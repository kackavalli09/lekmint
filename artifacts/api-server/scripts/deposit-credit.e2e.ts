/**
 * Regression test for deposit crediting (task: stop crediting old address
 * history as new deposits).
 *
 * Runs against the dev DB with a LOCAL mock of the mempool.space API:
 *  1. Address with pre-existing history + fresh deposit credits ONLY the
 *     fresh transaction; creditedTxs records exactly it.
 *  2. Re-poll does not double-credit.
 *  3. Old-history-only address never confirms.
 *  4. Height gating: a tx with a FUTURE-skewed block_time but block height at
 *     or below the creation-time baseline is NOT credited (miner timestamp
 *     drift cannot bypass the filter).
 *  5. Snapshot exclusion: a tx already in the mempool at request creation is
 *     NOT credited even after it confirms above the baseline height.
 *  6. Two mint requests can never share a deposit address (DB unique).
 *  7. deriveNextAddress skips an index whose address already has history.
 *
 * Run: scripts/node_modules/.bin/tsx artifacts/api-server/scripts/deposit-credit.e2e.ts
 */
import http from "node:http";

const MOCK_PORT = 45911;
process.env.MEMPOOL_API_BASE = `http://127.0.0.1:${MOCK_PORT}`;

// Imports AFTER env override so the watcher module picks up the mock base.
import { db, pool, mintRequestsTable, btcAddressesTable, adminConfigTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ---- Mock mempool.space -----------------------------------------------
const TIP = 900_100;
const BASELINE = 900_090; // tip height snapshotted at request creation
const nowSec = Math.floor(Date.now() / 1000);
const ADDR_MIXED = "bc1qmockmixedhistoryaddress0000000000000001";
const ADDR_OLD_ONLY = "bc1qmockoldhistoryonlyaddress000000000002";

const mkTx = (
  txid: string,
  addr: string,
  value: number,
  blockHeight: number | null,
  blockTime?: number,
) => ({
  txid,
  status:
    blockHeight === null
      ? { confirmed: false }
      : { confirmed: true, block_height: blockHeight, block_time: blockTime ?? nowSec },
  vout: [{ scriptpubkey_address: addr, value }],
});

const txsByAddress: Record<string, unknown[]> = {
  [ADDR_MIXED]: [
    // 30d-old history, in creation snapshot.
    mkTx("old-tx-1", ADDR_MIXED, 3_500_000, 800_000, nowSec - 86_400 * 30),
    // NOT in snapshot, block_time future-skewed (+2h) but height <= baseline:
    // must be blocked by height gating alone.
    mkTx("skewed-old-tx", ADDR_MIXED, 105_876, BASELINE - 1, nowSec + 7_200),
    // Was in the mempool at creation (snapshotted txid), later confirmed
    // ABOVE the baseline: must stay excluded.
    mkTx("preexist-mempool-tx", ADDR_MIXED, 50_000, TIP - 5),
    // The genuine deposit: confirmed above baseline, not in snapshot.
    mkTx("new-tx-1", ADDR_MIXED, 78_000, TIP - 5),
  ],
  [ADDR_OLD_ONLY]: [mkTx("old-tx-3", ADDR_OLD_ONLY, 16_530_804, 800_500, nowSec - 86_400 * 10)],
};

// Addresses the mock reports as "already used" for the derivation-skip test.
const usedForStats = new Set<string>();
const statsRequests: string[] = [];

const server = http.createServer((req, res) => {
  const url = req.url ?? "";
  const send = (body: unknown) => {
    res.setHeader("content-type", "application/json");
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  if (url === "/blocks/tip/height") return void res.end(String(TIP));
  const txsMatch = url.match(/^\/address\/([^/]+)\/txs$/);
  if (txsMatch) return void send(txsByAddress[txsMatch[1]!] ?? []);
  const statsMatch = url.match(/^\/address\/([^/]+)$/);
  if (statsMatch) {
    const addr = statsMatch[1]!;
    statsRequests.push(addr);
    // First distinct address queried is reported "used", the rest fresh.
    if (statsRequests.filter((a, i) => statsRequests.indexOf(a) === i).length === 1) {
      usedForStats.add(addr);
    }
    const used = usedForStats.has(addr);
    return void send({
      chain_stats: { tx_count: used ? 4 : 0 },
      mempool_stats: { tx_count: 0 },
    });
  }
  res.statusCode = 404;
  res.end("not found");
});

// BIP84 test-vector zpub (publicly known; watch-only, no funds risk in dev).
const TEST_ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

async function main() {
  await new Promise<void>((r) => server.listen(MOCK_PORT, "127.0.0.1", () => r()));
  const { pollDepositsOnce } = await import("../src/lib/depositWatcher");
  const { deriveNextAddress, setXpub } = await import("../src/lib/fundWallet");

  const cleanupIds: string[] = [];
  // Snapshot admin config so we can restore xpub/counter afterwards.
  const [origConfig] = await db.select().from(adminConfigTable).limit(1);

  try {
    const [reqMixed] = await db
      .insert(mintRequestsTable)
      .values({
        btcAddress: ADDR_MIXED,
        requestedAmountSats: 78_000,
        status: "pending",
        baselineTipHeight: BASELINE,
        excludedTxids: ["old-tx-1", "preexist-mempool-tx"],
      })
      .returning();
    const [reqOldOnly] = await db
      .insert(mintRequestsTable)
      .values({
        btcAddress: ADDR_OLD_ONLY,
        requestedAmountSats: 50,
        status: "pending",
        baselineTipHeight: BASELINE,
        excludedTxids: ["old-tx-3"],
      })
      .returning();
    cleanupIds.push(reqMixed!.id, reqOldOnly!.id);

    // --- 6: no two requests may share an address ---
    let dupRejected = false;
    try {
      await db
        .insert(mintRequestsTable)
        .values({ btcAddress: ADDR_MIXED, status: "pending" });
    } catch {
      dupRejected = true;
    }
    check("duplicate deposit address rejected by DB unique constraint", dupRejected);

    await pollDepositsOnce();

    const [afterMixed] = await db
      .select()
      .from(mintRequestsTable)
      .where(eq(mintRequestsTable.id, reqMixed!.id));
    check("mixed-history request confirmed", afterMixed!.status === "confirmed", afterMixed!.status);
    check(
      "only the NEW tx credited (old history, skewed-time tx, and pre-existing mempool tx all ignored)",
      afterMixed!.grossAmountSats === 78_000,
      `gross=${afterMixed!.grossAmountSats}`,
    );
    const credited = afterMixed!.creditedTxs as Array<{ txid: string; amountSats: number }>;
    check(
      "creditedTxs records exactly the new txid",
      Array.isArray(credited) && credited.length === 1 && credited[0]!.txid === "new-tx-1" &&
        credited[0]!.amountSats === 78_000,
      JSON.stringify(credited),
    );

    await pollDepositsOnce(); // re-poll
    const [afterRepoll] = await db
      .select()
      .from(mintRequestsTable)
      .where(eq(mintRequestsTable.id, reqMixed!.id));
    check(
      "re-poll does not double-credit",
      afterRepoll!.grossAmountSats === 78_000 && afterRepoll!.status === "confirmed",
      `gross=${afterRepoll!.grossAmountSats}`,
    );

    const [afterOldOnly] = await db
      .select()
      .from(mintRequestsTable)
      .where(eq(mintRequestsTable.id, reqOldOnly!.id));
    check(
      "old-history-only request stays pending (nothing credited)",
      afterOldOnly!.status === "pending" && afterOldOnly!.grossAmountSats === null,
      `status=${afterOldOnly!.status} gross=${afterOldOnly!.grossAmountSats}`,
    );

    // --- 7: derivation skips a used address ---
    await setXpub(TEST_ZPUB);
    const row = await deriveNextAddress();
    check(
      "first (used) index skipped, fresh address returned",
      row.derivationIndex === 1 && !usedForStats.has(row.address),
      `index=${row.derivationIndex} address=${row.address}`,
    );
    const [skipped] = await db
      .select()
      .from(btcAddressesTable)
      .where(eq(btcAddressesTable.derivationIndex, 0));
    check(
      "skipped address marked used_external",
      skipped?.status === "used_external",
      skipped?.status,
    );

    // Cleanup derivation rows + restore admin config.
    await db.delete(btcAddressesTable).where(inArray(btcAddressesTable.derivationIndex, [0, 1]));
  } finally {
    if (cleanupIds.length > 0) {
      await db.delete(mintRequestsTable).where(inArray(mintRequestsTable.id, cleanupIds));
    }
    if (origConfig) {
      await db
        .update(adminConfigTable)
        .set({
          xpubEncrypted: origConfig.xpubEncrypted,
          derivationIndexCounter: origConfig.derivationIndexCounter,
        })
        .where(eq(adminConfigTable.id, origConfig.id));
    }
    server.close();
    await pool.end();
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

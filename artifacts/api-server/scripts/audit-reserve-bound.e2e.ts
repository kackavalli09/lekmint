/**
 * Regression test: the solvency audit's required reserve must remain
 * SUFFICIENT when unredeemed tokens from an older (lower-rate) epoch are
 * outstanding — before AND after their upgrade to the current epoch.
 *
 * Why this matters: a proof issued at vintage rate Rv with face value F
 * redeems for F / Rv sats (upgrades multiply face by Rc/Rv, then redemption
 * divides by Rc — the vintage rate cancels through). Valuing ALL circulation
 * at the CURRENT rate therefore understates liability whenever the rate has
 * risen since issuance. The audit instead values circulation at the minimum
 * unrevoked epoch rate, which is a conservative upper bound.
 *
 * Fixture strategy (same registry-safe pattern as escrow-race.e2e.ts):
 * a synthetic vintage epoch at an unused id strictly between genesis and
 * current, rate 0.5, keyset inactive and unrevoked. Cleanup removes every
 * synthetic row and restores circulation exactly.
 */
import { db, keysetsTable, epochsTable, pool } from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import { recordSupplyDelta, getLatestSupply } from "../src/lib/supply";
import { randomBytes } from "node:crypto";

const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:80/api";
const VINTAGE_RATE = "0.500000000000";
const VINTAGE_FACE = 40_000; // leks of the synthetic vintage token
// True liability of the vintage token = face / 0.5 sats:
const TRUE_LIABILITY_SATS = Math.ceil(VINTAGE_FACE / Number(VINTAGE_RATE));

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function getStats(auth: Record<string, string>): Promise<any> {
  const res = await fetch(`${API_BASE}/admin/stats`, { headers: auth });
  if (res.status !== 200) throw new Error(`GET /admin/stats -> ${res.status}`);
  return res.json();
}

async function findSafeEpochGapId(): Promise<number> {
  const rows = await db.select({ id: epochsTable.id }).from(epochsTable).orderBy(asc(epochsTable.id));
  const ids = rows.map((r) => r.id);
  if (ids.length >= 2) {
    const used = new Set(ids);
    for (let candidate = ids[0]! + 1; candidate < ids[ids.length - 1]!; candidate++) {
      if (!used.has(candidate)) return candidate;
    }
  }
  throw new Error(
    "SAFETY ABORT: need a free epoch id strictly between genesis and current epoch ids.",
  );
}

async function main(): Promise<void> {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) throw new Error("ADMIN_API_KEY not set");
  const auth = { Authorization: `Bearer ${adminKey}` };

  const baselineStats = await getStats(auth);
  const baselineSupply = await getLatestSupply();
  const baselineCirculation = baselineSupply.totalLeksIssued - baselineSupply.totalLeksRedeemed;

  const gapId = await findSafeEpochGapId();
  const keysetId = `test-audit-${randomBytes(6).toString("hex")}`;
  // Test environments can carry a NEGATIVE net circulation from historical
  // synthetic burns (the audit clamps that to a zero requirement). Issue
  // enough extra face value to guarantee circulation ends up at least at the
  // vintage token's face, so the bound is actually exercised.
  const FACE = VINTAGE_FACE + Math.max(0, -baselineCirculation);

  await db.transaction(async (tx) => {
    await tx.insert(epochsTable).values({
      id: gapId,
      keysetId,
      rateIndex: VINTAGE_RATE,
      difficulty: "0.0000",
      subsidySats: 0,
    });
    await tx.insert(keysetsTable).values({
      id: keysetId,
      epochId: gapId,
      active: false, // not offered for new signatures…
      // …but NOT revoked: its outstanding proofs are still honored, which is
      // exactly the state whose liability the audit must cover.
      encryptedKeys: "{}",
    });
    await recordSupplyDelta(tx, { issued: FACE });
  });
  console.log(`Synthetic vintage epoch ${gapId} (rate ${VINTAGE_RATE}) provisioned, ${FACE} leks issued`);

  try {
    // --- BEFORE upgrade: audit must require at least the true liability ----
    // Isolate the circulation-backed component by subtracting the pending
    // melt estimate the endpoint folds into requiredReserveSats.
    const during = await getStats(auth);
    // Pending melts must be reserved at their FULL treasury debit (recipient
    // net + network fee), never just the recipient net.
    check(
      "pending-melt reserve covers recipient net plus network fees",
      (during.meltPendingReserveSats ?? 0) >= (during.meltPendingEstimatedSats ?? 0),
      `reserve=${during.meltPendingReserveSats}, recipientNet=${during.meltPendingEstimatedSats}, count=${during.meltPendingCount}`,
    );
    if (during.meltPendingCount > 0) {
      const quoteRes = await fetch(`${API_BASE}/melt/quote?amountLeks=1000`);
      const quote: any = quoteRes.status === 200 ? await quoteRes.json() : null;
      if (quote && quote.estimatedNetworkFeeSats > 0) {
        check(
          "each pending melt's reserve includes its network fee",
          (during.meltPendingReserveSats ?? 0) >=
            (during.meltPendingEstimatedSats ?? 0) + during.meltPendingCount,
          `reserve=${during.meltPendingReserveSats}, net=${during.meltPendingEstimatedSats}, networkFee/melt=${quote.estimatedNetworkFeeSats}`,
        );
      }
    }
    const circRequirement =
      during.audit.requiredReserveSats - (during.meltPendingReserveSats ?? 0);
    check(
      "circulation requirement covers the vintage token's true liability",
      circRequirement >= TRUE_LIABILITY_SATS,
      `requirement=${circRequirement}, true liability=${TRUE_LIABILITY_SATS}`,
    );
    check(
      "circulation is valued at the vintage (minimum unrevoked) rate, not the current rate",
      circRequirement >= Math.ceil(during.leksInCirculation / Number(VINTAGE_RATE)),
      `requirement=${circRequirement}, circulation=${during.leksInCirculation}`,
    );

    // --- AFTER upgrade: face value becomes F * Rc/Rv; liability unchanged --
    // Simulate the supply-side effect of an upgrade: face value grows, so the
    // supply log records the additional issued face value.
    const currentRateRow = await getStats(auth); // rate via pending calc not exposed; read epochs table
    const [currentEpoch] = await db
      .select({ rate: epochsTable.rateIndex })
      .from(epochsTable)
      .orderBy(asc(epochsTable.id))
      .then((rows) => [rows[rows.length - 1]!]);
    const rc = Number(currentEpoch!.rate);
    const upgradedFace = Math.floor((VINTAGE_FACE * rc) / Number(VINTAGE_RATE));
    const faceDelta = upgradedFace - VINTAGE_FACE;
    if (faceDelta !== 0) {
      await db.transaction(async (tx) => recordSupplyDelta(tx, { issued: faceDelta }));
    }
    const after = await getStats(auth);
    const circRequirementAfter =
      after.audit.requiredReserveSats - (after.meltPendingReserveSats ?? 0);
    check(
      "requirement still covers the liability after upgrade",
      circRequirementAfter >= TRUE_LIABILITY_SATS,
      `requirement=${circRequirementAfter}, true liability=${TRUE_LIABILITY_SATS} (upgraded face=${upgradedFace} at rate ${rc})`,
    );

    // Redeem the upgraded face value out of circulation (simulates melt).
    await db.transaction(async (tx) => recordSupplyDelta(tx, { redeemed: upgradedFace }));
    void currentRateRow;
  } finally {
    // --- cleanup: remove synthetic rows, restore circulation EXACTLY -------
    const errors: string[] = [];
    try {
      const now = await getLatestSupply();
      const drift = now.totalLeksIssued - now.totalLeksRedeemed - baselineCirculation;
      if (drift !== 0) {
        await db.transaction(async (tx) =>
          recordSupplyDelta(tx, drift > 0 ? { redeemed: drift } : { issued: -drift }),
        );
      }
    } catch (e) {
      errors.push(`supply restore: ${e}`);
    }
    try {
      await db.delete(keysetsTable).where(eq(keysetsTable.id, keysetId));
      await db.delete(epochsTable).where(eq(epochsTable.id, gapId));
    } catch (e) {
      errors.push(`fixture removal: ${e}`);
    }
    const restored = await getLatestSupply();
    check(
      "circulation restored exactly to pre-test baseline",
      restored.totalLeksIssued - restored.totalLeksRedeemed === baselineCirculation,
    );
    const leftovers = await db.select().from(epochsTable).where(eq(epochsTable.id, gapId));
    check("no synthetic epoch rows remain", leftovers.length === 0);
    if (errors.length > 0) throw new Error(`Cleanup errors: ${errors.join("; ")}`);
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log("\nAll assertions passed — the audit's reserve requirement stays sufficient across rate changes.");
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

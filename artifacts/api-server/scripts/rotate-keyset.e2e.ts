/**
 * E2E test for the one-time security keyset rotation (admin danger-zone).
 *
 * Flow:
 *   1. Issue real proofs under the current keyset (synthetic confirmed
 *      mint_requests row, deleted right after).
 *   2. POST /admin/rotate-keyset (needs ADMIN_API_KEY) — wrong phrase must 400.
 *   3. Assert: new active keyset differs; old keyset gone from /v1/keysets,
 *      /keysets and /v1/keys/:id (404); rate index unchanged; old proofs
 *      rejected on /swap, /redeem and /v1/swap with a "rotated" message;
 *      fresh issuance + swap on the new keyset works.
 *   4. Cleanup: redeem the fresh proofs (net supply back to 0).
 *
 * Run: scripts/node_modules/.bin/tsx artifacts/api-server/scripts/rotate-keyset.e2e.ts
 */
import { db, mintRequestsTable, pool } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createBlindedOutputs, unblindSignatures } from "../../lek-mint/src/lib/wallet";

const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:80/api";
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const AMOUNT = 4;

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function api(path: string, body?: unknown, admin = false) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(admin ? { Authorization: `Bearer ${ADMIN_KEY}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json: json as any };
}

async function issueProofs(keysetId: string, keys: Record<string, string>) {
  const [request] = await db
    .insert(mintRequestsTable)
    .values({
      btcAddress: `synthetic-e2e-rotate-${Date.now()}`,
      status: "confirmed",
      grossAmountSats: AMOUNT,
      feeSats: 0,
      netAmountSats: AMOUNT,
    })
    .returning();
  if (!request) throw new Error("failed to insert synthetic request");
  try {
    const issue = createBlindedOutputs(AMOUNT, keysetId);
    const issued = await api("/mint/issue", { requestId: request.id, outputs: issue.outputs });
    if (issued.status !== 200) throw new Error(`issue failed: ${JSON.stringify(issued.json)}`);
    return unblindSignatures(issued.json.signatures, issue.blindings, keys);
  } finally {
    await db.delete(mintRequestsTable).where(eq(mintRequestsTable.id, request.id));
  }
}

async function main() {
  if (!ADMIN_KEY) throw new Error("ADMIN_API_KEY env var required");

  const before = (await api("/keys")).json;
  const oldKeysetId: string = before.keysetId;
  const epochsBefore = (await api("/epochs")).json;
  const oldProofs = await issueProofs(oldKeysetId, before.keys);
  console.log(`Issued ${oldProofs.length} proofs under keyset ${oldKeysetId}`);

  // Wrong phrase must be refused.
  const bad = await api("/admin/rotate-keyset", { confirm: "yes please" }, true);
  check("wrong confirmation phrase rejected", bad.status === 400, JSON.stringify(bad.json));

  // No auth must be refused.
  const noAuth = await api("/admin/rotate-keyset", { confirm: "ROTATE AND VOID" });
  check("unauthenticated rotation rejected", noAuth.status === 401 || noAuth.status === 403);

  const rot = await api("/admin/rotate-keyset", { confirm: "ROTATE AND VOID" }, true);
  check("rotation succeeds", rot.status === 200, JSON.stringify(rot.json));
  const newKeysetId: string = rot.json.newKeysetId;
  check("new keyset differs", newKeysetId !== oldKeysetId);
  check("old keyset listed as revoked", rot.json.revokedKeysetIds?.includes(oldKeysetId));

  const after = (await api("/keys")).json;
  check("active keyset is the new one", after.keysetId === newKeysetId);

  // NUT-02: revoked keysets stay listed (inactive) so wallets with a stale
  // cached keyset learn about the rotation and switch to the active one.
  const v1keysets = (await api("/v1/keysets")).json;
  const v1rows = (v1keysets.keysets ?? []) as any[];
  const v1old_row = v1rows.find((k) => k.id === oldKeysetId);
  const v1new_row = v1rows.find((k) => k.id === newKeysetId);
  check(
    "revoked keyset listed inactive in /v1/keysets; new keyset active",
    v1old_row?.active === false && v1new_row?.active === true,
    JSON.stringify(v1rows),
  );
  const pubKeysets = (await api("/keysets")).json;
  const pubOld = ((pubKeysets.keysets ?? []) as any[]).find((k) => k.id === oldKeysetId);
  check("revoked keyset listed inactive in /keysets", pubOld?.active === false, JSON.stringify(pubKeysets));
  const v1old = await api(`/v1/keys/${oldKeysetId}`);
  check(
    "/v1/keys/<revoked> returns its public keys (read-only discovery)",
    v1old.status === 200 && v1old.json.keysets?.[0]?.id === oldKeysetId,
    `status ${v1old.status}`,
  );
  const v1unknown = await api(`/v1/keys/00deadbeefdeadbe`);
  check("/v1/keys/<unknown> returns 404", v1unknown.status === 404);

  const epochsAfter = (await api("/epochs")).json;
  check(
    "rate index unchanged (value-neutral)",
    epochsAfter.currentRateIndex === epochsBefore.currentRateIndex,
    `${epochsBefore.currentRateIndex} -> ${epochsAfter.currentRateIndex}`,
  );

  // Old proofs must be rejected everywhere, with a clear "rotated" message.
  const freshOut = createBlindedOutputs(AMOUNT, newKeysetId);
  const swapOld = await api("/swap", { inputs: oldProofs, outputs: freshOut.outputs });
  check(
    "old proofs rejected on /swap with rotation message",
    swapOld.status !== 200 && JSON.stringify(swapOld.json).toLowerCase().includes("rotated"),
    JSON.stringify(swapOld.json),
  );
  const redeemOld = await api("/redeem", { proofs: oldProofs, btcAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" });
  check("old proofs rejected on /redeem", redeemOld.status !== 200, JSON.stringify(redeemOld.json));
  const v1SwapOld = await api("/v1/swap", { inputs: oldProofs, outputs: freshOut.outputs });
  check(
    "old proofs rejected on /v1/swap with rotation message",
    v1SwapOld.status !== 200 && JSON.stringify(v1SwapOld.json).toLowerCase().includes("rotated"),
    JSON.stringify(v1SwapOld.json),
  );

  // New keyset works end-to-end: issue then swap then redeem (cleanup).
  const newProofs = await issueProofs(newKeysetId, after.keys);

  // Valid inputs + outputs targeting the OLD (revoked) keyset — the stale-
  // wallet case. Must fail with the "refresh keysets" hint, inputs unburned.
  const staleOut = createBlindedOutputs(AMOUNT, oldKeysetId);
  const staleSwap = await api("/v1/swap", { inputs: newProofs, outputs: staleOut.outputs });
  check(
    "outputs on revoked keyset rejected with refresh hint",
    staleSwap.status !== 200 && JSON.stringify(staleSwap.json).toLowerCase().includes("refresh"),
    JSON.stringify(staleSwap.json),
  );

  const out2 = createBlindedOutputs(AMOUNT, newKeysetId);
  const swapNew = await api("/swap", { inputs: newProofs, outputs: out2.outputs });
  check("swap works on new keyset", swapNew.status === 200, JSON.stringify(swapNew.json).slice(0, 120));
  const swappedProofs = unblindSignatures(swapNew.json.signatures, out2.blindings, after.keys);
  const burn = await api("/redeem", { proofs: swappedProofs, btcAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" });
  check("cleanup redeem on new keyset", burn.status === 200, JSON.stringify(burn.json));

  // Concurrency: a swap that started BEFORE a rotation commits must not be
  // signed with the just-revoked keys. We simulate the rotation commit window
  // deterministically: hold the keyset-transition advisory lock exclusively,
  // start a swap (it blocks at the in-transaction shared-lock guard), revoke
  // the active keyset inside our transaction, commit, and assert the swap
  // fails with the rotation error and its inputs were NOT burned.
  {
    const LOCK_KEY = 0x1e4_5e7;
    const raceKeys = (await api("/keys")).json;
    const raceProofs = await issueProofs(raceKeys.keysetId, raceKeys.keys);
    const raceOut = createBlindedOutputs(AMOUNT, raceKeys.keysetId);

    const client = await pool.connect();
    let swapPromise: Promise<{ status: number; json: any }>;
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [LOCK_KEY]);
      swapPromise = api("/swap", { inputs: raceProofs, outputs: raceOut.outputs });
      await new Promise((r) => setTimeout(r, 700)); // let the swap reach the guard
      await client.query(
        "update keysets set revoked_at = now(), active = false where id = $1",
        [raceKeys.keysetId],
      );
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const raceSwap = await swapPromise;
    check(
      "swap racing a rotation is rejected with rotation message",
      raceSwap.status !== 200 && JSON.stringify(raceSwap.json).toLowerCase().includes("rotated"),
      `status ${raceSwap.status}: ${JSON.stringify(raceSwap.json)}`,
    );

    // Undo the simulated revocation and burn the race proofs (cleanup).
    await pool.query("update keysets set revoked_at = null, active = true where id = $1", [
      raceKeys.keysetId,
    ]);
    const raceBurn = await api("/redeem", { proofs: raceProofs, btcAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" });
    check("race inputs were not burned (still redeemable after un-revoke)", raceBurn.status === 200, JSON.stringify(raceBurn.json));
  }

  // Admin history shows the revocation.
  const hist = await api("/admin/keysets", undefined, true);
  const oldRow = (hist.json.keysets ?? []).find((k: any) => k.id === oldKeysetId);
  const newRow = (hist.json.keysets ?? []).find((k: any) => k.id === newKeysetId);
  check("history: old keyset revoked, new active", !!oldRow?.revokedAt && newRow?.active === true && !newRow?.revokedAt);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error("FAILED:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });

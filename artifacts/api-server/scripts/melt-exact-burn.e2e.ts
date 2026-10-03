/**
 * E2E wallet-simulation test: melting burns EXACTLY the requested amount.
 *
 * Exercises the SAME code path as artifacts/lek-mint/src/pages/melt.tsx by
 * importing the shared melt-flow helpers from the real wallet library
 * (selectProofs / planMeltSwap / partitionMeltProofs / unblindSignatures).
 * A regression in the swap output ordering or the melt/change partition
 * fails this test — the logic is shared, not duplicated.
 *
 * Flow:
 *   1. Insert a synthetic CONFIRMED mint request (100 sats) directly in the DB
 *      (no on-chain deposit) and issue real proofs against it: [64, 32, 4].
 *   2. Melt 7 leks — {64,32,4} has no exact subset for 7, forcing the swap
 *      path: swap 64 -> melt denominations [4,2,1] + change [32,16,8,1].
 *   3. Assert the burned (redeemed) amount is exactly 7 — never more.
 *   4. Replay the burned proofs -> must be rejected with 409.
 *   5. Redeem ALL remaining proofs (change + untouched) -> must equal 93,
 *      proving the change survived the melt AND returning net supply to zero.
 *   6. Cleanup even on failure: best-effort redeem of any outstanding proofs
 *      (so no synthetic supply is left circulating), then delete the
 *      synthetic mint request row. Assertions are FAIL-FAST (throw).
 *
 * Run: scripts/node_modules/.bin/tsx artifacts/api-server/scripts/melt-exact-burn.e2e.ts
 */
import { db, mintRequestsTable, pool } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  selectProofs,
  createBlindedOutputs,
  planMeltSwap,
  partitionMeltProofs,
  unblindSignatures,
  sumProofs,
} from "../../lek-mint/src/lib/wallet";
import type { Proof } from "@workspace/api-client-react";

const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:80/api";
// Bitcoin genesis address — syntactically valid mainnet P2PKH for payout field.
const PAYOUT_ADDRESS = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const SYNTHETIC_MARKER = `synthetic-e2e-melt-${Date.now()}`;

const FUND_AMOUNT = 100; // -> proofs [64, 32, 4]
const MELT_AMOUNT = 7; //   no exact subset of {64,32,4} -> forces swap path

/** Fail-fast assertion: any broken invariant aborts immediately. */
function assert(cond: boolean, label: string, detail?: unknown): void {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${label} ${detail !== undefined ? JSON.stringify(detail) : ""}`);
  }
  console.log(`  PASS  ${label}`);
}

async function api(path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/**
 * Every proof we believe is currently unspent lives here, so the finally
 * block can burn stragglers even if the test aborts mid-flow.
 */
let outstanding: Proof[] = [];
const track = (proofs: Proof[]) => outstanding.push(...proofs);
const untrack = (proofs: Proof[]) => {
  const gone = new Set(proofs.map((p) => p.secret));
  outstanding = outstanding.filter((p) => !gone.has(p.secret));
};

async function bestEffortCleanupProofs(): Promise<void> {
  if (outstanding.length === 0) return;
  const res = await api("/redeem", { proofs: outstanding, btcAddress: PAYOUT_ADDRESS });
  if (res.status === 200) {
    console.log(`Cleanup: burned ${res.json.redeemedAmount} outstanding synthetic leks`);
    outstanding = [];
  } else {
    console.error(
      `Cleanup WARNING: could not burn ${sumProofs(outstanding)} outstanding leks (HTTP ${res.status})`,
      res.json,
    );
  }
}

async function main(): Promise<void> {
  // --- 1. Synthetic funding -------------------------------------------------
  const [request] = await db
    .insert(mintRequestsTable)
    .values({
      btcAddress: SYNTHETIC_MARKER,
      status: "confirmed",
      grossAmountSats: FUND_AMOUNT,
      feeSats: 0,
      netAmountSats: FUND_AMOUNT,
    })
    .returning();
  if (!request) throw new Error("Failed to insert synthetic mint request");
  console.log(`Synthetic confirmed deposit inserted (request ${request.id})`);

  try {
    const keysRes = await api("/keys");
    if (keysRes.status !== 200) throw new Error(`GET /keys -> ${keysRes.status}`);
    const { keysetId, keys } = keysRes.json as { keysetId: string; keys: Record<string, string> };

    const issueOutputs = createBlindedOutputs(FUND_AMOUNT, keysetId);
    const issueRes = await api("/mint/issue", {
      requestId: request.id,
      outputs: issueOutputs.outputs,
    });
    if (issueRes.status !== 200) {
      throw new Error(`POST /mint/issue -> ${issueRes.status}: ${JSON.stringify(issueRes.json)}`);
    }
    const wallet = unblindSignatures(issueRes.json.signatures, issueOutputs.blindings, keys);
    track(wallet);
    console.log(`Issued proofs: [${wallet.map((p) => p.amount).join(", ")}]`);
    assert(sumProofs(wallet) === FUND_AMOUNT, `issued proofs total ${FUND_AMOUNT}`);

    // --- 2. Melt 7 — SAME shared helpers the client uses --------------------
    const selection = selectProofs(wallet, MELT_AMOUNT);
    assert(!selection.exact, "no exact subset exists (swap path is exercised)");
    console.log(
      `Selection for melt ${MELT_AMOUNT}: [${selection.send.map((p) => p.amount).join(", ")}] total ${selection.total}`,
    );

    const plan = planMeltSwap(selection, MELT_AMOUNT, keysetId);
    const swapRes = await api("/swap", { inputs: selection.send, outputs: plan.outputs });
    if (swapRes.status !== 200) {
      throw new Error(`POST /swap -> ${swapRes.status}: ${JSON.stringify(swapRes.json)}`);
    }
    // Swap inputs are now spent at the mint; the new proofs replace them.
    untrack(selection.send);
    const newProofs = unblindSignatures(swapRes.json.signatures, plan.blindings, keys);
    track(newProofs);

    // partitionMeltProofs is the exact function melt.tsx burns with — it
    // throws internally if the melt slice does not sum to plan.amount.
    const { meltProofs, changeProofs } = partitionMeltProofs(plan, newProofs);
    assert(
      sumProofs(meltProofs) === MELT_AMOUNT,
      `partitioned melt proofs sum to exactly ${MELT_AMOUNT}`,
      meltProofs.map((p) => p.amount),
    );
    assert(
      sumProofs(changeProofs) === selection.total - MELT_AMOUNT,
      `change proofs sum to exactly ${selection.total - MELT_AMOUNT}`,
      changeProofs.map((p) => p.amount),
    );

    // --- 3. Burn: must redeem exactly the requested amount ------------------
    const redeemRes = await api("/redeem", { proofs: meltProofs, btcAddress: PAYOUT_ADDRESS });
    assert(redeemRes.status === 200, "redeem of melt proofs accepted", redeemRes);
    untrack(meltProofs);
    assert(
      redeemRes.json.redeemedAmount === MELT_AMOUNT,
      `redeemedAmount === ${MELT_AMOUNT} (burned exactly the requested amount, never more)`,
      redeemRes.json,
    );

    // --- 4. Replay protection ------------------------------------------------
    const replayRes = await api("/redeem", { proofs: meltProofs, btcAddress: PAYOUT_ADDRESS });
    assert(replayRes.status === 409, "replaying burned proofs returns 409", {
      status: replayRes.status,
    });

    // --- 5. Change is still spendable; net supply returns to zero -----------
    const remainingTotal = sumProofs(outstanding);
    assert(
      remainingTotal === FUND_AMOUNT - MELT_AMOUNT,
      `wallet still holds ${FUND_AMOUNT - MELT_AMOUNT} after melting ${MELT_AMOUNT}`,
      remainingTotal,
    );
    const finalRedeem = await api("/redeem", { proofs: outstanding, btcAddress: PAYOUT_ADDRESS });
    assert(
      finalRedeem.status === 200 && finalRedeem.json.redeemedAmount === remainingTotal,
      "change proofs remain spendable (final cleanup redeem succeeds)",
      finalRedeem,
    );
    outstanding = [];
  } finally {
    // --- 6. Revert synthetic state, even when an assertion aborted ----------
    await bestEffortCleanupProofs().catch((err) =>
      console.error("Cleanup WARNING: proof cleanup errored", err),
    );
    await db.delete(mintRequestsTable).where(eq(mintRequestsTable.id, request.id));
    console.log("Synthetic mint request deleted (DB state reverted)");
  }
}

main()
  .then(async () => {
    await pool.end();
    console.log("\nAll assertions passed — melt burns exactly the requested amount.");
  })
  .catch(async (err) => {
    console.error("\nTEST FAILED:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });

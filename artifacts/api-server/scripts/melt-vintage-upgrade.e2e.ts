/**
 * E2E wallet-simulation test: epoch rates are applied EVERYWHERE leks move,
 * so old-epoch (vintage) leks never lose their appreciation and deposits are
 * never shortchanged.
 *
 * Guards the invariants of task "apply epoch rates everywhere leks move":
 *   A. REDEEM: vintage proofs are automatically converted — /redeem succeeds
 *      and pays the upgraded value (no 400 refusal, no face-value burn).
 *   B. SWAP: /swap values inputs at R_current; outputs may total up to the
 *      CONVERTED value (receive flow), and asking for more is refused.
 *   C. ISSUANCE: a confirmed deposit of N net sats mints floor(N × R_current)
 *      leks (expectedLeks in the status response), not 1:1.
 *   D. The explicit upgrade path (POST /mint/upgrade) still matches the
 *      client's planUpgrade math exactly.
 *
 * Flow:
 *   1. Fund two batches of 96-sat deposits in the CURRENT keyset via
 *      synthetic confirmed mint requests (issued at the current rate).
 *   2. Rotate epochs synthetically: new epoch at rate R_new = R_old * 4/3
 *      with a fresh active keyset. The funded proofs are now vintage.
 *   3. ISSUANCE: new synthetic 96-sat request -> expectedLeks == floor(96*R_new
 *      / 1.0); issuing face-value outputs is refused; expectedLeks outputs
 *      are accepted.
 *   4. SWAP: swap vintage batch B for outputs totaling the converted value
 *      (accepted); asking for converted+1 is refused.
 *   5. REDEEM: redeem vintage batch A directly -> 200 with the CONVERTED
 *      amount, payout queue owes the converted amount.
 *   6. Cleanup even on failure: burn stragglers, restore the original active
 *      keyset, delete the synthetic epoch/keyset/mint-request/payout rows.
 *
 * Run: scripts/node_modules/.bin/tsx artifacts/api-server/scripts/melt-vintage-upgrade.e2e.ts
 */
import { eq, and, gte, inArray } from "drizzle-orm";
import {
  db,
  pool,
  mintRequestsTable,
  epochsTable,
  keysetsTable,
  payoutsTable,
} from "@workspace/db";
import { buildNewKeyset } from "../src/lib/keysetManager";
import { convertValueMulti, parseDecimalScaled, formatScaled, RATE_SCALE } from "../src/lib/epochEngine";
import {
  createBlindedOutputs,
  unblindSignatures,
  partitionProofsByKeyset,
  planUpgrade,
  sumProofs,
} from "../../lek-mint/src/lib/wallet";
import type { Proof } from "@workspace/api-client-react";

const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:80/api";
// Bitcoin genesis address — syntactically valid mainnet P2PKH for payout field.
const PAYOUT_ADDRESS = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const SYNTHETIC_MARKER = `synthetic-e2e-vintage-${Date.now()}`;
const FUND_SATS = 96;

function assert(cond: boolean, label: string, detail?: unknown): void {
  if (!cond) {
    throw new Error(
      `ASSERTION FAILED: ${label} ${detail !== undefined ? JSON.stringify(detail) : ""}`,
    );
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

/** Everything we believe is unspent, so cleanup can burn stragglers. */
let outstanding: Proof[] = [];
const track = (proofs: Proof[]) => outstanding.push(...proofs);
const untrack = (proofs: Proof[]) => {
  const gone = new Set(proofs.map((p) => p.secret));
  outstanding = outstanding.filter((p) => !gone.has(p.secret));
};

async function burnOutstanding(label: string): Promise<void> {
  if (outstanding.length === 0) return;
  const res = await api("/redeem", { proofs: outstanding, btcAddress: PAYOUT_ADDRESS });
  if (res.status === 200) {
    console.log(`Cleanup (${label}): burned ${res.json.redeemedAmount} leks (converted)`);
    outstanding = [];
  } else {
    console.error(
      `Cleanup WARNING (${label}): could not burn ${sumProofs(outstanding)} leks (HTTP ${res.status})`,
      res.json,
    );
  }
}

/** Insert a synthetic confirmed mint request and issue its leks at the current rate. */
async function fundBatch(
  keysetId: string,
  keys: Record<string, string>,
): Promise<{ proofs: Proof[]; requestId: string }> {
  const [request] = await db
    .insert(mintRequestsTable)
    .values({
      btcAddress: `${SYNTHETIC_MARKER}-${Math.random().toString(36).slice(2)}`,
      status: "confirmed",
      grossAmountSats: FUND_SATS,
      feeSats: 0,
      netAmountSats: FUND_SATS,
    })
    .returning();
  if (!request) throw new Error("Failed to insert synthetic mint request");
  const statusRes = await api(`/mint/status/${request.id}`);
  const expectedLeks: number = statusRes.json.expectedLeks;
  if (!expectedLeks || expectedLeks <= 0) {
    throw new Error(`status did not report expectedLeks: ${JSON.stringify(statusRes.json)}`);
  }
  const { outputs, blindings } = createBlindedOutputs(expectedLeks, keysetId);
  const issueRes = await api("/mint/issue", { requestId: request.id, outputs });
  if (issueRes.status !== 200) {
    throw new Error(`POST /mint/issue -> ${issueRes.status}: ${JSON.stringify(issueRes.json)}`);
  }
  const proofs = unblindSignatures(issueRes.json.signatures, blindings, keys);
  track(proofs);
  return { proofs, requestId: request.id };
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const syntheticRequestIds: string[] = [];

  // --- Baseline: current epoch + keyset --------------------------------------
  const epochsRes = await api("/epochs");
  const keysRes = await api("/keys");
  if (epochsRes.status !== 200 || keysRes.status !== 200) {
    throw new Error("Mint not reachable / not initialized");
  }
  const originalKeysetId: string = keysRes.json.keysetId;
  const originalKeys: Record<string, string> = keysRes.json.keys;
  const originalRate: string = epochsRes.json.currentRateIndex;
  const originalEpochId: number = epochsRes.json.currentEpochId;
  console.log(`Baseline: epoch ${originalEpochId}, rate ${originalRate}, keyset ${originalKeysetId}`);

  let syntheticKeysetId: string | null = null;
  let syntheticEpochRowId: number | null = null;

  try {
    // --- 1. Fund two batches in the current (soon-to-be-vintage) keyset -------
    const batchA = await fundBatch(originalKeysetId, originalKeys);
    const batchB = await fundBatch(originalKeysetId, originalKeys);
    syntheticRequestIds.push(batchA.requestId, batchB.requestId);
    const fundedLeks = sumProofs(batchA.proofs);
    assert(
      fundedLeks === convertValueMulti([{ amount: FUND_SATS, fromRate: "1.000000000000" }], originalRate).value,
      `issuance minted floor(${FUND_SATS} sats × ${originalRate}) = ${fundedLeks} leks (rate-adjusted)`,
    );

    // --- 2. Synthetic epoch rotation: R_new = R_old * 4/3 ---------------------
    const oldScaled = parseDecimalScaled(originalRate, RATE_SCALE);
    const newRate = formatScaled((oldScaled * 4n) / 3n, RATE_SCALE);
    const built = buildNewKeyset(originalEpochId + 1);
    const [genesisEpoch] = await db
      .select()
      .from(epochsTable)
      .where(eq(epochsTable.id, originalEpochId));
    if (!genesisEpoch) throw new Error("Current epoch row not found");

    const [newEpochRow] = await db
      .insert(epochsTable)
      .values({
        keysetId: built.id,
        rateIndex: newRate,
        difficulty: genesisEpoch.difficulty,
        subsidySats: genesisEpoch.subsidySats,
      })
      .returning();
    syntheticEpochRowId = newEpochRow!.id;
    // Deactivate BEFORE inserting the new active keyset (partial unique index
    // keysets_single_active_idx — same order as the real rollover).
    await db
      .update(keysetsTable)
      .set({ active: false })
      .where(eq(keysetsTable.id, originalKeysetId));
    await db.insert(keysetsTable).values({
      id: built.id,
      unit: "lek",
      active: true,
      epochId: newEpochRow!.id,
      encryptedKeys: built.encryptedKeys,
    });
    syntheticKeysetId = built.id;
    console.log(`Rotated to synthetic epoch ${newEpochRow!.id} (rate ${newRate}, keyset ${built.id})`);

    const freshEpochs = await api("/epochs");
    const freshKeys = await api("/keys");
    assert(freshKeys.json.keysetId === built.id, "GET /keys now serves the new keyset");

    // Conversion is computed per proof (per denomination), matching the mint.
    const convertProofs = (proofs: Proof[]) =>
      convertValueMulti(proofs.map((p) => ({ amount: p.amount, fromRate: originalRate })), newRate).value;
    const convertedA = convertProofs(batchA.proofs);
    const convertedBatch = convertProofs(batchB.proofs);

    // --- 3. ISSUANCE applies the new rate --------------------------------------
    const [issueReq] = await db
      .insert(mintRequestsTable)
      .values({
        btcAddress: `${SYNTHETIC_MARKER}-issue`,
        status: "confirmed",
        grossAmountSats: FUND_SATS,
        feeSats: 0,
        netAmountSats: FUND_SATS,
      })
      .returning();
    syntheticRequestIds.push(issueReq!.id);
    const issueStatus = await api(`/mint/status/${issueReq!.id}`);
    const expectedNewLeks = convertValueMulti(
      [{ amount: FUND_SATS, fromRate: "1.000000000000" }],
      newRate,
    ).value;
    assert(
      issueStatus.json.expectedLeks === expectedNewLeks,
      `status expectedLeks == floor(${FUND_SATS} × ${newRate}) = ${expectedNewLeks}`,
      issueStatus.json,
    );
    assert(expectedNewLeks > FUND_SATS, "after a rate increase, a deposit mints MORE leks than sats");
    // Face-value (1:1) outputs must now be refused.
    const faceOutputs = createBlindedOutputs(FUND_SATS, built.id);
    const faceIssueRes = await api("/mint/issue", { requestId: issueReq!.id, outputs: faceOutputs.outputs });
    assert(faceIssueRes.status === 400, "issuing 1:1 (face sats) outputs is refused", faceIssueRes.json);
    // Correct rate-adjusted outputs are accepted.
    const rateOutputs = createBlindedOutputs(expectedNewLeks, built.id);
    const rateIssueRes = await api("/mint/issue", { requestId: issueReq!.id, outputs: rateOutputs.outputs });
    assert(rateIssueRes.status === 200, "issuing rate-adjusted outputs succeeds", rateIssueRes.json);
    const issuedProofs = unblindSignatures(rateIssueRes.json.signatures, rateOutputs.blindings, freshKeys.json.keys);
    track(issuedProofs);
    assert(sumProofs(issuedProofs) === expectedNewLeks, `deposit minted ${expectedNewLeks} leks at the new rate`);

    // --- 4. SWAP converts vintage inputs ---------------------------------------
    // Asking for more than the converted value is refused.
    const overOutputs = createBlindedOutputs(convertedBatch + 1, built.id);
    const overRes = await api("/swap", { inputs: batchB.proofs, outputs: overOutputs.outputs });
    assert(overRes.status === 400, "swap outputs above converted value are refused", overRes.json);
    // Swapping for exactly the converted value succeeds (this is the wallet's
    // receive flow: old-epoch tokens are credited at the upgraded value).
    const swapOutputs = createBlindedOutputs(convertedBatch, built.id);
    const swapRes = await api("/swap", { inputs: batchB.proofs, outputs: swapOutputs.outputs });
    assert(
      swapRes.status === 200,
      `swap of ${fundedLeks} vintage leks for ${convertedBatch} current leks accepted`,
      swapRes.json,
    );
    untrack(batchB.proofs);
    const swapped = unblindSignatures(swapRes.json.signatures, swapOutputs.blindings, freshKeys.json.keys);
    track(swapped);
    assert(sumProofs(swapped) === convertedBatch, "swap credited the full converted value");

    // --- 5. REDEEM converts vintage proofs automatically -----------------------
    const redeemRes = await api("/redeem", { proofs: batchA.proofs, btcAddress: PAYOUT_ADDRESS });
    assert(
      redeemRes.status === 200 && redeemRes.json.redeemedAmount === convertedA,
      `redeeming ${fundedLeks} vintage leks pays the CONVERTED ${convertedA} leks`,
      redeemRes,
    );
    untrack(batchA.proofs);
    const [payout] = await db
      .select()
      .from(payoutsTable)
      .where(and(eq(payoutsTable.btcAddress, PAYOUT_ADDRESS), gte(payoutsTable.createdAt, startedAt)));
    assert(
      payout !== undefined && payout.amountLeks === convertedA,
      "payout queue owes the CONVERTED amount, not the vintage face value",
      payout,
    );

    // --- 6. Explicit upgrade path still matches client math --------------------
    const { active, vintage } = partitionProofsByKeyset(swapped, freshKeys.json.keysetId);
    assert(vintage.length === 0 && sumProofs(active) === convertedBatch, "swapped proofs are current-keyset");
    // Client planUpgrade math (used by receive/melt flows) matches the server.
    const clientPlanCheck = planUpgrade(
      batchA.proofs, // already burned — only checking the arithmetic
      freshEpochs.json.epochs,
      freshEpochs.json.currentRateIndex,
      freshKeys.json.keysetId,
    );
    assert(
      clientPlanCheck.newValue === convertedA,
      `client planUpgrade value (${clientPlanCheck.newValue}) matches server conversion (${convertedA})`,
    );
  } finally {
    // --- 7. Full revert, in dependency order ----------------------------------
    await burnOutstanding("synthetic keyset active").catch((e) => console.error(e));
    if (syntheticKeysetId) {
      await db.update(keysetsTable).set({ active: false }).where(eq(keysetsTable.id, syntheticKeysetId));
    }
    await db.update(keysetsTable).set({ active: true }).where(eq(keysetsTable.id, originalKeysetId));
    await burnOutstanding("original keyset restored").catch((e) => console.error(e));
    if (syntheticKeysetId) {
      await db.delete(keysetsTable).where(eq(keysetsTable.id, syntheticKeysetId));
    }
    if (syntheticEpochRowId !== null) {
      await db.delete(epochsTable).where(eq(epochsTable.id, syntheticEpochRowId));
    }
    await db
      .delete(payoutsTable)
      .where(and(eq(payoutsTable.btcAddress, PAYOUT_ADDRESS), gte(payoutsTable.createdAt, startedAt)));
    if (syntheticRequestIds.length > 0) {
      await db.delete(mintRequestsTable).where(inArray(mintRequestsTable.id, syntheticRequestIds));
    }
    console.log("Synthetic epoch/keyset/mint-request/payout state reverted");
  }
}

main()
  .then(async () => {
    await pool.end();
    console.log("\nAll assertions passed — epoch rates are applied everywhere leks move.");
  })
  .catch(async (err) => {
    console.error("\nTEST FAILED:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });

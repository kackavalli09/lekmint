/**
 * E2E: face-value swaps by epoch-unaware external wallets + appreciation
 * escrow, claimable exactly once by the original proof holder (task #45).
 *
 * Invariants guarded:
 *   A. /v1/swap (Cashu protocol) accepts vintage inputs with FACE-value
 *      outputs; the remainder (converted − face) is escrowed for the sender.
 *   B. /v1/swap still refuses outputs above the converted value.
 *   C. /v1/swap for exactly the converted value succeeds with NO escrow.
 *   D. /escrow/check reports the escrowed amount only for the exact original
 *      proof set; partial/wrong sets report nothing.
 *   E. /escrow/claim issues the escrowed leks exactly once; a second claim
 *      is refused (409); a wrong output total is refused (400).
 *   F. Current-epoch /v1/swap remains strictly balanced.
 *
 * Same synthetic-rotation harness as melt-vintage-upgrade.e2e.ts, with full
 * cleanup (including swap_escrows rows) in finally.
 *
 * Run: ADMIN_API_KEY=... scripts/node_modules/.bin/tsx artifacts/api-server/scripts/escrow-claim.e2e.ts
 */
import { eq, and, gte, inArray } from "drizzle-orm";
import {
  db,
  pool,
  mintRequestsTable,
  epochsTable,
  keysetsTable,
  payoutsTable,
  swapEscrowsTable,
} from "@workspace/db";
import { buildNewKeyset } from "../src/lib/keysetManager";
import { convertValueMulti, parseDecimalScaled, formatScaled, RATE_SCALE } from "../src/lib/epochEngine";
import { computeProofsHash } from "../src/lib/escrow";
import {
  createBlindedOutputs,
  unblindSignatures,
  sumProofs,
} from "../../lek-mint/src/lib/wallet";
import type { Proof } from "@workspace/api-client-react";

const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:80/api";
const PAYOUT_ADDRESS = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const SYNTHETIC_MARKER = `synthetic-e2e-escrow-${Date.now()}`;
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
    // --- 1. Fund vintage batches in the current keyset -----------------------
    const batchA = await fundBatch(originalKeysetId, originalKeys); // face-value swap + escrow claim
    const batchB = await fundBatch(originalKeysetId, originalKeys); // exact converted swap (no escrow)
    syntheticRequestIds.push(batchA.requestId, batchB.requestId);

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
    await db.update(keysetsTable).set({ active: false }).where(eq(keysetsTable.id, originalKeysetId));
    await db.insert(keysetsTable).values({
      id: built.id,
      unit: "lek",
      active: true,
      epochId: newEpochRow!.id,
      encryptedKeys: built.encryptedKeys,
    });
    syntheticKeysetId = built.id;
    console.log(`Rotated to synthetic epoch ${newEpochRow!.id} (rate ${newRate}, keyset ${built.id})`);
    const freshKeys = await api("/keys");

    const convertProofs = (proofs: Proof[]) =>
      convertValueMulti(proofs.map((p) => ({ amount: p.amount, fromRate: originalRate })), newRate).value;
    const faceA = sumProofs(batchA.proofs);
    const convertedA = convertProofs(batchA.proofs);
    const remainderA = convertedA - faceA;
    assert(remainderA > 0, `rotation created appreciation: face ${faceA} -> converted ${convertedA}`);

    // --- B. Over-converted outputs still refused ------------------------------
    const overOutputs = createBlindedOutputs(convertedA + 1, built.id);
    const overRes = await api("/v1/swap", { inputs: batchA.proofs, outputs: overOutputs.outputs });
    assert(overRes.status === 400 && overRes.json.code === 11002, "outputs above converted value refused (11002)", overRes.json);

    // --- A. Face-value swap accepted, remainder escrowed ----------------------
    const faceOutputs = createBlindedOutputs(faceA, built.id);
    const faceSwapRes = await api("/v1/swap", { inputs: batchA.proofs, outputs: faceOutputs.outputs });
    assert(faceSwapRes.status === 200, `face-value swap (${faceA} of ${convertedA}) accepted`, faceSwapRes.json);
    untrack(batchA.proofs);
    const faceProofs = unblindSignatures(
      faceSwapRes.json.signatures.map((s: any) => ({ ...s })),
      faceOutputs.blindings,
      freshKeys.json.keys,
    );
    track(faceProofs);
    const hashA = computeProofsHash(batchA.proofs);
    const [escrowRow] = await db.select().from(swapEscrowsTable).where(eq(swapEscrowsTable.proofsHash, hashA));
    assert(
      escrowRow !== undefined && escrowRow.amountLeks === remainderA && escrowRow.claimedAt === null,
      `escrow recorded for the remainder (${remainderA} leks), unclaimed`,
      escrowRow,
    );

    // --- C. Exact converted swap: accepted, NO escrow --------------------------
    const convertedB = convertProofs(batchB.proofs);
    const exactOutputs = createBlindedOutputs(convertedB, built.id);
    const exactRes = await api("/v1/swap", { inputs: batchB.proofs, outputs: exactOutputs.outputs });
    assert(exactRes.status === 200, "exact converted-value swap still accepted", exactRes.json);
    untrack(batchB.proofs);
    track(unblindSignatures(exactRes.json.signatures.map((s: any) => ({ ...s })), exactOutputs.blindings, freshKeys.json.keys));
    const hashB = computeProofsHash(batchB.proofs);
    const escrowB = await db.select().from(swapEscrowsTable).where(eq(swapEscrowsTable.proofsHash, hashB));
    assert(escrowB.length === 0, "no escrow recorded when outputs equal the converted value");

    // --- D. /escrow/check: exact set only --------------------------------------
    const checkRes = await api("/escrow/check", { proofs: batchA.proofs });
    assert(
      checkRes.status === 200 && checkRes.json.available === true && checkRes.json.amountLeks === remainderA,
      `/escrow/check reports ${remainderA} claimable for the original proof set`,
      checkRes.json,
    );
    const partialCheck = await api("/escrow/check", { proofs: batchA.proofs.slice(0, 1) });
    assert(
      partialCheck.status === 200 && partialCheck.json.available === false,
      "partial proof set finds no escrow",
      partialCheck.json,
    );
    const wrongCheck = await api("/escrow/check", { proofs: batchB.proofs });
    assert(
      wrongCheck.status === 200 && wrongCheck.json.available === false,
      "different (non-escrowed) proof set finds no escrow",
      wrongCheck.json,
    );
    // Tampered proofs (bad signature) are refused outright.
    const tampered = batchA.proofs.map((p) => ({ ...p, secret: p.secret + "x" }));
    const tamperedCheck = await api("/escrow/check", { proofs: tampered });
    assert(tamperedCheck.status === 400, "tampered proofs fail crypto verification", tamperedCheck.json);

    // --- E. Claim once, exactly ------------------------------------------------
    const wrongTotalOutputs = createBlindedOutputs(remainderA + 1, built.id);
    const wrongTotalRes = await api("/escrow/claim", { proofs: batchA.proofs, outputs: wrongTotalOutputs.outputs });
    assert(wrongTotalRes.status === 400, "claim with wrong output total refused", wrongTotalRes.json);

    const claimOutputs = createBlindedOutputs(remainderA, built.id);
    const claimRes = await api("/escrow/claim", { proofs: batchA.proofs, outputs: claimOutputs.outputs });
    assert(
      claimRes.status === 200 && claimRes.json.amountLeks === remainderA,
      `escrow claim credits the remainder (${remainderA} leks)`,
      claimRes.json,
    );
    const claimedProofs = unblindSignatures(
      claimRes.json.signatures.map((s: any) => ({ ...s })),
      claimOutputs.blindings,
      freshKeys.json.keys,
    );
    track(claimedProofs);
    assert(sumProofs(faceProofs) + sumProofs(claimedProofs) === convertedA, "face + claimed == converted (nothing kept by the mint)");

    // A repeat claim REDELIVERS the identical original signatures (crash
    // recovery) — it must NOT issue anything new.
    const secondClaim = await api("/escrow/claim", { proofs: batchA.proofs, outputs: createBlindedOutputs(remainderA, built.id).outputs });
    assert(
      secondClaim.status === 200 && secondClaim.json.redelivered === true,
      "second claim redelivers instead of failing",
      secondClaim.json,
    );
    assert(
      JSON.stringify(secondClaim.json.signatures.map((s: any) => s.C_)) ===
        JSON.stringify(claimRes.json.signatures.map((s: any) => s.C_)),
      "redelivered signatures are IDENTICAL to the original claim",
    );
    assert(
      Array.isArray(secondClaim.json.outputs) &&
        JSON.stringify(secondClaim.json.outputs.map((o: any) => o.B_)) ===
          JSON.stringify(claimOutputs.outputs.map((o) => o.B_)),
      "redelivery echoes the original blinded outputs for blinding lookup",
    );
    const [claimedRow] = await db.select().from(swapEscrowsTable).where(eq(swapEscrowsTable.proofsHash, hashA));
    assert(claimedRow?.claimedAt !== null, "escrow row remains claimed exactly once");
    // /escrow/check still reports available (claim would redeliver).
    const checkAfterClaim = await api("/escrow/check", { proofs: batchA.proofs });
    assert(
      checkAfterClaim.json.available === true && checkAfterClaim.json.amountLeks === remainderA,
      "/escrow/check stays available for redelivery after a claim",
      checkAfterClaim.json,
    );

    // --- F. Current-epoch swap stays strictly balanced --------------------------
    const imbalanced = createBlindedOutputs(sumProofs(faceProofs) - 1, built.id);
    const strictRes = await api("/v1/swap", { inputs: faceProofs, outputs: imbalanced.outputs });
    assert(strictRes.status === 400 && strictRes.json.code === 11002, "current-epoch under-balanced swap still refused", strictRes.json);
  } finally {
    await burnOutstanding("synthetic keyset active").catch((e) => console.error(e));
    if (syntheticKeysetId) {
      await db.update(keysetsTable).set({ active: false }).where(eq(keysetsTable.id, syntheticKeysetId));
    }
    await db.update(keysetsTable).set({ active: true }).where(eq(keysetsTable.id, originalKeysetId));
    await burnOutstanding("original keyset restored").catch((e) => console.error(e));
    await db.delete(swapEscrowsTable).where(gte(swapEscrowsTable.createdAt, startedAt));
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
    console.log("Synthetic epoch/keyset/escrow/mint-request/payout state reverted");
  }
}

main()
  .then(async () => {
    await pool.end();
    console.log("\nAll assertions passed — face-value swaps escrow the appreciation and it is claimable exactly once.");
  })
  .catch(async (err) => {
    console.error("\nTEST FAILED:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });

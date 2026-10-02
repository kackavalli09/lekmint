import { Router, type IRouter } from "express";
import type { z } from "zod";
import { Address } from "@scure/btc-signer";
import { db, treasuryDustLogTable, payoutsTable, swapEscrowsTable, swapEscrowOutputsTable, signedOutputsTable } from "@workspace/db";
import { and, eq, isNull, inArray, sql as dsql } from "drizzle-orm";
import {
  RedeemTokensBody,
  SwapTokensBody,
  RecoverSwapBody,
  GetMeltQuoteQueryParams,
  CheckEscrowBody,
  ClaimEscrowBody,
} from "@workspace/api-zod";
import { computeProofsHash, computeBlindedPoint } from "../lib/escrow";
import { validate } from "../middleware/validate";
import {
  getCurrentEpoch,
  convertProofsToRate,
  NoEpochForKeysetError,
  EpochChangedError,
  assertEpochCurrent,
  ZERO_DUST,
  addDustAmounts,
} from "../lib/epochEngine";
import { getOrCreateFeeConfig } from "../lib/mintConfig";
import { computeMeltQuote } from "../lib/meltQuote";
import { getNetworkFeeEstimate } from "../lib/networkFee";
import { logAuditEvent, requestIp } from "../lib/auditLog";
import { markSpentInCache, cacheConfirmedSpent } from "../lib/spentCache";
import {
  verifyInputProofs,
  verifyProofCryptography,
  spendProofs,
  signOutputs,
  sumAmounts,
  persistSignedOutputs,
  ProofValidationError,
  DoubleSpendError,
  assertKeysetsFresh,
} from "../lib/mintService";
import { getActiveKeyset } from "../lib/keysetManager";
import { recordSupplyDelta } from "../lib/supply";
import type { SignedOutput } from "../lib/mintService";
import { recoverLimiter } from "../middleware/rateLimit";

const router: IRouter = Router();

/** True when `address` parses as a mainnet BTC address (base58 or bech32). */
function isValidMainnetAddress(address: string): boolean {
  try {
    Address().decode(address.trim());
    return true;
  } catch {
    return false;
  }
}

function handleTokenError(err: unknown, res: Parameters<Parameters<IRouter["post"]>[1]>[1]): boolean {
  if (
    err instanceof ProofValidationError ||
    err instanceof NoEpochForKeysetError ||
    err instanceof EpochChangedError
  ) {
    res.status(400).json({ error: err.message });
    return true;
  }
  if (err instanceof DoubleSpendError) {
    res.status(409).json({ error: err.message });
    return true;
  }
  return false;
}

router.get(
  "/melt/quote",
  validate({ query: GetMeltQuoteQueryParams }),
  async (_req, res): Promise<void> => {
  const { amountLeks } = res.locals["query"] as z.infer<typeof GetMeltQuoteQueryParams>;
  const [epoch, feeConfig] = await Promise.all([getCurrentEpoch(), getOrCreateFeeConfig()]);
  if (!epoch) {
    res.status(503).json({ error: "Mint not initialized: no active epoch" });
    return;
  }
  // Network transfer fee is a real deduction, separate from the melt fee:
  // net = gross − melt fee − network fee (live rate, deterministic fallback).
  const networkFee = await getNetworkFeeEstimate();
  // Single source of truth: the exact function the payout queue uses.
  const quote = computeMeltQuote(amountLeks, epoch.rateIndex, feeConfig, networkFee.estimatedSats);
  res.json({
    unit: "lek",
    ...quote,
    quotedAt: new Date().toISOString(),
    networkFee: {
      source: networkFee.source,
      estimatedSats: networkFee.estimatedSats,
      satPerVb: networkFee.satPerVb,
    },
  });
  },
);

router.post(
  "/redeem",
  validate({ body: RedeemTokensBody }),
  async (req, res): Promise<void> => {
  const { proofs, btcAddress } = req.body as z.infer<typeof RedeemTokensBody>;
  // Validate the payout address BEFORE burning anything — a burn against an
  // unpayable address would strand the user's funds.
  if (!isValidMainnetAddress(btcAddress)) {
    res.status(400).json({ error: "Invalid BTC payout address (expected a mainnet address)" });
    return;
  }
  try {
    await verifyInputProofs(proofs);
    const currentEpoch = await getCurrentEpoch();
    if (!currentEpoch) {
      res.status(503).json({ error: "Mint not initialized: no active epoch" });
      return;
    }
    // Value inputs at R_current via the shared conversion (identity for
    // current-epoch proofs): swapping old-epoch proofs automatically credits
    // their upgraded value instead of silently dropping the appreciation.
    const converted = await convertProofsToRate(proofs, currentEpoch.rateIndex);
    if (converted.value <= 0) {
      res.status(400).json({ error: "Redeemed amount rounds to 0 leks at the current rate" });
      return;
    }
    await db.transaction(async (tx) => {
      await assertKeysetsFresh(tx, proofs.map((p) => p.id));
      // Bind the preflight conversion to this locked snapshot: if an epoch
      // roll committed since we read the rate, retry rather than misprice.
      await assertEpochCurrent(tx, currentEpoch.id);
      await spendProofs(tx, proofs);
      if (converted.hasVintage) {
        // Implicit upgrade + burn: the converted value is issued and
        // immediately redeemed, the vintage face value leaves circulation,
        // and the fractional remainder accrues to the treasury.
        await recordSupplyDelta(tx, {
          issued: converted.value,
          redeemed: converted.faceTotal + converted.value,
        });
        if (converted.dust !== ZERO_DUST) {
          await tx.insert(treasuryDustLogTable).values({
            sourceOperation: "redeem",
            dustAmount: converted.dust,
          });
        }
      } else {
        await recordSupplyDelta(tx, { redeemed: converted.value });
      }
      // Queue the payout in the same transaction as the burn so every
      // burned lek has a matching payable record (or neither commits).
      await tx.insert(payoutsTable).values({
        btcAddress: btcAddress.trim(),
        amountLeks: converted.value,
        status: "pending",
      });
    });
    markSpentInCache(proofs);
    logAuditEvent("proof_redeemed", requestIp(req), {
      amount: converted.value,
      faceValue: converted.faceTotal,
      btcAddress,
    });
    res.json({ unit: "lek", redeemedAmount: converted.value });
  } catch (err) {
    if (err instanceof DoubleSpendError) {
      cacheConfirmedSpent(proofs);
    }
    if (!handleTokenError(err, res)) {
      throw err;
    }
  }
  },
);

router.post(
  "/swap",
  validate({ body: SwapTokensBody }),
  async (req, res): Promise<void> => {
  const { inputs, outputs } = req.body as z.infer<typeof SwapTokensBody>;
  try {
      const keyset = await getActiveKeyset();
    if (!keyset) {
      res.status(503).json({ error: "Mint not initialized: no active keyset" });
      return;
    }
    await verifyInputProofs(inputs);
    const currentEpoch = await getCurrentEpoch();
    if (!currentEpoch) {
      res.status(503).json({ error: "Mint not initialized: no active epoch" });
      return;
    }
    // Value inputs at R_current via the shared conversion (identity for
    // current-epoch proofs): swapping old-epoch proofs automatically credits
    // their upgraded value instead of silently dropping the appreciation.
    const converted = await convertProofsToRate(inputs, currentEpoch.rateIndex);
      const outputTotal = sumAmounts(outputs);
    if (outputTotal > converted.value) {
      res.status(400).json({
        error: `Output total ${outputTotal} exceeds converted input value ${converted.value}`,
        convertedValue: converted.value,
      });
      return;
    }
    let signatures: SignedOutput[] = [];
    await db.transaction(async (tx) => {
      await assertKeysetsFresh(tx, inputs.map((p) => p.id), keyset.id);
      await assertEpochCurrent(tx, currentEpoch.id);
      await spendProofs(tx, inputs);
      // Sign only after inputs are locked in as spent.
      signatures = signOutputs(keyset, outputs);
      // Same transaction: signatures become redeliverable via /swap/recover
      // exactly when the inputs are spent (crash-safe idempotency).
      await persistSignedOutputs(tx, outputs, signatures, "swap");
      // Rounding dust and deliberately unclaimed value are DIFFERENT things:
      // log them under separate sources so the treasury breakdown stays honest.
      const forfeited = converted.value - outputTotal;
      if (converted.dust !== ZERO_DUST) {
        await tx.insert(treasuryDustLogTable).values({
          sourceOperation: "swap",
          dustAmount: converted.dust,
        });
      }
      if (forfeited > 0) {
        await tx.insert(treasuryDustLogTable).values({
          sourceOperation: "swap_forfeit",
          dustAmount: `${forfeited}.000000000000`,
        });
      }
    });
    markSpentInCache(inputs);
    res.json({ unit: "lek", signatures });
  } catch (err) {
    if (err instanceof ProofValidationError || err instanceof DoubleSpendError) {
      logAuditEvent("swap_failed", requestIp(req), { reason: err.message });
    }
    if (err instanceof DoubleSpendError) {
      cacheConfirmedSpent(inputs);
    }
    if (!handleTokenError(err, res)) {
      throw err;
    }
  }
  },
);

// ---------------------------------------------------------------------------
// Appreciation escrow: remainders from face-value swaps by epoch-unaware
// external wallets, claimable only by presenting the complete original
// (now spent) proofs. See swapEscrowsTable for the full design rationale.
// ---------------------------------------------------------------------------

/**
 * Resolve the escrow a presented proof set can claim, by either key:
 *  1. proofsHash — the presenter holds the ORIGINAL burned input proofs
 *     (the sender's own old token), or
 *  2. output linkage — the presenter holds the token PRODUCED by the
 *     face-value swap, and its proofs carry the DLEQ blinding factor r, so
 *     B_ = Y + r*G recomputes to output points recorded at swap time. All
 *     linkable proofs must point at ONE swap; a mixed set matches nothing.
 * Either way, the caller has already passed cryptographic verification, so
 * only a genuine holder of mint-signed proofs can resolve anything.
 *
 * DECIDED SEMANTICS (bearer-token model): the escrow is a ONE-TIME claim
 * racing between at most two legitimate parties — the sender (who keeps the
 * swap inputs and any change outputs) and the recipient (who holds the sent
 * outputs). Whoever presents first wins, exactly like possession of any
 * ecash token. The site wallet auto-claims at receive time, so in the
 * intended flow the recipient collects immediately; external wallets never
 * call this endpoint. A subset of outputs suffices deliberately — recipients
 * only ever hold the sent subset, never the sender's change.
 */
async function findEscrowForProofs(
  proofs: { id: string; amount: number; secret: string; C: string; r?: string | undefined }[],
): Promise<typeof swapEscrowsTable.$inferSelect | undefined> {
  const proofsHash = computeProofsHash(proofs);
  const [byInputs] = await db
    .select()
    .from(swapEscrowsTable)
    .where(eq(swapEscrowsTable.proofsHash, proofsHash));
  if (byInputs) return byInputs;
  const bValues = proofs
    .map((p) => computeBlindedPoint(p.secret, p.r))
    .filter((b): b is string => b !== null);
  if (bValues.length === 0) return undefined;
  const matches = await db
    .select({ escrowId: swapEscrowOutputsTable.escrowId })
    .from(swapEscrowOutputsTable)
    .where(inArray(swapEscrowOutputsTable.bValue, bValues));
  const escrowIds = [...new Set(matches.map((m) => m.escrowId))];
  if (escrowIds.length !== 1) return undefined;
  const [byOutputs] = await db
    .select()
    .from(swapEscrowsTable)
    .where(eq(swapEscrowsTable.id, escrowIds[0]!));
  return byOutputs;
}

router.post(
  "/escrow/check",
  validate({ body: CheckEscrowBody }),
  async (req, res): Promise<void> => {
    const { proofs } = req.body as z.infer<typeof CheckEscrowBody>;
    try {
      // Crypto verification (not the spent check — these proofs ARE spent):
      // only the holder of valid mint-signed originals learns anything.
      await verifyProofCryptography(proofs);
      const row = await findEscrowForProofs(proofs);
      // "Available" means calling /escrow/claim will succeed: either the
      // escrow is unclaimed, or it was claimed and the original signatures
      // can be redelivered (crash recovery). `redeliverable` distinguishes
      // the recovery case — only the browser that made the original claim
      // holds the blindings needed to use the redelivered signatures.
      const redeliverable = !!row?.claimedAt && !!row.claimBundle;
      const available = !!row && (!row.claimedAt || redeliverable);
      res.json({ available, amountLeks: available ? row!.amountLeks : 0, redeliverable });
    } catch (err) {
      if (!handleTokenError(err, res)) {
        throw err;
      }
    }
  },
);

router.post(
  "/escrow/claim",
  validate({ body: ClaimEscrowBody }),
  async (req, res): Promise<void> => {
    const { proofs, outputs } = req.body as z.infer<typeof ClaimEscrowBody>;
    try {
      const keyset = await getActiveKeyset();
      if (!keyset) {
        res.status(503).json({ error: "Mint not initialized: no active keyset" });
        return;
      }
      await verifyProofCryptography(proofs);
      const outputTotal = sumAmounts(outputs);
      const existing = await findEscrowForProofs(proofs);
      if (!existing) {
        res.status(409).json({ error: "No escrow exists for this proof set" });
        return;
      }
      if (existing.claimedAt) {
        // Already claimed: REDELIVER the identical original signatures (they
        // are useless to anyone but the holder of the matching blindings).
        // This makes the claim idempotent — a wallet that crashed after the
        // mint committed the claim but before storing its proofs recovers by
        // simply claiming again. No new issuance happens here.
        redeliverClaim(existing, res);
        return;
      }
      if (outputTotal !== existing.amountLeks) {
        res.status(400).json({
          error: `Output total ${outputTotal} must equal the escrowed amount ${existing.amountLeks} exactly`,
        });
        return;
      }
      let signatures: SignedOutput[] = [];
      try {
        await db.transaction(async (tx) => {
          await assertKeysetsFresh(tx, [], keyset.id);
          signatures = signOutputs(keyset, outputs);
          // Atomic single-use claim: flips claimedAt only if still unclaimed,
          // storing the signed bundle in the same row for future redelivery.
          const claimed = await tx
            .update(swapEscrowsTable)
            .set({
              claimedAt: dsql`now()`,
              claimBundle: JSON.stringify({ outputs, signatures }),
            })
            .where(and(eq(swapEscrowsTable.id, existing.id), isNull(swapEscrowsTable.claimedAt)))
            .returning({ amountLeks: swapEscrowsTable.amountLeks });
          if (!claimed[0]) {
            throw new EscrowAlreadyClaimedError();
          }
          // The escrowed leks enter circulation only now, at claim time.
          await recordSupplyDelta(tx, { issued: claimed[0].amountLeks });
        });
      } catch (err) {
        if (err instanceof EscrowAlreadyClaimedError) {
          // Lost a race with a concurrent claim — redeliver its bundle.
          const [row] = await db
            .select()
            .from(swapEscrowsTable)
            .where(eq(swapEscrowsTable.id, existing.id));
          if (row?.claimedAt) {
            redeliverClaim(row, res);
            return;
          }
          res.status(409).json({ error: "Escrow claim conflict; please retry" });
          return;
        }
        throw err;
      }
      logAuditEvent("escrow_claimed", requestIp(req), { amount: existing.amountLeks });
      res.json({ unit: "lek", amountLeks: existing.amountLeks, signatures });
    } catch (err) {
      if (!handleTokenError(err, res)) {
        throw err;
      }
    }
  },
);

class EscrowAlreadyClaimedError extends Error {}

/** Redeliver the original claim bundle (outputs + signatures) verbatim. */
function redeliverClaim(
  row: { amountLeks: number; claimBundle: string | null },
  res: Parameters<Parameters<IRouter["post"]>[1]>[1],
): void {
  if (!row.claimBundle) {
    // Claimed before redelivery existed — nothing stored to redeliver.
    res.status(409).json({ error: "This escrow has already been claimed" });
    return;
  }
  const bundle = JSON.parse(row.claimBundle) as {
    outputs?: unknown[];
    signatures?: SignedOutput[];
  };
  if (!bundle.signatures || !bundle.outputs) {
    // e.g. released by the operator via the admin dashboard — there are no
    // blind signatures to redeliver to a wallet.
    res.status(409).json({ error: "This escrow has already been claimed" });
    return;
  }
  res.json({
    unit: "lek",
    amountLeks: row.amountLeks,
    signatures: bundle.signatures,
    outputs: bundle.outputs,
    redelivered: true,
  });
}

router.post(
  "/swap/recover",
  recoverLimiter,
  validate({ body: RecoverSwapBody }),
  async (req, res): Promise<void> => {
    const { outputs } = req.body as z.infer<typeof RecoverSwapBody>;
    // Idempotent, read-only redelivery: return whatever was previously
    // signed for these blinded messages, null where nothing was ever signed
    // (that operation never committed, so its inputs are still spendable).
    const rows = await db
      .select()
      .from(signedOutputsTable)
      .where(inArray(signedOutputsTable.b, outputs));
    const byB = new Map(rows.map((r) => [r.b, r]));
    const signatures = outputs.map((b) => {
      const row = byB.get(b);
      if (!row) return null;
      return {
        id: row.keysetId,
        amount: row.amount,
        C_: row.cBlind,
        dleq: { e: row.dleqE, s: row.dleqS },
      };
    });
    logAuditEvent("swap_recovery_attempted", requestIp(req), {
      requested: outputs.length,
      found: rows.length,
    });
    res.json({ unit: "lek", signatures });
  },
);

export default router;

import { Router, type IRouter } from "express";
import { eq, desc, sql } from "drizzle-orm";
import type { z } from "zod";
import { db, mintRequestsTable, btcTransactionsTable, treasuryDustLogTable } from "@workspace/db";
import type { MintRequest } from "@workspace/db";
import {
  CreateMintRequestBody,
  IssueTokensBody,
  RecoverTokensBody,
  UpgradeTokensBody,
} from "@workspace/api-zod";
import { validate } from "../middleware/validate";
import { mintRequestLimiter, recoverLimiter } from "../middleware/rateLimit";
import { logAuditEvent, requestIp } from "../lib/auditLog";
import { markSpentInCache, cacheConfirmedSpent } from "../lib/spentCache";
import { deriveNextAddress, XpubNotConfiguredError } from "../lib/fundWallet";
import { snapshotAddressBaseline } from "../lib/depositWatcher";
import { logger } from "../lib/logger";
import { getOrCreateAdminConfig } from "../lib/mintConfig";
import { getActiveKeyset } from "../lib/keysetManager";
import {
  getCurrentEpoch,
  getEpochByKeysetId,
  convertValueMulti,
  assertEpochCurrent,
  EpochChangedError,
  ZERO_DUST,
} from "../lib/epochEngine";
import {
  verifyInputProofs,
  spendProofs,
  signOutputs,
  sumAmounts,
  assertKeysetsFresh,
  persistSignedOutputs,
  ProofValidationError,
  DoubleSpendError,
  type SignedOutput,
} from "../lib/mintService";
import { recordSupplyDelta } from "../lib/supply";

const router: IRouter = Router();

async function buildRequestStatus(request: MintRequest): Promise<Record<string, unknown>> {
  const txs = await db
    .select({ confirmations: btcTransactionsTable.confirmations })
    .from(btcTransactionsTable)
    .where(eq(btcTransactionsTable.address, request.btcAddress));
  const confirmations = txs.length ? Math.max(...txs.map((t) => t.confirmations)) : 0;
  const config = await getOrCreateAdminConfig();
  // How many leks issuance will mint for the confirmed net sats at the
  // CURRENT epoch rate — the wallet must build outputs for exactly this.
  let expectedLeks: number | null = null;
  if (request.netAmountSats !== null && request.netAmountSats !== undefined) {
    const epoch = await getCurrentEpoch();
    if (epoch) {
      expectedLeks = convertValueMulti(
        [{ amount: request.netAmountSats, fromRate: "1.000000000000" }],
        epoch.rateIndex,
      ).value;
    }
  }
  return {
    expectedLeks,
    id: request.id,
    btcAddress: request.btcAddress,
    status: request.status,
    unit: "lek",
    requestedAmountSats: request.requestedAmountSats,
    grossAmountSats: request.grossAmountSats,
    feeSats: request.feeSats,
    netAmountSats: request.netAmountSats,
    confirmations,
    minConfirmations: config.minConfirmations,
    createdAt: request.createdAt.toISOString(),
  };
}

router.post(
  "/mint/request",
  mintRequestLimiter,
  validate({ body: CreateMintRequestBody }),
  async (req, res): Promise<void> => {
  const body = req.body as z.infer<typeof CreateMintRequestBody>;

  let addressRow;
  try {
    addressRow = await deriveNextAddress();
  } catch (err) {
    if (err instanceof XpubNotConfiguredError) {
      res.status(503).json({ error: err.message });
      return;
    }
    throw err;
  }

  // Snapshot the chain baseline BEFORE the request exists: only txs confirmed
  // strictly after this tip height (and not already present at the address)
  // can ever be credited. Fail loudly if the snapshot is unavailable — a
  // request without a baseline could credit pre-existing coins.
  let baseline;
  try {
    baseline = await snapshotAddressBaseline(addressRow.address);
  } catch (err) {
    logger.warn({ err, address: addressRow.address }, "Baseline snapshot failed");
    res.status(503).json({
      error: "Cannot verify the deposit address with the Bitcoin network right now; try again shortly",
    });
    return;
  }

  const [request] = await db
    .insert(mintRequestsTable)
    .values({
      btcAddress: addressRow.address,
      requestedAmountSats: body.amountSats ?? null,
      status: "pending",
      baselineTipHeight: baseline.tipHeight,
      excludedTxids: baseline.existingTxids,
    })
    .returning();

  logAuditEvent("mint_request_created", requestIp(req), { requestId: request!.id });
  res.status(201).json(await buildRequestStatus(request!));
  },
);

router.get("/mint/status/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!raw || !/^[0-9a-f-]{36}$/i.test(raw)) {
    res.status(404).json({ error: "Mint request not found" });
    return;
  }

  const [request] = await db
    .select()
    .from(mintRequestsTable)
    .where(eq(mintRequestsTable.id, raw));

  if (!request) {
    res.status(404).json({ error: "Mint request not found" });
    return;
  }

  res.json(await buildRequestStatus(request));
});

router.post(
  "/mint/issue",
  validate({ body: IssueTokensBody }),
  async (req, res): Promise<void> => {
  const { requestId, outputs } = req.body as z.infer<typeof IssueTokensBody>;
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) {
    res.status(404).json({ error: "Mint request not found" });
    return;
  }

  const keyset = await getActiveKeyset();
  if (!keyset) {
    res.status(503).json({ error: "Mint not initialized: no active keyset" });
    return;
  }

  const currentEpoch = await getCurrentEpoch();
  if (!currentEpoch) {
    res.status(503).json({ error: "Mint not initialized: no active epoch" });
    return;
  }

  try {
    let signatures: SignedOutput[] = [];

    let issuedLeks = 0;
    const outcome = await db.transaction(async (tx) => {
      // Row lock prevents concurrent double-issuance for the same request.
      const [request] = await tx
        .select()
        .from(mintRequestsTable)
        .where(eq(mintRequestsTable.id, requestId))
        .for("update");
      if (!request) {
        return { code: 404 as const, error: "Mint request not found" };
      }
      if (request.status === "issued") {
        return { code: 409 as const, error: "Mint request already issued" };
      }
      if (request.status !== "confirmed") {
        return {
          code: 409 as const,
          error: `Mint request is not confirmed yet (status: ${request.status})`,
        };
      }
      const netAmount = request.netAmountSats ?? 0;
      // Issuance applies the current epoch rate: leks = floor(netSats * R),
      // via the same shared conversion used for upgrades (sats are valued at
      // the genesis rate 1.0). Keeps deposit -> melt round-trips at par.
      const { value, dust } = convertValueMulti(
        [{ amount: netAmount, fromRate: "1.000000000000" }],
        currentEpoch.rateIndex,
      );
      issuedLeks = value;
      const outputTotal = sumAmounts(outputs);
      if (outputTotal !== issuedLeks) {
        return {
          code: 400 as const,
          error: `Output total ${outputTotal} must equal issuable amount ${issuedLeks} (net ${netAmount} sats at rate ${currentEpoch.rateIndex})`,
        };
      }
      await assertKeysetsFresh(tx, [], keyset.id);
      await assertEpochCurrent(tx, currentEpoch.id);
      signatures = signOutputs(keyset, outputs);
      await tx
        .update(mintRequestsTable)
        .set({ status: "issued", issuedSignatures: signatures, proofsIssuedAt: new Date() })
        .where(eq(mintRequestsTable.id, requestId));
      if (dust !== ZERO_DUST) {
        await tx.insert(treasuryDustLogTable).values({
          sourceOperation: "issue",
          dustAmount: dust,
        });
      }
      await recordSupplyDelta(tx, { issued: issuedLeks });
      return { code: 200 as const };
    });

    if (outcome.code !== 200) {
      res.status(outcome.code).json({ error: outcome.error });
      return;
    }
    logAuditEvent("proof_issued", requestIp(req), { requestId, amount: issuedLeks });
    res.json({ unit: "lek", signatures });
  } catch (err) {
    if (err instanceof ProofValidationError || err instanceof EpochChangedError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  },
);

router.post(
  "/mint/recover",
  recoverLimiter,
  validate({ body: RecoverTokensBody }),
  async (req, res): Promise<void> => {
  const body = req.body as z.infer<typeof RecoverTokensBody>;
  const [request] = await db
    .select()
    .from(mintRequestsTable)
    .where(eq(mintRequestsTable.btcAddress, body.btcAddress.trim()))
    .orderBy(desc(mintRequestsTable.createdAt))
    .limit(1);
  logAuditEvent("recovery_attempted", requestIp(req), { found: Boolean(request) });
  if (!request) {
    res.status(404).json({ error: "No mint request found for this address" });
    return;
  }
  res.json({
    request: await buildRequestStatus(request),
    signatures: request.status === "issued" ? request.issuedSignatures : null,
  });
  },
);

router.post(
  "/mint/upgrade",
  validate({ body: UpgradeTokensBody }),
  async (req, res): Promise<void> => {
  const { proofs, outputs } = req.body as z.infer<typeof UpgradeTokensBody>;

  try {
    const [keyset, currentEpoch] = await Promise.all([getActiveKeyset(), getCurrentEpoch()]);
    if (!keyset || !currentEpoch) {
      res.status(503).json({ error: "Mint not initialized: no active epoch" });
      return;
    }

    await verifyInputProofs(proofs);

    // Resolve each proof's vintage rate via its keyset -> epoch.
    const items: Array<{ amount: number; fromRate: string }> = [];
    for (const proof of proofs) {
      const epoch = await getEpochByKeysetId(proof.id);
      if (!epoch) {
        res.status(400).json({ error: `No epoch found for keyset ${proof.id}` });
        return;
      }
      items.push({ amount: proof.amount, fromRate: epoch.rateIndex });
    }

    const oldValue = sumAmounts(proofs);
    const { value: newValue, dust } = convertValueMulti(items, currentEpoch.rateIndex);
    const outputTotal = sumAmounts(outputs);
    if (outputTotal !== newValue) {
      res.status(400).json({
        error: `Output total ${outputTotal} must equal upgraded value ${newValue}`,
      });
      return;
    }

    let signatures: SignedOutput[] = [];
    await db.transaction(async (tx) => {
      await assertKeysetsFresh(tx, proofs.map((p) => p.id), keyset.id);
      await spendProofs(tx, proofs);
      signatures = signOutputs(keyset, outputs);
      // Same transaction: redeliverable via /swap/recover after a crash.
      await persistSignedOutputs(tx, outputs, signatures, "upgrade");
      if (dust !== `0.${"0".repeat(12)}`) {
        await tx.insert(treasuryDustLogTable).values({
          sourceOperation: "upgrade",
          dustAmount: dust,
        });
      }
      await recordSupplyDelta(tx, { issued: newValue, redeemed: oldValue });
    });
    markSpentInCache(proofs);
    logAuditEvent("proof_upgrade", requestIp(req), { oldValue, newValue });

    res.json({
      unit: "lek",
      oldValue,
      newValue,
      rateIndex: currentEpoch.rateIndex,
      signatures,
    });
  } catch (err) {
    if (err instanceof ProofValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof DoubleSpendError) {
      cacheConfirmedSpent(proofs);
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
  },
);

export default router;

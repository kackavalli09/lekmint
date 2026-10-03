import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { readFile } from "node:fs/promises";
import { VERSION } from "../version.js";
import { inArray } from "drizzle-orm";
import { db, proofsTable, treasuryDustLogTable, swapEscrowsTable, swapEscrowOutputsTable } from "@workspace/db";
import { computeProofsHash } from "../lib/escrow";
import {
  getCurrentEpoch,
  convertProofsToRate,
  NoEpochForKeysetError,
  EpochChangedError,
  assertEpochCurrent,
  ZERO_DUST,
} from "../lib/epochEngine";
import { getActiveKeyset, getKeysetById, listPublicKeysets, getPublicKeys } from "../lib/keysetManager";
import {
  verifyInputProofs,
  spendProofs,
  signOutputs,
  sumAmounts,
  ProofValidationError,
  DoubleSpendError,
  assertKeysetsFresh,
} from "../lib/mintService";
import { markSpentInCache, cacheConfirmedSpent } from "../lib/spentCache";
import { recordSupplyDelta } from "../lib/supply";
import { logAuditEvent, requestIp } from "../lib/auditLog";
import type { SignedOutput } from "../lib/mintService";

/**
 * Cashu NUT-compatible protocol surface, mounted at /api/v1 so external
 * wallets (cashu.me, Minibits, ...) can connect using the mint URL
 * `<origin>/api`. This is a thin layer over the same keyset / swap /
 * spent-proof logic the custom API uses — double-spend protection is shared.
 *
 * Supported: NUT-01 (keys), NUT-02 (keysets), NUT-03 (swap), NUT-06 (info),
 * NUT-07 (checkstate), NUT-12 (DLEQ on blind signatures).
 * Not supported (advertised disabled): NUT-04/05 — this mint is on-chain
 * only; funding and cashing out happen on the Lek Mint site.
 */
const router: IRouter = Router();

const UNIT = "lek";
const ICON_PATH = "/icon-352e7e44.png";
const ICON_URL = `https://lekmint.cash/api/v1${ICON_PATH}`;
const ICON_CACHE_CONTROL = "public, max-age=31536000, immutable";
const iconBytes = readFile(new URL("./wallet-icon.png", import.meta.url));

const HexPoint = z.string().regex(/^[0-9a-fA-F]{66}$/, "expected a compressed point in hex");

const V1Proof = z.object({
  id: z.string().min(1),
  amount: z.number().int().positive(),
  secret: z.string().min(1).max(512),
  C: HexPoint,
  // Wallets may attach witness/dleq fields; ignore them.
});

const SwapBody = z.object({
  inputs: z.array(V1Proof).min(1).max(256),
  outputs: z
    .array(
      z.object({
        id: z.string().min(1),
        amount: z.number().int().positive(),
        B_: HexPoint,
      }),
    )
    .min(1)
    .max(256),
});

const CheckStateBody = z.object({
  Ys: z.array(HexPoint).min(1).max(1024),
});

function sendCashuError(res: Parameters<Parameters<IRouter["post"]>[1]>[1], status: number, detail: string, code = 10000): void {
  // NUT error format: { detail, code }
  res.status(status).json({ detail, code });
}

// ---------------------------------------------------------------------------
// NUT-06: mint info
// ---------------------------------------------------------------------------
router.get(ICON_PATH, async (_req, res): Promise<void> => {
  res.set({
    "Cache-Control": ICON_CACHE_CONTROL,
    "Content-Type": "image/png",
  });
  res.send(await iconBytes);
});

router.get("/info", async (_req, res): Promise<void> => {
  res.json({
    name: "Lek Mint",
    version: `LekMint/${VERSION}`,
    description: "On-chain Bitcoin ecash mint. Unit: lek (difficulty-pegged).",
    icon_url: ICON_URL,
    description_long:
      "Lek Mint issues ecash backed by on-chain Bitcoin deposits only — there is no Lightning. " +
      "Minting (deposits) and melting (withdrawals to a BTC address) happen on the Lek Mint website. " +
      "External Cashu wallets can hold, send, receive, and swap lek tokens. " +
      "Note: lek is difficulty-pegged via epochs — after an epoch rate change, older tokens are worth MORE than their face value. " +
      "Face-value swaps of old tokens are accepted; the appreciation is escrowed for the sender and credited when the original token is pasted into the Lek Mint website wallet.",
    contact: [],
    motd:
      "Deposits and withdrawals happen on the Lek Mint website, not via Lightning. " +
      "After an epoch rate change, old tokens swap at face value here; paste the original token into the Lek Mint website wallet to collect the escrowed difference. " +
      // Static on purpose: publishing live escrow counts/totals would leak
      // mint-wide financial activity on a public, pollable endpoint.
      "Not sure if your token carries held-back value? The website's Receive tab has a free 'Check value' button.",
    time: Math.floor(Date.now() / 1000),
    nuts: {
      "4": { methods: [], disabled: true },
      "5": { methods: [], disabled: true },
      "7": { supported: true },
      "8": { supported: false },
      "9": { supported: false },
      "10": { supported: false },
      "11": { supported: false },
      "12": { supported: true },
    },
  });
});

// ---------------------------------------------------------------------------
// NUT-01 / NUT-02: keys and keysets
// ---------------------------------------------------------------------------
router.get("/keys", async (_req, res): Promise<void> => {
  const keyset = await getActiveKeyset();
  if (!keyset) {
    sendCashuError(res, 503, "Mint not initialized: no active keyset");
    return;
  }
  res.json({ keysets: [{ id: keyset.id, unit: UNIT, keys: getPublicKeys(keyset) }] });
});

router.get("/keys/:keysetId", async (req, res): Promise<void> => {
  const keyset = await getKeysetById(req.params["keysetId"] ?? "");
  // Revoked keysets stay discoverable (read-only) so wallets can reconcile
  // their cache after a rotation; signing/spending with them stays rejected.
  if (!keyset) {
    sendCashuError(res, 404, "Keyset not found", 12001);
    return;
  }
  res.json({ keysets: [{ id: keyset.id, unit: UNIT, keys: getPublicKeys(keyset) }] });
});

router.get("/keysets", async (_req, res): Promise<void> => {
  const keysets = await listPublicKeysets();
  res.json({
    keysets: keysets.map((k) => ({
      id: k.id,
      unit: UNIT,
      active: k.active,
      input_fee_ppk: 0,
    })),
  });
});

// ---------------------------------------------------------------------------
// NUT-03: swap
// ---------------------------------------------------------------------------
router.post("/swap", async (req, res): Promise<void> => {
  const parsed = SwapBody.safeParse(req.body);
  if (!parsed.success) {
    sendCashuError(res, 400, "Invalid swap request body");
    return;
  }
  const { inputs, outputs } = parsed.data;
  try {
    const keyset = await getActiveKeyset();
    if (!keyset) {
      sendCashuError(res, 503, "Mint not initialized: no active keyset");
      return;
    }
    await verifyInputProofs(inputs);
    const currentEpoch = await getCurrentEpoch();
    if (!currentEpoch) {
      sendCashuError(res, 503, "Mint not initialized: no active epoch");
      return;
    }
    // Value inputs at R_current (identity for current-epoch proofs) so
    // external wallets spending old-epoch proofs are credited the upgraded
    // value — the same rule as the site's custom /swap.
    const converted = await convertProofsToRate(inputs, currentEpoch.rateIndex);
    const outputTotal = sumAmounts(outputs);
    // TOKENOMICS INVARIANT (defensive): the HWM rate index only ever rises,
    // so an old-epoch lek can NEVER convert to fewer current-epoch leks.
    // A computed downward conversion means corrupted epoch data or a math
    // bug — refuse loudly rather than burn value.
    if (converted.hasVintage && converted.value < converted.faceTotal) {
      console.error(
        `[EPOCH INVARIANT VIOLATION] vintage conversion went DOWN: face=${converted.faceTotal} converted=${converted.value} epoch=${currentEpoch.id} rate=${currentEpoch.rateIndex}`,
      );
      logAuditEvent("epoch_invariant_violation", requestIp(req), {
        faceTotal: converted.faceTotal,
        convertedValue: converted.value,
        epochId: currentEpoch.id,
        api: "cashu-v1",
      });
      sendCashuError(
        res,
        500,
        "Mint refused this swap: internal epoch-rate inconsistency detected (your tokens were NOT spent). The operator has been alerted.",
        20000,
      );
      return;
    }
    // Standard Cashu wallets always balance swaps at FACE value — they don't
    // understand epochs. DECIDED BEHAVIOR: for vintage inputs the mint
    // accepts any output total up to the converted value; the remainder
    // (typically the epoch appreciation) is ESCROWED for the sender, keyed to
    // the burned proof set, and auto-credited when the original token is
    // pasted into the Lek Mint site wallet. The mint keeps nothing.
    // Current-epoch swaps remain strictly balanced (input_fee_ppk = 0).
    const balanced = converted.hasVintage
      ? outputTotal <= converted.value
      : outputTotal === converted.value;
    if (!balanced) {
      const hint = converted.hasVintage
        ? ` This token includes old-epoch leks now worth ${converted.value} (face ${converted.faceTotal}). Build outputs totaling at most ${converted.value}; any difference is credited back to you when you paste the original token into the Lek Mint website wallet.`
        : "";
      sendCashuError(
        res,
        400,
        `Transaction is not balanced: inputs are worth ${converted.value} at the current epoch rate, outputs ${outputTotal} (fees are 0).${hint}`,
        11002,
      );
      return;
    }
    const escrowRemainder = converted.hasVintage ? converted.value - outputTotal : 0;
    let signatures: SignedOutput[] = [];
    await db.transaction(async (tx) => {
      await assertKeysetsFresh(tx, inputs.map((p) => p.id), keyset.id);
      await assertEpochCurrent(tx, currentEpoch.id);
      await spendProofs(tx, inputs);
      signatures = signOutputs(keyset, outputs);
      if (converted.hasVintage) {
        await recordSupplyDelta(tx, { issued: outputTotal, redeemed: converted.faceTotal });
        if (converted.dust !== ZERO_DUST) {
          await tx.insert(treasuryDustLogTable).values({
            sourceOperation: "swap",
            dustAmount: converted.dust,
          });
        }
        if (escrowRemainder > 0) {
          // Escrow the sender's appreciation. Issuance happens at claim time,
          // so face + outputs + escrow never exceeds backing meanwhile.
          const [escrowRow] = await tx
            .insert(swapEscrowsTable)
            .values({
              proofsHash: computeProofsHash(inputs),
              amountLeks: escrowRemainder,
              faceTotal: converted.faceTotal,
              convertedValue: converted.value,
            })
            .returning({ id: swapEscrowsTable.id });
          // Record each output's blinded point so the RESULTING token (whose
          // proofs carry the DLEQ blinding factor r) can also claim this
          // escrow — external wallets keep the input proofs internally, so
          // without this linkage the appreciation would be stranded.
          await tx.insert(swapEscrowOutputsTable).values(
            outputs.map((o) => ({
              escrowId: escrowRow!.id,
              bValue: o.B_.toLowerCase(),
            })),
          );
        }
      }
    });
    markSpentInCache(inputs);
    res.json({ signatures });
  } catch (err) {
    if (err instanceof DoubleSpendError) {
      cacheConfirmedSpent(inputs);
      logAuditEvent("swap_failed", requestIp(req), { reason: err.message, api: "cashu-v1" });
      sendCashuError(res, 400, "Token already spent", 11001);
      return;
    }
    if (
      err instanceof ProofValidationError ||
      err instanceof NoEpochForKeysetError ||
      err instanceof EpochChangedError
    ) {
      logAuditEvent("swap_failed", requestIp(req), { reason: err.message, api: "cashu-v1" });
      sendCashuError(res, 400, err.message, 10003);
      return;
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// NUT-07: token state check
// ---------------------------------------------------------------------------
router.post("/checkstate", async (req, res): Promise<void> => {
  const parsed = CheckStateBody.safeParse(req.body);
  if (!parsed.success) {
    sendCashuError(res, 400, "Invalid checkstate request body");
    return;
  }
  const ys = parsed.data.Ys.map((y) => y.toLowerCase());
  const rows = await db
    .select({ y: proofsTable.y })
    .from(proofsTable)
    .where(inArray(proofsTable.y, ys));
  const spent = new Set(rows.map((r) => r.y));
  res.json({
    states: parsed.data.Ys.map((original) => ({
      Y: original,
      state: spent.has(original.toLowerCase()) ? "SPENT" : "UNSPENT",
    })),
  });
});

// NUT-09 restore is not supported; be explicit rather than a bare 404.
router.post("/restore", (_req, res): void => {
  sendCashuError(res, 404, "Restore (NUT-09) is not supported by this mint", 10002);
});

// Quote endpoints exist in the spec paths some wallets probe even when
// NUT-04/05 are disabled — answer clearly instead of a generic 404.
router.all(["/mint/quote/:method", "/melt/quote/:method"], (_req, res): void => {
  sendCashuError(
    res,
    404,
    "This mint has no Lightning. Deposits and withdrawals happen on the Lek Mint website.",
    10002,
  );
});

export default router;

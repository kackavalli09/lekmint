import { Router, type IRouter } from "express";
import { asc } from "drizzle-orm";
import { db, epochsTable } from "@workspace/db";
import { getActiveKeyset, getPublicKeys, listPublicKeysets } from "../lib/keysetManager";
import { getCurrentEpoch, getGenesisEpoch, parseDecimalScaled, formatScaled, RATE_SCALE } from "../lib/epochEngine";

const router: IRouter = Router();

router.get("/keys", async (_req, res): Promise<void> => {
  const keyset = await getActiveKeyset();
  if (!keyset) {
    res.status(503).json({ error: "Mint not initialized: no active keyset" });
    return;
  }
  res.json({ keysetId: keyset.id, unit: keyset.unit, keys: getPublicKeys(keyset) });
});

router.get("/keysets", async (_req, res): Promise<void> => {
  const keysets = await listPublicKeysets();
  res.json({
    keysets: keysets.map((k) => ({
      id: k.id,
      unit: k.unit,
      active: k.active,
      epochId: k.epochId,
      // Revoked keysets' proofs are permanently invalid (security rotation);
      // plain inactive keysets are historical but still redeemable.
      revoked: k.revokedAt !== null,
    })),
  });
});

router.get("/epochs", async (_req, res): Promise<void> => {
  const [epochs, current, genesis] = await Promise.all([
    db.select().from(epochsTable).orderBy(asc(epochsTable.id)),
    getCurrentEpoch(),
    getGenesisEpoch(),
  ]);
  // C_0 = D_0 / max(1, S_0), reported at rate precision.
  let genesisCalibration: string | null = null;
  if (genesis) {
    const d0 = parseDecimalScaled(genesis.difficulty, 4);
    const s0 = BigInt(Math.max(1, genesis.subsidySats));
    genesisCalibration = formatScaled((d0 * 10n ** BigInt(RATE_SCALE)) / (s0 * 10_000n), RATE_SCALE);
  }
  res.json({
    unit: "lek",
    currentEpochId: current?.id ?? null,
    currentRateIndex: current?.rateIndex ?? null,
    genesisCalibration,
    epochs: epochs.map((e) => ({
      id: e.id,
      keysetId: e.keysetId,
      rateIndex: e.rateIndex,
      difficulty: e.difficulty,
      subsidySats: e.subsidySats,
      startedAt: e.startedAt.toISOString(),
    })),
  });
});

export default router;

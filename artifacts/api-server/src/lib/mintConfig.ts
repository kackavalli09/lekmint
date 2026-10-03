import { db, adminConfigTable, feeConfigTable } from "@workspace/db";
import type { AdminConfig, FeeConfig } from "@workspace/db";
import { asc } from "drizzle-orm";

/**
 * Singleton config rows. Both admin_config and fee_config hold exactly one
 * active row (the oldest); created on demand with defaults.
 */

export async function getOrCreateAdminConfig(): Promise<AdminConfig> {
  const [existing] = await db
    .select()
    .from(adminConfigTable)
    .orderBy(asc(adminConfigTable.id))
    .limit(1);
  if (existing) {
    return existing;
  }
  const [created] = await db.insert(adminConfigTable).values({}).returning();
  return created!;
}

export async function getOrCreateFeeConfig(): Promise<FeeConfig> {
  const [existing] = await db
    .select()
    .from(feeConfigTable)
    .orderBy(asc(feeConfigTable.id))
    .limit(1);
  if (existing) {
    return existing;
  }
  const [created] = await db.insert(feeConfigTable).values({}).returning();
  return created!;
}

/** The three parameters the fee formula needs. */
export interface FeeParams {
  fixedFeeSats: number;
  percentageFeeBps: number;
  minThresholdSats: number;
}

/**
 * Effective melt (redemption) fee parameters. Melt-specific values apply
 * when configured; NULL columns fall back to the mint (deposit) values, so
 * a mint that never configured melt fees keeps its historical behavior.
 */
export function getMeltFeeParams(config: FeeConfig): FeeParams {
  return {
    fixedFeeSats: config.meltFixedFeeSats ?? config.fixedFeeSats,
    percentageFeeBps: config.meltPercentageFeeBps ?? config.percentageFeeBps,
    minThresholdSats: config.meltMinThresholdSats ?? config.minThresholdSats,
  };
}

/**
 * Fee rule (deposits and melts): amounts below the threshold pay no fee;
 * otherwise fee = fixed + round(amount * bps / 10_000), capped at the amount.
 */
export function calculateFee(amountSats: number, config: FeeParams): number {
  if (amountSats < config.minThresholdSats) {
    return 0;
  }
  const fee =
    config.fixedFeeSats + Math.round((amountSats * config.percentageFeeBps) / 10_000);
  return Math.min(fee, amountSats);
}

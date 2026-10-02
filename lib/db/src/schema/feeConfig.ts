import { pgTable, serial, bigint, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Mint fee configuration (single active row).
 * fee = fixedFeeSats + amount * percentageFeeBps / 10_000,
 * applied only when amount >= minThresholdSats.
 */
export const feeConfigTable = pgTable("fee_config", {
  id: serial("id").primaryKey(),
  fixedFeeSats: bigint("fixed_fee_sats", { mode: "number" }).notNull().default(0),
  percentageFeeBps: integer("percentage_fee_bps").notNull().default(0),
  minThresholdSats: bigint("min_threshold_sats", { mode: "number" }).notNull().default(0),
  // Melt (redemption) fee component. NULL means "not separately configured":
  // melts then fall back to the mint fee values above, so adding these
  // columns changes nothing until the operator saves melt-specific values.
  meltFixedFeeSats: bigint("melt_fixed_fee_sats", { mode: "number" }),
  meltPercentageFeeBps: integer("melt_percentage_fee_bps"),
  meltMinThresholdSats: bigint("melt_min_threshold_sats", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertFeeConfigSchema = createInsertSchema(feeConfigTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertFeeConfig = z.infer<typeof insertFeeConfigSchema>;
export type FeeConfig = typeof feeConfigTable.$inferSelect;

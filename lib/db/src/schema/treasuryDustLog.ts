import { pgTable, serial, text, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Dust ledger: fractional remainders discarded by the floor function during
 * cross-epoch conversions accumulate here (mint solvency buffer).
 */
export const treasuryDustLogTable = pgTable("treasury_dust_log", {
  id: serial("id").primaryKey(),
  // issue = deposit-issuance rounding, upgrade/redeem/swap = cross-epoch
  // conversion rounding, swap_forfeit = value a swap deliberately left
  // unclaimed (outputs below converted input value).
  sourceOperation: text("source_operation").notNull(), // issue | upgrade | swap | swap_forfeit | redeem
  dustAmount: numeric("dust_amount", { precision: 40, scale: 12 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertTreasuryDustLogSchema = createInsertSchema(treasuryDustLogTable).omit({
  id: true,
  createdAt: true,
});
export type InsertTreasuryDustLog = z.infer<typeof insertTreasuryDustLogSchema>;
export type TreasuryDustLog = typeof treasuryDustLogTable.$inferSelect;

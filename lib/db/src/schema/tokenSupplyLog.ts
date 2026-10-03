import { pgTable, serial, bigint, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Supply snapshots for auditing: leks outstanding vs BTC held.
 */
export const tokenSupplyLogTable = pgTable("token_supply_log", {
  id: serial("id").primaryKey(),
  snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull().defaultNow(),
  totalLeksIssued: bigint("total_leks_issued", { mode: "number" }).notNull().default(0),
  totalLeksRedeemed: bigint("total_leks_redeemed", { mode: "number" }).notNull().default(0),
  btcBalanceSats: bigint("btc_balance_sats", { mode: "number" }).notNull().default(0),
});

export const insertTokenSupplyLogSchema = createInsertSchema(tokenSupplyLogTable).omit({
  id: true,
  snapshotAt: true,
});
export type InsertTokenSupplyLog = z.infer<typeof insertTokenSupplyLogSchema>;
export type TokenSupplyLog = typeof tokenSupplyLogTable.$inferSelect;

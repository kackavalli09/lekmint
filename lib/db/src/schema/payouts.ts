import { pgTable, serial, text, integer, bigint, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Payout queue: one row per melt (/redeem). Written in the same transaction
 * as the proof burn so every burned lek has a matching payable record.
 * The operator batches pending rows into cold-storage payouts and marks
 * them paid once broadcast.
 */
export const payoutsTable = pgTable(
  "payouts",
  {
    id: serial("id").primaryKey(),
    btcAddress: text("btc_address").notNull(),
    amountLeks: integer("amount_leks").notNull(),
    status: text("status").notNull().default("pending"), // pending | paid
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    // BTC owed, FROZEN at the moment the operator marks the payout paid
    // (melt quote at that instant). Null only on legacy rows settled before
    // this column existed; a startup backfill freezes those best-effort.
    paidAmountSats: bigint("paid_amount_sats", { mode: "number" }),
    // True for legacy rows whose value was reconstructed at a later quote
    // (backfill) rather than frozen at settlement time.
    paidAmountIsEstimate: boolean("paid_amount_is_estimate").notNull().default(false),
  },
  (table) => [index("payouts_status_idx").on(table.status)],
);

export const insertPayoutSchema = createInsertSchema(payoutsTable).omit({
  id: true,
  createdAt: true,
  settledAt: true,
});
export type InsertPayout = z.infer<typeof insertPayoutSchema>;
export type Payout = typeof payoutsTable.$inferSelect;

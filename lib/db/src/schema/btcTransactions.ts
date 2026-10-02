import { pgTable, text, serial, bigint, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * On-chain deposits observed on derived addresses (via mempool.space polling).
 */
export const btcTransactionsTable = pgTable(
  "btc_transactions",
  {
    id: serial("id").primaryKey(),
    txid: text("txid").notNull(),
    address: text("address").notNull(),
    amountSats: bigint("amount_sats", { mode: "number" }).notNull(),
    confirmations: integer("confirmations").notNull().default(0),
    status: text("status").notNull().default("detected"), // detected | confirmed | credited
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("btc_tx_txid_address_unique").on(table.txid, table.address)],
);

export const insertBtcTransactionSchema = createInsertSchema(btcTransactionsTable).omit({
  id: true,
  firstSeenAt: true,
  updatedAt: true,
});
export type InsertBtcTransaction = z.infer<typeof insertBtcTransactionSchema>;
export type BtcTransaction = typeof btcTransactionsTable.$inferSelect;

import { pgTable, text, serial, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Deposit addresses derived from the fund wallet xpub.
 * One fresh address per mint request (BIP84, m/84'/0'/0'/0/N).
 * Addresses are scoped to the wallet they were derived from via the BIP32
 * fingerprint, so rotating the xpub can safely restart indices at 0 while
 * historical addresses (and the recovery flow) keep working.
 */
export const btcAddressesTable = pgTable(
  "btc_addresses",
  {
    id: serial("id").primaryKey(),
    address: text("address").notNull().unique(),
    walletFingerprint: text("wallet_fingerprint").notNull(),
    derivationIndex: integer("derivation_index").notNull(),
    status: text("status").notNull().default("pending"), // pending | funded | expired
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    // When the funding deposit was confirmed (the event that makes the
    // address count as "funded" in metrics).
    fundedAt: timestamp("funded_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("btc_addr_wallet_index_unique").on(table.walletFingerprint, table.derivationIndex),
  ],
);

export const insertBtcAddressSchema = createInsertSchema(btcAddressesTable).omit({
  id: true,
  assignedAt: true,
});
export type InsertBtcAddress = z.infer<typeof insertBtcAddressSchema>;
export type BtcAddress = typeof btcAddressesTable.$inferSelect;

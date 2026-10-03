import { pgTable, text, integer, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Mint keysets. One keyset per epoch; private keys (one per power-of-2
 * denomination) are stored AES-256-GCM encrypted as a JSON map
 * { "<amount>": "<privkey hex>" }. Historical keysets are kept forever so
 * tokens of any vintage remain verifiable and redeemable — UNLESS revoked.
 * A revoked keyset (revokedAt set) stays in the DB for history/audit, but the
 * mint refuses its proofs everywhere and hides it from public keyset lists.
 * Revocation happens only via the operator's one-time security rotation.
 */
export const keysetsTable = pgTable("keysets", {
  id: text("id").primaryKey(), // Cashu keyset id: "00" + 14 hex chars
  unit: text("unit").notNull().default("lek"),
  active: boolean("active").notNull().default(false),
  epochId: integer("epoch_id").notNull(),
  encryptedKeys: text("encrypted_keys").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  // DB-level invariant: at most one active keyset can exist at any time.
  uniqueIndex("keysets_single_active_idx").on(table.active).where(sql`${table.active} = true`),
]);

export const insertKeysetSchema = createInsertSchema(keysetsTable).omit({
  createdAt: true,
});
export type InsertKeyset = z.infer<typeof insertKeysetSchema>;
export type Keyset = typeof keysetsTable.$inferSelect;

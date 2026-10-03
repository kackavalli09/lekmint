import { pgTable, text, serial, bigint, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Spent-proof registry. A proof row is only inserted when it is spent
 * (redeem / swap / upgrade). The unique constraint on (keyset_id, secret_hash)
 * is the DB-level double-spend guard: a second spend attempt violates it.
 */
export const proofsTable = pgTable(
  "proofs",
  {
    id: serial("id").primaryKey(),
    keysetId: text("keyset_id").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    secretHash: text("secret_hash").notNull(),
    // NUT-00 Y = hash_to_curve(secret), compressed hex. Used by the NUT-07
    // /v1/checkstate lookup. Nullable: rows spent before this column existed
    // have no Y (their secrets are not stored, so it cannot be backfilled).
    y: text("y"),
    c: text("c").notNull(), // the unblinded signature point C (hex)
    status: text("status").notNull().default("spent"), // spent (registry of used proofs)
    spentAt: timestamp("spent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("proofs_keyset_secret_unique").on(table.keysetId, table.secretHash),
    index("proofs_y_idx").on(table.y),
  ],
);

export const insertProofSchema = createInsertSchema(proofsTable).omit({
  id: true,
  spentAt: true,
});
export type InsertProof = z.infer<typeof insertProofSchema>;
export type Proof = typeof proofsTable.$inferSelect;

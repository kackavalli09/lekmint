import { pgTable, text, serial, bigint, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Redelivery registry for blind signatures issued by swap/upgrade.
 *
 * A row is written in the SAME transaction that marks the input proofs spent,
 * keyed by the blinded message B_. If the client crashes before storing the
 * mint's response, it can replay its persisted blindings against
 * POST /swap/recover and get the exact same signatures back. The rows are
 * useless to anyone who does not hold the client-side blinding factors.
 */
export const signedOutputsTable = pgTable(
  "signed_outputs",
  {
    id: serial("id").primaryKey(),
    /** The blinded message point B_ (hex) — the idempotency key. */
    b: text("b").notNull(),
    keysetId: text("keyset_id").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    /** The blind signature point C_ (hex). */
    cBlind: text("c_blind").notNull(),
    dleqE: text("dleq_e").notNull(),
    dleqS: text("dleq_s").notNull(),
    /** Which operation issued it: swap | upgrade */
    operation: text("operation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("signed_outputs_b_unique").on(table.b)],
);

export type SignedOutputRow = typeof signedOutputsTable.$inferSelect;

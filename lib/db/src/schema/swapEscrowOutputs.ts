import { pgTable, text, serial, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { swapEscrowsTable } from "./swapEscrows";

/**
 * Blinded output points (B_) issued by the face-value /v1/swap that created
 * an appreciation escrow.
 *
 * Why: the escrow's proofsHash is recomputable only from the swap's INPUT
 * proofs, which external wallets keep internally — so a recipient of the
 * resulting token could never claim. But tokens from NUT-12 wallets carry the
 * DLEQ blinding factor r per proof, and B_ = hash_to_curve(secret) + r*G is
 * recomputable by anyone holding (secret, r). Storing each output's B_ lets
 * the mint match a presented token back to the swap that issued it and pay
 * out the escrowed appreciation to whoever holds the token.
 */
export const swapEscrowOutputsTable = pgTable(
  "swap_escrow_outputs",
  {
    id: serial("id").primaryKey(),
    escrowId: integer("escrow_id")
      .notNull()
      .references(() => swapEscrowsTable.id, { onDelete: "cascade" }),
    // Compressed point hex, lowercased. Unique: a B_ belongs to exactly one swap.
    bValue: text("b_value").notNull(),
  },
  (table) => [
    uniqueIndex("swap_escrow_outputs_b_value_unique").on(table.bValue),
    index("swap_escrow_outputs_escrow_id_idx").on(table.escrowId),
  ],
);

export type SwapEscrowOutput = typeof swapEscrowOutputsTable.$inferSelect;

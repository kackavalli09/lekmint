import { pgTable, text, serial, bigint, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Appreciation escrow for face-value swaps by epoch-unaware external wallets.
 *
 * When the Cashu protocol /v1/swap accepts vintage (old-epoch) inputs with
 * outputs totaling less than the converted value (typically exactly the face
 * value, because standard wallets don't understand epochs), the integer
 * remainder (converted − outputs) is escrowed here instead of being kept by
 * the mint. The row is keyed by a hash of the burned input proof set; only
 * the holder of the complete original proofs (secret + signature) can claim
 * it, exactly once, via the site wallet.
 */
export const swapEscrowsTable = pgTable(
  "swap_escrows",
  {
    id: serial("id").primaryKey(),
    // sha256 over the sorted `${keysetId}:${secretHash}` list of the burned
    // input proofs — recomputable only by whoever holds the original secrets.
    proofsHash: text("proofs_hash").notNull(),
    // Integer leks owed to the claimant (converted value − signed outputs).
    amountLeks: bigint("amount_leks", { mode: "number" }).notNull(),
    // Bookkeeping for the operator dashboard / audits.
    faceTotal: bigint("face_total", { mode: "number" }).notNull(),
    convertedValue: bigint("converted_value", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    // JSON { outputs, signatures } stored atomically with the claim, so a
    // repeat claim by the same proof holder REDELIVERS the identical
    // signatures instead of failing — a crash between the mint committing
    // the claim and the wallet storing the proofs must never strand funds.
    claimBundle: text("claim_bundle"),
  },
  (table) => [uniqueIndex("swap_escrows_proofs_hash_unique").on(table.proofsHash)],
);

export const insertSwapEscrowSchema = createInsertSchema(swapEscrowsTable).omit({
  id: true,
  createdAt: true,
  claimedAt: true,
});
export type InsertSwapEscrow = z.infer<typeof insertSwapEscrowSchema>;
export type SwapEscrow = typeof swapEscrowsTable.$inferSelect;

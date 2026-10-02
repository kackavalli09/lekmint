import { pgTable, text, uuid, bigint, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * A user's request to mint lek by depositing BTC to a derived address.
 * Status lifecycle: pending -> payment_detected -> confirmed -> issued
 * (or -> expired / failed).
 *
 * issuedSignatures stores the blind signatures returned at issuance so the
 * recovery flow can re-deliver them idempotently (they are useless to anyone
 * who does not hold the client-side blinding factors).
 */
export const mintRequestsTable = pgTable("mint_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Unique: two open requests must never share a deposit address, or one
  // deposit could be credited to both.
  btcAddress: text("btc_address").notNull().unique(),
  requestedAmountSats: bigint("requested_amount_sats", { mode: "number" }),
  grossAmountSats: bigint("gross_amount_sats", { mode: "number" }),
  feeSats: bigint("fee_sats", { mode: "number" }),
  netAmountSats: bigint("net_amount_sats", { mode: "number" }),
  status: text("status").notNull().default("pending"), // pending | payment_detected | confirmed | issued | expired | failed
  issuedSignatures: jsonb("issued_signatures"),
  // Exact transactions credited toward this request: [{ txid, amountSats }].
  // Only txs confirmed AFTER the request was created may appear here, so
  // pre-existing address history can never mint leks.
  creditedTxs: jsonb("credited_txs"),
  // Chain tip height snapshotted at request creation. Only txs confirmed in a
  // STRICTLY LATER block are credit-eligible (miner timestamps can drift ±2h,
  // so block height — not block_time — is the trust anchor).
  baselineTipHeight: bigint("baseline_tip_height", { mode: "number" }),
  // Txids already present at the address (mempool or chain) when the request
  // was created. Permanently ineligible for crediting.
  excludedTxids: jsonb("excluded_txids"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // When the deposit reached the confirmation threshold and was credited.
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  proofsIssuedAt: timestamp("proofs_issued_at", { withTimezone: true }),
});

export const insertMintRequestSchema = createInsertSchema(mintRequestsTable).omit({
  id: true,
  createdAt: true,
  proofsIssuedAt: true,
});
export type InsertMintRequest = z.infer<typeof insertMintRequestSchema>;
export type MintRequest = typeof mintRequestsTable.$inferSelect;

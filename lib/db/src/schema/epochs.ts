import { pgTable, serial, text, numeric, bigint, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Public epoch registry for the difficulty-pegged tokenomics.
 * One row per rate change: R_t = max(R_{t-1}, (D_t / max(1, S_t)) / C_0).
 * rateIndex is stored as a high-precision decimal string (never floats).
 * The first row is the genesis epoch with rateIndex = 1.00000000.
 */
export const epochsTable = pgTable("epochs", {
  id: serial("id").primaryKey(),
  keysetId: text("keyset_id").notNull().unique(),
  rateIndex: numeric("rate_index", { precision: 40, scale: 12 }).notNull(),
  difficulty: numeric("difficulty", { precision: 40, scale: 4 }).notNull(),
  subsidySats: bigint("subsidy_sats", { mode: "number" }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertEpochSchema = createInsertSchema(epochsTable).omit({
  id: true,
  startedAt: true,
});
export type InsertEpoch = z.infer<typeof insertEpochSchema>;
export type Epoch = typeof epochsTable.$inferSelect;

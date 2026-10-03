import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Operator configuration (single active row).
 * xpubEncrypted holds the AES-256-GCM ciphertext bundle (salt:iv:tag:cipher,
 * base64) — never the raw xpub. derivationIndexCounter is the next unused
 * BIP84 child index.
 */
export const adminConfigTable = pgTable("admin_config", {
  id: serial("id").primaryKey(),
  xpubEncrypted: text("xpub_encrypted"),
  derivationIndexCounter: integer("derivation_index_counter").notNull().default(0),
  minConfirmations: integer("min_confirmations").notNull().default(1),
  // Set when the operator performs a key reset (ROTATE AND VOID): admin
  // metrics report only activity at/after this instant. History is kept.
  metricsBaselineAt: timestamp("metrics_baseline_at", { withTimezone: true }),
  // Social / contact links shown in the public site footer (all nullable).
  contactXUrl: text("contact_x_url"),
  contactNostrUrl: text("contact_nostr_url"),
  contactEmail: text("contact_email"),
  // Outbound email (Mailgun SMTP) settings. smtpPassEncrypted holds the
  // AES-256-GCM ciphertext bundle (same vault as xpubEncrypted) — never the
  // raw password. Null values fall back to the corresponding env secrets.
  smtpUser: text("smtp_user"),
  smtpPassEncrypted: text("smtp_pass_encrypted"),
  operatorEmail: text("operator_email"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertAdminConfigSchema = createInsertSchema(adminConfigTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertAdminConfig = z.infer<typeof insertAdminConfigSchema>;
export type AdminConfig = typeof adminConfigTable.$inferSelect;

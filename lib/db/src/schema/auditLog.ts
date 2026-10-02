import { pgTable, serial, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Structured security audit trail. Payloads are never stored raw — only a
 * SHA-256 hash of the (already sanitized) event payload, so the log can
 * prove an event occurred without retaining proof secrets, xpubs, or keys.
 */
export const auditLogTable = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    eventType: text("event_type").notNull(), // proof_issued | proof_redeemed | proof_upgrade | swap_failed | mint_request_created | recovery_attempted | admin_login_ok | admin_login_fail | fee_changed | xpub_changed
    actorIp: text("actor_ip").notNull(),
    payloadHash: text("payload_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_log_event_type_idx").on(table.eventType, table.createdAt)],
);

export const insertAuditLogSchema = createInsertSchema(auditLogTable).omit({
  id: true,
  createdAt: true,
});
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogTable.$inferSelect;

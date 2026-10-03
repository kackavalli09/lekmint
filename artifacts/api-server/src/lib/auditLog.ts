import { createHash } from "node:crypto";
import type { Request } from "express";
import { db, auditLogTable } from "@workspace/db";
import { logger } from "./logger";

export type AuditEventType =
  | "proof_issued"
  | "proof_redeemed"
  | "proof_upgrade"
  | "swap_failed"
  | "mint_request_created"
  | "recovery_attempted"
  | "swap_recovery_attempted"
  | "admin_login_ok"
  | "admin_login_fail"
  | "fee_changed"
  | "email_settings_changed"
  | "xpub_changed"
  | "payouts_settled"
  | "keyset_rotated"
  | "supply_era_rebased"
  | "supply_btc_balance_restored"
  | "escrow_claimed"
  | "escrow_admin_released"
  | "payout_corrected"
  | "epoch_invariant_violation";

export function requestIp(req: Request): string {
  return req.ip ?? "unknown";
}

/**
 * Fire-and-forget structured audit logging. Only a SHA-256 hash of the
 * sanitized payload is persisted — callers must still never pass raw proof
 * secrets, xpubs, or private keys, but the hash makes accidental leakage
 * non-recoverable anyway.
 *
 * Audit logging must never break the request path: failures are logged and
 * swallowed.
 */
export function logAuditEvent(
  eventType: AuditEventType,
  actorIp: string,
  payload: Record<string, unknown> = {},
): void {
  const payloadHash = createHash("sha256")
    .update(JSON.stringify({ eventType, ...payload }))
    .digest("hex");
  void db
    .insert(auditLogTable)
    .values({ eventType, actorIp, payloadHash })
    .catch((err) => {
      logger.error({ err, eventType }, "Failed to write audit log entry");
    });
}

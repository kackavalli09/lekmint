import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { logAuditEvent, requestIp } from "../lib/auditLog";

/**
 * Bearer-token guard for all /admin routes.
 *
 * - No ADMIN_API_KEY configured -> 503 (operator has not set up admin access)
 * - Missing/malformed Authorization header -> 401
 * - Wrong key -> 403 (after a fixed 500ms delay; comparison is constant-time)
 * - >= 10 failed attempts per IP within an hour -> 429 lockout w/ Retry-After
 *
 * Failure tracking is in-process, which is sufficient for the
 * single-instance deployment.
 */

const LOCKOUT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const LOCKOUT_THRESHOLD = 10;
const ATTEMPT_DELAY_MS = 500;
const SUCCESS_AUDIT_INTERVAL_MS = 60 * 60 * 1000; // log admin_login_ok at most hourly per IP

const failedAttempts = new Map<string, number[]>();
const lastSuccessAudit = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pruneFailures(ip: string, now: number): number[] {
  const cutoff = now - LOCKOUT_WINDOW_MS;
  const pruned = (failedAttempts.get(ip) ?? []).filter((t) => t > cutoff);
  if (pruned.length === 0) {
    failedAttempts.delete(ip);
  } else {
    failedAttempts.set(ip, pruned);
  }
  return pruned;
}

function recordFailure(ip: string, now: number): void {
  const attempts = failedAttempts.get(ip) ?? [];
  attempts.push(now);
  failedAttempts.set(ip, attempts);
  // Opportunistic cleanup so the map cannot grow without bound.
  if (failedAttempts.size > 10_000) {
    for (const key of failedAttempts.keys()) {
      if (pruneFailures(key, now).length === 0 && failedAttempts.size <= 10_000) break;
    }
  }
}

export async function adminAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const configuredKey = process.env["ADMIN_API_KEY"];
  if (!configuredKey) {
    res.status(503).json({ error: "Admin access is not configured" });
    return;
  }

  const ip = requestIp(req);
  const now = Date.now();

  const recentFailures = pruneFailures(ip, now);
  if (recentFailures.length >= LOCKOUT_THRESHOLD) {
    const oldest = recentFailures[0]!;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + LOCKOUT_WINDOW_MS - now) / 1000));
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({ error: "Too many failed attempts; try again later" });
    return;
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing admin credentials" });
    return;
  }

  // Fixed delay makes online brute force impractically slow and uniform.
  await sleep(ATTEMPT_DELAY_MS);

  const provided = header.slice("Bearer ".length).trim();
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(configuredKey, "utf8");
  const matches =
    providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);

  if (!matches) {
    recordFailure(ip, now);
    logAuditEvent("admin_login_fail", ip, { path: req.path });
    res.status(403).json({ error: "Invalid admin credentials" });
    return;
  }

  const lastOk = lastSuccessAudit.get(ip) ?? 0;
  if (now - lastOk > SUCCESS_AUDIT_INTERVAL_MS) {
    lastSuccessAudit.set(ip, now);
    logAuditEvent("admin_login_ok", ip, {});
  }

  next();
}

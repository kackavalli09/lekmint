/**
 * Regression test: an ACTUAL key rotation (POST /admin/rotate-keyset) must
 * immediately snapshot a zero era BTC balance — i.e. the baseline is written
 * BEFORE the rotation's supply delta inside the same transaction. Guards the
 * ordering that ledger-era-reset.e2e.ts (synthetic baseline) cannot cover.
 *
 * WARNING: rotation is irreversible — it revokes every keyset and voids all
 * outstanding tokens. Safe only against a development mint. The script
 * refuses to run unless API_BASE points at localhost.
 */
import { db, pool, tokenSupplyLogTable, adminConfigTable } from "@workspace/db";
import { desc } from "drizzle-orm";

const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:80/api";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  if (!/127\.0\.0\.1|localhost/.test(API_BASE)) {
    throw new Error("SAFETY ABORT: rotation is destructive; run only against a local dev mint.");
  }
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) throw new Error("ADMIN_API_KEY not set");
  const auth = { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" };

  const res = await fetch(`${API_BASE}/admin/rotate-keyset`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ confirm: "ROTATE AND VOID" }),
  });
  check("rotation accepted", res.status === 200, `status=${res.status}`);
  const rotated: any = await res.json();

  // The rotation transaction itself must have produced a zero-balance
  // snapshot (baseline written before the supply delta).
  const [snap] = await db
    .select()
    .from(tokenSupplyLogTable)
    .orderBy(desc(tokenSupplyLogTable.id))
    .limit(1);
  check(
    "rotation's own supply snapshot shows a zero era BTC balance",
    snap?.btcBalanceSats === 0,
    `btcBalanceSats=${snap?.btcBalanceSats}`,
  );
  check(
    "rotation's snapshot shows zero circulation",
    snap !== undefined && snap.totalLeksIssued - snap.totalLeksRedeemed === 0,
    `circulation=${snap ? snap.totalLeksIssued - snap.totalLeksRedeemed : "n/a"}`,
  );

  const [config] = await db.select().from(adminConfigTable).limit(1);
  check(
    "metrics baseline matches the rotation timestamp",
    config?.metricsBaselineAt !== null &&
      config?.metricsBaselineAt?.toISOString() === rotated.rotatedAt,
    `baseline=${config?.metricsBaselineAt?.toISOString()}, rotatedAt=${rotated.rotatedAt}`,
  );

  const statsRes = await fetch(`${API_BASE}/admin/stats`, { headers: auth });
  const stats: any = await statsRes.json();
  check("BTC held starts at zero after rotation", stats.btcHeldNetSats === 0, `btcHeldNetSats=${stats.btcHeldNetSats}`);
  check(
    "expected reserve starts at zero after rotation",
    stats.audit.expectedReserveSats === 0,
    `expected=${stats.audit.expectedReserveSats}`,
  );

  if (failures > 0) {
    console.log(`\n${failures} assertion(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log("\nAll assertions passed — a real rotation restarts the BTC ledger at zero.");
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

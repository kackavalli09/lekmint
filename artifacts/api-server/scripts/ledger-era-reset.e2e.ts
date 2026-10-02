/**
 * Regression test: a key rotation starts the BTC ledger fresh.
 *
 * The metrics baseline (set by ROTATE AND VOID) must scope the STOCK
 * figures — "BTC held (ledger net)" and the audit's expected reserve — to
 * post-rotation events only, with the pre-rotation ledger preserved as
 * priorEraBtcNetSats. Also covers the payout-correction endpoint: replacing
 * a settled payout's estimated value clears the estimate flag and the
 * audit's "approximate" disclosure.
 *
 * Fixture strategy: instead of performing a real (irreversible) rotation,
 * the test sets admin_config.metrics_baseline_at directly, inserts a
 * synthetic credited deposit and a synthetic settled payout with
 * post-baseline event timestamps, and verifies the era arithmetic. Cleanup
 * restores the original baseline and removes every synthetic row.
 */
import { db, pool, mintRequestsTable, payoutsTable, adminConfigTable, tokenSupplyLogTable } from "@workspace/db";
import { desc, eq, gt, sql } from "drizzle-orm";

const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:80/api";

const NET_DEPOSIT = 5_000; // sats credited this era
const GROSS_DEPOSIT = 5_100;
const PAID_OUT = 2_000; // sats settled this era (frozen as an estimate)
const CORRECTED = 1_900; // "actual" on-chain amount entered by the operator

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function getStats(auth: Record<string, string>): Promise<any> {
  const res = await fetch(`${API_BASE}/admin/stats`, { headers: auth });
  if (res.status !== 200) throw new Error(`GET /admin/stats -> ${res.status}`);
  return res.json();
}

async function main(): Promise<void> {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) throw new Error("ADMIN_API_KEY not set");
  const auth = { Authorization: `Bearer ${adminKey}` };

  const before = await getStats(auth);
  const [config] = await db.select().from(adminConfigTable).limit(1);
  if (!config) throw new Error("no admin config row");
  const originalBaseline = config.metricsBaselineAt;
  const [supplyTop] = await db
    .select({ id: tokenSupplyLogTable.id })
    .from(tokenSupplyLogTable)
    .orderBy(desc(tokenSupplyLogTable.id))
    .limit(1);
  const supplyMaxId = supplyTop?.id ?? 0;

  // Baseline "now": everything historical becomes the prior era.
  const baselineAt = new Date();
  await db
    .update(adminConfigTable)
    .set({ metricsBaselineAt: baselineAt })
    .where(eq(adminConfigTable.id, config.id));

  let mintId: string | null = null;
  let payoutId: number | null = null;
  try {
    const eraReset = await getStats(auth);
    check(
      "BTC held restarts at zero right after the reset",
      eraReset.btcHeldNetSats === 0,
      `btcHeldNetSats=${eraReset.btcHeldNetSats}`,
    );
    check(
      "expected reserve restarts at zero right after the reset",
      eraReset.audit.expectedReserveSats === 0,
      `expected=${eraReset.audit.expectedReserveSats}`,
    );
    check(
      "prior-era ledger is preserved, not deleted",
      eraReset.priorEraBtcNetSats === before.btcHeldNetSats - 0 + (before.priorEraBtcNetSats ?? 0),
      `priorEra=${eraReset.priorEraBtcNetSats}, pre-test btcHeld=${before.btcHeldNetSats}, pre-test priorEra=${before.priorEraBtcNetSats}`,
    );

    // --- New-era activity: one credited deposit, one settled payout --------
    const eventAt = new Date(baselineAt.getTime() + 1000);
    const inserted = await db
      .insert(mintRequestsTable)
      .values({
        btcAddress: `tb1q-era-test-${Date.now()}`,
        status: "issued",
        grossAmountSats: GROSS_DEPOSIT,
        netAmountSats: NET_DEPOSIT,
        feeSats: GROSS_DEPOSIT - NET_DEPOSIT,
        confirmedAt: eventAt,
        proofsIssuedAt: eventAt,
      } as any)
      .returning({ id: mintRequestsTable.id });
    mintId = (inserted[0] as any).id;
    const insertedPayout = await db
      .insert(payoutsTable)
      .values({
        btcAddress: `tb1q-era-payout-${Date.now()}`,
        amountLeks: PAID_OUT,
        status: "paid",
        settledAt: eventAt,
        paidAmountSats: PAID_OUT,
        paidAmountIsEstimate: true,
      } as any)
      .returning({ id: payoutsTable.id });
    payoutId = insertedPayout[0]!.id;

    const during = await getStats(auth);
    check(
      "BTC held counts only this era's deposits and payouts",
      during.btcHeldNetSats === NET_DEPOSIT - PAID_OUT,
      `btcHeldNetSats=${during.btcHeldNetSats}, expected=${NET_DEPOSIT - PAID_OUT}`,
    );
    check(
      "expected reserve = era gross deposits − era paid sats",
      during.audit.expectedReserveSats === GROSS_DEPOSIT - PAID_OUT,
      `expected=${during.audit.expectedReserveSats}`,
    );
    check(
      "audit discloses approximation while an era payout is an estimate",
      during.audit.approximate === true,
      `approximate=${during.audit.approximate}`,
    );

    // --- Operator correction: exact value replaces the estimate ------------
    const correctRes = await fetch(`${API_BASE}/admin/payouts/${payoutId}/correct`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ paidAmountSats: CORRECTED }),
    });
    check("correction endpoint accepts the actual paid amount", correctRes.status === 200, `status=${correctRes.status}`);

    const after = await getStats(auth);
    check(
      "corrected value replaces the estimate in the ledger",
      after.btcHeldNetSats === NET_DEPOSIT - CORRECTED,
      `btcHeldNetSats=${after.btcHeldNetSats}, expected=${NET_DEPOSIT - CORRECTED}`,
    );
    check(
      "audit stops disclosing approximation once the estimate is corrected",
      after.audit.approximate === false,
      `approximate=${after.audit.approximate}`,
    );
    const [supplyLatest] = await db
      .select()
      .from(tokenSupplyLogTable)
      .orderBy(desc(tokenSupplyLogTable.id))
      .limit(1);
    check(
      "supply snapshot reflects the corrected era balance atomically",
      supplyLatest?.btcBalanceSats === NET_DEPOSIT - CORRECTED,
      `snapshot=${supplyLatest?.btcBalanceSats}`,
    );

    // A non-settled payout cannot be "corrected".
    const badRes = await fetch(`${API_BASE}/admin/payouts/999999999/correct`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ paidAmountSats: 1 }),
    });
    check("correcting a missing payout is rejected", badRes.status === 409, `status=${badRes.status}`);
  } finally {
    // Cleanup: synthetic rows out, original baseline back, snapshots pruned.
    if (payoutId !== null) await db.delete(payoutsTable).where(eq(payoutsTable.id, payoutId));
    if (mintId !== null) await db.delete(mintRequestsTable).where(eq(mintRequestsTable.id, mintId as any));
    await db.delete(tokenSupplyLogTable).where(gt(tokenSupplyLogTable.id, supplyMaxId));
    await db
      .update(adminConfigTable)
      .set({ metricsBaselineAt: originalBaseline })
      .where(eq(adminConfigTable.id, config.id));
  }

  const restored = await getStats(auth);
  check(
    "stats restored exactly to pre-test values",
    restored.btcHeldNetSats === before.btcHeldNetSats &&
      restored.audit.expectedReserveSats === before.audit.expectedReserveSats,
    `btcHeld=${restored.btcHeldNetSats} (was ${before.btcHeldNetSats})`,
  );

  if (failures > 0) {
    console.log(`\n${failures} assertion(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log("\nAll assertions passed — the BTC ledger starts fresh after a key rotation.");
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

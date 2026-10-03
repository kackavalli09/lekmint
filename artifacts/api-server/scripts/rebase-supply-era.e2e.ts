/**
 * Regression test: retroactive era rebase of the supply log.
 *
 * Simulates the pre-fix state (a rotation that carried cumulative counters
 * forward) with synthetic rows, runs rebaseSupplyEraRetroactive, and checks:
 *  - the first post-baseline row is zeroed,
 *  - later era rows keep their deltas,
 *  - pre-baseline rows are untouched,
 *  - a second run is a no-op (idempotent).
 * Restores the baseline and deletes its synthetic rows afterwards.
 *
 * Run with: node scripts/run-ts.mjs scripts/rebase-supply-era.e2e.ts
 */
import { db, tokenSupplyLogTable, adminConfigTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { rebaseSupplyEraRetroactive } from "../src/lib/supply";

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  if (!ok) failures++;
}

async function main() {
  const [config] = await db.select().from(adminConfigTable).limit(1);
  if (!config) throw new Error("No admin config row");
  const originalBaseline = config.metricsBaselineAt;

  const insertedIds: number[] = [];
  try {
    // Pre-rotation historical row.
    const [rowA] = await db
      .insert(tokenSupplyLogTable)
      .values({ totalLeksIssued: 1000, totalLeksRedeemed: 200, btcBalanceSats: 5000 })
      .returning();
    insertedIds.push(rowA!.id);

    // Baseline strictly after row A.
    await new Promise((r) => setTimeout(r, 20));
    const syntheticBaseline = new Date();
    await new Promise((r) => setTimeout(r, 20));
    await db
      .update(adminConfigTable)
      .set({ metricsBaselineAt: syntheticBaseline })
      .where(eq(adminConfigTable.id, config.id));

    // Old-behavior rotation row (carried cumulative counters AND a
    // pre-rotation cumulative BTC balance) and one era row on top of it.
    const [rowB] = await db
      .insert(tokenSupplyLogTable)
      .values({ totalLeksIssued: 1000, totalLeksRedeemed: 1000, btcBalanceSats: 5000 })
      .returning();
    insertedIds.push(rowB!.id);
    const [rowC] = await db
      .insert(tokenSupplyLogTable)
      .values({ totalLeksIssued: 1500, totalLeksRedeemed: 1000, btcBalanceSats: 5800 })
      .returning();
    insertedIds.push(rowC!.id);

    const msg1 = await rebaseSupplyEraRetroactive();
    console.log(`  rebase: ${msg1}`);

    const rows = await db
      .select()
      .from(tokenSupplyLogTable)
      .where(inArray(tokenSupplyLogTable.id, insertedIds));
    const a = rows.find((r) => r.id === rowA!.id)!;
    const b = rows.find((r) => r.id === rowB!.id)!;
    const c = rows.find((r) => r.id === rowC!.id)!;

    // btcBalanceSats is always recomputed fresh from source tables in
    // recordSupplyDelta — it is NOT a cumulative counter, so the rebase must
    // not touch it. All three rows keep their original BTC values.
    check("pre-baseline row untouched",
      a.totalLeksIssued === 1000 && a.totalLeksRedeemed === 200 && a.btcBalanceSats === 5000,
      `A=(${a.totalLeksIssued}, ${a.totalLeksRedeemed}, btc=${a.btcBalanceSats})`);
    check("first era row: lek counters zeroed, btc balance unchanged",
      b.totalLeksIssued === 0 && b.totalLeksRedeemed === 0 && b.btcBalanceSats === 5000,
      `B=(${b.totalLeksIssued}, ${b.totalLeksRedeemed}, btc=${b.btcBalanceSats})`);
    check("later era row: lek deltas preserved, btc balance unchanged",
      c.totalLeksIssued === 500 && c.totalLeksRedeemed === 0 && c.btcBalanceSats === 5800,
      `C=(${c.totalLeksIssued}, ${c.totalLeksRedeemed}, btc=${c.btcBalanceSats})`);

    const msg2 = await rebaseSupplyEraRetroactive();
    check("second run is a no-op", msg2.includes("already zeroed"), msg2);
  } finally {
    // Cleanup: remove synthetic rows, restore the real baseline.
    if (insertedIds.length) {
      await db.delete(tokenSupplyLogTable).where(inArray(tokenSupplyLogTable.id, insertedIds));
    }
    await db
      .update(adminConfigTable)
      .set({ metricsBaselineAt: originalBaseline })
      .where(eq(adminConfigTable.id, config.id));
  }

  if (failures > 0) {
    console.error(`${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("All assertions passed — retroactive era rebase behaves correctly.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

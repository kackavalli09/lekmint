import { db, tokenSupplyLogTable, mintRequestsTable, payoutsTable, adminConfigTable } from "@workspace/db";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";

/**
 * Append-only supply audit trail. Each mutation writes a new snapshot row
 * derived from the previous totals.
 *
 * Concurrency: writers take a transaction-scoped advisory lock before
 * reading the latest snapshot, so concurrent mint operations serialize on
 * the audit log and no delta can be lost. Callers MUST invoke
 * recordSupplyDelta inside the same transaction as the state mutation it
 * documents, so both commit or roll back together.
 */

const SUPPLY_LOG_LOCK_ID = 811_772_001; // stable app-level advisory lock id (not a credential)

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function getLatestSupply(executor: Tx | typeof db = db): Promise<{
  totalLeksIssued: number;
  totalLeksRedeemed: number;
}> {
  const [latest] = await executor
    .select()
    .from(tokenSupplyLogTable)
    .orderBy(desc(tokenSupplyLogTable.id))
    .limit(1);
  return {
    totalLeksIssued: latest?.totalLeksIssued ?? 0,
    totalLeksRedeemed: latest?.totalLeksRedeemed ?? 0,
  };
}

export async function recordSupplyDelta(
  tx: Tx,
  deltas: { issued?: number; redeemed?: number },
): Promise<void> {
  // Serialize snapshot writers for the remainder of this transaction.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${SUPPLY_LOG_LOCK_ID})`);
  const current = await getLatestSupply(tx);
  // BTC balance uses the SAME definition as the admin overview's "BTC held":
  // net credited deposits minus sats paid out for settled melts, counting
  // only THIS ERA — events at/after the metrics baseline that a key rotation
  // (ROTATE AND VOID) sets. A rotation declares a fresh ledger: pre-rotation
  // BTC belongs to the operator, so the era ledger restarts at zero. The two
  // figures therefore always agree.
  const [baselineRow] = await tx
    .select({ baseline: adminConfigTable.metricsBaselineAt })
    .from(adminConfigTable)
    .limit(1);
  const baseline = baselineRow?.baseline ?? null;
  const mintEventTs = sql`coalesce(${mintRequestsTable.proofsIssuedAt}, ${mintRequestsTable.confirmedAt}, ${mintRequestsTable.createdAt})`;
  const [[{ netCredited }], [{ paidOut }]] = await Promise.all([
    tx
      .select({ netCredited: sql<string>`coalesce(sum(${mintRequestsTable.netAmountSats}), 0)` })
      .from(mintRequestsTable)
      .where(
        and(
          inArray(mintRequestsTable.status, ["confirmed", "issued"]),
          baseline ? sql`${mintEventTs} >= ${baseline}` : sql`true`,
        ),
      ),
    tx
      .select({ paidOut: sql<string>`coalesce(sum(${payoutsTable.paidAmountSats}), 0)` })
      .from(payoutsTable)
      .where(
        and(
          eq(payoutsTable.status, "paid"),
          baseline ? sql`${payoutsTable.settledAt} >= ${baseline}` : sql`true`,
        ),
      ),
  ]);
  await tx.insert(tokenSupplyLogTable).values({
    totalLeksIssued: current.totalLeksIssued + (deltas.issued ?? 0),
    totalLeksRedeemed: current.totalLeksRedeemed + (deltas.redeemed ?? 0),
    btcBalanceSats: Number(netCredited) - Number(paidOut),
  });
}

/**
 * Era reset for the supply log: a key rotation (ROTATE AND VOID) starts a
 * fresh token — the monitored supply restarts at zero. Inserts an explicit
 * zero snapshot so every later row (built as latest + delta) reports
 * era-scoped figures. Pre-rotation rows keep their historical values.
 * MUST run inside the rotation transaction, after the metrics baseline has
 * been set.
 */
/**
 * One-time retroactive correction: rebase supply-log rows recorded at/after
 * the current metrics baseline (set by a key rotation) so the era's figures
 * start at zero. Pre-rotation rows keep their historical values.
 *
 * Idempotent: it subtracts the offsets of the FIRST post-baseline row, so a
 * second run finds that row already at (0, 0) and does nothing. Runs in one
 * transaction under the supply advisory lock, so live writers can never
 * observe (or append onto) a half-rebased log.
 */
export async function rebaseSupplyEraRetroactive(): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SUPPLY_LOG_LOCK_ID})`);

    const [config] = await tx.select().from(adminConfigTable).limit(1);
    const baseline = config?.metricsBaselineAt ?? null;
    if (!baseline) {
      return "No metrics baseline set (no rotation has happened) — nothing to rebase.";
    }

    const [firstEraRow] = await tx
      .select()
      .from(tokenSupplyLogTable)
      .where(gte(tokenSupplyLogTable.snapshotAt, baseline))
      .orderBy(asc(tokenSupplyLogTable.id))
      .limit(1);

    if (!firstEraRow) {
      return "No snapshot rows at/after the baseline — nothing to rebase.";
    }

    const offsetIssued = firstEraRow.totalLeksIssued;
    const offsetRedeemed = firstEraRow.totalLeksRedeemed;
    // btcBalanceSats is NOT a cumulative counter — recordSupplyDelta always
    // recomputes it fresh from the era-scoped mintRequests/payouts tables.
    // It must never be rebased here; doing so would corrupt the absolute
    // on-chain BTC balance by subtracting an arbitrary constant from every row.
    if (offsetIssued === 0 && offsetRedeemed === 0) {
      return "First era row is already zeroed — nothing to do.";
    }

    const result = await tx
      .update(tokenSupplyLogTable)
      .set({
        totalLeksIssued: sql`${tokenSupplyLogTable.totalLeksIssued} - ${offsetIssued}`,
        totalLeksRedeemed: sql`${tokenSupplyLogTable.totalLeksRedeemed} - ${offsetRedeemed}`,
      })
      .where(gte(tokenSupplyLogTable.id, firstEraRow.id))
      .returning({ id: tokenSupplyLogTable.id });

    return (
      `Baseline ${baseline.toISOString()}; rebased ${result.length} row(s) from id ${firstEraRow.id} ` +
      `by issued -${offsetIssued}, redeemed -${offsetRedeemed} (btcBalanceSats untouched).`
    );
  });
}

/**
 * Recovery for supply logs whose btcBalanceSats were incorrectly adjusted by
 * an earlier buggy rebase. btcBalanceSats is always computed fresh from the
 * source tables (era-scoped mintRequests and payouts) — it is NOT a
 * cumulative counter, so it must never be shifted by a constant offset.
 *
 * Strategy: recompute the correct current BTC balance from source tables,
 * compare it to what the latest supply row stores, and apply the difference
 * to every era row. If the stored value already matches, returns a no-op
 * message. Idempotent.
 */
export async function restoreSupplyEraBtcBalance(): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SUPPLY_LOG_LOCK_ID})`);

    const [config] = await tx.select().from(adminConfigTable).limit(1);
    const baseline = config?.metricsBaselineAt ?? null;
    if (!baseline) {
      return "No metrics baseline set — nothing to restore.";
    }

    const [firstEraRow] = await tx
      .select()
      .from(tokenSupplyLogTable)
      .where(gte(tokenSupplyLogTable.snapshotAt, baseline))
      .orderBy(asc(tokenSupplyLogTable.id))
      .limit(1);

    if (!firstEraRow) {
      return "No snapshot rows at/after the baseline — nothing to restore.";
    }

    // Latest stored value (most recently written row).
    const [latestRow] = await tx
      .select()
      .from(tokenSupplyLogTable)
      .orderBy(desc(tokenSupplyLogTable.id))
      .limit(1);

    // Recompute the correct BTC balance from source tables using the same
    // era-scoped logic as recordSupplyDelta.
    const mintEventTs = sql`coalesce(${mintRequestsTable.proofsIssuedAt}, ${mintRequestsTable.confirmedAt}, ${mintRequestsTable.createdAt})`;
    const [[{ netCredited }], [{ paidOut }]] = await Promise.all([
      tx
        .select({ netCredited: sql<string>`coalesce(sum(${mintRequestsTable.netAmountSats}), 0)` })
        .from(mintRequestsTable)
        .where(
          and(
            inArray(mintRequestsTable.status, ["confirmed", "issued"]),
            sql`${mintEventTs} >= ${baseline}`,
          ),
        ),
      tx
        .select({ paidOut: sql<string>`coalesce(sum(${payoutsTable.paidAmountSats}), 0)` })
        .from(payoutsTable)
        .where(and(eq(payoutsTable.status, "paid"), sql`${payoutsTable.settledAt} >= ${baseline}`)),
    ]);

    const expectedNow = Number(netCredited) - Number(paidOut);
    const storedNow = latestRow?.btcBalanceSats ?? 0;
    const correction = expectedNow - storedNow;

    if (correction === 0) {
      return "BTC balance column is already correct — nothing to restore.";
    }

    const result = await tx
      .update(tokenSupplyLogTable)
      .set({
        btcBalanceSats: sql`${tokenSupplyLogTable.btcBalanceSats} + ${correction}`,
      })
      .where(gte(tokenSupplyLogTable.id, firstEraRow.id))
      .returning({ id: tokenSupplyLogTable.id });

    return (
      `BTC balance restored: corrected ${result.length} era row(s) by ${correction > 0 ? "+" : ""}${correction} sats ` +
      `(stored ${storedNow} → expected ${expectedNow}).`
    );
  });
}

export async function resetSupplyEra(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${SUPPLY_LOG_LOCK_ID})`);
  await tx.insert(tokenSupplyLogTable).values({
    totalLeksIssued: 0,
    totalLeksRedeemed: 0,
    btcBalanceSats: 0,
  });
}

import { db, mintRequestsTable, payoutsTable, btcAddressesTable } from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getCurrentEpoch } from "./epochEngine";
import { getOrCreateFeeConfig } from "./mintConfig";
import { computeMeltQuote } from "./meltQuote";
import { getNetworkFeeEstimate } from "./networkFee";
import { logger } from "./logger";

/**
 * Idempotent, one-shot data backfills for metrics correctness. Runs at every
 * boot; each step only touches rows that predate the fix, so subsequent runs
 * are no-ops.
 *
 * 1. proofs_issued_at — issuance historically never stamped this, leaving the
 *    30-day mint chart permanently empty. Backfill from created_at (the
 *    closest available timestamp; deposits are typically issued shortly
 *    after confirmation).
 * 2. confirmed_at / funded_at — lifecycle timestamps added later; backfill
 *    from the closest available timestamp so baseline filtering has an event
 *    time for every historical row.
 * 3. paid_amount_sats — legacy settled payouts predate value-freezing.
 *    Reconstruct them at today's melt quote and MARK THEM AS ESTIMATES
 *    (paid_amount_is_estimate) so the audit can disclose the approximation
 *    instead of presenting it as exact.
 */
export async function runMetricsBackfill(): Promise<void> {
  const stamped = await db
    .update(mintRequestsTable)
    .set({ proofsIssuedAt: sql`${mintRequestsTable.createdAt}` })
    .where(and(eq(mintRequestsTable.status, "issued"), isNull(mintRequestsTable.proofsIssuedAt)))
    .returning({ id: mintRequestsTable.id });
  if (stamped.length > 0) {
    logger.info({ rows: stamped.length }, "Backfilled proofs_issued_at from created_at");
  }

  await db
    .update(mintRequestsTable)
    .set({ confirmedAt: sql`coalesce(${mintRequestsTable.proofsIssuedAt}, ${mintRequestsTable.createdAt})` })
    .where(
      and(
        sql`${mintRequestsTable.status} in ('confirmed', 'issued')`,
        isNull(mintRequestsTable.confirmedAt),
      ),
    );
  await db
    .update(btcAddressesTable)
    .set({ fundedAt: sql`${btcAddressesTable.assignedAt}` })
    .where(and(eq(btcAddressesTable.status, "funded"), isNull(btcAddressesTable.fundedAt)));

  const legacyPaid = await db
    .select({ id: payoutsTable.id, amountLeks: payoutsTable.amountLeks })
    .from(payoutsTable)
    .where(and(eq(payoutsTable.status, "paid"), isNull(payoutsTable.paidAmountSats)));
  if (legacyPaid.length === 0) {
    return;
  }
  const epoch = await getCurrentEpoch();
  if (!epoch) {
    logger.warn("Cannot backfill paid_amount_sats yet: no epoch; will retry next boot");
    return;
  }
  const [feeConfig, networkFee] = await Promise.all([
    getOrCreateFeeConfig(),
    getNetworkFeeEstimate(),
  ]);
  for (const row of legacyPaid) {
    const q = computeMeltQuote(
      row.amountLeks,
      epoch.rateIndex,
      feeConfig,
      networkFee.estimatedSats,
    );
    // Total treasury outflow = gross − melt fee (recipient net + network fee).
    const sats = Math.max(0, q.estimatedGrossSats - q.estimatedFeeSats);
    await db
      .update(payoutsTable)
      .set({ paidAmountSats: sats, paidAmountIsEstimate: true })
      .where(and(eq(payoutsTable.id, row.id), isNull(payoutsTable.paidAmountSats)));
  }
  logger.info(
    { rows: legacyPaid.length },
    "Backfilled paid_amount_sats at current melt quote (marked as estimates)",
  );
}

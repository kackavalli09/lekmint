import { Router, type IRouter } from "express";
import { and, eq, desc, sql, inArray, count, isNull, type AnyColumn } from "drizzle-orm";
import {
  db,
  adminConfigTable,
  feeConfigTable,
  btcAddressesTable,
  mintRequestsTable,
  treasuryDustLogTable,
  tokenSupplyLogTable,
  payoutsTable,
  keysetsTable,
  epochsTable,
  swapEscrowsTable,
} from "@workspace/db";
import {
  UpdateFeeConfigBody,
  UpdateMintSettingsBody,
  UpdateEmailSettingsBody,
  UpdateXpubBody,
  GetSupplyLogQueryParams,
  GetPayoutsQueryParams,
  MarkPayoutsPaidBody,
  CorrectPayoutPaidAmountBody,
  UpdateSocialLinksBody,
  RotateKeysetBody,
} from "@workspace/api-zod";
import type { z } from "zod";
import { setXpub } from "../lib/fundWallet";
import { validate } from "../middleware/validate";
import { logAuditEvent, requestIp } from "../lib/auditLog";
import { getOrCreateAdminConfig, getOrCreateFeeConfig, getMeltFeeParams } from "../lib/mintConfig";
import type { FeeConfig } from "@workspace/db";
import { getCurrentEpoch, KEYSET_TRANSITION_LOCK_KEY, convertValueMulti, addDustAmounts } from "../lib/epochEngine";
import { getTreasurySnapshot } from "../lib/treasuryBalance";
import { buildNewKeyset, listKeysets, getActiveKeyset, getPrivateKeys, DENOMINATIONS } from "../lib/keysetManager";
import type { Keyset } from "@workspace/db";
import { signSecretDirect, generateSecret } from "../lib/cashuCrypto";
import { recordSupplyDelta, resetSupplyEra, rebaseSupplyEraRetroactive, restoreSupplyEraBtcBalance } from "../lib/supply";
import { computeMeltQuote } from "../lib/meltQuote";
import { getNetworkFeeEstimate } from "../lib/networkFee";
import { getLatestSupply } from "../lib/supply";
import { DERIVATION_PATH_PREFIX } from "../lib/xpub";
import { adminAuth } from "../middleware/adminAuth";
import { sendEmail, getEmailConfig, resetEmailTransporter } from "../lib/email";
import { encryptSecret } from "../lib/cryptoVault";

const router: IRouter = Router();

router.use("/admin", adminAuth);

const CREDITED_STATUSES = ["confirmed", "issued"];

/** Thrown inside the mark-paid transaction to reject a partial batch. */
class MarkPaidBatchError extends Error {
  constructor(public readonly ids: number[]) {
    super("mark-paid batch contains non-pending payouts");
  }
}

router.get("/admin/stats", async (_req, res): Promise<void> => {
  // FLOW metrics (mint/melt counts, fees, dust, chart) report activity
  // at/after the metrics baseline, which the operator resets by performing a
  // key rotation (ROTATE AND VOID). Each flow is filtered by the timestamp of
  // the EVENT that moved the metric (issuance time for mints, settlement time
  // for paid melts), so pre-baseline rows that complete after the reset are
  // still counted. STOCK metrics (BTC held, expected reserve) are ALSO
  // era-scoped: a rotation voids every outstanding token, so whatever BTC
  // remains from before it belongs to the operator and the ledger restarts
  // at zero. The pre-rotation ledger is preserved as priorEraBtcNetSats for
  // historical context rather than silently deleted.
  const adminConfig = await getOrCreateAdminConfig();
  const baseline = adminConfig.metricsBaselineAt;
  const sinceBaseline = (col: AnyColumn | ReturnType<typeof sql>) =>
    baseline ? sql`${col} >= ${baseline}` : sql`true`;
  // Event time for a credited deposit: issuance when it happened, else
  // confirmation time (confirmed-not-yet-issued rows), else createdAt as the
  // last-resort fallback for legacy rows.
  const mintEventTs = sql`coalesce(${mintRequestsTable.proofsIssuedAt}, ${mintRequestsTable.confirmedAt}, ${mintRequestsTable.createdAt})`;
  const fundedEventTs = sql`coalesce(${btcAddressesTable.fundedAt}, ${btcAddressesTable.assignedAt})`;

  const [
    [depositors],
    [totals],
    [allTimeTotals],
    [pending],
    dustRows,
    supply,
    volumeRows,
    [meltPaid],
    [allTimeMeltPaid],
    [eraEstimated],
    meltPendingRows,
    epoch,
    feeConfig,
    treasurySnap,
    [minRateRow],
    meltVolumeRows,
    balanceMintRows,
  ] = await Promise.all([
    db
      .select({ n: count() })
      .from(btcAddressesTable)
      .where(and(eq(btcAddressesTable.status, "funded"), sinceBaseline(fundedEventTs))),
    db
      .select({
        n: count(),
        gross: sql<string>`coalesce(sum(${mintRequestsTable.grossAmountSats}), 0)`,
        net: sql<string>`coalesce(sum(${mintRequestsTable.netAmountSats}), 0)`,
        fees: sql<string>`coalesce(sum(${mintRequestsTable.feeSats}), 0)`,
      })
      .from(mintRequestsTable)
      .where(and(inArray(mintRequestsTable.status, CREDITED_STATUSES), sinceBaseline(mintEventTs))),
    db
      .select({
        gross: sql<string>`coalesce(sum(${mintRequestsTable.grossAmountSats}), 0)`,
        net: sql<string>`coalesce(sum(${mintRequestsTable.netAmountSats}), 0)`,
      })
      .from(mintRequestsTable)
      .where(inArray(mintRequestsTable.status, CREDITED_STATUSES)),
    db
      .select({
        net: sql<string>`coalesce(sum(${mintRequestsTable.netAmountSats}), 0)`,
      })
      .from(mintRequestsTable)
      .where(eq(mintRequestsTable.status, "confirmed")),
    db
      .select({
        source: treasuryDustLogTable.sourceOperation,
        total: sql<string>`coalesce(sum(${treasuryDustLogTable.dustAmount}), 0)`,
      })
      .from(treasuryDustLogTable)
      .where(sinceBaseline(treasuryDustLogTable.createdAt))
      .groupBy(treasuryDustLogTable.sourceOperation),
    getLatestSupply(),
    db
      .select({
        // Bucket by UTC calendar day to match the UTC date keys used for
        // densification below (toISOString), regardless of DB session TZ.
        date: sql<string>`to_char((${mintRequestsTable.proofsIssuedAt} at time zone 'UTC')::date, 'YYYY-MM-DD')`,
        // Net sats: same definition as "BTC held", so chart and totals agree.
        amountSats: sql<string>`coalesce(sum(${mintRequestsTable.netAmountSats}), 0)`,
      })
      .from(mintRequestsTable)
      .where(
        and(
          sql`${mintRequestsTable.status} = 'issued' and ${mintRequestsTable.proofsIssuedAt} >= now() - interval '30 days'`,
          sinceBaseline(mintRequestsTable.proofsIssuedAt),
        ),
      )
      .groupBy(sql`(${mintRequestsTable.proofsIssuedAt} at time zone 'UTC')::date`),
    db
      .select({
        n: count(),
        sats: sql<string>`coalesce(sum(${payoutsTable.paidAmountSats}), 0)`,
      })
      .from(payoutsTable)
      // Settlement is the event that depletes the treasury.
      .where(and(eq(payoutsTable.status, "paid"), sinceBaseline(payoutsTable.settledAt))),
    db
      .select({
        n: count(),
        sats: sql<string>`coalesce(sum(${payoutsTable.paidAmountSats}), 0)`,
      })
      .from(payoutsTable)
      .where(eq(payoutsTable.status, "paid")),
    db
      .select({
        estimated: sql<string>`coalesce(count(*) filter (where ${payoutsTable.paidAmountIsEstimate}), 0)`,
      })
      .from(payoutsTable)
      // Only THIS ERA's estimates make the audit approximate — pre-baseline
      // payouts no longer participate in the reconciliation.
      .where(and(eq(payoutsTable.status, "paid"), sinceBaseline(payoutsTable.settledAt))),
    db
      .select({ amountLeks: payoutsTable.amountLeks })
      .from(payoutsTable)
      .where(eq(payoutsTable.status, "pending")),
    getCurrentEpoch(),
    getOrCreateFeeConfig(),
    getTreasurySnapshot(),
    // Smallest rate index among epochs whose keyset is still honored.
    // Outstanding proofs may date from any unrevoked epoch, and a proof's
    // true sats liability is faceValue / vintageRate — so valuing ALL
    // circulation at the minimum unrevoked rate is a conservative upper
    // bound on the reserve requirement, valid across rate changes.
    db
      .select({ minRate: sql<string | null>`min(${epochsTable.rateIndex})` })
      .from(epochsTable)
      .innerJoin(keysetsTable, eq(keysetsTable.id, epochsTable.keysetId))
      .where(isNull(keysetsTable.revokedAt)),
    // Daily melt payout volume (sats leaving the treasury), bucketed by UTC
    // settlement day over the same 30-day window as the mint series.
    db
      .select({
        date: sql<string>`to_char((${payoutsTable.settledAt} at time zone 'UTC')::date, 'YYYY-MM-DD')`,
        amountSats: sql<string>`coalesce(sum(${payoutsTable.paidAmountSats}), 0)`,
      })
      .from(payoutsTable)
      .where(
        and(
          sql`${payoutsTable.status} = 'paid' and ${payoutsTable.settledAt} >= now() - interval '30 days'`,
          sinceBaseline(payoutsTable.settledAt),
        ),
      )
      .groupBy(sql`(${payoutsTable.settledAt} at time zone 'UTC')::date`),
    // Daily CREDITED deposit deltas (same definition as "BTC held": all
    // credited statuses at their event time) — used to walk the balance
    // series so its last point lands exactly on btcHeldNetSats.
    db
      .select({
        date: sql<string>`to_char((${mintEventTs} at time zone 'UTC')::date, 'YYYY-MM-DD')`,
        amountSats: sql<string>`coalesce(sum(${mintRequestsTable.netAmountSats}), 0)`,
      })
      .from(mintRequestsTable)
      .where(
        and(
          inArray(mintRequestsTable.status, CREDITED_STATUSES),
          sql`${mintEventTs} >= now() - interval '30 days'`,
          sinceBaseline(mintEventTs),
        ),
      )
      .groupBy(sql`(${mintEventTs} at time zone 'UTC')::date`),
  ]);

  // Dense 30-day series (oldest first), zero-filled for days without mints.
  const byDate = new Map(volumeRows.map((r) => [r.date, Number(r.amountSats)]));
  const dailyMintVolume: { date: string; amountSats: number }[] = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    dailyMintVolume.push({ date: key, amountSats: byDate.get(key) ?? 0 });
  }

  // Dense melt series over the same window.
  const meltByDate = new Map(meltVolumeRows.map((r) => [r.date, Number(r.amountSats)]));
  const dailyMeltVolume: { date: string; amountSats: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    dailyMeltVolume.push({ date: key, amountSats: meltByDate.get(key) ?? 0 });
  }

  const netCreditedSats = Number(totals!.net);
  const grossCreditedSats = Number(totals!.gross);
  const meltPaidSats = Number(meltPaid!.sats);
  // STOCK figures: era-scoped (since the rotation baseline), matching the
  // supply-log snapshot definition. Without a baseline this is all-time.
  const btcHeldNetSats = netCreditedSats - meltPaidSats;
  // Pre-rotation ledger, kept visible as historical context.
  const priorEraBtcNetSats = baseline
    ? Number(allTimeTotals!.net) - netCreditedSats - (Number(allTimeMeltPaid!.sats) - meltPaidSats)
    : null;
  const leksInCirculation = supply.totalLeksIssued - supply.totalLeksRedeemed;

  // Daily balance series: walk backward from today's era balance so the
  // last point equals btcHeldNetSats exactly, using credited-deposit and
  // settled-melt deltas per day. IMPORTANT: the SQL windows use a rolling
  // `now() - 30 days` boundary, which can include a partial UTC day that the
  // dense 30-key series never emits — so the starting balance must subtract
  // only the deltas of the EMITTED keys, not every fetched bucket.
  const balanceMintByDate = new Map(balanceMintRows.map((r) => [r.date, Number(r.amountSats)]));
  const seriesKeys: string[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    seriesKeys.push(d.toISOString().slice(0, 10));
  }
  const windowMintTotal = seriesKeys.reduce((a, k) => a + (balanceMintByDate.get(k) ?? 0), 0);
  const windowMeltTotal = seriesKeys.reduce((a, k) => a + (meltByDate.get(k) ?? 0), 0);
  let runningBalance = btcHeldNetSats - windowMintTotal + windowMeltTotal;
  const dailyBalance: { date: string; balanceSats: number }[] = [];
  for (const key of seriesKeys) {
    runningBalance += (balanceMintByDate.get(key) ?? 0) - (meltByDate.get(key) ?? 0);
    dailyBalance.push({ date: key, balanceSats: runningBalance });
  }

  // Pending issuance in LEKS (what the confirmed net sats convert to at the
  // current rate), not raw sats mislabeled as leks.
  const pendingNetSats = Number(pending!.net);
  const leksPendingIssuance = epoch
    ? convertValueMulti([{ amount: pendingNetSats, fromRate: "1.000000000000" }], epoch.rateIndex).value
    : pendingNetSats;

  // Pending melts: per-row quotes at the current rate/fees (same formula the
  // payouts page uses).
  const networkFee = epoch ? await getNetworkFeeEstimate() : null;
  const meltPendingLeks = meltPendingRows.reduce((acc, r) => acc + r.amountLeks, 0);
  let meltPendingEstimatedSats: number | null = null; // recipient net (display)
  let meltPendingReserveSats: number | null = null; // total treasury debit
  if (epoch && networkFee) {
    meltPendingEstimatedSats = 0;
    meltPendingReserveSats = 0;
    for (const r of meltPendingRows) {
      const q = computeMeltQuote(r.amountLeks, epoch.rateIndex, feeConfig, networkFee.estimatedSats);
      meltPendingEstimatedSats += q.estimatedNetSats;
      // The treasury spends recipient net PLUS the network fee = gross − melt
      // fee — the reserve must cover the full anticipated debit.
      meltPendingReserveSats += Math.max(0, q.estimatedGrossSats - q.estimatedFeeSats);
    }
  }

  const dustTotal = dustRows
    .reduce((acc, r) => addDustAmounts(acc, r.total), `0.${"0".repeat(12)}`);

  // Solvency audit:
  //  - expected reserve: what should still sit on the deposit addresses if
  //    every settled melt was paid from them (gross deposits − paid sats);
  //  - required reserve: what is needed to back current liabilities
  //    (circulating leks + pending melts) at the current rate.
  // Conservative bound: a proof issued at vintage rate Rv has liability
  // faceValue / Rv sats; summed liability ≤ circulation / min(unrevoked Rv).
  const minUnrevokedRate = minRateRow?.minRate ? Number(minRateRow.minRate) : null;
  const liabilityRate =
    minUnrevokedRate && minUnrevokedRate > 0
      ? minUnrevokedRate
      : epoch
        ? Number(epoch.rateIndex)
        : null;
  const requiredCirculationSats = Math.max(
    0,
    liabilityRate ? Math.ceil(leksInCirculation / liabilityRate) : leksInCirculation,
  );
  const requiredReserveSats =
    requiredCirculationSats + (meltPendingReserveSats ?? 0);
  // Reconciliation is era-scoped: after ROTATE AND VOID the ledger restarts,
  // so the expected reserve covers only this era's deposits and payouts. Any
  // pre-rotation coins still on-chain surface as a positive discrepancy —
  // operator profit, not a ledger error.
  const expectedReserveSats = grossCreditedSats - meltPaidSats;
  const treasuryFresh = treasurySnap !== null && !treasurySnap.stale;
  const actualBalanceSats = treasurySnap ? treasurySnap.balanceSats : null;
  const discrepancySats = actualBalanceSats !== null ? actualBalanceSats - expectedReserveSats : null;
  // Legacy payouts whose value was reconstructed (not frozen at settlement)
  // make the reconciliation approximate — disclose it.
  const auditApproximate = Number(eraEstimated!.estimated) > 0;
  // Never declare "everything checks out" from a stale reading.
  const auditOk =
    treasuryFresh && actualBalanceSats !== null
      ? actualBalanceSats >= requiredReserveSats
      : null;

  res.json({
    fundedAddresses: depositors!.n,
    mintCount: totals!.n,
    totalBtcGrossSats: grossCreditedSats,
    totalBtcNetSats: netCreditedSats,
    totalFeesCollectedSats: Number(totals!.fees),
    btcHeldNetSats,
    priorEraBtcNetSats,
    meltPaidCount: meltPaid!.n,
    meltPaidSats,
    meltPendingCount: meltPendingRows.length,
    meltPendingLeks,
    meltPendingEstimatedSats,
    meltPendingReserveSats,
    leksInCirculation,
    leksPendingIssuance,
    treasuryDust: dustTotal,
    treasuryDustBySource: dustRows
      .map((r) => ({ source: r.source, total: r.total }))
      .sort((a, b) => a.source.localeCompare(b.source)),
    treasury: {
      liveBalanceSats: actualBalanceSats,
      addressCount: treasurySnap ? treasurySnap.addressCount : null,
      fetchedAt: treasurySnap ? treasurySnap.fetchedAt.toISOString() : null,
      stale: treasurySnap ? treasurySnap.stale : null,
    },
    audit: {
      expectedReserveSats,
      requiredReserveSats,
      actualBalanceSats,
      discrepancySats,
      approximate: auditApproximate,
      ok: auditOk,
    },
    metricsBaselineAt: baseline ? baseline.toISOString() : null,
    dailyMintVolume,
    dailyMeltVolume,
    dailyBalance,
  });
});

router.get("/admin/escrows/list", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(swapEscrowsTable)
    .orderBy(desc(swapEscrowsTable.createdAt))
    .limit(200);
  res.json({
    escrows: rows.map((row) => {
      let releasedToken: string | null = null;
      if (row.claimBundle) {
        try {
          const bundle = JSON.parse(row.claimBundle) as { adminRelease?: boolean; token?: string };
          if (bundle.adminRelease && bundle.token) releasedToken = bundle.token;
        } catch {
          // Legacy/claim bundles are not admin releases.
        }
      }
      return {
        id: row.id,
        amountLeks: row.amountLeks,
        faceTotal: row.faceTotal,
        convertedValue: row.convertedValue,
        createdAt: row.createdAt.toISOString(),
        claimedAt: row.claimedAt ? row.claimedAt.toISOString() : null,
        releasedToken,
        claimable: !row.claimedAt,
      };
    }),
  });
});

async function getActiveKeysetForRelease(): Promise<Keyset | undefined> {
  return (await getActiveKeyset()) ?? undefined;
}

/** Decompose an amount into keyset denominations (largest first). */
function buildDirectProofs(
  keyset: Keyset,
  amount: number,
): { id: string; amount: number; secret: string; C: string }[] {
  const privkeys = getPrivateKeys(keyset);
  const denomsDesc = [...DENOMINATIONS].sort((a, b) => b - a);
  const proofs: { id: string; amount: number; secret: string; C: string }[] = [];
  let remaining = amount;
  for (const denom of denomsDesc) {
    while (remaining >= denom) {
      const secret = generateSecret();
      proofs.push({
        id: keyset.id,
        amount: denom,
        secret,
        C: signSecretDirect(secret, privkeys[String(denom)]!),
      });
      remaining -= denom;
    }
  }
  if (remaining !== 0) {
    throw new Error(`Cannot decompose ${amount} into keyset denominations`);
  }
  return proofs;
}

/**
 * Operator escape hatch: release a stranded escrow as a spendable token.
 *
 * Escrows created before output-linkage existed (or whose token was lost)
 * can otherwise never be claimed — the input proofs live inside an external
 * wallet. The mint self-issues proofs for the escrowed amount (direct
 * signature, no blinding — the mint generates the secret itself) and returns
 * a standard token string the operator pastes into the site wallet. The
 * token is also stored on the escrow row so it is never lost if the browser
 * closes before the operator copies it.
 */
router.post("/admin/escrows/:id/release", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid escrow id" });
    return;
  }
  const [row] = await db.select().from(swapEscrowsTable).where(eq(swapEscrowsTable.id, id));
  if (!row) {
    res.status(409).json({ error: "Escrow not found" });
    return;
  }
  if (row.claimedAt) {
    // Idempotent for admin releases: return the stored token again.
    try {
      const bundle = JSON.parse(row.claimBundle ?? "{}") as { adminRelease?: boolean; token?: string };
      if (bundle.adminRelease && bundle.token) {
        res.json({ unit: "lek", amountLeks: row.amountLeks, token: bundle.token });
        return;
      }
    } catch {
      // fall through
    }
    res.status(409).json({ error: "Escrow already claimed by its token holder" });
    return;
  }
  const keyset = await getActiveKeysetForRelease();
  if (!keyset) {
    res.status(503).json({ error: "Mint not initialized: no active keyset" });
    return;
  }
  const proofs = buildDirectProofs(keyset, row.amountLeks);
  const mintUrl = `${req.protocol}://${req.get("host") ?? "lekmint.cash"}/api`;
  const token =
    "cashuA" +
    Buffer.from(JSON.stringify({ token: [{ mint: mintUrl, proofs }], unit: "lek" }))
      .toString("base64url");
  const claimed = await db.transaction(async (tx) => {
    const updated = await tx
      .update(swapEscrowsTable)
      .set({
        claimedAt: sql`now()`,
        claimBundle: JSON.stringify({ adminRelease: true, token }),
      })
      .where(and(eq(swapEscrowsTable.id, id), isNull(swapEscrowsTable.claimedAt)))
      .returning({ amountLeks: swapEscrowsTable.amountLeks });
    if (!updated[0]) return false;
    // Escrowed leks enter circulation only now, exactly as with a wallet claim.
    await recordSupplyDelta(tx, { issued: updated[0].amountLeks });
    return true;
  });
  if (!claimed) {
    res.status(409).json({ error: "Escrow was claimed concurrently" });
    return;
  }
  logAuditEvent("escrow_admin_released", requestIp(req), { escrowId: id, amount: row.amountLeks });
  res.json({ unit: "lek", amountLeks: row.amountLeks, token });
});

router.get("/admin/escrows", async (_req, res): Promise<void> => {
  const [row] = await db
    .select({
      unclaimedCount: sql<string>`count(*) filter (where ${swapEscrowsTable.claimedAt} is null)`,
      unclaimedTotalLeks: sql<string>`coalesce(sum(${swapEscrowsTable.amountLeks}) filter (where ${swapEscrowsTable.claimedAt} is null), 0)`,
      claimedCount: sql<string>`count(*) filter (where ${swapEscrowsTable.claimedAt} is not null)`,
      claimedTotalLeks: sql<string>`coalesce(sum(${swapEscrowsTable.amountLeks}) filter (where ${swapEscrowsTable.claimedAt} is not null), 0)`,
    })
    .from(swapEscrowsTable);
  res.json({
    unclaimedCount: Number(row!.unclaimedCount),
    unclaimedTotalLeks: Number(row!.unclaimedTotalLeks),
    claimedCount: Number(row!.claimedCount),
    claimedTotalLeks: Number(row!.claimedTotalLeks),
  });
});

/** Serialize a fee config row with EFFECTIVE melt values (fallback = mint). */
function feeConfigResponse(config: FeeConfig) {
  const melt = getMeltFeeParams(config);
  return {
    fixedFeeSats: config.fixedFeeSats,
    percentageFeeBps: config.percentageFeeBps,
    minThresholdSats: config.minThresholdSats,
    meltFixedFeeSats: melt.fixedFeeSats,
    meltPercentageFeeBps: melt.percentageFeeBps,
    meltMinThresholdSats: melt.minThresholdSats,
    meltConfigured:
      config.meltFixedFeeSats !== null ||
      config.meltPercentageFeeBps !== null ||
      config.meltMinThresholdSats !== null,
    updatedAt: config.updatedAt.toISOString(),
  };
}

router.get("/admin/fee-config", async (_req, res): Promise<void> => {
  res.json(feeConfigResponse(await getOrCreateFeeConfig()));
});

router.put(
  "/admin/fee-config",
  validate({ body: UpdateFeeConfigBody }),
  async (req, res): Promise<void> => {
  const body = req.body as z.infer<typeof UpdateFeeConfigBody>;
  // Partial update: only fields present in the body are written.
  const changes = Object.fromEntries(
    Object.entries(body).filter(([, v]) => v !== undefined),
  );
  if (Object.keys(changes).length === 0) {
    res.status(400).json({ error: "No fee fields provided" });
    return;
  }
  const existing = await getOrCreateFeeConfig();
  const [updated] = await db
    .update(feeConfigTable)
    .set(changes)
    .where(eq(feeConfigTable.id, existing.id))
    .returning();
  logAuditEvent("fee_changed", requestIp(req), { ...changes });
  res.json(feeConfigResponse(updated!));
  },
);

/**
 * Correct a settled payout's actual paid sats. Legacy payouts (and every
 * batch settlement) freeze quote-time ESTIMATES; when the operator knows the
 * true on-chain amount, this replaces the estimate with the exact figure and
 * clears the estimate flag, so the audit stops disclosing approximation for
 * that row. The supply snapshot is refreshed in the same transaction because
 * the era BTC balance derives from paid amounts.
 */
router.post(
  "/admin/payouts/:id/correct",
  validate({ body: CorrectPayoutPaidAmountBody }),
  async (req, res): Promise<void> => {
    const id = Number(req.params["id"]);
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid payout id" });
      return;
    }
    const { paidAmountSats } = req.body as z.infer<typeof CorrectPayoutPaidAmountBody>;
    // The zod validator bounds the range but does not force integrality —
    // a ledger correction must be a whole number of sats.
    if (!Number.isSafeInteger(paidAmountSats) || paidAmountSats < 0) {
      res.status(400).json({ error: "paidAmountSats must be a whole, non-negative sats amount" });
      return;
    }
    const stored = await db.transaction(async (tx) => {
      const updated = await tx
        .update(payoutsTable)
        .set({ paidAmountSats, paidAmountIsEstimate: false })
        .where(and(eq(payoutsTable.id, id), eq(payoutsTable.status, "paid")))
        .returning({
          id: payoutsTable.id,
          paidAmountSats: payoutsTable.paidAmountSats,
          paidAmountIsEstimate: payoutsTable.paidAmountIsEstimate,
        });
      if (!updated[0]) return null;
      await recordSupplyDelta(tx, {});
      return updated[0];
    });
    if (!stored) {
      res.status(409).json({ error: "Payout not found or not settled" });
      return;
    }
    // Report the PERSISTED ledger value, not the submitted one.
    const storedSats = Number(stored.paidAmountSats);
    logAuditEvent("payout_corrected", requestIp(req), { payoutId: id, paidAmountSats: storedSats });
    res.json({ id: stored.id, paidAmountSats: storedSats, paidAmountIsEstimate: stored.paidAmountIsEstimate });
  },
);

router.put(
  "/admin/xpub",
  validate({ body: UpdateXpubBody }),
  async (req, res): Promise<void> => {
  const body = req.body as z.infer<typeof UpdateXpubBody>;
  try {
    const { nextIndex, sampleAddresses } = await setXpub(body.xpub);
    // Never log the xpub itself — only the fact that it changed.
    logAuditEvent("xpub_changed", requestIp(req), { nextIndex });
    res.json({
      accepted: true,
      derivationPath: `${DERIVATION_PATH_PREFIX}/N`,
      nextIndex,
      sampleAddresses,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid xpub" });
  }
  },
);

// Public social links endpoint — no auth required.
router.get("/social-links", async (_req, res): Promise<void> => {
  const config = await getOrCreateAdminConfig();
  res.json({
    contactXUrl: config.contactXUrl ?? null,
    contactNostrUrl: config.contactNostrUrl ?? null,
    contactEmail: config.contactEmail ?? null,
  });
});

router.put(
  "/admin/social-links",
  validate({ body: UpdateSocialLinksBody }),
  async (req, res): Promise<void> => {
    const { contactXUrl, contactNostrUrl, contactEmail } = req.body as z.infer<typeof UpdateSocialLinksBody>;
    const existing = await getOrCreateAdminConfig();
    const [updated] = await db
      .update(adminConfigTable)
      .set({
        contactXUrl: contactXUrl ?? null,
        contactNostrUrl: contactNostrUrl ?? null,
        contactEmail: contactEmail ?? null,
      })
      .where(eq(adminConfigTable.id, existing.id))
      .returning();
    res.json({
      contactXUrl: updated!.contactXUrl ?? null,
      contactNostrUrl: updated!.contactNostrUrl ?? null,
      contactEmail: updated!.contactEmail ?? null,
    });
  },
);

router.get("/admin/mint-settings", async (_req, res): Promise<void> => {
  const config = await getOrCreateAdminConfig();
  res.json({
    minConfirmations: config.minConfirmations,
    xpubConfigured: config.xpubEncrypted !== null,
    derivationIndexCounter: config.derivationIndexCounter,
    updatedAt: config.updatedAt.toISOString(),
  });
});

router.put(
  "/admin/mint-settings",
  validate({ body: UpdateMintSettingsBody }),
  async (req, res): Promise<void> => {
  const body = req.body as z.infer<typeof UpdateMintSettingsBody>;
  const existing = await getOrCreateAdminConfig();
  const [updated] = await db
    .update(adminConfigTable)
    .set({ minConfirmations: body.minConfirmations })
    .where(eq(adminConfigTable.id, existing.id))
    .returning();
  res.json({
    minConfirmations: updated!.minConfirmations,
    xpubConfigured: updated!.xpubEncrypted !== null,
    derivationIndexCounter: updated!.derivationIndexCounter,
    updatedAt: updated!.updatedAt.toISOString(),
  });
  },
);

router.get(
  "/admin/supply",
  validate({ query: GetSupplyLogQueryParams }),
  async (_req, res): Promise<void> => {
  const query = res.locals["query"] as z.infer<typeof GetSupplyLogQueryParams>;
  const limit = query.limit ?? 100;
  const offset = query.offset ?? 0;

  // Fetch baseline so we can compute BTC balance live for era rows only.
  const [configRow] = await db
    .select({ baseline: adminConfigTable.metricsBaselineAt })
    .from(adminConfigTable)
    .limit(1);
  const baseline = configRow?.baseline ?? null;

  // For era rows (snapshotAt >= baseline): compute btcBalanceSats fresh from
  // source tables so the column is always authoritative regardless of any past
  // rebase operations on the stored value.
  // For pre-baseline rows: keep the stored value (those rows were never touched).
  type SupplyRow = {
    id: number;
    snapshot_at: Date;
    total_leks_issued: string;
    total_leks_redeemed: string;
    btc_balance_sats: string;
  };
  const [entriesResult, [totalRow]] = await Promise.all([
    db.execute<SupplyRow>(
      baseline
        ? sql`
            SELECT
              s.id,
              s.snapshot_at,
              s.total_leks_issued,
              s.total_leks_redeemed,
              CASE
                WHEN s.snapshot_at >= ${baseline} THEN
                  COALESCE((
                    SELECT SUM(mr.net_amount_sats)
                    FROM mint_requests mr
                    WHERE mr.status IN ('confirmed', 'issued')
                      AND COALESCE(mr.proofs_issued_at, mr.confirmed_at, mr.created_at) >= ${baseline}
                      -- +1s tolerance: the triggering deposit's proofs_issued_at (JS new Date())
                      -- lands a few ms AFTER snapshot_at (Postgres now(), frozen at tx start).
                      AND COALESCE(mr.proofs_issued_at, mr.confirmed_at, mr.created_at) <= s.snapshot_at + INTERVAL '1 second'
                  ), 0)
                  -
                  COALESCE((
                    SELECT SUM(p.paid_amount_sats)
                    FROM payouts p
                    WHERE p.status = 'paid'
                      AND p.settled_at >= ${baseline}
                      AND p.settled_at <= s.snapshot_at + INTERVAL '1 second'
                  ), 0)
                ELSE s.btc_balance_sats
              END AS btc_balance_sats
            FROM token_supply_log s
            ORDER BY s.id DESC
            LIMIT ${limit} OFFSET ${offset}
          `
        : sql`
            SELECT id, snapshot_at, total_leks_issued, total_leks_redeemed, btc_balance_sats
            FROM token_supply_log
            ORDER BY id DESC
            LIMIT ${limit} OFFSET ${offset}
          `,
    ),
    db.select({ n: count() }).from(tokenSupplyLogTable),
  ]);

  res.json({
    entries: entriesResult.rows.map((e) => ({
      id: e.id,
      snapshotAt: new Date(e.snapshot_at).toISOString(),
      totalLeksIssued: Number(e.total_leks_issued),
      totalLeksRedeemed: Number(e.total_leks_redeemed),
      btcBalanceSats: Number(e.btc_balance_sats),
    })),
    total: totalRow!.n,
  });
  },
);

router.get(
  "/admin/payouts",
  validate({ query: GetPayoutsQueryParams }),
  async (_req, res): Promise<void> => {
  const query = res.locals["query"] as z.infer<typeof GetPayoutsQueryParams>;
  const limit = query.limit ?? 100;
  const offset = query.offset ?? 0;
  const statusFilter = query.status;

  const where = statusFilter ? eq(payoutsTable.status, statusFilter) : undefined;

  const [entries, [totalRow], pendingRows, epoch, feeConfig] = await Promise.all([
    db
      .select()
      .from(payoutsTable)
      .where(where)
      .orderBy(desc(payoutsTable.id))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(payoutsTable).where(where),
    db
      .select({ amountLeks: payoutsTable.amountLeks })
      .from(payoutsTable)
      .where(eq(payoutsTable.status, "pending")),
    getCurrentEpoch(),
    getOrCreateFeeConfig(),
  ]);
  // Same network-fee figure (live or fallback) the melt quote deducts.
  const networkFee = await getNetworkFeeEstimate();

  // BTC owed is NEVER frozen at melt time: it is recomputed on every read
  // from the current epoch rate index + fee schedule + network fee via the
  // same computeMeltQuote used by GET /melt/quote, so the estimate the user
  // saw and the batch the operator prepares share one formula. Paid rows get
  // null — their settlement already happened at whatever rate applied then.
  const estimateSats = (amountLeks: number, status: string): number | null =>
    epoch && status === "pending"
      ? computeMeltQuote(amountLeks, epoch.rateIndex, feeConfig, networkFee.estimatedSats)
          .estimatedNetSats
      : null;

  const pendingTotalLeks = pendingRows.reduce((acc, r) => acc + r.amountLeks, 0);
  // Fee applies per payout row (one transfer each), so the pending total is
  // the sum of per-row quotes, not one quote over the summed leks.
  const pendingTotalEstimatedSats = epoch
    ? pendingRows.reduce(
        (acc, r) =>
          acc +
          computeMeltQuote(r.amountLeks, epoch.rateIndex, feeConfig, networkFee.estimatedSats)
            .estimatedNetSats,
        0,
      )
    : null;
  res.json({
    entries: entries.map((p) => ({
      id: p.id,
      btcAddress: p.btcAddress,
      amountLeks: p.amountLeks,
      status: p.status,
      createdAt: p.createdAt.toISOString(),
      settledAt: p.settledAt ? p.settledAt.toISOString() : null,
      estimatedBtcSats: estimateSats(p.amountLeks, p.status),
      paidAmountSats: p.paidAmountSats !== null ? Number(p.paidAmountSats) : null,
      paidAmountIsEstimate: p.status === "paid" ? p.paidAmountIsEstimate : null,
    })),
    total: totalRow!.n,
    pendingCount: pendingRows.length,
    pendingTotalLeks,
    rateIndex: epoch?.rateIndex ?? null,
    pendingTotalEstimatedSats,
  });
  },
);

router.post(
  "/admin/payouts/mark-paid",
  validate({ body: MarkPayoutsPaidBody }),
  async (req, res): Promise<void> => {
  const { ids } = req.body as z.infer<typeof MarkPayoutsPaidBody>;
  // Freeze each payout's TOTAL treasury debit at settlement time using the
  // same melt quote formula shown to the operator. The treasury spends the
  // recipient amount PLUS the network fee, i.e. gross − melt fee (the melt
  // fee stays in the treasury), so that is the figure frozen here. It is
  // still a settlement-time quote — not read from the actual on-chain
  // transaction — so it is stored flagged as an estimate and the audit
  // discloses the approximation.
  const [epoch, feeConfig] = await Promise.all([getCurrentEpoch(), getOrCreateFeeConfig()]);
  const networkFee = epoch ? await getNetworkFeeEstimate() : null;
  const frozenSats = (amountLeks: number): number | null => {
    if (!epoch || !networkFee) return null;
    const q = computeMeltQuote(amountLeks, epoch.rateIndex, feeConfig, networkFee.estimatedSats);
    // Total outflow = recipient net + network fee = gross − melt fee
    // (clamped like the net amount: fees can consume a tiny melt entirely).
    return Math.max(0, q.estimatedGrossSats - q.estimatedFeeSats);
  };
  // Strict batch contract: ALL requested rows must be pending, and the whole
  // batch settles in ONE transaction — either every row flips (with its
  // frozen value) or the request is rejected and nothing changes.
  const settledAt = new Date();
  let settled: { id: number; amountLeks: number }[];
  try {
    settled = await db.transaction(async (tx) => {
      const pendingRows = await tx
        .select({ id: payoutsTable.id, amountLeks: payoutsTable.amountLeks })
        .from(payoutsTable)
        .where(and(inArray(payoutsTable.id, ids), eq(payoutsTable.status, "pending")))
        .for("update");
      const pendingIds = new Set(pendingRows.map((r) => r.id));
      const notSettleable = ids.filter((id) => !pendingIds.has(id));
      if (notSettleable.length > 0) {
        throw new MarkPaidBatchError(notSettleable);
      }
      const done: { id: number; amountLeks: number }[] = [];
      for (const row of pendingRows) {
        const updated = await tx
          .update(payoutsTable)
          .set({
            status: "paid",
            settledAt,
            paidAmountSats: frozenSats(row.amountLeks),
            paidAmountIsEstimate: true,
          })
          .where(and(eq(payoutsTable.id, row.id), eq(payoutsTable.status, "pending")))
          .returning({ id: payoutsTable.id, amountLeks: payoutsTable.amountLeks });
        if (updated[0]) done.push(updated[0]);
      }
      // Snapshot the supply log in the SAME transaction: BTC balance now
      // derives from paid payout debits, so the settlement must be captured
      // atomically, not whenever the next issuance/redemption happens by.
      if (done.length > 0) {
        await recordSupplyDelta(tx, {});
      }
      return done;
    });
  } catch (err) {
    if (err instanceof MarkPaidBatchError) {
      res.status(400).json({
        error: "batch_not_pending",
        message:
          "No payouts were settled: some requested payouts are not pending (already paid or unknown)",
        notSettleableIds: err.ids,
      });
      return;
    }
    throw err;
  }

  if (settled.length === 0) {
    res.status(400).json({ error: "No matching pending payouts" });
    return;
  }

  const settledTotalLeks = settled.reduce((acc, p) => acc + p.amountLeks, 0);
  logAuditEvent("payouts_settled", requestIp(req), {
    count: settled.length,
    totalLeks: settledTotalLeks,
    ids: settled.map((p) => p.id),
  });
  res.json({ settledCount: settled.length, settledTotalLeks });
  },
);

router.get("/admin/keysets", async (_req, res): Promise<void> => {
  const keysets = await listKeysets();
  res.json({
    keysets: keysets
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((k) => ({
        id: k.id,
        active: k.active,
        epochId: k.epochId,
        createdAt: k.createdAt.toISOString(),
        revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
      })),
  });
});

const ROTATE_CONFIRM_PHRASE = "ROTATE AND VOID";

/**
 * Security rotation: mint fresh keys at the CURRENT epoch rate and revoke
 * every previous keyset. All tokens signed by the old keys become permanently
 * invalid — this is the operator's remedy when tokens predating a database
 * reset are still in circulation. Value-neutral for the rate math: the new
 * epoch row copies the current rate/difficulty/subsidy, so the HWM logic and
 * payout quotes are unaffected.
 */
router.post(
  "/admin/rotate-keyset",
  validate({ body: RotateKeysetBody }),
  async (req, res): Promise<void> => {
    const body = req.body as z.infer<typeof RotateKeysetBody>;
    if (body.confirm !== ROTATE_CONFIRM_PHRASE) {
      res.status(400).json({ error: `Confirmation phrase must be exactly "${ROTATE_CONFIRM_PHRASE}"` });
      return;
    }
    // Pre-check only (for a clean 503); the authoritative read happens inside
    // the transaction under the keyset-transition advisory lock.
    if (!(await getCurrentEpoch())) {
      res.status(503).json({ error: "Mint not initialized: no epoch yet" });
      return;
    }

    const keyset = buildNewKeyset(0);
    const rotatedAt = new Date();
    let revokedIds: string[] = [];
    await db.transaction(async (tx) => {
      // Serialize against difficulty-driven epoch rolls: both transitions
      // take this xact lock, so they can never interleave.
      await tx.execute(sql`select pg_advisory_xact_lock(${KEYSET_TRANSITION_LOCK_KEY})`);
      const [current] = await tx.select().from(epochsTable).orderBy(desc(epochsTable.id)).limit(1);
      if (!current) {
        throw new Error("Mint not initialized: no epoch yet");
      }
      // Revoke everything not already revoked (active and historical alike).
      const revoked = await tx
        .update(keysetsTable)
        .set({ active: false, revokedAt: rotatedAt })
        .where(isNull(keysetsTable.revokedAt))
        .returning({ id: keysetsTable.id });
      revokedIds = revoked.map((r) => r.id);
      // New epoch at the SAME rate — a security rotation, not a rate change.
      const [epoch] = await tx
        .insert(epochsTable)
        .values({
          keysetId: keyset.id,
          rateIndex: current.rateIndex,
          difficulty: current.difficulty,
          subsidySats: current.subsidySats,
        })
        .returning();
      await tx.insert(keysetsTable).values({
        id: keyset.id,
        unit: "lek",
        active: true,
        epochId: epoch!.id,
        encryptedKeys: keyset.encryptedKeys,
      });
      // Metrics baseline FIRST: the panel reports only post-reset activity,
      // and the supply snapshot below must already see the new baseline so
      // its era-scoped BTC balance restarts at zero.
      await tx
        .update(adminConfigTable)
        .set({ metricsBaselineAt: rotatedAt })
        .where(eq(adminConfigTable.id, (await getOrCreateAdminConfig()).id));
      // ROTATE AND VOID permanently invalidates every outstanding token —
      // a new token era begins. The supply log restarts at zero: later rows
      // build era-scoped figures on top of this zero snapshot, while
      // pre-rotation rows keep their historical values.
      await resetSupplyEra(tx);
    });

    logAuditEvent("keyset_rotated", requestIp(req), {
      newKeysetId: keyset.id,
      revokedKeysetIds: revokedIds,
    });
    res.json({
      newKeysetId: keyset.id,
      revokedKeysetIds: revokedIds,
      rotatedAt: rotatedAt.toISOString(),
    });
  },
);

/**
 * One-time idempotent data correction: rebase supply-log rows recorded
 * at/after the current metrics baseline (set by a key rotation) so the era's
 * snapshots start at zero. Pre-rotation rows keep their historical values.
 * Safe to call repeatedly — a second call reports nothing to do.
 */
router.post("/admin/rebase-supply-era", async (req, res): Promise<void> => {
  const message = await rebaseSupplyEraRetroactive();
  logAuditEvent("supply_era_rebased", requestIp(req), { message });
  res.json({ message });
});

/**
 * Recovery for supply-log rows whose btcBalanceSats were incorrectly shifted
 * by a past buggy rebase. Recomputes the correct current BTC balance from
 * source tables (same era-scoped logic as recordSupplyDelta) and applies the
 * difference to every era row. Idempotent — a second call reports nothing to do.
 */
router.post("/admin/restore-supply-btc-balance", async (req, res): Promise<void> => {
  const message = await restoreSupplyEraBtcBalance();
  logAuditEvent("supply_btc_balance_restored", requestIp(req), { message });
  res.json({ message });
});

/**
 * Smoke-test route: sends a test email to OPERATOR_EMAIL so the operator can
 * verify Mailgun SMTP delivery without code changes.
 *
 * Guarded by adminAuth (applied at the top of this router). Never exposed
 * to public traffic.
 */
router.post("/admin/test-email", async (_req, res): Promise<void> => {
  const { operatorEmail: to } = await getEmailConfig();
  if (!to) {
    res.status(503).json({ error: "Operator email is not configured (admin Email settings or OPERATOR_EMAIL secret)" });
    return;
  }
  try {
    const sent = await sendEmail({
      to,
      subject: "lekmint.cash — SMTP test",
      text: "This is a test message from the lekmint.cash API server. If you received this, outbound email via Mailgun SMTP is working correctly.",
    });
    if (!sent) {
      res.status(503).json({ error: "SMTP is not configured (missing MAILGUN_SMTP_USER or MAILGUN_SMTP_PASS)" });
      return;
    }
    res.json({ ok: true, to });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `SMTP delivery failed: ${message}` });
  }
});

/**
 * Email (Mailgun SMTP) settings — editable from the admin dashboard.
 * The SMTP password is stored AES-256-GCM encrypted (cryptoVault) and is
 * NEVER returned to the client; responses only report whether one is set.
 * Fields left null fall back to the corresponding env secrets.
 */
router.get("/admin/email-settings", async (_req, res): Promise<void> => {
  const cfg = await getEmailConfig();
  res.json({
    smtpUser: cfg.user,
    smtpPassSet: cfg.pass !== null,
    operatorEmail: cfg.operatorEmail,
    sources: cfg.sources,
  });
});

router.put(
  "/admin/email-settings",
  validate({ body: UpdateEmailSettingsBody }),
  async (req, res): Promise<void> => {
    const body = req.body as z.infer<typeof UpdateEmailSettingsBody>;
    const existing = await getOrCreateAdminConfig();
    const updates: Partial<{
      smtpUser: string | null;
      smtpPassEncrypted: string | null;
      operatorEmail: string | null;
    }> = {};
    if (body.smtpUser !== undefined) {
      updates.smtpUser = body.smtpUser === "" ? null : body.smtpUser;
    }
    if (body.smtpPass !== undefined) {
      // Empty string means "clear the stored password" (fall back to env
      // secret); omitted means "leave unchanged".
      updates.smtpPassEncrypted = body.smtpPass === "" ? null : encryptSecret(body.smtpPass);
    }
    if (body.operatorEmail !== undefined) {
      updates.operatorEmail = body.operatorEmail === "" ? null : body.operatorEmail;
    }
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }
    await db.update(adminConfigTable).set(updates).where(eq(adminConfigTable.id, existing.id));
    resetEmailTransporter();
    logAuditEvent("email_settings_changed", requestIp(req), {
      changed: Object.keys(updates),
    });
    const cfg = await getEmailConfig();
    res.json({
      smtpUser: cfg.user,
      smtpPassSet: cfg.pass !== null,
      operatorEmail: cfg.operatorEmail,
      sources: cfg.sources,
    });
  },
);

export default router;

import { db, mintRequestsTable, btcAddressesTable, btcTransactionsTable } from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { getOrCreateAdminConfig, getOrCreateFeeConfig, calculateFee } from "./mintConfig";
import { logger } from "./logger";
import { operationMode } from "./operationMode";

/**
 * Background deposit watcher. Polls the mempool.space REST API (no key
 * required; self-hostable — override with MEMPOOL_API_BASE) every 30s for
 * every mint request still awaiting payment/confirmation.
 *
 * Lifecycle it drives: pending -> payment_detected -> confirmed
 * (fee is computed and gross/fee/net are written at confirmation time).
 */

const MEMPOOL_API_BASE = process.env.MEMPOOL_API_BASE ?? "https://mempool.space/api";
const POLL_INTERVAL_MS = 30_000;

interface MempoolVout {
  scriptpubkey_address?: string;
  value: number;
}

interface MempoolTx {
  txid: string;
  status: { confirmed: boolean; block_height?: number; block_time?: number };
  vout: MempoolVout[];
}

interface MempoolAddressStats {
  chain_stats: { tx_count: number };
  mempool_stats: { tx_count: number };
}

/**
 * Whether an address has ANY on-chain or mempool history. Used at address
 * derivation time so mint requests never hand out a previously used address
 * (e.g. when the configured xpub belongs to an already-used wallet).
 */
export async function addressHasHistory(address: string): Promise<boolean> {
  const stats = await fetchJson<MempoolAddressStats>(`/address/${address}`);
  return stats.chain_stats.tx_count > 0 || stats.mempool_stats.tx_count > 0;
}

/**
 * Creation-time snapshot for a mint request: current chain tip height and
 * every txid already present at the address (chain + mempool). Anything in
 * this snapshot is permanently ineligible for crediting.
 */
export async function snapshotAddressBaseline(
  address: string,
): Promise<{ tipHeight: number; existingTxids: string[] }> {
  const [tipHeight, txs] = await Promise.all([
    getTipHeight(),
    fetchJson<MempoolTx[]>(`/address/${address}/txs`),
  ]);
  return { tipHeight, existingTxids: txs.map((tx) => tx.txid) };
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${MEMPOOL_API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`mempool.space ${path} -> HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function getTipHeight(): Promise<number> {
  const res = await fetch(`${MEMPOOL_API_BASE}/blocks/tip/height`);
  if (!res.ok) {
    throw new Error(`mempool.space tip height -> HTTP ${res.status}`);
  }
  return Number(await res.text());
}

/** Sum of sats received by `address` in a transaction's outputs. */
function receivedByAddress(tx: MempoolTx, address: string): number {
  return tx.vout
    .filter((v) => v.scriptpubkey_address === address)
    .reduce((sum, v) => sum + v.value, 0);
}

interface RequestBaseline {
  createdAt: Date;
  baselineTipHeight: number | null;
  excludedTxids: string[];
}

/**
 * Eligibility guard: a transaction may only be credited to this request if
 * ALL of the following hold — it is not in the creation-time txid snapshot,
 * and it is either still unconfirmed (appeared after the snapshot) or was
 * confirmed in a block STRICTLY AFTER the tip height recorded at request
 * creation. Block height, not block_time, is the trust anchor: miner
 * timestamps can drift by hours. Legacy rows without a baseline fall back to
 * the block_time >= created_at filter.
 */
function isEligible(tx: MempoolTx, baseline: RequestBaseline): boolean {
  if (baseline.excludedTxids.includes(tx.txid)) {
    return false;
  }
  if (!tx.status.confirmed) {
    return true;
  }
  if (baseline.baselineTipHeight !== null) {
    return (tx.status.block_height ?? 0) > baseline.baselineTipHeight;
  }
  const createdAtSec = Math.floor(baseline.createdAt.getTime() / 1000);
  return (tx.status.block_time ?? 0) >= createdAtSec;
}

async function checkAddress(
  requestId: string,
  address: string,
  baseline: RequestBaseline,
  tipHeight: number,
  minConfirmations: number,
): Promise<void> {
  const txs = await fetchJson<MempoolTx[]>(`/address/${address}/txs`);
  const funding = txs
    .map((tx) => ({ tx, amount: receivedByAddress(tx, address) }))
    .filter((f) => f.amount > 0)
    .filter(({ tx }) => isEligible(tx, baseline));

  if (funding.length === 0) {
    return;
  }

  let totalConfirmed = 0;
  let anyDetected = false;
  let minConfsSeen: number | null = null;
  const creditedTxs: Array<{ txid: string; amountSats: number }> = [];

  for (const { tx, amount } of funding) {
    const confirmations =
      tx.status.confirmed && tx.status.block_height
        ? tipHeight - tx.status.block_height + 1
        : 0;
    anyDetected = true;
    minConfsSeen = minConfsSeen === null ? confirmations : Math.min(minConfsSeen, confirmations);
    if (confirmations >= minConfirmations) {
      totalConfirmed += amount;
      creditedTxs.push({ txid: tx.txid, amountSats: amount });
    }

    await db
      .insert(btcTransactionsTable)
      .values({
        txid: tx.txid,
        address,
        amountSats: amount,
        confirmations,
        status: confirmations >= minConfirmations ? "confirmed" : "detected",
      })
      .onConflictDoUpdate({
        target: [btcTransactionsTable.txid, btcTransactionsTable.address],
        set: {
          confirmations,
          status: confirmations >= minConfirmations ? "confirmed" : "detected",
        },
      });
  }

  if (totalConfirmed > 0) {
    const feeConfig = await getOrCreateFeeConfig();
    const fee = calculateFee(totalConfirmed, feeConfig);
    const confirmedAt = new Date();
    await db
      .update(mintRequestsTable)
      .set({
        status: "confirmed",
        confirmedAt,
        grossAmountSats: totalConfirmed,
        feeSats: fee,
        netAmountSats: totalConfirmed - fee,
        creditedTxs,
      })
      .where(
        sql`${mintRequestsTable.id} = ${requestId} AND ${mintRequestsTable.status} IN ('pending', 'payment_detected')`,
      );
    await db
      .update(btcAddressesTable)
      .set({ status: "funded", fundedAt: confirmedAt })
      .where(eq(btcAddressesTable.address, address));
    logger.info(
      { requestId, address, grossSats: totalConfirmed, feeSats: fee },
      "Deposit confirmed",
    );
  } else if (anyDetected) {
    await db
      .update(mintRequestsTable)
      .set({ status: "payment_detected" })
      .where(
        sql`${mintRequestsTable.id} = ${requestId} AND ${mintRequestsTable.status} = 'pending'`,
      );
    logger.info({ requestId, address, confirmations: minConfsSeen }, "Payment detected, awaiting confirmations");
  }
}

export async function pollDepositsOnce(): Promise<void> {
  if (operationMode !== "active") return;
  const pending = await db
    .select({
      id: mintRequestsTable.id,
      btcAddress: mintRequestsTable.btcAddress,
      createdAt: mintRequestsTable.createdAt,
      baselineTipHeight: mintRequestsTable.baselineTipHeight,
      excludedTxids: mintRequestsTable.excludedTxids,
    })
    .from(mintRequestsTable)
    .where(inArray(mintRequestsTable.status, ["pending", "payment_detected"]));

  if (pending.length === 0) {
    return;
  }

  const [config, tipHeight] = await Promise.all([getOrCreateAdminConfig(), getTipHeight()]);

  for (const request of pending) {
    try {
      await checkAddress(
        request.id,
        request.btcAddress,
        {
          createdAt: request.createdAt,
          baselineTipHeight: request.baselineTipHeight,
          excludedTxids: Array.isArray(request.excludedTxids)
            ? (request.excludedTxids as string[])
            : [],
        },
        tipHeight,
        config.minConfirmations,
      );
    } catch (err) {
      logger.warn({ err, requestId: request.id }, "Deposit check failed; will retry");
    }
  }
}

let watcherRunning = false;
let watcherTimer: ReturnType<typeof setInterval> | undefined;
let watcherCycle: Promise<void> | undefined;

export function startDepositWatcher(): void {
  if (operationMode !== "active" || watcherTimer) return;
  logger.info({ apiBase: MEMPOOL_API_BASE, intervalMs: POLL_INTERVAL_MS }, "Deposit watcher started");
  watcherTimer = setInterval(() => {
    if (watcherRunning) {
      return; // previous poll still in flight
    }
    watcherRunning = true;
    watcherCycle = pollDepositsOnce()
      .catch((err) => { logger.warn({ err }, "Deposit poll cycle failed"); })
      .finally(() => { watcherRunning = false; });
  }, POLL_INTERVAL_MS);
}

export async function stopDepositWatcher(): Promise<void> {
  clearInterval(watcherTimer);
  watcherTimer = undefined;
  await watcherCycle;
}

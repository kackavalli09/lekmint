import { db, btcAddressesTable } from "@workspace/db";
import { logger } from "./logger";

/**
 * Live on-chain treasury balance: the sum of the CURRENT (unspent) balance of
 * every deposit address ever derived from the operator xpub, read from the
 * same mempool.space REST API the deposit watcher uses.
 *
 * balance(address) = chain funded − chain spent + mempool funded − mempool spent
 *
 * Results are cached in memory for a short TTL so the admin overview can poll
 * without hammering the API; the snapshot carries its fetch timestamp so the
 * dashboard can show freshness.
 */

const MEMPOOL_API_BASE = process.env.MEMPOOL_API_BASE ?? "https://mempool.space/api";
const CACHE_TTL_MS = 60_000;
// A snapshot older than this is served (better than nothing) but flagged
// stale — the solvency audit must not report a green verdict from it.
const STALE_AFTER_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT = 5;

interface AddressStats {
  chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
  mempool_stats: { funded_txo_sum: number; spent_txo_sum: number };
}

export interface TreasurySnapshot {
  balanceSats: number;
  addressCount: number;
  fetchedAt: Date;
  /** True when this reading is older than the freshness window. */
  stale: boolean;
}

let cache: TreasurySnapshot | null = null;
let inFlight: Promise<TreasurySnapshot> | null = null;

async function fetchAddressBalance(address: string): Promise<number> {
  const res = await fetch(`${MEMPOOL_API_BASE}/address/${address}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`mempool.space /address/${address} -> HTTP ${res.status}`);
  }
  const stats = (await res.json()) as AddressStats;
  return (
    stats.chain_stats.funded_txo_sum -
    stats.chain_stats.spent_txo_sum +
    stats.mempool_stats.funded_txo_sum -
    stats.mempool_stats.spent_txo_sum
  );
}

async function readTreasury(): Promise<TreasurySnapshot> {
  const rows = await db.select({ address: btcAddressesTable.address }).from(btcAddressesTable);
  const addresses = rows.map((r) => r.address);
  let total = 0;
  // Small concurrency window: friendly to the public API, fast enough for
  // the address counts a single mint accumulates.
  for (let i = 0; i < addresses.length; i += MAX_CONCURRENT) {
    const batch = addresses.slice(i, i + MAX_CONCURRENT);
    const balances = await Promise.all(batch.map(fetchAddressBalance));
    total += balances.reduce((a, b) => a + b, 0);
  }
  return { balanceSats: total, addressCount: addresses.length, fetchedAt: new Date(), stale: false };
}

function withStaleness(snap: TreasurySnapshot | null): TreasurySnapshot | null {
  if (!snap) return null;
  return { ...snap, stale: Date.now() - snap.fetchedAt.getTime() > STALE_AFTER_MS };
}

/**
 * Cached live treasury read. Returns null when the balance cannot be
 * determined right now (API unreachable) and no cached snapshot exists —
 * callers must surface "unavailable", never fake a zero balance.
 */
export async function getTreasurySnapshot(): Promise<TreasurySnapshot | null> {
  if (cache && Date.now() - cache.fetchedAt.getTime() < CACHE_TTL_MS) {
    return cache;
  }
  if (!inFlight) {
    inFlight = readTreasury()
      .then((snap) => {
        cache = snap;
        return snap;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  try {
    return withStaleness(await inFlight);
  } catch (err) {
    logger.warn({ err }, "Live treasury balance read failed");
    // Possibly stale, possibly null — staleness is flagged so callers never
    // pass off an old reading as a fresh audit result.
    return withStaleness(cache);
  }
}

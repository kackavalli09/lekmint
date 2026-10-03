/**
 * BTC network transfer fee estimate, DEDUCTED from melt payouts on top of
 * the melt fee (net = gross − melt fee − network fee).
 *
 * Source: mempool.space's recommended fees endpoint, cached briefly so the
 * public /melt/quote route never hammers (or leaks client IPs to) a third
 * party. When the live source is unavailable, a deterministic fallback rate
 * (FALLBACK_SAT_PER_VB) is used and labeled as such, so quotes and the
 * payout queue always have a concrete figure to deduct.
 */

const MEMPOOL_FEES_URL = "https://mempool.space/api/v1/fees/recommended";
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 3_000;

/**
 * Assumed virtual size (vB) of one payout's share of a batched settlement
 * transaction: one P2WPKH-ish output (~31 vB) plus an amortized share of the
 * batch's input and overhead. A deliberate round, conservative figure — the
 * UI labels it an estimate.
 */
export const TYPICAL_PAYOUT_VSIZE_VB = 140;

export interface LiveNetworkFee {
  satPerVb: number;
  estimatedSats: number;
  fetchedAt: string;
}

/** Reject absurd upstream fee rates (a bad feed must not gut payouts). */
const MAX_SANE_SAT_PER_VB = 5_000;

/** Deterministic rate used when the live source is down (conservative but sane). */
export const FALLBACK_SAT_PER_VB = 10;

let cache: { value: LiveNetworkFee | null; expiresAt: number } = {
  value: null,
  expiresAt: 0,
};
/** In-flight fetch, shared so concurrent cache-expiry callers coalesce into one request. */
let inflight: Promise<LiveNetworkFee | null> | null = null;

async function fetchRecommendedFee(): Promise<LiveNetworkFee | null> {
  try {
    const res = await fetch(MEMPOOL_FEES_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { halfHourFee?: unknown };
    const satPerVb = body.halfHourFee;
    if (
      typeof satPerVb !== "number" ||
      !Number.isFinite(satPerVb) ||
      satPerVb <= 0 ||
      satPerVb > MAX_SANE_SAT_PER_VB
    ) {
      return null;
    }
    return {
      satPerVb,
      estimatedSats: Math.ceil(satPerVb * TYPICAL_PAYOUT_VSIZE_VB),
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Cached live fee estimate; returns null when mempool.space is unreachable
 * or returns garbage (callers must then present the schedule-based figure).
 * Failures are cached for the same TTL so an outage cannot turn every quote
 * request into a slow third-party timeout.
 */
export async function getLiveNetworkFee(): Promise<LiveNetworkFee | null> {
  if (Date.now() < cache.expiresAt) return cache.value;
  if (!inflight) {
    inflight = fetchRecommendedFee()
      .then((value) => {
        cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export interface NetworkFeeEstimate {
  source: "live" | "fallback";
  satPerVb: number;
  estimatedSats: number;
}

/**
 * The network transfer fee figure to deduct from a melt payout. Always
 * returns a concrete value: live rate when available, FALLBACK_SAT_PER_VB
 * otherwise.
 */
export async function getNetworkFeeEstimate(): Promise<NetworkFeeEstimate> {
  const live = await getLiveNetworkFee();
  if (live) {
    return { source: "live", satPerVb: live.satPerVb, estimatedSats: live.estimatedSats };
  }
  return {
    source: "fallback",
    satPerVb: FALLBACK_SAT_PER_VB,
    estimatedSats: FALLBACK_SAT_PER_VB * TYPICAL_PAYOUT_VSIZE_VB,
  };
}

/** Test hook: clear the cache. */
export function clearNetworkFeeCache(): void {
  cache = { value: null, expiresAt: 0 };
  inflight = null;
}

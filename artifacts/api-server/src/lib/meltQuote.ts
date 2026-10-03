import type { FeeConfig } from "@workspace/db";
import { parseDecimalScaled, RATE_SCALE } from "./epochEngine";
import { calculateFee, getMeltFeeParams } from "./mintConfig";

/**
 * THE single lek -> BTC conversion formula for melts.
 *
 * Both the public melt estimate (GET /melt/quote) and the operator payout
 * queue (GET /admin/payouts) MUST go through this module so the number a
 * user sees when melting and the number the operator pays out can never be
 * computed two different ways.
 *
 * Formula: grossSats = floor(amountLeks / R_current), exact bigint at 1e12
 * precision (same scaling as convertValueMulti). Dividing by the current
 * epoch rate index is the only redemption rate that keeps the mint solvent:
 * upgrades multiply lek face value by R_current / R_vintage, so a vintage
 * deposit of N sats never redeems for more than N sats.
 *
 * Two separate deductions are then applied:
 *   1. The melt fee from the mint's fee schedule (calculateFee).
 *   2. The BTC network transfer fee (passed in by the caller — live
 *      mempool.space figure when available, deterministic fallback
 *      otherwise; see networkFee.ts).
 * net = max(0, gross − melt fee − network fee). Rate index, fee schedule,
 * and network conditions all float until the operator actually prepares a
 * payout batch, which is why every consumer of this value must label it an
 * estimate until settlement.
 */

const RATE_SCALE_N = 10n ** BigInt(RATE_SCALE);

export interface MeltQuote {
  amountLeks: number;
  rateIndex: string;
  estimatedGrossSats: number;
  estimatedFeeSats: number;
  estimatedNetworkFeeSats: number;
  estimatedNetSats: number;
}

/** floor(amountLeks / rateIndex) in sats, exact bigint arithmetic. */
export function meltLeksToGrossSats(amountLeks: number, rateIndex: string): number {
  const rate = parseDecimalScaled(rateIndex, RATE_SCALE);
  if (rate <= 0n) {
    throw new Error("Invalid epoch rate index");
  }
  return Number((BigInt(amountLeks) * RATE_SCALE_N) / rate);
}

export function computeMeltQuote(
  amountLeks: number,
  rateIndex: string,
  feeConfig: FeeConfig,
  networkFeeSats: number,
): MeltQuote {
  if (!Number.isSafeInteger(networkFeeSats) || networkFeeSats < 0) {
    throw new Error(`Invalid network fee: ${networkFeeSats}`);
  }
  const estimatedGrossSats = meltLeksToGrossSats(amountLeks, rateIndex);
  // Melt-specific fee schedule (falls back to mint fees when unconfigured).
  const estimatedFeeSats = calculateFee(estimatedGrossSats, getMeltFeeParams(feeConfig));
  return {
    amountLeks,
    rateIndex,
    estimatedGrossSats,
    estimatedFeeSats,
    estimatedNetworkFeeSats: networkFeeSats,
    // Clamped at 0: a tiny melt can be fully consumed by fees, but the mint
    // never asks the user to top up a payout.
    estimatedNetSats: Math.max(0, estimatedGrossSats - estimatedFeeSats - networkFeeSats),
  };
}

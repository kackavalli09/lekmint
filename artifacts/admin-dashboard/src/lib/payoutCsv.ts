/**
 * Payout batch CSV builders.
 *
 * `buildTrezorCsv` produces the file Trezor Suite's send-form "Import CSV"
 * accepts directly: header `address,amount,currency`, comma-delimited, with
 * the amount in BTC decimal notation (8 places) and currency `BTC` — this
 * matches Trezor Suite's parseCSV(['address','amount','currency','label'])
 * exactly. Rows without a computable sats estimate are EXCLUDED (returned in
 * `skipped`) rather than emitted with a blank amount that would break or
 * silently zero the import.
 *
 * `buildDetailedCsv` keeps the old bookkeeping columns (lek amounts + sats)
 * in a separate file so they never pollute the Trezor import.
 */

export interface PayoutCsvRow {
  btcAddress: string;
  amountLeks: number;
  estimatedBtcSats: number | null;
}

export const SATS_PER_BTC = 100_000_000;

/** 12345 sats -> "0.00012345" (8 decimal places, exact integer math). */
export function satsToBtcString(sats: number): string {
  if (!Number.isSafeInteger(sats) || sats < 0) {
    throw new Error(`Invalid sats amount: ${sats}`);
  }
  const whole = Math.floor(sats / SATS_PER_BTC);
  const frac = (sats % SATS_PER_BTC).toString().padStart(8, "0");
  return `${whole}.${frac}`;
}

export interface TrezorCsvResult {
  csv: string;
  included: number;
  skipped: PayoutCsvRow[];
}

export function buildTrezorCsv(rows: PayoutCsvRow[]): TrezorCsvResult {
  const payable = rows.filter(
    (r): r is PayoutCsvRow & { estimatedBtcSats: number } =>
      r.estimatedBtcSats !== null && r.estimatedBtcSats > 0,
  );
  const skipped = rows.filter((r) => r.estimatedBtcSats === null || r.estimatedBtcSats <= 0);
  const csv = [
    "address,amount,currency",
    ...payable.map((r) => `${r.btcAddress},${satsToBtcString(r.estimatedBtcSats)},BTC`),
  ].join("\n");
  return { csv, included: payable.length, skipped };
}

export function buildDetailedCsv(rows: PayoutCsvRow[]): string {
  return [
    "address,amount_leks,amount_sats_estimate",
    ...rows.map((r) => `${r.btcAddress},${r.amountLeks},${r.estimatedBtcSats ?? ""}`),
  ].join("\n");
}

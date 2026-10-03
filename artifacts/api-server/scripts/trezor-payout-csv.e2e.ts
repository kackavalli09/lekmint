/**
 * Consistency check for the Trezor payout CSV and the melt fee chain.
 *
 * Verifies, against the RUNNING api-server:
 *  1. GET /melt/quote returns net = max(0, gross − melt fee − network fee):
 *     both fees are separate deductions from the user's amount, with the
 *     network fee sourced live (or from a deterministic fallback rate).
 *  2. GET /admin/payouts recomputes pending estimates with the exact same
 *     formula (shared meltQuote module) — quote.estimatedNetSats for a row's
 *     lek amount equals the row's estimatedBtcSats.
 *  3. The Trezor CSV built by the ADMIN DASHBOARD'S REAL builder
 *     (buildTrezorCsv) round-trips through a parser equivalent to Trezor
 *     Suite's parseCSV: header address,amount,currency; amounts in BTC at
 *     8 decimals equal to estimatedBtcSats/1e8; no blank amounts; rows
 *     without estimates skipped.
 *
 * Read-only: no state is created or mutated (uses whatever pending payouts
 * exist; falls back to pure-math checks when the queue is empty).
 */
import {
  buildTrezorCsv,
  buildDetailedCsv,
  satsToBtcString,
} from "../../admin-dashboard/src/lib/payoutCsv";

const BASE = process.env["API_BASE"] ?? "http://127.0.0.1:80/api";
const ADMIN_KEY = process.env["ADMIN_API_KEY"];

let failures = 0;
function assert(cond: boolean, label: string, detail?: unknown) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}`, detail ?? "");
  }
}

/** Equivalent of Trezor Suite's parseCSV(input, ['address','amount','currency','label']). */
function trezorParseCsv(text: string): { address?: string; amount?: string; currency?: string }[] {
  const columns = ["address", "amount", "currency", "label"];
  return text
    .split("\n")
    .filter((l) => l.length)
    .map((line) => {
      const out: Record<string, string> = {};
      line.split(",").forEach((value, i) => {
        const clean = value.replace(/^"|"$/g, "").trim();
        const key = columns[i];
        if (key && !columns.includes(clean.toLowerCase())) out[key] = clean;
      });
      return out;
    })
    .filter((o) => Object.keys(o).length > 0);
}

async function main() {
  // --- 1. Melt quote fee semantics --------------------------------------
  const amounts = [1, 96, 12345];
  for (const amountLeks of amounts) {
    const res = await fetch(`${BASE}/melt/quote?amountLeks=${amountLeks}`);
    assert(res.status === 200, `GET /melt/quote?amountLeks=${amountLeks} -> 200`, res.status);
    const q = await res.json();
    assert(
      q.estimatedNetSats ===
        Math.max(0, q.estimatedGrossSats - q.estimatedFeeSats - q.estimatedNetworkFeeSats),
      `net = max(0, gross − melt fee − network fee) for ${amountLeks} leks (${q.estimatedGrossSats} − ${q.estimatedFeeSats} − ${q.estimatedNetworkFeeSats} = ${q.estimatedNetSats})`,
    );
    assert(q.estimatedNetSats <= q.estimatedGrossSats, "fees are subtracted, never added on top");
    assert(q.estimatedNetSats >= 0, "net never goes negative");
    assert(
      q.networkFee && ["live", "fallback"].includes(q.networkFee.source) &&
        Number.isSafeInteger(q.networkFee.estimatedSats) && q.networkFee.estimatedSats >= 0 &&
        q.networkFee.estimatedSats === q.estimatedNetworkFeeSats,
      `networkFee info present and matches the deduction (source=${q.networkFee?.source}, ${q.networkFee?.estimatedSats} sats)`,
    );
    assert(
      typeof q.networkFee?.satPerVb === "number" && q.networkFee.satPerVb > 0,
      `networkFee carries a sat/vB rate (${q.networkFee?.satPerVb}, ${q.networkFee?.source})`,
    );
  }

  // --- 2. Payout queue uses the same formula ----------------------------
  if (!ADMIN_KEY) throw new Error("ADMIN_API_KEY not set in env");
  const payoutsRes = await fetch(`${BASE}/admin/payouts?status=pending&limit=50`, {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  assert(payoutsRes.status === 200, "GET /admin/payouts -> 200", payoutsRes.status);
  const payouts = await payoutsRes.json();
  const rows: { btcAddress: string; amountLeks: number; estimatedBtcSats: number | null }[] =
    payouts.entries ?? [];
  console.log(`  (queue has ${rows.length} pending rows)`);
  for (const row of rows.slice(0, 10)) {
    const q = await (await fetch(`${BASE}/melt/quote?amountLeks=${row.amountLeks}`)).json();
    assert(
      row.estimatedBtcSats === q.estimatedNetSats,
      `payout row (${row.amountLeks} leks) matches /melt/quote net (${row.estimatedBtcSats} == ${q.estimatedNetSats})`,
    );
  }

  // --- 3. Trezor CSV round-trip ------------------------------------------
  // Use real queue rows when available, plus synthetic edge cases.
  const sample = [
    ...rows,
    { btcAddress: "bc1qexampleaddr0000000000000000000000synth", amountLeks: 10, estimatedBtcSats: 123456789 },
    { btcAddress: "bc1qskipme00000000000000000000000000000000", amountLeks: 5, estimatedBtcSats: null },
  ];
  const { csv, included, skipped } = buildTrezorCsv(sample);
  const lines = csv.split("\n");
  assert(lines[0] === "address,amount,currency", "header is address,amount,currency", lines[0]);
  assert(skipped.length >= 1 && skipped.every((r) => r.estimatedBtcSats === null || r.estimatedBtcSats <= 0),
    "rows without estimates are skipped, not emitted blank");
  assert(included === lines.length - 1, "every included row emitted exactly once");
  assert(!csv.includes(",,") && !csv.split("\n").some((l) => l.endsWith(",")),
    "no blank cells anywhere in the Trezor file");

  const parsed = trezorParseCsv(csv);
  assert(parsed.length === included, `Trezor-style parser sees ${included} recipients (header skipped)`);
  const payable = sample.filter((r) => r.estimatedBtcSats !== null && r.estimatedBtcSats > 0);
  parsed.forEach((p, i) => {
    const src = payable[i]!;
    const expected = satsToBtcString(src.estimatedBtcSats!);
    assert(
      p.address === src.btcAddress && p.amount === expected && p.currency === "BTC",
      `row ${i}: ${p.address} ${p.amount} BTC == ${src.btcAddress} ${expected}`,
    );
    assert(/^\d+\.\d{8}$/.test(p.amount ?? ""), `row ${i}: amount has exactly 8 decimals (${p.amount})`);
    assert(
      Math.round(Number(p.amount) * 1e8) === src.estimatedBtcSats,
      `row ${i}: BTC amount equals estimated sats / 1e8`,
    );
  });

  // Known answers for the sats -> BTC conversion.
  assert(satsToBtcString(0) === "0.00000000", "0 sats -> 0.00000000");
  assert(satsToBtcString(1) === "0.00000001", "1 sat -> 0.00000001");
  assert(satsToBtcString(100_000_000) === "1.00000000", "1e8 sats -> 1.00000000");
  assert(satsToBtcString(123456789) === "1.23456789", "123456789 sats -> 1.23456789");
  assert(satsToBtcString(95) === "0.00000095", "95 sats -> 0.00000095");

  // Detailed CSV keeps the bookkeeping columns.
  const detailed = buildDetailedCsv(sample);
  assert(detailed.startsWith("address,amount_leks,amount_sats_estimate"), "detailed CSV keeps bookkeeping header");
  assert(detailed.split("\n").length === sample.length + 1, "detailed CSV includes every row (even skipped)");

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll assertions passed — Trezor CSV and melt fee chain are consistent.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

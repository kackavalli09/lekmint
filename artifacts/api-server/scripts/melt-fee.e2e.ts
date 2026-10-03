/**
 * E2E: melt fees are an independent component from mint fees.
 *
 * Against the running dev API:
 *  1. Sets distinct mint vs melt fee params via PUT /admin/fee-config
 *     (partial updates: melt-only PUT must not touch mint fields).
 *  2. GET /melt/quote applies the MELT fee schedule, not the mint one.
 *  3. Melt threshold: quotes below the melt threshold pay 0 fee.
 *  4. Fallback: with melt fields never configured (NULLed in DB), the quote
 *     falls back to the mint fee values.
 *  5. Restores the original fee config.
 *
 * Run: scripts/node_modules/.bin/tsx artifacts/api-server/scripts/melt-fee.e2e.ts
 */
import { db, pool, feeConfigTable } from "@workspace/db";
import { asc } from "drizzle-orm";
import { eq } from "drizzle-orm";

const API = "http://127.0.0.1:80/api";
const ADMIN_KEY = process.env.ADMIN_API_KEY;
if (!ADMIN_KEY) throw new Error("ADMIN_API_KEY not set");

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${API}${path}`, init);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}
const adminHeaders = {
  Authorization: `Bearer ${ADMIN_KEY}`,
  "Content-Type": "application/json",
};

async function main() {
  const [orig] = await db.select().from(feeConfigTable).orderBy(asc(feeConfigTable.id)).limit(1);
  if (!orig) throw new Error("No fee_config row; hit the API once first");

  try {
    // Mint: fixed 100 + 50 bps; Melt: fixed 7 + 200 bps, threshold 1000.
    await api("/admin/fee-config", {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ fixedFeeSats: 100, percentageFeeBps: 50, minThresholdSats: 0 }),
    });
    const cfg = await api("/admin/fee-config", {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({
        meltFixedFeeSats: 7,
        meltPercentageFeeBps: 200,
        meltMinThresholdSats: 1000,
      }),
    });
    check(
      "melt-only PUT leaves mint fees untouched",
      cfg.fixedFeeSats === 100 && cfg.percentageFeeBps === 50 && cfg.minThresholdSats === 0,
      JSON.stringify(cfg),
    );
    check(
      "response reports melt fee params",
      cfg.meltFixedFeeSats === 7 && cfg.meltPercentageFeeBps === 200 && cfg.meltMinThresholdSats === 1000,
      JSON.stringify(cfg),
    );

    // Quote 100_000 leks. Rate index is whatever the current epoch says; the
    // fee must equal the MELT formula applied to the returned gross.
    const q = await api("/melt/quote?amountLeks=100000");
    const gross = q.estimatedGrossSats as number;
    const expectedMeltFee = gross < 1000 ? 0 : Math.min(7 + Math.round((gross * 200) / 10_000), gross);
    const mintFeeWouldBe = Math.min(100 + Math.round((gross * 50) / 10_000), gross);
    check(
      "quote applies MELT fee formula",
      q.estimatedFeeSats === expectedMeltFee && q.estimatedNetSats === gross - expectedMeltFee,
      `fee=${q.estimatedFeeSats} expected=${expectedMeltFee}`,
    );
    check(
      "melt fee differs from what the mint fee would have been",
      expectedMeltFee !== mintFeeWouldBe,
      `melt=${expectedMeltFee} mint=${mintFeeWouldBe}`,
    );

    // Threshold: a tiny quote whose gross is under 1000 sats pays no fee.
    const qSmall = await api("/melt/quote?amountLeks=10");
    check(
      "below melt threshold pays 0 fee",
      qSmall.estimatedGrossSats < 1000 && qSmall.estimatedFeeSats === 0,
      `gross=${qSmall.estimatedGrossSats} fee=${qSmall.estimatedFeeSats}`,
    );

    // Reset via API: explicit nulls restore "inherit mint fees".
    const cfgReset = await api("/admin/fee-config", {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({
        meltFixedFeeSats: null,
        meltPercentageFeeBps: null,
        meltMinThresholdSats: null,
      }),
    });
    check(
      "PUT nulls resets melt to inherit mint fees (meltConfigured=false)",
      cfgReset.meltConfigured === false,
      JSON.stringify(cfgReset),
    );
    const qFallback = await api("/melt/quote?amountLeks=100000");
    const grossFb = qFallback.estimatedGrossSats as number;
    const expectedFb = Math.min(100 + Math.round((grossFb * 50) / 10_000), grossFb);
    check(
      "unconfigured melt fees fall back to mint fees",
      qFallback.estimatedFeeSats === expectedFb,
      `fee=${qFallback.estimatedFeeSats} expected=${expectedFb}`,
    );
    const cfgFb = await api("/admin/fee-config", { headers: adminHeaders });
    check(
      "GET reports effective (fallback) melt values",
      cfgFb.meltFixedFeeSats === 100 && cfgFb.meltPercentageFeeBps === 50 && cfgFb.meltMinThresholdSats === 0,
      JSON.stringify(cfgFb),
    );

    // After reset, melt fees TRACK mint fee changes again.
    await api("/admin/fee-config", {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ fixedFeeSats: 33, percentageFeeBps: 10 }),
    });
    const qTrack = await api("/melt/quote?amountLeks=100000");
    const grossTrack = qTrack.estimatedGrossSats as number;
    const expectedTrack = Math.min(33 + Math.round((grossTrack * 10) / 10_000), grossTrack);
    check(
      "inherited melt fees track subsequent mint fee changes",
      qTrack.estimatedFeeSats === expectedTrack,
      `fee=${qTrack.estimatedFeeSats} expected=${expectedTrack}`,
    );
  } finally {
    await db
      .update(feeConfigTable)
      .set({
        fixedFeeSats: orig.fixedFeeSats,
        percentageFeeBps: orig.percentageFeeBps,
        minThresholdSats: orig.minThresholdSats,
        meltFixedFeeSats: orig.meltFixedFeeSats,
        meltPercentageFeeBps: orig.meltPercentageFeeBps,
        meltMinThresholdSats: orig.meltMinThresholdSats,
      })
      .where(eq(feeConfigTable.id, orig.id));
    await pool.end();
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * E2E test for the standard Cashu protocol layer (/api/v1) used by external
 * wallets like cashu.me. Simulates a wallet using the REAL client wallet lib:
 *
 *   1. Verify NUT-06 identity and `lek` unit metadata.
 *   2. Fund synthetically (confirmed mint request, 4 leks) and issue proofs.
 *   3. NUT-03 balanced swap via /v1/swap (as an external wallet receiving a
 *      token does) — assert signatures unblind to valid proofs.
 *   4. NUT-07 checkstate: swapped-away inputs report SPENT, fresh proofs
 *      report UNSPENT.
 *   5. Replay the swap -> NUT error "already spent" (code 11001).
 *   6. Imbalanced swap -> rejected (11002), nothing spent.
 *   7. Cleanup: redeem all remaining proofs (net supply back to zero) and
 *      delete the synthetic mint request row, even on failure.
 *
 * Run: scripts/node_modules/.bin/tsx artifacts/api-server/scripts/cashu-v1-compat.e2e.ts
 */
import { db, mintRequestsTable, pool } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  createBlindedOutputs,
  unblindSignatures,
  sumProofs,
} from "../../lek-mint/src/lib/wallet";
import { hashToCurveFromSecretString } from "../src/lib/cashuCrypto";
import type { Proof } from "@workspace/api-client-react";

const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:80/api";
const EXPECTED_ICON_URL = "https://lekmint.cash/api/v1/icon-352e7e44.png";
const PAYOUT_ADDRESS = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const FUND_AMOUNT = 4;

function assert(cond: boolean, label: string, detail?: unknown): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${label} ${detail !== undefined ? JSON.stringify(detail) : ""}`);
  console.log(`  PASS  ${label}`);
}

async function api(path: string, body?: unknown, origin?: string) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const yOf = (p: Proof) => hashToCurveFromSecretString(p.secret).toHex(true);

let outstanding: Proof[] = [];

async function main(): Promise<void> {
  const [request] = await db
    .insert(mintRequestsTable)
    .values({
      btcAddress: `synthetic-e2e-cashuv1-${Date.now()}`,
      status: "confirmed",
      grossAmountSats: FUND_AMOUNT,
      feeSats: 0,
      netAmountSats: FUND_AMOUNT,
    })
    .returning();
  if (!request) throw new Error("failed to insert synthetic request");

  try {
    const infoRes = await api("/v1/info", undefined, "https://wallet.cashu.me");
    assert(infoRes.status === 200, "GET /v1/info works cross-origin");
    assert(infoRes.json.name === "Lek Mint", "NUT-06 reports the mint name", infoRes.json);
    assert(infoRes.json.icon_url === EXPECTED_ICON_URL, "NUT-06 reports the stable production icon URL", infoRes.json);

    // This stateful E2E must only run against development/test infrastructure.
    // Production identity is checked by the read-only cashu-identity-smoke.mjs.
    const iconRes = await fetch(`${API_BASE}/v1/icon-352e7e44.png`);
    assert(iconRes.status === 200, "wallet icon is publicly reachable");
    assert(iconRes.headers.get("content-type") === "image/png", "wallet icon is served as PNG");
    assert(
      iconRes.headers.get("cache-control") === "public, max-age=31536000, immutable",
      "wallet icon is publicly cacheable for one year",
    );
    assert((await iconRes.arrayBuffer()).byteLength <= 16_384, "wallet icon is lightweight (16 KiB or less)");

    const keysRes = await api("/v1/keys", undefined, "https://wallet.cashu.me");
    assert(keysRes.status === 200, "GET /v1/keys works cross-origin");
    assert(
      keysRes.json.keysets.every((keyset: { unit?: unknown }) => keyset.unit === "lek"),
      "all /v1/keys entries report unit lek",
      keysRes.json,
    );
    const { id: keysetId, keys } = keysRes.json.keysets[0];

    const keysetsRes = await api("/v1/keysets", undefined, "https://wallet.cashu.me");
    assert(keysetsRes.status === 200, "GET /v1/keysets works cross-origin");
    assert(
      keysetsRes.json.keysets.every((keyset: { unit?: unknown }) => keyset.unit === "lek"),
      "all /v1/keysets entries report unit lek",
      keysetsRes.json,
    );

    const issue = createBlindedOutputs(FUND_AMOUNT, keysetId);
    const issueRes = await api("/mint/issue", { requestId: request.id, outputs: issue.outputs });
    if (issueRes.status !== 200) throw new Error(`issue failed: ${JSON.stringify(issueRes.json)}`);
    assert(issueRes.json.unit === "lek", "issued-token response reports unit lek", issueRes.json);
    const wallet = unblindSignatures(issueRes.json.signatures, issue.blindings, keys);
    outstanding = [...wallet];
    console.log(`Issued: [${wallet.map((p) => p.amount).join(", ")}]`);

    // --- NUT-03 balanced swap (external wallet receiving a token) ----------
    const fresh = createBlindedOutputs(FUND_AMOUNT, keysetId);
    const swapRes = await api("/v1/swap", { inputs: wallet, outputs: fresh.outputs }, "https://wallet.cashu.me");
    assert(swapRes.status === 200, "balanced /v1/swap accepted", swapRes.json);
    const newProofs = unblindSignatures(swapRes.json.signatures, fresh.blindings, keys);
    outstanding = [...newProofs];
    assert(sumProofs(newProofs) === FUND_AMOUNT, "swapped proofs unblind and DLEQ-verify to full amount");

    // --- NUT-07 checkstate ---------------------------------------------------
    const stateRes = await api("/v1/checkstate", { Ys: [yOf(wallet[0]!), yOf(newProofs[0]!)] });
    assert(stateRes.status === 200, "checkstate responds");
    assert(stateRes.json.states[0].state === "SPENT", "swapped-away input reports SPENT", stateRes.json);
    assert(stateRes.json.states[1].state === "UNSPENT", "fresh proof reports UNSPENT", stateRes.json);

    // --- Replay protection across the protocol layer -------------------------
    const replay = await api("/v1/swap", { inputs: wallet, outputs: createBlindedOutputs(FUND_AMOUNT, keysetId).outputs });
    assert(replay.status === 400 && replay.json.code === 11001, "replayed swap rejected with 'already spent'", replay.json);

    // --- Imbalanced swap refused ---------------------------------------------
    const short = createBlindedOutputs(FUND_AMOUNT - 1, keysetId);
    const imbal = await api("/v1/swap", { inputs: newProofs, outputs: short.outputs });
    assert(imbal.status === 400 && imbal.json.code === 11002, "imbalanced swap rejected (11002)", imbal.json);
    const stillUnspent = await api("/v1/checkstate", { Ys: [yOf(newProofs[0]!)] });
    assert(stillUnspent.json.states[0].state === "UNSPENT", "inputs untouched after rejected swap");
  } finally {
    if (outstanding.length > 0) {
      const burn = await api("/redeem", { proofs: outstanding, btcAddress: PAYOUT_ADDRESS });
      console.log(
        burn.status === 200
          ? `Cleanup: burned ${burn.json.redeemedAmount} leks (net supply restored)`
          : `Cleanup WARNING: redeem failed ${burn.status} ${JSON.stringify(burn.json)}`,
      );
    }
    await db.delete(mintRequestsTable).where(eq(mintRequestsTable.id, request.id));
    console.log("Synthetic mint request deleted");
  }
}

main()
  .then(async () => {
    await pool.end();
    console.log("\nAll assertions passed — Cashu v1 protocol layer works.");
  })
  .catch(async (err) => {
    console.error("\nTEST FAILED:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });

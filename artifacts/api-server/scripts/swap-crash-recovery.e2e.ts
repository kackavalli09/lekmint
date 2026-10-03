/**
 * E2E crash-recovery test: a browser crash after the mint signs a swap but
 * before the wallet stores the signatures must NOT lose funds.
 *
 * Simulates the crash by performing a swap over HTTP and "forgetting" the
 * response — keeping only the persisted blindings (what the wallet's
 * IndexedDB `blindings` store would still hold). Recovery then replays the
 * blinded messages (B_) against the new idempotent POST /swap/recover
 * endpoint, unblinds the redelivered signatures with the REAL wallet helper
 * (unblindSignatures, including DLEQ verification), and proves the recovered
 * proofs are spendable for the full original value.
 *
 * Also asserts:
 *   - /swap/recover is idempotent (second call returns identical signatures)
 *   - unknown B_ values come back null (operation never committed)
 *
 * Run: scripts/node_modules/.bin/tsx artifacts/api-server/scripts/swap-crash-recovery.e2e.ts
 */
import { db, mintRequestsTable, pool } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  createBlindedOutputs,
  unblindSignatures,
  sumProofs,
} from "../../lek-mint/src/lib/wallet";
import type { Proof } from "@workspace/api-client-react";

const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:80/api";
const PAYOUT_ADDRESS = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const SYNTHETIC_MARKER = `synthetic-e2e-swap-recovery-${Date.now()}`;
const FUND_AMOUNT = 100; // -> proofs [64, 32, 4]

function assert(cond: boolean, label: string, detail?: unknown): void {
  if (!cond) {
    throw new Error(
      `ASSERTION FAILED: ${label} ${detail !== undefined ? JSON.stringify(detail) : ""}`,
    );
  }
  console.log(`  PASS  ${label}`);
}

async function api(path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

let outstanding: Proof[] = [];
const track = (proofs: Proof[]) => outstanding.push(...proofs);
const untrack = (proofs: Proof[]) => {
  const gone = new Set(proofs.map((p) => p.secret));
  outstanding = outstanding.filter((p) => !gone.has(p.secret));
};

async function bestEffortCleanupProofs(): Promise<void> {
  if (outstanding.length === 0) return;
  const res = await api("/redeem", { proofs: outstanding, btcAddress: PAYOUT_ADDRESS });
  if (res.status === 200) {
    console.log(`Cleanup: burned ${res.json.redeemedAmount} outstanding synthetic leks`);
    outstanding = [];
  } else {
    console.error(
      `Cleanup WARNING: could not burn ${sumProofs(outstanding)} outstanding leks (HTTP ${res.status})`,
      res.json,
    );
  }
}

async function main(): Promise<void> {
  // --- 1. Synthetic funding: confirmed deposit -> issue real proofs --------
  const [request] = await db
    .insert(mintRequestsTable)
    .values({
      btcAddress: SYNTHETIC_MARKER,
      status: "confirmed",
      grossAmountSats: FUND_AMOUNT,
      feeSats: 0,
      netAmountSats: FUND_AMOUNT,
    })
    .returning();
  if (!request) throw new Error("Failed to insert synthetic mint request");
  console.log(`Synthetic confirmed deposit inserted (request ${request.id})`);

  try {
    const keysRes = await api("/keys");
    if (keysRes.status !== 200) throw new Error(`GET /keys -> ${keysRes.status}`);
    const { keysetId, keys } = keysRes.json as { keysetId: string; keys: Record<string, string> };

    const issueOutputs = createBlindedOutputs(FUND_AMOUNT, keysetId);
    const issueRes = await api("/mint/issue", {
      requestId: request.id,
      outputs: issueOutputs.outputs,
    });
    if (issueRes.status !== 200) {
      throw new Error(`POST /mint/issue -> ${issueRes.status}: ${JSON.stringify(issueRes.json)}`);
    }
    const wallet = unblindSignatures(issueRes.json.signatures, issueOutputs.blindings, keys);
    track(wallet);
    assert(sumProofs(wallet) === FUND_AMOUNT, `issued proofs total ${FUND_AMOUNT}`);

    // --- 2. Swap ALL proofs, then "crash": forget the response --------------
    // What survives the crash is exactly the wallet's persisted blindings.
    const { outputs, blindings } = createBlindedOutputs(FUND_AMOUNT, keysetId);
    const swapRes = await api("/swap", { inputs: wallet, outputs });
    assert(swapRes.status === 200, "swap accepted", swapRes.json);
    untrack(wallet); // inputs are spent at the mint now
    // CRASH: swapRes.json.signatures is discarded — never unblinded/stored.
    console.log("Simulated crash: swap response discarded; only blindings survive.");

    // Sanity: without recovery these funds would be gone — inputs are spent.
    const replay = await api("/swap", { inputs: wallet, outputs });
    assert(replay.status === 409, "inputs are already spent at the mint (409)", {
      status: replay.status,
    });

    // --- 3. Recover: replay the blinded messages against /swap/recover ------
    const recover1 = await api("/swap/recover", { outputs: blindings.map((b) => b.B_) });
    assert(recover1.status === 200, "POST /swap/recover -> 200", recover1.json);
    assert(
      Array.isArray(recover1.json.signatures) &&
        recover1.json.signatures.length === blindings.length &&
        recover1.json.signatures.every((s: unknown) => s !== null),
      "all blinded messages have redeliverable signatures",
    );

    // Unblind with the REAL wallet helper (verifies DLEQ) — this is exactly
    // what the Recover tab does with the IndexedDB blindings.
    const recovered = unblindSignatures(recover1.json.signatures, blindings, keys);
    track(recovered);
    assert(
      sumProofs(recovered) === FUND_AMOUNT,
      `recovered proofs total the full ${FUND_AMOUNT} — no funds lost`,
      recovered.map((p) => p.amount),
    );

    // --- 4. Idempotency: a second recovery returns identical signatures -----
    const recover2 = await api("/swap/recover", { outputs: blindings.map((b) => b.B_) });
    assert(
      recover2.status === 200 &&
        JSON.stringify(recover2.json.signatures) === JSON.stringify(recover1.json.signatures),
      "recovery is idempotent (second call returns identical signatures)",
    );

    // --- 5. Unknown B_ -> null (operation that never committed) -------------
    const fake = await api("/swap/recover", { outputs: ["02" + "ab".repeat(32)] });
    assert(
      fake.status === 200 && fake.json.signatures.length === 1 && fake.json.signatures[0] === null,
      "unknown blinded message returns null (nothing to recover)",
    );

    // --- 6. Recovered proofs are REAL: redeem them for full value -----------
    const redeem = await api("/redeem", { proofs: recovered, btcAddress: PAYOUT_ADDRESS });
    assert(
      redeem.status === 200 && redeem.json.redeemedAmount === FUND_AMOUNT,
      `recovered proofs are spendable for the full ${FUND_AMOUNT}`,
      redeem.json,
    );
    untrack(recovered);
    outstanding = [];
  } finally {
    await bestEffortCleanupProofs().catch((err) =>
      console.error("Cleanup WARNING: proof cleanup errored", err),
    );
    await db.delete(mintRequestsTable).where(eq(mintRequestsTable.id, request.id));
    console.log("Synthetic mint request deleted (DB state reverted)");
  }
}

main()
  .then(async () => {
    await pool.end();
    console.log("\nAll assertions passed — a mid-swap crash loses no funds.");
  })
  .catch(async (err) => {
    console.error("\nTEST FAILED:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });

/**
 * Helper for browser-testing the wallet startup verification (task: auto-check
 * wallet on load). Produces REAL proofs against the running mint:
 *
 *   seed:    issue 4 leks -> swap them (originals become SPENT) -> write
 *            /tmp/wallet-seed.json with { spentProofs, validProofs, foreignProof }.
 *            The synthetic mint_requests row is deleted immediately; the valid
 *            proofs remain outstanding until cleanup.
 *   cleanup: redeem the valid proofs from the seed file (net supply -> 0).
 *
 * Run: scripts/node_modules/.bin/tsx artifacts/api-server/scripts/seed-wallet-verify.e2e.ts [seed|cleanup]
 */
import { writeFileSync, readFileSync } from "node:fs";
import { db, mintRequestsTable, pool } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createBlindedOutputs, unblindSignatures } from "../../lek-mint/src/lib/wallet";

const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:80/api";
const SEED_FILE = "/tmp/wallet-seed.json";
const AMOUNT = 4;

async function api(path: string, body?: unknown) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} failed ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function seed(): Promise<void> {
  const [request] = await db
    .insert(mintRequestsTable)
    .values({
      btcAddress: `synthetic-e2e-walletverify-${Date.now()}`,
      status: "confirmed",
      grossAmountSats: AMOUNT,
      feeSats: 0,
      netAmountSats: AMOUNT,
    })
    .returning();
  if (!request) throw new Error("failed to insert synthetic request");

  try {
    const keysData = await api("/keys");
    const issue = createBlindedOutputs(AMOUNT, keysData.keysetId);
    const issued = await api("/mint/issue", { requestId: request.id, outputs: issue.outputs });
    const spentProofs = unblindSignatures(issued.signatures, issue.blindings, keysData.keys);

    // Swap: originals become SPENT at the mint; the new proofs are valid.
    const fresh = createBlindedOutputs(AMOUNT, keysData.keysetId);
    const swapped = await api("/swap", { inputs: spentProofs, outputs: fresh.outputs });
    const validProofs = unblindSignatures(swapped.signatures, fresh.blindings, keysData.keys);

    // A proof from a keyset this mint has never heard of.
    const foreignProof = {
      id: "00deadbeef000000",
      amount: 8,
      secret: `foreign-${Date.now()}`,
      C: "02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2",
    };

    writeFileSync(SEED_FILE, JSON.stringify({ spentProofs, validProofs, foreignProof }, null, 2));
    console.log(`Seed written to ${SEED_FILE}`);
    console.log(`spent: ${spentProofs.length} proofs (4 leks), valid: ${validProofs.length} proofs (4 leks), foreign: 8 leks`);
  } finally {
    await db.delete(mintRequestsTable).where(eq(mintRequestsTable.id, request.id));
  }
}

async function cleanup(): Promise<void> {
  const { validProofs } = JSON.parse(readFileSync(SEED_FILE, "utf8"));
  const burn = await api("/redeem", {
    proofs: validProofs,
    btcAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
  });
  console.log(`Cleanup: burned ${burn.redeemedAmount} leks (net supply restored)`);
}

const mode = process.argv[2] ?? "seed";
(mode === "cleanup" ? cleanup() : seed())
  .then(() => pool.end())
  .catch(async (err) => {
    console.error("FAILED:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });

/**
 * E2E check for the payout queue (task: melted leks get paid).
 * Crafts a valid proof server-side, redeems it over HTTP, verifies the
 * payout row + supply snapshot, exercises the admin payout endpoints,
 * then fully reverts all synthetic DB state.
 */
import { eq, desc, gt } from "drizzle-orm";
import { db, payoutsTable, proofsTable, tokenSupplyLogTable } from "@workspace/db";
import { getActiveKeyset, getPrivateKeys } from "../src/lib/keysetManager";
import { hashToCurveFromSecretString, secretHash } from "../src/lib/cashuCrypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";

const BASE = "http://localhost:80/api";
const ADMIN_KEY = process.env["ADMIN_API_KEY"]!;
const TEST_ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"; // BIP-173 test vector

function fail(msg: string): never {
  console.error("FAIL:", msg);
  process.exit(1);
}

async function main() {
  const keyset = await getActiveKeyset();
  if (!keyset) fail("no active keyset");
  const amount = 64;
  const priv = getPrivateKeys(keyset)[String(amount)]!;
  const secret = bytesToHex(randomBytes(32));
  const Y = hashToCurveFromSecretString(secret);
  const k = BigInt("0x" + priv) % secp256k1.Point.Fn.ORDER;
  const C = Y.multiply(k).toHex(true);
  const proof = { id: keyset.id, amount, secret, C };

  // Baselines for cleanup + assertions
  const [supplyBefore] = await db.select().from(tokenSupplyLogTable).orderBy(desc(tokenSupplyLogTable.id)).limit(1);
  const supplyBaselineId = supplyBefore?.id ?? 0;
  const redeemedBefore = supplyBefore?.totalLeksRedeemed ?? 0;

  // 1. Redeem over HTTP
  const redeemRes = await fetch(`${BASE}/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proofs: [proof], btcAddress: TEST_ADDRESS }),
  });
  const redeemJson = await redeemRes.json();
  if (redeemRes.status !== 200 || redeemJson.redeemedAmount !== amount) {
    fail(`redeem: status=${redeemRes.status} body=${JSON.stringify(redeemJson)}`);
  }
  console.log("PASS: /redeem burned", amount, "leks");

  // 2. Payout row exists, pending, same tx as burn
  const payoutRows = await db.select().from(payoutsTable).where(eq(payoutsTable.btcAddress, TEST_ADDRESS));
  const payout = payoutRows.find((p) => p.amountLeks === amount && p.status === "pending");
  if (!payout) fail(`payout row missing: ${JSON.stringify(payoutRows)}`);
  console.log("PASS: pending payout row created (id", payout.id + ")");

  // 3. Supply snapshot consistent
  const [supplyAfter] = await db.select().from(tokenSupplyLogTable).orderBy(desc(tokenSupplyLogTable.id)).limit(1);
  if (!supplyAfter || supplyAfter.totalLeksRedeemed !== redeemedBefore + amount) {
    fail(`supply snapshot mismatch: before=${redeemedBefore} after=${supplyAfter?.totalLeksRedeemed}`);
  }
  console.log("PASS: supply log redeemed incremented by", amount);

  // 4. Admin list shows it with pending totals
  const listRes = await fetch(`${BASE}/admin/payouts?status=pending`, {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  const listJson = await listRes.json();
  const listed = listJson.entries?.find((e: any) => e.id === payout.id);
  if (listRes.status !== 200 || !listed) fail(`admin list: ${listRes.status} ${JSON.stringify(listJson)}`);
  if (typeof listJson.pendingCount !== "number" || listJson.pendingTotalLeks < amount) {
    fail(`pending totals wrong: ${JSON.stringify(listJson)}`);
  }
  console.log("PASS: GET /admin/payouts lists it; pendingCount =", listJson.pendingCount, "pendingTotalLeks =", listJson.pendingTotalLeks);

  // 5. Mark paid
  const paidRes = await fetch(`${BASE}/admin/payouts/mark-paid`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [payout.id] }),
  });
  const paidJson = await paidRes.json();
  if (paidRes.status !== 200 || paidJson.settledCount !== 1 || paidJson.settledTotalLeks !== amount) {
    fail(`mark-paid: ${paidRes.status} ${JSON.stringify(paidJson)}`);
  }
  const [settled] = await db.select().from(payoutsTable).where(eq(payoutsTable.id, payout.id));
  if (settled?.status !== "paid" || !settled.settledAt) fail("settled row not updated");
  console.log("PASS: mark-paid settled row with settledAt =", settled.settledAt.toISOString());

  // 6. Idempotency: re-marking already-paid ids is a 400 no-op
  const againRes = await fetch(`${BASE}/admin/payouts/mark-paid`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [payout.id] }),
  });
  if (againRes.status !== 400) fail(`re-mark should 400, got ${againRes.status}`);
  console.log("PASS: re-marking a paid payout is rejected (400)");

  // Cleanup: revert all synthetic state (payout, spent proof, supply snapshots)
  await db.delete(payoutsTable).where(eq(payoutsTable.id, payout.id));
  await db.delete(proofsTable).where(eq(proofsTable.secretHash, secretHash(secret)));
  await db.delete(tokenSupplyLogTable).where(gt(tokenSupplyLogTable.id, supplyBaselineId));
  const [supplyFinal] = await db.select().from(tokenSupplyLogTable).orderBy(desc(tokenSupplyLogTable.id)).limit(1);
  if ((supplyFinal?.totalLeksRedeemed ?? 0) !== redeemedBefore) fail("cleanup left supply drifted");
  console.log("PASS: synthetic state fully reverted");
  console.log("ALL CHECKS PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

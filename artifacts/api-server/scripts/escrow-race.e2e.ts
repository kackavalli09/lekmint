/**
 * E2E concurrency test: an appreciation escrow can be collected exactly ONCE,
 * no matter how many claim paths race for it simultaneously.
 *
 * An escrow has three legitimate collection paths:
 *   1. sender path   — /escrow/claim with the ORIGINAL swap input proofs
 *   2. receiver path — /escrow/claim with the RECEIVED token's proofs, linked
 *                      via the DLEQ blinding factor r (B_ = Y + r*G)
 *   3. operator path — POST /admin/escrows/:id/release
 *
 * Fixture strategy (self-contained, registry-safe):
 *   - A synthetic vintage keyset is provisioned with its own epoch row at a
 *     GAP id strictly between the genesis and current epoch ids, so it can
 *     never be read as the genesis (rate-updater baseline) or the current
 *     epoch (live pricing). Its rate is BELOW the current rate, guaranteeing
 *     a nonzero appreciation escrow in any environment. Provisioning is a
 *     single transaction: it either fully exists or not at all.
 *   - Vintage proofs are fabricated by direct signing with the synthetic
 *     keyset's private keys; their face value is recorded as issued supply in
 *     the same provisioning transaction so the books stay consistent.
 *   - The test's escrow is located ONLY by the fabricated inputs' unique
 *     proof hash — never by recency — so concurrent real traffic is
 *     untouchable.
 *   - EVERY step after provisioning runs under try/finally. Cleanup is
 *     best-effort across all steps (burn synthetic proofs, delete queued
 *     payout rows, delete the test escrow, remove the synthetic keyset +
 *     epoch), aggregates its own errors, and FAILS the test if anything
 *     could not be restored. The final assertion compares circulation to the
 *     TRUE pre-test baseline captured before any fixture existed.
 *
 * This script mutates the mint database it points at. Run it only against a
 * development database, never production.
 *
 * Run: scripts/node_modules/.bin/tsx artifacts/api-server/scripts/escrow-race.e2e.ts
 */
import { db, keysetsTable, epochsTable, swapEscrowsTable, payoutsTable, pool } from "@workspace/db";
import { eq, and, gte, asc } from "drizzle-orm";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { hashToCurveFromSecretString } from "../src/lib/cashuCrypto";
import { computeProofsHash } from "../src/lib/escrow";
import { buildNewKeyset } from "../src/lib/keysetManager";
import { getLatestSupply, recordSupplyDelta } from "../src/lib/supply";

const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:80/api";
const PAYOUT_ADDRESS = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const FACE = 100000;
const VINTAGE_RATE = "0.500000000000"; // below any real rate -> escrow is always > 0

const Point = secp256k1.Point;
const ORDER = Point.Fn.ORDER;
const DENOMS = Array.from({ length: 15 }, (_, i) => 2 ** i).reverse();

function assert(cond: boolean, label: string, detail?: unknown): void {
  if (!cond) {
    throw new Error(
      `ASSERTION FAILED: ${label} ${detail !== undefined ? JSON.stringify(detail) : ""}`,
    );
  }
  console.log(`  PASS  ${label}`);
}

function mod(a: bigint): bigint {
  const r = a % ORDER;
  return r >= 0n ? r : r + ORDER;
}

function decompose(amount: number): number[] {
  const out: number[] = [];
  let rem = amount;
  for (const d of DENOMS) while (rem >= d) { out.push(d); rem -= d; }
  if (rem !== 0) throw new Error(`cannot decompose ${amount}`);
  return out;
}

async function api(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

interface Blinding { secret: string; r: bigint; B_: string; amount: number; id: string }

function blindOutputs(amount: number, keysetId: string): Blinding[] {
  return decompose(amount).map((amt) => {
    const secret = bytesToHex(randomBytes(32));
    const r = mod(BigInt("0x" + bytesToHex(randomBytes(32))));
    const Y = hashToCurveFromSecretString(secret);
    return { secret, r, B_: Y.add(Point.BASE.multiply(r)).toHex(true), amount: amt, id: keysetId };
  });
}

const asOutputs = (bs: Blinding[]) => bs.map(({ id, amount, B_ }) => ({ id, amount, B_ }));

function unblind(sigs: { C_: string }[], blindings: Blinding[], pubkeys: Record<string, string>) {
  return sigs.map((sig, i) => {
    const b = blindings[i]!;
    const A = Point.fromHex(pubkeys[String(b.amount)]!);
    const C = Point.fromHex(sig.C_).add(A.multiply(b.r).negate());
    return {
      id: b.id,
      amount: b.amount,
      secret: b.secret,
      C: C.toHex(true),
      r: b.r.toString(16).padStart(64, "0"),
    };
  });
}

/**
 * Pick an epoch id strictly between the genesis (min) and current (max)
 * epoch ids that is unused. Refusing to run without such a gap is
 * deliberate: any other placement could distort real rates.
 */
async function findSafeEpochGapId(): Promise<number> {
  const rows = await db.select({ id: epochsTable.id }).from(epochsTable).orderBy(asc(epochsTable.id));
  const ids = rows.map((r) => r.id);
  if (ids.length >= 2) {
    const used = new Set(ids);
    for (let candidate = ids[0]! + 1; candidate < ids[ids.length - 1]!; candidate++) {
      if (!used.has(candidate)) return candidate;
    }
  }
  throw new Error(
    "SAFETY ABORT: this test needs a free epoch id strictly between the genesis and current epoch ids " +
      "so the synthetic vintage epoch can never be read as genesis or current. " +
      "Run it in an environment where the mint has rotated epochs at least once (leaving an id gap).",
  );
}

async function main(): Promise<void> {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) throw new Error("ADMIN_API_KEY not set");
  const auth = { Authorization: `Bearer ${adminKey}` };

  const keysRes = await api("/keys");
  if (keysRes.status !== 200) throw new Error(`GET /keys -> ${keysRes.status}`);
  const { keysetId: activeId, keys: activePub } = keysRes.json as {
    keysetId: string;
    keys: Record<string, string>;
  };

  // TRUE baseline: captured before ANY fixture state exists. The final
  // assertion restores circulation to exactly this number.
  const baseline = await getLatestSupply();
  const baselineCirculation = baseline.totalLeksIssued - baseline.totalLeksRedeemed;
  const testStart = new Date();

  // --- provision the synthetic vintage fixture (single transaction: all or
  // nothing — a failure here leaves no state to clean up) --------------------
  const gapId = await findSafeEpochGapId();
  const fixture = buildNewKeyset(gapId);
  const senderProofs = decompose(FACE).map((amt) => {
    const secret = bytesToHex(randomBytes(32));
    const k = mod(BigInt("0x" + fixture.privkeys[String(amt)]!));
    return {
      id: fixture.id,
      amount: amt,
      secret,
      C: hashToCurveFromSecretString(secret).multiply(k).toHex(true),
    };
  });
  const senderProofsHash = computeProofsHash(senderProofs);

  await db.transaction(async (tx) => {
    await tx.insert(epochsTable).values({
      id: gapId,
      keysetId: fixture.id,
      rateIndex: VINTAGE_RATE,
      difficulty: "0.0000",
      subsidySats: 0,
    });
    await tx.insert(keysetsTable).values({
      id: fixture.id,
      epochId: gapId,
      active: false,
      encryptedKeys: fixture.encryptedKeys,
    });
    // The fabricated vintage proofs enter circulation here, so the supply
    // books stay consistent through every subsequent flow.
    await recordSupplyDelta(tx, { issued: FACE });
  });
  console.log(`Synthetic vintage keyset ${fixture.id} provisioned at epoch id ${gapId} (rate ${VINTAGE_RATE})`);

  // From this point on there IS fixture state; everything below runs under
  // try/finally with best-effort, error-aggregating cleanup.
  const outstanding: { proofs: any[]; label: string }[] = [];
  let testFailure: unknown = null;
  const cleanupErrors: string[] = [];
  const guard = async (label: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      cleanupErrors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  try {
    // --- create a real escrow via the public face-value swap path -----------
    // Realistic split: the external wallet builds outputs as the TRANSFER
    // amount for the receiver plus CHANGE it keeps for the sender. The
    // receiver only ever holds the transfer subset.
    const TRANSFER = 90000;
    const CHANGE = FACE - TRANSFER;
    const transferB = blindOutputs(TRANSFER, activeId);
    const changeB = blindOutputs(CHANGE, activeId);
    const swapB = [...transferB, ...changeB];
    const swapRes = await api("/v1/swap", { inputs: senderProofs, outputs: asOutputs(swapB) });
    assert(swapRes.status === 200, "face-value /v1/swap accepted", swapRes.json);
    const allOutputProofs = unblind(swapRes.json.signatures, swapB, activePub);
    // Receiver holds ONLY the transferred subset; the change stays with the
    // sender (we track both for cleanup).
    const receiverProofs = allOutputProofs.slice(0, transferB.length);
    outstanding.push({ proofs: allOutputProofs, label: "swap outputs (transfer + change)" });

    // Sanity: the PARTIAL received token alone resolves the escrow.
    const partialCheck = await api("/escrow/check", { proofs: receiverProofs });
    assert(
      partialCheck.status === 200 && partialCheck.json.available === true,
      "partial received token (transfer subset only) resolves the escrow",
      partialCheck.json,
    );

    const [escrow] = await db
      .select()
      .from(swapEscrowsTable)
      .where(eq(swapEscrowsTable.proofsHash, senderProofsHash));
    if (!escrow || escrow.claimedAt) throw new Error("escrow for the fabricated inputs not found/unclaimed");
    assert(escrow.amountLeks > 0, `escrow holds ${escrow.amountLeks} leks`);

    // --- THE RACE: all three paths fire concurrently ------------------------
    const supplyBefore = await getLatestSupply();
    const senderB = blindOutputs(escrow.amountLeks, activeId);
    const receiverB = blindOutputs(escrow.amountLeks, activeId);
    const [senderClaim, receiverClaim, adminRelease] = await Promise.all([
      api("/escrow/claim", { proofs: senderProofs, outputs: asOutputs(senderB) }),
      api("/escrow/claim", { proofs: receiverProofs, outputs: asOutputs(receiverB) }),
      api(`/admin/escrows/${escrow.id}/release`, {}, auth),
    ]);
    console.log(
      `race results: sender=${senderClaim.status}${senderClaim.json.redelivered ? " (redelivered)" : ""}, ` +
        `receiver=${receiverClaim.status}${receiverClaim.json.redelivered ? " (redelivered)" : ""}, ` +
        `admin=${adminRelease.status}`,
    );

    const [rowAfter] = await db
      .select()
      .from(swapEscrowsTable)
      .where(eq(swapEscrowsTable.id, escrow.id));
    assert(!!rowAfter?.claimedAt, "escrow is claimed after the race");
    const bundle = JSON.parse(rowAfter!.claimBundle ?? "{}");
    const adminWon = bundle.adminRelease === true;
    const claimWinners = [senderClaim, receiverClaim].filter(
      (r) => r.status === 200 && !r.json.redelivered,
    );
    if (adminWon) {
      assert(
        claimWinners.length === 0 && adminRelease.status === 200,
        "admin release won; both wallet claims refused",
        { sender: senderClaim.status, receiver: receiverClaim.status },
      );
    } else {
      assert(
        claimWinners.length === 1 && adminRelease.status === 409,
        "exactly one wallet claim issued fresh signatures; admin release refused",
        { sender: senderClaim.json, receiver: receiverClaim.json, admin: adminRelease.status },
      );
      const loser = senderClaim === claimWinners[0] ? receiverClaim : senderClaim;
      if (loser.status === 200) {
        assert(
          loser.json.redelivered === true &&
            JSON.stringify(loser.json.signatures) === JSON.stringify(bundle.signatures),
          "losing claim got the winner's identical bundle, not new signatures",
        );
      } else {
        assert(loser.status === 409, "losing claim refused with 409", loser);
      }
    }

    // --- supply increased by the escrow amount EXACTLY ONCE ------------------
    const supplyAfter = await getLatestSupply();
    assert(
      supplyAfter.totalLeksIssued - supplyBefore.totalLeksIssued === escrow.amountLeks &&
        supplyAfter.totalLeksRedeemed === supplyBefore.totalLeksRedeemed,
      `issued supply grew by exactly ${escrow.amountLeks} (single payout)`,
      { before: supplyBefore.totalLeksIssued, after: supplyAfter.totalLeksIssued },
    );

    if (adminWon) {
      const decoded = JSON.parse(
        Buffer.from((bundle.token as string).slice(6), "base64url").toString(),
      );
      outstanding.push({ proofs: decoded.token[0].proofs, label: "admin-released token" });
    } else {
      const winnerB = claimWinners[0] === senderClaim ? senderB : receiverB;
      outstanding.push({
        proofs: unblind(claimWinners[0]!.json.signatures, winnerB, activePub),
        label: "winning claim proceeds",
      });
    }

    // --- a straggler arriving later still cannot double-collect -------------
    const lateB = blindOutputs(escrow.amountLeks, activeId);
    const late = await api("/escrow/claim", { proofs: senderProofs, outputs: asOutputs(lateB) });
    assert(
      late.status === 409 || (late.status === 200 && late.json.redelivered === true),
      "late claim after the race redelivers or refuses — never re-issues",
      late,
    );
    const lateAdmin = await api(`/admin/escrows/${escrow.id}/release`, {}, auth);
    assert(
      adminWon
        ? lateAdmin.status === 200 && lateAdmin.json.token === bundle.token
        : lateAdmin.status === 409,
      adminWon
        ? "late admin release idempotently returns the same token"
        : "late admin release refused (already claimed by a wallet)",
      lateAdmin.status,
    );
    const supplyFinal = await getLatestSupply();
    assert(
      supplyFinal.totalLeksIssued === supplyAfter.totalLeksIssued,
      "no further issuance from late attempts",
    );
  } catch (err) {
    testFailure = err;
  } finally {
    // --- cleanup: best-effort across EVERY step; errors aggregate -----------
    for (const item of outstanding) {
      await guard(`burn ${item.label}`, async () => {
        const res = await api("/redeem", { proofs: item.proofs, btcAddress: PAYOUT_ADDRESS });
        if (res.status !== 200) {
          throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.json)}`);
        }
        console.log(`Cleanup: burned ${item.label} (${res.json.redeemedAmount} leks)`);
      });
    }
    await guard("delete synthetic payout rows", async () => {
      const deleted = await db
        .delete(payoutsTable)
        .where(
          and(
            eq(payoutsTable.btcAddress, PAYOUT_ADDRESS),
            eq(payoutsTable.status, "pending"),
            gte(payoutsTable.createdAt, testStart),
          ),
        )
        .returning({ id: payoutsTable.id });
      console.log(`Cleanup: removed ${deleted.length} synthetic payout rows`);
    });
    await guard("delete test escrow", async () => {
      await db.delete(swapEscrowsTable).where(eq(swapEscrowsTable.proofsHash, senderProofsHash));
    });
    // If the pre-issued FACE was never spent through /v1/swap (early failure),
    // reverse the pre-issuance so the supply books return to baseline.
    await guard("reverse unspent pre-issuance", async () => {
      if (outstanding.length === 0) {
        await db.transaction(async (tx) => {
          await recordSupplyDelta(tx, { redeemed: FACE });
        });
        console.log("Cleanup: reversed pre-issued face value (fabricated proofs were never swapped)");
      }
    });
    await guard("remove synthetic keyset", async () => {
      await db.delete(keysetsTable).where(eq(keysetsTable.id, fixture.id));
    });
    await guard("remove synthetic epoch", async () => {
      await db.delete(epochsTable).where(eq(epochsTable.id, gapId));
    });
    console.log("Cleanup: synthetic keyset + epoch rows removed (registry restored)");
  }

  if (cleanupErrors.length > 0) {
    const suffix = testFailure ? ` (test had already failed: ${String(testFailure)})` : "";
    throw new Error(
      `CLEANUP FAILED — environment may not be fully restored: ${cleanupErrors.join("; ")}${suffix}`,
    );
  }
  if (testFailure) throw testFailure;

  // The books must balance EXACTLY back to the true pre-test baseline:
  // pre-issued FACE, v1/swap (+FACE issued, -FACE redeemed), claim issued
  // escrow, burns redeemed FACE + escrow => net zero.
  const end = await getLatestSupply();
  const endCirculation = end.totalLeksIssued - end.totalLeksRedeemed;
  assert(
    endCirculation === baselineCirculation,
    "circulation restored EXACTLY to the true pre-test baseline (no stray funds)",
    { baselineCirculation, endCirculation },
  );

  // And no synthetic rows survive.
  const leftoverKeysets = await db.select().from(keysetsTable).where(eq(keysetsTable.id, fixture.id));
  const leftoverEpochs = await db.select().from(epochsTable).where(eq(epochsTable.id, gapId));
  const leftoverEscrows = await db
    .select()
    .from(swapEscrowsTable)
    .where(eq(swapEscrowsTable.proofsHash, senderProofsHash));
  assert(
    leftoverKeysets.length === 0 && leftoverEpochs.length === 0 && leftoverEscrows.length === 0,
    "no synthetic keyset/epoch/escrow rows remain",
  );
}

main()
  .then(async () => {
    console.log("\nAll assertions passed — held-back value can only ever be collected once.");
  })
  .catch((err) => {
    console.error("\nTEST FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end().catch(() => {});
  });

import { db, proofsTable, keysetsTable, signedOutputsTable } from "@workspace/db";
import type { Keyset } from "@workspace/db";
import { sql, inArray } from "drizzle-orm";
import { KEYSET_TRANSITION_LOCK_KEY } from "./epochEngine";
import { verifyProof, blindSign, secretHash, hashToCurveFromSecretString } from "./cashuCrypto";
import { DENOMINATIONS, getKeysetById, getPrivateKeys } from "./keysetManager";
import { anyRecentlySpent } from "./spentCache";

/**
 * Shared mint-side proof/output handling used by redeem, swap, issue and
 * upgrade endpoints.
 */

export interface ProofInput {
  id: string;
  amount: number;
  secret: string;
  C: string;
}

export interface BlindedMessageInput {
  id: string;
  amount: number;
  B_: string;
}

export interface SignedOutput {
  id: string;
  amount: number;
  C_: string;
  dleq: { e: string; s: string };
}

export class ProofValidationError extends Error {}
/**
 * Raised for proofs signed by a revoked keyset (post security-rotation).
 * Distinct from a generic validation error so routes can surface a clear
 * "keys were rotated" message instead of "unknown keyset".
 */
export class KeysetRevokedError extends ProofValidationError {
  constructor(keysetId: string) {
    super(
      `This mint's keys were rotated for security; tokens signed by keyset ${keysetId} are permanently invalid`,
    );
  }
}
export class DoubleSpendError extends Error {
  constructor() {
    super("One or more proofs have already been spent");
  }
}

const DENOMINATION_SET = new Set(DENOMINATIONS);

/**
 * Cryptographically verifies proofs against their keysets.
 * Returns the verified proofs annotated with their keyset rows.
 */
export async function verifyInputProofs(
  proofs: ProofInput[],
): Promise<{ total: number; keysets: Map<string, Keyset> }> {
  if (proofs.length === 0) {
    throw new ProofValidationError("No proofs provided");
  }
  // Reject in-request duplicates up front.
  const seen = new Set<string>();
  for (const proof of proofs) {
    const key = `${proof.id}:${proof.secret}`;
    if (seen.has(key)) {
      throw new ProofValidationError("Duplicate proof in request");
    }
    seen.add(key);
  }

  // Fast-path double-spend rejection: proofs recently spent (and committed)
  // are refused before any expensive crypto or DB work.
  if (anyRecentlySpent(proofs)) {
    throw new DoubleSpendError();
  }

  return verifyProofCryptography(proofs);
}

/**
 * Crypto-only proof verification (signature + keyset + denomination), WITHOUT
 * the recently-spent fast path. Used by the escrow claim flow, where the
 * proofs are EXPECTED to be already spent — the claimant proves they held the
 * original token by presenting the complete, validly-signed proof set.
 */
export async function verifyProofCryptography(
  proofs: ProofInput[],
): Promise<{ total: number; keysets: Map<string, Keyset> }> {
  const keysets = new Map<string, Keyset>();
  for (const proof of proofs) {
    if (!DENOMINATION_SET.has(proof.amount)) {
      throw new ProofValidationError(`Invalid denomination: ${proof.amount}`);
    }
    let keyset = keysets.get(proof.id);
    if (!keyset) {
      const found = await getKeysetById(proof.id);
      if (!found) {
        throw new ProofValidationError(`Unknown keyset: ${proof.id}`);
      }
      if (found.revokedAt) {
        throw new KeysetRevokedError(proof.id);
      }
      keyset = found;
      keysets.set(proof.id, keyset);
    }
    const privkey = getPrivateKeys(keyset)[String(proof.amount)];
    if (!privkey) {
      throw new ProofValidationError(`No key for denomination ${proof.amount}`);
    }
    if (!verifyProof(proof.secret, proof.C, privkey)) {
      throw new ProofValidationError("Proof signature verification failed");
    }
  }
  const total = proofs.reduce((sum, p) => sum + p.amount, 0);
  return { total, keysets };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Concurrency guard — MUST be called inside every transaction that burns
 * proofs or signs outputs, BEFORE doing either.
 *
 * Takes the keyset-transition advisory lock in SHARED mode (token operations
 * run concurrently with each other, but serialize against an in-flight
 * rotation/epoch roll, which takes it exclusively) and re-reads the keyset
 * rows. This closes the race where a keyset is read before the transaction
 * but revoked/deactivated before commit: without it, a swap or issue could
 * burn valid inputs and hand back signatures from just-revoked keys.
 *
 * - Any input keyset revoked mid-request -> KeysetRevokedError (400, clear
 *   "keys were rotated" message), transaction rolls back, inputs untouched.
 * - The signing keyset no longer active -> retryable validation error.
 */
export async function assertKeysetsFresh(
  tx: Tx,
  inputKeysetIds: string[],
  signingKeysetId?: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${KEYSET_TRANSITION_LOCK_KEY})`);
  const ids = [...new Set(signingKeysetId ? [...inputKeysetIds, signingKeysetId] : inputKeysetIds)];
  if (ids.length === 0) {
    return;
  }
  const rows = await tx.select().from(keysetsTable).where(inArray(keysetsTable.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || row.revokedAt) {
      throw new KeysetRevokedError(id);
    }
  }
  if (signingKeysetId && !byId.get(signingKeysetId)?.active) {
    throw new ProofValidationError(
      "The mint's signing keys changed while processing this request; please retry",
    );
  }
}

/**
 * Marks proofs spent inside a transaction. The unique constraint on
 * (keyset_id, secret_hash) turns any double-spend into a 23505 violation,
 * which surfaces as DoubleSpendError and rolls back the whole transaction.
 */
export async function spendProofs(tx: Tx, proofs: ProofInput[]): Promise<void> {
  try {
    await tx.insert(proofsTable).values(
      proofs.map((p) => ({
        keysetId: p.id,
        amount: p.amount,
        secretHash: secretHash(p.secret),
        // NUT-00 Y point, so external wallets can query state via NUT-07.
        y: hashToCurveFromSecretString(p.secret).toHex(true),
        c: p.C,
        status: "spent",
      })),
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new DoubleSpendError();
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    ("code" in err && (err as { code?: string }).code === "23505" ||
      ("cause" in err && isUniqueViolation((err as { cause?: unknown }).cause)))
  );
}

/**
 * Validates blinded outputs against a target keyset and blind-signs them.
 * All outputs must target the given keyset and use valid denominations.
 */
export function signOutputs(keyset: Keyset, outputs: BlindedMessageInput[]): SignedOutput[] {
  const privkeys = getPrivateKeys(keyset);
  return outputs.map((output) => {
    if (output.id !== keyset.id) {
      throw new ProofValidationError(
        `Output targets keyset ${output.id}; expected active keyset ${keyset.id}. ` +
          `The mint's keys may have rotated — refresh the mint's keysets in your wallet and retry`,
      );
    }
    if (!DENOMINATION_SET.has(output.amount)) {
      throw new ProofValidationError(`Invalid output denomination: ${output.amount}`);
    }
    const privkey = privkeys[String(output.amount)]!;
    const { signatureHex, dleq } = blindSign(output.B_, privkey);
    return { id: output.id, amount: output.amount, C_: signatureHex, dleq };
  });
}

/**
 * Persists issued blind signatures keyed by their blinded message B_ so an
 * already-processed swap/upgrade can be redelivered idempotently via
 * POST /swap/recover. MUST run in the same transaction as spendProofs —
 * either the inputs are spent AND the signatures are redeliverable, or
 * neither happened.
 */
export async function persistSignedOutputs(
  tx: Tx,
  outputs: BlindedMessageInput[],
  signatures: SignedOutput[],
  operation: "swap" | "upgrade",
): Promise<void> {
  await tx
    .insert(signedOutputsTable)
    .values(
      signatures.map((sig, i) => ({
        b: outputs[i]!.B_,
        keysetId: sig.id,
        amount: sig.amount,
        cBlind: sig.C_,
        dleqE: sig.dleq.e,
        dleqS: sig.dleq.s,
        operation,
      })),
    )
    .onConflictDoNothing();
}
export function sumAmounts(items: Array<{ amount: number }>): number {
  return items.reduce((sum, item) => sum + item.amount, 0);
}

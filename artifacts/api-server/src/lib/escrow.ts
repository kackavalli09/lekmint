import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { secretHash, hashToCurveFromSecretString } from "./cashuCrypto";
import type { ProofInput } from "./mintService";

/**
 * Appreciation-escrow key: a deterministic fingerprint of a burned input
 * proof set. Computed from `${keysetId}:${sha256(secret)}` pairs, sorted, so
 * the same set of proofs always hashes identically regardless of order.
 *
 * Only someone holding the complete original proofs (secrets + signatures)
 * can recompute this hash AND pass cryptographic verification, which is what
 * makes the escrow claimable exclusively by the original sender's wallet.
 */
export function computeProofsHash(proofs: ProofInput[]): string {
  const parts = proofs.map((p) => `${p.id}:${secretHash(p.secret)}`).sort();
  return bytesToHex(sha256(utf8ToBytes(parts.join("|"))));
}

/**
 * Recompute the blinded point of the swap output a proof originated from:
 * B_ = hash_to_curve(secret) + r*G, where r is the DLEQ blinding factor the
 * issuing wallet embedded in the token (NUT-12). Only the token holder knows
 * (secret, r), so a valid recomputation proves this proof IS the output of
 * whichever swap the mint recorded that B_ for.
 *
 * Returns the compressed point hex (lowercase), or null when r is missing or
 * malformed — callers treat that as "no output linkage available".
 */
export function computeBlindedPoint(secret: string, r: string | undefined): string | null {
  if (!r || !/^[0-9a-fA-F]{64}$/.test(r)) return null;
  try {
    const Point = secp256k1.Point;
    const rScalar = BigInt("0x" + r) % Point.Fn.ORDER;
    if (rScalar === 0n) return null;
    const Y = hashToCurveFromSecretString(secret);
    return Y.add(Point.BASE.multiply(rScalar)).toHex(true).toLowerCase();
  } catch {
    return null;
  }
}

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  hexToBytes,
  concatBytes,
  utf8ToBytes,
  randomBytes,
} from "@noble/hashes/utils.js";

/**
 * Client-side Cashu BDHKE primitives (NUT-00) + DLEQ verification (NUT-12).
 *
 * Wallet side of the protocol:
 *   - wallet picks random secret x and blinding factor r
 *   - sends B_ = Y + rG where Y = hash_to_curve(x)
 *   - mint returns C_ = k * B_ plus a DLEQ proof
 *   - wallet unblinds C = C_ - r*K (K = mint pubkey for the denomination)
 *   - proof is (x, C); mint later verifies C == k * hash_to_curve(x)
 */

const Point = secp256k1.Point;
type PointType = InstanceType<typeof Point>;
const CURVE_ORDER = Point.Fn.ORDER;

const DOMAIN_SEPARATOR = utf8ToBytes("Secp256k1_HashToCurve_Cashu_");

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function bytesToNumber(bytes: Uint8Array): bigint {
  return BigInt("0x" + bytesToHex(bytes));
}

/** NUT-00 hash_to_curve: deterministically maps a secret to a curve point. */
export function hashToCurve(secret: Uint8Array): PointType {
  const msgHash = sha256(concatBytes(DOMAIN_SEPARATOR, secret));
  const counter = new Uint8Array(4);
  const view = new DataView(counter.buffer);
  for (let i = 0; i < 2 ** 16; i++) {
    view.setUint32(0, i, true); // little-endian counter per spec
    const candidate = sha256(concatBytes(msgHash, counter));
    try {
      return Point.fromHex("02" + bytesToHex(candidate));
    } catch {
      // not a valid x-coordinate; try next counter
    }
  }
  throw new Error("hash_to_curve: no valid point found");
}

export function hashToCurveFromSecretString(secret: string): PointType {
  return hashToCurve(utf8ToBytes(secret));
}

/** Random 32-byte secret, hex encoded (NUT-00 recommends random strings). */
export function generateSecret(): string {
  return bytesToHex(randomBytes(32));
}

export interface BlindingData {
  /** The proof secret (utf-8 string, here hex-encoded random bytes) */
  secret: string;
  /** Blinding factor r as hex */
  r: string;
  /** Blinded point B_ = hash_to_curve(secret) + r*G, compressed hex */
  B_: string;
}

/** Blind a secret: B_ = Y + rG. Keep `r` and `secret` private until unblinding. */
export function blindMessage(secret: string): BlindingData {
  const Y = hashToCurveFromSecretString(secret);
  let r = 0n;
  while (r === 0n) {
    r = mod(bytesToNumber(randomBytes(32)), CURVE_ORDER);
  }
  const B_ = Y.add(Point.BASE.multiply(r));
  return {
    secret,
    r: r.toString(16).padStart(64, "0"),
    B_: B_.toHex(true),
  };
}

/**
 * Unblind a blind signature: C = C_ - r*K.
 * `mintPubkeyHex` is the mint's published pubkey K for this denomination.
 */
export function unblindSignature(
  cBlindedHex: string,
  rHex: string,
  mintPubkeyHex: string,
): string {
  const C_ = Point.fromHex(cBlindedHex);
  const K = Point.fromHex(mintPubkeyHex);
  const r = mod(bytesToNumber(hexToBytes(rHex)), CURVE_ORDER);
  const C = C_.subtract(K.multiply(r));
  return C.toHex(true);
}

/** NUT-12 challenge: e = sha256(concat of uncompressed hex encodings, utf8). */
function hashE(...points: PointType[]): bigint {
  const encoded = points.map((p) => p.toHex(false)).join("");
  return mod(bytesToNumber(sha256(utf8ToBytes(encoded))), CURVE_ORDER);
}

/**
 * Verify a NUT-12 DLEQ proof on a blind signature:
 *   R1 = s*G  - e*A
 *   R2 = s*B_ - e*C_
 *   valid iff e == hash(R1, R2, A, C_)
 * Proves the mint used the same private key k as in its published pubkey A.
 */
export function verifyDleq(
  bBlindedHex: string,
  cBlindedHex: string,
  mintPubkeyHex: string,
  dleq: { e: string; s: string },
): boolean {
  try {
    const B_ = Point.fromHex(bBlindedHex);
    const C_ = Point.fromHex(cBlindedHex);
    const A = Point.fromHex(mintPubkeyHex);
    const e = mod(bytesToNumber(hexToBytes(dleq.e)), CURVE_ORDER);
    const s = mod(bytesToNumber(hexToBytes(dleq.s)), CURVE_ORDER);
    if (s === 0n) return false;
    const R1 = Point.BASE.multiply(s).subtract(A.multiply(e));
    const R2 = B_.multiply(s).subtract(C_.multiply(e));
    return hashE(R1, R2, A, C_) === e;
  } catch {
    return false;
  }
}

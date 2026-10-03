import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes, randomBytes } from "@noble/hashes/utils.js";

/**
 * Cashu BDHKE primitives (NUT-00) + DLEQ proofs (NUT-12) on secp256k1,
 * using constant-time operations from @noble/curves.
 *
 * Mint side of the protocol:
 *   - client sends B_ = Y + rG (blinded point for secret x, Y = hash_to_curve(x))
 *   - mint returns C_ = k * B_       (blindSign)
 *   - client unblinds C = C_ - r*K   and holds proof (x, C)
 *   - mint verifies a proof by checking C == k * hash_to_curve(x)
 */

const Point = secp256k1.Point;
type PointType = InstanceType<typeof Point>;
const CURVE_ORDER = Point.Fn.ORDER;

const DOMAIN_SEPARATOR = utf8ToBytes("Secp256k1_HashToCurve_Cashu_");

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

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function bytesToNumber(bytes: Uint8Array): bigint {
  return BigInt("0x" + bytesToHex(bytes));
}

export function generatePrivateKey(): string {
  return bytesToHex(secp256k1.utils.randomSecretKey());
}

export function getPublicKeyHex(privkeyHex: string): string {
  return bytesToHex(secp256k1.getPublicKey(hexToBytes(privkeyHex), true));
}

export interface DleqProof {
  e: string;
  s: string;
}

/** NUT-12 challenge: e = sha256(concat of uncompressed hex encodings, utf8). */
function hashE(...points: PointType[]): bigint {
  const encoded = points.map((p) => p.toHex(false)).join("");
  return mod(bytesToNumber(sha256(utf8ToBytes(encoded))), CURVE_ORDER);
}

/**
 * Blind-sign a blinded message: C_ = k * B_. Also produces a DLEQ proof that
 * the same k was used as in the published pubkey A = k*G.
 */
export function blindSign(
  blindedMessageHex: string,
  privkeyHex: string,
): { signatureHex: string; dleq: DleqProof } {
  const B_ = Point.fromHex(blindedMessageHex);
  const k = mod(bytesToNumber(hexToBytes(privkeyHex)), CURVE_ORDER);
  if (k === 0n) {
    throw new Error("Invalid private key");
  }
  const C_ = B_.multiply(k);

  // DLEQ: prove log_G(A) == log_{B_}(C_)
  const r = mod(bytesToNumber(randomBytes(32)), CURVE_ORDER);
  const R1 = Point.BASE.multiply(r);
  const R2 = B_.multiply(r);
  const A = Point.BASE.multiply(k);
  const e = hashE(R1, R2, A, C_);
  const s = mod(r + e * k, CURVE_ORDER);

  return {
    signatureHex: C_.toHex(true),
    dleq: { e: e.toString(16).padStart(64, "0"), s: s.toString(16).padStart(64, "0") },
  };
}

/**
 * Direct mint-side issuance (no blinding): C = k * hash_to_curve(secret).
 * Used only for operator self-issuance (admin escrow release), where the
 * mint itself generates the secret — blinding would add nothing since the
 * mint already knows it. The result verifies exactly like any other proof.
 */
export function signSecretDirect(secret: string, privkeyHex: string): string {
  const k = mod(bytesToNumber(hexToBytes(privkeyHex)), CURVE_ORDER);
  if (k === 0n) {
    throw new Error("Invalid private key");
  }
  return hashToCurveFromSecretString(secret).multiply(k).toHex(true);
}

/** Random 32-byte hex secret for mint-generated proofs. */
export function generateSecret(): string {
  return bytesToHex(randomBytes(32));
}

/** Mint-side proof verification: C == k * hash_to_curve(secret). */
export function verifyProof(secret: string, cHex: string, privkeyHex: string): boolean {
  let C: PointType;
  try {
    C = Point.fromHex(cHex);
  } catch {
    return false;
  }
  const k = mod(bytesToNumber(hexToBytes(privkeyHex)), CURVE_ORDER);
  const Y = hashToCurveFromSecretString(secret);
  return Y.multiply(k).equals(C);
}

/** Hex-encoded sha256 of a proof secret (double-spend registry key). */
export function secretHash(secret: string): string {
  return bytesToHex(sha256(utf8ToBytes(secret)));
}

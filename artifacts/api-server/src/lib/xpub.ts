import { HDKey } from "@scure/bip32";
import { base58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import * as btc from "@scure/btc-signer";

/**
 * Watch-only BIP84 address derivation from an account-level extended public
 * key. Accepts mainnet `xpub` or `zpub` (zpub is normalized to xpub version
 * bytes; both encode the same key material, only the prefix differs).
 * Derivation path: m/84'/0'/0'/0/N (external chain, child N).
 */

const b58 = base58check(sha256);
const XPUB_VERSION = 0x0488b21e;
const ZPUB_VERSION = 0x04b24746;

export const DERIVATION_PATH_PREFIX = "m/84'/0'/0'/0";

/** Normalize zpub -> xpub version bytes so @scure/bip32 can parse it. */
export function normalizeXpub(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("xpub")) {
    return trimmed;
  }
  if (trimmed.startsWith("zpub")) {
    const data = b58.decode(trimmed);
    const version = new DataView(data.buffer, data.byteOffset).getUint32(0);
    if (version !== ZPUB_VERSION) {
      throw new Error("Invalid zpub version bytes");
    }
    const out = new Uint8Array(data);
    new DataView(out.buffer).setUint32(0, XPUB_VERSION);
    return b58.encode(out);
  }
  throw new Error("Unsupported extended key: expected mainnet xpub or zpub");
}

/** Throws if the key is not a valid, derivable public extended key. */
export function validateXpub(input: string): string {
  const xpub = normalizeXpub(input);
  const hd = HDKey.fromExtendedKey(xpub);
  if (hd.privateKey) {
    throw new Error("Refusing extended PRIVATE key — provide the xpub only");
  }
  // Must be able to derive the external chain.
  deriveAddress(xpub, 0);
  return xpub;
}

/** BIP32 fingerprint (8 hex chars) identifying the wallet key. */
export function getFingerprint(xpub: string): string {
  const hd = HDKey.fromExtendedKey(normalizeXpub(xpub));
  return (hd.fingerprint >>> 0).toString(16).padStart(8, "0");
}

/** Derive the native SegWit (P2WPKH) address at external index N. */
export function deriveAddress(xpub: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Invalid derivation index: ${index}`);
  }
  const hd = HDKey.fromExtendedKey(normalizeXpub(xpub));
  const child = hd.deriveChild(0).deriveChild(index);
  if (!child.publicKey) {
    throw new Error("Failed to derive public key");
  }
  const payment = btc.p2wpkh(child.publicKey, btc.NETWORK);
  if (!payment.address) {
    throw new Error("Failed to derive address");
  }
  return payment.address;
}

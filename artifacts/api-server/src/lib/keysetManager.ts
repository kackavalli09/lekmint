import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, concatBytes } from "@noble/hashes/utils.js";
import { db, keysetsTable } from "@workspace/db";
import type { Keyset } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { encryptSecret, decryptSecret } from "./cryptoVault";
import { generatePrivateKey, getPublicKeyHex } from "./cashuCrypto";

/**
 * Keyset lifecycle. One keyset per epoch; denominations are powers of two
 * 1..16384 leks. Private keys live encrypted in the DB and decrypted into an
 * in-process cache on demand.
 */

export const DENOMINATIONS = Array.from({ length: 15 }, (_, i) => 2 ** i); // 1..16384

export type PrivateKeyMap = Record<string, string>; // amount -> privkey hex
export type PublicKeyMap = Record<string, string>; // amount -> pubkey hex

/** NUT-02 keyset id: "00" + first 14 hex chars of sha256(sorted pubkeys). */
export function computeKeysetId(pubkeys: PublicKeyMap): string {
  const sorted = Object.keys(pubkeys)
    .map(Number)
    .sort((a, b) => a - b)
    .map((amount) => hexToBytes(pubkeys[String(amount)]!));
  const digest = sha256(concatBytes(...sorted));
  return "00" + bytesToHex(digest).slice(0, 14);
}

export function derivePublicKeys(privkeys: PrivateKeyMap): PublicKeyMap {
  const out: PublicKeyMap = {};
  for (const [amount, priv] of Object.entries(privkeys)) {
    out[amount] = getPublicKeyHex(priv);
  }
  return out;
}

function generateKeys(): PrivateKeyMap {
  const keys: PrivateKeyMap = {};
  for (const amount of DENOMINATIONS) {
    keys[String(amount)] = generatePrivateKey();
  }
  return keys;
}

// In-process caches (keysets are immutable once created).
const privkeyCache = new Map<string, PrivateKeyMap>();
const pubkeyCache = new Map<string, PublicKeyMap>();

export function getPrivateKeys(keyset: Keyset): PrivateKeyMap {
  let cached = privkeyCache.get(keyset.id);
  if (!cached) {
    cached = JSON.parse(decryptSecret(keyset.encryptedKeys)) as PrivateKeyMap;
    privkeyCache.set(keyset.id, cached);
  }
  return cached;
}

export function getPublicKeys(keyset: Keyset): PublicKeyMap {
  let cached = pubkeyCache.get(keyset.id);
  if (!cached) {
    cached = derivePublicKeys(getPrivateKeys(keyset));
    pubkeyCache.set(keyset.id, cached);
  }
  return cached;
}

/**
 * Creates a brand-new keyset for the given epoch. Does NOT toggle active
 * flags — callers manage activation transitions.
 */
export function buildNewKeyset(epochId: number): {
  id: string;
  encryptedKeys: string;
  privkeys: PrivateKeyMap;
} {
  const privkeys = generateKeys();
  const id = computeKeysetId(derivePublicKeys(privkeys));
  return { id, encryptedKeys: encryptSecret(JSON.stringify(privkeys)), privkeys };
}

export async function getActiveKeyset(): Promise<Keyset | null> {
  // A partial unique index guarantees at most one active keyset; the ordering
  // is a defensive guard so any transient anomaly still resolves to the
  // newest keyset deterministically.
  const [row] = await db
    .select()
    .from(keysetsTable)
    .where(eq(keysetsTable.active, true))
    .orderBy(desc(keysetsTable.epochId))
    .limit(1);
  return row ?? null;
}

export async function getKeysetById(id: string): Promise<Keyset | null> {
  const [row] = await db.select().from(keysetsTable).where(eq(keysetsTable.id, id)).limit(1);
  return row ?? null;
}

export async function listKeysets(): Promise<Keyset[]> {
  return db.select().from(keysetsTable);
}

/**
 * Keysets visible to the public keys/keysets endpoints. Revoked keysets ARE
 * included (marked inactive): per NUT-02 wallets rely on the keyset list to
 * learn that a cached keyset is no longer active and switch to the current
 * one. Hiding revoked keysets left wallets stuck targeting stale keysets.
 * Spending/signing restrictions on revoked keysets are enforced separately.
 */
export async function listPublicKeysets(): Promise<Keyset[]> {
  return db.select().from(keysetsTable);
}

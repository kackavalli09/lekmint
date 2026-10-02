import { db, adminConfigTable, btcAddressesTable } from "@workspace/db";
import type { BtcAddress } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { encryptSecret, decryptSecret } from "./cryptoVault";
import { validateXpub, deriveAddress, getFingerprint } from "./xpub";
import { getOrCreateAdminConfig } from "./mintConfig";
import { addressHasHistory } from "./depositWatcher";
import { logger } from "./logger";

/**
 * Fund wallet management. The xpub is stored AES-256-GCM encrypted in
 * admin_config; only one xpub is active at a time. Addresses are scoped to
 * the wallet's BIP32 fingerprint, so setting a NEW xpub restarts derivation
 * at index 0, while re-setting a previously used xpub resumes after the
 * highest index already derived for that wallet (no uniqueness collisions).
 */

export async function setXpub(rawXpub: string): Promise<{
  nextIndex: number;
  sampleAddresses: string[];
}> {
  const xpub = validateXpub(rawXpub);
  const encrypted = encryptSecret(xpub);
  // Round-trip check before persisting.
  if (decryptSecret(encrypted) !== xpub) {
    throw new Error("Encryption round-trip failed");
  }
  const fingerprint = getFingerprint(xpub);
  const [{ maxIndex }] = await db
    .select({ maxIndex: sql<number | null>`max(${btcAddressesTable.derivationIndex})` })
    .from(btcAddressesTable)
    .where(eq(btcAddressesTable.walletFingerprint, fingerprint));
  const nextIndex = maxIndex === null ? 0 : Number(maxIndex) + 1;

  const config = await getOrCreateAdminConfig();
  await db
    .update(adminConfigTable)
    .set({ xpubEncrypted: encrypted, derivationIndexCounter: nextIndex })
    .where(eq(adminConfigTable.id, config.id));
  const sampleAddresses = [nextIndex, nextIndex + 1, nextIndex + 2].map((i) =>
    deriveAddress(xpub, i),
  );
  return { nextIndex, sampleAddresses };
}

/** Returns the decrypted xpub, or null if none is configured. */
export async function getActiveXpub(): Promise<string | null> {
  const config = await getOrCreateAdminConfig();
  if (!config.xpubEncrypted) {
    return null;
  }
  return decryptSecret(config.xpubEncrypted);
}

/** How many consecutive already-used indices we skip before giving up. */
const MAX_USED_ADDRESS_SKIPS = 25;

/**
 * Atomically claims the next derivation index and records the derived
 * address. Counter increment and address insert run in one transaction, so
 * a failed insert rolls the counter back; the UPDATE ... RETURNING increment
 * gives concurrent requests distinct indices.
 *
 * Fresh-address guarantee: before handing an address to a mint request, its
 * on-chain history is checked. If the configured xpub belongs to a wallet
 * that already used this index (any prior transactions), the address is
 * marked `used_external` and the next index is tried. If the history check
 * itself fails (mempool API down), the address is still handed out — the
 * deposit watcher independently refuses to credit transactions confirmed
 * before the request was created, so stale history can never mint leks.
 */
export async function deriveNextAddress(): Promise<BtcAddress> {
  const xpub = await getActiveXpub();
  if (!xpub) {
    throw new XpubNotConfiguredError();
  }
  const fingerprint = getFingerprint(xpub);
  const config = await getOrCreateAdminConfig();

  const claimNext = (): Promise<BtcAddress> =>
    db.transaction(async (tx) => {
      const [updated] = await tx
        .update(adminConfigTable)
        .set({
          derivationIndexCounter: sql`${adminConfigTable.derivationIndexCounter} + 1`,
        })
        .where(eq(adminConfigTable.id, config.id))
        .returning();
      const index = updated!.derivationIndexCounter - 1;
      const address = deriveAddress(xpub, index);
      const [row] = await tx
        .insert(btcAddressesTable)
        .values({ address, walletFingerprint: fingerprint, derivationIndex: index, status: "pending" })
        .returning();
      return row!;
    });

  for (let attempt = 0; attempt <= MAX_USED_ADDRESS_SKIPS; attempt++) {
    const row = await claimNext();
    let used: boolean;
    try {
      used = await addressHasHistory(row.address);
    } catch (err) {
      // History check unavailable — hand out the address anyway; the deposit
      // watcher's created-at filter still protects against old history.
      logger.warn(
        { err, address: row.address },
        "Address history check failed; proceeding with derived address",
      );
      return row;
    }
    if (!used) {
      return row;
    }
    await db
      .update(btcAddressesTable)
      .set({ status: "used_external" })
      .where(eq(btcAddressesTable.id, row.id));
    logger.warn(
      { address: row.address, derivationIndex: row.derivationIndex },
      "Derived address already has on-chain history; skipping to next index",
    );
  }
  throw new Error(
    `First ${MAX_USED_ADDRESS_SKIPS + 1} derived addresses all have prior on-chain history — ` +
      "the configured xpub looks like an actively used wallet. Set a dedicated (unused) wallet xpub.",
  );
}

export class XpubNotConfiguredError extends Error {
  constructor() {
    super("Mint is not configured: no fund wallet xpub set");
  }
}

/** Startup check: fail loudly if a stored xpub cannot be decrypted. */
export async function verifyXpubOnStartup(): Promise<void> {
  const config = await getOrCreateAdminConfig();
  if (!config.xpubEncrypted) {
    logger.warn("No fund wallet xpub configured yet — minting is disabled until set");
    return;
  }
  try {
    const xpub = decryptSecret(config.xpubEncrypted);
    deriveAddress(xpub, 0);
    logger.info("Fund wallet xpub decrypted and verified");
  } catch (err) {
    logger.error({ err }, "Stored xpub cannot be decrypted — mint endpoints disabled");
    throw new Error(
      "Stored xpub cannot be decrypted (SESSION_SECRET changed?). Re-set the xpub.",
    );
  }
}

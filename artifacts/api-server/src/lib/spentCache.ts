import { LRUCache } from "lru-cache";
import { inArray } from "drizzle-orm";
import { db, proofsTable } from "@workspace/db";
import { secretHash } from "./cashuCrypto";
import { logger } from "./logger";
import type { ProofInput } from "./mintService";

/**
 * In-memory fast-path double-spend guard.
 *
 * The authoritative double-spend protection is the DB unique constraint on
 * (keyset_id, secret_hash); this LRU only exists so repeated replay attempts
 * with already-spent proofs are rejected before touching the database.
 *
 * Entries are added ONLY after the spending transaction has committed, so a
 * rolled-back transaction can never poison the cache.
 */
const spentSecrets = new LRUCache<string, true>({
  max: 100_000,
  ttl: 24 * 60 * 60 * 1000, // 24h
});

function cacheKey(keysetId: string, hash: string): string {
  return `${keysetId}:${hash}`;
}

/** Returns true if any of the proofs was recently seen as spent. */
export function anyRecentlySpent(proofs: ProofInput[]): boolean {
  return proofs.some((p) => spentSecrets.has(cacheKey(p.id, secretHash(p.secret))));
}

/** Record proofs as spent. Call only after the DB transaction committed. */
export function markSpentInCache(proofs: ProofInput[]): void {
  for (const p of proofs) {
    spentSecrets.set(cacheKey(p.id, secretHash(p.secret)), true);
  }
}

/**
 * After a DB-level double-spend rejection, look up which of the submitted
 * proofs are *actually* recorded as spent and cache only those, so replay
 * hammering with the same proofs is fast-rejected next time.
 *
 * Caching only DB-confirmed spends (never the whole batch) prevents an
 * attacker from poisoning the cache against a victim's unspent proof by
 * mixing it into a batch with an already-spent one.
 *
 * Fire-and-forget: failures only cost the fast path, never correctness.
 */
export function cacheConfirmedSpent(proofs: ProofInput[]): void {
  const byHash = new Map(proofs.map((p) => [secretHash(p.secret), p]));
  void db
    .select({ keysetId: proofsTable.keysetId, secretHash: proofsTable.secretHash })
    .from(proofsTable)
    .where(inArray(proofsTable.secretHash, [...byHash.keys()]))
    .then((rows) => {
      for (const row of rows) {
        const proof = byHash.get(row.secretHash);
        if (proof && proof.id === row.keysetId) {
          spentSecrets.set(cacheKey(row.keysetId, row.secretHash), true);
        }
      }
    })
    .catch((err) => {
      logger.warn({ err }, "Failed to backfill spent-proof cache after double-spend rejection");
    });
}

import { pool } from "@workspace/db";
import { isServingTransactions, operationMode } from "./operationMode";
import { VERSION } from "../version";

export const release = process.env.MINT_RELEASE_ID || VERSION;
let cache: { expires: number; healthy: boolean } | undefined;
let inFlight: Promise<boolean> | undefined;

async function databaseAvailable(): Promise<boolean> {
  if (cache && cache.expires > Date.now()) return cache.healthy;
  // Many browsers poll this route. Share one bounded probe, not one query each.
  if (!inFlight) {
    const probeConfig = { text: "SELECT 1", query_timeout: 3000 };
    inFlight = pool.query(probeConfig)
      .then(() => true, () => false)
      .then((healthy) => {
        cache = { expires: Date.now() + 2000, healthy };
        return healthy;
      })
      .finally(() => { inFlight = undefined; });
  }
  return inFlight;
}

export async function getReadiness() {
  const healthy = isServingTransactions() && await databaseAvailable();
  // Recheck after the asynchronous query: shutdown may have started meanwhile.
  const ready = healthy && isServingTransactions();
  return {
    status: ready ? "ready" as const : "not_ready" as const,
    mode: operationMode,
    release,
  };
}
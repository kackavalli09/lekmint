import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import type { Server } from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import { verifyXpubOnStartup } from "./lib/fundWallet";
import { startDepositWatcher, stopDepositWatcher } from "./lib/depositWatcher";
import { ensureGenesis, startEpochEngine, stopEpochEngine } from "./lib/epochEngine";
import { listKeysets, getPrivateKeys } from "./lib/keysetManager";
import { runMetricsBackfill } from "./lib/metricsBackfill";
import { logSmtpStatus } from "./lib/email";
import { markDraining, markInitialized, operationMode } from "./lib/operationMode";
import { release } from "./lib/readiness";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

/**
 * Fail-fast startup checks. Any failure logs a fatal error and exits —
 * no silent degradation.
 */
async function runStartupChecks(): Promise<void> {
  const sessionSecret = process.env["SESSION_SECRET"];
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be set and at least 32 characters long");
  }

  const adminKey = process.env["ADMIN_API_KEY"];
  if (!adminKey) {
    throw new Error("ADMIN_API_KEY must be set");
  }
  if (adminKey.length < 32) {
    // Operator explicitly chose to keep a shorter key; warn loudly instead of
    // blocking startup. Brute force is still mitigated by the 500ms auth
    // delay and per-IP lockout, but a >= 32 char random key is recommended.
    logger.warn(
      "ADMIN_API_KEY is shorter than the recommended 32 characters; consider rotating to a longer random key",
    );
  }

  // DB connectivity.
  await db.execute(sql`SELECT 1`);

  // Every stored mint keypair must decrypt successfully with SESSION_SECRET.
  const keysets = await listKeysets();
  for (const keyset of keysets) {
    try {
      getPrivateKeys(keyset);
    } catch (err) {
      throw new Error(`Mint keyset ${keyset.id} failed to decrypt`, { cause: err });
    }
  }
  logger.info(
    { keysetsVerified: keysets.length },
    "Startup checks passed (env, DB, keyset decryption)",
  );
}

let server: Server | undefined;
let shuttingDown = false;

async function initialize(): Promise<void> {
  if (operationMode !== "active") {
    // No key access, DB queries, lazy configuration creation, or jobs.
    // This is a maintenance responder, NOT a writable recovered mint.
    logger.warn({ mode: operationMode, release }, "Passive mint: all ledger routes and jobs disabled");
    return;
  }
  await runStartupChecks();
  await verifyXpubOnStartup();
  await ensureGenesis();
  await runMetricsBackfill();
  logSmtpStatus();
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  markDraining();
  logger.info("Draining HTTP requests and mint background jobs");
  const deadline = setTimeout(() => {
    logger.error("Shutdown deadline exceeded; restore/promotion must verify this process is stopped");
    process.exit(1);
  }, 30_000);
  deadline.unref();
  try {
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        if (!server) { resolve(); return; }
        server.close((error) => error ? reject(error) : resolve());
      }),
      stopDepositWatcher(),
      stopEpochEngine(),
      startup,
    ]);
    await pool.end();
    clearTimeout(deadline);
    process.exit(0);
  } catch {
    logger.error("Graceful shutdown failed");
    process.exit(1);
  }
}

const startup = initialize();
startup
  .then(() => {
    if (shuttingDown) return;
    markInitialized();
    server = app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }

      logger.info({ port, mode: operationMode, release }, "Server listening");
      if (operationMode === "active") {
        startDepositWatcher();
        startEpochEngine();
      }
    });
  })
  .catch((err) => {
    logger.fatal({ err }, "Startup checks failed; refusing to start");
    process.exit(1);
  });

process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });

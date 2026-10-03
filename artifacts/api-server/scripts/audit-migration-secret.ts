/**
 * Read-only development audit. Never imports the app/startup/jobs and never
 * changes persisted secrets. Only aggregate counts leave this process.
 */
import { pool } from "@workspace/db";
import { decryptSecret } from "../src/lib/cryptoVault";
import { computeKeysetId, derivePublicKeys, DENOMINATIONS } from "../src/lib/keysetManager";

type KeyRow = { id: string; active: boolean; encrypted_keys: string };
type ConfigRow = { xpub_encrypted: string | null; smtp_pass_encrypted: string | null };

function audit(keys: KeyRow[], configs: ConfigRow[]) {
  const result = {
    keysets: { total: keys.length, decrypted: 0, identityMatched: 0, failed: 0 },
    activeKeysets: { total: 0, identityMatched: 0 },
    encryptedConfig: { total: 0, decrypted: 0, failed: 0 },
  };
  for (const row of keys) {
    if (row.active) result.activeKeysets.total++;
    try {
      const plain = decryptSecret(row.encrypted_keys);
      result.keysets.decrypted++;
      const map = JSON.parse(plain);
      if (!map || typeof map !== "object" || Array.isArray(map) ||
          Object.keys(map).length !== DENOMINATIONS.length ||
          !DENOMINATIONS.every((d) => typeof map[String(d)] === "string" &&
            /^[0-9a-f]{64}$/i.test(map[String(d)])) ||
          computeKeysetId(derivePublicKeys(map)) !== row.id) {
        throw new Error("Invalid key map or identity");
      }
      result.keysets.identityMatched++;
      if (row.active) result.activeKeysets.identityMatched++;
    } catch {
      result.keysets.failed++;
    }
  }
  for (const row of configs) {
    for (const bundle of [row.xpub_encrypted, row.smtp_pass_encrypted]) {
      if (bundle === null) continue;
      result.encryptedConfig.total++;
      try {
        if (!decryptSecret(bundle)) throw new Error("Empty value");
        result.encryptedConfig.decrypted++;
      } catch {
        result.encryptedConfig.failed++;
      }
    }
  }
  return result;
}

let stage = "checking audit scope";
async function main() {
  if (process.argv[2] !== "--read-only-development") {
    stage = "requiring explicit audit argument";
    throw new Error("Explicit development-only audit required");
  }
  // Obtain this fingerprint immediately beforehand through executeSql with
  // environment: development. A shell environment label alone is insufficient.
  const expectedTarget = process.argv[3];
  if (!expectedTarget || !/^[0-9a-f]{32}$/.test(expectedTarget)) {
    stage = "requiring independently verified development target";
    throw new Error("Expected development target required");
  }
  stage = "checking secret availability";
  const current = process.env.SESSION_SECRET;
  const candidate = process.env.MIGRATION_SOURCE_SESSION_SECRET;
  if (!current || !candidate) throw new Error("Required validation secrets missing");
  stage = "connecting to development database";
  const client = await pool.connect();
  try {
    stage = "opening read-only transaction";
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '10s'");
    stage = "matching independently verified development database";
    const target = await client.query<{ fingerprint: string }>(
      "SELECT md5(current_database() || ':' || coalesce(inet_server_addr()::text, 'local') || ':' || current_user || ':' || oid::text) AS fingerprint FROM pg_database WHERE datname = current_database()",
    );
    if (target.rows[0]?.fingerprint !== expectedTarget) {
      throw new Error("Wrong database target");
    }
    stage = "reading encrypted keysets";
    const keys = await client.query<KeyRow>(
      "SELECT id, active, encrypted_keys FROM keysets",
    );
    stage = "reading encrypted configuration";
    const configs = await client.query<ConfigRow>(
      "SELECT xpub_encrypted, smtp_pass_encrypted FROM admin_config",
    );
    stage = "validating encrypted material";
    const currentResult = audit(keys.rows, configs.rows);
    let candidateResult;
    try {
      // Only this short-lived process changes its local variable; workspace
      // settings, other processes, and the database are untouched.
      process.env.SESSION_SECRET = candidate;
      candidateResult = audit(keys.rows, configs.rows);
    } finally {
      process.env.SESSION_SECRET = current;
    }
    await client.query("ROLLBACK");
    process.stdout.write(JSON.stringify({
      databaseScope: "current development connection",
      readOnly: true,
      current: currentResult,
      suppliedSource: candidateResult,
      sourceMatchesAllStoredMaterial: keys.rows.length > 0 &&
        candidateResult.keysets.failed === 0 &&
        candidateResult.encryptedConfig.failed === 0,
      promotionAuthorized: false,
    }, null, 2) + "\n");
  } finally {
    // No raw errors, row data, key IDs, plaintext or credentials in output.
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

main()
  .catch(() => {
    process.stderr.write(`Read-only audit stopped at ${stage}; no secrets or database records were changed.\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
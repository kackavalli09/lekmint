import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";

const requestedMode = process.argv[2];
if (!requestedMode) {
  // Use isolated children: do not connect to the project's real DB or secrets.
  for (const mode of ["standby", "maintenance", "active"]) {
    const result = spawnSync(process.execPath, [process.argv[1]!, mode], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        MINT_OPERATION_MODE: mode,
        DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:1/fixture",
        MINT_RELEASE_ID: "fixture-release",
      },
      stdio: "inherit",
      timeout: 20000,
    });
    assert.equal(result.status, 0, `${mode} checks failed`);
  }
} else {
  const {
    parseOperationMode, parseTrustProxy, isOperationalProbe, isServingTransactions,
    markInitialized, markDraining,
  } = await import("../src/lib/operationMode");
  assert.equal(parseOperationMode(undefined), "active");
  assert.equal(parseOperationMode("standby"), "standby");
  for (const invalid of ["", "ACTIVE", "active ", "stand-by", "true"]) {
    assert.throws(() => parseOperationMode(invalid));
  }
  assert.equal(parseTrustProxy(undefined), 1);
  assert.equal(parseTrustProxy("0"), 0);
  assert.deepEqual(parseTrustProxy("loopback, 10.0.0.0/8"), ["loopback", "10.0.0.0/8"]);
  assert.throws(() => parseTrustProxy("true"));
  assert.equal(isOperationalProbe("POST", "/readyz"), false);
  assert.equal(isOperationalProbe("GET", "/readyz/extra"), false);
  assert.equal(isOperationalProbe("HEAD", "/healthz/"), true);
  assert.equal(isServingTransactions(), false);

  const { default: express } = await import("express");
  const { operationGate } = await import("../src/middleware/operationGate");
  const fixture = express();
  let routeHits = 0;
  fixture.use("/api", operationGate);
  fixture.all("/api/{*path}", (_req, res) => { routeHits++; res.sendStatus(204); });
  const server = fixture.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
    const response = await fetch(`${base}/api/admin/settings`, { method });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(routeHits, 0);
  assert.equal((await fetch(`${base}/api/healthz`)).status, 204);
  markInitialized();
  assert.equal(isServingTransactions(), requestedMode === "active");
  assert.equal((await fetch(`${base}/api/mint/issue`, { method: "POST" })).status,
    requestedMode === "active" ? 204 : 503);
  markDraining();
  assert.equal((await fetch(`${base}/api/v1/swap`, { method: "POST" })).status, 503);
  await new Promise<void>((resolve) => server.close(() => resolve()));

  if (requestedMode !== "active") {
    // Test the actual router tree too: no DB / crypto credentials available.
    const { default: app } = await import("../src/app");
    const { pool } = await import("@workspace/db");
    const actual = app.listen(0, "127.0.0.1");
    await once(actual, "listening");
    const addr = actual.address();
    assert.ok(addr && typeof addr !== "string");
    const url = `http://127.0.0.1:${addr.port}/api`;
    for (const path of ["/v1/info", "/admin/settings", "/tokenomics", "/mint/status/fixture"]) {
      assert.equal((await fetch(`${url}${path}`)).status, 503);
    }
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    const response = await fetch(`${url}/readyz`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: "not_ready", mode: requestedMode, release: "fixture-release",
    });
    assert.equal(pool.totalCount, 0, "Passive health and routes must never connect to database");
    await new Promise<void>((resolve) => actual.close(() => resolve()));
    await pool.end();
  }
  process.stdout.write(`${requestedMode}: operation gate, probe and shutdown checks passed\n`);
}
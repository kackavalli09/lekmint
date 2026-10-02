import test from "node:test";
import assert from "node:assert/strict";
import {
  readConfig, initialState, encodeState, decodeState, checkReady,
  createIssueStore, runMonitor,
} from "./monitor.mjs";

function harness() {
  let durable = initialState();
  let ready = true;
  let timestamp = "2026-01-01T00:00:00.000Z";
  let mailFails = false;
  const messages = [];
  const attempts = [];
  const store = {
    async load() { return structuredClone(durable); },
    async save(state) { durable = structuredClone(state); },
  };
  return {
    store, messages, attempts,
    state: () => structuredClone(durable),
    setState: value => { durable = structuredClone(value); },
    ready: value => { ready = value; },
    time: value => { timestamp = value; },
    mailFails: value => { mailFails = value; },
    run: () => runMonitor({
      store, check: async () => ready, now: () => timestamp,
      send: async event => {
        attempts.push(event);
        if (mailFails) throw new Error("secret-smtp-error");
        messages.push(event);
      },
    }),
  };
}

test("normal readiness is quiet and the second failed check alerts once", async () => {
  const h = harness();
  await h.run();
  assert.equal(h.messages.length, 0);
  h.ready(false);
  await h.run();
  assert.equal(h.state().failures, 1);
  assert.equal(h.messages.length, 0);
  await h.run();
  assert.equal(h.messages[0].kind, "outage");
  assert.equal(h.state().outage, true);
  for (let i = 0; i < 12; i++) await h.run();
  assert.equal(h.messages.length, 1);
});

test("a delayed schedule counts observations, not missed five-minute slots", async () => {
  const h = harness();
  h.ready(false);
  await h.run();
  h.time("2026-01-02T12:00:00.000Z");
  await h.run();
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].at, "2026-01-02T12:00:00.000Z");
});

test("isolated failure resets; recovery sends once and a new incident may alert", async () => {
  const h = harness();
  h.ready(false);
  await h.run();
  h.ready(true);
  await h.run();
  assert.equal(h.state().failures, 0);
  assert.equal(h.messages.length, 0);
  h.ready(false);
  await h.run();
  await h.run();
  h.ready(true);
  h.time("2026-01-01T01:00:00.000Z");
  await h.run();
  await h.run();
  assert.deepEqual(h.messages.map(event => event.kind), ["outage", "recovery"]);
  h.ready(false);
  h.time("2026-01-01T02:00:00.000Z");
  await h.run();
  await h.run();
  assert.deepEqual(h.messages.map(event => event.kind), ["outage", "recovery", "outage"]);
});

test("SMTP failure is sanitized, persisted, and retried next run without a new event", async () => {
  const h = harness();
  h.ready(false);
  h.mailFails(true);
  await h.run();
  await assert.rejects(h.run(), /Email delivery failed; notification retained/);
  assert.equal(h.state().queue.length, 1);
  assert.equal(h.state().queue[0].status, "queued");
  h.mailFails(false);
  await h.run();
  await h.run();
  assert.equal(h.messages.length, 1);
  assert.equal(h.attempts.length, 2);
  assert.equal(h.state().queue.length, 0);
});

test("recovery while outage email is pending retains both events in order", async () => {
  const h = harness();
  h.ready(false);
  await h.run();
  h.mailFails(true);
  await assert.rejects(h.run(), /Email delivery failed/);
  h.ready(true);
  h.mailFails(false);
  await h.run();
  assert.deepEqual(h.messages.map(event => event.kind), ["outage", "recovery"]);
});

test("recovery SMTP failure also retries only the recovery notification", async () => {
  const h = harness();
  h.ready(false);
  await h.run();
  await h.run();
  h.ready(true);
  h.mailFails(true);
  await assert.rejects(h.run(), /Email delivery failed/);
  h.mailFails(false);
  await h.run();
  await h.run();
  assert.deepEqual(h.messages.map(event => event.kind), ["outage", "recovery"]);
});

test("missing or corrupt durable state never resets and sends no alert", async () => {
  const h = harness();
  h.setState(null);
  h.ready(false);
  await assert.rejects(h.run(), /state is invalid/);
  assert.equal(h.attempts.length, 0);
  assert.throws(() => decodeState(""), /missing or malformed/);
  assert.deepEqual(decodeState(`${encodeState(initialState())}\n`), initialState());
  assert.throws(() => decodeState(encodeState(initialState()).replace('"version": 1', '"version": 2')), /invalid/);
});

test("persistence failure before delivery aborts without sending", async () => {
  const h = harness();
  h.ready(false);
  await h.run();
  h.store.save = async () => { throw new Error("storage failed"); };
  await assert.rejects(h.run(), /storage failed/);
  assert.equal(h.attempts.length, 0);
});

test("a delivery claim must persist before SMTP is attempted", async () => {
  const h = harness();
  h.ready(false);
  await h.run();
  const save = h.store.save;
  let writes = 0;
  h.store.save = async state => {
    if (++writes === 2) throw new Error("claim failed");
    await save(state);
  };
  await assert.rejects(h.run(), /claim failed/);
  assert.equal(h.attempts.length, 0);
  h.store.save = save;
  await h.run();
  assert.equal(h.messages.length, 1);
});

test("loss after SMTP success leaves an ambiguous marker and prevents an alert storm", async () => {
  const h = harness();
  h.ready(false);
  await h.run();
  const save = h.store.save;
  let writes = 0;
  h.store.save = async state => {
    if (++writes === 3) throw new Error("final persistence failed");
    await save(state);
  };
  await assert.rejects(h.run(), /final persistence failed/);
  assert.equal(h.messages.length, 1);
  assert.equal(h.state().queue[0].status, "sending");
  h.store.save = save;
  for (let i = 0; i < 5; i++) await assert.rejects(h.run(), /delivery is ambiguous/);
  assert.equal(h.messages.length, 1);
});

test("readiness requires successful JSON with ready AND active; redirects are forbidden", async () => {
  for (const [payload, status, expected] of [
    [{ status: "ready", mode: "active", release: "1" }, 200, true],
    [{ status: "ready", mode: "standby" }, 200, false],
    [{ status: "ready", mode: "maintenance" }, 200, false],
    [{ status: "not_ready", mode: "active" }, 200, false],
    [{ status: "ready" }, 200, false],
    [{ status: "ready", mode: "active" }, 503, false],
    ["not json", 200, false],
  ]) {
    const result = await checkReady("https://example.com/api/readyz?token=private", async (_, options) => {
      assert.equal(options.redirect, "error");
      assert.ok(options.signal);
      return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status });
    });
    assert.equal(result, expected);
  }
  assert.equal(await checkReady("https://example.com", async () => { throw new Error("token=private"); }), false);
  assert.equal(await checkReady("https://example.com", async () => new Response("x".repeat(16385))), false);
});

const validEnv = {
  MINT_MONITOR_URL: "https://mint.example.com/api/readyz",
  GITHUB_REPOSITORY: "owner/repo", MINT_MONITOR_STATE_ISSUE: "1",
  GITHUB_TOKEN: "test-token", MAILGUN_SMTP_USER: "test-user", MAILGUN_SMTP_PASS: "test-pass",
};
test("configuration failures are distinct, redacted, and HTTPS is mandatory", () => {
  assert.throws(() => readConfig({}), /Missing configuration: MINT_MONITOR_URL/);
  for (const url of ["http://example.com", "https://user:secret@example.com", "invalid?secret=value"]) {
    assert.throws(() => readConfig({ ...validEnv, MINT_MONITOR_URL: url }), error =>
      !error.message.includes("secret") && /configuration|HTTPS/.test(error.message));
  }
  assert.throws(() => readConfig({ ...validEnv, MAILGUN_SMTP_PASS: "" }), /Missing configuration: MAILGUN_SMTP_PASS/);
  assert.equal(readConfig(validEnv).to, "info@lekmint.cash");
  assert.equal(readConfig(validEnv).smtp.requireTLS, true);
});

test("GitHub issue store round-trips state and retries transient failures", async () => {
  let body = encodeState(initialState());
  let calls = 0;
  const store = createIssueStore(readConfig(validEnv), async (_, options) => {
    calls++;
    if (calls === 1) return new Response("private transport details", { status: 503 });
    if (options.method === "PATCH") body = JSON.parse(options.body).body;
    return Response.json({ state: "open", body });
  }, async () => {});
  const state = await store.load();
  state.failures = 1;
  await store.save(state);
  assert.equal((await store.load()).failures, 1);
  assert.equal(calls, 4);
});

test("state issue loss, closure, rejected writes and exhausted retries fail explicitly", async () => {
  const config = readConfig(validEnv);
  const missing = createIssueStore(config, async () => new Response("secret", { status: 404 }));
  await assert.rejects(missing.load(), /HTTP 404/);
  const closed = createIssueStore(config, async () => Response.json({ state: "closed", body: encodeState(initialState()) }));
  await assert.rejects(closed.load(), /open issue/);
  const mismatch = createIssueStore(config, async () => Response.json({ state: "open", body: "not saved" }));
  await assert.rejects(mismatch.save(initialState()), /did not confirm/);
  let calls = 0;
  const unreachable = createIssueStore(config, async () => {
    calls++;
    throw new Error("secret from API");
  }, async () => {});
  await assert.rejects(unreachable.load(), /State storage request failed/);
  assert.equal(calls, 3);
});
export class MonitorError extends Error {}

export function readConfig(env) {
  const required = (key) => {
    if (!env[key]?.trim()) throw new MonitorError(`Missing configuration: ${key}`);
    return env[key].trim();
  };
  let url;
  try {
    url = new URL(required("MINT_MONITOR_URL"));
  } catch (error) {
    if (error instanceof MonitorError) throw error;
    throw new MonitorError("Invalid configuration: MINT_MONITOR_URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new MonitorError("MINT_MONITOR_URL must use HTTPS without userinfo or a fragment");
  }
  const repository = required("GITHUB_REPOSITORY");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new MonitorError("Invalid configuration: GITHUB_REPOSITORY");
  }
  const issue = required("MINT_MONITOR_STATE_ISSUE");
  if (!/^[1-9]\d*$/.test(issue)) throw new MonitorError("Invalid configuration: MINT_MONITOR_STATE_ISSUE");
  const port = env.MINT_MONITOR_SMTP_PORT || "587";
  if (!["465", "587"].includes(port)) throw new MonitorError("SMTP port must be 465 or 587");
  const host = env.MINT_MONITOR_SMTP_HOST || "smtp.mailgun.org";
  if (!/^[a-zA-Z0-9.-]+$/.test(host)) throw new MonitorError("Invalid SMTP hostname");
  const address = (key, fallback) => {
    const value = env[key] || fallback;
    if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value)) {
      throw new MonitorError(`Invalid email configuration: ${key}`);
    }
    return value;
  };
  return {
    url: url.href,
    repository,
    issue,
    token: required("GITHUB_TOKEN"),
    smtp: {
      host, port: Number(port), secure: port === "465", requireTLS: true,
      auth: { user: required("MAILGUN_SMTP_USER"), pass: required("MAILGUN_SMTP_PASS") },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
      logger: false, debug: false,
    },
    from: address("MINT_MONITOR_FROM", "monitor@lekmint.cash"),
    to: address("MINT_MONITOR_TO", "info@lekmint.cash"),
  };
}

export function initialState() {
  return {
    version: 1, failures: 0, outage: false, incidentStartedAt: null,
    lastCheckAt: null, queue: [],
  };
}

const isTimestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
export function validateState(state) {
  if (!state || state.version !== 1 ||
      !Number.isInteger(state.failures) || state.failures < 0 || state.failures > 2 ||
      typeof state.outage !== "boolean" ||
      (state.lastCheckAt !== null && !isTimestamp(state.lastCheckAt)) ||
      (state.incidentStartedAt !== null && !isTimestamp(state.incidentStartedAt)) ||
      (state.outage !== (state.incidentStartedAt !== null)) ||
      (state.outage !== (state.failures === 2)) ||
      !Array.isArray(state.queue) || state.queue.length > 100 ||
      state.queue.some(event => !event || !["outage", "recovery"].includes(event.kind) ||
        !["queued", "sending"].includes(event.status) ||
        !isTimestamp(event.at) || !isTimestamp(event.incident))) {
    throw new MonitorError("Monitor state is invalid; restore it before monitoring (no automatic reset)");
  }
  return state;
}

export const STATE_HEADER = "Lek Mint outage monitor state v1 — do not edit while enabled";
export function encodeState(state) {
  validateState(state);
  return `${STATE_HEADER}\n\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\`\n`;
}
export function decodeState(body) {
  const match = typeof body === "string" && body.trim().match(/^Lek Mint outage monitor state v1 — do not edit while enabled\n\n```json\n([\s\S]+)\n```$/);
  if (!match) throw new MonitorError("Monitor state is missing or malformed; no automatic reset");
  let state;
  try { state = JSON.parse(match[1]); }
  catch { throw new MonitorError("Monitor state JSON is invalid; no automatic reset"); }
  return validateState(state);
}

export async function checkReady(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      redirect: "error", signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return false;
    // Bound the response before parsing; an unhealthy endpoint must not exhaust memory.
    const reader = response.body?.getReader();
    if (!reader) return false;
    let bytes = 0;
    const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16384) { await reader.cancel(); return false; }
      chunks.push(value);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return payload?.status === "ready" && payload?.mode === "active";
  } catch {
    // Endpoint responses, query strings and transport errors may contain secrets.
    return false;
  }
}

export function createIssueStore(config, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const url = `https://api.github.com/repos/${config.repository}/issues/${config.issue}`;
  async function request(method, body) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${config.token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: "error", signal: AbortSignal.timeout(15000),
        });
        if (response.ok) {
          const data = await response.json();
          if (data.state !== "open" || data.pull_request) {
            throw new MonitorError("State issue must be an open issue, not a pull request");
          }
          return data;
        }
        if (response.status < 500 && response.status !== 429) {
          throw new MonitorError(`State storage unavailable (HTTP ${response.status}); monitoring aborted`);
        }
      } catch (error) {
        if (error instanceof MonitorError) throw error;
      }
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    }
    throw new MonitorError("State storage request failed; monitoring aborted");
  }
  return {
    async load() { return decodeState((await request("GET")).body); },
    async save(state) {
      const body = encodeState(state);
      const result = await request("PATCH", { body });
      if (result.body !== body) throw new MonitorError("State storage did not confirm the update");
    },
  };
}

export async function runMonitor({ store, check, send, now = () => new Date().toISOString() }) {
  const state = validateState(structuredClone(await store.load()));
  if (state.queue.some(event => event.status === "sending")) {
    throw new MonitorError("Notification delivery is ambiguous; inspect state and email before resuming");
  }
  const at = now();
  if (!isTimestamp(at)) throw new MonitorError("Invalid monitor clock");
  const ready = await check();
  state.lastCheckAt = at;
  if (ready) {
    state.failures = 0;
    if (state.outage) {
      state.queue.push({ kind: "recovery", at, incident: state.incidentStartedAt, status: "queued" });
      state.outage = false;
      state.incidentStartedAt = null;
    }
  } else {
    state.failures = Math.min(2, state.failures + 1);
    if (state.failures === 2 && !state.outage) {
      state.outage = true;
      state.incidentStartedAt = at;
      state.queue.push({ kind: "outage", at, incident: at, status: "queued" });
    }
  }
  // Never email unless the check and event are durably recorded.
  await store.save(state);
  while (state.queue.length) {
    state.queue[0].status = "sending";
    await store.save(state);
    try {
      await send({ ...state.queue[0] });
    } catch {
      state.queue[0].status = "queued";
      await store.save(state);
      throw new MonitorError("Email delivery failed; notification retained for next run");
    }
    state.queue.shift();
    // If this fails, the durable 'sending' marker prevents an automatic duplicate.
    await store.save(state);
  }
  return { ready, failures: state.failures, outage: state.outage };
}
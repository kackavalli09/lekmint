// Liveness must stay green in standby. Financial readiness requires active + DB.
const kind = process.argv[2];
if (!["live", "ready"].includes(kind)) throw new Error("Use live or ready");
const route = kind === "ready" ? "/api/readyz" : "/api/healthz";
try {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || "3000"}${route}`, {
    signal: AbortSignal.timeout(4000),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
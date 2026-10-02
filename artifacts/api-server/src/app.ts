import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes";
import { globalLimiter } from "./middleware/rateLimit";
import { logger } from "./lib/logger";
import { operationGate } from "./middleware/operationGate";
import { parseTrustProxy } from "./lib/operationMode";

const app: Express = express();

// Configure the actual proxy boundary on StartOS; never trust arbitrary headers.
app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));
app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: {
      // Pure JSON API: lock everything down to self.
      directives: {
        defaultSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    frameguard: { action: "deny" },
    referrerPolicy: { policy: "no-referrer" },
    strictTransportSecurity: { maxAge: 15552000, includeSubDomains: true },
    noSniff: true,
  }),
);

/**
 * CORS allowlist. Same-origin requests carry no Origin header and are always
 * allowed (both frontends are served from the same origin via path routing).
 * Cross-origin requests are allowed only from FRONTEND_ORIGIN / ADMIN_ORIGIN
 * (if configured) and the Replit dev/prod domains; anything else gets 403.
 */
function allowedOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const envKey of ["FRONTEND_ORIGIN", "ADMIN_ORIGIN"] as const) {
    const value = process.env[envKey];
    if (value) origins.add(value.replace(/\/$/, ""));
  }
  for (const domain of (process.env["REPLIT_DOMAINS"] ?? "").split(",")) {
    if (domain.trim()) origins.add(`https://${domain.trim()}`);
  }
  return origins;
}

/**
 * The standard Cashu protocol surface (/api/v1/*) must be reachable from any
 * browser wallet origin (cashu.me, etc.) — it is a public, unauthenticated
 * protocol by design. Everything else keeps the strict allowlist.
 */
function isPublicWalletPath(path: string): boolean {
  return path === "/api/v1" || path.startsWith("/api/v1/");
}

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (
    origin &&
    !isPublicWalletPath(req.path) &&
    !allowedOrigins().has(origin.replace(/\/$/, ""))
  ) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }
  next();
});
app.use(
  cors((req, callback) => {
    if (isPublicWalletPath(req.path)) {
      callback(null, { origin: true });
      return;
    }
    const origin = req.headers.origin;
    callback(null, {
      origin: !origin || allowedOrigins().has(origin.replace(/\/$/, "")),
    });
  }),
);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use("/api", globalLimiter, operationGate, router);

export default app;

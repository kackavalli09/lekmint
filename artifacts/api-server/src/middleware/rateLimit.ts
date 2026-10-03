import rateLimit from "express-rate-limit";

/**
 * Per-IP rate limits (in-process store — sufficient for the single-instance
 * deployment). Limited requests get a 429 with a Retry-After header
 * (standardHeaders + legacyHeaders retryAfter behavior of express-rate-limit).
 */

const common = {
  standardHeaders: true as const,
  legacyHeaders: false,
  message: { error: "Too many requests, slow down" },
};

/** Global backstop: 100 requests/minute per IP across the whole API. */
export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  ...common,
});

/** Address derivation is expensive and enumerable: 5/minute per IP. */
export const mintRequestLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  ...common,
  message: { error: "Too many mint requests, try again in a minute" },
});

/** Recovery lookups could enumerate deposit addresses: 3/minute per IP. */
export const recoverLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 3,
  ...common,
  message: { error: "Too many recovery attempts, try again in a minute" },
});

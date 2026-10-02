import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { ZodTypeAny } from "zod";

interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Zod validation middleware factory. Rejects malformed requests with a
 * structured 400 before any business logic runs; on success replaces the
 * request slot with the parsed (coerced, defaulted, stripped) data.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    for (const slot of ["params", "query", "body"] as const) {
      const schema = schemas[slot];
      if (!schema) continue;
      const parsed = schema.safeParse(slot === "body" ? (req[slot] ?? {}) : req[slot]);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request",
          details: parsed.error.issues.map((issue) => ({
            path: `${slot}.${issue.path.join(".")}`,
            message: issue.message,
          })),
        });
        return;
      }
      if (slot === "query") {
        // Express 5 exposes req.query via a getter; stash parsed values instead.
        res.locals["query"] = parsed.data;
      } else {
        (req as unknown as Record<string, unknown>)[slot] = parsed.data;
      }
    }
    next();
  };
}

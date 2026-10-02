import type { RequestHandler } from "express";
import {
  isOperationalProbe,
  isServingTransactions,
  operationMode,
} from "../lib/operationMode";

export const operationGate: RequestHandler = (req, res, next) => {
  if (isOperationalProbe(req.method, req.path) || isServingTransactions()) {
    next();
    return;
  }
  // Block reads too: existing GET handlers can lazily create configuration.
  // A passive host must not expose stale token/spend state as authoritative.
  res.set("Cache-Control", "no-store");
  res.set("Retry-After", "60");
  res.status(503).json({
    error: "Mint transactions are paused. Your local wallet data has not been changed.",
    code: "MINT_UNAVAILABLE",
    mode: operationMode,
  });
};
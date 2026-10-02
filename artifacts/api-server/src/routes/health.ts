import { Router, type IRouter } from "express";
import { HealthCheckResponse, ReadinessCheckResponse } from "@workspace/api-zod";
import { VERSION } from "../version.js";
import { getReadiness } from "../lib/readiness";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  res.set("Cache-Control", "no-store");
  const data = HealthCheckResponse.parse({ status: "ok", version: VERSION });
  res.json(data);
});

router.get("/readyz", async (_req, res): Promise<void> => {
  const data = ReadinessCheckResponse.parse(await getReadiness());
  res.set("Cache-Control", "no-store");
  res.set("CDN-Cache-Control", "no-store");
  if (data.status !== "ready") res.set("Retry-After", "60");
  res.status(data.status === "ready" ? 200 : 503).json(data);
});

export default router;

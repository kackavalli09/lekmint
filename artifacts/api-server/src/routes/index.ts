import { Router, type IRouter } from "express";
import healthRouter from "./health";
import mintRouter from "./mint";
import tokensRouter from "./tokens";
import tokenomicsRouter from "./tokenomics";
import adminRouter from "./admin";
import cashuV1Router from "./cashuV1";

const router: IRouter = Router();

// Standard Cashu protocol surface for external wallets (mint URL <origin>/api).
router.use("/v1", cashuV1Router);

router.use(healthRouter);
router.use(mintRouter);
router.use(tokensRouter);
router.use(tokenomicsRouter);
router.use(adminRouter);

export default router;

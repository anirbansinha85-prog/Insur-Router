import { Router, type IRouter } from "express";
import authRouter from "./auth";
import healthRouter from "./health";
import providersRouter from "./providers";
import applicationsRouter from "./applications";
import dashboardRouter from "./dashboard";
import dmsRouter from "./dms";
import ingestRouter from "./ingest";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(providersRouter);
router.use(applicationsRouter);
router.use(dashboardRouter);
router.use(dmsRouter);
router.use(ingestRouter);

export default router;

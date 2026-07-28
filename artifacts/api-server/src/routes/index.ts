import { Router, type IRouter } from "express";
import healthRouter from "./health";
import providersRouter from "./providers";
import applicationsRouter from "./applications";
import dashboardRouter from "./dashboard";

const router: IRouter = Router();

router.use(healthRouter);
router.use(providersRouter);
router.use(applicationsRouter);
router.use(dashboardRouter);

export default router;

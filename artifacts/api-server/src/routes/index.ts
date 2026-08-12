import { Router, type IRouter } from "express";
import authRouter from "./auth";
import healthRouter from "./health";
import providersRouter from "./providers";
import applicationsRouter from "./applications";
import dashboardRouter from "./dashboard";
import dmsRouter from "./dms";
import ingestRouter from "./ingest";
import webhooksRouter from "./webhooks";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(providersRouter);
router.use(applicationsRouter);
router.use(dashboardRouter);
router.use(dmsRouter);
router.use(ingestRouter);
/*
 * Last, and outside every gate above it.
 *
 * A customer's phone talking to Meta talking to us — no service key, no
 * session, no dealership. The signature on each delivery is what replaces all
 * three, and a channel with no signing secret stored cannot receive at all.
 * See `webhooks.ts` for why that refusal is the honest failure.
 */
router.use(webhooksRouter);

export default router;

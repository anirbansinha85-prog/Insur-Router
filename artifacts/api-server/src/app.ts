import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { refuseOwnerCredential, requireAppRoleConfigured } from "@workspace/db";
import router from "./routes";
import { logger } from "./lib/logger";
import {
  allowedOrigins,
  requireServiceKeyConfigured,
  serviceKeyAuth,
} from "./lib/auth";
import { attachSession } from "./lib/session";

const app: Express = express();

// Fail at import time, not on the first unauthenticated request.
const serviceKey = requireServiceKeyConfigured();

// Same reasoning, one layer down. Without the restricted role the DDMS routes
// would fall back to the connection that bypasses row-level security, and every
// policy written in lib/db/sql/rls.sql would be inert with nothing saying so.
requireAppRoleConfigured();

// And the other half of that, which is the one that actually closes it: refuse
// to start while the unrestricted credential is still in reach. Choosing the
// restricted role is not isolation if the other one is one import away — the
// mistake would be a working query, which is the kind nothing reports.
refuseOwnerCredential();

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
app.use(cors({ origin: allowedOrigins(), credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Auth sits between the mount and the routes so every current and future route
// is covered by default. A route that should be public opts out by name in
// lib/auth.ts, which keeps the exemptions in one readable list rather than
// scattered across the routers.
// Two layers, answering two different questions. The service key asks "is this
// one of our processes"; the session asks "whose data is this". Neither
// substitutes for the other, and the key alone was what let any caller read any
// owner's customers by changing a number in a URL.
app.use("/api", serviceKeyAuth(serviceKey), attachSession, router);

export default app;

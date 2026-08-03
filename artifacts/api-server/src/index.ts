import app from "./app";
import { startDmsSyncScheduler } from "./lib/dms";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Started here rather than in app.ts so that importing the app — from a test,
  // or a script that just wants a route handler — never starts hitting a real
  // dealership's ERP as a side effect.
  const scheduler = startDmsSyncScheduler();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      scheduler.stop();
      process.exit(0);
    });
  }
});

#!/usr/bin/env node
/**
 * dev.mjs — starts the API server and the DDMS frontend together.
 *
 * Written as a Node script rather than a shell one-liner on purpose. pnpm hands
 * package scripts to cmd.exe on Windows, which does not understand `export`, and
 * Git Bash rewrites `/ddms/` into a Windows path on the way to Vite. Node has
 * neither problem, so this is the one entry point that works on both shells.
 *
 * Three things this encodes that are easy to get wrong by hand:
 *   - the API server needs `--env-file=.env.api`; nothing in its own package
 *     script supplies it, and without it the server dies on API_SERVICE_KEY
 *   - `PORT` and `API_PORT` are different variables. .env.api carries API_PORT,
 *     but index.ts reads PORT
 *   - Vite must not start before the API answers, or the first screen loads
 *     against a proxy target that is not listening yet
 *
 * Usage: pnpm run stack
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

const API_ENV_FILE = ".env.api";
const DDMS_PORT = Number(process.env.DDMS_PORT ?? 31280);
const DDMS_BASE_PATH = process.env.BASE_PATH ?? "/ddms/";
const DMS_MOCK_PORT = Number(process.env.DMS_PORT ?? 9090);
const HEALTH_TIMEOUT_MS = 60_000;

const paint = {
  api: (s) => `\x1b[36m[api ]\x1b[0m ${s}`,
  web: (s) => `\x1b[35m[web ]\x1b[0m ${s}`,
  dms: (s) => `\x1b[33m[dms ]\x1b[0m ${s}`,
  run: (s) => `\x1b[32m[stack]\x1b[0m ${s}`,
  bad: (s) => `\x1b[31m[stack]\x1b[0m ${s}`,
};

/** Parse a dotenv file just far enough to read a key. Not a general parser. */
function readEnvFile(file) {
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * The standing rule, checked rather than remembered: DATABASE_URL is the owner
 * credential and it bypasses row-level security. It belongs in .env, where the
 * CLI tools find it, and must never reach the API server — which is supposed to
 * hold only the three scoped roles. A server that quietly picked it up would
 * serve every tenant's rows to every tenant and nothing would look wrong.
 */
function refuseOwnerCredential(env) {
  if (env.DATABASE_URL === undefined) return;
  console.error(
    paint.bad(
      `DATABASE_URL is present in ${API_ENV_FILE}. That is the owner credential and it ` +
        `bypasses row-level security.`,
    ),
  );
  console.error(
    paint.bad(
      `Remove it from ${API_ENV_FILE} — it belongs in .env only. The API server runs on ` +
        `DATABASE_URL_APP / _WORKER / _LOGIN.`,
    ),
  );
  process.exit(1);
}

/**
 * Reach the database before starting anything, using the same role the login
 * route uses. This exists because a paused Supabase project does not look like
 * a database problem: /api/healthz never touches Postgres, so the server
 * reports healthy, every screen loads, and the failure surfaces only as a 500
 * on login that reads like a wrong password. A control that passes while the
 * thing it guards is down is worse than no control, so this runs first and
 * names the actual cause.
 */
async function requireDatabase() {
  const { createRequire } = await import("node:module");
  const req = createRequire(path.join(root, "scripts", "package.json"));
  const pg = req("pg");

  const fromFile = readEnvFile(path.join(root, API_ENV_FILE));
  const url = process.env.DATABASE_URL_LOGIN ?? fromFile.DATABASE_URL_LOGIN;
  if (!url) {
    console.error(paint.bad("DATABASE_URL_LOGIN is not set — cannot check the database."));
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    const r = await client.query("select count(*)::int as n from users");
    await client.end();
    console.log(paint.run(`database reachable — ${r.rows[0].n} users`));
  } catch (err) {
    try {
      await client.end();
    } catch {}
    console.error(paint.bad(`the database is not reachable: ${err.message}`));
    if (/not found/i.test(String(err.message))) {
      console.error(
        paint.bad(
          "That message comes from the pooler and almost always means the Supabase " +
            "project is PAUSED. Restore it at https://supabase.com/dashboard and run this again.",
        ),
      );
    }
    console.error(
      paint.bad("Not starting — login would fail with a 500 that looks like a wrong password."),
    );
    process.exit(1);
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

async function requireFreePort(port, who) {
  if (await portFree(port)) return;
  console.error(paint.bad(`Port ${port} is already in use — ${who} cannot start.`));
  console.error(
    paint.bad(
      `Find it with:  Get-NetTCPConnection -LocalPort ${port} | Select-Object OwningProcess`,
    ),
  );
  process.exit(1);
}

function run(cmd, args, opts, label) {
  const child = spawn(cmd, args, { cwd: root, ...opts });
  const relay = (stream, sink) => {
    let tail = "";
    stream.on("data", (chunk) => {
      const lines = (tail + chunk.toString()).split(/\r?\n/);
      tail = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) sink(label(line));
    });
  };
  relay(child.stdout, (s) => console.log(s));
  relay(child.stderr, (s) => console.error(s));
  return child;
}

/** Poll until the API answers, so Vite never starts against a dead proxy target. */
async function waitForHealth(port) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/api/healthz`);
      if (res.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function main() {
  const envPath = path.join(root, API_ENV_FILE);
  if (!existsSync(envPath)) {
    console.error(paint.bad(`${API_ENV_FILE} not found at ${envPath}.`));
    console.error(paint.bad(`It is gitignored, so a fresh clone will not have one.`));
    process.exit(1);
  }

  const apiEnv = readEnvFile(envPath);
  refuseOwnerCredential(apiEnv);

  const apiPort = Number(apiEnv.API_PORT ?? 8080);

  await requireFreePort(apiPort, "the API server");
  await requireFreePort(DDMS_PORT, "the DDMS frontend");
  await requireFreePort(DMS_MOCK_PORT, "the DMS mock");

  await requireDatabase();

  // 1. Build the API server. esbuild, ~3s.
  console.log(paint.run("building the API server…"));
  const built = await new Promise((resolve) => {
    const b = run(
      process.execPath,
      ["./artifacts/api-server/build.mjs"],
      { env: { ...process.env, NODE_ENV: "development" } },
      paint.api,
    );
    b.on("exit", resolve);
  });
  if (built !== 0) {
    console.error(paint.bad(`build failed (exit ${built}) — not starting anything.`));
    process.exit(1);
  }

  // 2. Start the API server. --env-file supplies the three scoped database roles
  //    and the service key; PORT is separate from API_PORT and must be passed.
  console.log(paint.run(`starting the API server on ${apiPort}…`));
  const api = run(
    process.execPath,
    [
      "--enable-source-maps",
      `--env-file=${API_ENV_FILE}`,
      "./artifacts/api-server/dist/index.mjs",
    ],
    { env: { ...process.env, NODE_ENV: "development", PORT: String(apiPort) } },
    paint.api,
  );

  if (!(await waitForHealth(apiPort))) {
    console.error(paint.bad(`the API server did not answer /api/healthz within 60s.`));
    api.kill();
    process.exit(1);
  }
  console.log(paint.run(`API healthy on http://localhost:${apiPort}`));

  // 3. Start the mock OEM DMS. The product reads a manufacturer's system it does
  //    not control and may never write to (R-5/R-40); this stands in for it
  //    locally. Without it every ingest path fails as "unavailable" after
  //    retries, which reads like a bug rather than a missing dependency.
  console.log(paint.run(`starting the DMS mock on ${DMS_MOCK_PORT}…`));
  const dms = run(
    process.execPath,
    ["./artifacts/dms-mock/src/index.ts"],
    { env: { ...process.env, DMS_PORT: String(DMS_MOCK_PORT) } },
    paint.dms,
  );

  // 4. Start Vite. Spawned directly rather than through pnpm so no shell touches
  //    BASE_PATH — Git Bash would rewrite "/ddms/" into a Windows path.
  console.log(paint.run(`starting the DDMS frontend on ${DDMS_PORT}…`));
  const web = run(
    process.execPath,
    ["./node_modules/vite/bin/vite.js", "--config", "vite.config.ts", "--host", "0.0.0.0"],
    {
      cwd: path.join(root, "artifacts", "ddms"),
      env: {
        ...process.env,
        NODE_ENV: "development",
        PORT: String(DDMS_PORT),
        BASE_PATH: DDMS_BASE_PATH,
        API_PORT: String(apiPort),
      },
    },
    paint.web,
  );

  setTimeout(() => {
    console.log("");
    console.log(paint.run(`open  http://localhost:${DDMS_PORT}${DDMS_BASE_PATH}`));
    console.log(paint.run(`ctrl-c stops all three.`));
    console.log("");
  }, 3000);

  // 4. Neither outlives the other, and neither outlives ctrl-c.
  let stopping = false;
  const stopAll = () => {
    if (stopping) return;
    stopping = true;
    console.log(paint.run("stopping…"));
    for (const child of [api, web, dms]) if (!child.killed) child.kill();
    setTimeout(() => process.exit(0), 500);
  };

  process.on("SIGINT", stopAll);
  process.on("SIGTERM", stopAll);

  api.on("exit", (code) => {
    if (stopping) return;
    console.error(paint.bad(`the API server exited (${code}). Stopping the frontend too.`));
    stopAll();
  });
  // The mock dying is not worth stopping a demo over: only the ingest screens
  // depend on it, and they degrade rather than break.
  dms.on("exit", (code) => {
    if (stopping) return;
    console.error(paint.bad(`the DMS mock exited (${code}). Ingest paths will report unavailable.`));
  });

  web.on("exit", (code) => {
    if (stopping) return;
    console.error(paint.bad(`the frontend exited (${code}). Stopping the API too.`));
    stopAll();
  });
}

main().catch((err) => {
  console.error(paint.bad(String(err?.stack ?? err)));
  process.exit(1);
});

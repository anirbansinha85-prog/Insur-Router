# InsurRouter

An autonomous two-wheeler insurance application routing dashboard. Insurance agents fill in the standardised MSA payload, select a provider, validate the data, and submit — the system routes to the provider's direct REST API or falls back to Playwright headless-browser automation.

## Run & Operate

- `pnpm --filter @workspace/insur-router run dev` — frontend (port auto from env)
- `pnpm --filter @workspace/api-server run dev` — API server (port 8080 in dev)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React 19 + Vite 7, Tailwind CSS 4, TanStack React Query, Wouter, Recharts, Framer Motion
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod v3, `drizzle-zod`
- API codegen: Orval 8 (from OpenAPI spec)
- Browser automation: Playwright (headless Chromium)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — single source of truth for API contracts
- `lib/db/src/schema/` — Drizzle table definitions (providers, applications, submission_logs, policies)
- `artifacts/api-server/src/routes/` — Express route handlers (providers, applications, dashboard)
- `artifacts/api-server/src/lib/api-executor.ts` — REST API execution stubs (add real providers here)
- `artifacts/api-server/src/lib/browser-executor.ts` — Playwright browser automation stubs (add real providers here)
- `artifacts/insur-router/src/` — React frontend

## Architecture decisions

- **MSA payload is the canonical data model**: all vehicle, owner, RTO data is stored flat in the `applications` table and assembled into the structured payload at execution time.
- **Dual execution engine**: `executeWithApi` and `executeWithBrowser` are independent modules. AUTO mode checks whether the provider has an `apiEndpoint`; if yes → API, otherwise → Browser.
- **Orval 8 + Zod v3 compatibility**: Orval 8.x generates `zod.int()` (v4 syntax) but this workspace pins Zod v3. The codegen script post-patches the generated file with `sed` to replace `zod.int()` → `zod.number().int()` and `zod.email()` → `zod.string().email()`.
- **Mock providers seeded**: 6 real-named providers are seeded with proper codes, brand colors, and mode defaults. Wire up real API keys via env vars named `<PROVIDER_CODE>_API_KEY`.

## Adding a real provider

1. Add the provider row via the Providers UI (or directly in DB).
2. For **API mode**: add `case "YOURCODE":` in `api-executor.ts`, map the MSA payload to the provider's schema, call their endpoint with your API key from `process.env.YOURCODE_API_KEY`.
3. For **BROWSER mode**: add `case "YOURCODE":` in `browser-executor.ts`, implement Playwright DOM selectors for their dealer portal.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- `pnpm --filter @workspace/api-spec run codegen` must be re-run after every OpenAPI spec change.
- After codegen, run `pnpm run typecheck:libs` before checking artifact packages so leaf typechecks see fresh workspace declarations.
- Playwright is imported dynamically inside `executeWithBrowser` to avoid startup cost when not needed.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

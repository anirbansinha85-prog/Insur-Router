# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A pnpm workspace holding **three products that share one database**, plus a
mobile capture app:

| Product | Path served | Package | What it does |
|---|---|---|---|
| **DDMS** | `/ddms` | `@workspace/ddms` | Owner-facing control panel across every showroom. Mirrors the dealer's own DMS read-only and shows what that system cannot: enquiries against the manufacturer's response clock, deals against our insurance record, job cards against the promise made to the customer, RTO files against whether the customer ever got their certificate. |
| **InsurRouter** | `/` | `@workspace/insur-router` | Agent-facing dashboard. Fill the MSA payload, pick an insurer, validate, submit. Routes to the provider's REST API or falls back to Playwright browser automation. |
| **VeloDocs** | `/doc-ingest` | `@workspace/doc-ingest` | Document ingestion. Pulls vehicle/owner data from a dealer DMS, a scraped portal, or OCR of an RC book, lets a human correct low-confidence fields, then pushes a draft into InsurRouter. |
| **RC Capture** | `/rc-capture` | `@workspace/rc-capture` | Expo mobile app. Camera capture → OCR review → push to InsurRouter. |

**Each product is complete on its own and none contains another.** DDMS is the
owner's umbrella and links out to the other two rather than embedding them;
InsurRouter is a working insurance product with no DDMS screens in it. The three
DDMS screens briefly lived inside InsurRouter — that was a shortcut taken
because InsurRouter already had the API proxy and the components, and it is not
a precedent. New cross-product work gets its own artifact.

They still share **one API process** today, with DDMS's routes isolated in
`api-server/src/routes/dms.ts`. Splitting that into separate services is
mechanical when deployment calls for it; nothing above the route layer assumes
one process.

Both web products are served by **one Express API** (`@workspace/api-server`) on
`/api`. VeloDocs does not call InsurRouter over HTTP — `POST /api/ingest/push`
inserts straight into the shared `applications` table.

## API authentication

Every `/api` route except `/api/healthz` requires a shared service key, sent as
either `Authorization: Bearer <key>` or `x-api-key: <key>`. **The api-server
throws at startup if `API_SERVICE_KEY` is missing or shorter than 32
characters** — a server that quietly runs unauthenticated is the failure this
prevents. Exemptions are named in one list in `api-server/src/lib/auth.ts`.

Browsers never hold the key: each Vite dev server reads it from the
workspace-root `.env` via `loadEnv` and injects the header into its `/api`
proxy, so it stays in Node and out of the bundle. Anything served to a browser
in production needs the same injection at the reverse proxy.

`cors()` is no longer argument-less (which reflected every origin on the
internet); origins come from `CORS_ORIGINS`, defaulting to the three local dev
servers.

**This authenticates a process, not a person**, and cannot say whose data is
being asked for. That is what the session layer below is for. Neither
substitutes for the other.

## Who is asking: sessions, scope, and row-level security

Three layers, each answering a different question. Skipping any one of them
leaves a hole the other two cannot cover.

| Layer | Question | Where |
|---|---|---|
| Service key | is this one of our processes? | `lib/auth.ts` |
| Session | who is signed in? | `lib/session.ts`, `users` + `sessions` |
| Row-level security | what may that person's connection see? | `lib/db/sql/rls.sql` |

**Sessions.** `POST /api/auth/login` verifies a scrypt password and issues an
httpOnly cookie. Only the SHA-256 of the token is stored, so the table is not a
list of usable credentials. `attachSession` runs app-wide and never rejects;
`requireUser` rejects. `assertShowroomAccess` answers **404, not 403**, on a
showroom the session's owner does not hold — a 403 confirms it exists.

**The two database roles**, and they are not interchangeable:

| | `DATABASE_URL` (`postgres`) | `DATABASE_URL_APP` (`ddms_app`) |
|---|---|---|
| Owns the tables | yes | no |
| `bypassrls` | **yes** | no |
| Grants on `users` / `sessions` | all | **none** |
| Used by | drizzle-kit, seeds, InsurRouter and VeloDocs routes, the sync scheduler | the DDMS request path |

The DMS router mounts `sessionScope`, which checks out a connection from the
`ddms_app` pool and sets `app.session_token` on it for the life of the request.
`db` from `@workspace/db` is an `AsyncLocalStorage`-backed proxy: inside a scope
it is that connection, outside one it is the owner pool. **No caller passes a
handle around**, which is the whole reason it is a proxy — `lib/db/src/scope.ts`
has the argument.

Policies resolve the tenant through `app.current_owner_id()`, a `security
definer` function that reads `sessions` and `users`. `ddms_app` has no grants on
those tables, so it cannot read a token hash and therefore cannot invent one:
holding its credentials gets you exactly as far as holding no session at all.

**Consequences worth knowing before you write a query:**

- Inside the DMS router, a query with **no** tenant filter returns only the
  signed-in owner's rows. That is the point, not a coincidence to rely on
  silently — write the filter anyway, and let RLS be the backstop.
- `applications.showroom_id` is nullable, and a null belongs to **nobody**
  under RLS. Hand, OCR and scrape applications are invisible to DDMS by design.
  They are still reachable through InsurRouter, which runs on the owner pool.
- A new table arrives with RLS enabled and no policy, so `ddms_app` cannot read
  it at all. **Run `pnpm run db:rls` after every `db:push`**, and add the table
  to `rls.sql` first. A blank DDMS screen is the intended failure.
- Anything genuinely cross-tenant — the sync scheduler is the only one today —
  imports `ownerDb` by name rather than `db`, so reaching past a tenant is a
  visible decision instead of a missing scope.

**Mount router-wide gates on their path prefix**, never path-less.
`router.use(requireUser)` inside the DMS router runs for every request that
*reaches* that router, including ones destined for a router mounted after it —
which is how VeloDocs's ingest routes silently answered 401 for a whole
session. Use `router.use("/dms", requireUser, sessionScope)`.

## Workspace layout

```
artifacts/            deployable apps
  ddms/               React 19 + Vite — owner control panel, its own service
  api-server/         Express 5 API — the only backend
    src/routes/       health, providers, applications, dashboard, dms, ingest
    src/lib/          api-executor.ts, browser-executor.ts, auth.ts, logger.ts
    src/lib/dms/      client, adapters, mirror sync, five worklists, panel,
                      scheduler
  insur-router/       React 19 + Vite — InsurRouter frontend
  doc-ingest/         React 19 + Vite — VeloDocs frontend
  rc-capture/         Expo mobile app
  mockup-sandbox/     component preview canvas, not a product
  dms-mock/           fake OEM dealer system, dev fixture — see its README
docs/                 domain reference (issuance field requirements, IRDAI rates)
lib/                  shared packages
  db/                 Drizzle schema + the two pg pools. Source of truth for
                      tables. src/scope.ts holds the request-scoped handle;
                      sql/rls.sql holds the row-level security policies.
  api-spec/           openapi.yaml — source of truth for API contracts
  api-zod/            GENERATED Zod schemas + types. Do not hand-edit.
  api-client-react/   GENERATED React Query hooks. Do not hand-edit.
scripts/              one-off scripts
```

**Two sources of truth, one direction of flow:**
`lib/db/src/schema/` defines the tables. `lib/api-spec/openapi.yaml` defines the
API. `api-zod` and `api-client-react` are generated **from openapi.yaml** — edit
the spec, then regenerate. Never edit `lib/api-zod/src/generated/` directly.

```
pnpm --filter @workspace/api-spec run codegen   # after every openapi.yaml change
pnpm run typecheck:libs                         # before checking leaf packages
```

## Data model

Seventeen tables, all in `lib/db/src/schema/`. Every one of them has RLS enabled;
which of them `ddms_app` may read, and on what terms, is in `lib/db/sql/rls.sql`.

**The owner tier** — who the data belongs to:

- **owners** — one dealership group.
- **showrooms** — one physical outlet. **A showroom is not a dealer code**: one
  owner may hold two brands at one address, one brand may be sold from three
  outlets, and a service centre has no dealer code at all. `legalName`/`gstin`
  live here because a group routinely spans legal entities.
- **showroom_dms_accounts** — the link to an OEM's system, one row per
  (showroom, OEM). `dealerCode` is globally unique, which is what lets a DMS
  pull resolve straight back to an owner without the caller saying who they are.
  `insuranceChannel` (BROKER / DIRECT_AGENT) lives here, not on the showroom.

**The DDMS layer** — what we pulled and what we can do with it:

- **dms_deals** — a read-only mirror of the dealer's DMS: raw payload, a hash to
  tell "changed" from "unchanged" cheaply, projected columns the worklist sorts
  on, and `statusSince` / `lastSyncedAt` / `disappearedAt`. Reconciliation is
  **not** stored here; it is derived on read, because a stale "in sync" flag is
  worse than none.
- **dms_job_cards**, **dms_enquiries** + **dms_employees**,
  **dms_registrations**, **dms_part_stock** — the same shape, four more times.
  `dms_part_stock` is keyed on `(showroomId, partNo)` rather than
  `(dealerCode, partNo)` unlike the rest: stock is physically at an outlet, not
  at a dealer code, and one showroom may carry two brands' codes over one set
  of shelves.
- **insurer_panel_entries** — one insurer on one outlet's panel: quota, payout,
  turnaround, integration surface. Hangs off the *DMS account*, not the
  showroom. `route` is deliberately absent — it is the account's
  `insuranceChannel`, and storing it twice would let the two disagree.

Every mirror table carries **mirror fields** (pulled, never written back) and
**decision fields** (what we concluded, and what is still outstanding). A
decision field that does not change the derived state is decoration, and the
test for one is a query before and after it is set.

Adding a module means: a mirror table, a `*-worklist.ts` with `sync…` and
`build…` and `summarise…`, a route, a spec entry, a screen. It is not a fresh
integration, and it should not become one.

**Every DDMS read is scoped to one showroom except the spares worklist**, which
reads across every outlet the *session's owner* holds — the scope comes from
`req.sessionUser.ownerId`, never from the request, and RLS is the backstop. That
one query is the product's whole premise: a DMS keeps the parts ledger against a
dealer code, so an owner with three outlets gets three ledgers and no way to ask
whether the part a customer is waiting for is on a shelf in the next branch.

**Derived state describes a cause, not a consequence.** `registration-worklist.ts`
has the counter-example written into it: a lapsed temporary registration was
first modelled as a state, and a file the RTO had rejected whose temporary
registration had also lapsed came out advising somebody to take it to the RTO,
with the objection nowhere on screen. Consequences that can coexist with any
cause belong on the row (`tempRegDaysLeft`) and in the note, and the summary
counts them from there.

**The application pipeline:**

- **providers** — insurers. `code` is unique and drives everything: API key
  lookup (`process.env[`${code}_API_KEY`]`), the `executeWithApi` switch, and
  the `executeWithBrowser` switch. `apiEndpoint` null ⇒ AUTO mode picks BROWSER.
  Global: this says *how to reach* an insurer. What a given dealer's
  arrangement with them is lives in `insurer_panel_entries` — neither is
  derivable from the other.
- **applications** — the MSA payload stored **flat** (26 columns, not nested
  JSON). Assembled into the nested payload only at execution time.
- **ocr_engines** — operator preferences (priority, enabled) for the OCR chain.
  Rows are optional; missing engines use registry defaults. Never stores keys.
- **submission_logs** — append-only audit trail, FK cascade-deletes with the
  application. Browser steps stash a base64 JPEG in `metadata.screenshot`.
- **policies** — one row per successful submission, `applicationId` unique.

Status flow: `draft → pending_confirmation → submitting → completed | failed`.
Validation failure resets status to `draft`, it does not set `failed`.

**One application per DMS deal.** `applications_dms_deal_unique` on
`(dms_dealer_code, dms_deal_id)` is load-bearing: two drafts from one deal that
both reach execution mean two policies on one vehicle. `/ingest/push` checks for
an existing row **before validating** and answers 409 with that row's id, and
catches `23505` as a backstop for the race. Postgres NULLS DISTINCT is also
load-bearing — hand, OCR and scrape applications all leave both columns null and
must not collide. Do not add NULLS NOT DISTINCT.

> `drizzle-kit push` offers to **TRUNCATE** when adding a unique constraint to a
> table that already holds rows, and `--force` answers yes. Apply constraints
> like this by hand (`alter table … add constraint …`) and then re-run push to
> confirm it reports no changes.

## MSA payload validation rules

Validation exists in **two places that must stay in sync**:

- `POST /api/applications/:id/validate` — `routes/applications.ts`, the
  authoritative gate before execution.
- `validateMsaFields()` — `routes/ingest.ts`, applied on VeloDocs push so
  incomplete OCR data cannot silently create a junk draft.

They are intentionally near-identical. The **only** difference: ingest does not
require `providerId`, because a provider isn't chosen until later.

**Errors — these block submission:**

| Field | Rule |
|---|---|
| `vehicleMake`, `vehicleModel`, `vehicleVariant` | non-empty |
| `vehicleEngineNumber`, `vehicleChassisNumber` | non-empty |
| `vehicleExShowroomPrice` | `> 0` |
| `vehicleDateOfPurchase` | non-empty |
| `ownerFullName`, `ownerBillingAddress` | non-empty |
| `ownerPincode` | exactly 6 digits |
| `ownerPhoneNumber` | exactly 10 digits, `/^\d{10}$/` |
| `ownerEmail` | `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` |
| `ownerDateOfBirth` | non-empty |
| `ownerIdProofType` | one of `AADHAR` `PAN` `PASSPORT` `DRIVING_LICENSE` `VOTER_ID` |
| `ownerIdProofNumber` | non-empty |
| `rtoRegistrationCity`, `rtoRegistrationState` | non-empty |
| `providerId` | required — **validate endpoint only** |

**Warnings — these do NOT block:**

- `rtoCode` should match `/^[A-Z]{2}\d{2}$/` (e.g. `MH01`, `DL02`).
  A malformed RTO code still passes validation.

Execution has two further hard gates beyond validation:
`confirmedByUser: true` in the request body, and status not already `completed`.

**Date handling.** Drizzle date columns use `mode: "string"`, but Zod coerces
date-formatted strings into `Date` objects. Every write path funnels through a
local `toDateStr()` helper that slices to `YYYY-MM-DD`. There are two separate
copies of this helper (applications.ts and ingest.ts) — change both together.

## OCR engines

All engine logic lives in `api-server/src/lib/ocr-engines.ts`. `routes/ingest.ts`
only translates between HTTP and that module — put new engine work in the
registry, not the route.

An engine is usable only when **all three** hold:

| Flag | Meaning | Source |
|---|---|---|
| `isImplemented` | a real integration exists | code |
| `isConfigured` | its API key is present | environment, read live |
| `isEnabled` | operator has it switched on | `ocr_engines` table |

Listed in default priority order — free options first:

| Prio | Engine | Implemented | Requires | Cost | Model |
|---|---|---|---|---|---|
| 5 | `gemini` | yes | `GEMINI_API_KEY` | **free tier** | `gemini-flash-latest`, native API |
| 10 | `gpt-vision` | yes | `OPENAI_API_KEY` | paid | `gpt-4o`, `detail: high` |
| 15 | `openrouter` | yes | `OPENROUTER_API_KEY` | **free tier** | configurable, `:free` models |
| 20 | `qwen-vl` | yes | `DASHSCOPE_API_KEY` | paid | `qwen-vl-plus` via DashScope |
| 30 | `paddleocr` | **no** | `PADDLEOCR_API_URL` | — | deliberately unwired, see below |
| 40 | `olmocr` | **no** | — | — | not integrated |
| 99 | `stub` | yes | nothing | — | fixed Yamaha FZ-S / Delhi DL01 record |

`gpt-vision` and `openrouter` share `callOpenAiCompatibleVision()` — identical
wire format, differing only in host, key and headers. Add any other
OpenAI-compatible provider by calling that helper rather than writing new fetch
code.

**`gemini` uses the native API, not Google's OpenAI-compatible shim**, so it can
set `responseMimeType: "application/json"`. That constrains the model to emit
valid JSON and eliminates the most common parse failure — prose or markdown
fences around the object. Keep it that way.

**OpenRouter can return HTTP 200 with an error body** when an upstream provider
fails; the shared helper checks for that and throws, so the chain moves on
instead of parsing an error as a result.

Model IDs are all overridable: `GEMINI_VISION_MODEL`, `OPENAI_VISION_MODEL`,
`OPENROUTER_VISION_MODEL`, `DASHSCOPE_VISION_MODEL`. `gpt-vision` also honours
`AI_INTEGRATIONS_OPENAI_API_KEY` + `AI_INTEGRATIONS_OPENAI_BASE_URL` (the Replit
proxy), which take priority over `OPENAI_API_KEY`.

OpenRouter's `:free` model roster rotates. If the configured model is retired it
returns a clear "model not found" and the chain falls through — no code change
needed, just update `OPENROUTER_VISION_MODEL`.

### The fallback chain

`resolveChain()` decides what to try; `runOcrChain()` runs it and returns the
first success, recording every attempt.

```
model "auto" (default) → all available, auto-eligible engines by priority
model <engine>         → that engine first, then the rest of the chain
allowFallback: false   → only the named engine, failure returned as-is
```

Each attempt gets an `OCR_TIMEOUT_MS` deadline (default 45s) via `AbortController`,
so one hung provider cannot stall the request. Failures that trigger fallback:
missing key, HTTP error, timeout, unparseable output, and *zero extracted fields* —
a model that returns valid JSON with everything blank counts as a failure, not a
blank success.

If every engine fails, the route returns **502** with the full `attempts` array.
It never returns a partial or fabricated result.

> **The stub is never reachable automatically.** `autoEligible: false` keeps it
> out of every chain; it runs only when named explicitly, and its results carry
> `isDemoData: true`. This is deliberate — the stub returns an invented chassis
> number and Aadhaar number at high confidence, and if a key expired and the chain
> quietly fell through to it, that fiction would enter a real insurance
> application looking like genuine OCR output. Do not make it auto-eligible.

### Runtime configuration

Priority and enabled state live in the `ocr_engines` table, edited from the
**Engines** tab in VeloDocs. Reordering takes effect on the next extraction with
no restart. Adding or removing an API *key* still needs a restart, since keys are
read from the environment.

Rows are optional — any engine without one falls back to its registry defaults,
so a database that has never been configured works fine.

```
GET /api/ingest/ocr/engines   → status + live availability, priority order
PUT /api/ingest/ocr/engines   → set order and enabled state
```

**Why PaddleOCR is not wired.** Both working engines are vision-LLMs prompted
with `OCR_EXTRACTION_PROMPT`, which instructs them to return a JSON object of
MSA fields *plus* a per-field `confidence` map. `parseVisionLLMResponseToMsaFields()`
parses that JSON. PaddleOCR returns raw OCR text lines, which would always
JSON-parse-fail. **Only pipe model output into `parseVisionLLMResponseToMsaFields()`
if the model was prompted with `OCR_EXTRACTION_PROMPT`.** A raw-text engine needs
its own text-to-fields extractor first.

**Confidence scores** drive the review UI. The model self-reports 0.0–1.0 per
field; the parser backfills anything unscored (0.65 if the field is non-empty,
0.20 if empty). `review-correct.tsx` highlights anything **< 0.7** in amber so a
human checks it before pushing. The parser is defensive: it strips markdown
fences, coerces types, and falls back to `AADHAR` for an unrecognised ID type.

## Playwright execution paths

Playwright is used in **two unrelated places**. Both `await import("playwright")`
lazily so startup cost is only paid when actually needed.

**1. Submission — `lib/browser-executor.ts`** (InsurRouter)

Reached when `executeWithBrowser` is selected. Mode resolution in
`POST /api/applications/:id/execute`:

```
executionMode "API"     → API
executionMode "BROWSER" → BROWSER
executionMode "AUTO"    → API if provider.apiEndpoint is set
                              AND provider.defaultExecutionMode !== "BROWSER"
                          else BROWSER
```

If no `portalUrl` is set it invents `https://portal.<code>.com`. It then
switches on `providerCode.toUpperCase()` — **every provider currently falls
through to `executeGenericStub`**, which navigates, screenshots each step, and
returns a fake policy number `<CODE>-BROWSER-<base36>`. Real flows go in that
switch (commented examples for HDFC/BAJAJ are in place).

Each step calls `snap(page)` → base64 JPEG (quality 70) stored in
`submission_logs.metadata.screenshot` so the UI can render inline snapshots.
Steps: `browser_launch → page_loaded → form_vehicle → form_kyc → form_rto →
form_submit → policy_issued`. Any new step name must also be added to the `step`
enum in `lib/db/src/schema/submission_logs.ts` or the insert will fail.

**2. Scraping — `POST /api/ingest/browser-scrape`** (VeloDocs)

Loads a dealer portal, optionally logs in with generic selectors, extracts
`document.body.innerText` plus every form input, and maps inputs to MSA fields
by regex on name/placeholder/label. Scraped fields get 0.6–0.8 confidence;
anything unmatched defaults to 0.4 so the reviewer sees it.

This endpoint is **SSRF-hardened** and the protection is load-bearing — it takes
a user-supplied URL. `validateUrlSsrf()` enforces http(s) only, rejects bare
private IPs (v4, v6, and IPv4-mapped-v6 in both dotted and hex form), rejects
`localhost`/`.local`/`.internal`/`.corp`/`.lan`, and DNS-resolves the hostname
rejecting any internal A/AAAA record. A `page.route()` handler re-validates
**every** request so a redirect can't escape to an internal address. Do not
weaken or bypass this.

**Launch options are shared.** Both call sites use `chromiumLaunchOptions()`
from `browser-executor.ts` — do not inline a `chromium.launch({...})` config.

- `CHROMIUM_EXECUTABLE_PATH` **unset** (local): Playwright uses its own
  downloaded browser with default args. Install once with
  `pnpm --filter @workspace/api-server exec playwright install chromium`.
- `CHROMIUM_EXECUTABLE_PATH` **set** (Replit): uses that binary *and* switches on
  `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu
  --single-process`. Those flags are deliberately tied to the custom executable —
  `--single-process` is unstable off-Replit.

## Running locally

Node 24 and pnpm are required. **Nothing calls dotenv** — a `.env` file is not
read automatically. Use `node --env-file=.env` or set vars inline.

Every artifact throws at startup if `PORT` is missing, and the web artifacts also
throw if `BASE_PATH` is missing. Values differ per artifact, so they cannot all
live in one `.env`. Ports come from each `.replit-artifact/artifact.toml`:

`API_SERVICE_KEY` must be in the workspace-root `.env` before anything starts:
the API refuses to boot without it, and each Vite dev server throws when it
creates its `/api` proxy. Generate one with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

`DATABASE_URL_APP` must be there too, for the same reason and with the same
failure mode — the API refuses to boot without it rather than falling back to
the connection that bypasses row-level security. Copy `DATABASE_URL`, change the
user to `ddms_app.<project-ref>`, pick a password, then `pnpm run db:rls`, which
creates the role with whatever password that URL says.

```powershell
# API — build once, then run node directly so --env-file loads .env.
# (Don't use the package's `dev` script on Windows: it starts with POSIX
#  `export NODE_ENV=... &&`, and it wouldn't load .env anyway.)
pnpm --filter @workspace/api-server run build
$env:PORT=8080; node --env-file=.env --enable-source-maps artifacts/api-server/dist/index.mjs

# DDMS         → http://localhost:31280/ddms/
$env:PORT=31280; $env:BASE_PATH="/ddms/";       pnpm --filter @workspace/ddms run dev

# InsurRouter  → http://localhost:24791/
$env:PORT=24791; $env:BASE_PATH="/";            pnpm --filter @workspace/insur-router run dev

# VeloDocs     → http://localhost:18815/doc-ingest/
$env:PORT=18815; $env:BASE_PATH="/doc-ingest/"; pnpm --filter @workspace/doc-ingest run dev

# Mock OEM DMS → http://localhost:9090/portal  (its own SQLite file)
$env:DMS_PORT=9090; node artifacts/dms-mock/src/index.ts
```

DDMS needs the API and the mock DMS running to show anything. It reads only the
mirror, so it renders when the mock is down — just with a stale `lastSyncedAt`.

Run the API and a frontend in separate terminals. The Vite dev servers proxy
`/api` → `localhost:${API_PORT ?? 8080}`; on Replit the platform router does this
instead and the proxy is inert.

Health check, needs no database: `curl http://localhost:8080/api/healthz`.

Other commands:

```
pnpm run typecheck      # whole workspace
pnpm run build          # typecheck + build all
pnpm run db:push        # push schema changes (dev only, destructive)
pnpm run db:seed        # insert the 6 starter providers, idempotent
pnpm run db:seed-owners # owner, showrooms, DMS accounts + insurer panel
pnpm run db:seed-users  # sign-in accounts, plus a second owner to isolate from
pnpm run db:rls         # create the ddms_app role and apply RLS policies
```

Order matters twice. `db:seed-owners` must run **after** `db:seed` — panel
entries point at `providers` rows, and it warns loudly for any insurer code it
cannot find rather than silently leaving it off the panel. `db:rls` must run
**after every `db:push`** — a new table arrives with RLS enabled and no policy,
so `ddms_app` cannot read it until `lib/db/sql/rls.sql` names it.

**`pnpm install` must be run from Git Bash on Windows.** The `preinstall` hook
that refuses npm/yarn is a `sh -c` script and PowerShell has no `sh`, so the
install fails at the hook.

`db:push` invokes drizzle-kit directly, which is not a Node entrypoint, so
`--env-file` cannot reach it — export `DATABASE_URL` first:

```powershell
$env:DATABASE_URL = (Get-Content .env | Where-Object { $_ -match '^DATABASE_URL=' }) -replace '^DATABASE_URL=',''
pnpm run db:push
```

**RC Capture does not run on Windows.** Its `dev` script uses POSIX inline env
assignment (`VAR=x cmd`) and depends on `$REPLIT_EXPO_DEV_DOMAIN`,
`$REPLIT_DEV_DOMAIN` and `$REPL_ID`. It needs Replit, or a rewritten script plus
`EXPO_PUBLIC_DOMAIN` pointed at a reachable host. It typechecks fine either way.

### Frontend pages

DDMS (`artifacts/ddms/src/pages/`): `Leads` (`/`), `Worklist` (`/worklist`),
`Registrations` (`/registrations`), `ServiceWorklist` (`/service`),
`Spares` (`/spares`). Its own `Shell` — an owner looking across showrooms,
rather than an agent working one
application — with outbound links to the other two products rather than
embedded copies of them.

InsurRouter (`artifacts/insur-router/src/pages/`), routed by Wouter under
`BASE_URL`: `Dashboard` (`/`), `ApplicationsList`, `ApplicationNew`,
`ApplicationDetail` (renders the log timeline incl. inline browser screenshots),
`ProvidersList`, `ProviderEdit`. Wrapped in `components/layout/Shell.tsx`.

Note `Select` in DDMS and InsurRouter is a **native** select (`NativeSelect`),
not the Radix composite VeloDocs uses. DDMS carries its own copy of the handful
of UI primitives it needs; there is no shared UI package yet, and extracting one
is only worth doing when a third consumer appears.

VeloDocs (`artifacts/doc-ingest/src/`) is a single `Workspace` page composing
four components, one per ingest source plus review: `dms-pull`, `browser-scrape`,
`ocr-upload`, `review-correct`. The last highlights any field scoring **< 0.7**
in amber.

### Seed data

`pnpm run db:seed` inserts 6 insurers, skipping any `code` already present.
`replit.md` claims providers "are seeded" — that was done directly against the
Replit database, never by a script, and did not survive the export. The names in
`scripts/src/seed-providers.ts` are real companies but **every endpoint and
portal URL is a `.invalid` placeholder**, so browser submissions against seeded
providers fail at navigation until you set a real `portalUrl`. API-mode
submissions succeed regardless, because `executeGenericApiStub` never makes a
real request.

## Gotchas

- **`.env` is gitignored, `.env.example` is tracked.** Keep the template current
  when you add a variable.
- **Zod is pinned to v3** but Orval 8 emits v4 syntax. The codegen script
  post-patches with `sed`: `zod.int()` → `zod.number().int()`, `zod.email()` →
  `zod.string().email()`. Codegen therefore needs a POSIX shell — on Windows run
  it from Git Bash.
- **`drizzle.config.ts` normalises its schema path to forward slashes.**
  drizzle-kit globs that path, and glob treats `\` as an escape, so a raw
  Windows path fails with "No schema files found". Don't revert it to plain
  `path.join`.
- **`pnpm-workspace.yaml` excludes non-linux-x64 native binaries** to keep the
  Replit store small. The **win32-x64** variants are deliberately left in for
  local Windows dev — esbuild hard-fails without its native binary, there is no
  JS fallback. Don't add `"esbuild>@esbuild/win32-x64": "-"` back.
- **`minimumReleaseAge: 1440`** blocks npm packages published less than a day
  ago. This is deliberate supply-chain defence — do not disable it.
- **`preinstall` refuses npm and yarn.** Use pnpm.
- **`lib/api-client-react` is a composite TS package.** After codegen it must be
  rebuilt with `tsc` before Expo (rc-capture) will typecheck against it.
- **RLS policies name `ddms_app` explicitly, not `public`.** The Supabase `anon`
  and `authenticated` roles therefore still read nothing, which is the intended
  answer until a Supabase-client frontend exists and someone writes policies for
  it deliberately.
- **`pnpm run db:rls` proves itself and exits non-zero if it cannot.** It
  reconnects as `ddms_app` with no session and checks the tables read empty and
  that `users`/`sessions` are denied. Reading the policy file proves nothing — a
  typo in an owner comparison still reads like a policy.

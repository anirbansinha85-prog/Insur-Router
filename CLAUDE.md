# CLAUDE.md

Guidance for Claude Code when working in this repository.

> **Opening this project for the first time?** Read `docs/ORIENTATION.md` first.
> It says what to read, in what order, and traces how the project got from an
> insurance dashboard to an agentic ERP. This file is the second thing to read
> and the most important one; `docs/ddms-requirements.md` is the third.

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
| Role | what does that person do here? | `lib/dms/permissions.ts`, `users.role` |
| Row-level security | what may their connection see? | `lib/db/sql/rls.sql` |

Since OBJ-8 all three apply to **all three products**. InsurRouter and VeloDocs
had only the first of them, which is why their routes returned every
dealership's applications to anybody holding the shared key.

**Sessions.** `POST /api/auth/login` verifies a scrypt password and issues an
httpOnly cookie. Only the SHA-256 of the token is stored, so the table is not a
list of usable credentials. `attachSession` runs app-wide and never rejects;
`requireUser` rejects. `assertShowroomAccess` answers **404, not 403**, on a
showroom the session's owner does not hold — a 403 confirms it exists.

**Four database roles**, and they are not interchangeable. One per job, because
two of the jobs happen with nobody signed in and so cannot be scoped by a
session — which is exactly why they used to run as the table owner:

| | `DATABASE_URL`<br>`postgres` | `DATABASE_URL_APP`<br>`ddms_app` | `DATABASE_URL_LOGIN`<br>`ddms_login` | `DATABASE_URL_WORKER`<br>`ddms_worker` |
|---|---|---|---|---|
| Owns the tables | yes | no | no | no |
| `bypassrls` | **yes** | no | no | no |
| `users` / `sessions` | all | **none** | select, and one column of update | **none** |
| Used by | drizzle-kit, the seeds, `db:rls`, `db:probe` | every request path | sign-in | the sync scheduler |

**The API server is not given `DATABASE_URL` and refuses to start with it set.**
`refuseOwnerCredential()` in `lib/db/src/scope.ts` is what refuses, and the
reason it exists rather than a comment saying "don't use the owner pool" is that
choosing the restricted role is not isolation while the unrestricted one is one
import away — the mistake would be a query that silently works. So the server
runs from `.env.api`, which is `.env` minus that one line, and the command-line
tools keep theirs. See `.env.api.example`.

`ddms_login` exists because `lib/session.ts` runs *before* a scope exists — it
is working out whose scope to open — and reads the two tables `ddms_app` is
denied. It may write exactly one column, `users.last_login_at`, so a leak of the
credential that can see password hashes cannot rewrite one or change a role.

`ddms_worker` exists because syncing every dealership on a timer is cross-tenant
by definition. Since OBJ-16 it also holds the outbox and the decision log,
because the rules run there and rules draft — the widening that changed what
that role *is*: it no longer only mirrors, it proposes. What may actually leave
is still `authoriseSend()`'s decision. `withWorkerScope()` opens it once around the whole pass, so the
seven sync functions keep reaching for `db` and do not know or care whether a
person or a timer started them. It reads `applications` and `policies` —
select-only, and not by original intent: a deal's derived state is a *statement
about* the insurance record, so the detector cannot rebuild the projection
without them. It holds nothing about people and writes nothing anybody decided.

`PLATFORM_ADMIN` is a user role rather than a credential, and the only one that
may write `providers` and `ocr_engines`. Those are the same rows for every
dealership, so an owner editing an insurer's endpoint would be editing it for
every other owner; `app.is_platform_admin()` is what refuses. It reads no
dealership module at all.

Every product router mounts `sessionScope`, which checks out a connection from
the `ddms_app` pool and sets `app.session_token` on it for the life of the
request. `db` from `@workspace/db` is an `AsyncLocalStorage`-backed proxy: inside
a scope it is that connection, outside one it falls back to the owner handle —
which in the API server has no credential behind it and throws. That is the
intended shape: unscoped database access from a request path used to work
silently and now cannot happen at all. **No caller passes a handle around**,
which is the whole reason it is a proxy — `lib/db/src/scope.ts` has the
argument.

Policies resolve the tenant through `app.current_owner_id()`, a `security
definer` function that reads `sessions` and `users`. `ddms_app` has no grants on
those tables, so it cannot read a token hash and therefore cannot invent one:
holding its credentials gets you exactly as far as holding no session at all.

**Consequences worth knowing before you write a query:**

- Inside the DMS router, a query with **no** tenant filter returns only the
  signed-in owner's rows. That is the point, not a coincidence to rely on
  silently — write the filter anyway, and let RLS be the backstop.
- `applications.showroom_id` is nullable, and a null belongs to **nobody**
  under RLS — so since OBJ-8 a null is a *failure state* rather than a standing
  condition. Every create path takes the outlet from the session:
  `resolveOwningShowroom()` uses what the caller asked for (checked), then the
  outlet on their login, then the owner's only outlet, and asks rather than
  guessing when an owner holds several. `db:seed-applications` prints the count
  of unattributed rows; it should stay zero.
- A new table arrives with RLS enabled and no policy, so `ddms_app` cannot read
  it at all. **Run `pnpm run db:rls` after every `db:push`**, and add the table
  to `rls.sql` first. A blank DDMS screen is the intended failure.
- Anything genuinely cross-tenant runs inside `withWorkerScope`, which is a
  visible decision in one place instead of a missing scope in seven. `ownerDb`
  has no callers left in the server — only the command-line tools, which run as
  somebody who already has the password.

**Mount router-wide gates on their path prefix**, never path-less.
`router.use(requireUser)` inside the DMS router runs for every request that
*reaches* that router, including ones destined for a router mounted after it —
which is how VeloDocs's ingest routes silently answered 401 for a whole
session. Use `router.use("/dms", requireUser, sessionScope)`.

InsurRouter and VeloDocs mount `requireModule("DEAL")` behind that, because
every screen in both is about one module and an application carries the
customer's Aadhaar number, address and date of birth. A technician closing job
cards has no reason to hold any of that; owners, managers, sales and accounts
do. The row policy carries the same gate, which is what makes the refusal true
rather than merely legible.

## Workspace layout

```
artifacts/            deployable apps
  ddms/               React 19 + Vite — owner control panel, its own service
  api-server/         Express 5 API — the only backend
    src/routes/       health, providers, applications, dashboard, dms, ingest
    src/lib/          api-executor.ts, browser-executor.ts, auth.ts, logger.ts
    src/lib/dms/      client, adapters, mirror sync, seven worklists, the
                      entity graph, actions, composer, the approval gate,
                      the explain tools, the event log, insurer panel, scheduler
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

Sixty-one tables, all in `lib/db/src/schema/`. Every one of them has RLS enabled;
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
  `dms_employees.emailId` is mirrored rather than composed from the name: a
  dealership's mailbox naming is theirs, and guessing it would send an
  assignment notification into the void while the screen reported it delivered.
  Null is a real answer there, and it is why the approval gate refuses to send.
  `dms_part_stock` is keyed on `(showroomId, partNo)` rather than
  `(dealerCode, partNo)` unlike the rest: stock is physically at an outlet, not
  at a dealer code, and one showroom may carry two brands' codes over one set
  of shelves.
- **dms_receivables** — what each outlet is owed. `partyCode` is the field
  the module exists for: it is stable across outlets, so the projection can ask
  what one insurer owes the *group*. Matching on names would work until
  somebody typed "ICICI Lombard Gen. Ins." and the exposure quietly halved.
- **dms_vehicle_stock** — the floor. `receivedDate` with `costAmount` and
  `interestRatePct` is the whole ageing question and no screen in the dealer's
  system puts the three together. Money here is `numeric`, not the `real` the
  older `dms_part_stock` uses — float4 carries about seven significant digits,
  which a fleet invoice already exceeds.
- **entities** + **entity_links** — one person, one vehicle, one member of
  staff, resolved across the five mirrors that carry a person. **Owner-scoped,
  not showroom-scoped**:
  a customer who buys at one outlet and services at another is one row, and
  saying so is the point. The two are rebuilt *differently* — links wholesale,
  entities upserted — because an entity id is addressable (it is in a URL) and
  `firstSeenAt` is a claim about how long the dealership has known somebody.
  Deleting both reassigned every id on each scheduled sync.
- **outbound_messages** — everything DDMS proposes to say on the
  dealership's behalf, and the basis on which it was allowed to. Select,
  insert and update but **no delete**: a message somebody decided against is
  `CANCELLED`, because "we chose not to contact this customer" and "nobody ever
  drafted anything" are different facts and only one of them can be defended
  later. A partial unique index keeps one *open* message per record, audience
  and channel; the application widens that to a day, because the index has to
  release before a legitimate nudge next week and it was letting a duplicate
  through minutes later.
- **record_events** — every time a record's *derived state* moved, and what it
  moved from. Append-only, like the decision log and for a sharper reason: the
  newest row per `(module, showroomId, recordKey)` **is** the current state, so
  an update here would not merely lose history, it would change what every rule
  believes is true now.
- **decision_log** — every decision-field change, with a name and a
  before/after against it. Append-only by convention: `ddms_app` is granted
  insert and select and nothing else, because a record of who decided what is
  answering a different question if it can be edited afterwards.
- **insurer_panel_entries** — one insurer on one outlet's panel: quota, payout,
  turnaround, integration surface. Hangs off the *DMS account*, not the
  showroom. `route` is deliberately absent — it is the account's
  `insuranceChannel`, and storing it twice would let the two disagree.

**Three queries deliberately span outlets**, and each is the product's premise
rather than a convenience. Spares asks whether the part a customer is waiting
for is on a shelf in another branch. Receivables asks what one party owes the
group. The vehicle floor matches standing stock against open enquiries at *any*
outlet. All three take the scope from `req.sessionUser.ownerId`, never from the
request, and RLS is the backstop.

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

## The screens act

Every "what to do" that can be resolved deterministically is a control. **None
of them uses a model** — `classify()` decides what is wrong, `lib/dms/actions.ts`
decides what may be done about it, and both are knowable, so both are rules.

| Screen | Controls |
|---|---|
| Enquiries | call · WhatsApp · reassign to active staff |
| Service | call · mark customer told |
| Registration | assign an RTO agent · mark customer told · log a chase |
| Spares | request a transfer from the branch that has it · mark reorder raised |
| Receivables | log a chase · mark disputed · draft a statement of account |
| Vehicle stock | mark offered against an enquiry · propose a transfer to the outlet that wants it |

One endpoint, `POST /api/dms/actions`, because they all do the same thing:
write a decision field that already changes a derived state, and log who did it.

**Three properties every action has, and each was a decision:**

- **Reversible.** `clear: true` undoes any of them. These marks *remove work
  from a screen* — marking a customer as told takes their row out of the
  calls-to-make count — so an irreversible mis-click would silently delete a
  phone call somebody still needs to make.
- **Attributed.** `decision_log` records who, what, and the before/after. "We
  told the customer" is a claim somebody may later dispute, and a bare
  timestamp cannot say who made it. It is also the substrate the approval gate
  will need.
- **Refusable.** Assigning work to somebody who has left returns **409 with the
  reason**, because that is the bug these actions exist to fix. The staff picker
  excludes them rather than greying them out, for the same reason.

**Nothing here writes to the dealer's DMS**, and nothing will. Where the only
real fix is a person keying something into their system, the row says so and
gives the exact value to copy rather than offering a button that pretends
otherwise. `ENQUIRY_LOG_CONTACT` is the sharpest case: logging a call in DDMS
does **not** stop the manufacturer's response clock, because the OEM measures
their own `firstContactAt` and the integration is read-only. So the derived
state keeps using *their* field, our record changes only the *advice* — "call
now" becomes "key the contact into the OEM portal" — and `slaNote` says the
limit out loud. A screen that let a logged call clear an SLA breach would tell
an owner they were compliant while the manufacturer's report said otherwise.

## Nothing leaves the building unapproved

Every screen above acts on the dealership's own records. `outbound_messages` is
the first thing that speaks *for* them, and it is gated in one place:

> **Nothing leaves without either a rule permitting it or a person approving
> it.**

`authoriseSend()` in `lib/dms/outbound.ts` is that gate, and `sendMessage()` is
the only function permitted to write `sentAt` — after the gate has returned a
basis and not otherwise. A row with a `sentAt` and no `authorisedBasis` is the
state that file exists to make unreachable.

**There is exactly one rule**, `INTERNAL_STAFF_NOTIFICATION`, and every clause
of it is load-bearing: internal **email** only, to somebody who **still works
here**, at the address **on the mirror** rather than in the request, about a
record **already assigned to them**. Everything else — every customer message,
without exception — needs a person. No branch can produce a rule basis for
`audience: "CUSTOMER"`, which is R-50 expressed as control flow rather than as
configuration. Widening that is a decision about how far this product is
trusted, and it belongs in that file where somebody can read it.

**The transport registry is empty, and that is honest rather than unfinished.**
There is no SMTP credential and no WhatsApp Business account, so an authorised
message lands in `HELD_NO_TRANSPORT` with `sentAt` still null and the screen
says exactly that. A green "sent" for something no customer received is the same
defect as a simulated policy number that looks issued. Adding a transport is
adding an entry to `TRANSPORTS`; the gate is complete either way, because what a
message *may* do is the part that had to be built.

**A model writes and a rule verifies.** `composer.ts` builds every draft from a
`facts` object a rule pulled out of the mirror, then optionally asks a model to
rephrase it — and `checkRewrite()` accepts the result only if it invents no
figure, drops no figure the draft asserted, and ends in a finished sentence.
Each of those three tests exists because a rewrite failed it: the first customer
draft this composer ever produced read *"Dear Mr Satish Verma, your HF Deluxe"*
and stopped, because the token budget ran out inside the model's own reasoning
and a truncated message invents nothing. A failed rewrite is logged and the
template goes forward — and the *reason* is logged too, because a silent
fallback and a silent failure look identical from the outside. They looked
identical for a while: a malformed request made the model path inert and every
draft came back `RULE`, which is exactly what healthy fallback looks like.

## Messages out, replies in

`lib/dms/channels/`, `routes/webhooks.ts` and two tables (OBJ-27, R-106). The
outbox has drafted since OBJ-16 and delivered nothing, because `TRANSPORTS` was
an empty object with a long comment explaining that being empty was the honest
state of the system. It is no longer empty.

**DDMS holds no messaging account of its own.** The WhatsApp number a customer
sees has to be the dealership's — a service reminder from an unknown number is
a message nobody answers — and so do the template approvals, the sending
reputation and the bill. R-106 states it as a rule and `channel_credentials`
is what makes it true: one row per (owner, channel), and an environment
variable would have been one account for every dealership using the product.

**The secret is encrypted and no route can return it.** AES-256-GCM under
`CREDENTIAL_KEY`, which lives in the environment and not the database, so a
backup on a laptop or a `pg_dump` in a support ticket is not a token. The
decrypting function is module-private; what a screen gets is `ChannelStatus`,
which has no field for a secret and four masked characters instead. That is a
property of the type rather than a rule every future handler must remember.
No key, no feature — a token written in the clear with a warning nobody reads
is not the fallback.

**A credential arrives switched off, every time, including on a re-paste.** A
token that changed is a token nobody has tested, and the send that proves it
works is cheaper than the one that goes to four hundred customers from a number
the dealership had not finished setting up.

**`blocker` is one sentence naming whose problem it is.** *No transport is
configured* described a gap in the product; three of the four real reasons are
the dealership's own and each is worded separately.

WhatsApp goes over Meta's Cloud API as a `text` message, which Meta permits only
within twenty-four hours of the customer's last one. Outside that window their
error is shown verbatim. **DDMS does not quietly substitute an approved
template** — delivering something other than what a manager put their name to is
the one thing the whole gate exists to prevent.

### A reply is the half that is not plumbing

`inbound_messages` is the first table in this product that mirrors nothing. A
DMS records what the dealership did to a record; it has no column for *the
customer answered on Tuesday and said the bike is still pulling left*, no report
that would produce one, and no way to notice that nobody read it.

**Nothing reads the message.** Stored verbatim, no rule fires on its contents,
no model summarises it. A model reading *"don't bother, I've sold it"* and
marking a lead lost is the judgement R-49 reserves for a person, and the failure
is silent — the lead leaves a screen and nobody learns why. What a reply does is
become a queue row saying somebody answered and nobody opened it, **always in
the Nobody's band**: an unread message arrived at a number, not at a person,
which is the exact definition of that band.

**The thread beats the phone book** (R-47). A reply is attributed to the last
message DDMS actually sent that number — a reference, because we wrote it — and
falls back to matching the customer entity on the mobile, which is probable and
says so. An unmatched reply is kept and queued rather than dropped: somebody
wrote to the dealership whether or not we can say about what.

`providerMessageId` is unique per channel, and that is the whole of the
idempotency. Meta retries any webhook it did not get a 200 for, including ones
it timed out on itself, so without it one customer message becomes four queue
rows and the screen stops being believed inside a week.

### The webhook is outside every gate, and one thing replaces them

`POST /api/webhooks/whatsapp` is the only route in this product without the
service key, a session or a role. Meta is the caller and holds none of them.
**The signature is what stands in their place** — HMAC-SHA256 over the raw
bytes with the app secret the dealership stored beside their own credential,
`timingSafeEqual`, verified before a row is written. A channel with no signing
secret **cannot receive at all**: an unsigned webhook is somewhere anybody may
post a fabricated customer conversation into a dealership's queue, and refusing
the delivery is the honest failure.

Whose payload it is has to be settled before there is a key to check it with, so
the business phone number id resolves the owner first. It answers 200 to almost
everything, deliberately: a 500 for an unparseable payload buys the same bad
payload every few minutes for a day. Only a failed signature gets a 401.

> **The signature is over the bytes, not the parsed object.** `express.json`'s
> `verify` hook keeps `rawBody`, because `JSON.stringify(req.body)` re-serialises
> with different key order and spacing — verifying against that produces a
> webhook that rejects every genuine delivery while looking correct.

> **A verifier that reaches for a wider credential is usually reporting a real
> boundary.** `verify:channels` connected an account inside `withWorkerScope`
> and got `permission denied for table channel_credentials`. The grant is right:
> an unattended process that could write a messaging credential could point a
> dealership's outbound at a number nobody chose. Connecting is a person's act.
> Third time this has happened — `ingest_mappings`, `autonomy_consents`, and now
> this — and each accident became a check.

> **A verifier that only exercises the empty case keeps passing after the
> feature breaks.** With no prior outbound to that number the test reply came
> back `matchBasis: NONE`, every check passed, and the entire threading path —
> the reason `providerMessageId` is on the outbox at all — was untested.

`pnpm run verify:channels`, and `/channels` is the screen.

## The panel that explains

Every screen answers *what is wrong*. `POST /api/dms/explain` answers the three
things the row cannot, because each reaches across a boundary the dealer's own
system keys everything by:

> why is this stuck · who else is affected · what happens if it waits

**Six typed tools, not query access.** `lib/dms/tools.ts` is a closed set of
read-only functions. The owner id comes from the session and is never a
parameter, the cross-outlet lookups read the *session's* showrooms, and anything
not in the registry is unreachable however the model phrases its request. RLS is
still the backstop — the difference here is that the caller is not a person.

**The findings are rules; the summary is a model.** `explain.ts` assembles one
sentence per claim from the rows the tools returned, then offers a model the
chance to narrate over exactly that evidence. `citationsHold()` accepts the
narration only if every figure in it appears in the evidence and it ends in a
finished sentence. **Both survive to the screen.** Replacing the findings with
the better-sounding paragraph would drop the only part of the answer somebody
can check, which is the part that makes it worth trusting — so the panel shows
the summary, then the findings, then the evidence rows themselves under *what
was looked at*.

With no key, a rate limit or a rejected narration, the findings stand alone and
the panel still works. That is not a fallback bolted on; it is the design. The
free tier returned **429** during verification and the answer on screen was
unchanged apart from the missing paragraph.

**Nothing here classifies and nothing here acts.** The state arrives from the
module's own `classify()` and travels through untouched (R-49), and no tool
writes. `recordState` deliberately reads through `build…Worklist` rather than
the mirror table: of all the places for this product to contradict itself, an
explanation of *why a row says what it says* is the worst.

> **The check catches figures, not meanings.** A finding that read *"It has not
> moved for 5 days"* was turned by the model into *"the record has not moved for
> 5 days"* — a different and wrong claim, about the transfer request rather than
> the stock, with the figure cited correctly. The fix was to name the subject in
> the finding. An ambiguous finding is one waiting to be misread, and by a person
> as easily as by a model.

## The mirror emits events

Everything above answers *what is true now*. `record_events` answers **what
changed and when**, which is a different question and the only one a rule can
be triggered by.

Until it existed the product was entirely *pull*: sync wrote the mirror, screens
derived on read, and a file that went wrong overnight waited for somebody to
open a page. Sync already compared a hash of every row on every pull and threw
the answer away.

**An event is the classifier's answer moving, not a column changing.** That is
Salesforce's distinction between a platform event and change data capture, and
it decides the design: `REGISTRATION → RC_IN_DRAWER` is something a rule can act
on, where `rc_received_date changed` would make every rule re-derive the meaning
`classify()` already worked out. It also catches the transitions no field diff
could — a lead breaching its window, a chase going stale, a temporary
registration lapsing. Nothing in the dealer's system changes; the answer does.

**The log is the state.** There is no companion table of current state: the
newest row per `(module, showroomId, recordKey)` *is* the state, and its
`detectedAt` is when the record entered it — which is also how long it has been
stuck. Two tables would read faster and would eventually disagree.

`detectStateChanges` runs after sync in `scheduler.ts`, with nobody signed in,
which is the entire point of it running there. It rebuilds the same projections
the screens use rather than re-deriving — an event stream that disagrees with
the screen it came from is worse than no event stream.

> **The showroom is part of a record's identity.** `dms_part_stock` is keyed on
> `(showroomId, partNo)` unlike every other mirror, so `HR-BRK-SHOE-R` is a
> different record at each branch and is `AVAILABLE_ELSEWHERE` at one and `OK`
> at the other. Keyed on the part number alone, the two outlets overwrote each
> other and the log flapped between the two states on every pass, for ever. Any
> key on a record has to be the key that record actually has.

## The dealership's own numbers

Two things decided how a short-staffed dealership spent its day and both were
ours until OBJ-18: the severity table that orders the queue, and the thresholds
each classifier turns on. Neither is a product question — whether a stuck
registration outranks a broken payment promise depends on this group's RTO agent
and this group's cash position.

`lib/dms/policy.ts` is the **closed registry**: every key that may exist, with a
default, a range and a sentence saying what it does. A key not there is rejected
on write and ignored on read, so a dealership may change *what the numbers are*
and can never change *what the product does with them*. That is the R-52 line —
eighty numbers in a table cannot become an automation layer nobody can predict;
eighty flows can.

`dealer_policy` is **sparse on purpose**: a row exists only where somebody set
something, so reset is a delete. Writing today's default into the table would
freeze that dealership on it when the product later improves its own.

Read by anybody signed in — the numbers explain what is on their screen — and
written only by `OWNER` or `MANAGER`, enforced by `seesEveryOutlet` in the route
*and* by `app.current_role() in ('OWNER','MANAGER')` in the row policy. Changes
go through the decision log with the previous value.

The seven builders take an optional `policy` and resolve it from the outlet when
absent, via `policyForShowroom`. **Never silently defaulted**: a builder quietly
using the product's numbers because nobody passed a policy would be a
dealership's settings not applying on one screen, which nothing would report.
Callers doing a full pass — the queue, the detector, the rules — load once and
pass it down, so the screen, the event log and the automation all read the same
numbers.

> **Changing a threshold found a classifier bug, and will again.** With *ageing
> after* raised to 300 days, two units somebody had been offered came back as
> `AGEING_SEVERE` — whose note reads *"nobody has asked for it"*. `OFFERED` was
> only checked inside the ageing branch. Derived state describes a cause, not a
> consequence: being offered is a cause, ageing is a separate axis. Moving a
> threshold a long way is a cheap way to find more of these.

## Rules that run themselves

`lib/dms/rules.ts` is the whole automation layer, and its length is the design.
One ordered list, in code, capped at twelve — `assertRuleSetFits` throws at
import above the ceiling. No rule builder and no per-dealership flows: the
failure mode being designed against is eighty active flows on one object and an
automation layer nobody can predict, and **DDMS's customer has no administrator
at all** to untangle one. Readable at `GET /api/dms/rules` and on the Outbox
under *What runs itself*, because an automation layer nobody can see is where an
automation layer nobody can predict starts.

**A rule fires on a record *being* in a state, not on the transition into it.**
The newest row per record in `record_events` is its state (OBJ-13), so reading
the state means a missed scheduler pass loses nothing — and the cadence falls
out of the same query. *While the record is still in this state, and the last
message about it was more than N days ago* is one condition, and it is also the
whole of R-57: the chase stops because the record moved.

**It drafts and presses send; `authoriseSend()` decides the rest.** An internal
note to somebody who still works here is permitted by rule; every customer
message without exception waits for a person. The same code path therefore
produces two very different things, and that asymmetry is R-48.

> **Stopping the cadence is not enough.** A draft raised last week about a
> certificate in a drawer is still in the Outbox after the customer collects it,
> waiting for somebody to approve telling them to come and collect it. A rule
> withdraws its own open drafts when the record leaves the state that raised
> them — `DRAFT` only, rule-raised only (`createdByUserId` null), cancelled
> rather than deleted.

> **No rule writes a decision field.** R-56 permits it, and every decision field
> in this product encodes a claim about something a *person* did — the customer
> was told, the RTO was chased. A rule writing one would assert work that never
> happened. When a field appears that records something the system did, a rule
> may write it.

## The seeded dealership

`dms-mock/src/generate.ts` and `generate-deals.ts` — a month of trading
**appended** to the hand-written fixtures, never replacing them. `push` rather
than a spread inside the array literal, so every scenario the session log names
by id keeps its id, its dates and its position.

One seeded PRNG, no `Math.random`, no clock read in any decision: reseeding
twice produces the same dealership. 141 enquiries, 104 job cards, 88
registration files, 78 deals, 58 vehicles, 67 parts, 50 receivables, 21 staff.
Saraswati carries the volume; Deccan stays parked (R-43).

**The ratios are the claim, not the volume** — about one row in six needs
somebody. Reseed with `DMS_RESET=1`, then sync both showrooms, then
`pnpm run db:seed-applications`, which also backfills DDMS's own policies for
the generated deals so reconciliation reads as a dealership that has been using
DDMS rather than one that signed up this morning.

> **Reconciliation is string equality.** A `SIM-` prefix on one side and not the
> other manufactures a `CONFLICT` per matched deal. Both sides carry it, because
> every number in that fixture is a policy no insurer issued (R-41).

## The queue is inspectable, not just actionable

`GET /dms/records/{module}/{recordKey}` and `lib/dms/case.ts` — every column on
a record, labelled where there is a label and humanised where there is not.

> *"I understand the automation is working fine, but it should open the case."*

The queue told somebody *what to do* and offered a button, with no way to see
the record the instruction came from. **Complete rather than curated**: a column
nobody has taught `case.ts` about still appears, because a value that exists and
is invisible is the failure worth designing against, and a tidy view is how that
happens six months after somebody adds a column.

Each field says `MIRROR` (the manufacturer's, never written back), `DDMS` (what
this product concluded) or `META` (sync bookkeeping). Only one of the three is
anybody's to change here. Where a value arrived by report or scan, its
confidence shows beside it (OBJ-24, R-85).

The up-next list is navigable — any row jumps to its card. Ordering the work is
the product's job; *insisting* on the order is not.

> **A display cap became a reported figure.** The vehicle row said *"5 people
> are asking for this model"* on a model with 31 open enquiries: the code took
> `.slice(0, 5)` and reported that length as the count. Two fields now,
> `matchingEnquiries` and `matchingEnquiryCount`, because they answer two
> questions.

> **An instruction with no reason behind it.** *"Offer it to Mrs Geeta Mahto"*
> was `matches[0]` — whichever row Postgres returned first, which meant sending
> a salesman to a COLD enquiry while three HOT ones waited. Ordered now by the
> grade the salesman gave and then by who has waited longest, and the row says
> which: *"the hottest of the 31 asking, waiting 24 days"*. An unexplained
> instruction is worse than a wrong one — nobody can overrule it on the
> evidence.

## The case somebody else can pick up

`lib/dms/history.ts`, `GET /dms/records/{module}/{recordKey}/history` and
`/case/:module/:recordKey` (OBJ-49, R-133 to R-137). Built for **handover**,
which is a different goal from the inspection the case panel already served:
when the advisor is off, a manager picks the record up cold and has to
understand it without asking anybody.

> **The timeline read what somebody wrote down. It did not read what somebody
> did.**

That was the defect. `record_activities` carries notes; `decision_log` carries
*Mark customer told* — so the commonest thing an advisor does left no trace on
the record's own history. The history assembles five sources, and **every entry
says which clock it is on** (R-133): their system changing it, a sync noticing
it, a person acting, the agent acting, the customer replying. One merged `when`
column would read a three-day sync gap as three days nobody spent.

**It infers nothing.** No call logged means no call logged, and where nothing has
been recorded it says the ambiguity out loud — nobody tried, or somebody tried
and did not record it, and it cannot tell them apart. It also states where its
history starts: nothing before `firstSeenAt` was ever pulled.

> **`stillHere` has three answers.** True, false on a leaving date, and **null
> for an employee code the staff master has never heard of** (R-134) — a keying
> error is not a departure. It can never say whether somebody came in this
> morning; no DMS carries attendance.

**`JOB_CARD_REASSIGN` is the thirteenth registry action.** `advisorEmpCode` is
whoever opened the card and stays that way until it closes, so the handover sits
*beside* it rather than overwriting a read of it (R-135) — the two disagreeing is
a fact worth showing. The control lives on the case rather than the queue row:
the queue's picker is for the *Nobody's* band, and a handover is the opposite
situation, where somebody is named and simply is not in.

Withheld from both agents, and **not for the reason the other ten are**. It
asserts nothing false; it is held back because a card in progress carries context
in a person's head that a reassignment cannot move with it.

> **A name is copied onto the row, never joined for** (R-137). `ddms_app` holds
> no grants on `users` — that is what makes a leaked credential worthless — so
> the first version of the history was refused by Postgres for reading
> `users.name`. `decision_log` gained `userName`, exactly as
> `record_activities.authorName` already had it. Fifth time a verifier has
> reported a real boundary by reaching for a wider credential.

> **`case.ts` keyed receivables on `invoiceNo`** where the queue, `applyAction`,
> the explain panel and the mirror's own unique index all use `receivableId`. The
> one module whose record key is not the obvious human-readable field was the one
> whose case could not be opened. Any key on a record has to be the key that
> record actually has.

`/case/:module/:recordKey` opens in a **new tab** from every worklist and the
queue (R-136) — a manager keeps six open, compares them, and pastes one to
somebody, and the queue's deliberately-frozen order is left untouched.

`pnpm run verify:history`.

## The document DDMS issues

`lib/dms/invoice/` and three tables (OBJ-25). **DDMS's document is the DMS's
facts plus the commercial agreement, and neither system holds both** — the DMS
does not know what was promised, DDMS does not know the chassis and the tax
split.

**Price lists keep the history the DMS discards** (R-87). A current-state system
holds today's price and forgets yesterday's, and a dealer selling at an older
rate is lawful and his decision. The invoice picks a list, defaults to the
current one, and **prints which it used**. Tax rates are per price-list item
because a motorcycle above 350cc attracts a cess the one below it does not.

**Only one system holds the tax series** (R-90) — `SWITCH.DDMS_HOLDS_TAX_SERIES`,
off by default. Off, DDMS issues a `SALE_CONFIRMATION` carrying the DMS's number
for linkage and saying on its face that it is not a tax invoice (R-89). On, a
`TAX_INVOICE` from its own series, financial year April to March, with a unique
index as the backstop.

**The discount is split by who pays for it** (R-88). The taxable value falls by
what the customer was *given*; `oemSchemeAmount` stays at full value because the
claim is owed on the scheme rather than on the part passed on. An unclaimed
scheme is money given away twice — `GET /dms/invoice/claims`.

**It does not know where the facts came from** (OBJ-30, R-96). The first
version read `dms_deals` and returned 404 when the deal was not there, which
quietly meant *this product issues invoices for dealerships that already have a
system issuing invoices* — excluding the sub-dealer doing five units a month,
who is the customer the standalone generator exists for. Facts now arrive as a
`SaleFacts` from `facts.ts`: a mirrored deal, or **a form somebody typed**. No
third resolver for a scan — a scan reaches the mirror through OBJ-24's
`DOCUMENT` path and is a deal row by the time anything prices it.

The price is the same shape: `resolvePrice` returns a `Priced` from a list, or
from an amount, HSN and rates **stated on the document**, which is what a
dealership has before it has built a list. Overriding a list it does have is
permitted and warned about with the list's own figure, for the same reason
`pricedOffCurrentList` exists. `sale_documents` records `factsOrigin` and
`priceOrigin` so the document can *say* which; nothing downstream reads them.

**A model's read may not reach a tax invoice** (R-97). A field below 0.7
confidence is named and refused on a `TAX_INVOICE` or `SALE_CONFIRMATION`, and
warned about on a quotation — *the gate is on the consequence, not on the
provenance*. The one place in this product where provenance blocks rather than
annotates.

> **A nullable key breaks an equality check silently.** The *sold this twice*
> check matched `dealer_code = $1`, which no null ever satisfies, so a
> sub-dealer's documents would never have collided and the same frame could have
> been invoiced twice — with the check appearing to run and returning nothing,
> every time.

`verify:invoice` proves R-96 as a claim that can fail: **the same sale, issued
twice, once from a mirrored deal and once from a typed form, produces the same
money** — all thirteen money and tax columns compared.

**The document is a page, and the page is the printed thing.** `/invoices/:id`
— no PDF library, no server-side render, no second layout that can drift from
the first: browser print, A4, and a `@media print` block that removes the shell
and nothing else. What somebody checks on screen is what comes out of the
printer, and there is one layout to be wrong rather than two. Every row of the
Issued list opens it, and both "issued" confirmations link straight to it.

R-89 is the whole design of the header: a sale confirmation says on its face
that it is not a tax invoice, above the figures, and the notice prints. That
notice is **computed from the row** by `noticeFor()` in `series.ts`, not fixed
per kind — it names a linked tax invoice number only when there is one, and the
input-credit sentence appears only for a buyer with a GST number, who is the
only reader it can happen to.

> **A document must not assert something that is not on it.** The first notice
> read *"the tax invoice for this sale is issued by the dealership's own system,
> and its number is shown above"* — on a sale confirmation raised before that
> system had invoiced the deal, there is no number above. A false statement on
> the face of a document, produced by the rule written to prevent exactly that.

> **A document has two readers, and only one can act on the provenance** (R-104).
> *Priced per Hero list July 2026 — not the current list* is true and it is the
> dealer's: it answers *why did the product charge this*, which only the person
> who chose the list can act on. To the customer it is an unexplained admission.
> R-87 asked that the product not hide a dealer's decision **from the dealer**;
> it never asked for it to be printed. The provenance block is `print:hidden`
> and labelled *for your records — this is not printed*.
R-88 too — the customer's page shows what *he* was given, and the scheme the
dealer retained is not on his invoice; it is on the claims screen, which is
ours. The amount in words is written out rather than pulled from a library,
because it is what a bank reads when the figures are disputed and there is
nothing to go wrong at install time on a dealer's laptop.

> **An invoice a dealership cannot open is an invoice they cannot hand to the
> customer it was raised for.** The generator issued documents from OBJ-25 and
> there was nowhere to look at one, which made the whole feature a row in a
> list. Found by somebody issuing an invoice and asking where it went.

**`generateDocument` is the only thing that writes a document** (R-81). When a
journey wants an invoice raised it calls that, with a person's consent behind
it. `invoice.generate` is withheld from the agent: it puts a priced document in
a customer's hands and can spend a number that cannot be un-spent. A salesman
may quote and may not invoice — enforced in the route, because that is *what
kind*, not *whether*.

**A second journey, and the runtime did not change to accept it.** `VEHICLE_SALE`
walks deals: booked → allocated → priceable → invoiced → delivered.
`loadFacts` moved onto the definition and `severityState` onto `Step`; nothing
else. `PRICEABLE` is a stall nothing could previously describe — *nobody has
told us what this model costs*.

**`Wait.tone` and the first row that is not a problem.** `OPPORTUNITY` means
*everything is in place, this can be done now*. It does not change the sort: an
opportunity competes on the same three keys, or a dealership does the pleasant
rows first and accumulates the others.

`pnpm run verify:invoice`; `pnpm run db:seed-pricelists` for two lists, the
older of which is the point.

> **A verifier that tidies by owner deletes the dealership's own work.** This
> one reset with `delete from sale_documents where owner_id = 1`, which is right
> for a fixture-only table and wrong here: by the time anybody uses the product
> that table holds *their* invoices. It destroyed two a person had raised, twice,
> because a verifier that passes is one nobody reads the output of. Every
> document it issues is now signed `verify:invoice` in `issuedByName` and reset
> takes back only those; it picks deals nothing has been issued against, and
> **it says how many it worked around**. A verifier that only passes on an empty
> table has never seen the dealership it verifies.

> **Three findings worth keeping.** A quotation blocked the sale that followed
> it — the comment said otherwise and the query filtered on status alone, found
> only by driving the routes. `whyNot` returned the `policy.set` sentence for
> every module-less permission, so a service advisor asking about an invoice was
> told they may not set thresholds. And a correlated subquery through the ORM's
> SQL template silently returned 1 for a list holding six.

## The books, the return and the feeder

`lib/dms/ledger/` and three tables (OBJ-31 to OBJ-33, R-98 to R-103). The first
thing in this product where being wrong is a filing offence rather than a bad
morning.

**No model is anywhere near it and there is nowhere one could go.** R-100
restates R-78 where the consequence is statutory. Every branch in `post.ts` is a
comparison against a stored value or a lookup in a table declared above it.

**The input is a `sale_document`, not a PDF.** DDMS already produces the
invoice; the ledger posts what DDMS issued. A dealership whose invoices never
pass through DDMS arrives at the same place through OBJ-24's `DOCUMENT` path, so
there is exactly one thing to post from.

```
  Dr  Sundry Debtors                    total on the invoice
      Cr  Vehicle Sales                 taxable value
      Cr  Output CGST / SGST / IGST     the split as printed
      Cr  Road Tax / Registration /     R-103 — collected for somebody else
          Insurance Premium Payable
      Cr  Suspense                      unrecognised, never income
  Dr  Cost of Goods Sold                R-102 — the bike has left the floor
      Cr  Vehicle Stock
```

**R-103 is worth a number.** On an ₹84,000 sale this dealership collects ₹17,750
for the RTO and an insurer. Crediting it to income reports turnover **21% higher
than it is** — and that error escapes the books: turnover drives the tax on it,
the GST registration thresholds and the OEM's slabs. A charge whose label
nothing recognises goes to **suspense, never income**, because overstating
turnover is the failure being designed against and the default has to fall the
other way.

**R-102's honest failure.** A chassis not in stock gets no invented cost. The
revenue posts, the relief does not, and the warning says *until it is, the whole
selling price reads as margin.* Refusing would deny a sale that happened.

**R-101 is an index.** Partial unique on `(sourceKind, sourceId) where status =
'POSTED'`, so a concurrent retry loses at the database rather than both winning.
Correction is **reverse and re-issue** — the original stays `REVERSED`, a new
voucher carries every line mirrored, dated today because reversing an April
entry in September is a September event and back-dating reopens a filed month.

**The chart is Tally-shaped and `tallyName` is theirs to change.** One invented
from first principles would not map onto the one their CA has used for eleven
years. `isSystem` accounts rename and do not delete: a rule that cannot find its
account has no honest behaviour — a substitute misstates silently, a skipped
line will not balance.

**Where it is not yet Tally-logical, and it matters.** Tally gives every
customer their *own ledger* under the Sundry Debtors group, which is what makes
a party statement and bill-wise tracking possible. DDMS posts every debtor to
one `Sundry Debtors` account with the name as a line attribute, so the feed
imports with the party visible and a per-customer statement inside Tally is not
possible from it. There are also no receipt or payment vouchers, so debtors
never clear. Both are the next piece of ledger work, not oversights.

**The OEM scheme is deliberately not posted.** Whether it is income or a
reduction of cost is the dealership's CA's judgement, and R-98 says feed their
books rather than decide their policy. Named in the warnings, worked on the
claims screen.

### The cost side, and the door it needed

`lib/dms/ledger/journal.ts` and the chart's second half (OBJ-50, R-138 to
R-142). Read out of the database, the gap was one line long: **28 accounts,
three of them expenses, two of those cost of goods sold.** A five-branch
dealership's entire operating cost — rent, salaries, power, advertising,
interest, depreciation — was one account called *Discount Allowed*, and **no
route in the product touched `ledger_accounts`**, so nobody could add a head.

**Sixteen starter accounts, and none of them `isSystem`** (R-138). Every account
in `CHART` is undeletable because a posting rule names it by code; nothing names
these. Marking them system would make them undeletable because *we* decided a
dealership ought to want them, which is not the same thing.

**`offerStarterChart` is a deliberate act, not a seeding step** (R-140). The
first version seeded them inside `ensureChart` on an empty chart, which was
wrong in both directions and the verifier said so on its first run: every
dealership already using the product has a chart, so **none would ever have
received the heads** — and a gap-filling rule puts *Printing & Stationery* back
next Tuesday for somebody who deliberately deleted it.

**`postJournal` is the eighth door and the only one that starts from a person.**
The other seven all begin with a document DDMS issued, so nothing could book an
accrual, a provision, a depreciation charge, or a March reclassification. It
refuses a journal that is unbalanced, one-sided, negative, empty, against an
unknown or retired account, or into a locked period (the trigger's own sentence,
caught not restated). It is a **new voucher, never an edit** (R-141) — `/books`
still has no edit control.

> **A line against a control account with no party is warned, not refused.** The
> balance on `1100` is meant to equal the party ledgers under it, so a line with
> nobody's name leaves money that reconciles to nothing — but a provision for
> doubtful debts genuinely belongs to no single customer. The product names the
> consequence and points at the reconciliation.

> **A guard that fires first decides what the refusal says** (R-142). A line for
> minus a hundred was refused with *has no amount on it*, because `debit <= 0`
> caught it before the negative check. True, passes a test, and tells the person
> the opposite of what happened. The order of two guards was the whole bug, and
> it was only caught because the check asserted the sentence rather than the
> boolean.

> **`ddms_worker` may not write `ledger_accounts`.** Creating an account is a
> person's act. Sixth time a verifier has reported a real boundary by reaching
> for a wider credential.

> **Voucher numbers are bare integers.** `nextVoucherNo` returns `"1"`, `"2"` for
> every kind, gapless per kind per financial year — not `JV/2026-27/0001`.
> Nothing is wrong; an auditor expects a series on the face of a voucher, and
> `numberingGaps` parses digits out of it. Named rather than changed, because
> changing the format mid-year is its own decision.

`pnpm run verify:journal`.

### The floor has a creditor and a cost

`lib/dms/ledger/floorplan.ts` and `interest_accruals` (OBJ-51, R-143 to R-146).
Two defects, different in kind. **A misfiled liability**: `postPurchaseInvoice`
always credits Sundry Creditors against the supplier, so a floor-plan purchase
showed ₹57.9 lakh owed to Hero — a company the financier had already paid —
while the party who can call the money in was invisible. **A missing cost**: the
interest was computed per unit per day, put on the Inventory screen, and posted
nowhere.

The purchase posting is **unchanged**. Buying from Hero and being funded are two
events, and collapsing them loses the input credit's link to Hero's invoice.
`recordDrawdown` does the second: `Dr Sundry Creditors → Hero / Cr Floor Plan →
the financier`, and **no money moves** — which is why it is easy to forget.

> **`floorPlanInterest` is exported from `inventory-worklist.ts` and imported by
> the ledger** (R-144). One arithmetic, two readers. A dealership told ₹68,980 on
> a screen and something else in its own books stops believing both.

> **This one has a table when almost nothing else does** (R-145). The
> reconciliations, the central end of day and the trial balance are derived on
> read because a stored sum drifts from its parts. An accrual is the opposite:
> **posting it changes the books**, so the question is not *what is the number*
> but *has this period been charged* — a fact about what was done. The unique
> index on `(showroom, period)` makes charging November twice impossible, and a
> doubled interest charge is exactly the size of error nobody spots.

> **A periodic charge charges the period** (R-146). The month's figure is the
> difference between two positions, not the running total — a run that booked
> everything accrued to date would re-charge every earlier month and treble the
> cost by March.

**A drawdown against a party who is not a `FINANCIER` is refused**, not warned:
that is a large liability filed under somebody who does not hold it, and
`parties.kind` already knows. More than the bill is refused; less is permitted
and warned about, because a margin the dealership funds itself is ordinary.

**The honest limit is on the voucher.** `dms_vehicle_stock` records *that* a
machine is financed and never *by whom*, so the monthly charge carries no
financier's name and says so.

`pnpm run verify:floorplan`.

### The one screen that writes to the ledger

`/journal` (R-147). Beside `/books` rather than inside it — `/books` is read-only
and stays that way, and a journal is a new voucher rather than an edit.

> **The screen never decides what the server decides.** The running total shows
> the two columns and their difference and **leaves the post button live either
> way**. A client-side balance check would be a second implementation of a rule
> that already exists on the server, and the one people trust is not the one that
> refuses.

Typing in the debit column clears the credit column, which makes the *both a
debit and a credit* refusal unreachable by accident rather than merely explained
afterwards. A line against `1100` or `2100` offers the party picker and says what
happens without one. The chart sits underneath, collapsed, with *add the standard
expense heads*, *an account of your own*, and a retire control that is absent on
anything a posting rule names.

### GSTR-1 and Tally share one file

They are one claim about the same numbers; if they disagreed nobody could tell
which was wrong. **Nothing in either recomputes tax** — the rate and split were
decided when the invoice was priced and printed on a document a customer holds.

B2B is invoice-wise and B2C is aggregated because they are different filings.
Getting it wrong produces a return the portal accepts and a buyer who cannot
claim their credit, which the dealership hears about three months later.

Building the feed and marking it handed over are **two calls**: a download that
failed halfway would leave vouchers marked exported that nobody received, and
the next feed would skip them.

`grant select on vouchers to ddms_worker` and nothing more — nothing unattended
posts to a dealership's accounts. `/books` has no edit control and will not get
one. `pnpm run verify:ledger`, thirty checks.

> **A `date` column and `like` do not meet.** The verifier's independent
> cross-check filtered a month with `voucher_date like '2026-08%'` and Postgres
> refused it outright. Worth noting because it failed *loudly* — the same
> comparison against a `text` column runs and quietly matches nothing.

> **`db:push` without `db:rls` behind it broke six verifiers at once.** The rule
> is at the top of this file and this is exactly why: a push resets policy state,
> `record_activities` began refusing its own inserts, and it read as six
> unrelated regressions rather than one missing command.

## The network: what moves, who decides, who checks

`lib/dms/ledger/moves.ts`, `allocation.ts` and `eod.ts` (OBJ-46 to OBJ-48,
R-128 to R-132). One question at three levels — what moves between branches, who
decides that it moves, and who checks at the end of the day that it added up.

**A challan carries machines or parts.** `stock_move_lines.kind` is `VEHICLE` or
`PART`; a machine has a chassis and a life on the register, a part has a number
and a quantity and no register at all. A database check constraint enforces
exactly one identifier per line, because a guarantee that only holds for callers
who went through TypeScript is not a guarantee.

> **The shelf falls on despatch and rises on receipt — the opposite of a
> machine.** A vehicle's mirror row moves branch on arrival and the chassis
> register says *nowhere* in between, which the stock reconciliation reads. A
> part has no register, so if the count only fell on arrival the sending branch's
> shelf would overstate for as long as the van was out. The difference between
> the two ends **is** the goods in transit, and that is what the first
> reconciliation reports.

> **A shelf may go negative and is never clamped.** Below zero is the books
> saying the branch shipped or issued more than it held (R-129). Clamping
> destroys the only evidence it happened. `negativeShelves` names the branch and
> the part, under the stock reconciliation — which for parts is not two sources
> compared but *the one thing a shelf cannot be*, because a quantity has no
> second opinion anywhere.

**Receiving a part at a branch that has never held it writes a mirror row**, and
that is the one place this product does. Refusing would mean the box arrived and
nothing recorded it. The line carries the *sending* branch's dealer code and the
warning says the dealership's own system does not know; at a branch that syncs,
the next pull marks it disappeared, which is the honest signal rather than a
defect.

**`planAllocation` reads; `commitAllocation` refuses without a named approver**
(R-130). One morning's allocation is one decision and still as many challans as
there are destinations, because a delivery challan carries one consignee.
Demand is open bookings plus the display floor — **an enquiry is not demand**.
Supply is the yard minus anything allocated or already on an open challan, oldest
first, deterministic. Nothing goes to a `SERVICE` branch, decided by `role` and
never by name. `ALLOCATION.DISPLAY_FLOOR` and `ALLOCATION.MAX_PER_BRANCH` are the
dealership's, and are per **owner** rather than per branch — a real limit, not an
oversight.

**`centralEndOfDay` is derived, stores nothing and closes nothing** (R-131). It
is a sum of branch day-closes; a stored roll-up would come to disagree with them,
and a company-level close would journal something no branch authorised. A branch
that never closed is an **absence, not a zero**, so `reconciles` needs both
conditions: every branch closed, and every close agreed. Financier and OEM
receipts are read off `parties.kind` and sit beside the cash, never inside it.

`pnpm run verify:allocation`, `pnpm run verify:eod`, and §8 of
`pnpm run verify:moves` — whose claim is **conservation** rather than arrival: a
version that raised the destination and forgot the source would pass "the
workshop received four" while manufacturing stock on every van run.

## Three ways in, one record

`lib/dms/ingest/` — the mirror no longer assumes an OEM API (OBJ-24, R-84). A
dealership takes deals by `API`, `REPORT` (a spreadsheet they export and drop)
or `DOCUMENT` (a scan), **per data type per outlet**, defaulting to `API` so an
unconfigured dealership behaves exactly as it always did.

> **Ingestion varies. Completion does not.**

**The seam is a `Source<T>`, not a format.** `list()` is cheap and answers *what
can you see*; `load(keys)` is expensive and answers *give me these in full*.
That split preserves the API path's one essential optimisation — most rows are
untouched most of the time — and every path fits it honestly. `sync.ts` resolves
a source and nothing below that line branches on the path.

Two properties the source is asked rather than assumed, and both prevent real
damage:

- **`listIsComplete`** — false for documents. One scanned invoice says nothing
  about the other four hundred deals, and treating *not listed* as *gone* would
  disappear the whole book.
- **partial records merge** — an absent field on a document means *the document
  did not say*, never *the value is gone*.

**The mapping graduates**: a model proposes once per export shape, a person
confirms once, and every file thereafter is read by column position with **no
model at all**. Keyed on a hash of the sorted headings. The model sees *headings
only* — never a cell — so it cannot invent a value; its proposals are checked
against the file the way `checkRewrite` checks a draft. `ddms_worker` holds
select and update on `ingest_mappings` and **not insert**: a mapping is what a
person said the columns mean.

**Provenance sits beside the value, never inside it** (R-85). `dms_deals` gained
`ingest_path`, `field_confidence` and `ingest_batch_id`. The worklist reads
`invoiceNo`, not `invoiceNo.value`. The confidence map is sparse — an API field
is certain, and a megabyte of 1.0s asserts nothing.

VeloDocs has the confirmation screen, beside the API pull rather than beneath
it. `pnpm run verify:ingest` generates the export **from the mirror** and proves
every projected column identical across paths.

> **A key alone does not make a record.** Every dealer export ends
> `Total,,,,,,78 deals,,,` and *Total* lands in the deal-number column — the
> first version imported the footer as a deal priced at 78. A record needs its
> key **plus two other fields**.

**All seven modules.** Widening the first time proved the seam was one: the
mapping was deal-bound in six places and the report source in one, and once
those were generic a second module cost a **field vocabulary and a source
function**. `FIELDS_FOR` and `SYNONYMS_FOR` are keyed by data type, `extract`
builds its record from whichever vocabulary it was handed, and the key is *the
first required field* rather than `dealId`.

Synonyms are per data type on purpose, not one flat table: `Status` means the
deal's status on one export and the lead's stage on another, and a merged table
would have matched a deal field on an enquiry file and looked like it worked.

The field names are **the DMS's, not ours** — `enqDt`, not `enquiredAt`. Each
sync already converts its own summary shape into mirror columns, and a report
producing our names would need a second converter that could disagree with the
first.

**Where the trade has a word, use the trade's word.** The import screen read
*What the file is*, *Take it in* and *What has been taken in* — plain enough,
and not what anybody in a dealership calls these things. The people onboarding a
dealer are its own administrator and an implementation consultant, and both
already have words: **data type**, **import**, **import history**, **column
mapping**. Inventing friendlier ones makes a product read as though it were
built by people who have not done the job. Write plainly everywhere the trade
has no word.

The outlet is a picker over `listShowrooms`, not a box somebody types `1` into:
an id they do not hold sends the file to another branch of their own group,
which is a silent import into the wrong outlet rather than an error. And the
native file input is hidden behind a label — *Choose file · no file chosen* is
the browser's wording at the browser's height, so it read as neither a control
nor a field.

`GET /dms/ingest/sources` returns `reportable`, and the picker is built from it.
**A picker offering a path that does nothing is worse than one with two
entries** — the dealership drops the file, nothing happens, and the product has
told them a lie with a dropdown.

`sample-reports/` holds eight exports per outlet, generated from the mirror by
`db:export-reports`. All seven droppable ones map **every heading by name with
no model called**: vehicle stock 14/14, enquiries 14/14, deals 16/16,
registrations 26/26, job cards 16/16, parts 12/12, receivables 16/16. The eighth
is the staff master, which has no data type of its own — employees sync inside
the enquiry pass, because the lead derivation joins against them and a stale
roster reports a lead as owned when its owner left last month.

> **A report carries the answer, not the working.** `project()` on a job card
> reads `jc.parts.some(p => p.issuedFlg === "N")` and on a registration file it
> reads the outstanding document lines — nested shapes a flat file cannot hold.
> The vocabulary asks for the **flags** instead, which the dealer's own register
> already prints, and the source rebuilds exactly the shape the projection reads
> and nothing more. Asking a dealership to export every part line so we can
> recompute a boolean they handed us is asking for the working when they gave us
> the answer, and it is how an onboarding fails on the first afternoon.

Three source shapes cover all seven: `wholeListSource` where the client returns
the record in one call (parts, receivables, vehicle stock), `summaryThenFetchSource`
where the detail carries lines the summary does not (deals, job cards,
registrations, enquiries), and `reportSource` for a dropped file.

> The file bodies live in memory — there is no object storage — so a restart
> loses a held drop's bytes but never its audit row.

## Where each sale has got to

`lib/dms/journeys/` — the first thing in the product that understands a
**journey** rather than a record (OBJ-23, R-77). One definition,
`VEHICLE_DELIVERY`: nine steps from the invoice to the certificate in the
customer's hands, across four screens that do not know they describe one sale.

**The definition is code and versioned**, in `vehicle-delivery.ts`. Every fork is
a column test — is the policy on the file, is the tax remitted, did a number come
back — so there is no journey builder and will not be one (R-52 unchanged).

> **A model may write a sentence inside a step. It may never choose an edge.**

`done`, `wait` and `returnsTo` are synchronous pure functions taking no client,
which is the first line of that rule rather than a comment about it.

**The walk: the position is the first step that is not done.** Not the step after
the last one seen to complete — that advances once per pass and can never go
backwards. Because the walk is total, the loop needs no special case: when the
RTO rejects a file, `DOCUMENTS` stops being done and the position *is* earlier.
The `journey_steps` row records `BACKWARD` and carries the objection.

**The ending is the last step, not the absence of gaps.** A vehicle whose plate
date was never recorded is still a delivered vehicle.

**Four kinds of waiting**, and this is what the old model could not express:
`PERSON` is always a queue row, `OUTSIDE` becomes one once it passes the
dealership's own threshold, `JOURNEY` blocks everything behind it, and **`TIME`
never raises one**. A file lodged on Tuesday is not work on Wednesday.

**A stalled step is the queue row, and the classifier stands aside.** A
registration file with a live journey produces exactly one row and the runtime
writes it — `QueueItem.source` is `DERIVED | TASK | JOURNEY`. Severity is
borrowed from the dealership's `SEVERITY.REGISTRATION.*` keys, as a function of
the facts, because one step can be two degrees of urgent.

**Nothing lives in memory.** The position is two rows in Postgres and the facts
come from the mirror, so a restart mid-flight is the ordinary pass run twice.
`advanceJourneys` runs in the scheduler before the rules, because the agent pass
reads the queue.

**It writes `journeys` and `journey_steps` and nothing else** — no decision
field, nothing on the mirror. `ddms_worker` may insert and update a journey and
may neither delete nor update an arrival: the newest arrival *is* the position,
so rewriting one would not lose history, it would change what the runtime
believes now.

`pnpm run verify:journey` — a simulated month with no database, then the durable
half on the worker credential.

> **Absence of evidence is not evidence of absence.** `INVOICED.done` was
> `Boolean(invoiceNo)` and put nine files on the queue asking somebody to invoice
> a vehicle that was already registered — their deals are not in the deal mirror,
> so the join returned nothing. A registration file only exists because the sale
> was invoiced. Same shape as the employee rule: **silence is not a departure**,
> and a subject missing from a fact-set means the walk has nothing to say about
> it, not that the file is gone.

## The records DDMS owns

`record_activities` and `tasks` — the first tables that are neither a copy of
the dealer's data nor a decision field hung off one (OBJ-22, R-76). No
`disappeared_at`, nothing reconciles them upstream, no sync pass overwrites them.

**The rule that makes them safe to let an agent near**, in `lib/dms/records.ts`:

> An agent may record what the agent did. It may never record what a person did.

`AGENT_KINDS` is `OBSERVED` and `SYSTEM`, and that is the whole set. `CALL`,
`VISIT` and `MESSAGE` assert a human act; each carries a written refusal. **This
is the objective that unlocks the agent** — eight registry actions are closed to
it because they assert a person rang somebody, and an activity it wrote asserts
only that it wrote it.

Gated twice: the permission table says whether a principal may write, the row
policy says which records, using the same `app.can_read(module)` as the mirror
row. A service advisor writing about a registration file is refused by Postgres.

**Tasks live in the queue, not beside it.** `QueueItem.source` is `DERIVED` or
`TASK`; severity comes from the due date, not from whoever raised it. There is
no task list endpoint on purpose.

`ddms_worker` may select, insert and update these and **not delete**. Nothing
unattended erases a record, not even its own — an activity is retracted, struck
through with its reason, never removed.

`pnpm run verify:records` — on the worker credential, because the claim is about
what happens with nobody signed in.

## One permission table

`lib/dms/permissions.ts` — verb-scoped `namespace.verb`, and it is the only
place any permission question is answered. `access.ts` is gone.

**The agent is a principal in it**, not a special case beside it. `AGENT_ACTIONS`
and `CLOSED_TO_THE_AGENT` are derived from the table; the ten written reasons
live in `WITHHELD.AGENT` and `whyNot()` reads them. A second agent (OBJ-29) is a
principal plus a set of grants, and `agent.ts` does not change.

`may(principal, permission)` is the one question. `whyNot()` phrases the refusal
— a hand-written reason where there is one, otherwise assembled from what the
principal *can* do, because the commonest cause of a refusal is somebody given
the wrong role on their first day.

The session carries `permissions`, so no screen works out for itself whether
somebody is an owner. Cosmetic, like `modules` — the route refuses and the row
policies refuse.

`pnpm run verify:permissions` — thirty checks, no database, no server.

> **This objective changed no grants.** Who may do what is exactly what it was;
> it is written in one place for the first time. Separating *reading a module*
> from *acting on it* is a deferred product decision, and the seam now exists
> for it to land in.

> **`POST /dms/actions` used to check nothing** and was never exploitable —
> `app.can_read(module)` is in every mirror table's row policy. But the caller
> got `404 No receivable X`, which is a lie: it exists, they cannot see it. Now
> a 403 that names their role. 404 stays the right answer across dealerships.

## The agent operates the registry

`lib/dms/agent.ts`. The agent calls the same `applyAction()` a button calls, with
`userId` null, so every refusal is inherited rather than repeated — 409 for a
departed employee, 404 across tenants, row-level security underneath.

**Two of the twelve actions, and the other ten are named with reasons in
`CLOSED_TO_THE_AGENT`.** Eight assert a *person* did something (rang the
customer, chased the RTO, showed the bike), which is OBJ-16's objection to a
rule writing a decision field and it does not weaken when the writer is a model.
One is a judgement about whether an account is in breach, which R-49 reserves.
One asserts a purchase order in the dealer's own system, which DDMS never writes
to. What survives — `ENQUIRY_REASSIGN`, `REGISTRATION_ASSIGN_AGENT` — records a
routing decision DDMS itself is making, over the queue's **Nobody's** band and
nowhere else.

**The rule chooses; the model may only phrase.** Lightest-loaded person in the
role the queue asks for, from `listStaff`, which already excludes anybody who
left. A model may write the sentence, checked by `citationsHold()`. No key, no
model, no change in behaviour.

**Off until a dealership turns it on** — `AGENT.ASSIGN_ORPHANS`, default 0, the
first `unit: "switch"` in the policy registry. Off, the suggestion rides on the
queue row and a person's click applies it, logged as theirs. On, the scheduler
assigns after the rules and the log carries null. `ddms_worker` may **read**
`dealer_policy` and not write it, so the unattended process cannot switch itself
on.

`pnpm run verify:agent` — eleven steps on the worker credential, including both
refusals and a person's undo.

**A person may write their own sentence into a draft, and doing so closes the
rule path.** `POST /api/dms/messages/{id}/edit`, `DRAFT` only (R-75). The rule
permits text a *rule* composed — checked against the facts, identical every
time; a sentence somebody typed is none of those things, so `authoriseSend()`
refuses it a `RULE` basis and the person who wrote it approves it instead
(R-72). The composed text is kept in `composedBody`, **written once** so it
stays the rule's wording rather than the previous edit's (R-73), `draftedBy`
becomes `PERSON`, and the edit is a `MESSAGE_EDITED` row with both versions
(R-74).

The point is not the textarea. `checkRewrite()` exists because a *model* asked
to rephrase can invent a figure the facts do not support; a named manager adding
*"Mr Verma is coming in on Saturday, please have the file ready"* is asserting
something only they know, and there is nothing in the mirror to check it
against. The old answer — cancel it and fix the record — meant somebody
cancelled the draft and picked up the phone, and the Outbox stopped being used.

Rules run in the scheduler after detection, on `ddms_worker` — which is why that
role now holds the outbox and the decision log.

## Watching what runs on its own

`lib/dms/trace.ts`, `lib/dms/model.ts` and two tables (OBJ-28, R-92 to R-94).

> **You cannot supervise what you cannot watch.**

`decision_log` answers *what happened to this record* and answers it well. It
cannot answer *what did the agent do at half past two*, because a run is a
narrative **across** records — a hundred and forty looked at, eleven offered,
two refused, one acted on, four model calls — and that shape lives in no
per-record table. Reconstructing it meant sorting the decision log by timestamp
and guessing where a pass began.

**The trace is ambient, for the same reason the database handle is.** `withRun`
opens a run into an `AsyncLocalStorage` and everything underneath records
against it by calling `step()`. The alternative was threading a run id through
four signatures that do not care about it, and a fifth call site that forgets.
**Outside a run every function is a no-op** — a person pressing a button is not
a trace and must not become one, or the steps table becomes a second logger
inside the database.

**A step that produced a write names its `decision_log` row rather than
repeating it.** Two tables telling the story of one write is how they come to
disagree, and the one somebody reads is not necessarily the one they would
trust. `applyAction` returns `decisionId` for exactly this.

### One door for model calls

There were three near-identical fetches — the composer's rewrite, the
explanation's narration, the ingest mapping's heading reader — with error
handling that had drifted apart and **no single place that could count what any
of it cost**. A ceiling that knows about two of three call sites is not a
ceiling. `askModel()` is the one door, metering is by construction, and a
fourth call site is metered without whoever adds it remembering.

Cost uses the provider's own `usageMetadata` token counts times a rate table in
code, so the only inaccuracy is the rate — correctable in one place rather than
compounding per call. **It is an estimate and is called one** everywhere it is
shown. An unknown model bills at the top of the table: the failure that matters
is a ceiling that lets a run through because nobody added its model.

Metering happens on **every** exit including failures. A run where nine calls in
ten fail is exactly what somebody needs to see; recording only the successes
produces a tidy trace of a broken pass.

### The stand-down

`AGENT.DAILY_COST_CAP_PAISE` (₹50) and `AGENT.STAND_DOWN_PCT` (40), both the
dealership's. Two reasons to stop and they differ in kind. **Money** is
arithmetic and is the only defence against a loop that would spend all night.
**Being overruled** is the interesting one: it is the ladder coming down, one
level up. The ladder demotes a *pattern* people keep overruling; this pauses the
*agent* when it is being overruled broadly, because a product that keeps
proposing while a dealership keeps saying no is one they stop reading and then
stop trusting.

The rate is computed across every pattern, not per pattern — one pattern going
badly should demote that pattern, not silence everything — and the ceiling sits
above `AUTONOMY.OVERRIDE_CEILING_PCT` for the same reason.

**It recovers by itself.** Acceptance improves inside the window, or the day
turns over. A pause needing a person to clear it is an outage, not a safety
mechanism. And **nothing a person presses is affected**: a cap on unattended
spending is not a reason to stop somebody doing their job.

A stand-down is written as a run with outcome `STOOD_DOWN`, because *the agent
chose not to act* and *nothing was scheduled* are different facts and only one
needs looking into. The banner clears itself the moment a good run follows —
a warning nothing ever clears is one people learn to ignore.

`/runs` is the screen: read-only for everybody, including owners. A run is
opened and closed by the thing doing the running, and a person editing what an
unattended process recorded about itself is the single change that would make
the table worthless. `grant select on agent_runs to ddms_app` carries the
refusal.

> **A verifier that ignores a return value will one day pass while doing
> nothing.** `verify:trace` set the cost ceiling to 1 paisa and never checked
> what `setPolicy` said. The registry's floor for that key is 100, so the write
> was refused — correctly, by the closed policy registry doing its job — the cap
> stayed at its default, and two checks failed for a reason unrelated to the
> ceiling. It now lowers the cap to the registry's own floor, asserts the write
> succeeded, and spends past it for real.

`pnpm run verify:trace`.

## A second agent

`lib/dms/stock-agent.ts`, one principal and eight grants (OBJ-29, R-95). The
whole point of it is how little it cost.

> **A second agent is a principal and a set of grants, and `agent.ts` does not
> change.**

`agent.ts` did not change. Not a line. The new agent is a principal in
`permissions.ts`, a list beside it, and its own file — which calls the same
`applyAction` a person's button calls, inherits the same refusals, stands on the
same ladder and appears in the same trace.

**It does one thing.** When a customer is waiting on a part that is out of stock
here and sitting on a shelf at another branch, it proposes requesting the
transfer. That is the finding the spares module exists for and no branch system
can produce it, and it is **DDMS's own routing decision** rather than a claim
about anybody — which is why the grant was available to give.

**Why a second agent rather than a wider first one.** `part.request_transfer`
and `vehicle.propose_transfer` were withheld from `AGENT` with the reason *"not
the band this agent is pointed at"*. Granting them to `AGENT` would have been
the smaller diff and the worse design: the ladder would then judge handing out
enquiries and committing a part to a van on **one** count, so a dealership that
trusts the first and distrusts the second has no way to say so. Two principals,
two standings, two independent rungs.

**The ladder took a principal and defaulted it.** `ceilingFor(action,
principal = "AGENT")` — so `PART_REQUEST_TRANSFER` is automatic for the stock
agent and capped at pre-filled for the first, both answers out of the same
permission table, and four existing call sites needed no edit.

**`ANY_AGENT_REFUSAL` is the shared half of `WITHHELD`.** Lifted rather than
copied, because the copy is the failure: two agents refused the same act for the
same reason must get the *same words*, or they drift and a year later the
product gives two explanations for one rule. Everything in it is about **what
the act asserts**, which is why it does not depend on who is asking.

> **The verifier caught this being a near-identical rewrite.** The first version
> of `WITHHELD.STOCK_AGENT` had thirteen hand-written sentences that said what
> the first agent's said in slightly fewer words — which is exactly the drift
> R-95 was trying to prevent, written by the person implementing R-95.
> `verify:agents` §3 compares the two agents' sentences and failed on eight of
> them. The fix was to share the strings, not to loosen the check.

> **And then the exemption went stale.** `VEHICLE_MARK_OFFERED` was on the
> check's expected-to-differ list; once the reasons were genuinely shared it
> stopped differing, and leaving it there would have been an exemption quietly
> covering nothing. A stale exemption is how a check stops checking.

The runtime is deliberately **not** shared with `agent.ts`. The two differ in
what they read, what they propose, and what a proposal even is — one picks a
person, the other picks a branch — and the common part is four lines of loop.
Factoring that out produces an abstraction widened by every third agent with a
slightly different shape, which is how a two-agent runtime becomes a workflow
engine nobody can predict.

`pnpm run verify:agents` — twenty checks, and sections 1 to 4 need no database,
because a check that needs one to answer *may this principal do that* has
quietly moved the answer somewhere else.

## Autonomy is earned, not set

`lib/dms/precedent.ts`, `lib/dms/autonomy.ts`, `lib/dms/proposals.ts` and two
tables (OBJ-26, R-66 to R-71, R-79, R-80). Everyone builds autonomy as a dial
somebody sets — a guess made on the first afternoon about work nobody has
watched the product do. This is a count.

| | what the product does | who decides |
|---|---|---|
| **0 · watching** | notices a pattern, says nothing | nobody |
| **1 · recall** | *"the last 7 times, you gave it to Jaswinder"* | a person, every time |
| **2 · pre-filled** | the answer is already selected; press go | a person, faster |
| **3 · automatic** | *"10 out of 10 — shall I just do it?"* → consent, once | a person, once, revocably |

**Why it is safer than a dial, and it is not obvious.** At rungs 0 to 2 the
model does **recall, never judgement** — *what happened before* is a question
with an answer, where *what should happen* is not. R-49 survives intact the
whole way up, and the graduation **is** the safety mechanism rather than
something bolted beside it. R-69 does not bend either: precedent is the
**evidence a person consents on**, and the consent is what authorises.

**Precedent is a query, not a store** (R-67). Derived on read from
`decision_log` and `record_events`, both append-only and both writable only
through `applyAction`. Nothing is written, so there is no ingestion surface to
poison — and the commonest poisoning payload in the literature is a
plausible-looking *preference*, which this design has nowhere to put.

**Only people count** (R-66). One predicate, `userId is not null`. An agent that
re-reads its own output as evidence turns one early mistake into a settled
belief, and the loop is invisible from inside.

**A count and a date, or nothing** (R-68). Null rather than a hedge: a queue
that says something about every item teaches people to stop reading it.

**The pattern is `MODULE:STATE:ACTION`**, and the state comes from the newest
`record_events` row **at or before the decision** — the state the person was
looking at. Using the record's current state would re-file every past decision
under whatever happened to it afterwards.

**Rungs 0 to 2 are derived; only rung 3 is stored.**

> **Consent raises the ceiling. Evidence sets what has been earned. Both have to
> hold.**

A consent standing while acceptance falls does not keep a pattern automatic —
the rung drops, the consent row stays untouched and still true, and recovery
needs nobody to re-grant anything. Demotion floors at `RECALL`, not silence:
people overriding the *choice* have not stopped having a habit.

**The floor is `may("AGENT", …)`** (R-80) — the same table that answers for a
service advisor, so it cannot drift, with `whyNot()` supplying the sentence.
Eight of the twelve registry actions assert a *person* did something; those
patterns reach pre-filled and stop. An owner cannot consent past it either.

**`agent_proposals` is the substrate and the agent writes only half of it.**
It records what was offered; **nothing writes an acceptance**.
`resolveProposals` compares what a person actually did against what was on
offer, deterministically, no model. `EXPIRED` — nobody got to it — counts
neither way, because a busy week is not a rejection.

**`AGENT.ASSIGN_ORPHANS` narrowed.** It used to mean *act on the whole Nobody's
band*; it now means *anything may run unattended at all*, and the rung decides
which. A dealership that switches the agent on with no history gets suggestions,
not actions.

Five thresholds in the policy registry, all theirs. `/learned` is the screen —
an automation layer nobody can see is where an automation layer nobody can
predict begins. `pnpm run verify:autonomy`, ten sections on the worker
credential.

> **The verifier tried to grant consent as the scheduler and was refused.**
> `ddms_worker` holds select and no insert on `autonomy_consents`, because an
> unattended process that could grant itself standing permission to act
> unattended is the whole failure the ladder prevents. The accident became a
> check. Same shape as OBJ-24 on `ingest_mappings`.

> **A rung the product cannot honour is worse than no rung.** `MESSAGE_EDITED`
> has no button to pre-fill, so its ceiling is `RECALL` rather than `PREFILLED`
> — otherwise the screen reports a rung it reached while nothing ever changed.

## The overall view

`lib/dms/overview.ts` and `GET /api/dms/overview` (OBJ-35, R-107, R-108). The
queue answers *what do I do next* for the person doing the work. This answers
**how is the business doing** for the person who owns it, and until it existed
the only way to ask was to open seven screens and add up.

**It derives nothing.** Every figure is already computed by the seven
classifiers, the queue's bands, the reconciliation, the outbox gate or the
ladder's standing. This loops the visible outlets, calls the same builders every
worklist route calls, and adds up what comes back. A dashboard that computes its
own version of *overdue* is a second answer to a question the product already
answers, and the two drift within a month — the owner's screen says eleven and
the receivables screen says nine, and from then on nobody trusts either.

Six bands: what is waiting on somebody, the dealership's money, **money held for
somebody else**, what time is costing, what the DMS still believes, and what the
product did on its own. The third is R-103 on a screen rather than in a ledger —
road tax collected from a customer is the RTO's money in a dealer's account, and
a dashboard that adds it to the cash position is teaching somebody to spend it.

**Every figure carries an `href`.** R-20 says this is a control panel and not a
report, and a number you cannot walk into is a report: it says eleven things are
wrong and leaves somebody to find which eleven. The server decides where each
one goes; the screen renders `href` and knows what none of them mean.

**A module outside the role is named, never zeroed** — left out of the
arithmetic and listed in `scope.withheld` with the reason. The same defect the
route guard exists for, and worse here, because the zeroes would be summed into
a headline.

**The headline is a rule.** Findings ordered by a fixed table, top three, each
worded by a function. No model is called from that file and there is no branch
where one could be.

**`limits` is derived from what was just read** and prints. The mirror's
staleness, the modules left out, the outlets not covered, and — the one that
matters most on a page handed to somebody who has not bought anything — whether
any message has actually reached a customer.

**The screen and the report are the same page.** R-108 asks that a prospect be
shown a report about their own dealership, and that it be the *same artifact*
the owner opens every morning afterwards; a diagnostic built only to sell is a
brochure and stops being true the week after. So `/overview` is one route with a
`@media print` block, exactly as `/invoices/:id` is — no second layout to drift.
Print drops the chrome and the walk-in arrows, keeps the figures and the limits,
and adds one line saying what the page is: read from this dealership's own DMS,
which DDMS never writes to.

> **A verifier that agrees with the bug is a bug with a tick beside it.** The
> first `verify-overview` counted rows through the same builders `overview.ts`
> calls and called that independent. Removing the outlet filter from
> `receivables-worklist.ts` — the one line stopping a cross-branch builder
> returning the whole group for every outlet, which would double every money
> figure on the owner's screen — **left all twenty-two checks passing**, because
> the defect landed on both sides of every comparison. Section 3 now reads
> `dms_vehicle_stock` in SQL with no classifier involved, and asserts the
> invariant the fold rests on: *a builder asked for one outlet returns that
> outlet's rows and no others.* The same mutation now fails one check by name.
> Only one figure gets the SQL treatment on purpose — reimplementing a
> classifier in its own verifier produces a second opinion that drifts and then
> fails for reasons unrelated to the code under test.

`pnpm run verify:overview`. Nine sections, on the worker credential, and it
asserts among other things that building the view writes no decision and no
event: it is a read.


## One queue, worked one at a time

Every screen below answers *what is wrong with these records*. `GET /api/dms/queue`
answers the question a short-staffed dealership actually has each morning —
**what should I do next** — and it is the only screen that spans all seven
modules at once. It is the root of DDMS since OBJ-15; Enquiries moved to
`/enquiries`.

Three bands, in order: **mine**, **nobody's**, **my outlet's**. The middle one
is the point. An enquiry assigned to a salesman who left in February is on
nobody's list and is not late by any measure the DMS holds — it simply stops
happening, and that is what a dealership loses. A departed assignee puts an item
in that band rather than in "somebody else's", because the work is not less
orphaned for the DMS still carrying the name.

`lib/dms/queue.ts` reads the classifiers' answers through the same
`build…Worklist` functions the screens and the event detector use — every record
whose own screen would show an `actionRequired`, and whose state appears in
`SEVERITY`. That table is the single place the queue's contents are decided, and
it is capped and in code: severity has to be comparable *across* modules to sort
one list, and a per-module score would leave "is a stuck RC worse than a broken
payment promise" a question nobody answers in one place. **No model anywhere** —
what somebody should do next is exactly the decision R-49 says a model may not
make.

Which controls a row offers is decided in `queue.ts` too, not by the screen, so
the queue renders any module's actions without knowing what any of them mean.
The reassignment picker is separate from the buttons because it is a list of
staff who still work here with what each already carries (R-54).

> **The order is frozen while it is being worked.** Acting on an item removes it
> from the server's answer, so refetching would shift everything below up and
> move the next item out from under the person about to read it.
> `invalidateWorklists` in `ddms/src/lib/actions.tsx` excludes `/api/dms/queue`
> by name for that reason; it builds fresh on arrival and rebuilds when somebody
> asks, and the header says when it was built.

## Who the person is, not just which dealership

Since OBJ-14 a dealership's staff have their own logins, and scope is **three
predicates ANDed onto each other, never ORed**:

| | |
|---|---|
| Owner | `app.current_owner_id()` — unchanged, and everything else rests on it |
| Outlet | `app.visible_showroom_ids()` — the employee's one branch, or the owner's whole set |
| Module | `app.can_read('RECEIVABLE')` — from their role |

Each one can only take away. Salesforce's sharing model runs the same way in
the opposite direction — a private baseline that later layers can only widen —
and the property bought is the same either way: **the direction of a mistake is
safe.** A bug in the role layer can hide a row from somebody entitled to it and
cannot reveal one to somebody who is not.

`lib/dms/permissions.ts` holds the role-to-module table in TypeScript and
`app.can_read()` holds it in SQL. Two copies on purpose, doing different jobs:
the first lets a route *explain* a refusal, the second makes it *true*. A
service advisor's connection reads zero rows from the ledger whatever the
application code does — `pnpm run db:probe` prints exactly that, per login, and
is a check rather than a claim.

**SELECT stays owner-scoped; only writes narrow to the visible outlet.** Not an
oversight: the cross-branch findings are the product, and an advisor has to be
able to learn that the part their customer is waiting for is free at the other
branch (R-64). What they cannot do is open that branch's screen or write to its
rows.

**The mirror may revoke access and may never grant it.** The DMS already records
`dateOfLeaving`, and it now closes the matching login — at sign-in, on every
request, *and* inside `app.session_user_id()` so the refusal holds at the
database rather than only in code. Strictly one-way: a name appearing in a staff
master never becomes an account, and an employee row that is simply *absent* is
not treated as a departure. The honest limit is that revocation is only as fresh
as the last sync; an owner who needs somebody out now deactivates the user,
which is immediate.

> **A refusal has to look different from an absence.** The first version landed
> an RTO agent on the Enquiries screen — a module they cannot read — where four
> zeroes and *"No enquiries mirrored yet"* read as *your dealership has none*.
> The console now sends people to a screen they can work on, and states the
> refusal where it cannot. Hiding a menu item is a courtesy; the database is the
> control.

**Identity: prefer an explicit reference over a probable one.** A registration
file *names* its deal, so the customer resolves through that named deal before
falling back to a matching phone number. Getting this the wrong way round
produced the same person twice. The fallback stays probable and says so —
`confidence` travels with the entity and an `identityNote` travels with the
dossier, because families share a handset and numbers get reassigned. Chained
inference is deliberately *not* done: chassis → deal → customer would attribute
a service visit to whoever originally bought the vehicle, and second-hand
vehicles are most of a workshop's book.

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

**One command starts everything: `pnpm run stack`.** It reaches the database,
builds the API server, starts it, waits for `/api/healthz`, starts the mock OEM
DMS, and only then starts Vite — so the first screen never loads against a proxy
target that is not listening yet. Ctrl-C stops all three.

> **It reaches the database before it starts anything** (the probe in
> `requireDatabase`). A paused Supabase project does not present as a database
> problem: `/api/healthz` never touches Postgres, so the server reports healthy,
> every screen loads, and the only symptom is a 500 on sign-in that reads like a
> wrong password. **A control that passes while the thing it guards is down is
> worse than no control** — the same reason a reconciliation here says *not run*
> rather than reporting clean. The probe uses `DATABASE_URL_LOGIN`, the role the
> login route itself uses, and when the pooler answers *tenant or user not found*
> it says that this almost always means the project is paused.

> **It starts `artifacts/dms-mock` on 9090.** The product reads a manufacturer's
> system it does not control and may never write to (R-5/R-40); the mock stands
> in for it locally. Without it every ingest path retries three times and fails
> as `unavailable`, which reads like a bug rather than a missing dependency —
> `verify:ingest` is the one verifier that cannot pass without it. The mock dying
> does not stop the other two: only the ingest screens depend on it, and they
> degrade rather than break.

It exists because starting the stack by hand goes wrong in three ways that all
look like different bugs:

> **`pnpm run dev` on the API server fails on Windows.** The script opens with
> `export NODE_ENV=development`, and pnpm hands package scripts to `cmd.exe`,
> which has no `export`. Nothing in the error says so.

> **The `start` script does not load `.env.api`.** It needs
> `--env-file=.env.api`, which appears only in the verifiers''' comments. Without
> it the server dies on `API_SERVICE_KEY` and looks like a missing secret rather
> than a missing flag.

> **`PORT` and `API_PORT` are different variables.** `.env.api` carries
> `API_PORT`; `index.ts` reads `PORT`. Supplying only the env file gets you a
> server that will not start on a port it has been told twice about.

`dev.mjs` is a Node script rather than a shell one-liner for the first reason,
and it spawns Vite directly rather than through pnpm because Git Bash rewrites
`/ddms/` into a Windows path on the way to `BASE_PATH`.

> **It refuses to start if `DATABASE_URL` is in `.env.api`**, before it checks
> ports or builds anything — the rule below, checked rather than remembered. A
> server that quietly picked up the owner credential would serve every tenant'''s
> rows to every tenant, and nothing on any screen would look wrong.

Everything below is what `pnpm run stack` does for you, and what to set up once
before it will work.


Node 24 and pnpm are required. **Nothing calls dotenv** — a `.env` file is not
read automatically. Use `node --env-file=.env` or set vars inline.

Every artifact throws at startup if `PORT` is missing, and the web artifacts also
throw if `BASE_PATH` is missing. Values differ per artifact, so they cannot all
live in one `.env`. Ports come from each `.replit-artifact/artifact.toml`:

`API_SERVICE_KEY` must be in the workspace-root `.env` before anything starts:
the API refuses to boot without it, and each Vite dev server throws when it
creates its `/api` proxy. Generate one with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

`DATABASE_URL_APP`, `DATABASE_URL_LOGIN` and `DATABASE_URL_WORKER` must be there
too, for the same reason and with the same failure mode — the API refuses to
boot without them rather than falling back to the connection that bypasses
row-level security. Copy `DATABASE_URL` three times, change the user to
`ddms_app.<project-ref>` / `ddms_login.…` / `ddms_worker.…`, pick a password for
each, then `pnpm run db:rls`, which creates all three with whatever passwords
those URLs say and then proves what each can and cannot reach.

**`DATABASE_URL` itself must be in `.env` and must NOT be in `.env.api`.** The
CLI tools need the table owner; the server refuses to start with it. See
`.env.api.example`.

`CREDENTIAL_KEY` must be in **both**, and it is what encrypts a dealership's
messaging token at rest (OBJ-27). Without it the product cannot hold one at
all, which is the designed refusal rather than a fallback to storing it in the
clear. Generate one the same way as the service key. Changing it does not
corrupt anything — the stored ciphers simply stop opening, and the log says so
in those words rather than reporting an authentication failure that would send
somebody to re-paste a perfectly good token.

`WHATSAPP_VERIFY_TOKEN` is only used for Meta's one-time subscription
handshake, which happens before any credential exists to check against.

```powershell
# API — build once, then run node directly so --env-file loads the env file.
# (Don't use the package's `dev` script on Windows: it starts with POSIX
#  `export NODE_ENV=... &&`, and it wouldn't load .env anyway.)
#
# .env.api, NOT .env — the server refuses to start while DATABASE_URL is set,
# because that credential bypasses every row policy. Regenerate it from .env
# whenever .env changes:
#   Get-Content .env | Where-Object { $_ -notmatch '^DATABASE_URL=' } | Set-Content .env.api
pnpm --filter @workspace/api-server run build
$env:PORT=8080; node --env-file=.env.api --enable-source-maps artifacts/api-server/dist/index.mjs

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
pnpm run db:seed-applications  # a book of applications across both outlets
pnpm run db:rls         # create the three restricted roles and apply RLS
pnpm run db:probe       # print what each login can actually read, as ddms_app
pnpm run db:seed-network       # the two extra branches, hub-and-spoke
pnpm run db:seed-branch-data   # three months of trading across all five
pnpm run db:export-books       # the 13 reports a CA opens, per company
pnpm run verify:history        # the record history and the job-card handover
pnpm run verify:journal        # the chart's cost side and the journal door
pnpm run verify:floorplan      # the financier as creditor, and what the floor costs
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

DDMS (`artifacts/ddms/src/pages/`): `Queue` (`/`), `Overview` (`/overview`),
`Leads` (`/enquiries`), `Worklist` (`/worklist`), `Numbers` (`/numbers`),
`Channels` (`/channels`), `Runs` (`/runs`), `Books` (`/books`),
`Journal` (`/journal`, the only screen that writes to the ledger),
`Registrations` (`/registrations`), `ServiceWorklist` (`/service`),
`Spares` (`/spares`), `Receivables` (`/receivables`), `Inventory`
(`/inventory`), `Outbox` (`/outbox`), `Dossier` (`/who/:entityId`,
reached from the header search rather than the sidebar). The explain panel is
not a page — it is a control on every worklist row, in `src/lib/explain.tsx`.

DDMS has its own `Shell` — an owner looking across showrooms, rather than an
agent working one application — with outbound links to the other two products
rather than embedded copies of them.

InsurRouter (`artifacts/insur-router/src/pages/`), routed by Wouter under
`BASE_URL`: `Dashboard` (`/`), `ApplicationsList`, `ApplicationNew`,
`ApplicationDetail` (renders the log timeline incl. inline browser screenshots),
`ProvidersList`, `ProviderEdit`. Wrapped in `components/layout/Shell.tsx`.

All three products now open on `SignIn` until `/auth/me` answers, and the same
cookie works across them — one login, three screens. The Shell shows whoever is
signed in; it said "John Doe / Agent" until OBJ-8, which was harmless while
there was no sign-in and is not once there is, because the name in the corner is
how somebody notices they are looking at the wrong dealership's work.

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

## What is parked, and why it is parked rather than forgotten

OBJ-52 to OBJ-54, registered 29 August against a later version. `docs/ddms-requirements.md`
§3o carries the reasoning; the short form:

| # | Objective | Status |
|---|---|---|
| OBJ-52 | The 13 registry actions, offered over MCP | **parked** — first worth doing |
| OBJ-53 | A journey a dealership can add without a deploy | **parked** — wait for a real request |
| OBJ-54 | The agent loop, separable from the agent | **parked** — only after OBJ-52, if then |

They came from reading `anthropics/commerce-agents`, Anthropic'''s reference
blueprint for merchant agents. The finding was not a list of things to build:
**the architecture here already matches the pattern** — server-side actions
rather than database access, writes staged behind approval, provenance on every
finding, one door for model calls, no live effects. Arrived at separately.

> **No requirements are raised for a parked objective.** The register'''s whole
> value is that every row in it is true today; unmet rows would end that.

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

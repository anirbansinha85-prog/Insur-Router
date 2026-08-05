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
| Role | what does that person do here? | `lib/dms/access.ts`, `users.role` |
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

Twenty-five tables, all in `lib/db/src/schema/`. Every one of them has RLS enabled;
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

`lib/dms/access.ts` holds the role-to-module table in TypeScript and
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

DDMS (`artifacts/ddms/src/pages/`): `Queue` (`/`), `Leads` (`/enquiries`), `Worklist` (`/worklist`),
`Numbers` (`/numbers`),
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

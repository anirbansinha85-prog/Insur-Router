# DDMS — requirements, objectives and definition of done

Written 3 August 2026, after Anirban's observation that we were "in a loop with
no definite outputs". That was accurate. Work had been shipping every session —
mirror, workshop, CRM, service split — but nothing was ever *finished* against
a written definition, so each session ended by proposing the next thing instead
of closing the current one.

This file is the fix. It is the single place requirements live. **Nothing gets
built that is not R-numbered here, and nothing is called done except against the
test written next to it.**

---

## 1. What DDMS is

> An owner's control panel across every showroom they own, sitting on top of the
> OEM's dealer management system, which it can only read. It shows what that
> system cannot — what is stuck, what is aging, what nobody has been told — and
> it acts on it.

Bought by the **owner**, not the OEM and not the manufacturer's dealer network.
It is the owner's own purchase and works irrespective of which OEM the showrooms
carry.

**Sold on staff shortage.** Small dealership owners are short-staffed and losing
people; they are losing business because there is nobody to do the work, not
because the work costs too much. DDMS is about **capacity**, never about
reducing headcount. Any wording that implies cutting staff is wrong.

---

## 2. Requirements register

Status: **✅ done** · **◑ partial** · **○ not started**

### The shape of the thing

| # | Requirement | Status |
|---|---|---|
| R-1 | Owner-level: one owner, many showrooms, one view across all of them | ✅ and *load-bearing* in three places — spares, receivables and the vehicle floor each read across outlets |
| R-2 | A showroom is its own entity and *has* dealer codes — not 1:1. One address may carry two brands; one brand may sell from three outlets; a service centre has no dealer code at all | ✅ |
| R-3 | First customer shape: one OEM, several showrooms, one owner | ✅ |
| R-4 | DDMS sits on top of the OEM's DMS and does not replace it | ✅ |
| R-5 | The DMS integration is **read-only, permanently**. Design around that rather than around a write-back that may never be granted | ✅ |
| R-6 | Works irrespective of OEM — the adapter absorbs per-OEM differences | ◑ one adapter (Hero) |
| R-7 | Each product is complete on its own; DDMS, InsurRouter and VeloDocs usable individually and as a whole | ◑ frontends split and each now has its own sign-in; API still one process |
| R-8 | InsurRouter and VeloDocs are API capabilities reachable from DDMS | ○ linked, not called |

### What it shows

| # | Requirement | Status |
|---|---|---|
| R-10 | Mirror the DMS locally rather than querying live — the owner's questions are cross-deal and aging is not computable from a live query | ✅ |
| R-11 | Show live status **and** a side-by-side column of what the DMS still believes. DDMS is the current one; the difference is the signal | ✅ deals |
| R-12 | Reconciliation derived on read, never stored | ✅ |
| R-13 | Sales: deals and insurance status | ✅ |
| R-14 | Service centre: job cards, what is stuck, what the customer has not been told | ✅ |
| R-15 | CRM: enquiries, the manufacturer's response clock, leads with no owner | ✅ |
| R-16 | Spares, finance/receivables, inventory ageing, registration workflow | ✅ all four |
| R-17 | Invoice generation, automated | ✅ as a **statement of account** through the approval gate. Generating the dealer's tax invoice would mean two invoices for one debt, and the DMS is read-only |
| R-18 | DDMS holds every DMS field **plus** its own decision fields for each function | ✅ 7 modules, every decision field proven load-bearing by query |
| R-19 | Staff shortage made visible from the dealer's own data — attrition, orphaned work | ✅ every module, and orphaned work is its own band on the queue rather than a row somebody has to think to look for |

### What it does

| # | Requirement | Status |
|---|---|---|
| R-20 | **Dual role**: a control panel *with action buttons*, not a report | ✅ every screen acts |
| R-21 | Action buttons call the real `/api` pipeline — *locked decision, after the owner tier* | ✅ |
| R-22 | Multi-agent automation orchestration — agents propose, rules dispose, actions execute | ✅ the composer proposes, the gate disposes, the actions execute, the panel explains — and a model is in exactly two of those, on a leash, in neither of the deciding ones |
| R-23 | Deterministic if/else rules where the logic is knowable, not a model guessing | ✅ derivations, actions, authorisation and the findings are all rules. A model words two of them and decides none |
| R-24 | What the software cannot do becomes an explicit tracked task with the exact value to copy | ✅ |
| R-46 | **Our record of a contact is ours, and does not stop the manufacturer's clock.** The DMS is read-only, so a call logged in DDMS cannot write `firstContactAt` in their CRM. The row shows both and states the limit, with the exact value to key in | ✅ |
| R-47 | **Identity resolved on a mobile number is probable, not certain** — families share a handset, numbers are reassigned, switchboard numbers get typed into walk-in records. Confidence travels with the entity and nothing irreversible is driven by it alone. **And an explicit reference beats a probable one**: a registration file names its deal, so that wins over a matching number | ✅ |
| R-48 | Nothing leaves the building without either a rule permitting it or a person approving it | ✅ one function decides, and it is the only thing that may write `sentAt` |
| R-49 | **The agent proposes, explains and drafts. Rules authorise.** A model may never decide whether an action is permitted or whether a record is in breach — that logic is knowable, and a rule that is right every time beats a model that is right most of the time | ✅ the composer drafts, the panel explains, and rules verify both. Neither the gate nor `classify()` ever calls a model |
| R-50 | Internal notifications before customer-facing ones. Emailing staff their own workload is low risk; messaging a dealership's customers is not | ✅ the only rule that sends without a person covers internal email, and no branch can produce one for a customer |

### How it runs itself

*Added 4 August after researching how Salesforce and HubSpot are built as
platforms rather than as products. The findings, and what was deliberately
refused, are in section 3b.*

| # | Requirement | Status |
|---|---|---|
| R-51 | **A change of derived state is an event, and events are recorded.** Not a field diff — `classify()`'s answer moving from one state to another. A file that crossed into `RC_IN_DRAWER` at 3am must be knowable without anybody having opened a screen | ✅ |
| R-52 | **Automation is one ordered list, it lives in code, and it is capped.** No rule builder, no per-dealership flows, and a stated ceiling on how many rules may exist. The failure mode being designed against is documented: orgs reach eighty automations on one object, page saves take eight seconds, and nobody can predict what a save will do | ✅ |
| R-53 | **A dealership has people, and scope only ever narrows.** Roles inside an owner — advisor, RTO agent, accounts, manager — expressed as an *additional* predicate on top of the owner's, never an alternative one. A bug in the role layer must be able to hide rows and must not be able to reveal them | ✅ |
| R-54 | **Work is routed by role and capacity, and never becomes unroutable.** Who can do it, who has room, and who is actually in today. When nothing matches, it degrades to a named queue rather than disappearing | ✅ the picker offers only staff still here, each with what they carry; unroutable work lands in the second band rather than vanishing |
| R-55 | **One queue, worked one at a time.** Seven screens each holding a list is a reporting product. The capacity thesis needs a single ordered queue that can be worked start to finish without returning to a list | ✅ |
| R-56 | **Automation may write a decision field. Only the gate lets anything leave.** An automated mark is internal, reversible and logged. Anything outbound still passes `authoriseSend()`, unchanged — the line drawn in R-48 does not move because the caller stopped being a person | ✅ *(the gate half; no rule writes a decision field yet, and OBJ-16 says why)* |
| R-57 | **A chase stops when its goal state is reached.** The exit condition is a `classify()` state, not a reply or a click. A cadence that cannot stop itself is the mechanism by which automation becomes something a dealership apologises for | ✅ *(and it withdraws the draft it already raised)* |
| R-58 | **Thresholds are dealer policy, not product logic.** Credit periods, ageing buckets, chase cadence, what counts as the RTO having gone quiet — per owner, stored, and changes to them audited. The rules stay in code; the numbers belong to the dealership | ✅ *nine of them, moved out of five classifiers* |
| R-59 | **The agent invokes the same action registry a person does.** One endpoint, one set of refusals, one decision log. A parallel agent-only path would have to re-earn every refusal and would eventually fail to | ✅ |
| R-60 | **Every automated act is attributable and reversible.** `decision_log.userId` null reads as *the system did this*, never as *we lost track*. Anything a rule set, a person can unset | ✅ |
| R-61 | **A dealership's staff get their own logins, and a login is the dealership's own employee record.** *Locked 4 August.* A user carries an `empCode`, and that code is what already sits on the enquiries, registration files and job cards they are responsible for. Without that join, *my work* has no referent and the queue is only a differently sorted list | ✅ |
| R-62 | **The mirror may revoke access. It may never grant it.** An owner creates a login and links it to an employee; the DMS saying that person has left closes it. Never the reverse — a name appearing in the staff master must not become a login. And the honest limit travels with it: revocation is only as fresh as the last sync | ✅ at sign-in, on every request, and in `app.session_user_id()` so it holds at the database |
| R-63 | **See the outlet, act on what is yours or unowned.** A nine-person dealership covers for each other, so hiding a colleague's leads would be wrong and would hide the orphaned-work finding R-19 exists for. Visibility is the outlet; the write is yours, or nobody's | ✅ SELECT owner-scoped, writes narrowed |
| R-64 | **A cross-outlet *finding* survives the narrowing; the other outlet's *rows* do not.** An advisor scoped to one branch still learns that the part their customer is waiting for is free at the other one, and still cannot open that branch's ledger. The finding is the product; the rows are somebody else's business | ✅ |

### What it remembers
*Researched 4 August, after the queue. The severity table shipped as the
product's opinion; it is the dealership's, and the agent has never once looked
at what this dealership actually did last time.*

| # | Requirement | Status |
|---|---|---|
| R-65 | **Priority is dealer policy, not product logic.** The severity table decides what a short-staffed dealership does first, and it is currently one owner's judgement written by us into a file. It becomes per-owner data with the product's table as the default, editable by the owner or a showroom manager, with what changed and who changed it in the decision log. Same class as R-58: a bounded table of numbers, **not** a rule builder | ✅ |
| R-66 | **Memory is what people here actually did, and nothing else.** Only rows the decision log attributes to a *person* count as precedent. A mark the system made is excluded on purpose: an agent that re-reads its own output as evidence turns one early mistake into a settled belief, and the loop is invisible from inside. `decision_log.userId` already distinguishes the two, which is the whole reason R-60 insisted null means *the system did this* | ✅ `precedentFor` joins `decision_log` to `record_events` and counts only rows carrying a user id — `verify:autonomy` §3 drives an agent decision through and asserts it is not counted |
| R-67 | **Nothing is stored as memory that was not already stored as a fact.** Precedent is derived on read from `decision_log` and `record_events` — both append-only, both writable only through `applyAction`. No summarised memory, no free text, no ingestion surface. What cannot be written cannot be poisoned, and the commonest poisoning payload in the literature is a plausible-looking *preference* | ✅ nothing is stored. Precedent is a join over two append-only tables at read time; there is no memory table to write to and therefore none to poison |
| R-68 | **Precedent carries its date and its count, or it is not shown.** "You did this 5 times of the last 6, most recently on 28 July" is a fact somebody can weigh. "You usually do this" is a claim with no way to tell a settled habit from something that stopped in March. Stale-but-true is the failure mode, and a date is the whole of the fix | ✅ `precedentSentence()` cannot be built without a count and a date, and returns null rather than a hedge |
| R-69 | **Precedent informs a person or a default. It never authorises and never acts.** R-49 does not bend for memory: an agent that has seen a pattern still may not decide whether an action is permitted or a record in breach. What it may do is say what happened last time, next to the button — and propose a change to the *stored* priority for the owner to accept or refuse | ✅ the ladder's ceiling is `may("AGENT", …)`, so no amount of precedent grants a permission. At rung 2 the value arrives selected and a person still presses Assign |
| R-70 | **Similarity is a small set of named features, not an embedding.** Module, state, and two or three things that actually differ between cases. A dealership has hundreds of open records and twelve action types; a vector index would be slower to explain than to build, and "why did it show me that one" has to have an answer in one sentence | ✅ the feature set is `(module, state, action)` and one choice field. No embedding, no index |
| R-71 | **A pattern that stops is a pattern that stops being shown.** Precedent reads a moving window, so a habit the dealership drops disappears from the product by itself rather than by somebody remembering to retire it | ✅ a 60-day moving window, so a habit that stops disappears without anybody retiring it |

### How it looks

| # | Requirement | Status |
|---|---|---|
| R-30 | **A dense dealer portal, in the shape of the Hero portal at `:9090/portal`** — module-grouped sidebar, KPI cards, action buttons on rows, quota bars, an identity header with showroom picker and financial year | ✅ OBJ-1, and every screen since has been built to it |
| R-31 | Distinct from the OEM's own system: the owner's group identity, multi-showroom, not one dealer code | ✅ |
| R-32 | Never show invented identity — no fake user until there is a login | ✅ |
| R-33 | **The seeded dealership data must read as real.** No "sandbox", "demo data" or similar labelling on the chrome. The records are invented, but they stand in for a real dealer's, and a demo badge makes the whole product read as a toy | ✅ |

### Non-negotiables

| # | Requirement | Status |
|---|---|---|
| R-40 | Never write to the OEM's DMS | ✅ |
| R-41 | Never present simulated output as real. **Narrower than R-33 and it survives it**: dealership records may read as real because they stand in for real ones, but a policy number no insurer issued stays marked on the policy itself, because somebody could otherwise believe they are covered | ✅ |
| R-42 | Per-user authentication before any real customer | ✅ all three products, since OBJ-8 |
| R-45 | Isolation enforced by the database, not only by application code. Every request path connects as a role that cannot bypass RLS and cannot read a session token — and since OBJ-8 the server holds no credential that could, so the restricted role is not a choice it makes but the only one it has | ✅ |
| R-43 | Deccan stays parked; Saraswati is the working showroom | ✅ |
| R-44 | Remote-desktop access (AnyDesk-style) is **not** the integration route | ✅ ruled out |

---

## 3. Objectives, rephrased

The old objectives were activities ("build the CRM module"). These are outputs
with a test. An objective is done when the test passes and not before.

### OBJ-1 — DDMS reads as a dealer portal  ✅ **done 3 Aug**
*Covers R-30, R-31.*

Grouped sidebar (SHOWROOM / INSURANCE / AFTER SALES / SERVICES), identity header
carrying owner, showroom, dealer code, financial year and an honest "no auth
yet", showroom picker moved out of the pages and into the header as the scope it
actually is.

**Done when:** DDMS next to `:9090/portal` reads as the same class of product,
and switching showroom in the header carries across all three screens.

> The first draft of this objective also demanded action buttons. That was two
> objectives in one — looking like a portal and behaving like one are different
> pieces of work, and bundling them is how an objective ends up never finishing.
> Buttons are OBJ-2.

### OBJ-2 — The first real action button  ✅ **done 3 Aug**
*Covers R-20, R-21. The locked decision.*

"Start the insurance application" stopped being text. `POST
/dms/deals/{dealId}/start-application` pulls the deal, translates it, resolves
the owner and creates the draft server-side, then the console opens it in
InsurRouter.

**Done when:** clicking it on deal `…000181` produces an application in Supabase
and the row's reconcile state changes on the next render, with no manual step in
between.

**Verified** through the UI, not just the API: one button on screen, clicked,
application #12 created, InsurRouter opened at `/applications/12`, row moved
`NOT_STARTED → IN_SYNC` and the Not-started filter went to zero.

Only `NOT_STARTED` gets a button. The other states still need a person — keying
a policy number into the dealer's system, resolving two policies on one vehicle
— and dressing those as buttons would be the same lie as a simulated policy that
looks issued.

### OBJ-3 — Per-user authentication  ✅ **done 3 Aug**
*Covers R-42.*

Owner signs in; scope comes from the session. `users` and `sessions` tables,
scrypt passwords, an httpOnly server-side session that can be revoked, and
`assertShowroomAccess` on every route that touches tenant data — gated on the
whole DMS router rather than per route, so a route added later is protected by
default instead of by whoever remembers.

**Done when:** two owners exist and neither can read the other's rows, proven by
a failing query rather than by inspection.

**Verified**, with Malhotra Motors seeded as a second owner:

| | |
|---|---|
| Service key, no session | `401 Not signed in` |
| Wrong password | `401 Those details are not right` |
| Saraswati owner sees | `DEL-SARASWATI, PUN-DECCAN` |
| Malhotra owner sees | `MUM-MALHOTRA` |
| Malhotra reads Saraswati's worklist | `404 No showroom 1` |
| Malhotra starts an application on a Saraswati deal | `404 No showroom 1` |
| Saraswati reads their own | `200`, 4 deals |

404 not 403 on the cross-tenant reads: 403 confirms the showroom exists, which
is what an attacker enumerating ids wanted to learn.

> **Not done here, and it was in the original wording:** RLS policies, so the
> connection string stops being a master key. Split out as OBJ-7 rather than
> quietly dropped.

### OBJ-7 — Isolation enforced by the database, not just the app  ✅ **done 3 Aug**
*Covers R-45. Split out of OBJ-3, where it was in the wording and did not get
done.*

A second Postgres role, `ddms_app`, which owns nothing and cannot bypass RLS.
The DDMS request path connects as it; `sessionScope` sets the session token
hash on the connection and the policies in `lib/db/sql/rls.sql` resolve the
owner from there.

The token hash is what makes this more than bookkeeping. `ddms_app` has **no
grants at all** on `users` or `sessions`, so it cannot read a token hash and
therefore cannot invent one. `app.current_owner_id()` is `security definer` and
reads those tables on its behalf, returning only an owner id.

**Done when:** a connection that is not the owner role reads zero rows from
`applications` without a policy granting it, proven by a query returning nothing
rather than by reading the policy file.

**Verified.** `pnpm run db:rls` finishes by proving it and exits non-zero if it
cannot, so this is a check that runs rather than a claim in a document:

| As `ddms_app`, no session | |
|---|---|
| `applications`, `dms_deals`, `dms_job_cards`, `dms_enquiries`, `showrooms`, `owners` | 0 rows each |
| `users`, `sessions` | permission denied — not "empty", denied |
| invented token hash | 0 rows |
| `create policy` on `showrooms` | must be owner of table |
| `alter table … disable row level security` | must be owner of table |

With a real session, and the application-level check deliberately out of the
way — signed in as Malhotra, reaching for Saraswati's showroom 1:

| | |
|---|---|
| `insert into applications … showroom_id = 1` | new row violates row-level security policy |
| `select from applications where showroom_id = 1` | 0 rows |
| `update dms_deals where showroom_id = 1` | 0 rows changed |
| `select own showroom 7` | 1 row (control) |

And through HTTP, on a shared connection pool: 40 interleaved requests across
the two owners, each returning only its own outlets. A pooled connection that
kept a previous request's token would have shown up here as one wrong answer in
forty.

> **What this does not do.** The process still holds the owner credential, for
> InsurRouter's routes, VeloDocs's ingest and the sync scheduler. Somebody who
> can read the whole environment still reads everything. What is closed is the
> DDMS request path: it now cannot reach another tenant even when the code
> asks it to. Retiring the owner connection from the running server needs
> InsurRouter to have a sign-in of its own — OBJ-8.

### OBJ-8 — One credential, and it is not the owner's  ✅ **done 4 Aug**
*Follows OBJ-7. Covers R-7 and the rest of R-42, and finishes R-45.*

> **Moved up on 4 August.** It sat beside OBJ-14 rather than at the end:
> roles inside a dealership and credentials held by the process are the same
> question — *who may see what* — asked twice, and answering them apart would
> have meant touching the same code twice.

InsurRouter and VeloDocs ran on the connection that bypasses RLS, because they
had no sign-in and no tenant to scope by. While they did, the server held a
credential that sees every dealership and every password hash.

**Done when:** the running API server's environment contains no connection
string with `bypassrls`, and InsurRouter's application list shows only the
signed-in owner's applications — proven by signing in as the second owner and
getting an empty list rather than by reading the code.

**Verified, both halves.**

The server refuses to start with the owner's credential in its environment
rather than merely declining to use it — because choosing the restricted role
is not isolation while the other one is one import away, and that mistake would
be a query that silently works:

```
$ node --env-file=.env artifacts/api-server/dist/index.mjs
Error: DATABASE_URL is set. That is the table owner's connection and it
bypasses row-level security … Start it with `--env-file=.env.api`.
```

And the list, through HTTP with a real cookie:

| | |
|---|---|
| Anirban → applications | 200, **18** |
| Malhotra owner → applications | 200, **0** |
| Malhotra owner → dashboard | every figure zero, no provider rows |
| Service advisor → applications | **403** — *"A service advisor does not see sales deals. Yours covers job cards and the parts counter."* |
| RTO agent → applications | 403 |
| Accounts, sales exec → applications | 200 |
| Any of them with the service key but no session | **401** on applications, dashboard, providers and ingest |

`pnpm run db:probe` now counts `applications` per login, which is the check
rather than the claim — the second owner reads zero rows at the database, not
just at the route.

**Three credentials, because there were three jobs.** One role could not do it:
two of the jobs happen with nobody signed in and so cannot be scoped by a
session, which is exactly why they had been left on the table owner.

| | reaches | |
|---|---|---|
| `ddms_app` | every request, scoped by its session | nothing at all without one |
| `ddms_login` | `users`, `sessions`, the staff master | may write one column, `last_login_at` |
| `ddms_worker` | the mirror and the graph, every tenant | no users, no sessions, no writes to anything a person decided |

> **The scheduler found the widening I had not planned for.** Detection failed
> on every pass with a permission error: a deal's derived state is a *statement
> about the insurance record* — AHEAD, BEHIND and IN_SYNC compare the DMS's
> policy number with ours — so the detector cannot rebuild the projection
> without reading `applications`. It now may, select-only, and the grant says
> why. A narrower claim in a comment would have been the easier fix and the
> wrong one.

**And a fourth role that is not a credential: `PLATFORM_ADMIN`.** Insurers and
OCR engines are the same rows for every dealership, so no owner's session may
write them — an owner editing an insurer's endpoint would be editing it for
every other owner. Until now the only thing that could was the connection that
bypassed everything. It reads no dealership module at all.

**The five applications that belonged to nobody.** `showroom_id` is nullable
and a null belongs to no owner, so the moment InsurRouter moved behind the
policies, five rows left over from the Replit export became invisible to
everybody — including the login that created them. Data that silently
disappears is the failure this product refuses everywhere else, so they were
repaired rather than deleted, and `db:seed-applications` reports the count of
unattributed rows every time it runs. It is zero.

### OBJ-4 — The remaining modules  ✅ **done 4 Aug**
*Covers R-16, R-17, R-18.*

Spares, receivables, inventory ageing, registration workflow, invoicing. Each
follows the established pattern: mirror table, projection, derived state, one
decision field that changes the outcome.

**Done when:** each module has a screen whose leading number is a count of work
nobody could previously see.

#### Registration & RC ✅ **done 4 Aug**

Taken first because it is the one adjacent to insurance — a new vehicle cannot
be registered without live cover — so it tested whether the mirror pattern
extends *and* whether one module can hand work to another.

Two numbers on that screen exist nowhere in the dealership:

- **Certificates in the drawer.** The DMS treats a vehicle as finished when the
  RTO allots a number, because that is when the sale can be reported. Whether
  the customer ever received the card is two fields further down the same
  record, and no screen puts them beside each other. Saraswati is holding two,
  one for 47 days.
- **Road tax held.** Collected from the customer at invoice, remitted to the
  state afterwards. Both dates exist; nothing subtracts them. ₹9,901 of
  customers' money, and their files cannot be lodged until it goes.

Two decision fields, both proven load-bearing by query rather than assumed:
`customerNotifiedAt` (needsAction 8 → 7) and `rtoChasedAt`, which is a
**recency** test rather than a presence one — a chase 14 days ago leaves the
file `RTO_SILENT`, a chase yesterday moves it to `ON_TRACK`.

It also produced the first cross-module action: a file blocked because there is
no policy links straight to the insurance queue with its deal id.

**Verified**: 10 files mirrored for Saraswati, every state populated, tenant
isolation holding at the database (Malhotra reads 0 of 12), and the screen
driven through the browser rather than the API.

> **The bug worth keeping.** The first derivation had a lapsed temporary
> registration as a *state*, near the top of the ordering. A file the RTO had
> rejected whose temporary registration had also lapsed came out as `TR_EXPIRED`
> advising somebody to take it to the RTO — which is what had already been done
> — with the objection nowhere on screen. A lapse is not a cause; it is a
> consequence that raises the urgency of whatever the cause is, and it can
> coexist with all of them. It now lives on the row and in the note, and the
> rule is written into CLAUDE.md.

#### Spares ✅ **done 4 Aug**

The first module that answers a question a single branch **cannot** answer,
rather than one it merely failed to. Every module before it read something one
outlet could in principle have noticed: a policy nobody keyed in, a customer
nobody rang, a certificate nobody handed over. This one reads across the shelves.

A DMS keeps the parts ledger against a dealer code, because a dealer code is
what it thinks a business is. Own three outlets and you get three ledgers, none
of which can answer the only question the counter actually has.

What it produced on Saraswati's screen, from the dealership's own numbers:

| | |
|---|---|
| A customer waiting **4 days** for a brake shoe | Deccan has 4 free, bin P-02-1 |
| A customer waiting **10 days** for a painted panel | genuine stockout — nobody in the group has one, and it has to read differently |
| 4 spark plugs on the shelf | every one promised to an open job card; the counter screen shows 4 |
| ₹5,696 of brake pads never issued since they arrived | and Deccan has **4 on order** for the same part |

That last row is the sharpest: the group is about to pay for what it already
owns, and no screen in either branch could say so. The action is *"Send
PUN-DECCAN theirs and cancel the order."*

Decision field `transferRequestedAt` proven load-bearing (needsAction 6 → 5).

> **Corrected during the build.** `daysWaiting` first came from `statusSince` —
> our mirror's clock — which reported a customer waiting *one day* for a vehicle
> that had been in the bay since last week. That is a number about us presented
> as a number about them. It now comes from the dealer's own `jcDate`.

**Verified**: 14 part lines across two outlets, every state populated, the
cross-branch lookup working in both directions, and the screen driven through a
browser.

#### Receivables ✅ **done 4 Aug**

The second module — after spares — to answer a question a single branch
**cannot** answer rather than one it merely failed to.

A DMS keys the ledger to a dealer code. Own two outlets and one insurer owes you
money in two places; each branch sees a bill worth chasing, and nobody sees an
insurer holding a six-figure sum of the group's money. Those are different
conversations, and only one of them gets a phone call returned.

| | |
|---|---|
| ICICI Lombard, across both outlets | **₹85,500** — ₹48,200 at Saraswati, ₹37,300 at Deccan, and neither ledger adds them up |
| A fleet account 104 days past a 30-day credit period | never chased since a part payment in March |
| An OEM warranty claim short-settled | not collectable and not a write-off until somebody reworks it |
| A customer who gave a date and missed it | a different state from an unchased bill, and it needs a different call |

**The states name causes, not ageing.** `daysOverdue` lives on the row.
Ranking by age alone would put a disputed bill next to an unchased one and send
somebody to have an argument they cannot win — the same lesson the registration
module paid for.

Decision fields proven load-bearing by query: `chasedAt` moved the fleet account
`UNCHASED → BEING_CHASED` and removed its action, and it is a **recency** test
so a chase three months ago still reads as unchased. `disputedAt` moved the
warranty claim to `DISPUTED` and replaced "chase ₹7,450" with "resolve the
dispute — this cannot be collected until it is".

#### Inventory ageing ✅ **done 4 Aug**

The module that finally joins two mirrors that have sat side by side since the
CRM was built.

> **A bike has been on this floor for 96 days, and two people are asking for
> that exact model.**

The stock screen cannot see the CRM. The CRM cannot see the floor. Both systems
are working correctly and the customer buys elsewhere. `modelCode` against
`modelInterest`, across every outlet the owner holds, is a join rather than a
guess — and it is the leading number, because ringing somebody who already asked
is not a decision the way discounting is.

The second number is arithmetic nobody disputes and nobody has seen attached to
a chassis: **₹121 a day** across the floor, ₹11,065 accrued, ₹4,77,900 of capital
standing. A Destini allocated 142 days ago and never invoiced is the sharpest
row — held out of stock *and* out of sales, and invisible on any ageing report
that filters on `IN_STOCK`.

`offeredToEnqId` proven load-bearing: `WANTED_NOW → OFFERED`, so the screen
stops proposing the same call every morning.

> **The clock has to stop somewhere.** An invoiced unit first showed 34 days on
> the floor and interest still climbing — a cost the dealership stopped paying
> when the bike left. Ageing now measures to the invoice date once there is one.

#### Invoicing ✅ **done 4 Aug** — as a statement of account

R-17 said "invoice generation, automated". Read against R-5 that cannot mean
generating the dealer's tax invoice: that document lives in their DMS, carries a
statutory number series, and the integration is read-only permanently. A second
one would create two invoices for one debt, which is worse than none.

What DDMS generates instead is the document the dealership never gets round to —
a statement addressed to the party, listing the open items **totalled across
every outlet they owe at**. That total is the thing no branch ledger can
produce, and putting it in front of an insurer is the point of having computed
it.

It goes through the OBJ-11 gate as a `CUSTOMER` message, so no rule can send it
and a person approves every one. Verified, including the refusals:

| | |
|---|---|
| Statement to ICICI Lombard | drafted, carrying the ₹85,500 group total broken out per outlet |
| Gate | refuses — *"addressed to a customer… needs somebody to read it"* |
| A settled invoice | 409 — *"asking somebody to pay a bill they have paid is the one letter a dealership cannot take back"* |
| A disputed invoice | 409 — *"resolve that before asking them to pay it"* |
| A walk-in customer with no email | drafts, then the gate refuses on send: no address |

---

## 3a. Replanned 4 August, after the design conversation on actions and agents

Anirban's questions changed the shape of what is left, in three ways.

**OBJ-5 was one phrase doing four jobs.** "Agent orchestration" bundled the
buttons, the drafting, the sending and the explaining — and three of those four
need no model at all. Bundling them is precisely the mistake OBJ-1 was split to
avoid, and it would have produced an objective that never finished.

**A prerequisite appeared that was not on the list.** The agent's usefulness
depends on answering *what else is true about this customer*, and nothing could:
five modules, five islands. That is now OBJ-9, and it sits ahead of the agent
rather than inside it.

**OBJ-4 lost its claim on being next.** Five modules that report and one button
that acts is a worse product than five modules that act. R-20 — the dual role —
is the weakest cell in the whole register, and three more read-only screens make
it weaker rather than better. The remaining modules move after the action layer.

| Order | Objective | Model? | Why here |
|---|---|---|---|
| 1 | **OBJ-9** Entity resolution | no | prerequisite for anything cross-module |
| 2 | **OBJ-10** The screens act | no | R-20, and it is what makes an agent worth having |
| 3 | **OBJ-11** Composer + approval gate ✅ | yes, gated | the first outbound surface |
| 4 | **OBJ-12** The panel that explains ✅ | yes, read-only | needs 9 and 10 to have anything to say |
| 5 | **OBJ-4** receivables, ageing, invoicing ✅ | no | after the product acts |
| 6 | **OBJ-6** a dealership that reads as real | no | *reordered — see 3b* |
| 7 | **OBJ-8** one credential | no | *reordered — see 3b* |

> **Superseded in part on 4 August.** Items 1–5 are done. What was left —
> OBJ-6 and OBJ-8 — is now sequenced inside **section 3b**, alongside five new
> objectives that came out of researching how Salesforce and HubSpot are built.

> An agent with nothing to invoke is a chatbot. That is the whole argument for
> this order.

### OBJ-9 — One customer, one vehicle, one person across five modules  ✅ **done 4 Aug**
*Covers R-47.*

`entities` and `entity_links`: a person resolved on the last ten digits of a
mobile number, a vehicle on its chassis, a member of staff on `dealerCode:empCode`.
Owner-scoped, not showroom-scoped — a customer who buys at Saraswati and
services at Deccan is one person, and saying so is the point.

Built by rules and stored as rows, **not** as a retrieval index. GraphRAG exists
to impose structure on unstructured text because there is no schema to read;
we have the schema, and indexing exact data probabilistically converts a certain
answer into a likely one. Retrieval earns its place later, over the free text
these mirrors already carry and nothing reads — complaint descriptions, RTO
objections, lost-enquiry reasons.

**Done when:** searching one mobile number returns every deal, job card,
enquiry and registration file touching that person across showrooms in one
call — and somebody who bought at one outlet and services at another comes back
as one person rather than two.

**Verified.** 61 entities and 95 links across two outlets. Mr Rohit Bansal
returns as one record spanning a deal, an enquiry and a registration file, with
each row carrying the state its own module's screen shows. Tenant isolation
holds at both layers — Malhotra's search returns `[]`, the dossier 404s, and
`ddms_app` holding Malhotra's session reads 0 of 61 entities.

Two things it caught, both real:

> **The same person came back twice.** The registration fixtures gave Devender
> Singh Rathee a different mobile from his sales record — a fixture bug, but it
> exposed a design error underneath: a registration file *names its deal*, and
> matching on a phone number when an explicit reference is available is the
> wrong way round. The named deal now wins; the number is the fallback.
>
> **Entity ids were not stable.** The first version deleted and re-inserted
> everything, so the scheduler silently reassigned every id fifteen minutes
> after anyone opened a dossier — and reset `firstSeenAt` on every pass, making
> "known since June" a claim that refreshed itself. Found by opening a URL that
> had been valid a minute earlier and getting a 404. Entities are upserted now;
> links stay wholesale, because they have no identity worth keeping.

Also 13× faster after batching the writes: 4,942ms → 382ms for the same graph.
The cost was never Postgres, it was 160 round trips to a pooler in another
region.

### OBJ-10 — The screens act  ✅ **done 4 Aug**
*Covers R-20, R-21, R-46.*

Every "what to do" that can be resolved deterministically becomes a control. No
model is involved in any of it:

| Screen | Controls |
|---|---|
| Enquiries | call · WhatsApp · **reassign** to an active member of staff |
| Deals | start application (exists) · copy the policy number to key in |
| Service | call — vehicle ready · chase the part · request approval |
| Registration | **assign to the RTO agent** · chase the RTO · call — RC ready |
| Spares | request transfer from the branch that has it · raise reorder |

Each control writes a decision field that already changes the derived state, so
pressing it moves the row rather than logging a note nobody reads.

**Done when:** no row on any of the five screens says "call the customer"
without a way to call them and record it, and pressing a control changes that
row's derived state on the next render.

**Verified**, through the browser and against the numbers:

| | |
|---|---|
| Registration actions | needsAction 8 → 6 |
| Spares transfer requested | needsAction 6 → 5 |
| Assign to Imtiaz Khan, who left 28-02-2026 | **409** — *"assigning work to them is the problem this is meant to fix"* |
| Assign to Vikram Chandel, still employed | 200 |
| Transfer from another owner's outlet | 404 |
| Decision log | six rows, each with a user, an action and a before/after |

**And the one that matters most.** Logging a call on a breached OEM lead moved
the advice from *"Call now — this is already reportable to the OEM"* to *"Key
the contact into the OEM portal against this lead"*, added the note explaining
why, and left **`slaBreached` at 2**. Our record does not stop the
manufacturer's clock, the derived state still uses their field, and the screen
says so. A version that cleared the breach would have told an owner they were
compliant while the OEM's report disagreed.

### OBJ-11 — Nothing leaves the building unapproved  ✅ **done 4 Aug**
*Covers R-22 in part, R-48, R-49, R-50.*

The composer drafts the contact — the message to the customer whose vehicle is
ready, the email telling an RTO agent a file is theirs, the handover note to the
salesperson a lead has just landed on. Rules decide whether it may be sent. A
person approves until trust is earned.

**Internal notifications before customer-facing ones.** Emailing a member of
staff their own workload is low risk and immediately useful; messaging a
dealership's customers is the first thing this product does that leaves the
building, and it goes behind the gate.

**Done when:** a drafted message exists against a worklist row, and no message
can leave without either a rule permitting it or a person approving — proven by
attempting to send one that neither permits and watching it be refused.

**Verified.** The proof is the second row:

| | |
|---|---|
| Draft the customer WhatsApp for a vehicle ready and uncollected | 201, `DRAFT`, gate refuses |
| **Send it with nobody having approved** | **409** — *"This is addressed to a customer. No rule permits that."* Still `DRAFT`, `sentAt` null, `authorisedBasis` null |
| Approve, then send | `HELD_NO_TRANSPORT`, basis `PERSON`, `sentAt` **still null** |
| Draft the agent's email before anybody is assigned | 409 — *"assign it first, then tell them"* |
| Assign, then draft | gate allows it, basis `RULE`, rule `INTERNAL_STAFF_NOTIFICATION` |
| Send it | `HELD_NO_TRANSPORT`, basis `RULE`, `approvedByUserId` null — no person involved |
| Hand the file to somebody else, then send the draft addressed to the first agent | 409 — *"not the person this record is assigned to"* |
| "Vehicle ready" about a job card awaiting a part | 409 — *"telling a customer otherwise is worse than telling them nothing"* |
| The other owner reading, approving, sending or cancelling any of it | 404 each |

Driven through the browser as well as the API: drafting from the service and
registration screens, the refusal appearing on the row that caused it, then
approving and sending from the outbox.

**One number on that screen is deliberately zero and stays zero.** *Actually
sent* is 0, because the transport registry is empty — there is no SMTP
credential and no WhatsApp Business account, so an authorised message is held
and the row says nothing was delivered. The gate is what this objective is; a
"sent" badge for a message no customer received would be the same defect as a
simulated policy number that looks issued (R-41).

> **Two bugs the screen showed before the code did.** The RTO agent was told
> about the same file twice, two minutes apart: the partial unique index only
> blocks a duplicate while the first is `DRAFT` or `APPROVED`, and it *has* to
> release so a legitimate nudge next week can go — so the window belongs in the
> application, where "again already?" and "again, later" can be told apart. And
> the agent's email carried the lapsed temporary registration on two consecutive
> lines, because the worklist note already prefixes it.
>
> **And one the model produced.** The first customer draft read *"Dear Mr Satish
> Verma, your HF Deluxe"* and stopped — the token budget covered the model's
> reasoning as well as its output. It passed the fact check, because a truncated
> message invents nothing. `checkRewrite()` now tests all three directions:
> nothing invented, nothing dropped, and it ends in a finished sentence.
>
> **And one that was invisible by construction.** A malformed request made the
> model path inert for a while and every draft came back `RULE` — which is
> exactly what a healthy fallback looks like. A silent fallback and a silent
> failure are indistinguishable unless one of them says so, and now it does.

### OBJ-12 — The panel that explains  ✅ **done 4 Aug**
*Covers R-22, R-23, R-49.*

One panel, on every worklist row, reading through typed tools over the entity
graph and the projections that already exist. It answers what the row cannot:
*why is this stuck, who else is affected, what happens if this waits another
week.*

What it must never do is decide whether something is wrong. `classify()` already
does that — deterministically, auditably, for free — and replacing a rule that
is right every time with a model that is right most of the time would be a
downgrade dressed as an upgrade. The agent resolves, composes and explains. It
does not authorise.

**Done when:** on any row, the panel answers a question the screen does not
already display, and every claim in its answer traces to rows a query returned
rather than to prose it generated.

**Verified**, through the API and then through the browser. What the panel said
about a registration file the RTO had sent back, none of which is on that screen:

| Finding | Where it came from |
|---|---|
| The temporary registration lapsed 3 days ago, so the vehicle is on the road unregistered | `what_the_clock_says`, by subtraction over the dealer's own dates |
| Jaswinder Sethi is carrying it, along with 9 other open records | `who_is_carrying_it` — the number that turns a staffing anecdote into an argument |
| 3 decisions recorded against it here | `what_we_have_done` — the decision log, which does not exist in the dealer's system |
| 1 message drafted about it, none of which has actually been delivered | the outbox, said honestly |

And on a part nobody in the group has: *"Mr Deepak Ahuja has been waiting 9
days… 1 on order, expected 10-08-2026… this part has not been issued to anybody
for 41 days."* Three tools, one answer, every figure on screen underneath it.

**The evidence is on the screen, not behind a promise.** Each finding is one
sentence assembled by a rule from a row a query returned, and every one of those
rows is in the panel under *what was looked at*, expandable to the raw JSON. The
model's paragraph sits above them, labelled, and is accepted only when every
figure in it appears in the evidence.

**The panel works with no model at all**, which is what makes it a feature
rather than a demo. During verification the free tier returned **429** on one
record and the answer was unchanged apart from the missing paragraph.

> **Three things found by reading the output.** Every narration was rejected as
> unfinished, because 1,000 output tokens covered the model's reasoning as well
> as its reply — the same bug as the composer's, on a prompt four times the size.
> Two findings said the same thing twice, because the tools overlap on purpose
> and a module's note is often *about* a deadline the clock then reports again;
> resolved by de-duplicating the sentences rather than narrowing either tool.
>
> **And one the check could not catch.** A finding that read *"It has not moved
> for 5 days"* became *"the record has not moved for 5 days"* in the model's
> paragraph — a claim about the transfer request rather than the stock, wrong,
> and with the figure cited correctly. `citationsHold()` verifies figures, not
> meanings. The fix was to name the subject in the finding, because an ambiguous
> finding is one waiting to be misread, by a person as easily as by a model.

## 3b. Researched 4 August — what an enterprise workflow platform is made of

Anirban asked whether Salesforce and HubSpot had architecture worth borrowing
rather than features. They do, and the research changed the shape of what is
left. Sources are listed at the end of this section.

### The finding that matters most

Salesforce's spine is not objects or layouts. It is that **automation binds to a
record changing state**, and that the chain which then runs has a documented,
deterministic order — before-save flows, before triggers, after triggers,
after-save flows, each with an explicit trigger-order number from 1 to 2,000.
An organisation can reason about what a save will do.

**DDMS has no events at all.** Sync writes the mirror and screens derive on
read. Everything built so far — actions, gate, composer, panel — is *pull*. A
registration file crossing into `RC_IN_DRAWER` overnight produces nothing until
somebody opens a page. An agent workflow needs *push*, and there is nothing to
push.

The maddening part is that sync already knows. It compares `rawHash` on every
row on every pull, and throws the answer away.

### What each platform contributes, and what DDMS already has

| Concept | Where it comes from | DDMS today |
|---|---|---|
| Automation binds to a state change, in a declared order | Salesforce record-triggered flows | nothing |
| Business events, not field diffs — publish `RC_IN_DRAWER`, not `rc_received_date changed` | Platform Events vs Change Data Capture | nothing, and the distinction decides the design |
| One listener, hub-and-spoke, never point-to-point | Salesforce event architecture guidance | n/a yet |
| Deny by default, then widen deliberately; the later layers **can only grant** | org-wide defaults → role hierarchy → sharing rules | RLS, owner-scoped ✅ — but no tier inside a dealership |
| Route on required skill **and** spare capacity **and** presence; additional skills prevent dead-ends | Omni-Channel | `listStaff` returns `role` and `carrying` ◑ |
| An agent is declared as role, data, actions, guardrails, channel — and cannot act outside that closed set | Agentforce | `tools.ts` read-only ✅, `actions.ts` write ✅, but the agent may call neither |
| Enrol on a trigger, run steps with delays, **unenrol on a goal** | HubSpot workflows and sequences | nothing — and DDMS's version can be better, because the goal is a state it computes rather than a click it hopes for |

### What was refused, and why

The research turned up the failure mode as clearly as the pattern. Salesforce
orgs reach **eighty active flows on a single object**; page saves take eight
seconds; recursion appears where the same object shows up repeatedly in a
dependency tree; and the automation layer becomes, in one practitioner's
phrase, *a graveyard of decisions nobody documented and behaviours nobody can
predict*. It is not caused by bad administrators — it is caused by good ones
working without a governance layer.

That is a warning aimed directly at this product, because **DDMS's customer has
no administrator at all**. Every configuration surface is a person a
short-staffed dealership does not employ. So:

- **No rule builder.** Rules live in code, in one ordered list, reviewed like
  any other change (R-52).
- **A cap, stated out loud.** A ceiling on active rules, with the number
  written down and a reason next to it.
- **Thresholds are the only thing that becomes data** (R-58) — the numbers
  belong to the dealership, the logic does not.
- **No mass send, no campaigns, no lead scoring by model, and no record
  creation.** The first two are what R-48 and R-50 exist to prevent; the third
  is R-49; the fourth would make DDMS a second system of record, which is the
  precise thing it was built to expose.

  > **The fourth was re-cut on 6 August and the other three stand.** DDMS is an
  > ERP as well as a control plane, so *creates nothing* is false as written —
  > but the instinct was right and survives as **R-76: DDMS creates nothing the
  > DMS is the source of truth for.** Mirror-only stays mirror-only; what the
  > dealer's system does not hold is DDMS's own. See §3c.

### The revised order, and why

| Order | Objective | Model? | Why here |
|---|---|---|---|
| 1 | ~~**OBJ-13** The mirror emits events~~ ✅ | no | invisible, small, and four things are blocked behind it |
| 2 | ~~**OBJ-14** People, and what each may see~~ ✅ | no | the queue needs a *me*; and it is half of the access story |
| 3 | ~~**OBJ-8** One credential~~ ✅ | no | the other half. Doing 14 and 8 together was one piece of work about who sees what, and it had been outstanding since 3 August |
| 4 | ~~**OBJ-15** The queue~~ ✅ | no | the capacity thesis, finally operational |
| 5 | ~~**OBJ-16** Rules that run themselves~~ ✅ | no | needs 13 for the trigger and 15 for somewhere to put the work |
| 6 | ~~**OBJ-18** The dealership's own numbers~~ ✅ | no | *added 4 Aug.* The queue shipped with our opinion of what matters in it |
| 7 | **OBJ-19** The agent remembers what this dealership did | no | *added 4 Aug.* Precedent from the decision log. Before 17, so the agent that acts acts with it |
| 8 | ~~**OBJ-17** The agent operates the registry~~ ✅ | yes, gated | the registry, the refusals, the gate and the audit trail all exist by then |
| 9 | ~~**OBJ-6** A dealership that reads as real~~ ✅ | no | last, and better last — by then there is more for the data to exercise, and it exposed a missing search on every list plus three bugs |

> ~~**OBJ-20 — a person may write their own sentence**~~ ✅ **done 5 Aug**, and
> it was unsequenced above because it is small and it is a usability gap rather
> than a capability one. It was taken first anyway, out of order, because it
> belongs before anybody demonstrates the Outbox to a dealership and the local
> hosting on 5 August was that demonstration: the answer to *"can I just add a
> line?"* was no, and that is the wrong answer.

> Two objectives already on the list keep their place in it rather than being
> pushed behind new work. OBJ-8 moves *up*, because roles and credentials are
> the same question asked twice.

> **The one product decision this plan waited on, answered 4 August: a
> dealership's staff get their own logins.** It is written up in OBJ-14 and it
> is what makes the queue somebody's work rather than a differently sorted
> list. It also brings deprovisioning with it, since the mirror already knows
> who has left.

### OBJ-13 — The mirror emits events  ✅ **done 4 Aug**
*Covers R-51.*

Sync already computes whether a row changed. This makes it say **what changed
about it**: a `record_events` row naming the module, the record, the state it
left and the state it entered.

Derived-state transitions, not field diffs — the Platform-Events reading rather
than the Change-Data-Capture one. `REGISTRATION → RC_IN_DRAWER` is a business
event a rule can act on. `rc_received_date changed` is a fact about a column,
and every rule reading it would have to re-derive the meaning that
`classify()` already produced.

It also answers a question nothing currently can: *how long has this been
stuck*, as distinct from *what is it now*.

**Done when:** a state transition that happened while nobody was signed in is
readable afterwards, with its before and after — and the same transition
detected twice does not produce two events.

**Verified**, and the whole proof ran with nobody signed in until the reading:

| | |
|---|---|
| Two scheduler passes over both outlets | 67 events across 67 distinct records — **one each** |
| Moved, when nothing had changed between the passes | **0** |
| Then: a policy keyed into the *mock OEM's own system*, by PATCH, with DDMS not involved | the OEM replied 200 |
| The next scheduler pass, unattended | **exactly one event** — `DEAL HMC-DL-2026-000183 · AHEAD → IN_SYNC` |
| That record's timeline, filtered the way a row will read it | `first seen → AHEAD`, then `AHEAD → IN_SYNC` |
| The screen afterwards | *"Both systems hold SIM-BAJAJ-API-MSD9PEXS."* |
| The other owner reading these events | 404 |

The scheduler also gained the two syncs it never learned about in OBJ-4 —
receivables and the vehicle floor — which had been running on manual sync only
since they were built.

> **The bug worth keeping: the showroom is part of a record's identity.**
> `dms_part_stock` is keyed on `(showroomId, partNo)` unlike every other mirror,
> so `HR-BRK-SHOE-R` is `AVAILABLE_ELSEWHERE` at Saraswati and `OK` at Deccan.
> Keyed on the part number alone, the two outlets overwrote each other in the
> comparison and the log flapped between the two states on every pass, for ever.
> It showed up as two events one second apart with the states reversed. A key on
> a record has to be the key that record actually has, and CLAUDE.md had said so
> about this exact table since OBJ-4.

### OBJ-14 — People, and what each of them may see  ✅ **done 4 Aug**
*Covers R-53, R-61, R-62, R-63, R-64. Extends OBJ-3 and OBJ-7 down a level.*

**Locked 4 August: a dealership's staff get their own logins.** That answer is
what turns the queue from a differently sorted list into somebody's work, and
it decides the shape of OBJ-15 through OBJ-17.

Today one login is one owner and sees everything; `users.role` is
`OWNER | MANAGER` and the column's own comment admits both see the whole group.
A dealership is nine people with different jobs.

**A login is an employee.** `users` gains an `empCode`, and that code is already
on the enquiries, registration files and job cards that person is responsible
for — `assignedEmpCode`, `reassignedToEmpCode`, `assignedAgentEmpCode`,
`advisorEmpCode`. The join is what `listStaff` has been computing `carrying`
against since OBJ-10. Roles come from the same place: `dms_employees.role`
already carries SALES_EXEC, SERVICE_ADVISOR, TECHNICIAN, RTO_AGENT, ACCOUNTS
and MANAGER.

**Deprovisioning falls out of the mirror, in one direction only.** The DMS
already records `dateOfLeaving`, and the reassignment actions already refuse
work to somebody who has left. The same fact should close their login. But
strictly one-way: an owner creates a login and links it to an employee, and the
mirror may only ever *revoke*. A name appearing in a staff master must never
become an account — that is Salesforce's sharing asymmetry, where the layers
after the baseline can only grant, applied here in reverse so that the layers
after the baseline can only take away.

The honest limit travels with it: revocation is as fresh as the last sync, and
that window is the scheduler's interval. It is the same window the reassignment
refusal already runs on, and it should be said on screen rather than implied.

**Scope, as three predicates ANDed onto the owner's:**

| | |
|---|---|
| Owner | unchanged — `app.current_owner_id()`, and everything already built rests on it |
| Outlet | the employee's showroom, not the owner's whole set |
| Module | the role's — an RTO agent gets registrations, accounts gets the ledger, an advisor gets the workshop |

Never ORed. A bug in the role layer must be able to hide rows and must not be
able to reveal them, which means every new predicate narrows and none of them
widens.

**Two decisions inside this, both taken deliberately:**

*See the outlet, act on what is yours.* Hiding a colleague's leads in a
nine-person dealership would be wrong — they cover for each other, and the
orphaned-work finding only works if somebody other than the departed person can
see it. Visibility is the outlet; the write is yours or nobody's (R-63).

*The cross-outlet finding survives; the rows do not.* Spares already returns
`availableAt` as a summary of another branch rather than that branch's rows, and
receivables returns `groupExposure` rather than the other outlet's ledger. That
accident of design turns out to be exactly the rule (R-64): an advisor still
learns the part is free at Deccan and still cannot open Deccan's books.

**Done when:** a service advisor signs in and cannot read the receivables
ledger — proven by a query returning nothing rather than by a hidden menu item —
and an employee the DMS reports as departed cannot sign in at all.

**Verified**, and `pnpm run db:probe` is the check rather than the claim: it
mints a short-lived session per login, connects as `ddms_app`, and counts.

```
login                     role             outlets  deals enq  jc  parts  regn  recv  veh
anirban@…                 OWNER            1,2          5  10  10     14    12     8    8
owner@malhotramotors…     OWNER            7            0   0   0      0     0     0    0
jaswinder.sethi@…         RTO_AGENT        1            0   0   0      0    12     0    0
sunil.rawat@…             SERVICE_ADVISOR  1            0   0  10     14     0     0    0
meera.joshi@…             ACCOUNTS         1            5   0   0      0     0     8    0
vikram.chandel@…          SALES_EXEC       1            5  10   0      0     0     0    8
imtiaz.khan@…             -                -            0   0   0      0     0     0    0
```

Through HTTP as well:

| | |
|---|---|
| Advisor → the ledger | **403** — *"A service advisor does not see the ledger. Yours covers job cards and the parts counter."* |
| Accounts → the ledger | 200, 6 rows |
| Accounts → job cards | 403 |
| RTO agent → registrations | 200, 10 rows · → enquiries 403 |
| Advisor → the other branch's spares screen | **404**, the same answer as another dealership's |
| Advisor → their own branch | 200 — and still *"PUN-DECCAN has 4"* on the part their customer waits for |
| Accounts → the ledger's group figure | ICICI Lombard owes ₹85,500 across 2 outlets, same as the owner sees |
| Imtiaz Khan, who left 28-02-2026 | **401** at sign-in, and zero rows at the database |
| Malhotra owner → Saraswati's ledger | 404, unchanged |

**Two bugs found by running the tools rather than by reading the code.**

> **The departure was enforced only in application code.** `db:probe` showed
> Imtiaz Khan still reading his branch's rows: `resolveSession` refused him, but
> the policies did not know he had gone, so a session row obtained any other way
> would have worked. That fails OBJ-7's own standard — *isolation enforced by
> the database, not only by application code* — so the check moved into
> `app.session_user_id()`, which every policy helper now resolves through. He
> reads nothing at all now.
>
> **A refusal looked like an absence.** The RTO agent landed on Enquiries — a
> module he cannot read — and saw four zeroes and *"No enquiries mirrored yet"*.
> That is a false claim about somebody's own dealership. The console now lands
> each role on a screen they can work on and states the refusal where it cannot,
> which is the same discipline as never showing a simulated policy as issued.

### OBJ-15 — The queue  ✅ **done 4 Aug**
*Covers R-54, R-55. Absorbs the rest of R-19.*

One screen, one ordered list, across all seven modules, for the person signed
in — which, since OBJ-14, is a named member of staff with an `empCode` rather
than the owner. Worked start to finish without going back to a list.

Three bands, in this order: **mine**, then **nobody's**, then **my outlet's**.
The middle band is the one that matters — orphaned work is what a short-staffed
dealership loses, and R-19 has been asking for it since the register was
written.

Routing takes who can do it, who has room, and who is in today — and when
nothing matches, work degrades to a named queue rather than vanishing. A
nine-person dealership cannot afford an item that is unroutable, which is
exactly what happens when skills gate eligibility and nobody holds the skill.

**Done when:** the leading number on that screen is everything waiting on a
person across every module, and somebody can clear ten items without once
returning to a list.

**Verified.** Signed in as the owner, the screen leads with **33**, and ten
items were worked through in a browser — counter 1 of 33 through 11 of 33, 23
left — with the URL never leaving `/`. Not one of them was the same kind of
work as the last: a unit on the floor 131 days somebody is asking for, a
receivable whose promised date passed, a part blocking a job card, an enquiry
whose salesman left, a warranty claim in dispute.

| login | total | mine | nobody's | outlet's | modules |
|---|---|---|---|---|---|
| Anirban, owner | 33 | 0 | 17 | 16 | all seven |
| Vikram, sales exec | 7 | 1 | 3 | 3 | enquiries, vehicles, deals |
| Sunil, service advisor | 10 | 3 | 7 | 0 | job cards, parts |
| Jaswinder, RTO agent | 6 | 5 | 1 | 0 | registrations |
| Meera, accounts | 4 | 0 | 4 | 0 | receivables, deals |

An owner's *mine* is zero and that is right: an owner has no employee code, so
nothing in the dealership is assigned to them. The bands are computed from
codes, and no code means no claim.

**R-19 closed, end to end.** The orphaned lead — Suresh Pillai, assigned to a
salesman who left on 28-02-2026 — reads *"Was Imtiaz Khan, who has left.
Nobody is carrying this"* in the second band, with a picker offering only staff
who are still here and what each already holds: *Vikram Chandel · 3 open*,
*Neha Grover · 5 open*. Handing it on moved the record from **Nobody's ·
NO_OWNER · "Reassign to someone still here"** to **Mine · FOLLOW_UP_OVERDUE ·
"Make the follow-up call"** — the item did not disappear, it became somebody's
next call.

> **Two bugs the screen found, both about not moving under somebody.**
>
> Acting on an item invalidated every `/api/dms/*` query, the queue included,
> so the list rebuilt and everything below shifted up — the next item moved out
> from under the person about to read it. `invalidateWorklists` now excludes
> the queue by name; it builds fresh on arrival and rebuilds when somebody asks,
> and the header says when it was built.
>
> And the reassignment picker was handed the employee code on the row, which on
> an orphan belongs to somebody who has left. It rendered a tick beside a
> departed salesman's code with an *undo* next to it — a confirmation that the
> work was assigned, on the one screen that exists because it is not.

> **And one thing this shipped with that is not ours to decide.** `SEVERITY`
> says a stuck registration outranks a broken payment promise. That is a
> dealership's judgement, not a product's, and it is one afternoon's opinion
> written into a file — see **OBJ-18**, which makes it per-owner data an owner
> or a showroom manager sets.

### OBJ-16 — Rules that run themselves  ✅ **done 4 Aug**
*Covers R-52, R-56, R-57, R-60. **R-58 moved to OBJ-18** — thresholds becoming
per-owner data is the same piece of work as the severity table becoming
per-owner data, and doing it twice would mean two tables of the dealership's
numbers.*

```
on   <event>        a state transition, or a clock
if   <conditions>   over the same projections the screens read
then <action>       the existing typed registry, or a draft into the gate
```

Trigger deterministic, conditions deterministic, action from the registry that
already refuses correctly. No model anywhere in the decision path.

The line from R-48 does not move: a rule may write a decision field — internal,
reversible, attributed to the system — and anything outbound still passes
`authoriseSend()`. And every cadence carries a goal state, so a chase stops
because the file moved rather than because somebody remembered to stop it.

**Done when:** a file crossing into `RC_IN_DRAWER` with nobody watching
produces a queue item and a drafted message; the same file, once the customer
has collected, produces neither; and the whole rule set is one ordered list
short enough to read in a sitting.

**Verified, with nobody signed in for either half.**

Three registration files sat in `RC_IN_DRAWER`. One unattended pass produced
**four drafts** — those three and a job card finished and uncollected — every
one `created_by_user_id` null, which is R-60's *the system did this*. All four
were then refused by the gate: *"This is addressed to a customer. No rule
permits that, so it needs somebody to read it and approve it before it can go."*
Four drafts, four refusals, nothing sent. That refusal is the product working.

Then the customer collected. Keyed into the mock OEM's own database — DDMS is
read-only and was not involved — and the next unattended pass:

| | |
|---|---|
| `REG-0417-3298` in the RTO agent's queue | **gone** |
| Its draft | **`CANCELLED`**, `user_id` null, note *"Withdrawn: registration REG-0417-3298 is no longer rc in drawer, so the customer collects it and the file leaves rc_in_drawer"* |
| `REG-0417-3311`, not collected | still `DRAFT` — the withdrawal is targeted, not a sweep |
| Drafts raised that pass | **0** |

And the set is five rules with a ceiling of twelve, readable on the Outbox
under *What runs itself* and at `GET /api/dms/rules`. `assertRuleSetFits`
throws at import above the ceiling, because a cap nobody enforces is a comment.

> **Stopping the cadence was not the whole of R-57.** The rule correctly
> stopped raising new drafts once the file moved, and the draft raised last week
> was still sitting in the Outbox waiting for somebody to approve telling a
> customer to come and collect a certificate they already had. Nothing about
> that message was true any more and the person approving it had no way to know.
> A rule now withdraws its own open drafts when the record leaves the state that
> raised them — `DRAFT` only, rule-raised only, cancelled rather than deleted.

> **No rule writes a decision field, and that is a finding rather than an
> omission.** R-56 permits it and `applyAction` would take a null user id, but
> every decision field in this product encodes a claim about something a person
> did — *the customer was told*, *the RTO was chased*, *a reorder was raised*. A
> rule writing one would be the product asserting work that never happened,
> which is the same defect as a policy number that looks issued. When a field
> appears that records something the *system* did, a rule may write it.

> **And the scheduler's credential grew again.** Rules draft, so `ddms_worker`
> now holds insert and update on `outbound_messages` and insert on
> `decision_log`. It is the widening that changes what that role *is* — it no
> longer only mirrors, it proposes. What has not changed is what may leave:
> `authoriseSend()` is still the only thing that writes `sent_at`.

### OBJ-17 — The agent operates the registry  ✅ **done 5 Aug**
*Covers R-59, and finishes R-22.*

The agent stops describing work and starts doing it — by calling the same
endpoint the button calls.

That is the whole design. Agentforce's useful idea is that an agent is a
declared role with a closed set of actions and explicit guardrails, and DDMS's
closed set already exists and already refuses correctly: 409 for a departed
employee, 404 across tenants, the gate on anything outbound. An agent on that
registry inherits every refusal for free.

`decision_log.userId` is nullable and its comment already anticipates this:
*"a future automated rule may act without a person — and when it does, a null
here has to read as 'the system did this', never as 'we lost track of who
did'."*

**Done when:** the agent completes a queue item by calling `/api/dms/actions`,
is refused for exactly the reasons a person would be, and the decision log
shows the system did it — with a person able to undo it.

> **The set is two of twelve, and that is the objective's main finding.** The
> question for each registry action was not *can the agent do this* but *what
> would be true of the dealership if it did*. Eight assert that a **person** did
> something — rang the customer, chased the RTO, showed the bike — which is
> OBJ-16's objection to a rule writing a decision field, and it gets stronger
> rather than weaker when the writer is a model. `RECEIVABLE_MARK_DISPUTED` is a
> judgement about whether an account is in breach, which R-49 reserves outright.
> `PART_RAISE_REORDER` asserts a purchase order in the dealer's own system,
> which DDMS never writes to. The two that survive record a routing decision
> DDMS itself is making, and DDMS is entitled to make it.
>
> `CLOSED_TO_THE_AGENT` in `lib/dms/agent.ts` names all ten with the reason
> beside each, so widening the set is an argument with a sentence rather than a
> branch somebody widens.

**The rule chooses; the model may only phrase.** The assignee is the
lightest-loaded person in the role the queue asks for, from staff who still work
here — `listStaff` already excludes anybody who left and already counts what
each carries, so the choice is a sort. A model may write the sentence that goes
on the row and into the log, checked by the same `citationsHold()` the
explanation panel uses. With no key the deterministic sentence stands.

**Off until a dealership turns it on** — `AGENT.ASSIGN_ORPHANS`, default 0, on
*Your numbers*. Off, the agent's suggestion rides on the queue row and a
person's click applies it, logged as **theirs**. On, the scheduler assigns and
the log carries null. Anirban's call, 5 August: *"for acting we will do option 1
first, when it works good we will do option 2 in next version."*

**Proved on `ddms_worker`, not through a request** — `pnpm run verify:agent`,
eleven steps, and the credential is the point: a request would have proved it on
`ddms_app`, which is what a person holds.

| | |
|---|---|
| switched off | `enabled=false considered=0 assigned=0` |
| switched on | `assigned=2`, `decision_log.userId` **null** on both |
| the records | `ENQ-0417-9103 → SA-0417-19`, `REG-0417-3307 → RT-0417-02` |
| the queue | Nobody's band 14 → 12, and a second pass finds nothing |
| refused | 409 *"Imtiaz Khan has left the dealership (2026-02-28)"*; 404 *"No showroom 3"* |
| undone | by a person, and the log says `userId=1`, not null |

> **The switch cannot be set by the thing it switches on.** The first version of
> the verifier wrote the row on `workerDb` and got `permission denied for table
> dealer_policy` — `ddms_worker` may read the dealership's numbers and may not
> set them. That refusal was not designed for this; it fell out of OBJ-18's
> grants and turned out to be exactly right.

> **The citation check refused a true sentence, and the fix was to give it the
> figure rather than weaken it.** A model naming the file it was talking about —
> `REG-0417-3307` — was rejected because `04173307` was a figure no tool had
> returned. The record key is now in the evidence rows. The check catching an
> identifier it had never been shown is the check working; loosening it so
> identifiers pass generally would have been the wrong repair.

### OBJ-18 — The dealership's own numbers  ✅ **done 4 Aug**
*Covers R-65 **and R-58**, which moved here from OBJ-16 on 4 August: the
severity table and the thresholds are one piece of work, and splitting them
would leave a dealership with two places to set their own numbers.*

`SEVERITY` in `lib/dms/queue.ts` decides what a short-staffed dealership does
first, and right now it is one afternoon's judgement written by us into a file.
Whether a stuck RC outranks a broken payment promise is not a product question.

Per-owner rows, the product's table as the default, and a screen where an owner
or a **showroom manager** — who already holds every module in `access.ts` —
sets a number against each known state. Changes go through the same
`applyAction` path as everything else, so who changed it and what it was before
land in the decision log without new machinery.

**Deliberately not a rule builder.** The states are a fixed enum, the values are
1–3, and there is nothing to compose. That is the R-52 line: thresholds and
priorities become data, logic does not. The failure mode this product is
designed against is eighty flows on one object, and eighty numbers in a table
cannot do that.

**Done when:** an owner moves `DEAD_STOCK` below `RTO_SILENT`, the queue reorders
on the next build for every login in that dealership, the previous value is in
the decision log, and a **Reset to the product's defaults** control puts it back.

**Verified.** `RTO_SILENT` has no rows in the seeded dealership, so *below* is
not observable on it; the same mechanism was proved on a pair that does exist.
The owner raised **Dead stock** from *when there is time* to *today*:

| | before | after |
|---|---|---|
| Anirban, owner | #17 of 32, severity 1 | **#5 of 32, severity 3** |
| Sunil, service advisor | #9 of 9 | **#4 of 9** |

One dealership, one set of numbers — the owner's change reordered a service
advisor's queue, which is the point. Then:

| | |
|---|---|
| Service advisor sets a number | **403** — *"Only an owner or a showroom manager sets these. They decide what the whole dealership does first, and your role covers one part of it."* |
| A key not in the registry | **400** — *"There is no setting called … The numbers a dealership may set are a closed list."* |
| Dead stock after 5 days | **400** — *"Dead stock after must be a whole number between 30 and 720."* |
| Every change | in `decision_log` with the previous value: *"Dead stock: 1 → 3"*, *"Ageing after: 60 → 300"* |
| Reset | the row is **deleted**, and dead stock is back at #17 |

Reset deletes rather than writing today's default down. A dealership that
resets keeps following the product's default *afterwards* — writing it into the
table would freeze them on whatever we happened to think in August.

**Nine thresholds moved out of five files.** `TR_WARNING_DAYS`,
`RTO_QUIET_DAYS`, two `CHASE_FRESH_DAYS`, `DUE_SOON_DAYS`, `DEAD_STOCK_DAYS`,
`AGEING_DAYS`, `AGEING_SEVERE_DAYS` and `STUCK_ALLOCATION_DAYS` were
`const X = 90` in the classifier that used them, which is a fine place for a
number nobody disagrees with and the wrong place for one every dealership does.
Raising *ageing after* from 60 to 300 changes what the vehicle floor says, and
the detector and the rules read the same numbers as the screen — a log that
disagreed with the screen it came from would be worse than no log.

> **The threshold change found a classifier bug.** With ageing at 300 days, two
> units somebody had been offered came back as `AGEING_SEVERE`, whose note reads
> *"nobody has asked for it"* — a plainly false claim about a unit a salesman had
> shown to a named customer. `OFFERED` was only ever checked *inside* the ageing
> branch, so being offered was reported as a side effect of also being old. Same
> rule the registration classifier learned in OBJ-4: **derived state describes a
> cause, not a consequence.** Being offered is a cause; ageing is a separate axis
> and the figure travels on the row either way.

### OBJ-19 — The agent remembers what this dealership did
*Covers R-66 to R-71, and answers the "otherwise it is just a dumb thing"
objection to OBJ-17.*

Everything the product knows about a record it works out from scratch each time.
Fifty-eight decisions are already logged with a person against them, sixty-eight
state transitions with dates, and nothing has ever read either one to ask **what
did we do last time this happened here**. That question is what separates an
agent from a rules engine with a chat window.

**Case-based reasoning, not a memory store.** The literature's three-tier
episodic/semantic/procedural split describes systems that write memories; the
substrate here is two append-only logs the product already keeps, and precedent
is a query over them rather than a thing to be curated. Retrieval is a group-by
on named features — module, state, and the two or three that differ between
cases — because with hundreds of records and twelve action types the honest
index is an index, and "why did it show me that one" has a one-sentence answer.

What it produces, in the three places a person is already looking:

| Where | What it adds |
|---|---|
| A queue item | *"Six of these in the last 60 days. Five were chased within a day; one was disputed."* |
| The explain panel | The nearest past cases, what was done, and what came of the record afterwards |
| The owner's priority screen | *"Nobody has touched a `DEAD_STOCK` item in 60 days"* — a proposal to change the stored number, which the owner accepts or refuses |

**Four failure modes, and the answer to each is already in the product's shape.**

| Failure | Why it does not happen here |
|---|---|
| **Self-reinforcement** — the agent re-reads its own output as ground truth and one early error becomes settled | Only rows with a `userId` count. R-60 made *the system did this* distinguishable for exactly this kind of reason, a fortnight before there was a use for it |
| **Poisoning** — the effective payload is something that reads like a preference or a constraint | Nothing is written. Precedent is derived on read from logs that only `applyAction` can append to, so there is no ingestion surface to attack |
| **Temporal obsolescence** — a memory that is true and no longer current | A moving window and a date on every claim. A habit the dealership drops leaves the product by itself |
| **No admissibility** — the agent cannot decline a retrieved memory | It never applies one. Precedent reaches a person, or it reaches the owner as a proposal about a stored number. R-49 does not bend |

**Explicitly not:** precedent does not reorder the queue, does not change a
classifier's answer, and does not widen what `authoriseSend()` permits. It
proposes and it explains. The owner's table is the only thing that moves the
order, and a person moves it.

**Done when:** a queue item for a state this dealership has handled before
carries what was done last time with a count and a date; a state it has never
handled carries nothing rather than a hedge; and a pattern stopped 60 days ago
is gone from the screen without anybody retiring it.

### OBJ-20 — A person may write their own sentence  ✅ **done 5 Aug**
*Raised by Anirban, 5 August. Covers R-72 to R-75.*

The Outbox shipped with **no editing**, deliberately, and the reasoning is
written at the top of `Outbox.tsx`: a message is what a rule composed and what
`checkRewrite()` confirmed asserts nothing the facts do not support, so free
text would put an unverified claim in the dealership's name.

That reasoning is half right, and the half it gets wrong is the half that
matters here. **The check exists to stop a *model* inventing things.** A named
manager writing their own sentence and then approving it is not that risk — it
is a person taking responsibility, which is precisely what R-48 asks for. The
current design says *cancel it and fix the record instead*, and what will
actually happen is that somebody cancels the draft and picks up the phone, and
the outbox stops being used.

A concrete case, and it is the one Anirban gave: assigning a registration file
to an agent and wanting to add *"Mr Verma is coming in on Saturday, please have
the file ready"*. Nothing in the composed text covers it and nothing should —
it is not a fact the mirror holds.

**How it gets built, and this is the part that keeps R-48 intact:**

| | |
|---|---|
| Editing is allowed, on `DRAFT` only | An approved message has been read by somebody; an edit after that is a different message |
| An edited message **can never take the rule path** | `authoriseSend()` returns a `PERSON` basis or nothing. The internal-notification rule permits text a rule composed, not text somebody typed, and that distinction is the whole of why the rule is safe |
| The composed body is kept | `body` becomes what will go; the original stays, so *what did we draft* and *what did they send* are both answerable |
| The edit is logged | `decision_log` with before and after, like every other decision |
| `draftedBy` gains `PERSON` | Today it is `RULE` or `AGENT`. A human-edited message is neither, and the Outbox should say so on the row |

**Done when:** a manager edits a drafted assignment note, the row says it was
edited and by whom, the gate refuses it a rule basis so it needs approval even
though the unedited version would not have, and the original text is still
recoverable.

**Proved on the one draft the test needed** — message 31, an internal lead
handover to Neha Grover, `DRAFT`, gate `OK RULE`. Adding a sentence to it turned
that verdict into *"Anirban Sinha added their own words to this. The rule only
sends text it composed itself"*, `send` came back 409, and after approval it
went out on a `PERSON` basis with `authorisedRule` null. `composedBody` still
holds the rule's wording, unchanged by a **second** edit — written once, so it
stays the composed text rather than the previous edit's.

Three refusals worth naming: editing an `APPROVED` message is 409 (R-75), an
empty body and a 4,001-character one are both 400, and an edit that changes
nothing returns the row untouched and writes no log line — recording it would
close the rule path on a message a rule could still send.

> **The name is denormalised on the row and that is a deliberate reversal of
> the usual instinct.** `editedByName` could be joined from `users`, except
> `ddms_app` — the credential every request runs on — has no grant on that table
> at all, and it holds password hashes. Widening it so a screen can print a name
> would be a poor trade. It is also the better answer regardless: *this sentence
> was written by Sunil Rane on 5 August* stays true after he is renamed or
> leaves, and re-resolving the id later would quietly answer a different
> question.

> **One consequence surfaced only by writing the withdrawal note.** A rule
> withdraws its own stale drafts (OBJ-16), and a rule-raised draft somebody has
> since typed into is still rule-raised. Withdrawing it is right — the message
> asserts something that has stopped being true, which is the exact failure that
> function was added to fix — but the note now names the person who added to it
> and says their text is kept on the row. The system may withdraw a person's
> words; it should never do it silently.

| # | Requirement | Status |
|---|---|---|
| R-72 | **A person may edit a draft; a rule may not send what a person edited.** The rewrite checks guard against a model inventing figures. A named person writing their own sentence and approving it is the opposite case — it is somebody taking responsibility, which is what R-48 wants — but it must always take the person path, never the rule one | ✅ |
| R-73 | **What was drafted survives what was sent.** The composed text is kept alongside the edited text, because *what the product proposed* and *what the dealership said* are different facts and both are worth having later | ✅ |
| R-74 | **An edit is a decision and is logged like one.** Who, when, and both versions | ✅ |
| R-75 | **Editing is for `DRAFT` only.** Approval means somebody read it; text that changes after that has not been read by the person whose name is on the approval | ✅ |

### Sources

Salesforce order of execution and record-triggered flows —
<https://www.salesforceben.com/before-save-flow-vs-after-save-flow-in-salesforce/>,
<https://help.salesforce.com/s/articleView?language=en_US&id=sf.flow_considerations_trigger_record.htm&type=5>.
Event-driven design, Platform Events versus Change Data Capture —
<https://developer.salesforce.com/blogs/2022/10/design-considerations-for-change-data-capture-and-platform-events>,
<https://sfdcprep.com/salesforce-platform-events-vs-change-data-capture-use-cases/>.
Sharing model —
<https://help.salesforce.com/s/articleView?id=platform.security_sharing_owd_about.htm&language=en_US&type=5>,
<https://architect.salesforce.com/docs/architect/fundamentals/guide/platform-sharing-architecture>.
Omni-Channel skills and capacity routing —
<https://medium.com/@shirley_peng/salesforce-omni-channel-how-skills-based-routing-really-works-54326fafbdc8>.
Agentforce and the Atlas reasoning engine —
<https://engineering.salesforce.com/inside-the-brain-of-agentforce-revealing-the-atlas-reasoning-engine/>,
<https://stackoverflow.blog/2025/05/28/a-deep-dive-into-building-an-agent-framework-for-salesforce/>.
HubSpot workflows, sequences, goals and unenrolment —
<https://blog.hubspot.com/customers/workflows-vs-sequences>,
<https://knowledge.hubspot.com/articles/kcs_article/workflows/set-unenrollment-triggers-in-company-deal-ticket-quote-based-workflows>.
Automation sprawl, the failure mode being designed against —
<https://www.equals11.com/blog/flow-sprawl-is-the-silent-killer-of-your-salesforce-org-6-signs-you-have-it>.

Agent memory, researched 4 August for OBJ-19. The three-tier taxonomy and what
production systems actually keep —
<https://thenuancedperspective.substack.com/p/designing-agentic-memory-in-2026>,
<https://arxiv.org/html/2603.07670v1>.
Case-based reasoning, which is the shape this product needs rather than a
memory store — retrieval by named features, and recommendations that carry
their similarity, their matching features and their points of difference so
that reason-giving and audit are possible —
<https://www.givainc.com/blog/case-based-reasoning-cbr-meaning-ai-help-desk/>,
<https://www.sciencedirect.com/science/article/abs/pii/S0950705107000433>.
The failure modes, which decided the design more than the patterns did —
self-reinforcement through re-ingesting one's own output, temporal
obsolescence, poisoning by plausible-looking preferences, and the missing
admissibility mechanism that leaves agents unable to decline a retrieved
memory —
<https://arxiv.org/html/2603.11768v1>,
<https://arxiv.org/html/2607.27080>,
<https://arxiv.org/pdf/2606.06054>.

### OBJ-6 — A dealership that reads as real  ✅ **done 5 Aug**
*Covers R-6, R-33. Replaces "get real DMS access", which Anirban ruled out on
3 Aug: the data we generate is the data, and it has to feel real rather than be
real.*

Deepen the seeded dealership until nothing on screen reads as a fixture: enough
volume that the lists need filtering, names and models spread the way a real
month is, and no demo labelling anywhere in the chrome.

**Done when:** somebody shown the console without preamble asks a question about
the business rather than a question about the data.

A deterministic generator in `dms-mock/src/generate.ts`, **appended** to the
hand-written fixtures rather than replacing them. `push` rather than a spread
inside the array literal, so *the hand-written rows are untouched* is a property
of the code: every scenario the last six sessions proved something against keeps
its id, its dates and its position, and every proof in the session log stays
reproducible.

| | before | after |
|---|---|---|
| enquiries | 9 | **141** |
| job cards | 8 | **104** |
| registration files | 10 | **88** |
| deals | 4 | **78** |
| vehicle stock | 6 | **58** |
| parts | 9 | **67** |
| receivables | 6 | **50** |
| staff | 11 | **21** |

One seeded PRNG and no `Math.random` anywhere: reseeding twice produces the same
dealership. `store.ts` already argues this about state surviving restarts, and
it applies with more force to generated volume — a dealership that is different
every morning cannot be demonstrated and a bug that appears in one shape of data
cannot be found.

**The ratios are the claim, not the volume.** Roughly one row in six needs
somebody. The hand-written fixtures were effectively all stuck, because each was
written to demonstrate a failure, and that made the queue read as a dealership
in crisis rather than one having a normal month.

> **R-33 needed no change, and one thing that looked like a violation was not.**
> `doc-ingest` labels its stub OCR engine *"returns fabricated demo data"* — that
> is R-41 working, not R-33 broken. R-33 is about the dealership's records not
> being badged as a fixture; R-41 is about never presenting simulated output as
> real. The stub genuinely fabricates and the label is the honest one.

#### What the volume exposed, which is what generating it was for

> **Every list screen needed a search and none had one.** Filtering by state
> existed everywhere — a chip row is the right control for *show me everything
> stuck the same way* — and it is the wrong control for the question somebody
> walks up with: *the customer is on the phone, what is happening with Mr
> Pillai's bike*. At nine enquiries that gap was invisible because you could
> read the screen. At a hundred and forty-one it is the difference between a
> working screen and one people give up on. `lib/find.tsx`, wired into all seven
> lists; `pillai` → 4 of 141.

> **The reconciliation screen showed one state sixty-seven times.** Every row
> said `BEHIND` — *the DMS holds a policy DDMS did not issue* — and every one was
> **true**: it was describing a dealership that had signed up this morning and
> been handed its entire sales history as a to-do list. That is an onboarding
> problem, not a day's work. The seeded dealership now *has been using* DDMS, and
> the screen reads `IN_SYNC 53 · BEHIND 12 · NOT_STARTED 7 · CONFLICT 4 ·
> AHEAD 2` — which is what that screen is for.

> **Reconciliation is string equality, so marking one side manufactures a
> conflict.** Prefixing DDMS's copy with `SIM-` while the mock's stayed unmarked
> produced fifty-five `CONFLICT` rows — *two different policies against one
> vehicle*, the sharpest state that screen has — out of deals where both systems
> held the same policy. The fix was to mark the mock's numbers too: every number
> in that fixture is a policy no insurer issued, and R-41 does not become
> optional on the side of the boundary we happen not to be writing.

> **Two draws for one decision.** Job cards asked `chance(0.66)` separately for
> the post-service record and for its date — two different draws from the same
> stream — so a third of them had a record and no date or a date and no record,
> and thirty-eight landed on the queue as a follow-up call that had already been
> made. Decided once now.

> **Four of nine model codes did not exist.** The mix carried Passion, Glamour
> and Xoom, which a real Hero dealer certainly sells and `catalogue.ts` does
> not, and the mock's own portal died on the first request looking up a warranty
> period for a model with no entry. Narrowed to the six the catalogue holds
> rather than inventing four more service schedules the catalogue's own header
> warns against.

---

## 3c. Reframed 6–10 August — DDMS as an agentic ERP, and the journey model

Anirban developed the product in parallel sessions and asked for the
understanding to be revamped rather than the code changed. **Nothing in this
section is built.** It reconciles everything discussed between 6 and 10 August
into one path, and it supersedes parts of §3a and §3b where they disagree.

Two research corpora informed it and are cited where they did: a first-hand
extraction of **wrrk.ai** (155 pages, `C:\Users\Rentorzo\scrapi\reports\wrrk-ai.md`)
and the **QM** agent harness (`github.com/yc-software/qm`, README only). Both are
read for *construction*, not for pricing or positioning.

### What changed, in one line

> DDMS was **an owner-level control plane over a read-only mirror**. It is now
> **an agentic ERP and CRM that uses the DMS's data to produce insight and
> action** — and the mirror is a source, not the identity.

Three standalone products, not one umbrella. InsurRouter is separate by design
and shares the database deliberately, because its scope is two-wheeler policy
issue only — same domain, same records. Modules are written so each can be
called on its own.

### The non-goal that had to be re-cut, not deleted

*"No record creation / not a second system of record"* was written to stop DDMS
becoming a duplicate DMS that silently drifts. As an ERP that rule is false as
written, and the instinct behind it is still right. The new line, agreed:

> **DDMS creates nothing the DMS is the source of truth for.**

Deals, job cards, stock, enquiries, registration files → mirror only, forever.
Notes, activities, tasks, quotations, price lists, decisions, internal costs →
DDMS's outright.

**And that re-cut is what unlocks the agent.** OBJ-17 opened 2 of 12 registry
actions because 8 of the other 10 assert *a person did something* against a
record DDMS does not own. Adding agents does not move that number. Owning
records does: a note the agent wrote is the agent's note, and nothing false is
being claimed. CRM is not a screen — it is the thing that gives an agent
anything legitimate to do.

### The journey model

DDMS knows what is wrong with a **record**. It has never understood a
**journey**. A vehicle sold is one thing walking through the building —
invoice, insurance, registration, road tax, RTO, RC — and today that is ten
unrelated rows on four screens, with nothing in the system aware they are the
same sale.

A journey is a **graph**: steps, and forks between them. Every step declares
five things — what must be true first, what it does, who does it (rule · agent ·
person · outside world · the dealer's own system), what it produces, and what
happens when it cannot run.

Four kinds of waiting, and DDMS can express none of them today:

| | |
|---|---|
| on a person | approve, key it in, make the call |
| on the outside world | the RTO, the financier, India Post |
| **on another journey** | insurance, before registration can move |
| on time | nothing to do until Tuesday |

**A wait is a queue row, and that is the mechanic that pays for the whole
thing.** Today seven classifiers each hand-write their own *what to do*
sentence. With journeys, a stalled step *is* the queue entry — it already knows
where it stopped, why, and what it was doing before.

Two shapes of backwards edge, and they are not the same:

- **loop** — an RTO objection sends a registration file back to document
  collection, carrying the objection reason. It may loop more than once.
- **unwind** — a finance rejection releases the allocated unit back to free
  stock and hands the customer back to the enquiry journey. This is the only
  process in the dealership that runs backwards and frees a physical asset, and
  nothing models it: the `STUCK_ALLOCATION` state is that bike, three weeks
  after the deal died, with no record of why.

The journeys, with the forks that matter, are listed in the design note. The
commercial funnel — **lead → pre-sales → sale → booking → finance → invoice** —
was missing from the first pass and Anirban added it; the booking seam is where
money first changes hands and the finance seam is the unwind.

### Autonomy is earned, not set — and this is the session's best idea

Everyone builds autonomy as a dial somebody sets. Anirban's proposal is
autonomy **earned by evidence, where the evidence is the dealership's own past
decisions**:

| Stage | What the system does | Who decides |
|---|---|---|
| **0 · watching** | notices a pattern, says nothing | nobody |
| **1 · recall** | *"the last 7 times, you gave it to Jaswinder. Same again?"* | the person, every time |
| **2 · pre-filled** | the answer is already selected; press go | the person, faster |
| **3 · automatic** | *"10 out of 10. Shall I just do it?"* → consent, once | the person, once, revocably |

**Why it is safer than a dial, and it is not obvious.** At stages 0–2 the model
does **recall**, never judgement. It answers *what happened before* — a query
with an answer — and never *what should happen*. R-49 therefore survives intact
all the way up the ladder. The graduation *is* the safety mechanism.

This does not contradict R-69 (*precedent never authorises and never acts*). It
adds one step: precedent is the **evidence a person consents on**, and the
consent authorises. Precedent still authorises nothing.

Three properties it needs to be honest: **demotion**, or it is a ratchet;
**per pattern**, not per agent or per module; and the threshold is **the
dealership's number**, belonging on the *Your numbers* screen — a cautious owner
sets 25, a confident one 5.

wrrk's cruder version of the same instinct: after two weeks, a rejection rate
above **20%** means the agent is not ready and more autonomy is the wrong
answer; below **5%**, expand. **[Documented]**

### The architecture — six layers, and one door

| | Layer | What lives here | Who touches it |
|---|---|---|---|
| 1 | **Ground truth** | the mirror · records DDMS owns · every decision · where each journey has got to | everything, through one door |
| 2 | **Journey definitions** | the maps. Steps, forks, conditions. Hardcoded, versioned | nobody at runtime |
| 3 | **The runtime** | live journeys, one per real-world thing. Durable pause and resume | the scheduler, and people acting |
| 4 | **Stored intelligence** | every journey ever walked, which way it went, what followed | **the agent only** |
| 5 | **Agents** | read 4, propose against 3, act through the one door | — |
| 6 | **Surfaces** | queue, screens, Outbox, WhatsApp | people |

Layer 1 is Postgres and stays Postgres: truth, audit, and the dealer-group
boundary all live there. Layer 2 is code — most forks are definitive, so they
are hardcoded and reviewed like any other change, which is R-52 unchanged.
Layer 3 is the durable runner, and *pause and resume across weeks* is the single
biggest thing DDMS cannot do today.

> **The one door: nothing writes to layer 1 except through the same call a
> person's button makes.**

Not agents, not the runtime, not the graph. This is the same argument as OBJ-17
one level up, and it is what makes the rest deferrable — permissions, roles, who
sees what can all be settled later, because whenever they are, they are settled
in one place and everything inherits them.

### The floor, now three times attested

| | |
|---|---|
| **DDMS** | no rule can permit a customer message — by construction, not omission |
| **wrrk.ai** | *"a code-level guarantee, not a configuration toggle. There's no admin setting to auto-approve emails, by design"* **[Documented]** |
| **QM** | hard denials in the predeclared command policy apply **across all security postures** **[Documented]** |

Three teams, three products, one conclusion: **the floor lives in code and
configuration cannot reach it.** It stops being a DDMS opinion and becomes an
attested pattern — and it composes with graduation exactly as it must:

> **Graduation moves a pattern up the ladder. It can never move it past the
> floor.**

### The intelligence store

Anirban's argument for a graph is better than the one first offered: if a
journey *is* a graph, a completed journey is a **path through it**, and *what
did we do last time in this situation* is literally *find paths that reached
this node with these properties and see which edge they took*. That is a graph
query by nature.

His second point resolves the isolation objection: **only the agent reads the
store**, and whatever it surfaces goes out through DDMS's normal
permission-checked surfaces. So the store needs one partition per dealer group
and **no permission model of its own**. Scope the reader, not the store — the
same idea QM builds its whole workspace model on **[Documented]**.

Build it behind **one interface with four questions** — *what happened before ·
what usually happens next · where does this normally stall · what is unusual
here*. SQL first, because R-70 already argues for named features over
embeddings and it is a week's work to find out whether the graduation loop
works at all. Swap in a graph when a question needs paths. Nothing above the
interface knows which is behind it.

### The runtime, and why Python is fine

Process logic in Python with LangGraph, the rest TypeScript. One rule decides
whether that is safe:

> **The Python orchestrator is a client of the existing API, never a second
> thing with a database connection.**

It calls the endpoints the buttons call, and inherits every refusal, the gate,
the decision log and row-level security. Give it its own connection and every
rule has to be written twice, and the first one somebody forgets is the hole.

One caution carried: LangGraph is built for model-driven apps and most of our
nodes have no model in them. That is supported — but its presence will tempt a
model onto a decision edge. **Never on the edges. The edges are rules.**

### Ingestion — three ways in, one record

> **Ingestion varies. Completion does not.**

| Path | Who it is for | Onboarding | Freshness |
|---|---|---|---|
| Direct fetch | large groups, cooperative DMS | one integration per OEM | live |
| **Report drop** | **most dealers** | map the columns once | per export |
| PDF scan | the smallest, and anyone with nothing else | per document type | per document |

Anirban's correction, and it reframes the priority: **the dealers with no API
are the majority and the most underserved.** A sub-dealer in Tripura doing five
units a month feels the pain more than a group doing eighty and has nothing.
Building for the API case and treating the rest as fallback serves the smallest
part of the market.

Enabled **per data type per dealer**, not per dealer — stock by report,
invoices by PDF, and the API two years later when the OEM opens it, without
breaking anything already running.

The report path graduates like everything else: a model maps the column
headings **once**, a person confirms **once**, and thereafter extraction is
deterministic. Model cost is one-off per dealer per report type, not per row.

**This is what VeloDocs becomes** — the generic *unstructured source → our
schema, with a human confidence gate* pipeline. Insurance was its first
consumer; DMS ingestion is its second.

Every field carries its **source** and a **confidence**. A value read off a
mapped column is not the same fact as one an API returned, and the row must say
which — the same instinct as `SIM-` on a simulated policy number.

### The invoice DDMS produces

Anirban chose **(b): DDMS produces the invoice document**, and the reasoning is
sound and worth recording. The customer does not necessarily get the DMS's
invoice: the dealer may sell at an older price list, discount against ageing
stock, or retain the OEM's scheme rather than pass it on. All three are the
dealer's commercial decision. *"Who am I to stop him — I have to give him the
product which gives him the invoice."*

**The argument for (b), stated properly:** DDMS's document is the DMS's facts
**plus the commercial agreement**. Neither system holds both — the DMS does not
know what was promised, DDMS does not know the chassis and the tax split. Only
the join produces the document the customer should get.

Three consequences:

- **Price lists become first-class data** — effective dates, whose list, model
  → ex-showroom. The invoice picks one, defaults to current, and prints the
  choice: *"priced per list effective 12 July."* The DMS is a current-state
  system that forgets yesterday's price; DDMS keeps the history.
- **Discount composition is recorded** — how much is the dealer's and how much
  the OEM's. The claim to the OEM is owed **whatever the customer was told**,
  and an unclaimed scheme is money already given away.
- **Which document is the tax invoice is a per-dealer setting.** Only one system
  may hold a sequential GST series. Where DDMS holds it, setup takes GSTIN, HSN,
  place-of-supply rules and IRP credentials above the e-invoicing threshold;
  where the DMS holds it, DDMS's document carries the DMS invoice number for
  linkage and its own reference series. Same generator, one flag.

And the readiness gate produces **a new kind of queue row**. Everything in the
queue today is a problem; this is the first item that is an **opportunity** —
*everything is in place, the invoice can be generated*, with the figures on it
and a button. Invoices are not late because typing is hard. They are late
because nobody noticed the deal became ready.

### Corrections to things already built

> **The RC does not sit in the dealer's drawer.** Once issued it goes by India
> Post to the customer's address. The dealer's controllable duty is **the
> communication address being right at the point of lodging** — which is
> *preventive* and therefore better: three addresses exist (the deal, the KYC
> document, the registration file) and nothing compares them. A mismatch found
> before lodging costs a phone call; found after, it is a lost RC and a
> re-application. **Open:** whether `RC_IN_DRAWER` and its weekly chase rule
> should be retired outright or kept for corrections and re-issues.

> **WhatsApp will refuse most of what the Outbox composes.** The Business API
> requires a Meta-approved template for the first message and for anything after
> 24 hours of silence **[Documented]**. Templates suit the design better than
> free prose — blanks filled from `facts` are the no-invented-figures rule
> enforced externally — but a person's own sentence (OBJ-20) can only go inside
> an open 24-hour window. Parked at Anirban's instruction: the message content
> is not the current concern.

> **Auto-reassignment stays off.** The queue's job is visibility for two
> audiences — the manager sees what is stuck, the employee sees what is theirs.
> The agent's assignment already ships off by default and stays there, *held
> pending design confirmation with a customer.*

### The three modes an agent can run in, and DDMS has one

QM and wrrk both attribute agent actions to **the person who started the run**
**[Documented]**. DDMS writes null — *the system did this* — and for a scheduled
pass that is the only honest answer, because nobody started it.

But it exposes a gap: **DDMS has no way for a person to ask the agent to do
something.** Our agent only ever runs on a timer. A person-initiated run, under
their name and their permissions, audited, is the **safest** of the three modes
and the one we lack.

| Mode | Who is accountable | DDMS today |
|---|---|---|
| scheduled | nobody — the system | ✅ |
| person accepts a suggestion | the person who clicked | ✅ |
| **person asks the agent** | the person who asked | **missing** |

### New requirements

| # | Requirement | Status |
|---|---|---|
| R-76 | **DDMS creates nothing the DMS is the source of truth for.** The re-cut of the old non-goal. Deals, job cards, stock, enquiries and registration files stay mirror-only forever; notes, activities, tasks, quotations, price lists and internal costs are DDMS's outright — and owning them is what gives an agent anything legitimate to write | ✅ |
| R-77 | ✅ **A journey is the unit of work, and a wait is a queue row.** Steps, forks, and four kinds of waiting — on a person, on the outside world, on another journey, on time. A stalled step *is* the queue entry rather than a sentence somebody wrote for that module | ✅ |
| R-78 | ✅ **Forks are rules. A model may write a sentence inside a step; it may never choose an edge.** Almost every fork in every journey is knowable from data — is tax paid, is the part on the shelf, did the date pass. R-49 restated for the runtime, and the specific temptation a workflow library introduces | ✅ |
| R-79 | **Autonomy is earned by evidence and can be lost the same way.** Precedent → repeated acceptance → consent, per pattern, with the threshold set by the dealership and demotion when acceptance falls. A dial somebody sets is a guess; a count is a fact | ✅ OBJ-26. Four rungs off a moving window, consent stored for the fourth, demotion on a 20% override rate |
| R-80 | **Graduation can never cross the floor.** Hard denials apply at every level of autonomy, and no amount of precedent promotes an action past them. Attested independently in three products | ✅ OBJ-26. `ceilingFor()` reads the permission table, so the floor caps the ladder rather than the ladder crossing it |
| R-81 | **One door.** Nothing writes to the record except through the same call a person's button makes — not agents, not the process runtime, not any second service. It is what lets every question about roles and visibility be answered later in one place | ◑ the agent and the button share `applyAction`, attested by `verify:agent`, and outbound has its own single door in `authoriseSend`. What is *not* attested is that a second path cannot appear — nothing fails if somebody writes one |
| R-82 | **Precedent is scoped, and never crosses a dealer group.** One dealership's operating decisions must not inform another's. Within a group the owner sees everything, across groups nothing — which is where the boundary already is | ✅ `precedentFor` is scoped to `ownerId` **and** the caller's visible showroom ids, and both tables are behind RLS besides |
| R-83 | **The intelligence store is read by the agent alone.** Whatever it surfaces leaves through a permission-checked surface, so the store needs partitioning by group and no permission model of its own | ✅ satisfied by there being no store. Precedent derives from `decision_log` and `record_events`, which already carry the group boundary and the permission model — so there is nothing needing one of its own |
| R-84 | ✅ **Ingestion varies; completion does not.** Direct fetch, report drop and document scan produce one canonical record, and the readiness check does not know which path a field arrived by  | ✅ |
| R-85 | ✅ **Every ingested field carries its source and its confidence.** A value read off a mapped column is not the same fact as one an API returned, and nothing downstream may treat them alike  | ✅ |
| R-86 | ✅ **A mapping is confirmed once by a person, then it is fixed.** The model reads unfamiliar column headings once; a person approves; extraction is deterministic thereafter. Model cost is per report type, not per row — and the same shape as graduation  | ✅ |
| R-87 | ✅ **Price is the dealer's decision, and DDMS records which list was used.** Selling at an older list, discounting ageing stock or retaining an OEM scheme are commercial calls. DDMS holds price lists with effective dates and prints which one an invoice was priced against | ✅ |
| R-88 | ✅ **An OEM scheme is claimable whatever the customer was told.** The claim is owed on the scheme amount regardless of how much was passed on, and DDMS is the only system holding both halves | ✅ |
| R-89 | ✅ **A document must say what it is.** If it is not a tax invoice it must not look like one. Same instinct as *held — nothing was delivered* and the `SIM-` prefix | ✅ |
| R-90 | ✅ **Only one system may hold the tax-invoice series.** Which one is a per-dealer setting; two systems issuing from one sequential series produces gaps or duplicates, and both are audit findings | ✅ |
| R-91 | **A person may ask the agent to act, under their name and their permissions.** The third mode, and the safest, because accountability is unambiguous from the start | ◑ the mechanism is there — an agent already acts through `applyAction` under a principal — and there is still no screen where a person asks it to do something under *their* name |
| R-92 | **An agent run has a cost and a cap.** Per-run cost, a daily ceiling, and attribution. wrrk quotes $0.01–$0.05 a run and caps at 50/org/day **[Documented]**; DDMS meters nothing | ✅ OBJ-28. Per-run cost from the provider's own token counts, a daily ceiling that is the dealership's number, and attribution on every run. An unknown model bills at the top of the rate table |
| R-93 | **A run is a trace, not a row.** The decision log answers *what happened to this record*. A multi-agent run is a narrative across records and agents, and nothing today can show it as one thing | ✅ OBJ-28. `agent_runs` and `agent_run_steps`, ambient through an `AsyncLocalStorage` so nothing threads a run id. A step naming a write points at its `decision_log` row rather than repeating it |
| R-95 | ✅ **One table answers every permission question, and the agent is a principal in it.** Verb-scoped `namespace.verb`, not tiered roles. The agent holds grants like any role rather than being a special case beside the table, so a second agent is a principal and a set of grants and nothing else changes. Withheld permissions carry a written reason where there is one worth writing — *a model cannot make a phone call* is a fact about the world, not about the grant | ✅ |
| R-94 | **The agent may stand down.** When its proposals are being rejected it pauses itself rather than continuing to propose. wrrk auto-pauses a campaign on acceptance-rate decay **[Documented]**; DDMS has no version of this | ✅ OBJ-28. Two reasons — the day's money, or being overruled across every pattern — recorded as a run with outcome `STOOD_DOWN`, and it resumes on its own |

### The revised order

| # | Objective | Model? | Depends on | Why here |
|---|---|---|---|---|
| 21 | ~~**One permission model**~~ ✅ | no | — | two half-systems exist — module read-gating and the agent's action set. Everything below adds actions and principals to both |
| 22 | ~~**DDMS owns its own records**~~ ✅ | no | 21 | the unlock. Notes, activities, tasks, quotations, price lists. Nothing an agent can honestly write until this exists |
| 23 | ~~**The journey model**~~ ✅ | no | 22 | the runtime, proved end to end on one journey |
| 24 | ~~**Ingestion beyond the API**~~ ✅ | at the mapping step only | — | independent of everything, and the thing that decides how many dealers can be sold to at all |
| 25 | ~~**The invoice DDMS produces**~~ ✅ | no | 22, 23, 24 | the first document the product issues, and the first record it holds *before* the DMS knows anything |
| 26 | ~~**Autonomy: the ladder and graduation**~~ ✅ | recall only | 21, 23 | needs journeys running long enough to have history to cite. Absorbs OBJ-19 |
| 27 | ~~**dm-concierge — messages out, replies in**~~ ✅ | no | 22 | the Outbox has no transport at all. Inbound is the larger half: a reply is a fact the DMS will never hold |
| 28 | ~~**The trace and the stand-down**~~ ✅ | no | 23, 26 | you cannot supervise what you cannot watch, and cost belongs here |
| 29 | ~~**More agents**~~ ✅ | yes | all | last, and only once there is a model that admits new principals, a ladder to place them on, records they may write, and a trace to watch them in |

*Objectives 30 to 33 are in section 3d; 34 and 35 in section 3e. They are
numbered in one sequence and planned in three, which is what the reconciliation
on 12 August was for.*

> **24 has no dependencies and the strongest commercial argument.** It can be
> taken out of order whenever reaching more dealers matters more than deepening
> the product for one.

> **29 is deliberately last, and most people would do it first.** The §3b
> research found the failure mode is never bad agents — it is ungoverned
> accumulation, eighty flows on one object, *"a graveyard of decisions nobody
> documented"*. N agents that can trigger one another reach that faster.

### OBJ-21 — One permission model  ✅ **done 10 Aug**
*Covers R-95. Prerequisite for R-81 and R-82, and for objectives 22, 24 and 26.*

DDMS has two permission systems that do not know about each other.
`lib/dms/access.ts` gates **reading**, by module, by role. `lib/dms/agent.ts`
gates **writing**, by listing two of the twelve registry actions and naming the
other ten with a reason each. Both are hand-written tables in different idioms,
and a third is scattered inline as `role === "OWNER" || role === "MANAGER"`.

Every objective below adds actions, or principals, or both. Adding them to two
tables guarantees the two drift, and the first drift is a hole.

The shape is verb-scoped rather than tiered — wrrk's 120 permissions across 31
namespaces, with `view` / `view_all` ownership pairs **[Observed]**. Half of it
DDMS discovered independently: the queue's *mine · nobody's · my outlet's* bands
**are** that pair.

**The agent becomes a principal in the same table, not a special case.** That is
the point of the objective. `CLOSED_TO_THE_AGENT` stops being a constant and
becomes the absence of a grant — but the ten reasons must survive the move,
because the reasons are the valuable artefact, not the list.

Stays in code, not database rows: R-52's argument unchanged, and the detail of
who-sees-what is deliberately deferred. This builds the seam so that decision
lands in one place whenever it is made.

**Done when:** one function answers every permission question in the product,
the agent is refused by the same table that refuses a service advisor, the ten
reasons are still readable, and no screen or route changes behaviour.

`lib/dms/permissions.ts`. `access.ts` is deleted, its four importers repointed,
`AGENT_ACTIONS` and `CLOSED_TO_THE_AGENT` are now *read from* the table rather
than being a second copy of it, and the session carries `permissions` so the
console stops working out for itself whether somebody is an owner.

**Proved by `pnpm run verify:permissions`** — thirty checks, no database and no
server, which is itself part of the point. Every role reads exactly the eight,
four, three, two, two and zero modules it read before; the agent still holds two
of twelve and the other ten still carry their written sentence.

> **The route that checked nothing, and why it was not the hole it looks like.**
> `POST /dms/actions` performed no permission check at all — any signed-in user
> could ask for any of the twelve actions. It was never exploitable:
> `app.can_read(module)` sits in the `using` **and** `with check` of every
> mirror table's row policy, so Postgres refused it.
>
> What was wrong was the **sentence**. `applyAction` reads the row before it
> writes, row-level security makes that read return nothing, and the caller got
> `404 — No receivable REC-0417-5504`. Which is false. The receivable exists;
> they may not see it. A 404 is right *across* dealerships, where confirming a
> record exists is itself a leak. Inside your own dealership with the wrong role
> it is unhelpful, and the table already held the sentence that helps:
>
> ```
> 403  A service advisor does not see the ledger.
>      Yours covers job cards and the parts counter.
> ```
>
> Defence in depth working is not the same as the application being honest, and
> only one of those two was true.

> **Two questions that shared one implementation.** Policy writes asked
> `seesEveryOutlet(role)` — *can you see across branches* — to decide *may you
> set what the whole dealership does first*. Same answer today, different
> questions, and the day a dealership wants a branch manager who sets numbers
> for one outlet the old code would have had to be untangled to find out which
> of the two it meant. They are now `outlet.view_all` and `policy.set`, with the
> same holders and no shared implementation.

> **The console held a third table.** `role === "OWNER" || role === "MANAGER"`
> was written into the *Your numbers* screen. The session now carries
> `permissions`, and the screen asks `permissions.includes("policy.set")` — the
> same string the route checks. Still cosmetic, exactly as `modules` is: hiding
> a control is a courtesy, the route and the row policies are the control.

> **The queue moved 221 → 256 between the two runs and none of it is this
> objective.** Five days passed in the session; job cards go overdue, follow-ups
> lapse, stock ages. The permission-relevant invariants are the ones that had to
> hold and did: an owner still sees all eight modules, and a service advisor's
> queue contains `JOB_CARD` and `PART` and nothing else.

### OBJ-22 — DDMS owns its own records  ✅ **done 10 Aug**
*Covers R-76. The unlock for 25, 26 and 27.*

The first records DDMS creates rather than copies: notes, activities, tasks,
quotations and price lists. Bounded by R-76 — nothing the DMS is the source of
truth for.

This is the objective that makes agents useful rather than the objective that
adds agents. Eight of the twelve registry actions are closed to the agent
because they assert a person telephoned somebody. A note the agent wrote asserts
only that the agent wrote a note.

Price lists carry effective dates, because the DMS is a current-state system
that forgets yesterday's price and a dealer may legitimately sell at an older
one (R-87).

**Done when:** DDMS holds a record the DMS has no field for, an agent writes one
without asserting human work, and nothing mirror-only has become writable.

**Scoped down on the way in, and worth saying so.** The paragraph above listed
five record types. Quotations and price lists moved to **OBJ-25**, where R-87
already lived and where they are actually used — building them here would have
been building the invoice's data model a fortnight before the invoice. What
shipped is the spine: `record_activities` and `tasks`.

**The rule, and it is enforced rather than intended:**

> **An agent may record what the agent did. It may never record what a person
> did.**

`AGENT_KINDS` is that rule as a closed set — `OBSERVED` and `SYSTEM`, and
nothing else. *The address on the deal does not match the KYC document* is
something the agent genuinely did. `CALL`, `VISIT` and `MESSAGE` describe human
acts and stay human, each with a written refusal:

```
CALL     Asserts a person picked up a telephone. The agent cannot, and a call
         logged that never happened takes the customer off somebody's list.
NOTE     A note is somebody's opinion, and the agent does not have one to
         record. What it observed is an OBSERVED.
INBOUND  The customer said this. It is written when a reply actually arrives,
         by the transport that received it — never composed.
```

**Two layers, each doing what it is good at.** The permission table answers
*may this principal write at all*; the row policy answers *about which records*,
gating on the same `app.can_read(module)` as the mirror row the activity points
at. A service advisor is refused a note on a registration file **by Postgres** —
and gets the sentence from OBJ-21's table rather than a silent empty result.

**Tasks are not a second list.** Open tasks appear *in the queue*, sorted with
everything else on the same three keys. A Tasks screen would recreate exactly
what OBJ-15 was built to remove. `QueueItem` gained one field — `source:
DERIVED | TASK` — and severity comes from the due date rather than from whoever
raised it, because letting people mark their own work urgent makes everything
urgent inside a fortnight.

**Proved by `pnpm run verify:records`**, on the worker credential, because the
claim is about what happens with nobody signed in:

| | |
|---|---|
| the agent writes `OBSERVED` | allowed, `authoredBy=AGENT`, `userId=null` |
| `CALL` · `VISIT` · `MESSAGE` · `NOTE` · `INBOUND` | all five refused, each with its sentence |
| raises a task | allowed, attributed to the agent |
| closes one | **refused** — `task.complete` is not in its grants |
| task on Imtiaz Khan | refused — *left 2026-02-28, a task nobody will do* |
| on the queue | 248 items — 247 derived, 1 written down, sorted together |

> **The verifier's own cleanup was refused, and that was the design working.**
> The first run tried to delete its rows on `workerDb` and got `permission
> denied for table record_activities`. `ddms_worker` holds select, insert and
> update and **not** delete — the same argument as cancelling a message rather
> than removing it. A note nobody can prove existed is worse than a note
> somebody withdrew, and **nothing unattended may erase a record, not even its
> own.** Tidy-up moved to the CLI credential and the refusal became check 8.

> **A person writing `SYSTEM` is recorded as `NOTE` rather than refused.** People
> do notice things. The distinction being kept is *who noticed*, not whether
> they were allowed to — so the row is corrected rather than rejected, which is
> the friendlier half of the same rule.

### OBJ-23 — The journey model  ✅ **done 10 Aug**
*Covers R-77, R-78. Needs 22.*

Steps, forks, and four kinds of waiting. Proved end to end on one journey —
**invoice raised to RC delivered**, because it spans four screens that today do
not know they describe one sale, it contains a real loop, and it is weeks long
so pause-and-resume is exercised rather than asserted.

The mechanic that pays for it: a stalled step *is* the queue row. Seven
classifiers currently hand-write their own *what to do* sentence.

**Done when:** one journey runs end to end across a simulated month, survives a
restart mid-flight, an RTO objection sends a file backwards with its reason
attached, and every queue row for that journey is produced by the runtime rather
than written by a classifier.

**Six layers were designed and three were built.** Layer 2 is
`lib/dms/journeys/vehicle-delivery.ts` — nine steps, hardcoded and versioned.
Layer 3 is `runtime.ts`. Layer 1 gained `journeys` and `journey_steps`. Layers 4
to 6 — the intelligence store, more agents, the graph — are OBJ-26 and OBJ-29
and nothing here presumes their shape.

**The walk, and the reason the loop needed no special case:**

> **The position is the first step that is not done.**

Not *the step after the last one we saw complete*, which was the obvious design
and is wrong twice over: it advances one step per pass and drifts behind a file
that moved three steps in a week, and it can never go backwards at all. Because
the walk is total, any fact-set maps to exactly one position — so when the RTO
rejects a file, `DOCUMENTS` stops being done and the position simply **is**
earlier. There is no backwards edge to maintain. The `journey_steps` row records
the direction and carries the objection, so a file on its third loop reads as a
file on its third loop rather than as a file nobody has started.

**The ending is the last step, not the absence of gaps.** A journey finishes
when `HANDED_OVER` is done, whatever happened behind it. A vehicle whose plate
date the DMS never recorded is still a delivered vehicle, and a journey that
refused to finish over a missing date would describe a sale that closed in March
on somebody's queue for ever.

**Four kinds of waiting, and only two of them are work.**

| | | |
|---|---|---|
| `PERSON` | somebody here | always a queue row |
| `OUTSIDE` | the RTO, the customer, India Post | a row only once it has gone on longer than the dealership said was normal |
| `JOURNEY` | insurance, before registration can move | always — it blocks everything behind it |
| `TIME` | nothing to do until Tuesday | **never** |

That last line is the one DDMS could not previously express at all. `RTO_SILENT`
is a *state*, and nothing in the product could tell *the RTO has it and that is
normal* from *the RTO has it and has gone quiet*. Four of the 42 live journeys
are on a `TIME` wait and raise nothing.

**Nothing lives in memory, which is why the restart test is dull.** The position
is two rows in Postgres and the facts come from the mirror, so a cold read after
a restart is indistinguishable from the next scheduler pass. The verifier proves
it by reading the trace back cold and advancing again: same journey, same place,
nothing written.

**The classifier stands aside.** A registration file with a live journey gets
exactly one row and the runtime writes it. Both would put the same file on one
screen twice saying two different things — the failure the single queue was
built to end, arriving from a new direction.

| | rows for the two outlets |
|---|---|
| the classifier alone | 30 — `BLOCKED_NO_INSURANCE` 12 · `RC_IN_DRAWER` 8 · `RTO_SILENT` 6 · `HSRP_PENDING` 2 · `OBJECTION` 1 · `TAX_HELD` 1 |
| the runtime | **38** — `INSURED` 11 · `HANDED_OVER` 9 · `ALLOTTED` 6 · `LODGED` 3 · `RC_ISSUED` 3 · `HSRP` 2 · `INVOICED` 2 · `DOCUMENTS` 1 · `ROAD_TAX` 1 |

**Five of the eight extra rows are work the product has never shown anybody.**
Three files are ready to lodge and nobody has lodged them; two have a registration
file open against a deal carrying no invoice. The classifier has `AWAITING_DOCS`
for the step before and `RTO_SILENT` for the step after, and no state for the gap
between them. The other three come from splitting one `RTO_SILENT` into two
different waits on two different parties — *lodged and nothing back* and
*registered and the certificate has not turned up*.

**Severity is still the dealership's.** Each step borrows a
`SEVERITY.REGISTRATION.*` key rather than inventing a `SEVERITY.JOURNEY.*` group,
so a dealership that decided a stuck RC outranks a quiet RTO decided it once, for
the whole product.

**Proved by `pnpm run verify:journey`**, in two halves that need two different
kinds of proof:

```
day  0  start  INSURED      JOURNEY the insurance desk
day  2  ▶      DOCUMENTS    OUTSIDE the customer
day  4  ▶      ROAD_TAX     PERSON  accounts
day  5  ▶      LODGED       PERSON  the RTO agent
day  6  ▶      ALLOTTED     TIME    the RTO
day  9  ◀ BACK DOCUMENTS    PERSON  the RTO agent
            reason: Address proof does not match the KYC document
day 11  ▶      ALLOTTED     TIME    the RTO
day 23  ▶      HSRP         PERSON  the workshop
day 24  ▶      RC_ISSUED    TIME    the RTO and India Post
day 27  ▶      HANDED_OVER  PERSON  whoever rings customers
day 29  ▶      FINISHED
```

A month with **no database anywhere near it** — the position is a pure function
of facts, which is what makes a simulated month possible and the durable half
almost trivial. The second half runs on `ddms_worker`, walks the real
`REG-0417-3304` through the two successive states of the world the RTO put it in,
and ends where OBJ-22 ended: the worker may advance a journey and may neither
delete nor rewrite an arrival, because the newest arrival **is** the position.

> **Absence of evidence is not evidence of absence, and it cost nine false rows.**
> The first version read `INVOICED.done` as `Boolean(invoiceNo)`. Nine
> registration files in the seeded dealership name a deal the deal mirror does
> not hold, so the join returned nothing and the runtime concluded the invoice
> had never been raised — telling somebody to invoice a vehicle that was already
> registered. **A registration file only exists because the sale was invoiced**,
> so an absent deal means the step happened somewhere we cannot see. A deal we
> *can* see with no invoice number on it is real work and stays.

> **Silence is not a departure**, and this is the same rule the login check keeps
> about an absent employee row. A subject missing from the fact-set means the
> walk has nothing to say about it on this pass — not that the file is gone. A
> file the DMS stopped returning is still in the mirror with `disappearedAt` set,
> and that is the only thing that abandons a journey. Getting this wrong
> abandoned 41 live journeys in one pass.

> **One step can be two degrees of urgent.** `severityState` was a constant and
> quietly demoted every objected file from the dealership's 3 to its 2:
> `DOCUMENTS` is *waiting on the customer* most of the time and *the RTO rejected
> this* after a loop. It is a function of the facts now.

**`GET /dms/records/{module}/{recordKey}/journey`, and no write route.** A
journey moves because the world changed, not because somebody pressed a button
on it; an endpoint that let a caller set a position would be a second way for the
record to become untrue. The position and the wait are derived on read like
reconciliation — only the arrivals come out of the database, because history does
not go stale. 404 on a record with no journey is an answer rather than a failure.

**R-81 is respected and not yet tested.** The runtime writes `journeys` and
`journey_steps` and nothing else — no decision field, nothing on the mirror. The
one door is not exercised until something in a journey needs a record changed,
which is **OBJ-25**.

> **The address seam is still open.** Anirban's correction moved the dealer's
> controllable duty to *the communication address being right at the point of
> lodging*, and the journey names `RC_ISSUED` as an `OUTSIDE` wait on India Post
> accordingly. But the comparison itself is not built: three addresses exist —
> the deal, the KYC document, the registration file — and the mirror carries none
> of them on the registration row. A step for it needs data OBJ-24 brings.

### OBJ-24 — Ingestion beyond the API  ✅ **done 10 Aug**
*Covers R-84, R-85, R-86. No dependencies.*

Report drop and document scan alongside direct fetch, enabled per data type per
dealer. The reframing that matters: the dealers with no API are the majority and
the most underserved, and a sub-dealer doing five units a month in Tripura feels
the pain more than a group doing eighty.

The report path graduates — a model maps unfamiliar column headings once, a
person confirms once, extraction is deterministic thereafter. Model cost is per
report type per dealer, not per row.

This is what VeloDocs becomes: the generic *unstructured source to our schema,
with a human confidence gate* pipeline, with DMS ingestion as its second
consumer after insurance.

**Done when:** the same dealership can be onboarded three ways, every field
carries its source and confidence, a second file of the same report type needs
no model call, and nothing downstream can tell which path a value arrived by.

**The seam is a source, not a format**, and getting that right is most of the
objective. A source answers two questions:

| | `list()` — cheap | `load(keys)` — expensive | complete? |
|---|---|---|---|
| API | the summary endpoint | one call per deal | yes |
| REPORT | the file, parsed once | rows already in hand | as complete as the export |
| DOCUMENT | scans waiting to be read | one at a time | **no** |

The split preserves the one optimisation the API path cannot lose — on a busy
dealership most rows are untouched most of the time, and syncing without it is
four hundred round trips against an ERP that returns 503 at month end. Every
path fits the shape honestly, which is the test of whether an abstraction is the
right one rather than merely a tidy one.

**`sync.ts` no longer knows where its data comes from.** One line resolves a
source and nothing below it branches on the path. `projectDeal` became
`columnsOf` and moved into the ingestion layer — the canonical flat shape was
always there, unnamed, and naming it is what made three paths possible.

**Two things the source is asked rather than assumed, and both would have been
serious bugs.** `listIsComplete` — a scanned invoice says nothing about the
other four hundred deals, so treating *not listed* as *gone* would disappear a
dealership's whole book the first time somebody scanned a sheet of paper. And
partial records merge rather than replace: an absent field on a document means
*the document did not say*, never *the value is gone*.

**The graduation, which is OBJ-26's shape arriving early:**

```
propose   a model reads the headings          once per export shape
confirm   a person says yes                   once per export shape
apply     column position, no model at all    every file thereafter
```

Keyed on a hash of the sorted headings, so the same *shape* matches whatever the
file is called. Adding a column produces a new fingerprint and one more
confirmation — correct rather than annoying, because quietly reusing yesterday's
mapping across a changed export is how a column shifts one place and a month of
figures lands under the wrong heading.

**The model sees headings only.** Never a cell, never a customer's name, never a
figure — so it cannot invent a value, because it is never shown one. The worst
it can do is misname a column, which is exactly the mistake a person catches at
a glance. Its proposals are then checked against the file the way `checkRewrite`
checks a draft: a named column that is not in the headings is discarded, and its
confidence is capped at 0.8 so the confirmation screen can sort a good guess
below a name match.

**A first pass with no model at all** places most headings on a normalised
string match. The seeded dealership's own export matched **16 of 16** and never
called anything — running a model over a file the product can already read is
paying for nothing.

**Proved by `pnpm run verify:ingest`**, which generates the export **from the
mirror itself** — which is exactly what the dealer's system would produce — and
then compares, field by field:

| | |
|---|---|
| an unseen shape | **held**, 0 of 79 rows extracted, mapping proposed |
| a person confirms | the held file comes in, 78 of 79 rows |
| the same shape again | `usedModel: false`, straight through |
| a shape name-matching cannot read | proposed once; the second lookup calls nothing |
| the scheduler proposing one | **refused** — `ddms_worker` has no insert on mappings |
| the same file twice | 409, one drop |
| **every projected column of all 78 deals** | **identical to what the API left there** |
| a scanned invoice | policy and registration it never mentioned both survive |
| the whole book after that scan | still there — nothing disappeared |

> **A key alone does not make a record, and a footer became a deal.** Every
> dealer export ends `Total,,,,,,78 deals,,,` and the word *Total* lands in the
> deal-number column. The first version checked only that a key was present, so
> the footer arrived in the mirror as a deal called **Total** with an
> ex-showroom price of 78 — a phantom row on the worklist, in the queue, and in
> the count an owner reads. The test is now *the key plus at least two other
> fields*, which separates a deal from a footer without guessing at the word
> "Total" in whatever abbreviation this dealer's system uses.

> **The scheduler was refused an insert, and the refusal was the design.** The
> first verifier ran the whole thing as `ddms_worker` and died at
> `permission denied for table ingest_mappings`. A mapping is what a *person*
> said the columns mean; an unattended process able to propose **and then use**
> its own proposal would have quietly removed the person from the only step
> where R-49 applies to onboarding. `ddms_worker` holds select and update and
> not insert, and that became check 3b.

> **A verifier that only tidies up on the happy path starts lying.** A run died
> mid-way with the mock DMS down and left the dealership fed by report; the next
> run's first assertion then failed for a reason unconnected to the code. It now
> restores the API path at the *start* as well as the end, and two consecutive
> runs both exit 0.

> **The model path itself was not exercised end to end.** The free tier returned
> **429 — quota exhausted**, exactly as it did during OBJ-16's explain panel. So
> what ran was the fallback: name matches stand alone, the gaps are visible on
> the confirmation screen, and a person maps them by hand once. That is the more
> important half and the one that had to hold — but *a model successfully
> reading an opaque heading* remains attested by design rather than by this run.

**Three tables and three columns.** `ingest_sources` (per outlet, per data
type), `ingest_mappings` (the graduation), `ingest_batches` (which drop a figure
came from — the question a live integration never has to answer). On
`dms_deals`: `ingest_path`, `field_confidence` and `ingest_batch_id`, **beside**
the projected columns and never inside them, because the worklist reads
`invoiceNo` and not `invoiceNo.value`. The confidence map is sparse on purpose —
an API field is certain, and a megabyte of 1.0s asserts nothing.

**VeloDocs gained the tab, beside the API pull rather than beneath it.** A tab
order that treated the report path as the fallback would be the product agreeing
with the assumption it exists to correct. The confirmation screen shows every
field, which column was proposed for it, and whether that was a name match or a
model reading — and a person's own choice is recorded at certainty, because they
are looking at the file.

> **Scope, stated plainly.** Three paths are wired for **deals**. The other six
> modules still call the client directly and resolve to `API`, which is what
> they always did. Widening is a source function each, not a redesign — the
> vocabulary, the mapping graduation, the batches and the provenance columns are
> all data-type agnostic already.

> **The file bodies live in memory, and that is a real gap.** There is no object
> storage wired up, so a restart loses the bytes of a held drop and the dealer
> drops the file again. `ingest_batches` keeps the audit trail either way, which
> is the part that must not be lost. What had to be built here is *whether three
> paths can produce one record*; a bucket is plumbing that answers nothing.

### OBJ-25 — The invoice DDMS produces  ✅ **done 10 Aug**
*Covers R-87, R-88, R-89, R-90. Needs 22, 23, 24.*

DDMS's document is the DMS's facts **plus the commercial agreement**, and
neither system holds both. The dealer may sell at an older list, discount
ageing stock, or retain the OEM's scheme rather than pass it on — all three are
his decision and the product's job is to support them, not to have an opinion.

Which system holds the tax-invoice series is a per-dealer setting, because only
one may (R-90). The document must say what it is (R-89).

The readiness gate produces **the first queue row that is an opportunity rather
than a problem** — *everything is in place, the invoice can be generated* — and
that is the automation. Invoices are not late because typing is hard.

**Done when:** a dealer prices an invoice from a list that is no longer current
and the document says so, the OEM claim is raised for the full scheme amount
regardless of what was passed on, and the readiness row appears the moment the
last condition is satisfied rather than when somebody opens a screen.

**Three tables.** `price_lists` and `price_list_items` keep the history the DMS
discards — a current-state system holds today's price and forgets yesterday's,
which is fine until a dealer lawfully sells at an older rate. `sale_documents`
is the document itself, and `kind` on it is load-bearing rather than
descriptive.

**The tax rates are per model, not a setting.** HSN, GST and cess live on the
price-list item because a motorcycle above 350cc attracts a cess the one below
it does not. One rate in a policy registry would have been tidier and wrong for
half the range.

> **Only one system may hold the series, and which one is a switch.**

`SWITCH.DDMS_HOLDS_TAX_SERIES`, **off by default**, and the default is the safe
direction. Off, DDMS issues a `SALE_CONFIRMATION` that carries the DMS's invoice
number for linkage and says on its face that it is not a tax invoice. On, a
`TAX_INVOICE` with a number from its own sequential series. Same generator, one
flag — and the second is not a lesser feature: a dealer whose DMS numbers his
invoices still wants DDMS's document, because DDMS's is the one with the
commercial agreement on it.

The series number is taken inside the insert, the financial year is April to
March because Indian series restart with it, and a unique index on
`(ownerId, taxInvoiceNo)` is the backstop that must never fire.

**The discount is split by who is paying for it** (R-88), and the two halves
answer different questions:

| | |
|---|---|
| `dealerDiscount` | his own margin, given away |
| `oemSchemeAmount` | the manufacturer's, **claimable in full whatever happened next** |
| `oemSchemePassedOn` | how much of it reached the customer. May be zero |

The taxable value falls by what the customer was actually given. The scheme the
dealer kept never reaches that line, because the customer never got it — and
`oemSchemeAmount` stays at full value on the row, because **the claim is owed on
the scheme rather than on the part of it that was passed on.** An unclaimed
scheme is money given away twice, and `GET /dms/invoice/claims` is the number
nobody previously had: it lives in two places at once and only DDMS's document
holds both.

**A second journey, and the runtime did not change to accept it.** `VEHICLE_SALE`
— booked → allocated → priceable → **invoiced** → delivered, on the `DEAL`
module. That was the test OBJ-23 set for itself without saying so: a journey
model is a model if the second journey costs a file and a special case if it
costs a refactor. What moved was `loadFacts` onto the definition and
`severityState` onto `Step`; the walk, the loop detection and the queue
projection are untouched. Where it finishes, `VEHICLE_DELIVERY` begins — and
that journey's `INSURED` step already knew how to say *waiting on another
process*.

It also closes the funnel Anirban said was missing: *lead → pre-sales → sale →
booking → finance → invoice*. This is its second half.

**`PRICEABLE` is a stall nothing in the product could previously describe.** Not
*the customer has not paid* and not *the RTO is slow*: **we cannot invoice this
because nobody has told us what the model costs.** An onboarding gap, invisible
until something tries to price a sale — which is what a journey does and a
classifier never did.

**The opportunity.** `Wait` gained `tone`, and `INVOICED` is the first row in
this product's history that is not something going wrong. It does **not** change
the sort: an opportunity competes on the same three keys, because a dealership
that always did the pleasant rows first would have a growing pile of the others.

**Proved by `pnpm run verify:invoice`** — ten sections, and then driven through
HTTP because the library passing is not the same as the product working:

| | |
|---|---|
| priced off July when August is current | `pricedOffCurrentList: N`, and the warning names the current price |
| the tax split | CGST and SGST are halves of one whole, to the paisa |
| scheme ₹5,000, none passed on | ₹5,000 claimable, taxable value down only by the ₹2,000 he actually gave |
| series off | `SALE_CONFIRMATION`, carrying the DMS's number, titled as not a tax invoice |
| series on | `INV/2627/00001` |
| a second sale on one deal | refused |
| a quotation on the same deal | allowed |
| cancelling | needs a reason; the row stays and the number stays spent |
| the agent | **refused**, by the same table that refuses a technician |
| the runtime | 79 sale journeys, 5 opportunities, at position 72 of 286 on the one queue |

> **The bug the API found that the library did not.** The existence check said
> *only a sale may already exist* in its comment and filtered on status alone in
> its query — so a salesman quoting a customer in the morning made the deal
> un-invoiceable for the rest of the day. Found by quoting and then invoicing
> through the routes. **Driving the library is not driving the product.**

> **A refusal named the wrong reason, and the code had predicted it.** `whyNot`
> returned the `policy.set` sentence for every permission belonging to no
> module, with a comment saying that was the only one. This objective added
> three more, so a service advisor asking to read an invoice was told they may
> not set the dealership's thresholds — true of them, and not what they asked.
> Exactly the defect OBJ-21 fixed on `POST /dms/actions`, arriving from the
> other side: **defence in depth working is not the same as the application
> being honest.**

> **A correlated subquery silently returned 1.** The price-list screen's model
> count, written through the ORM's SQL template, reported one model for a list
> holding six — not an error, not an empty result, a plausible wrong number. It
> is a join and a `group by` now, and the count each list reports is checked
> against the count it holds. Caught only because the seeded data is a shape
> somebody knows.

> **A vehicle delivered with no invoice is not an opportunity.** Same step, same
> missing document, opposite reading: *here is money you can collect* against
> *you have handed over a vehicle you never billed for*. A row calling the
> second one an opportunity would be the product being cheerful about an
> accounting hole.

**`pnpm run db:seed-pricelists`** builds two lists from the mirror — July, and
an August one four per cent higher — because the interesting case needs a
superseded list to exist.

> **The scope that was left.** Place of supply defaults to the outlet's own
> state, because the deal mirror carries no customer address; the field is an
> input rather than an assumption and the document records the answer, so
> inter-state is reachable the moment the address is. E-invoicing (IRP
> registration above the threshold) is not built. And the readiness row appears
> on the **next scheduler pass** rather than instantaneously — which is what
> *rather than when somebody opens a screen* actually buys: a timestamped record
> that the deal became ready, written with nobody signed in.

### OBJ-26 — Autonomy: the ladder and graduation  ✅ **done 11 Aug**
*Covers R-79, R-80, and R-66 to R-71. Absorbs OBJ-19. Needs 21 and 23.*

Watching, then recall, then pre-filled, then consent. Per pattern, with
demotion, and the threshold owned by the dealership.

Needs 23 because precedent needs journeys that have actually run: a ladder with
no history to cite is a dial with extra steps.

R-69 does not bend. Precedent still authorises nothing — it is the evidence a
person consents on, and the consent authorises. Below the consent step the model
**recalls** rather than judges, which is what carries R-49 up the whole ladder.

**Done when:** a pattern is cited with its count and date, accepting it ten
times produces a consent request rather than an automatic promotion, rejecting
it demotes, and no amount of precedent moves anything past the floor.

#### What it turned out to be  ✅ **done 11 Aug**

Two files of judgement, one ledger, two tables and ten verified sections.

**The pattern is `MODULE:STATE:ACTION`, and recovering the state was the
interesting part.** `decision_log` records what was decided and not what the
record's derived state was at the time — correctly, it is a log of decisions
rather than of situations. So `precedent.ts` joins to `record_events` for the
newest event **at or before the moment of the decision**: the state the person
was actually looking at. Reading the record's *current* state instead would
have been the sharper mistake, re-filing every past decision under whatever
happened to the record afterwards, so a habit would silently change shape as
records moved on.

**Rungs 0 to 2 are derived; only rung 3 is stored.** Nothing persists a rung, so
a habit the dealership drops takes its rung with it and demotion needs no
scheduled job to notice — R-71 for free rather than as a feature. Rung 3 needs a
row with somebody's name on it, because letting an unattended process act is a
decision rather than an observation.

> **Consent raises the ceiling. Evidence sets what has been earned. Both have to
> hold.**

That one sentence is what makes it a ladder rather than a ratchet. A consent
standing while acceptance falls does not keep a pattern automatic: the earned
rung drops and the pattern drops with it, the consent row untouched and still
true, and recovery needs nobody to remember to re-grant anything.

**The floor is `may("AGENT", …)`, not a second list.** The same table that
answers for a service advisor, with `whyNot()` supplying the sentence — so it
cannot drift out of step with the permission table, and R-80 is one line rather
than a policy. Eight of the twelve registry actions assert that a *person* did
something, so those patterns climb to **pre-filled and stop**: pre-filling is
the product offering a default somebody presses, automatic is the product
asserting the phone call happened.

**`agent_proposals` is the substrate, and the agent writes only half of it.**
`record()` writes what was offered; **nothing writes an acceptance**.
`resolveProposals` reads `decision_log` — which only `applyAction` appends to —
and works out what happened by comparing what a person did against what was on
offer. The agent therefore cannot mark its own proposal accepted, which is the
single property that stops the ladder being climbable from inside. OBJ-22's rule
arriving where it matters most.

**`EXPIRED` counts neither way.** A queue nobody had time to reach is not a
rejection, and dividing by everything offered would demote the agent for the
dealership being short-staffed — the exact circumstance this product exists to
be sympathetic about.

**`AGENT.ASSIGN_ORPHANS` narrowed, and it is worth saying out loud.** It used to
mean *act on everything in the Nobody's band*. It now means *anything may run
unattended at all*, and the pattern's rung decides which. A dealership that
switches the agent on with no history gets suggestions rather than actions,
which is a strict narrowing of an existing behaviour and the safer direction of
the two. The loop closes through people: acceptances at rungs 1 and 2 are what
earn rung 3, and every one of them is somebody clicking.

> **The verifier tried to grant consent as the scheduler, and the grant refused
> it.** `permission denied for table autonomy_consents` — `ddms_worker` holds
> select and no insert, because an unattended process that could grant itself
> standing permission to act unattended is the whole failure the ladder exists
> to prevent. Second time the credential design has caught a test: OBJ-24's was
> the same shape on `ingest_mappings`. The accident became check 6.

> **A crashed run has to be cleanable by the next one.** This verifier writes
> real decisions onto real mirror rows, because a ladder proved against fixture
> rows would not have been proved. The first version tidied from an in-memory
> list, a run threw halfway, and the next run counted 24 decisions where its
> section had made six — three checks failing for a reason that had nothing to
> do with the ladder. The marker is in the data now. Same lesson as OBJ-24's
> non-self-healing ingest verifier.

> **A rung the product cannot honour is worse than no rung.** `MESSAGE_EDITED`
> is in the decision log and a dealership that edits a lot of drafts genuinely
> has a habit — but there is no button to pre-fill and nothing for an unattended
> pass to press. Its ceiling was `PREFILLED`, which would have had the product
> reporting a rung it had reached while nothing on any screen ever changed. Now
> `RECALL`: it may say what happened, and there is nothing further to do.

### OBJ-27 — dm-concierge: messages out, replies in
*Covers R-91 in part. Needs 22.*

The Outbox has drafted messages since OBJ-16 and delivered **nothing** —
`TRANSPORTS` is empty and every authorised message ends `HELD_NO_TRANSPORT`.
dm-concierge is the transport.

Inbound is the larger half. A customer replying *"I will come Saturday"* is a
fact the dealer's system will never hold, and it is ours the moment it arrives —
a record DDMS owns outright, so an agent may act on it.

The boundary is unchanged: dm-concierge is the pipe, `authoriseSend()` remains
the gate, and nothing unauthorised reaches the pipe.

**Done when:** an approved message actually arrives on a phone, a reply becomes
a DDMS record, and a reply clears the queue item that prompted it.

### OBJ-28 — The trace and the stand-down
*Covers R-92, R-93, R-94. Needs 23 and 26.*

Three things, all about being able to supervise what is running.

`decision_log` answers *what happened to this record*. A run is a **narrative
across records and agents**, and nothing can show it as one thing. Cost is
unmetered — wrrk quotes $0.01 to $0.05 a run and caps at 50 per org per day
**[Documented]**; DDMS counts nothing. And the agent cannot stand down: when its
proposals are being rejected it goes on proposing.

**Done when:** one screen shows a run as a story, a daily cap stops the
twenty-first run of an hour, and an agent whose rejection rate crosses the
dealership's threshold pauses itself and says so.

### OBJ-29 — More agents
*Needs everything above.*

Last, and most people would do it first. Section 3b's research found the failure
mode is never bad agents — it is ungoverned accumulation, eighty flows on one
object, *"a graveyard of decisions nobody documented and behaviours nobody can
predict"*. N agents that can trigger one another reach that faster.

By this point there is a model that admits new principals, a ladder to place
them on, records they may legitimately write, and a trace to watch them in.
Before it, every new agent is one more thing nobody can govern.

**Done when:** a second agent is added by declaring a principal and a set of
permissions, and nothing else changes.

### Held, and why

- **The QM harness itself.** Right stack, useful patterns, and it models no
  journeys — it would give agents a safe place to run and would not know what a
  registration file is. Revisit if agents ever need their own per-employee
  credentials and files.
- **Neo4j.** Not refused, sequenced. Behind the four-question interface, adopted
  when a question needs paths rather than filters.
- **WhatsApp message content and templates.** Parked at Anirban's instruction.
- **Auto-reassignment.** Off, pending a customer conversation.
- **Roles and visibility in detail.** Deliberately deferred — R-81 is what makes
  deferring safe.
- **OBJ-19 as a separate objective.** Absorbed into 26.

---

## 4. Where things actually stand

**Built and verified:** owner tier; the read-only mirror across seven modules
(deals, job cards, enquiries, registration files, parts, receivables, vehicle
stock); reconciliation on deals; derived state on all seven; insurer panel with quota; scheduled sync; API
authentication; per-user sign-in; row-level security on the DDMS request path;
the one-application-per-deal constraint; DDMS as its own service.

**The dual role has started.** The first action button works end to end: a deal
with no insurance goes from a row on a screen to an application in the database
in one click, and the row changes state behind you. The other actions on the
three screens are still sentences, because they still need a person — and
dressing those as buttons would be the same defect as a simulated policy that
looks issued.

**And it can be asked why.** A panel on every worklist row answers the three
questions the row cannot — why it is stuck, who else it touches, what happens if
it waits — by reading six typed tools over the mirrors and the entity graph, and
it shows the rows it read underneath the answer. A model words the summary and
decides nothing; the findings beneath it are assembled by rules and stand on
their own when there is no model to be had.

**And it has started to speak.** Every screen now drafts the message its rows
have been describing in words for three sessions, and one gate decides whether
any of it may leave: a rule for internal email to the person a record is
assigned to, a person for everything else, and nothing at all without one of the
two. Nothing has actually been delivered, because there is no email or WhatsApp
account connected — and the outbox says so on every row rather than implying a
delivery it cannot perform.

**Section 3b closed that gap, and this paragraph used to say it was open.**
What it said was: nothing happens unless somebody is looking, every mechanism is
*pull*, there are no events, no queue, no people inside a dealership and no rule
that runs on its own. All six of those are now built — the mirror emits events,
staff have their own logins, one queue spans seven modules, five rules run
unattended, the dealership owns its numbers, and an agent operates two of the
twelve registry actions. Six of §3b's seven are done; OBJ-19 was deferred by
decision and is absorbed into §3c's OBJ-26.

**Section 3c closed that one too.** It said DDMS understood a *record* and
had never understood a *journey* — that a vehicle sold was one thing moving
through the building shown as ten unrelated rows on four screens, and that
nothing could wait. The journey model, its four kinds of waiting, the invoice
the product issues and the ladder it earns autonomy on are all built.

**What it cannot do yet, as of 12 August.** It could not *deliver* — every
message it composed stopped at the outbox — and OBJ-27 closed that: the
transports are built and a dealership connects its own account. What remains
outside the software is the account itself. It cannot be *watched* — there
is a decision log per record and no trace across a run, and nothing meters what
an agent costs (OBJ-28). It could not answer *how is the business doing*
without somebody opening seven screens and adding up, and that one is now
built — OBJ-35, on 12 August, blocked on nothing and therefore done first.

**The blocker before a customer is gone.** Sign-in exists in all three
products, the database enforces the boundary rather than trusting the code to,
and since OBJ-8 the server holds no credential that could bypass it — it refuses
to start with one. What is left is not a safety question any more.

**Thirteen verifiers, and each states a claim it could fail.** Permissions,
records, agent, agents, journey, ingest, invoice, autonomy, overview, channels,
trace, ledger and `typecheck`.
The rule they are held to was learnt the expensive way in OBJ-30: *a verifier
that can fail for a reason it does not name will one day pass for a reason it
does not name.*

---

## 5. Explicit non-goals

Written down so they stop being re-litigated.

- Not writing back to the OEM's DMS.
- Not a remote-desktop or screen-scraping integration.
- Not reducing dealership headcount, and no wording that implies it.
- Not replacing the OEM's DMS.
- Not multi-OEM before one OEM works end to end.
- Not extracting a shared UI package until a third consumer needs it.
- Not hosting ERPNext. A feeder posts to whatever the dealership already keeps.
- Not a second web framework in this monorepo.

## 3d. The standalone invoice generator, and the ledger beneath it

Anirban worked a parallel design with Gemini for a TVS sub-dealer: watch a
folder, read the DMS invoice with a model, post double-entry journals to
ERPNext, generate a branded PDF, send it on WhatsApp, and pitch it as *replace
Tally*. He asked for it to be analysed against what exists and attached the way
InsurRouter and VeloDocs are — **a fourth product, standalone, sharing the
database**. **Nothing in this section is built.**

### Most of that plan already exists here, and is further along

| The plan's layer | What DDMS has | |
|---|---|---|
| Watch a folder / Drive / upload | **OBJ-24** — three ingestion paths, per data type per dealer, content-hash dedup, held batches | built, and more general |
| Model reads the PDF | **VeloDocs** `ocr-engines.ts` — five engines, fallback chain, per-field confidence | built |
| Model reads the columns | **OBJ-24** mapping — proposed once, confirmed once, deterministic thereafter | built, **and cheaper**: the plan pays a model per document for ever |
| Which fields to believe | **R-85** — `ingestPath`, `fieldConfidence`, `ingestBatchId` on the row | built; the plan has no notion of it |
| Produce the invoice | **OBJ-25** — price lists with history, discount composition, GST split, series ownership, R-89 | built, and considerably deeper |
| Send it on WhatsApp | **OBJ-27** — `authoriseSend()` exists; `TRANSPORTS` is empty | half: the gate is built, the pipe is not |
| **Double-entry journals** | — | **not built** |
| **Chart of accounts, ledger** | — | **not built** |
| **The CA's return file** | — | **not built** |

Rebuilding the top half as a separate FastAPI service would produce two systems
that disagree about what a sale is — the failure this product exists to fix,
reintroduced from inside. The bottom half is a genuine gap and it is the half
the *replace Tally* pitch actually rests on.

### The sharpest thing in that conversation

> **The dealer pays for Tally because the CA needs it**, for GSTR-1, GSTR-3B and
> the audit. Replace Tally and the CA has to be kept whole, or the dealer says
> no.

Which reframes the deliverable. **It is not a ledger. It is the file the CA
files.** A perfect double-entry ledger that produces nothing a chartered
accountant can lodge has not replaced anything — it has added a system. This is
the same shape as the RC correction: the dealer's controllable duty was not the
certificate, it was the address at lodging.

### Four things in the plan that would not survive contact

**The journal does not balance and does not relieve stock.** The sample debits
Bank for the whole invoice and credits revenue plus the two GST heads. A real
two-wheeler sale is a booking advance, a financier's disbursement and a cash
balance — three debits, not one — and the RTO fee and insurance premium the
plan's own table calls liabilities never appear in its code. Worse, nothing
credits inventory or debits cost of sales, so the P&L would show the whole
ex-showroom price as margin. A dealership's gross profit on a bike is a few
thousand rupees; that ledger would report sixty.

**A model's read would go straight into a statutory return.** The plan parses
with an LLM and posts, with no human gate anywhere. VeloDocs already has the
answer — anything under 0.7 confidence is highlighted for a person before it
moves — and OBJ-24 has the other half in confirm-once. A figure that reaches
GSTR-1 must have been confirmed by a person or returned by an API. A model's
read is a **proposal**.

**"Replace Tally" is the wrong first sale, and the arithmetic is shaky.** The
₹22,000 in that conversation was quoted as the **DMS** base cost and then reused
in the pitch as Tally's price; the two are different numbers and the second one
should be checked before it goes in front of a dealer. More importantly, if our
ledger is the book of record and it is wrong, the dealer's filing is wrong and
that is *their* liability. Sell the data-entry saving first, be a **feeder**
into whatever they already keep, and become the book of record once the numbers
have reconciled for a few months. That is OBJ-26's ladder applied to a product
decision rather than to a pattern.

**Python-first, Composio only where it earns it** is right and is already our
rule in a different accent. R-81's one door says nothing writes to the record
except through the call a person's button makes — a third-party tool runner is
exactly the second way in that rule refuses. Composio at the edges (WhatsApp,
Drive), never between the parser and the ledger.

### The gap it exposed in what we built

`generateDocument` reads `dms_deals` and returns **404** when the deal is not
there. So OBJ-25's invoice generator cannot serve the dealer it was written for:
the sub-dealer in Tripura doing five units a month has no DMS, no mirror, and no
deal row. The generator is coupled to the very thing that customer does not
have.

That is the single change which makes the product standalone, and it is small:
the facts may come from a mirror row, a scanned document, or a form somebody
filled in — and the pricing, the discount composition, the tax split and the
series logic do not care which.

### How it attaches

A fourth artifact beside InsurRouter and VeloDocs, sharing `lib/db`:

```
the sub-dealer with nothing          the dealer with a DMS
  form / scanned invoice               dms_deals (mirror)
            \                                /
             \______ generateDocument ______/        OBJ-25, decoupled
                          |
                    sale_documents                   already exists
                          |
                    posting rules                    NEW — deterministic
                          |
              accounts · vouchers · lines            NEW
                       /        \
              GSTR-1 / CSV      Tally / ERPNext      NEW — the CA's file
                                                          and the feeder
```

**The ledger's input is a `sale_document`, not a PDF.** That is the whole
integration. DDMS already produces the invoice; the ledger posts what DDMS
issued. The PDF path is only for a dealership whose invoices never pass through
DDMS at all — and OBJ-24's `DOCUMENT` path already reads those.

### New requirements

| # | Requirement | Status |
|---|---|---|
| R-96 | **The invoice generator must work without a mirror.** A dealer with no DMS is the customer it exists for, and requiring a mirrored deal row excludes exactly him. Facts may come from a mirror, a scan or a form; nothing downstream of the facts may know which | ✅ OBJ-30. `SaleFacts` from a mirrored deal or a typed form; the same sale issued both ways produces identical money in all thirteen columns |
| R-97 | **A figure that reaches a statutory return was confirmed by a person or returned by an API.** A model's read is a proposal. This is R-49 applied where being wrong is a filing offence rather than a bad morning | ✅ OBJ-30. `doubtful()` refuses a tax invoice or sale confirmation carrying a sub-0.7 model read, and warns on a quotation — the gate is on the consequence, not on the provenance |
| R-98 | **The ledger is a feeder before it is a book of record.** It produces vouchers for whatever the dealership already keeps, and becomes the record only once its numbers have reconciled against that system for an agreed period. Graduation, applied to a product decision | ✅ OBJ-33. Vouchers into Tally in their own chart's names, and the screen says *feeder, not your book of record* in those words. `ddms_worker` holds select and nothing else |
| R-99 | **The deliverable is the file the CA files.** A ledger that produces nothing lodgeable has added a system rather than replaced one | ✅ OBJ-32. GSTR-1 as B2B, B2CS and HSN with the portal's own column headings, and `problems` alongside the result rather than instead of it |
| R-100 | **Accounting arithmetic is deterministic, tested, and has no model anywhere near it.** R-78 restated where the consequence is statutory | ✅ OBJ-31. Every branch in `post.ts` is a comparison or a table lookup. `verify:ledger` compares each figure against the document rather than against another number the same code produced |
| R-101 | **A voucher names the document it came from, and one document posts once.** Re-posting a corrected invoice reverses and re-issues; it never edits a posted voucher | ✅ OBJ-31. A partial unique index, so a concurrent retry loses at the database. Correction reverses and re-issues; nothing edits a posted voucher |
| R-102 | **Selling a vehicle relieves inventory.** A ledger that credits revenue and never credits stock reports the ex-showroom price as margin | ✅ OBJ-31. Matched on chassis. No match posts the revenue, refuses to invent a cost, and warns that the whole selling price reads as margin until it is relieved |
| R-103 | **Money collected on somebody else's behalf is a liability, not revenue.** Road tax, RTO fees and the insurance premium pass through the dealership; treating them as income overstates turnover and the tax on it | ✅ OBJ-31. Three named liability accounts, and an unrecognised label goes to suspense rather than income — ₹17,750 of an ₹84,000 sale, which is turnover 21% overstated if it lands the other way |

### New objectives

| # | Objective | Model? | Depends on | Why here |
|---|---|---|---|---|
| 30 | ~~**The generator without a mirror**~~ ✅ | no | 25 | one change, and it is what makes the product sellable to the dealer it was designed for |
| 31 | ~~**The ledger** — accounts, vouchers, posting rules~~ ✅ | **no** | 30 | the genuinely new half. Deterministic, tested, and the first thing in this product where being wrong is a filing offence |
| 32 | ~~**The CA's file** — GSTR-1 out, invoice-wise for B2B and aggregated for B2C~~ ✅ | no | 31 | the deliverable. Without it nothing has been replaced |
| 33 | ~~**The feeder** — vouchers into Tally or ERPNext~~ ✅ | no | 31 | R-98's first rung: be additive before asking to be trusted |

> **Sequencing against what is already queued.** OBJ-30 is an afternoon and
> unblocks the standalone pitch, so it can go whenever. OBJ-31 to 33 are a
> product of their own and should not jump ahead of **OBJ-27** — a dealership
> that cannot yet send a WhatsApp message is not ready to be sold an accounting
> replacement, and OBJ-27 is also what delivers the invoice to the customer's
> phone, which is half of what the Gemini plan was actually for.

### OBJ-30 — The generator without a mirror  ✅ **done 11 Aug**

Built. Two seams and a gate, and the generator lost its only reason to know
about the mirror.

**`SaleFacts` is *who bought what, and which vehicle*.** Two resolvers produce
one — a mirrored deal, or a form somebody typed. There is deliberately **no
third resolver for a scan**: a scanned invoice reaches the mirror through
OBJ-24's `DOCUMENT` path and is a deal row by the time anything asks to price
it, carrying its provenance beside the values (R-85). A separate scan resolver
would have been a second way into the same facts, which is the shape R-81
refuses everywhere else.

**`Priced` is *what it costs*, looked up or stated.** A dealership selling five
units a month has not built a price list, and telling it to enter its whole
range before the first invoice is how a product gets uninstalled on the first
afternoon. So the amount, HSN and rates may be typed onto one document — and
under R-97 that is a **confirmed** figure rather than a proposal, which is why
it is allowed onto a tax invoice at all. Overriding a list that *does* cover the
model is permitted and warned about, with the list's own figure in the sentence,
for the same reason `pricedOffCurrentList` exists.

**R-97 is a gate, and it is the only place in the product where provenance
blocks rather than annotates.** A field a model lifted off a scan below 0.7 is
named and refused on a tax invoice or sale confirmation, and merely warned about
on a quotation. *The gate is on the consequence, not on the provenance* — the
same 55% read is perfectly fine on a document nobody files.

`sale_documents` gained `factsOrigin`, `priceOrigin` and `customerGstin`, and
`dealerCode` became nullable. **Nothing downstream reads the first two**; they
exist so a document can say where it came from.

> **A nullable key breaks an equality check silently.** The *sold this twice*
> check matched on `dealer_code = $1`, which no row with a null dealer code ever
> satisfies. A sub-dealer's documents would never have collided with each other
> and the same frame could have been invoiced twice — with the check appearing
> to run, and returning nothing, every time. `isNull` on that branch.

> **The verifier failed for a reason it did not name.** Section 11 filtered on
> `HERO-SARASWATI-01`, a plausible dealer code that is not this dealership's,
> and reported *none priceable* — which reads as a finding about price lists.
> A verifier that can fail for a reason it does not name will one day pass for a
> reason it does not name. The dealer code now comes off the row.

The proof is the claim stated so it can fail: **the same sale, issued twice,
once from a mirrored deal and once from a form, produces the same money.** All
thirteen money and tax columns compared, identical; the only fields that differ
are the three that should.

> **What is deliberately not adopted.** ERPNext as the backend: it is a second
> system of record with its own chart of accounts, and R-98's feeder can post to
> it over its REST API without us hosting it. A separate FastAPI service: it
> would duplicate OBJ-24 and OBJ-25 and give two answers about one sale. A
> Next.js dashboard: DDMS is React and Vite and there is no reason for a second
> framework in one monorepo.

## 3e. Reconciled 12 August — the register against what was built

Three sessions of work landed with no objective attached to it, two finished
objectives were never marked, seven rows carried a ✅ in their text and a ○ in
their status column, and four things Anirban has asked for had nowhere in this
file to live. None of that changed the product; all of it made the register
lie about the product, which is worse, because the register is what the next
plan is built from.

This section is the reconciliation. The corrections were made in place —
sections 2, 3c and 3d now read true — and what follows is only the part that
needed new numbers.

### What was built and never registered

| commit | what it was | why it had no number |
|---|---|---|
| `15189f7` | the invoice you can open and print | OBJ-25 issued documents and gave nobody a way to look at one. Found by using the product, not by reading the plan |
| `c04d9f2` | the document written for the customer | a disclaimer that could be false — became **R-104** |
| `86105d0` | `sample-reports/`, eight exports per outlet | scaffolding for OBJ-24's report path; no objective owns test data |
| `0448af9` `731d845` | ingestion for all seven modules | OBJ-24 shipped the seam and one module through it. Widening it to seven is **OBJ-34** |
| `1225593` | the import screen in the trade's vocabulary | became **R-105** |

Two of those five are requirements the product now holds to, and one is an
objective. The other two were always going to be somebody's afternoon and are
fine unregistered — but they are listed, because *"the plan does not mention
it"* stopped being evidence that a thing was not built.

### New requirements

| # | Requirement | Status |
|---|---|---|
| R-104 | **A document has two readers, and only one of them may see the provenance.** The customer gets a document; we keep a copy that says where each figure came from and how sure of it we were. Printing the second is how a dealership hands a buyer a page admitting a model read 55% of it. And the halves must each be true *on their own*: a sale confirmation saying *the tax invoice number is shown above* is a lie on every copy where there is no number, and a document that can lie about itself is worse than one that says nothing | ✅ |
| R-105 | **Where the trade has a word, use the trade's word.** *Data type*, *import*, *import history*, *column mapping* — a dealership's administrator and an implementation consultant both already have vocabulary for this, and inventing friendlier terms makes the product read as though nobody who built it had done the job. Write plainly everywhere the trade has no word | ✅ |
| R-106 | **Every outside credential is the dealership's own.** The model key, the WhatsApp number, the mail account, the DMS login, the document store. DDMS holds none of them, meters none of them, and cannot spend one dealership's key on another's work. It is the honest answer to *where does our data go* and it is what makes per-run model cost somebody else's line item — but it is a constraint on the architecture before it is a pricing position, and it has to be true in the code or it must not be said | ✅ OBJ-27. `channel_credentials`, one row per (owner, channel), AES-256-GCM under a key that lives in the environment. `verify:channels` §2 serialises the whole response and fails if the token appears anywhere in it |
| R-107 | **One view answers *how is the business doing* without opening a module.** Seven screens each holding a list is the reporting product R-55 already refused; the queue fixed it for the person doing the work and left the owner with nothing. Derived on read like R-12, and every figure on it opens the rows underneath — a number you cannot walk into is a report, and R-20 says this product is not one | ✅ OBJ-35. Six bands, derived on read, and every figure carries the screen its rows are on — `verify:overview` §7 refuses a figure pointing at a screen that does not exist |
| R-108 | **What a prospect is shown first is a report about their own dealership.** Point the read-only mirror at their data and hand back what is falling through: orphaned work, money past its credit period, files the RTO has gone quiet on. It must be the *same artifact* the owner opens every morning after they buy — a diagnostic built only to sell is a brochure, and it stops being true the week after it is produced | ✅ OBJ-35. The same page, printed. `@media print` drops the chrome and the walk-in arrows and keeps the figures and the limits, so there is no second artifact to go stale |

### New objectives

| # | Objective | Model? | Depends on | Why here |
|---|---|---|---|---|
| 34 | ~~**Ingestion for all seven modules**~~ ✅ | at the mapping step only | 24 | registered after the fact. OBJ-24 proved one seam on one module; a dealership does not export only its deals |
| 35 | ~~**The overall view, and the report that sells it**~~ ✅ | no | 18, 23, 24, 26 | R-107 and R-108 are one build. It needs nothing new — it aggregates seven classifiers, the journeys, the queue bands and the ladder — and it is the second half of the one-line description of what DDMS is |

> **Why 35 goes before 27 and before the ledger.** Anirban's own sentence for
> this product is *it automates your routine tasks and gives you a dashboard
> with the overall view.* The first half has been the whole of the work since
> 3 August and the second half has never been built. It also costs the least
> per unit of value in the queue, because every figure on it already exists and
> is already permission-checked — this is a read, an assembly and a screen, not
> a new capability. OBJ-27 stays next after it, unchanged, and the §3d
> sequencing note still holds: the ledger does not jump ahead of the ability to
> send a message.

### What OBJ-34 turned out to be

The seam held. `Source<T>` was written for deals in OBJ-24 and six more modules
went through it without changing its shape — which is the only real evidence
that a seam was cut in the right place.

What did have to be generalised was everything *around* the seam. Field
definitions and column synonyms became per-data-type (`FIELDS_FOR`,
`SYNONYMS_FOR`, `vocabularyFor`), and `extract` builds its record from the
vocabulary rather than from a hard-coded deal shape. Three source shapes cover
all seven modules: the whole list in one call, a summary list with a fetch per
record, and a report the dealership dropped.

**The disappearance guard is the one thing that is not symmetric.** An API
lists the outlet's whole book on every call, so a record that stops appearing
has genuinely gone. A report covering one month says nothing about the other
eleven, and a path-blind sync that does not ask would mark a year of records
vanished because somebody dropped July's file. `source.listIsComplete` is the
question, and every one of the six syncs asks it before marking anything gone.

The proof: all seven exports from `sample-reports/` dropped through
`POST /dms/ingest/report`. **Every heading matched by name — `model: false` on
all seven.** The model exists on that path for headings nobody anticipated, and
on a dealership's own export of its own registers it was not needed once.

### What is parked, and by whose decision

**Remote-desktop access.** Anirban has said it comes later; R-44 currently
rules it out as an integration route and §5 lists it as a non-goal. Those can
both be true — *support and onboarding* is a different thing from *how the data
gets in* — but which one it is has not been settled, and the rules that follow
differ enough that guessing would be worse than waiting. **Parked by decision
on 12 August.** R-44 and the non-goal stand until it is answered.

**Insurance issuance.** Named by Anirban as a routine task on the same footing
as invoicing. Its executors are stubs, and unlike everything else in the queue
the blocker is not build time — it is an insurer credential and a contract.
Sequenced when that exists, not before.

### What OBJ-35 turned out to be

Built on 12 August. One module, one route, one screen and a verifier, and the
module is almost entirely additions — which was the argument for doing it
first and turned out to be true.

**Six bands, in the order an owner asks.** What is waiting on somebody · the
dealership's money · money held for somebody else · what time is costing · what
the DMS still believes · what the product did on its own.

The third is the one that was not in the plan. **R-103 belongs on a screen, not
only in a ledger.** Road tax collected from a customer is the RTO's money
sitting in a dealer's account, and a dashboard that folds ₹73,526 of it into the
cash position is teaching somebody to spend money that is not theirs. It has its
own band, with the sentence saying so, for that reason and no other — and OBJ-31
will need the same distinction in double entry.

**Nothing on it is derived.** Every figure is a classifier's existing answer, a
queue band, a reconciliation state, an outbox count or a rung's standing. The
one exception is a `count(*)` over `sale_documents`, written because
`listDocuments` caps at a hundred rows and a capped list silently understates a
total — a dealership past its hundredth invoice would watch the number stop
climbing with no way to tell that from a quiet month.

**The screen and the diagnostic are the same page.** No second route, no PDF
library, the same decision as the invoice: `@media print` drops the chrome and
the walk-in arrows, keeps the figures and the limits, and adds one printed line
saying what the page is. R-108 asked that the artifact handed to a prospect be
the one the owner opens every morning afterwards, and two files claiming to be
that page would have made it two artifacts within a month.

#### The finding, and it is the one worth keeping

> **A verifier that agrees with the bug is a bug with a tick beside it.**

The first `verify-overview` counted rows through the same builders `overview.ts`
calls, and the file's own comment described that as independent. It is not.
Spares, receivables and inventory each read every outlet in the group to answer
their cross-branch questions and filter back to one outlet before returning;
that filter is one line in each of three files, and losing it doubles every
money figure on the owner's screen.

Removing it from `receivables-worklist.ts` **left all twenty-two checks
passing.** The defect landed on both sides of every comparison and cancelled
itself out — the group run inflated, the per-outlet runs inflated by the same
factor, and the sum still balanced.

Two changes. Section 3 now reads `dms_vehicle_stock` in SQL with no classifier
anywhere near it — a column and a null test, which is the only comparison in the
file that shares no code with the thing it checks. And it asserts the invariant
the whole fold rests on rather than assuming it: **a builder asked for one
outlet returns that outlet's rows and no others.** The same mutation now fails
one check, by name, in one line.

Only one figure gets the SQL treatment, deliberately. Every other number here is
a classifier's answer, and reimplementing a classifier inside its own verifier
produces a second opinion that drifts and then fails for reasons that have
nothing to do with the code under test. The sections now say which of them
proves what, because the honest reach of a check is part of the check.

#### Three smaller ones

**A figure that is structurally zero reads as reassurance.** *Yours: 0* on an
owner's screen — an owner has no employee code, so nothing on the queue is ever
theirs — tells the one person looking that they are on top of their own work.
The figure is only rendered for somebody the work can be assigned to.

**Two numbers cannot say which of two stories is true; three can.** *Accepted 0,
overruled 0* reads as a product whose every suggestion was ignored. With the
count they are out of in front of them, the same two zeroes read as what they
are — the agent has not proposed anything yet.

**Money arrived asserting fourteen significant digits.** Interest accrued comes
out of a daily rate and came back as `36733.291024657534`. Rounded in the
response rather than in the formatter, so the screen, the printed page and
anything exported all carry one figure — a display-only round is how two copies
of one number start to disagree.

#### What it did not do

It is **not the root**. The queue stays at `/`, because it is the right first
screen for most of the logins, and swapping the two by role would mean one URL
showing two different screens. An owner arrives at the overall view from the
first item in the sidebar. That is a reversible choice and it is written down
here so it can be revisited rather than rediscovered.

### What OBJ-27 turned out to be

Built on 12 August, and it divided cleanly in two: one half was plumbing and the
other half was the first thing this product knows that a dealership could not
have found out any other way.

**The sending half is BYOK, and that is the design rather than a pricing
position.** R-106 was written into the register three hours before this was
built and it would have been easy to satisfy in the documentation and not in the
code — one environment variable, one WhatsApp number, every dealership sending
from it. `channel_credentials` is what makes the rule true: the number a
customer sees is the dealership's, so is the Meta account, so are the template
approvals, and so is the bill.

The token is AES-256-GCM under a key that lives in the environment, and the
function that decrypts it is private to one module. **No route in this product
has a shape that could return a secret** — `ChannelStatus` has no field for one
— which is a property of the type rather than a rule every future handler has
to remember. `verify:channels` §2 serialises the whole response and fails if the
plaintext appears anywhere in it.

**A credential arrives switched off every time, including on a re-paste.** A
token that changed is a token nobody has tested, and the send that proves it
works costs less than the one that goes to four hundred customers from a number
the dealership had not finished setting up.

**Meta's twenty-four-hour window is shown, not worked around.** A free-form
WhatsApp message is only permitted within a day of the customer's last one;
outside it a business must send a pre-approved template. DDMS surfaces Meta's
own refusal rather than silently substituting an approved template for the
message a manager wrote and put their name to — which is the single thing the
whole approval gate exists to prevent.

#### The half that is not plumbing

`inbound_messages` is the first table here that mirrors nothing. Every other one
copies, derives from or annotates something the dealer's own system holds. A DMS
records what the dealership *did* to a record; it has no column for *the
customer answered on Tuesday*, no report that would produce one, and no way to
notice that nobody read it.

**Nothing reads the message.** Stored verbatim, no rule fires on its contents,
no model summarises it. A model reading *"don't bother, I've sold it"* and
marking a lead lost is exactly the judgement R-49 reserves for a person, and it
is the worst kind of failure because it is silent — the lead leaves a screen and
nobody ever learns why.

What a reply produces is a queue row saying somebody answered and nobody has
opened it, **always in the Nobody's band**. Not because a reply is the most
urgent thing in a dealership, but because there is no honest way to call it
assigned: it arrived at a number, not at a person. That is the definition of the
band and it is the finding this product exists for.

**The thread beats the phone book** (R-47 again, in a new place). A reply is
attributed to the last message DDMS actually sent that number — a reference,
because we wrote it and know what it was about — and falls back to matching the
customer entity on the mobile, which is probable and says so on the row. An
unmatched reply is kept and queued rather than dropped: somebody wrote to the
dealership whether or not anything here can say what about.

#### The endpoint outside every gate

The webhook is the only route in this product without the service key, a session
or a role, because Meta holds none of them. **The signature is what stands in
their place**: HMAC-SHA256 over the raw bytes with the app secret the dealership
stored beside their own credential, compared in constant time, verified before
a row is written.

A channel with no signing secret **cannot receive at all**. There was a
temptation to accept unsigned deliveries so a dealership could get replies
working before finishing the Meta setup, and it is the wrong trade by a long way
— it makes the URL somewhere anybody may post a fabricated customer conversation
into a dealership's queue.

> **The signature is over the bytes, not the parsed object.** Verifying against
> `JSON.stringify(req.body)` re-serialises with different key order and spacing,
> and produces a webhook that rejects every genuine delivery while looking
> completely correct.

#### Two findings, and both are about the verifier

> **A verifier that reaches for a wider credential is usually reporting a real
> boundary.** This one connected an account inside `withWorkerScope` and got
> `permission denied for table channel_credentials`. The grant is right —
> `ddms_worker` holds select and update and no insert, because an unattended
> process that could write a messaging credential could point a dealership's
> outbound at a number nobody chose. Connecting is a person's act. **Third time
> this exact shape has appeared** (`ingest_mappings`, `autonomy_consents`, now
> this), and each accident became a deliberate check.

> **A verifier that only exercises the empty case keeps passing after the
> feature breaks.** With no prior outbound to the test number the reply came
> back `matchBasis: NONE`, all twenty-two checks passed, and the entire
> threading path — the reason `providerMessageId` exists on the outbox at all —
> had never run. Section 5b sends a message first and then answers it.

#### What is still outside the software

An actual WhatsApp Business account: a Meta app, a verified business, a phone
number that is not already on consumer WhatsApp, and a permanent access token.
None of that is code and none of it is ours to do. The product is ready for the
numbers; adding them is the dealership's afternoon with their own Meta account,
and `/channels` is written to be that afternoon's screen.

### What OBJ-28 turned out to be

Built on 12 August, and the largest part of it was a refactor nobody asked for.

**R-92 could not be satisfied without one door for model calls.** There were
three near-identical fetches — the composer's rewrite, the explanation's
narration, the ingest mapping's heading reader — with error handling that had
drifted apart and no single place that could count what any of them cost. A
daily ceiling that knows about two of three call sites is not a ceiling, and
would have been the worst kind of feature: one that reports a number and is
quietly wrong about it. `askModel()` is the door, and metering is now by
construction rather than by whoever adds the fourth call site remembering.

The refactor paid for itself immediately. Cost uses the provider's own
`usageMetadata` token counts, so the only inaccuracy is the rate table — one
number, correctable in one place, instead of a guess compounding per call.

**The trace is ambient, and that was the second decision.** `withRun` puts a run
into an `AsyncLocalStorage` exactly as `sessionScope` does with the request's
connection, and everything underneath calls `step()` knowing nothing about run
ids. Threading one through `runAgentForShowroom` → `suggestForItems` →
`composeFor` → `rewriteWithModel` would have been four signatures changed to
carry something none of them care about, and a fifth call site that forgets and
silently records nothing. `lib/db/src/scope.ts` makes the same argument about
the connection and it applies here unchanged.

Outside a run every function is a no-op, deliberately. A person pressing a
button is not a trace: the decision log already answers for that, and a steps
table that fills up with request handling is a second logger inside the database
and then a retention problem.

**A step names the decision it produced rather than repeating it.**
`applyAction` gained a `decisionId` in its result for this. Two tables telling
the story of one write is how they come to disagree, and the one somebody reads
is not necessarily the one they would trust.

#### The stand-down is the ladder, one level up

The ladder demotes a *pattern* people keep overruling. This pauses the *agent*
when it is being overruled broadly, because a product that keeps proposing while
a dealership keeps saying no is one they stop reading and then stop trusting.

Two things worth writing down about its shape. The rate is computed **across
every pattern rather than per pattern** — one pattern going badly should demote
that pattern, not silence everything — and the ceiling sits above
`AUTONOMY.OVERRIDE_CEILING_PCT` for the same reason.

And it **recovers by itself**: acceptance improves inside the window, or the day
turns over. A pause that needs a person to clear it is an outage rather than a
safety mechanism, and it would be one nobody understood how to clear. Likewise
the money ceiling stops only what runs unattended — a cap that also broke
somebody's button would be a product that goes down when it gets busy, and it is
one line in the wrong function away.

It is recorded as a run with outcome `STOOD_DOWN`, because *the agent chose not
to act* and *nothing was scheduled* are different facts and only one of them
needs looking into. The banner clears itself the moment a good run follows — a
warning that nothing ever clears is a warning people learn to ignore.

#### The finding

> **A verifier that ignores a return value will one day pass while doing
> nothing at all.**

`verify:trace` set the daily cost ceiling to 1 paisa and never looked at what
`setPolicy` said. The registry's floor for that key is 100, so the write was
refused — correctly, by the closed policy registry doing its job — the ceiling
stayed at its default, and two checks failed for a reason that had nothing to do
with the ceiling. Had the defaults been slightly different it would have failed
the other way: passing, having tested nothing.

It now reads the floor out of the registry, asserts the write succeeded, and
spends past it with a real metered call sized from that same floor. Nothing in
that section is a number typed twice.

#### What it deliberately did not do

**No severity column on a step, and five kinds, closed.** A steps table with a
`DEBUG` level becomes a second logger inside the database within a month. Each
kind corresponds to something a person would want to see on a screen, and
nothing writes a step to say a function was entered.

**No per-outlet runs.** The agent reads the group's queue once and the standing
is a property of the owner, so three runs would each tell a third of one story
and the daily ceiling would become three ceilings.

**`/runs` is read-only for everybody, including the owner.** A person editing
what an unattended process recorded about itself is the single change that would
make the whole table worthless, and the grant carries the refusal rather than
the route being careful.

### What OBJ-31 to OBJ-33 turned out to be

Built on 12 August, and the three are one build. Separating them would have
meant a ledger with nothing lodgeable coming out of it, which R-99 names as
having added a system rather than replaced one.

**No model is anywhere near any of it, and there is nowhere one could go.**
R-100 restates R-78 where the consequence is statutory. Every branch in
`post.ts` is a comparison against a stored value or a lookup in a table declared
above it. The single place a judgement could have crept in — deciding what an
unrecognised charge *is* — deliberately does not make one.

#### The three requirements, and what each cost

**R-103 — money collected for somebody else.** On this dealership's own
invoice, ₹17,750 of an ₹84,000 sale belongs to the RTO and an insurer. A ledger
that credited it to income would report turnover **21% higher than it is**, and
that error escapes the books entirely: turnover drives the tax on it, the GST
registration thresholds, and the OEM's own slabs. Three named liability
accounts, and the classification is a closed table of regular expressions
against the labels a dealership actually prints.

The interesting half is the default. A charge whose label nothing recognises
goes to **suspense, never to income** — the failure being designed against is
overstating turnover, so the default has to fall the other way, and a suspense
account somebody's accountant clears is ordinary practice.

**R-102 — selling a vehicle relieves stock.** Matched on the chassis number,
which is the only identifier the document and the stock mirror share. No match
means either a sub-dealer with no DMS — the customer OBJ-30 exists for — or a
chassis typed differently on one of them. **The revenue posts, the cost does
not, and the warning says what that means**: *until it is, the whole selling
price reads as margin.* Refusing the posting would deny a sale that happened;
inventing a cost would put a fabricated figure inside a set of books.

**R-101 — one document posts once.** A partial unique index on
`(sourceKind, sourceId) where status = 'POSTED'`, so a concurrent second attempt
loses at the database rather than both winning. A check-then-insert posts the
same invoice twice under a retry and overstates the month by the price of a
motorcycle — the error nobody notices until a return is filed.

Correction is **reverse and re-issue**, never an edit. The original stays marked
`REVERSED` and a new voucher carries every line with debit and credit swapped.
Dated today rather than back-dated: reversing an April entry in September is a
September event, and back-dating would silently reopen a month already filed on.

#### Two decisions that are the dealership's, not ours

**The chart is Tally-shaped and `tallyName` is a column.** A chart invented from
first principles would be elegant and would not map onto the one their CA has
used for eleven years. `isSystem` accounts may be renamed and remapped and not
deleted — a posting rule that cannot find its account has no honest behaviour
available: posting to a substitute misstates the books silently, and skipping
the line produces a voucher that does not balance.

**The OEM scheme is deliberately not posted.** R-88 says the claim is owed
whatever the customer was told, so there is a receivable from the manufacturer
behind every sale carrying one. Whether that is income or a reduction of cost is
a genuine accounting judgement belonging to the dealership's CA, and R-98's
posture is to feed their books rather than decide their policy. The amount is
named in the warnings so it is not lost, and the claims screen is where it is
worked.

#### Why GSTR-1 and the Tally feed share a file

They are one claim about the same numbers. If they ever disagreed, one would be
wrong and nobody could tell which — so neither is allowed its own idea of what a
sale was, and **nothing in either recomputes tax**. The rate and the split were
decided when the invoice was priced and printed on a document a customer holds;
a statutory return is not the place to discover the product has two answers.

B2B and B2C are different shapes rather than a flag, because they are different
filings. Getting that wrong does not produce a wrong total — it produces a
return the portal accepts and a buyer who cannot claim their input credit, which
the dealership hears about from the buyer three months later.

**Building the feed and marking it handed over are two calls.** A download that
failed halfway would otherwise leave vouchers marked exported that nobody
received, and the next feed would skip them — which is how a month goes missing
from somebody's books with nothing anywhere reporting it.

#### The findings

> **A `date` column and `like` do not meet.** The verifier's independent
> cross-check filtered the month with `voucher_date like '2026-08%'` and Postgres
> answered *no operator matches the given name and argument types*. Cast, and it
> is worth noting because it failed loudly — the same comparison written against
> a `text` column would have run and quietly matched nothing.

> **`db:push` without `db:rls` behind it broke six verifiers at once.** The rule
> has been in CLAUDE.md since OBJ-8 and it is there because this is exactly what
> happens: a push resets policy state, `record_activities` started refusing its
> own inserts, and the failures looked like six unrelated regressions rather than
> one missing command.

#### What is deliberately not built

**No receipts, no purchases, no payroll.** The voucher kinds exist in the enum
and only `SALES` and `JOURNAL` are produced. A ledger that posts everything is a
book of record, and R-98 is explicit that this is a feeder first — it earns the
rest by reconciling for a few months against what the dealership already keeps.

**Nothing unattended posts.** `ddms_worker` holds select on all three tables and
nothing else, asserted by `verify:ledger` §8. An entry appearing in a
dealership's accounts with nobody signed in is not a thing this product does.

**No edit control on the screen, and there will not be one.**

### What OBJ-29 turned out to be

Built on 12 August, last as planned, and the interesting thing about it is the
size. R-95 made a prediction eight objectives ago — *a second agent is a
principal and a set of grants, and `agent.ts` does not change* — and this is
that prediction being tested rather than restated.

**`agent.ts` did not change. Not a line.** The second agent is one entry in the
`Principal` union, eight grants beside it, and its own file.

#### What it does, and why that act was available

When a customer is waiting on a part that is out of stock at their branch and
sitting on a shelf at another, it proposes requesting the transfer. That is the
finding the spares module exists for — a DMS keeps the parts ledger against a
dealer code, so an owner with three outlets gets three ledgers and no way to ask
the question.

It was available because it is **DDMS's own routing decision** and not a claim
about a person. Every one of the eight registry actions closed to the first
agent is closed because it asserts somebody rang, chased or showed something;
requesting a transfer asserts only that this product asked.

#### Why a second agent rather than a wider first one

`part.request_transfer` and `vehicle.propose_transfer` were withheld from
`AGENT` with the reason *"not the band this agent is pointed at"* — an honest
proposal held back until the assignments had run for a while. Moving them into
`AGENT_GRANTS` would have been a two-line diff and the wrong answer.

**The ladder is why.** One principal means one standing per pattern, so handing
out enquiries and committing a part to a van would be judged on the dealership's
willingness to accept *either*. A showroom that loves the reassignments and
distrusts the transfers would have had no way to say so — and the whole argument
for a ladder over a dial is that the dealership's actual behaviour decides, per
pattern, rather than somebody's guess on the first afternoon.

Two principals, two sets of patterns, two independent rungs. One can run
unattended while the other stays at *pre-filled* for ever.

#### What it cost, exactly

- One line in the `Principal` union.
- Eight grants in `STOCK_AGENT_GRANTS`.
- Two hand-written refusals; the other thirteen inherited.
- One optional parameter on `ceilingFor`, defaulted, so four call sites were
  untouched.
- One optional field on `standingFor`'s input, same reason.
- One new file for the agent itself, and one for its verifier.

**Nothing was re-earned.** The refusals it gets are the sentences already
written for the first agent, because the objection was never about *which*
agent — it was about what the act asserts, and *a model cannot make a phone
call* does not become less true for a different model.

#### The finding, and it is a good one

> **The verifier caught the author of R-95 violating R-95.**

The first version of `WITHHELD.STOCK_AGENT` had thirteen hand-written sentences
saying what the first agent's already said, in slightly fewer words. That is
precisely the drift R-95 exists to prevent, committed by the person implementing
R-95, in the same hour.

`verify:agents` §3 compares the two agents' sentences for every act they are
both refused and failed on eight of them. **The fix was to share the strings,
not to loosen the check** — `ANY_AGENT_REFUSAL` is now spread into both maps,
and the sentences cannot diverge because there is one of each.

> **And then the exemption went stale.** `VEHICLE_MARK_OFFERED` sat on the
> check's expected-to-differ list. Once the reasons were genuinely shared it
> stopped differing, and leaving it there would have been an exemption covering
> nothing. Removed, which makes the check stricter than it was written.

#### What is deliberately not shared

The two runtimes. They differ in what they read, what they propose, and what a
proposal *is* — one picks a person, the other picks a branch — and the common
part is four lines of loop. Factoring that out produces an abstraction that has
to be widened every time a third agent has a slightly different shape, which is
how a two-agent runtime becomes a workflow engine nobody can predict. R-52's
failure mode, one level up.

What **is** shared is everything that matters: one door in `applyAction`, one
permission table, one ladder function, one proposal ledger, one trace.

#### What is granted and unused

`vehicle.propose_transfer`. The queue does not yet carry which outlet wants a
standing unit in a form the suggestion can read off, and re-deriving it here
would be a second answer to a question the inventory classifier already answers.
The grant is honest about what the agent *may* do; the gap is a queue field
rather than a permission, and it is written down here so it is not rediscovered
as a bug.

## 3f. Planned 12 August — accounting that a chartered accountant would sign

> **Superseded in part by §3g, the same day.** This section planned against the
> seed, which has Saraswati as a Delhi Pvt Ltd and Deccan as a Maharashtra LLP.
> Anirban corrected the premise: the ordinary two-wheeler dealership is **one
> company running several branches hub-and-spoke**, and a dealer network strong
> enough to hold two legal entities is a large firm that has become a company
> anyway. **OBJ-36 to 40 below are replaced by §3g's OBJ-36 to 45.**
>
> What survives unchanged is the defect analysis that opens this section. The
> one-directional ledger is still live and is still the reason reconciliation
> cannot be bolted on — and R-109 to R-115 carry over into §3g intact.

Anirban's ask, verbatim in substance: *the invoicing module should handle
everything from generating the invoice to reconciliation and reporting to the
CA, and all of it should be audit ready.*

OBJ-31 to 33 built the first third of that and the register said so. This
section is the rest, and it opens with a defect rather than a feature, because
the defect explains the shape of everything after it.

### The defect, and it is the whole design in miniature

**Every account the ledger touches moves in one direction.**

| Account | What moves it | What moves it back |
|---|---|---|
| `1200` Vehicle Stock | credited by every sale | **nothing** |
| `1100` Sundry Debtors | debited by every sale | **nothing** |
| `2300` Road Tax Payable | credited by every sale | **nothing** |
| `2200`–`2230` Output GST | credited by every sale | **nothing** |

A trial balance drawn today would show Stock-in-Hand as a large negative asset,
a debtor book that has never received a rupee, and a road-tax liability that
grows for ever. None of it is wrong arithmetic — every voucher balances — and
all of it is a set of books nobody could file.

The cause is single: **the ledger knows about one event in a dealership's life.**
There are four.

1. The vehicle arrives from the manufacturer — *purchase*
2. It is sold — *built*
3. The customer pays, usually in three parts — *receipt*
4. The dealership pays the OEM, the RTO and the insurer — *payment*

This also answers why reconciliation cannot be bolted on. **Reconciliation
compares two sides**, and only one side exists. Complete the double entry and
most of the reconciliation writes itself; leave it incomplete and every
reconciliation screen would be a report of one number against nothing.

### What "audit ready" means here, specifically

Not a mood. In India it is three concrete things and one of them is statutory.

**The edit log is statutory.** The proviso to Rule 3(1) of the Companies
(Accounts) Rules and Rule 11(g) of the Companies (Audit and Auditors) Rules
require accounting software to keep an audit trail of every change, with the
date, **which cannot be disabled**, and which is preserved. It binds companies
from FY 2023-24. A dealership trading as a proprietorship is not caught by it;
their auditor will still ask, and a product that can only answer *for a
proprietorship* has a ceiling on who may buy it.

DDMS is already stronger than the rule asks — **there is no edit path at all**,
only reversal — but "stronger" is not the same as "demonstrable". An auditor
asks *show me the trail*, and the answer has to be a screen rather than an
argument about grants.

**A closed period is closed.** Once a return is filed for a month, a voucher
posting into it makes the filed return disagree with the books. Every accounting
system in the world locks periods and DDMS does not.

**A figure traces both ways.** From a GSTR-1 row to the voucher to the document
to the deal, and back from the deal to the return it ended up in. An auditor's
question is almost always *where did this come from* or *where did this go*, and
a system that answers one direction answers half of them.

### The five objectives

| # | Objective | Fixes / unblocks | Depends on |
|---|---|---|---|
| ~~36~~ | ~~**Parties, purchases and opening balances**~~ *(see §3g)* | negative stock, input credit, the Tally party gap | 31 |
| 37 | **Receipts, payments and bill-wise allocation** | debtors that never clear, liabilities that never discharge, real ageing | 36 |
| 38 | **Day book, ledger, trial balance, P&L, balance sheet** | proves 36 and 37 landed | 37 |
| 39 | **Audit-ready: period lock, audit register, gapless proof, two-way trace** | the statutory half | 38 |
| 40 | **Reconciliation — five of them, and the graduation gate** | R-98's promise made concrete | 39 |

Sequenced so each one is provable by the next. **OBJ-38's trial balance is the
proof that 36 and 37 worked** — if it does not balance, nothing after it is
worth building, and finding that out with two objectives spent is much cheaper
than finding it out with five.

---

### OBJ-36 — Parties, purchases and opening balances

**A party is a ledger, not a column.** Tally gives every customer and supplier
its own ledger under a group, and that is not a formatting preference: it is
what makes a statement of account, a bill-wise allocation and an ageing report
possible at all. DDMS posts every debtor to one `Sundry Debtors` account with
the name as a line attribute, so the Tally feed imports with the party visible
and no per-customer statement is derivable from it.

`ledger_parties` hangs off `ledger_accounts` as a child, resolved against the
entity graph where a customer is already known — and **probable, per R-47**. Two
customers who share a handset must not silently become one ledger, so the match
is on an explicit reference where one exists and named as probable otherwise.

**Purchases are what stops stock going negative.** Dr Vehicle Stock, Dr Input
CGST/SGST/IGST, Cr the supplier. The mirror carries `receivedDate` and
`costAmount`, which is enough for the stock half and **not** enough for the
input-credit half — the OEM's tax invoice has GST on it that
`dms_vehicle_stock` does not hold. See the fork below.

**Opening balances** are one dated journal that must balance, for a dealership
adopting mid-year with debtors, creditors, stock and a bank balance already in
existence. It posts into the period before the first live month and is the one
entry that may name any account.

> **Done when:** a trial balance drawn after one purchase and one sale of the
> same chassis shows Vehicle Stock at zero and Cost of Goods Sold at the unit's
> cost — the arithmetic that is impossible today.

### OBJ-37 — Receipts, payments and bill-wise allocation

**The three-debit sale that §3d named.** A two-wheeler is rarely paid for once:
a booking advance in cash or UPI, a financier's disbursement into the bank, and
a balance on delivery. Three receipts against one invoice, and the ledger has to
hold that without any of them being an approximation.

**Bill-wise allocation is the mechanism, and it is Tally's own.** *New Ref* opens
a bill, *Agst Ref* settles part or all of one, *On Account* is money with no
invoice against it yet, *Advance* is money taken before there is an invoice at
all. `voucher_bill_allocations` carries it, and the Tally feed emits
`BILLALLOCATIONS.LIST` so an imported receipt lands against the right invoice
rather than as an unallocated credit their accountant then has to place by hand.

This is also what makes **DDMS's own receivables ageing true rather than
plausible.** Today the ageing comes from `dms_receivables`, which is the DMS's
opinion; once receipts are posted, the ledger has its own and the two can
disagree — which is OBJ-40's first reconciliation and a genuinely useful
finding.

**Payments discharge the liabilities.** Road tax paid over to the RTO, premium
paid to the insurer, the OEM's invoice settled. Without these, R-103's
liabilities are correct on the way in and wrong for ever afterwards.

> **Done when:** a customer who paid a ₹5,000 advance, was financed ₹70,000 and
> paid ₹19,000 on delivery has a zero balance, a statement showing four lines,
> and no unallocated credit anywhere.

### OBJ-38 — The three reports a CA opens first, and two more

Day book, ledger (per account and per party), and **trial balance**. Then P&L and
balance sheet, which fall out of a trial balance once the group hierarchy is
real — and the groups already exist on `ledger_accounts`.

The trial balance is the one that turns *audit ready* from a hope into a claim.
If it does not balance, nothing else on this list matters, and the fastest way
to discover that 36 or 37 has a hole is to draw one.

**Derived on read, and this is the exception that proves R-12's rule.** Every
other derived figure in this product is computed fresh because a stale flag is
worse than none. A report over an append-only ledger is the same argument
reaching the opposite conclusion only in appearance: the vouchers are immutable,
so the report *cannot* go stale — recomputing is free and storing would be the
thing that could drift.

### OBJ-39 — Audit-ready

**Period locking, refused at the database.** A `ledger_periods` row per owner per
month, with `CLOSED` set when a return is filed. A voucher whose date falls in a
closed period is refused — and the refusal belongs in the row policy as well as
the route, for the same reason every other refusal in this product does: a
policy is true and a route is careful.

Reopening a closed period is a named act with a reason, recorded, and it should
be rare enough that somebody notices.

**The audit register.** One screen answering the auditor's actual question:
every voucher, who posted it, from what document, when, and — for anything
reversed — the reversal, its reason and its author. It exists because *we never
edit* is a claim about grants, and an auditor is entitled to see it as a list.

**The gapless proof.** A register per series per financial year saying *tax
invoices 1 to 247, no gaps, no duplicates*, computed rather than asserted. The
unique index prevents a duplicate; nothing today proves the absence of a hole,
and a hole in a sequential tax series is an audit finding on its own.

**The two-way trace.** From a GSTR-1 row to the voucher to the document to the
deal, and back. Both directions, because an auditor asks *where did this come
from* and *where did this end up* about equally.

### OBJ-40 — Reconciliation, and there are five

Each answers a different question and only the last is optional.

**1 · The books against the mirror.** Sundry Debtors against
`dms_receivables`; Vehicle Stock at cost against `dms_vehicle_stock`. These
should agree, and when they do not the difference **names the document** — a
sale that posted without relieving stock, a receipt the DMS recorded that DDMS
never posted. This is where OBJ-31's R-102 warnings stop being a sentence on a
voucher and become a number somebody has to explain.

**2 · The return against the books.** GSTR-1's taxable value against the Vehicle
Sales credit for the month, tax head by tax head. Already asserted inside
`verify:ledger`; it needs to be a screen, because a CA will ask before filing
and *the verifier says so* is not an answer.

**3 · Input credit: GSTR-2B against purchases.** The single biggest recurring
job in a dealership's month. Three buckets: matched, **in 2B and not in our
books** (the supplier filed and we have not recorded the purchase), and **in our
books and not in 2B** (we recorded it and the supplier has not filed — credit at
risk, and worth chasing before the deadline rather than after).

**4 · The bank.** Statement lines against receipts and payments. Lowest value of
the five, because most dealers already do it in whatever they keep, and it is
listed so it is not mistaken for an oversight.

**5 · Against their own system, and this one is the product decision.** R-98
promised that DDMS becomes the book of record *only once its numbers have
reconciled against what they already keep, for an agreed period*. That promise
needs a scorecard: month by month, DDMS's sales, tax and debtor movement against
Tally's, the difference and its cause. **N consecutive months inside tolerance,
and the product offers to graduate** — which is OBJ-26's ladder applied to a
product decision exactly as §3d said it should be, with the dealership's own
consent as the thing that authorises.

> **A variance nobody can act on is a report, not a reconciliation.** Every one
> of these five must name the row, not the difference. *Debtors are ₹1,20,400
> apart* sends somebody to a spreadsheet for an afternoon; *these four invoices
> are in the ledger and not in the DMS, and this receipt is in the DMS and not
> in the ledger* is a morning's work with a list.

### New requirements

| # | Requirement | Status |
|---|---|---|
| R-109 | **A ledger records every money event, not one.** Every account must have something that moves it back, or the balance is a running total rather than a position. The four events in a dealership's life are the vehicle arriving, the sale, the customer paying and the dealership paying onward — and a ledger holding one of them balances per voucher while being unfilable in aggregate | ○ |
| R-110 | **A party is a ledger, not a column.** A statement of account, a bill-wise allocation and an ageing report are all impossible without it, and an import that lands every customer in one lump creates a parallel chart inside somebody else's books | ○ |
| R-111 | **Money is allocated to a bill, or it is on account and says so.** An unallocated receipt is not an error and must not be silently spread across the oldest invoices — that is a guess about which debt a customer intended to settle, and it is theirs to make | ○ |
| R-112 | **A filed period is closed, and the refusal is at the database.** A voucher dated into a month whose return has been lodged makes the filed return disagree with the books. Reopening is a named act with a reason and should be rare enough to notice | ○ |
| R-113 | **The audit trail cannot be switched off, and it is a screen rather than an argument.** India requires it of companies from FY 2023-24. DDMS is already stronger than the rule — there is no edit path, only reversal — and *stronger* is not *demonstrable* | ○ |
| R-114 | **A reconciliation names the row, not the difference.** A variance figure sends somebody to a spreadsheet; a list of documents is a morning's work. Every one of the five must produce the second | ○ |
| R-115 | **The book of record is earned by reconciling, not claimed.** N months inside tolerance against what the dealership already keeps, then the product asks. R-98's graduation with a number against it, and the dealership's consent is what authorises | ○ |

### Three forks, and they change the build

**Purchases: derived from the mirror, or the OEM's invoice?** The mirror has
`receivedDate` and `costAmount`, which fixes the negative stock and gives no
input credit, because the GST on the manufacturer's invoice is not in there.
Requiring the purchase invoice makes the ledger complete and adds an onboarding
step. *Recommendation: derive the cost-only purchase now so stock is right, and
take the OEM invoice through OBJ-24's existing report path when input credit is
wanted — the ingestion seam already exists and this is one more data type.*

**Is the first dealership a company?** Rule 11(g)'s audit trail binds companies
from FY 2023-24 and not proprietorships. It decides whether period locking is a
hard refusal or a warning, and whether the audit register is a requirement or a
courtesy. *Recommendation: build the hard version regardless — a product that
only suits a proprietorship has a ceiling on who may buy it, and the strict
behaviour is not more work.*

**GSTR-2B: portal access, or a file the CA hands over?** The government's API
needs registration and a GSP in most cases; a downloaded JSON is what a CA
actually has on their desk. *Recommendation: the file first, through the same
drop-and-map path OBJ-24 already built, and the API only if a dealership turns
out to have one.*

## 3g. Finance — the module, planned 12 August

§3f planned the accounting against the seed data, which has Saraswati as a
Delhi Pvt Ltd and Deccan as a Maharashtra LLP — two PANs, two states, two sets
of books. Anirban corrected the premise, and the correction is worth stating
because it makes the design **simpler**, not harder:

> A two-wheeler dealership does not usually run several legal entities. If it
> does, the network is strong enough that it is a large firm and has become a
> company anyway. **The ordinary case is one owner, one company, several
> branches, run hub-and-spoke from a main location.**

The worked reference is Tansi Honda across Bengaluru — a 4S hub carrying the
stockyard, the finance team and the parts warehouse; satellite 1S/2S showrooms
for footfall and bookings; standalone authorised service centres; and a BigWing
outlet for the 300cc+ range. All branches on **one state GSTIN**, each a
distinct cost and profit centre, with cash, financier payouts and OEM claims
consolidated centrally at the end of every business day.

**§3f's objective table (OBJ-36 to 40) is superseded by this section.** Its
defect analysis is not — the one-directional ledger is still the live problem
and still the reason reconciliation cannot be bolted on.

### What the correction changes

| | §3f assumed | Actually |
|---|---|---|
| Legal entities | two (Pvt Ltd + LLP) | **one company** |
| Sets of books | two balance sheets | **one** |
| GST registrations | two, two states | **one, one state** |
| A branch | its own entity | a **cost and profit centre** |
| Hub → satellite stock move | a taxable inter-company sale | a **delivery challan, no tax** |

The last row reverses completely, and it is the one that would have been most
expensive to get wrong in either direction. Moving a chassis from the
Ramagondanahalli hub to the Marathahalli satellite is **not a supply**: same
legal person, same GSTIN, so no tax invoice and no GST. It is a Delivery
Challan under Rule 55 with a Stock Transfer Note, and the stock simply changes
branch.

> **An e-way bill is still likely.** The consignment value of a motorcycle is
> above ₹50,000, and a delivery challan does not exempt the movement. Part B —
> the vehicle detail — is generally not required under fifty kilometres inside
> the state. This is the one paragraph in this section their CA should confirm
> against current Karnataka notifications rather than take from us.

### The structure, settled

One accounting engine. The dealership's shape is **data**, not a code path.

```
owner              the group — a commercial fact, not a legal one
 └─ entity         one PAN · one set of books · one balance sheet
     └─ registration    one GSTIN per state · one GSTR-1 · one GSTR-3B
         └─ branch      a cost & profit centre, with a role
```

Four foreign keys, and every shape a two-wheeler dealership takes falls out of
them without a second engine:

| Dealership | Entities | Registrations | Branches |
|---|---|---|---|
| Hub-and-spoke Honda dealer, one city | 1 | 1 | 5 — hub, satellites, ASC, BigWing |
| One company, two states | 1 | 2 | n |
| A group holding two companies | 2 | 2 | n |
| The sub-dealer doing five units a month | 1 | 1 | 1 |

The last row matters most: **the dealership OBJ-30 exists for is this same
structure with every count at one.** Nothing special-cases it.

> **Two engines was the tempting answer and it is the one failure this product
> refuses everywhere else.** `applyAction` is one door; the overall view is not
> allowed to know anything the module screens do not; GSTR-1 and the Tally feed
> share a file so they cannot disagree. Two ledgers for two shapes would drift
> within a month — and reconciliation would be the first casualty, because we
> would stop reconciling the books against reality and start reconciling two of
> our own systems against each other with no way to say which was right.

**Structure is fixed; variability is a closed setting list.** The split is the
whole of it, and conflating the two is where this gets complicated:

| Setting | Level | What it changes |
|---|---|---|
| The service centre invoices through DDMS | registration | the trial balance, and whether SAC lines exist at all — **answered: yes** |
| Turnover band | entity | switches e-invoicing on the B2B path |
| Regular or composition scheme | registration | GST entirely |
| Series central, or prefixed per branch | registration | `HOO/26-27/0001` |
| Who holds the tax-invoice series | registration | already exists — `SWITCH.DDMS_HOLDS_TAX_SERIES` |

**Closed, like the policy registry, for R-52's reason.** An open *adjust as per
requirement* layer becomes a configuration surface nobody can predict, and this
product's customer has no administrator to untangle one.

**Multi-entity is modelled and not featured.** A group holding two companies
gets two clean sets of books and **no** consolidated balance sheet, no
inter-company eliminations, no group P&L. That is honest and it is what their CA
would produce anyway — a consolidated statement is a specific legal exercise
rather than a report.

### The tax basis, researched and decided

Anirban answered the two open questions: **the service centre does invoice
through DDMS**, and the ex-showroom question was handed back to be researched
and decided. Doing that turned up something larger — **the rates in the code are
two years out of date**, and the decision itself stops being a setting.

#### What the rates actually are

The 56th GST Council rationalised the slabs with effect from **22 September
2025**. What the product currently believes, and what is true:

| | In the code today | Actually, since 22 Sep 2025 |
|---|---|---|
| Two-wheeler ≤ 350cc | 28% + 0% cess | **18%** |
| Two-wheeler > 350cc | 28% + 3% cess | **40%**, cess folded in |
| Electric two-wheeler | — | **5%** |
| Spare parts and accessories | 28% | **18%**, one uniform slab |
| Repair and servicing labour | — | **18%** |

`seed-pricelists.ts` hard-codes `gst: "28", cess: "3"`; the sale form defaults to
28. Every seeded price list, every invoice raised from one, and the worked
example in `verify-ledger` are wrong by the whole difference.

**Compensation cess on two-wheelers is gone.** The columns stay — cess still
exists for cars, tobacco and coal, and a dealership that adds a car brand would
need them — but for every two-wheeler this product prices, cess is now zero and
the 40% band is a single consolidated rate.

> **The rate cannot be derived from the HSN code.** `8711 30` covers 250cc to
> 500cc, and the 18%/40% boundary cuts straight through the middle of it at
> 350cc. So the rate belongs on the price-list item — which it already does —
> and any default has to be set from **engine capacity**, never from HSN. A
> product that inferred the rate from HSN would put a CB350 and a CB500 in the
> same band and be wrong about one of them.

#### Ex-showroom is tax-inclusive, and it is not a setting

The trade quotes **ex-showroom price as the price including GST**: factory cost
plus GST plus the dealer's margin, and excluding registration, road tax,
insurance, accessories and handling. On-road is ex-showroom plus those.

That is a fact about the world rather than a choice a dealership makes, so it
comes **off** the settings list. There is nothing to configure — a product that
offered *is your ex-showroom price inclusive or exclusive?* would be asking a
dealer to answer a question that has one answer, and half of them would get it
wrong.

The code today treats `exShowroomAmount` as the **taxable value** and adds tax on
top, **and it does so at the stale rate**, so the two defects compound:

| | Splendor @ ₹84,000 | Transalp @ ₹11,00,000 |
|---|---|---|
| Correct — inclusive, current rate | **₹84,000** | **₹11,00,000** |
| The code today — 28% / 31% on top | **₹1,07,520** | **₹14,41,000** |
| Overcharged | ₹23,520 | **₹3,41,000** |

Before a single pass-through charge. It is the single largest correctness defect
in the product, and on a BigWing bike it is three and a half lakh.

**What replaces it.** The price list holds one figure, the one the dealer quotes
and the customer recognises, and the taxable value is back-calculated:

```
  taxable  =  (ex-showroom − discount) ÷ (1 + rate)
  tax      =  (ex-showroom − discount) − taxable        ← the residual
  CGST     =  round(tax ÷ 2)
  SGST     =  tax − CGST                                ← the residual again
```

**Tax is the residual, twice, and that is deliberate.** Computing it
independently and printing both means the invoice does not foot when the paise
round the wrong way, and an invoice whose columns do not add to its own total is
one a customer queries and an auditor circles. Taking the difference guarantees
`taxable + tax = the price agreed`, exactly, every time.

#### What the service centre changes

It invoices through DDMS, so the Finance module covers service revenue and not
only vehicle sales. Three consequences:

**Labour is a service and parts are goods.** Both sit at 18% today, which is
convenient and is not a reason to conflate them: labour carries a **SAC** code
and parts carry an **HSN**, GSTR-1 reports them in the same summary but under
different codes, and the rates were different before September 2025 and could
diverge again.

**An advance for a service does attract GST**, unlike an advance against a
motorcycle. A dealership taking a booking on a bike and a deposit on a
restoration job is doing two different things, and the module has to know which.

**A service invoice is a different document from a sale.** Same series rules,
same registration, different line shape — labour lines, parts lines, and
frequently both on one job card.


### The objectives

Ten, and the shape changed twice while planning them.

**OBJ-36 was two objectives wearing one coat.** It bundled the entity hierarchy
with the tax basis. They touch different files and carry different risk, and the
tax basis is the one that cannot wait: until it lands, every invoice the product
generates overcharges by twenty-eight per cent. It goes first, alone.

**Nothing built the service invoice.** The service centre invoices through DDMS
— that is settled — but no objective created the document, and the only
generator in the codebase is built around one chassis and one ex-showroom
figure. It is now OBJ-42, sitting *after* the trial balance so the vehicle path
is proved complete before a second document type joins it.

| # | Objective | Depends on | The claim it has to prove |
|---|---|---|---|
| 36 | **The tax basis** — the September 2025 rates, engine capacity as the field they default from, and ex-showroom as the price **including** tax | 31 | a bike quoted at ₹84,000 invoices at ₹84,000, and a Classic 350 is taxed at 18% |
| 37 | **The hierarchy and the setup** — entity, registration, branch role, the closed setting list, the migration off `showrooms.gstin` | 31 | one code path serves a one-branch sub-dealer, a five-branch hub-and-spoke and a two-company group, with **no branch in the code** |
| 38 | **Parties and purchases** — party ledgers, purchase vouchers, opening balances per entity | 37 | a purchase and a sale of one chassis leave Vehicle Stock at zero |
| 39 | **Stock that moves without being sold** — delivery challan, chassis register, e-way bill | 38 | **the structure decides the tax**: same registration is no supply, different registration is a taxable one, and nothing asks a person |
| 40 | **Money** — receipts, payments, bill-wise allocation, advances, the day close | 38 | a customer who paid in three parts has a zero balance and no unallocated credit |
| 41 | **The books a CA opens** — day book, ledgers, trial balance, P&L, balance sheet | 40 | **the trial balance balances**, which is the proof 38 to 40 landed |
| 42 | **Service invoicing** — labour under a SAC, parts under an HSN, both on one job card, and an advance that carries tax | 41, 36 | a job card bills labour and parts as one document, and the trial balance still balances |
| 43 | **Audit-ready** — period lock, audit register, gapless proof, two-way trace | 41 | an auditor's three questions answered on a screen, not in an argument about grants |
| 44 | **The returns** — GSTR-1 per registration, GSTR-3B, TCS, e-invoicing on the B2B path | 43 | the return equals the books, tax head by tax head |
| 45 | **The reconciliations** — ten, plus the graduation gate | 44 | every one names rows rather than a difference |

**OBJ-41 sits where it does deliberately.** A trial balance is the cheapest
possible proof that the double entry is complete, and finding a hole with three
objectives spent costs far less than finding it with seven. It is also why
service invoicing follows rather than precedes it: adding a second document type
to books not yet known to balance means two suspects for one difference.

**Every report states the level it was drawn at.** Trial balance and balance
sheet per entity. Returns per registration. Day close, branch P&L and stock per
branch. A figure whose scope is ambiguous is a figure somebody will eventually
add to another one.


### The document chain, and what each one posts

This is the whole module in one table. Nine documents, and every entry in the
books comes from exactly one of them.

| # | Document | When | The entry |
|---|---|---|---|
| 1 | **Purchase invoice** (Honda → hub) | stock arrives | Dr Vehicle Stock, Dr Input IGST/Cess · Cr Honda |
| 2 | **Delivery challan** (hub → satellite) | allocation | *branch moves, no accounting entry* — a stock-register movement |
| 3 | **Booking receipt** | customer books | Dr Cash/Bank · Cr Customer *(advance)* |
| 4 | **Tax invoice** | delivery | Dr Customer · Cr Sales, Output tax, pass-through liabilities · **and** Dr COGS · Cr Vehicle Stock |
| 5 | **Financier receipt** | disbursement lands | Dr Bank · Cr Customer, allocated to the bill |
| 6 | **Balance receipt** | on delivery | Dr Cash/Bank · Cr Customer |
| 7 | **Payment** | RTO, insurer, Honda | Dr the liability / Cr Bank |
| 8 | **OEM claim** | warranty, scheme | Dr Honda *(receivable)* · Cr the income or cost head |
| 9 | **Day close** | every evening, per branch | cash counted vs cash booked; the difference is named |

Row 2 is the one that is *not* an accounting entry and that is the point: a
stock transfer changes which branch holds a chassis and changes no balance. It
still needs a document, a number and an e-way bill.

### The reports the CA asks for

Not a wish list — this is what an Indian statutory audit and a monthly GST
filing actually consume.

**The books**

| Report | Why it is on the list |
|---|---|
| Day book | every voucher in date order; the auditor's entry point |
| Ledger — account-wise | the movement in any one account |
| Ledger — party-wise | a customer's or supplier's statement, bill by bill |
| **Trial balance** | the one that proves the double entry is complete |
| Profit & loss | consolidated **and per branch**, since branches are profit centres |
| Balance sheet | consolidated only — a branch has no balance sheet |
| Cash book / bank book | per branch, and what the day close reconciles |

**The registers**

Sales register (invoice-wise with the tax split) · purchase register · **stock
register, chassis-wise** (received → transferred → sold) · debtors ageing,
bill-wise · creditors ageing · e-way bill register · voucher numbering gap
report.

**The returns**

GSTR-1 · GSTR-3B with the tax-payment entry · the GSTR-2B match · the TCS
statement where it applies.

**The audit set**

The audit trail register · the period-lock log · the two-way trace from a return
row back to a deal.

### Four statutory things that change the build

**E-invoicing is B2B only, and it is a real gate.** Above ₹5 crore aggregate
turnover a B2B invoice must be registered on the Invoice Registration Portal and
carry an **IRN and a QR code, or it is not a valid tax invoice**. A multi-branch
Honda dealer crosses ₹5 crore comfortably once service and parts are counted.

The relief is that **most of a dealership's sales are B2C** — Mr Verma buying a
Splendor needs no IRN — and DDMS already knows which is which, because
`customerGstin` is the same field that decides B2B against B2CS in GSTR-1. So
this is a capability on the B2B path, gated on the dealership's turnover, and
not a change to every invoice. Above ₹10 crore there is also a **30-day
reporting window** from the invoice date.

**TCS at 1% above ₹10 lakh, and BigWing is why it matters.** Section 206C(1F)
applies to the sale of a motor vehicle where the invoice value exceeds ₹10 lakh,
collected **at the time of receipt** rather than at invoicing. A Splendor never
reaches it; a Transalp does, and a Gold Wing is four times over. A BigWing
outlet needs it and a 1S satellite never will — which is another reason the
branch role is a real field rather than a label. (206C(1H), the ₹50 lakh
provision, ceased from 1 April 2025.)

**No GST on an advance for goods.** A booking advance against a motorcycle
attracts no tax — the liability arises at the invoice. An advance against a
*service* job does attract it. The module has to tell the two apart, and a
dealership taking both routinely.

**The invoice series is per GSTIN per financial year.** With several branches on
one registration, either one central series or a distinct per-branch prefix —
`HOO/26-27/0001`, `MAR/26-27/0001` — and both are permitted so long as they
cannot collide. `series.ts` today issues one series per owner, which is correct
for one branch and wrong for five.

### The ten reconciliations

Grouped by what they compare, and every one of them names rows rather than a
difference (R-114).

**Inside our own books**

1. **Inter-branch** — transfers out equal transfers in, chassis by chassis. A
   difference is a bike that left the hub and arrived nowhere.
2. **Stock** — the book position against the chassis register against the DMS
   mirror. Three sources that must agree, and the odd one out names itself.
3. **Debtors** — the party ledger against `dms_receivables`, bill by bill.

**Money**

4. **Day close** — cash counted at each branch against cash booked, every
   evening. The one control that catches a problem the same day.
5. **Bank** — the statement against the cash and bank books.
6. **Financier** — disbursements expected from live bookings against
   disbursements received. Money a dealership is owed and routinely forgets.
7. **The OEM** — Honda's statement against our creditor ledger *and* our claims
   receivable. Warranty and scheme claims are where a dealer's money quietly
   goes missing.

**Statutory**

8. **GSTR-1 against the sales register against the books.** Three views of one
   month that must produce one number.
9. **GSTR-3B against GSTR-1 and the ledger**, including the tax actually paid.
10. **GSTR-2B against the purchase register** — matched, in 2B and not in our
    books, and **in our books and not in 2B**. The last bucket is input credit
    at risk, and it is worth chasing before the deadline rather than after.

**And the eleventh, which is a product decision rather than an accounting one.**
R-98 promised DDMS becomes the book of record only once its numbers have
reconciled against whatever the dealership already keeps, for an agreed period.
That needs a scorecard — month by month, sales, tax and debtor movement against
their existing system, with the difference and its cause — and **N consecutive
months inside tolerance before the product offers to graduate.** OBJ-26's ladder,
applied to a product decision, with the dealership's consent as the thing that
authorises.

### New requirements

| # | Requirement | Status |
|---|---|---|
| R-109 | **A ledger records every money event, not one.** Every account must have something that moves it back. A ledger holding only the sale balances per voucher and is unfilable in aggregate | ○ |
| R-110 | **A party is a ledger, not a column.** A statement, a bill-wise allocation and an ageing report are all impossible without it | ○ |
| R-111 | **Money is allocated to a bill, or it is on account and says so.** Spreading an unallocated receipt across the oldest invoices is a guess about which debt the customer meant to settle, and it is theirs to make | ○ |
| R-112 | **A filed period is closed, and the refusal is at the database.** Reopening is a named act with a reason | ○ |
| R-113 | **The audit trail cannot be switched off, and it is a screen rather than an argument.** DDMS is already stronger than the rule — no edit path, only reversal — and *stronger* is not *demonstrable* | ○ |
| R-114 | **A reconciliation names the row, not the difference.** A variance figure is an afternoon in a spreadsheet; a list of documents is a morning's work | ○ |
| R-115 | **The book of record is earned by reconciling, not claimed.** N months inside tolerance, then the product asks | ○ |
| R-116 | **The owner is the legal entity; a branch is a cost centre.** One PAN, one set of books, one GST registration per state, and every voucher carrying its branch. A group holding two companies is two owners, and that is already how tenancy works | ○ |
| R-117 | **Moving stock between branches is not a supply.** Same legal person, same GSTIN: a delivery challan and a stock-register movement, no tax invoice, no GST, and no accounting entry — but a document, a number and an e-way bill | ○ |
| R-118 | **What is statutory is not ours to soften.** E-invoicing above ₹5 crore on the B2B path, TCS at 1% above ₹10 lakh collected on receipt, no GST on an advance for goods, and an invoice series unique per GSTIN per year. Each is a rule about the world, and a product that gets one wrong is a product that produces invalid documents | ○ |
| R-119 | **The shape of a dealership is data, not a code path.** One accounting engine; the hierarchy is four foreign keys and the variability is a closed setting list. Two engines for two shapes would drift within a month, and reconciliation would be the first casualty — we would stop comparing the books against reality and start comparing two of our own systems with no way to say which was right | ○ |
| R-120 | **A report states the level it was drawn at.** Trial balance and balance sheet per entity, returns per registration, day close and branch P&L per branch. A figure whose scope is ambiguous is a figure somebody will eventually add to another one | ○ |
| R-121 | **A tax rate is a fact about the world, and the product holds the current one.** The slabs moved on 22 September 2025 and the code did not: two-wheelers are 18% up to 350cc and 40% above it, cess on them is gone, parts and labour are 18%. **The boundary is inclusive** — *exceeding 350cc* means exceeding, so a Classic 350 sits in the lower band, and a classifier that reads model names rather than capacity gets it wrong. The rate cannot be inferred from HSN either, since `8711 30` spans it. So it belongs on the price-list item, and the default comes from a **capacity field**, which is a column the product did not have | ✅ |
| R-122 | **Ex-showroom is the price including tax, and tax is the residual.** The taxable value is back-calculated from what the customer agreed to pay; the tax is the difference and the CGST/SGST split takes the difference again. Computing either independently produces an invoice whose columns do not add to its own total, which is what a customer queries and an auditor circles | ✅ |
| R-123 | **Labour and parts are different classifications even when the rate is the same.** Labour carries a SAC and parts an HSN. They sit at 18% together today, they did not before September 2025, and a product that collapsed them because the numbers happened to match would have to be unpicked the next time they diverge | ✅ |

### What is settled, and what is next

**The service centre invoices through DDMS**, so Finance covers service revenue:
labour under a SAC code, parts under an HSN, both at 18% today, and advances
against a service job carrying tax where a booking advance on a motorcycle does
not. It is OBJ-42 rather than a footnote, because nothing in the first draft
actually built the document.

**Ex-showroom is the tax-inclusive price**, decided by research rather than by
asking — it is a fact about the trade and not a choice a dealership makes. It
therefore never became a setting, and is instead the substance of OBJ-36.

**Nothing is blocking OBJ-36.**

---

## 3h. Built 13 August — OBJ-36, the tax basis

The objective closed in one sitting, and three things came out of it that the
plan did not contain.

### What it turned out to be

**The rate table went into `@workspace/quoting`, not into the API server.** It
started life as `lib/dms/invoice/rates.ts` and moved before it was used twice,
because `@workspace/quoting` is the package that exists for exactly this: the
mock and the server share `panel` and `premium` so they cannot disagree about a
quota or a premium. The **seeder** that builds a price list and the **generator**
that raises an invoice off it must not be able to disagree about what 350cc
means, and now they cannot — one table, three importers, and the sale form
imports it too, so the screen offers the same default the seeder wrote.

**The mirror does not carry engine capacity, and that is a fact rather than a
gap.** The OEM's export records what was sold and for how much, not what the
machine displaces. So a dealer bootstrapping a price list out of his own sales
history has the prices and not the capacities — which is why `engine_cc` is
nullable, why a missing one defaults to 18%, and why the typed form now asks for
it directly. The fixture supplies capacities from a map that matches the mock
catalogue; a real dealership supplies them once, per model, forever.

**The old classifier was wrong about the boundary in the way everyone is.**
`seed-pricelists.ts` matched on the model name — `/(350|390|classic|meteor)/` —
and a Classic 350 is *exactly* 350cc. The law says *exceeding* 350cc, so it
belongs in the lower band and the regex put it in the upper one. Under the old
rates that was a cess wrongly charged; under the new ones it is 40% where 18% is
due, on a bike that sells in volume. The verifier now asserts the boundary from
both sides **and on it**.

### What the verifier caught in itself

The mutation test found a hole in the check rather than in the code, which is
the outcome it exists for.

Reverting `taxWithin` to `taxable = inclusive` makes the tax **zero** — and the
headline check, *the columns add to the price the customer agreed to*, passed.
It is trivially true when there is no tax. The check pinned one end of the
arithmetic and left the other loose.

So the section now asserts the reverse direction too: **the tax is a real rate
on a real base**, non-zero, and within one paisa of the rate applied to the
taxable value. The tolerance is that paisa and it is the residual, deliberately
— `taxWithin` takes the difference rather than computing the product precisely
so the invoice foots, and where the two disagree the footing wins.

Both mutations now fail loudly: the zeroing one on ten checks, the genuine old
exclusive basis on twelve.

> **A footnote worth keeping.** Three checks failed on the first run for a reason
> that was not the code: summing rupees as JavaScript floats. `67795.76 +
> 6101.62 + 6101.62` is 79,999 in decimal and 79998.99999999999 in binary. The
> figures were exact; the verifier's addition was not. Comparisons are now made
> in **paise, as integers**, which is stricter than rounding the sum and is the
> arithmetic Postgres `numeric` actually performs. It is the same reason the
> schema has said *money as `numeric`, never `real`* since the first migration.

### What is now true

| | Before | After |
|---|---|---|
| Splendor quoted at ₹84,000 | invoiced ₹1,07,520 | **₹84,000** |
| Transalp quoted at ₹11,00,000 | invoiced ₹14,41,000 | **₹11,00,000** |
| Classic 350 | 28% + 3% cess | **18%** |
| Electric | no band at all | **5%** |
| Where the rate comes from | a regex on the model name | **engine capacity, one shared table** |

R-121, R-122 and R-123 close. **OBJ-37, the hierarchy and the setup, is next and
nothing blocks it.**

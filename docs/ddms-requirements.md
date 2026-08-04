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
| R-19 | Staff shortage made visible from the dealer's own data — attrition, orphaned work | ◑ leads only, and orphaned work across every module. The rest is OBJ-15 |

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
| R-52 | **Automation is one ordered list, it lives in code, and it is capped.** No rule builder, no per-dealership flows, and a stated ceiling on how many rules may exist. The failure mode being designed against is documented: orgs reach eighty automations on one object, page saves take eight seconds, and nobody can predict what a save will do | ○ |
| R-53 | **A dealership has people, and scope only ever narrows.** Roles inside an owner — advisor, RTO agent, accounts, manager — expressed as an *additional* predicate on top of the owner's, never an alternative one. A bug in the role layer must be able to hide rows and must not be able to reveal them | ✅ |
| R-54 | **Work is routed by role and capacity, and never becomes unroutable.** Who can do it, who has room, and who is actually in today. When nothing matches, it degrades to a named queue rather than disappearing | ○ |
| R-55 | **One queue, worked one at a time.** Seven screens each holding a list is a reporting product. The capacity thesis needs a single ordered queue that can be worked start to finish without returning to a list | ○ |
| R-56 | **Automation may write a decision field. Only the gate lets anything leave.** An automated mark is internal, reversible and logged. Anything outbound still passes `authoriseSend()`, unchanged — the line drawn in R-48 does not move because the caller stopped being a person | ○ |
| R-57 | **A chase stops when its goal state is reached.** The exit condition is a `classify()` state, not a reply or a click. A cadence that cannot stop itself is the mechanism by which automation becomes something a dealership apologises for | ○ |
| R-58 | **Thresholds are dealer policy, not product logic.** Credit periods, ageing buckets, chase cadence, what counts as the RTO having gone quiet — per owner, stored, and changes to them audited. The rules stay in code; the numbers belong to the dealership | ○ |
| R-59 | **The agent invokes the same action registry a person does.** One endpoint, one set of refusals, one decision log. A parallel agent-only path would have to re-earn every refusal and would eventually fail to | ○ |
| R-60 | **Every automated act is attributable and reversible.** `decision_log.userId` null reads as *the system did this*, never as *we lost track*. Anything a rule set, a person can unset | ○ |
| R-61 | **A dealership's staff get their own logins, and a login is the dealership's own employee record.** *Locked 4 August.* A user carries an `empCode`, and that code is what already sits on the enquiries, registration files and job cards they are responsible for. Without that join, *my work* has no referent and the queue is only a differently sorted list | ✅ |
| R-62 | **The mirror may revoke access. It may never grant it.** An owner creates a login and links it to an employee; the DMS saying that person has left closes it. Never the reverse — a name appearing in the staff master must not become a login. And the honest limit travels with it: revocation is only as fresh as the last sync | ✅ at sign-in, on every request, and in `app.session_user_id()` so it holds at the database |
| R-63 | **See the outlet, act on what is yours or unowned.** A nine-person dealership covers for each other, so hiding a colleague's leads would be wrong and would hide the orphaned-work finding R-19 exists for. Visibility is the outlet; the write is yours, or nobody's | ✅ SELECT owner-scoped, writes narrowed |
| R-64 | **A cross-outlet *finding* survives the narrowing; the other outlet's *rows* do not.** An advisor scoped to one branch still learns that the part their customer is waiting for is free at the other one, and still cannot open that branch's ledger. The finding is the product; the rows are somebody else's business | ✅ |

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

### The revised order, and why

| Order | Objective | Model? | Why here |
|---|---|---|---|
| 1 | ~~**OBJ-13** The mirror emits events~~ ✅ | no | invisible, small, and four things are blocked behind it |
| 2 | ~~**OBJ-14** People, and what each may see~~ ✅ | no | the queue needs a *me*; and it is half of the access story |
| 3 | ~~**OBJ-8** One credential~~ ✅ | no | the other half. Doing 14 and 8 together was one piece of work about who sees what, and it had been outstanding since 3 August |
| 4 | **OBJ-15** The queue | no | the capacity thesis, finally operational |
| 5 | **OBJ-16** Rules that run themselves | no | needs 13 for the trigger and 15 for somewhere to put the work |
| 6 | **OBJ-17** The agent operates the registry | yes, gated | almost free by then: the registry, the refusals, the gate and the audit trail all exist |
| 7 | **OBJ-6** A dealership that reads as real | no | last, and better last — by then there is more for the data to exercise |

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

### OBJ-15 — The queue
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

### OBJ-16 — Rules that run themselves
*Covers R-52, R-56, R-57, R-58, R-60.*

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

### OBJ-17 — The agent operates the registry
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

### OBJ-6 — A dealership that reads as real
*Covers R-6, R-33. Replaces "get real DMS access", which Anirban ruled out on
3 Aug: the data we generate is the data, and it has to feel real rather than be
real.*

Deepen the seeded dealership until nothing on screen reads as a fixture: enough
volume that the lists need filtering, names and models spread the way a real
month is, and no demo labelling anywhere in the chrome.

**Done when:** somebody shown the console without preamble asks a question about
the business rather than a question about the data.

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

**What it cannot do yet, and it is one thing.** Nothing happens unless somebody
is looking. Every mechanism built so far is *pull*: sync writes the mirror,
screens derive on read, and a file that went wrong overnight waits for a person
to open a page. There are no events, no queue, no people inside a dealership,
and no rule that runs on its own. That is what **section 3b** is for, and it is
the difference between a product that shows a short-staffed dealership its
problems and one that absorbs some of them.

**The blocker before a customer is gone.** Sign-in exists in all three
products, the database enforces the boundary rather than trusting the code to,
and since OBJ-8 the server holds no credential that could bypass it — it refuses
to start with one. What is left is not a safety question any more; it is the
queue, and the rules that fill it.

---

## 5. Explicit non-goals

Written down so they stop being re-litigated.

- Not writing back to the OEM's DMS.
- Not a remote-desktop or screen-scraping integration.
- Not reducing dealership headcount, and no wording that implies it.
- Not replacing the OEM's DMS.
- Not multi-OEM before one OEM works end to end.
- Not extracting a shared UI package until a third consumer needs it.

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
| R-7 | Each product is complete on its own; DDMS, InsurRouter and VeloDocs usable individually and as a whole | ◑ frontends split, API still one process |
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
| R-19 | Staff shortage made visible from the dealer's own data — attrition, orphaned work | ◑ leads only |

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

### How it looks

| # | Requirement | Status |
|---|---|---|
| R-30 | **A dense dealer portal, in the shape of the Hero portal at `:9090/portal`** — module-grouped sidebar, KPI cards, action buttons on rows, quota bars, an identity header with showroom picker and financial year | ○ **currently a thin admin console** |
| R-31 | Distinct from the OEM's own system: the owner's group identity, multi-showroom, not one dealer code | ◑ |
| R-32 | Never show invented identity — no fake user until there is a login | ✅ |
| R-33 | **The seeded dealership data must read as real.** No "sandbox", "demo data" or similar labelling on the chrome. The records are invented, but they stand in for a real dealer's, and a demo badge makes the whole product read as a toy | ✅ |

### Non-negotiables

| # | Requirement | Status |
|---|---|---|
| R-40 | Never write to the OEM's DMS | ✅ |
| R-41 | Never present simulated output as real. **Narrower than R-33 and it survives it**: dealership records may read as real because they stand in for real ones, but a policy number no insurer issued stays marked on the policy itself, because somebody could otherwise believe they are covered | ✅ |
| R-42 | Per-user authentication before any real customer | ✅ |
| R-45 | Isolation enforced by the database, not only by application code. The DDMS request path connects as a role that cannot bypass RLS and cannot read a session token | ✅ |
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

### OBJ-8 — One credential, and it is not the owner's  · *replanned to last, see 3a*
*Follows OBJ-7. Covers R-7 and the rest of R-42.*

InsurRouter and VeloDocs still run on the connection that bypasses RLS, because
they have no sign-in and no tenant to scope by. Until they do, the server holds
a credential that sees every dealership.

**Done when:** the running API server's environment contains no connection
string with `bypassrls`, and InsurRouter's application list shows only the
signed-in owner's applications — proven by signing in as the second owner and
getting an empty list rather than by reading the code.

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
| 6 | **OBJ-6** a dealership that reads as real | no | partly falls out of the above |
| 7 | **OBJ-8** one credential | no | unchanged, and now also gates outbound |

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

**The blocker before a customer has moved.** Sign-in exists and the database
enforces the boundary rather than trusting the code to. What is left is that the
server still holds a credential that can see every dealership, because the other
two products have nothing to scope by yet — OBJ-8.

---

## 5. Explicit non-goals

Written down so they stop being re-litigated.

- Not writing back to the OEM's DMS.
- Not a remote-desktop or screen-scraping integration.
- Not reducing dealership headcount, and no wording that implies it.
- Not replacing the OEM's DMS.
- Not multi-OEM before one OEM works end to end.
- Not extracting a shared UI package until a third consumer needs it.

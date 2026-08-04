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
| R-1 | Owner-level: one owner, many showrooms, one view across all of them | ✅ and now *load-bearing* — the spares worklist reads across outlets |
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
| R-16 | Spares, finance/receivables, inventory ageing, registration workflow | ◑ registration and spares done |
| R-17 | Invoice generation, automated | ○ |
| R-18 | DDMS holds every DMS field **plus** its own decision fields for each function | ◑ 5 of 9 modules |
| R-19 | Staff shortage made visible from the dealer's own data — attrition, orphaned work | ◑ leads only |

### What it does

| # | Requirement | Status |
|---|---|---|
| R-20 | **Dual role**: a control panel *with action buttons*, not a report | ○ **all actions are text** |
| R-21 | Action buttons call the real `/api` pipeline — *locked decision, after the owner tier* | ○ |
| R-22 | Multi-agent automation orchestration — agents propose, rules dispose, actions execute | ○ |
| R-23 | Deterministic if/else rules where the logic is knowable, not a model guessing | ◑ derivations are rules |
| R-24 | What the software cannot do becomes an explicit tracked task with the exact value to copy | ✅ |

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

### OBJ-8 — One credential, and it is not the owner's  ← **next**
*Follows OBJ-7. Covers R-7 and the rest of R-42.*

InsurRouter and VeloDocs still run on the connection that bypasses RLS, because
they have no sign-in and no tenant to scope by. Until they do, the server holds
a credential that sees every dealership.

**Done when:** the running API server's environment contains no connection
string with `bypassrls`, and InsurRouter's application list shows only the
signed-in owner's applications — proven by signing in as the second owner and
getting an empty list rather than by reading the code.

### OBJ-4 — The remaining modules  ◑ **2 of 5, 4 Aug**
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

#### Still to do

Receivables, inventory ageing, invoicing.

### OBJ-5 — Agent orchestration
*Covers R-22, R-23.*

Agents draft the contact — the WhatsApp message to the customer whose bike is
ready, the follow-up to the lead nobody rang. Rules decide whether it may be
sent. A human approves until trust is earned.

**Done when:** a drafted message exists against a worklist row, and no message
can leave the system without either a rule permitting it or a person approving
it.

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

**Built and verified:** owner tier; the read-only mirror across five modules
(deals, job cards, enquiries, registration files, parts); reconciliation on
deals; derived state on all five; insurer panel with quota; scheduled sync; API
authentication; per-user sign-in; row-level security on the DDMS request path;
the one-application-per-deal constraint; DDMS as its own service.

**The dual role has started.** The first action button works end to end: a deal
with no insurance goes from a row on a screen to an application in the database
in one click, and the row changes state behind you. The other actions on the
three screens are still sentences, because they still need a person — and
dressing those as buttons would be the same defect as a simulated policy that
looks issued.

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

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
| R-1 | Owner-level: one owner, many showrooms, one view across all of them | ✅ |
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
| R-16 | Spares, finance/receivables, inventory ageing, registration workflow | ○ |
| R-17 | Invoice generation, automated | ○ |
| R-18 | DDMS holds every DMS field **plus** its own decision fields for each function | ◑ 3 of 9 modules |
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
| R-42 | Per-user authentication before any real customer | ○ **blocker** |
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

### OBJ-3 — Per-user authentication  ← **next**
*Covers R-42. Blocks every real customer.*

Owner logs in. `showroomId` comes from the session, not the request. RLS
policies written so the Supabase key stops being a master key.

**Done when:** two owners exist and neither can read the other's rows, proven by
a failing query rather than by inspection.

### OBJ-4 — The remaining modules
*Covers R-16, R-17, R-18.*

Spares, receivables, inventory ageing, registration workflow, invoicing. Each
follows the established pattern: mirror table, projection, derived state, one
decision field that changes the outcome.

**Done when:** each module has a screen whose leading number is a count of work
nobody could previously see.

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

**Built and verified:** owner tier; the read-only mirror across three modules
(deals, job cards, enquiries); reconciliation on deals; derived state on all
three; insurer panel with quota; scheduled sync; API authentication; the
one-application-per-deal constraint; DDMS as its own service.

**The dual role has started.** The first action button works end to end: a deal
with no insurance goes from a row on a screen to an application in the database
in one click, and the row changes state behind you. The other actions on the
three screens are still sentences, because they still need a person — and
dressing those as buttons would be the same defect as a simulated policy that
looks issued.

**The blocker before a customer:** no per-user auth. An owner-level product with
no owner login cannot be sold to an owner.

---

## 5. Explicit non-goals

Written down so they stop being re-litigated.

- Not writing back to the OEM's DMS.
- Not a remote-desktop or screen-scraping integration.
- Not reducing dealership headcount, and no wording that implies it.
- Not replacing the OEM's DMS.
- Not multi-OEM before one OEM works end to end.
- Not extracting a shared UI package until a third consumer needs it.

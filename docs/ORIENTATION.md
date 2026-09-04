# Start here

For anybody — person or agent — opening this repository for the first time.

There are about **103,000 lines of hand-written code** here and **five thousand
lines of design register**. Reading it front to back is the wrong move. This
file says what to read, in what order, and what each thing answers.

---

## 1. What this is, in five lines

Four products in one pnpm workspace, sharing **one Postgres database** and
**one Express API**, built for a two-wheeler dealership group in India.

| | Path | What it does |
|---|---|---|
| **DDMS** | `/ddms` | The owner's control panel. Mirrors the dealer's own system read-only and shows what that system cannot. |
| **InsurRouter** | `/` | Motor insurance issuance — fill the payload, pick an insurer, submit by API or browser automation. |
| **VeloDocs** | `/doc-ingest` | Getting data in: an API pull, a dropped spreadsheet, or OCR of a scanned document. |
| **RC Capture** | Expo | Phone camera → OCR → a draft in InsurRouter. |

**DDMS is the centre of gravity.** It began as a fourth product and became the
thing the other three feed.

---

## 2. Read these three, in this order

### First — `CLAUDE.md` (2,200 lines)

**The single most important file.** It is written for an agent picking the
project up cold, and it is organised by *subsystem*, each section explaining
what the thing is, why it is shaped that way, and what was got wrong on the way
there.

Do not skim it. The `>` blockquotes are the load-bearing parts — each one is a
defect that was found and the rule that came out of it. Example:

> **A display cap became a reported figure.** The vehicle row said *"5 people
> are asking for this model"* on a model with 31 open enquiries.

If you only have time for one file, this is it.

### Second — `docs/ddms-requirements.md` (4,965 lines)

**The narrative.** This is how the project actually happened, in order, and it
is the file to read if the question is *why*.

Its shape matters:

| Section | What it holds |
|---|---|
| §1–2 | What DDMS is, and the **requirements register** — R-1 to R-147, each a one-line rule with a status |
| §3 | The objectives, OBJ-1 to OBJ-51 |
| §3a–3n | **Dated entries, in order.** Each is either *planned on* or *built on* a date, and each says what the building taught that the planning did not |

**Read §3a onwards as a diary.** `3i` covers ten objectives in one sitting;
`3k`, `3l`, `3m`, `3n` each cover one and are the most detailed.

Every dated entry ends the same way: a table of new requirements, and a
paragraph headed *what is not built, and named rather than left to be
discovered*.

### Third — the verifiers, `artifacts/api-server/src/scripts/verify-*.ts`

**Twenty-six of them, and they are the proof rather than the tests.**

Each one opens with the objective's *done-when* stated as a sentence that can
fail, then a numbered set of sections that assert it. They are readable top to
bottom and they print English:

```
── 2. **the accrual charges the month, not everything to date** ──
  ✓ October accrues
  ✓ and it is one month's interest, not the whole life of the stock
  ✓ **the same month twice is refused**
```

Run any of them: `pnpm run verify:<name>`. They need the database; two
(`agent`, `ingest`) also need the API and the mock DMS running.

**If a claim anywhere in the docs matters to you, the verifier is where to
check it.** Several of them exist specifically because an earlier version of
themselves passed while the feature was broken.

---

## 3. The map

```
artifacts/
  api-server/src/
    lib/dms/           ← 78 files. The whole product's thinking lives here.
      ledger/          ← the Finance module, 15 files
      journeys/        ← what a sale walks through
      ingest/          ← three ways data arrives
      invoice/         ← the document DDMS issues
      *-worklist.ts    ← seven of these, one per module: sync · build · summarise
    scripts/           ← 26 verifiers + the seeders and exporters
    routes/dms.ts      ← every DDMS endpoint
  ddms/src/pages/      ← 21 screens
  insur-router/, doc-ingest/, rc-capture/, dms-mock/

lib/
  db/src/schema/       ← 61 tables, one file per subject, heavily commented
  db/sql/rls.sql       ← 1,858 lines of row-level security. Not optional reading.
  api-spec/openapi.yaml ← the API contract. api-zod and api-client-react
                          are GENERATED from it — never hand-edited.

docs/
  ddms-requirements.md ← the narrative
  ORIENTATION.md       ← this file
  ddms-fixture-shapes.md, dms-data-model.md, new-vehicle-issuance-fields.md

sample-reports/
  from-the-dealer/     ← eight exports per dealer code — what DDMS reads
  from-ddms/           ← thirteen reports per company — what a CA opens
```

**Two sources of truth, one direction of flow.** `lib/db/src/schema/` defines
the tables; `lib/api-spec/openapi.yaml` defines the API; the two generated
packages come *from* the spec.

---

## 4. How this project reads differently from most

Four habits, and noticing them early saves a lot of confusion.

**Comments carry arguments, not descriptions.** A docstring here usually
explains what was *rejected* and why. When one says *"warned rather than
refused"* or *"this is a checked refusal rather than a guaranteed one"*, that is
the design, not a hedge.

**Limits are stated rather than hidden.** Two of the ten reconciliations
report *not run* because nothing imports a bank statement or GSTR-2B. `ran` and
`clean` are separate fields for exactly this reason: *a tick beside a control
nobody has performed is worse than the gap.*

**Nothing computes a figure twice.** Where two screens quote the same number,
one function is exported and both import it. Where that was violated, a verifier
now asserts the two agree.

**No model anywhere near a decision.** `classify()` decides what is wrong; a
rule decides what may be done. A model may only *phrase*, and `checkRewrite()`
/ `citationsHold()` accept its output only if it invents no figure. The ledger
has no model in it at all and nowhere one could go.

---

## 5. The arc — how it got from there to here

Twenty-four days, 104 commits, 28 July to 20 August 2026.

### Phase 1 · InsurRouter (late July)

An agent-facing insurance dashboard. A flat 26-column MSA payload, six insurers,
and two execution paths — a provider's REST API, or Playwright browser
automation with a screenshot at every step.

**What it taught:** the browser path is SSRF-exposed by construction, because a
user supplies the URL. `validateUrlSsrf()` and a `page.route()` re-validation on
every request are load-bearing and still there.

### Phase 2 · VeloDocs and RC Capture

Getting data *in*. An OCR chain over four vision models with a fallback ladder,
a portal scraper, and a phone app.

**What it taught:** *the stub is never reachable automatically.* It returns an
invented chassis number at high confidence, and a chain that quietly fell
through to it would put fiction into a real insurance application.

### Phase 3 · DDMS begins — the mirror

Seven read-only mirrors of the dealer's own system, each with **mirror fields**
(theirs, never written back) and **decision fields** (what this product
concluded). The premise in one line: *a DMS keeps the parts ledger against a
dealer code, so an owner with three outlets gets three ledgers and no way to ask
whether the part a customer is waiting for is on a shelf in the next branch.*

### Phase 4 · Who is asking (OBJ-8, OBJ-14)

Sessions, roles, and **four database credentials** — one per job, because two of
the jobs happen with nobody signed in. `ddms_app` holds no grants on `users` at
all, which is what makes a leaked credential worthless.

**Three predicates ANDed, never ORed:** owner, outlet, module. Each can only
take away, so *the direction of a mistake is safe.*

### Phase 5 · From screens to a queue (OBJ-13, OBJ-15)

`record_events` — the derived state moving, which is the only thing a rule can
fire on. Then one queue across all seven modules, in three bands, and the middle
one is the point: **work assigned to somebody who left is on nobody's list and
is not late by any measure the DMS holds.**

### Phase 6 · Doing things (OBJ-16 to OBJ-22)

Rules capped at twelve, in code. An outbox where **nothing leaves without either
a rule permitting it or a person approving it**. An agent that calls the same
`applyAction()` a button calls, with two of twelve grants — the other ten
withheld with a written reason each, because they assert *a person did
something*.

### Phase 7 · Autonomy earned rather than set (OBJ-26)

Everyone builds autonomy as a dial somebody sets. This is a **count**: watching
→ recall → pre-filled → automatic, and the graduation *is* the safety mechanism.
Precedent is a query, not a store, so there is no ingestion surface to poison.

### Phase 8 · Documents and books (OBJ-25, OBJ-30 to OBJ-33)

An invoice DDMS issues, then a double-entry ledger under it. **The first thing
in the product where being wrong is a filing offence rather than a bad morning.**

### Phase 9 · Finance as a module (OBJ-36 to OBJ-45, 13 August)

Ten objectives in one sitting. The hierarchy `owner → entity → registration →
branch`; parties and bills; delivery challans; money in and out; the books a CA
opens; period locks; GSTR-3B; ten reconciliations.

**The defect it existed to close:** the ledger knew *one* of four money events.
Every sale credited Vehicle Stock and nothing debited it — a ledger that
balances per voucher and is unfilable in aggregate.

### Phase 10 · The network (OBJ-46 to OBJ-48, 14 August)

Saraswati became five branches on one GSTIN. Parts travel on the same challan a
machine does; one morning's allocation is one decision; head office gets an
evening.

**R-124 came out of this:** *a dealership's shape is proved by data, not by
structure.* Hub-and-spoke was expressible from OBJ-37 and was a diagram until
business ran through five branches.

### Phase 11 · Handover (OBJ-49, 18 August)

Asked for as a case view, sharpened into: *when the advisor is off, the manager
picks it up cold.* Found that the timeline read what somebody **wrote down** and
not what somebody **did** — so pressing *Mark customer told* left no trace on
the record's own history.

### Phase 12 · The cost side (OBJ-50, OBJ-51, 19 August)

Reading the chart out of the database made the gap one line long: **28 accounts,
three of them expenses, two of those cost of goods sold.** So the P&L was a
gross-margin statement with a P&L's title, and no route in the product touched
`ledger_accounts` at all.

A journal voucher — the eighth door into the books and the only one that starts
from a person rather than a document — plus the financier as the real creditor
on a floor-plan purchase, and the interest that had been computed to the rupee
and posted nowhere.

---

## 6. Where the honest gaps are

Every dated entry in the register ends with these, and they are worth reading
before forming a view of completeness:

- **Two reconciliations cannot run** — nothing imports a bank statement or
  GSTR-2B, and they report *not run* rather than *clean*.
- **`1500 Bank Accounts` is one account**, so a dealership with three bank
  facilities cannot reconcile any of them.
- **Insurance commission is booked nowhere**, and `policies` carries no premium
  — the group sells as a broker and the income is invisible.
- **Two OEM receivables are reports rather than balances** — warranty claimable
  and the scheme.
- **No year-end close**, no credit notes, no fixed assets, no TDS beyond a
  payable head.
- **The transport registry is empty** for email; a message that cannot be sent
  lands in `HELD_NO_TRANSPORT` and says so rather than showing a green tick.

None of these are hidden. Each is named in the docs and most are named on the
screen the user would otherwise be misled by.

---

## 6b. What is parked

Three objectives are registered and deliberately not built — OBJ-52 (the
registry offered over MCP), OBJ-53 (a journey a dealership can add without a
deploy), OBJ-54 (the agent loop separable from the agent). `docs/ddms-requirements.md`
§3o says why, and why the shopping-agent half of the blueprint they came from is
deliberately not taken.

**Do not treat these as work in progress.** Nothing is half-built for them, and
no requirement depends on them.

## 7. If you are an agent, do this

1. Read `CLAUDE.md` end to end. Do not skip the blockquotes.
2. Read `docs/ddms-requirements.md` §1, §2, then §3e (*Reconciled 12 August —
   the register against what was built*) and every dated entry after it.
3. Pick the subsystem the task touches and read its verifier before its source.
   The verifier states the claim; the source is how it is met.
4. Before changing schema: `lib/db/sql/rls.sql`, and **run `pnpm run db:rls`
   after every `db:push`** — a new table arrives with RLS on and no policy.
5. Before changing an API shape: edit `openapi.yaml`, then
   `pnpm --filter @workspace/api-spec run codegen`. Never hand-edit the
   generated packages.

The gotchas that cost the most time are collected at the end of `CLAUDE.md`.

---

## 8. The facts, for a CV or an interview

| | |
|---|---|
| Scale | ~103,000 lines hand-written; 61 tables; 26 verifiers; 21 screens |
| Duration | 24 days, 104 commits |
| Stack | TypeScript · React 19 · Express 5 · Drizzle · Postgres (Supabase) · Playwright · Expo · pnpm workspace |
| Design record | 5,000 lines: 51 objectives, 147 requirements, each with a status and a rationale |
| Domain | Indian GST (rates from 22 Sep 2025, the 350cc boundary, GSTR-1/3B, TCS 206C(1F), e-invoicing), double-entry bookkeeping, IRDAI intermediary rules, RTO registration |

**What is genuinely unusual about it, in three claims you can defend:**

1. **A four-credential security model where the application cannot bypass its
   own isolation.** The API server refuses to start if handed the credential
   that bypasses row-level security. `ddms_app` cannot read `users`, so it
   cannot read a session token hash, so holding its password gets you exactly as
   far as holding no session at all. `pnpm run db:probe` prints what each login
   can actually reach — a check rather than a claim.

2. **Autonomy as an earned count rather than a configured dial.** Four rungs,
   evidence derived from append-only logs, consent stored only at the top rung,
   and a floor set by the same permission table that answers for a human. A
   pattern people keep overruling demotes itself.

3. **Verifiers written to fail rather than to pass.** Several were rewritten
   after they passed on a broken feature — a mutation that removed a filter left
   twenty-two checks green because the defect landed on both sides of every
   comparison. That story is in `CLAUDE.md` under *the overall view*.

**What to say about the AI-assisted part, if asked:** the code was written with
Claude Code across the whole period, and the artefact that makes it defensible
is `docs/ddms-requirements.md` — the decisions, the rejected alternatives and
the defects are recorded as they happened, so any claim in the codebase can be
traced back to the conversation that produced it and the check that proves it.

---

## 9. Branches

| | |
|---|---|
| `main` | the original three products, before DDMS grew |
| `dealer-new-vehicle` | preserved deliberately — one dealership as a single outlet |
| **`dealer-hub-and-spoke`** | **current.** Saraswati as five Delhi branches on one GSTIN |

`dealer-new-vehicle` is kept so the same owner can be modelled in two shapes;
`docs/ddms-fixture-shapes.md` explains how to build the second one in four
inserts and no code change.

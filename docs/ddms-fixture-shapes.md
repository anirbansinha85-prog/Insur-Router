# The fixture, and the four shapes it can take

*Written 13 August 2026, on `dealer-new-vehicle`, with OBJ-1 to OBJ-45 closed
and 21 verifiers green.*

This document exists because the branch it sits on is a **version** — a working
state somebody may come back to in six months — and a fixture nobody can read is
a fixture nobody can trust. It records exactly what is in the database, which
parts of it are real and which are scaffolding, and how to get from here to any
of the other shapes a dealership takes.

---

## 1. What is actually in the database

```
 id  code             role      entity                          GSTIN             state         DMS account        data
  1  DEL-SARASWATI    HUB       Saraswati Automobiles Pvt Ltd   07AAACS1234A1Z5   Delhi         HMC-DL-0417        deals 78  stock 97  jobcards 104
  9  DEL-SAR-JANAK    SALES     Saraswati Automobiles Pvt Ltd   07AAACS1234A1Z5   Delhi         (none)             empty
 10  DEL-SAR-OKHLA    SERVICE   Saraswati Automobiles Pvt Ltd   07AAACS1234A1Z5   Delhi         (none)             empty
  2  PUN-DECCAN       HUB       Deccan Two Wheelers LLP         27AACFD5678B1Z9   Maharashtra   HMC-MH-1182        deals 1   stock 2   jobcards 2
  7  MUM-MALHOTRA     HUB       Malhotra Motors Pvt Ltd         27AAECM4411R1Z2   Maharashtra   (none)             empty
```

One owner (`SARDECC`), **three legal entities**, three GST registrations, five
branches, across **two states**.

### Read it like this

```
owner            the group. A commercial fact — "these outlets are the same person's"
 └─ entity       the COMPANY. One PAN, one set of books, one balance sheet
     └─ registration   one GSTIN per state. One GSTR-1, one GSTR-3B
         └─ branch     a place with a door. A cost & profit centre, with a role
```

Each level answers a different question, and asking at the wrong one gives a
number that means nothing:

| Question | Answered at | Report |
|---|---|---|
| Whose money is this? | **entity** | trial balance, P&L, balance sheet |
| Who files this return? | **registration** | GSTR-1, GSTR-3B |
| Where did this happen? | **branch** | day close, cash book, branch P&L |

### What is real and what is scaffolding

**Real, with data behind it:** `DEL-SARASWATI` and `PUN-DECCAN`. Both have a DMS
account, both have mirrored deals, stock and job cards, and both appear in
`sample-reports/`.

**Structurally real, commercially empty:** `DEL-SAR-JANAK`, `DEL-SAR-OKHLA`,
`MUM-MALHOTRA`. They resolve, they can be transferred stock, their tills close
and their P&L draws — the verifiers do all of that. **No seeded business flows
through them.** Open a branch screen for Janakpuri today and it is a blank page.

The first two were created deliberately by `scripts/src/migrate-org.ts` so that
hub-and-spoke had somewhere to happen; without them the fixture was three
companies at one branch each and never exercised the ordinary shape at all.
Malhotra's missing DMS account is **not** deliberate — it is a gap in the
original owner seed.

### Why two branches have no DMS account, and it is not a gap

**A satellite genuinely does not have one.** Hero issues a dealer code to a
*dealership*, not to every shopfront. Janakpuri books and delivers against the
hub's `HMC-DL-0417`. There is nothing to connect it to.

**A service centre never has one.** Okhla is an authorised service centre with
no sales franchise, so no dealer code for it exists anywhere in Hero's system.
This was anticipated in OBJ-3 and is written into `lib/db/src/schema/showrooms.ts`:
*"a service centre has no dealer code at all and still needs to appear in the
owner's view."*

That is exactly why `showroom_dms_accounts` is a separate table rather than a
column. One owner may hold two brands at one address (two codes, one showroom);
one brand may sell from three outlets (one code family, three showrooms); a
service centre has none. The extra join costs nothing and survives all three.

---

## 2. The four shapes, and where each one is exercised

The whole claim of OBJ-37 is that **one code path serves all four** — the
hierarchy is four foreign keys and the shapes fall out of them, with no branch
in the code. `verify-org.ts` §3 proves it literally: it reads the resolver's own
source and asserts that `HUB`, `SARASWATI`, `hubAndSpoke` and `isSubDealer`
appear nowhere in it.

| # | Shape | Entities | Regns | Branches | In this fixture? |
|---|---|---|---|---|---|
| 1 | **A group of companies** | 2+ | 2+ | n | ✅ **live** — Saraswati, Deccan, Malhotra |
| 2 | **One company, two states** | 1 | 2 | n | ⚠️ built and torn down inside `verify-org.ts` |
| 3 | **Hub-and-spoke, one city** | 1 | 1 | 3+ | ⚠️ structure live (Saraswati + 2 satellites), no data |
| 4 | **The sub-dealer** | 1 | 1 | 1 | ✅ **live** — Deccan, and Malhotra |

Shape 4 matters more than it looks: **the dealership OBJ-30 exists for is this
same structure with every count at one.** Nothing special-cases it.

### Shape 2 is the one people get wrong

One company, one PAN, one balance sheet — and **two taxable persons**, because
GST treats distinct registrations as distinct persons whoever owns them. Moving
a chassis between its Delhi and Karnataka branches *is* a taxable supply.

That is decided in `lib/dms/org.ts` by `transferIsSupply`, from the two
placements, and nobody is asked. It is expensive in both directions:

```
  same registration        no supply    challan, no tax invoice, no GST, NO VOUCHER
  different, same state    a supply     challan + tax invoice, CGST + SGST, a voucher
  different, other state   a supply     challan + tax invoice, IGST,        a voucher
```

Charging GST on an internal transfer inflates output tax and the return, and
hands the government money the dealership does not owe — quietly, monthly, until
somebody checks. Not charging it on a cross-registration move is tax short-paid.

---

## 3. How to build shape 2 — one owner, two states, one company

This is the case the current fixture does **not** hold and the one most likely
to be wanted next. It is deliberately small: four inserts and no code change.

### What it means

Today Saraswati (Delhi) and Deccan (Maharashtra) are two companies. Shape 2 is
**one** company registered in both — one PAN, one set of books, one balance
sheet, two GSTINs, two GSTR-1s. That is a dealership that expanded across a
state line without incorporating separately, which is common and is why the
schema models it.

### The steps

**1. Add a second registration to an existing entity.** It hangs off the entity,
not the branch:

```ts
await ownerDb.insert(gstRegistrationsTable).values({
  ownerId: 1,
  entityId: <Saraswati's id>,        // the SAME company
  gstin: "29AAACS1234A1Z1",          // 29 = Karnataka; chars 3-12 are the PAN
  state: "Karnataka",
  stateCode: "29",
});
```

The GSTIN is not arbitrary. Characters 3 to 12 **are the PAN**, which is why two
registrations sharing a PAN are one legal person. Keep them consistent or the
data will contradict itself the first time anybody looks closely.

**2. Point branches at it.** A branch carries `entityId` *and* `registrationId`,
and both must be set — `placementOf` throws rather than guessing, because an
invoice with no legal name and no GSTIN is not a tax invoice.

```ts
await ownerDb.update(showroomsTable)
  .set({ entityId: <Saraswati's id>, registrationId: <the new one>, role: "HUB" })
  .where(eq(showroomsTable.code, "BLR-SARASWATI"));
```

**3. Nothing else changes.** Not one line of application code. The trial balance
covers both states because it is drawn per **entity**; the two returns are drawn
per **registration** and neither knows the other exists; a transfer between them
becomes a taxable supply on its own.

**4. Check it landed:**

```
pnpm --filter @workspace/scripts run org        # the four shapes
pnpm --filter @workspace/scripts run books      # the trial balance still balances
pnpm --filter @workspace/scripts run returns    # one return per registration
```

### The worked example already exists

`verify-org.ts` §2 builds exactly this — `TMPTWOSTATE`, two GSTINs, three
branches — asserts the four claims and tears it down. **Read that before
building it for real**; it is forty lines and it is the shape, tested.

### What you would also want to change

| | Why |
|---|---|
| `place_of_supply` on new sale documents | it decides CGST+SGST against IGST, and a Karnataka branch selling in Karnataka is intra-state under *its* GSTIN, not Delhi's |
| the invoice series | unique per GSTIN per financial year (R-118). `series_scope` on the registration is `REGISTRATION` or `BRANCH`; both are lawful |
| `sample-reports/` | it is **exported**, never authored — see below |

---

## 4. The rule that governs `sample-reports/`

> **Nothing in there is invented.** Every value is read out of the mirror this
> dealership already has. A second, made-up book would give the product two
> versions of one dealership, which is the failure it exists to fix.

The sixteen CSVs are produced by `pnpm run db:export-reports` reading the
database. **The order is always seed → export, never the other way.** Writing a
CSV by hand for a branch with no data behind it breaks the one rule the corpus
rests on, and the files stop being regenerable.

Three constraints decide what may appear in one:

- **Mirror fields only, never decision fields.** A dealer's system knows the
  chassis number and the invoice number. It has never heard of `rtoChasedAt` —
  that is what DDMS concluded, and a file carrying it would be the product
  reading its own output back as evidence.
- **Their vocabulary.** `Deal No`, not `dealId`. Headings that matched our column
  names would prove nothing about the mapping.
- **Their formats.** `dd/mm/yyyy`, `₹ 1,24,500.00`, a title row above the
  headings and a total row underneath — the total row is the one that once
  arrived as a deal priced at 78.

There is also a real gap worth knowing: **the finance-side raw data has no
mirror.** `dms_deals` exists because the OEM's DMS has it. There is no
`dms_purchases` — a dealership's purchase register arrives once, at onboarding,
to establish opening stock and creditors. It is an *ingest* format, not a mirror,
and nothing has been built for it yet.

---

## 5. Where this version stands

| | |
|---|---|
| Objectives | 45 of 45 |
| Requirements | 123 of 123 |
| Verifiers | 21, all green |
| Money events | all four — purchase, sale, receipt, payment |
| Documents | sale, purchase, challan, service, receipt, payment, day close, opening |
| Returns | GSTR-1, GSTR-3B, TCS, e-invoicing readiness |
| Reconciliations | 8 that run, 2 that say why they cannot |

### Known incomplete, named rather than left to be found

1. **Three branches are empty.** Janakpuri, Okhla and Malhotra resolve and post
   but hold no business. Hub-and-spoke is a structure here, not yet a screen.
2. **Malhotra has no DMS account** — an unintentional gap in `seed-owners.ts`.
3. **Five second sources do not exist**: a bank statement import, a GSTR-2B
   import, the financier's sanction list, a customer PAN for the TCS statement,
   and the IRP call that returns an IRN. Each is why the control that needs it
   says on its face that it has not run.
4. **`showrooms.legal_name` and `showrooms.gstin` are deprecated**, read by
   nothing, and left in place through one migration so this run can be checked
   against what they said. They should be dropped in whichever branch next
   touches the schema.

### How to rebuild this fixture from nothing

```
pnpm install                      # from Git Bash on Windows
pnpm run db:push
pnpm run db:rls                   # ALWAYS after a push
pnpm run db:seed-owners
pnpm run db:seed-users
pnpm run db:seed                  # providers
pnpm run db:seed-applications
pnpm run db:migrate-org           # entities, registrations, roles, satellites
pnpm run db:seed-pricelists
pnpm run db:export-reports        # regenerates sample-reports/
```

---

## 6. Branches

| Branch | What it is |
|---|---|
| `dealer-new-vehicle` | **this version.** OBJ-1 to OBJ-45, three companies, two states. Preserved as a working state and not to be overhauled in place |
| `dealer-hub-and-spoke` | branched from here on 13 Aug 2026, to reshape the fixture toward one Bengaluru company running hub-and-spoke, and to build the raw data the processes need |

A branch is a copy — nothing on this one changes because work happens on that
one, and either can be returned to at any time.

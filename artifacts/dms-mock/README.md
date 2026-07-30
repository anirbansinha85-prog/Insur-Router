# dms-mock

A stand-in for the OEM dealer-management system InsurRouter pulls from, plus a
**demonstrable dealer portal** on top of it, so the story can be shown to a
dealer before anyone has real DMS access.

**Development fixture only.** State is in memory and resets on restart. It has no
database, no real auth, and must never be deployed anywhere reachable.

For *what* fields a policy needs and why, see
[`docs/new-vehicle-issuance-fields.md`](../../docs/new-vehicle-issuance-fields.md).
This file covers how the mock behaves.

## Run

```powershell
$env:DMS_PORT=9090; pnpm --filter @workspace/dms-mock run start
```

Node 24 runs the TypeScript directly — there is no build step.
Then open **http://localhost:9090** for the portal, or hit `/dms/v1/…` for the API.

## The portal

Server-rendered, form-driven, no client framework — it starts instantly, has no
build step, and cannot drift out of sync with the mock's data. The product's real
UI belongs in the React artifacts, not here.

| Path | What it shows |
|---|---|
| `/portal` | KPIs, issuance queue, panel utilisation, volume chart |
| `/portal/deals` | Every booking, searchable |
| `/portal/insurance` | The `AWAITING_INSURANCE` queue, fewest gaps first |
| `/portal/deals/:id` | Full deal — vehicle, customer, nominee, finance, registration |
| `/portal/deals/:id/issue` | Step 1 of issuance |
| `/portal/stock` | Yard stock and allotment |
| `/portal/policies` | Issued policies, and a printable policy schedule |
| `/portal/panel` | The dealer's insurers: route, integration, quota, payout |
| `/portal/service` | Warranty and service schedule per delivered vehicle |
| `/portal/reminders` | Policy-expiry and service-due events |

### The issuance flow

`Confirm details → Choose insurer → Policy issued`, and it genuinely runs:
answers collected at step 1 are **written back onto the DMS record**, the policy
lands on the deal, status advances to `AWAITING_REGISTRATION`, and the insurer's
quota increments. Drive it through the UI and `/dms/v1/deals/:id` reflects it —
the portal and the API cannot tell different stories, because they share the same
records.

Two things are deliberately visible rather than smoothed over:

- **Computed vs estimated.** Third-party premium is fixed by IRDAI and identical
  at every insurer, so that figure is exact. Own damage was detariffed and only
  the insurer's engine is authoritative, so it is labelled an estimate wherever it
  appears. A demo that presents both as final teaches a dealer to distrust the
  tool the first time a portal disagrees.
- **The dealer's real conflict.** The cheapest quote for the customer is usually
  not the best payout for the dealership. Both are badged, and the difference is
  spelled out, instead of one being picked silently. That trade-off belongs to the
  dealership.

**No insurer is ever contacted.** The policy exists only in memory, and the
issued-policy screen says so. Issuing for real needs the dealership's own
credentials — an API where one exists, browser automation where it does not.

### Branding

The portal is presented as **the dealership's own system**, carrying the
dealership name with "Authorised Hero MotoCorp Dealer" as context and a permanent
**Sandbox** badge in the top bar. Hero's brand red (`#D9241C`) is the accent
because that is the OEM context a dealer works in — that is what makes the screen
feel familiar.

The mark is an **original geometric device, not a reproduction of Hero's
trademarked logo**. A demo that embeds a real trademark invites a dealer to assume
an OEM endorsement that does not exist.

The insurance module is badged separately as InsurRouter, because that is the part
being sold. Keeping the boundary visible *is* the pitch: the DMS is theirs, the
automation is ours.

| Variable | Default | Purpose |
|---|---|---|
| `DMS_PORT` | `9090` | |
| `DMS_API_KEY` | `dev-dms-key` | Sent as `X-DMS-API-Key` |
| `DMS_MOCK_LATENCY_MS` | `0` | Adds delay to every `/dms/v1` call |
| `DMS_MOCK_FAIL_RATE` | `0` | Fraction of calls to fail with 503 |

The last two exist to keep the **client** honest. A real OEM DMS is a shared ERP
under load, and an adapter written only against an instant, always-up mock will
fall over the first time it meets one. Turn them on before trusting the client:

```powershell
$env:DMS_MOCK_LATENCY_MS=1200; $env:DMS_MOCK_FAIL_RATE=0.3
```

## Endpoints

All under `/dms/v1`, all requiring `X-DMS-API-Key` except health.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness. Unauthenticated |
| GET | `/dealers/:dealerCode` | Dealer profile and intermediary channel |
| GET | `/models` | OEM catalogue |
| GET | `/deals?dealerCode=&status=` | Worklist. Summary rows, not full records |
| GET | `/deals/:dealId` | Full deal — the main read |
| GET | `/stock/:chassisNo` | Chassis lookup, allocated or free |
| GET | `/deals/:dealId/service-schedule` | Derived, not stored |
| PATCH | `/deals/:dealId/insurance` | Write the issued policy back |
| PATCH | `/deals/:dealId/registration` | Write the registration number back |

Errors return `{ errCode, errDesc }`, which is the shape these systems tend to
use rather than anything RFC-shaped.

### Status flow

```
BOOKED → AWAITING_INSURANCE → AWAITING_REGISTRATION → DELIVERED
```

`PATCH /insurance` advances `AWAITING_INSURANCE → AWAITING_REGISTRATION`.
`PATCH /registration` advances `AWAITING_REGISTRATION → DELIVERED`.

`GET /deals?status=AWAITING_INSURANCE` is the queue this product exists to drain:
every deal in it is a vehicle that cannot be registered until a policy is issued.

## Why the wire format is awkward

Dates are `DD-MM-YYYY`. Money is a decimal string. Codes are uppercase. Field
names are abbreviated (`cc`, `mfgMth`, `financedFlg`) and blocks are denormalised.

This is deliberate. A mock that already spoke InsurRouter's vocabulary would hide
the translation work a real integration needs, and the adapter is exactly where
per-OEM differences get absorbed. **Nothing here should be consumed directly** —
it all passes through an adapter that emits the canonical internal shape.

The structure is representative of an Indian two-wheeler OEM DMS. It is **not a
copy of any vendor's published contract**, and no real dealer API was consulted.
Field *coverage* is researched; field *names* are constructed.

## Seed data

Two dealers, on different channels, because insurer reach differs per dealer:

| Dealer | Channel | Location |
|---|---|---|
| `HMC-DL-0417` | `BROKER` — consolidated platform fronting several insurers | New Delhi |
| `HMC-MH-1182` | `DIRECT_AGENT` — own agency code with one insurer | Pune |

Five deals, each exercising a different branch. A seed set where every record is
complete teaches nothing.

| Deal | What it exercises |
|---|---|
| `HMC-DL-2026-000181` | Complete, cash, nominee captured — the happy path |
| `HMC-DL-2026-000182` | Financed, **nominee null** — the field no document carries |
| `HMC-DL-2026-000183` | **Electric** (kW-rated, `cc` is null), **email null** |
| `HMC-MH-2026-000184` | **Corporate** buyer — `gender`, `dob`, `aadhaar` all null. Second dealer |
| `HMC-DL-2026-000185` | Delivered, insured, registered — write-back fields populated |

Everything is fictional. PANs do not satisfy the real checksum, and only the last
four Aadhaar digits exist at all.

## Notes on specific behaviours

**No registration number on open deals.** Not an oversight. An RTO will not
register a vehicle without live insurance, so a new vehicle has no registration
number when the policy is bought. `000185` has one because it has already been
through the whole cycle.

**Service schedules only exist after delivery.** An undelivered deal returns an
empty `entries` array rather than dates counted from the booking, because there
is no clock to count from yet. Status is date-based only — the DMS does not know
the odometer between workshop visits, so a km target can arrive earlier than the
date suggests.

**Paid services are projected, not stored**, and stop at the warranty horizon.
Staying inside the authorised-workshop schedule is what keeps the warranty alive;
past that the reminder has no leverage.

**The deal list returns summary rows.** Full customer records for rows nobody
opens would be needless PII exposure.

**The dealer switcher is a cookie**, with nothing verifying it. It exists so the
multi-tenant story can be shown: the same screens over a different worklist and a
different insurer panel. `HMC-DL-0417` reaches five insurers through a broker;
`HMC-MH-1182` reaches exactly one, directly — and its routing screen looks
different as a result.

**Premium arithmetic lives in `src/premium.ts`** and is data, not logic: IRDAI TP
bands for both cc and kW, IDV depreciation, zone loading, compulsory PA and GST.
Rates move by government notification, so they belong in one table.

## Restarting resets the demo

Every issued policy, every collected nominee and every quota increment lives in
memory. Restart the process and the seed set is pristine again — which is exactly
what you want before walking into a meeting.

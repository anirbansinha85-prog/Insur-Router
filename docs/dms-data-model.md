# What is actually in a dealer's DMS — and what DDMS adds on top

Written 3 August 2026, before building. The question this answers: *we are
designing a system whose entire premise is pulling from someone else's database,
and we have never seen that database.*

Our mock covers the sales-to-insurance slice — about one and a half modules of
nine. Everything DDMS can decide is bounded by that, which is why it currently
decides one thing.

## The shape of the problem

DDMS holds two kinds of field, and keeping them apart is the whole design:

| | comes from | can we write it | who is authoritative |
|---|---|---|---|
| **Mirror fields** | pulled from the DMS | **no** | the OEM's DMS |
| **Decision fields** | ours | yes | DDMS |

A mirror field is a fact about the dealership's business. A decision field is
what we concluded about it, what we did, and what is still outstanding — none of
which the DMS ever knew. The reconciliation already built is the first instance
of this pattern: `dms_deals.dms_policy_no` is a mirror field, our `policies` row
is a decision field, and the *difference* is the product.

**Every module below follows the same pattern.** That is the point of writing
this down: once the mirror exists, each new automation is "which decision fields
does this need", not a fresh integration.

## What a real DMS contains

Researched against the Indian market — Excellon 5 (Hero, Mahindra Two Wheelers
and others run on it), DealerSetu, aPro, Wheelz. The consistent module list:

| # | Module | What it holds | Ours |
|---|---|---|---|
| 1 | **CRM / enquiry** | leads by source, follow-ups, test rides, lost reasons | ✗ |
| 2 | **Sales** | booking → allotment → invoice → delivery | ◑ partial |
| 3 | **Vehicle inventory** | OEM dispatch, GRN, yard stock, ageing, transit | ◑ stock only |
| 4 | **Insurance** | policy against the deal | ✓ |
| 5 | **Registration** | Form 21/22, RTO file, agent handling | ◑ fields only |
| 6 | **Service / workshop** | job cards, technicians, bays, labour, PSF | ✗ (schedule only) |
| 7 | **Spares** | part master, stock, requisition, counter sales | ✗ |
| 8 | **Finance / accounts** | receipts, outstanding, GST, day book | ✗ |
| 9 | **HR / staffing** | employees, targets, incentives, attendance | ✗ (name only) |

Module 9 matters more than its size suggests. The product is sold on **staff
shortage** — and the DMS is where the evidence of that shortage lives.

## The fictitious DMS

Realistic in shape, not a copy of any vendor's contract. Conventions already
established in `artifacts/dms-mock/src/types.ts` are kept throughout: dates are
`DD-MM-YYYY`, money is a decimal string, codes are uppercase, field names are
abbreviated. **Keeping it awkward is deliberate** — a mock that speaks our
vocabulary hides the translation work a real integration needs.

### 1. CRM / enquiry

```
enquiry      enqId, dealerCode, enqDt, source (WALKIN|PHONE|WEB|REFERRAL|
             PORTAL|CAMPAIGN), custName, mobileNo, modelCodeInterest,
             assignedEmpCode, stage (NEW|CONTACTED|TEST_RIDE|QUOTED|
             NEGOTIATION|BOOKED|LOST), lostReasonDesc, nextFollowUpDt,
             lastContactDt, convertedDealId
followup     fuId, enqId, dueDt, doneDt, outcomeDesc, empCode
testRide     trId, enqId, modelCode, chassisNo, scheduledDt, doneFlg
```

> **The highest-value module we do not have.** An enquiry with a follow-up
> overdue by four days is a customer walking into a competitor. Nobody is
> watching that list either.

### 2. Sales — extends what exists

```
booking      bookingId, enqId, dealId, bookingAmt, bookingDt, expDeliveryDt
deal         (exists) + exchangeFlg, exchangeVehicleDesc, exchangeAmt,
             accessoriesAmt, discountAmt, offerCode
delivery     dealId, pdiDoneFlg, pdiEmpCode, gatePassNo, deliveryDt,
             deliveredByEmpCode, custSignedFlg
```

### 3. Vehicle inventory — extends `DmsStockUnit`

```
oemInvoice   oemInvNo, oemInvDt, dealerCode, dispatchDt, transporterDesc,
             lrNo, expArrivalDt
grn          grnNo, oemInvNo, receivedDt, receivedByEmpCode, damageFlg
stockUnit    (exists) + status (IN_TRANSIT|IN_YARD|ALLOCATED|INVOICED|
             DELIVERED), yardLocDesc, ageingDays
```

> Ageing stock is money sitting still. A unit in the yard 90 days has an
> interest cost the owner is paying and probably cannot see.

### 6. Service / workshop

```
jobCard      jcNo, jcDt, dealerCode, chassisNo, regNo, custId, odometerKm,
             jcType (FREE|PAID|RUNNING_REPAIR|ACCIDENT|CAMPAIGN|WARRANTY),
             advisorEmpCode, technicianEmpCode, bayNo,
             complaintDesc, observationDesc,
             status (OPEN|IN_PROGRESS|AWAITING_PARTS|AWAITING_APPROVAL|
                     READY|INVOICED|DELIVERED),
             promisedDt, actualCloseDt, estimateAmt, finalAmt
jcLabour     jcNo, seq, labourCode, labourDesc, hrs, rateAmt
jcPart       jcNo, seq, partNo, qty, rateAmt, warrantyFlg
psf          jcNo, callDt, satisfactionScore, complaintFlg, remarksDesc
```

Statuses follow the flow every workshop system uses:
`OPEN → IN_PROGRESS → AWAITING_PARTS → AWAITING_APPROVAL → READY → INVOICED`.

> `AWAITING_PARTS` and `AWAITING_APPROVAL` are the two states where a vehicle
> sits still because **a human did not make a phone call**. That is the same
> shape as `AWAITING_INSURANCE`, and the same automation applies.

### 7. Spares

```
partMaster   partNo, partDesc, mrpAmt, hsnCode, gstRate, modelApplicability[]
partStock    dealerCode, partNo, qtyOnHand, qtyReserved, reorderLevel,
             binLocDesc, lastReceiptDt
partReq      reqNo, jcNo, partNo, qty, status (REQUESTED|ISSUED|SHORT|RETURNED)
```

### 8. Finance / accounts

```
receipt      rcptNo, rcptDt, dealerCode, custId, againstType (BOOKING|
             INVOICE|JOBCARD), againstRef, modeDesc (CASH|UPI|CARD|NEFT|
             FINANCE), amt
outstanding  custId, againstType, againstRef, invoiceAmt, receivedAmt,
             balanceAmt, dueDt, ageingDays
```

### 9. HR / staffing

```
employee     empCode, empName, dealerCode, role (SALES_EXEC|ADVISOR|
             TECHNICIAN|RTO_AGENT|ACCOUNTS|MANAGER), doj, dol, activeFlg,
             mobileNo
target       empCode, periodYm, targetUnits, achievedUnits
attendance   empCode, dt, presentFlg
```

> This is the module that proves the pitch. `dol` (date of leaving) populated
> across six months *is* the attrition rate. Enquiries assigned to a departed
> employee are leads nobody is following.

## What DDMS adds — the decision fields

The half that is ours. This is what makes DDMS more than a viewer.

| Module | Mirror says | DDMS decides |
|---|---|---|
| CRM | follow-up due 4 days ago | `contact_attempted_at`, `channel`, `agent_draft_message`, `escalated_to`, `outcome` |
| Sales | invoiced, not delivered | `delivery_blocker` (insurance / RTO / payment / PDI), `blocked_since`, `owner_notified_at` |
| Inventory | in yard 94 days | `ageing_flagged_at`, `carrying_cost_estimate`, `suggested_action` |
| Insurance | no policy | *(built)* `application_id`, `reconcile` derived, `action_required` |
| Registration | no reg no | `rto_file_status`, `agent_assigned`, `days_with_agent` |
| Service | AWAITING_PARTS 3 days | `customer_informed_at`, `part_eta`, `promise_breached` |
| Spares | qty 0, reorder 5 | `reorder_raised_at`, `stockout_cost` (job cards blocked) |
| Finance | balance ₹18,400, 41 days | `chase_stage`, `last_reminder_at`, `write_off_risk` |
| HR | 3 left in 90 days | `coverage_gap`, `reassigned_to`, `unworked_queue_size` |

Read the middle column and the right column together and the product states
itself: **the DMS records what happened; DDMS records what was decided about
it, and what still has not been.** No DMS has that second column, because a DMS
is a system of record and this is a system of follow-through.

## Access

The mock keeps its current contract and grows:

```
GET /dms/v1/health
GET /dms/v1/dealers/:dealerCode
GET /dms/v1/models
GET /dms/v1/deals            ?status= &fromDt= &modifiedSince=
GET /dms/v1/deals/:dealId
GET /dms/v1/stock/:chassisNo
GET /dms/v1/deals/:dealId/service-schedule
                                            ── new ──
GET /dms/v1/enquiries        ?dealerCode= &stage= &followUpBefore=
GET /dms/v1/enquiries/:enqId
GET /dms/v1/jobcards         ?dealerCode= &status= &modifiedSince=
GET /dms/v1/jobcards/:jcNo
GET /dms/v1/stock            ?dealerCode= &status=      (list, ageing)
GET /dms/v1/parts/stock      ?dealerCode= &belowReorder=
GET /dms/v1/receivables      ?dealerCode= &minAgeingDays=
GET /dms/v1/employees        ?dealerCode= &activeFlg=
```

Every list endpoint takes `modifiedSince`. Without it a mirror has to pull
everything every time, and that is what makes a sync expensive enough that
people turn it off.

**DDMS calls none of the write endpoints.** The mock does expose
`PATCH /deals/:dealId/insurance` and `/registration` — its own portal uses them
to simulate a dealer keying data in by hand, which is how the demo forces an
`IN_SYNC` or `CONFLICT` state. That they exist and DDMS still never calls them
is the point: the constraint is ours to honour, not theirs to enforce.

### Two structural changes to the mock

1. **It gets its own database — SQLite, via Node's built-in `node:sqlite`, one
   file on disk.** Two reasons. State currently dies with the process, which has
   already produced one false conclusion this project (a stale mock made deals
   look pre-insured, and that went into the session log as fact before being
   retracted). And a separate file makes the boundary physical: nothing can
   accidentally join the OEM's tables against ours, because they are not in the
   same database. No new dependency.

2. **A dashboard**, because the mock is now big enough that reading it through
   `curl` is not viable, and because a demo needs a visible "their system" next
   to "our system". It shows what a dealership manager's screen shows —
   enquiries due, job cards open, stock ageing, receivables — deliberately as
   the flat unhelpful lists a real DMS gives, so the contrast with DDMS is the
   argument.

## Build order

Each step is useful alone, and each earns the next.

1. **SQLite + the existing entities**, endpoints unchanged. Nothing visible
   changes; state stops dying on restart.
2. **Service / workshop** — job cards, technicians, parts lines. Biggest module,
   and `AWAITING_PARTS` / `AWAITING_APPROVAL` are the same "stuck waiting for a
   human" shape we already solved once, so DDMS gets a second worklist almost
   free.
3. **CRM / enquiry** — highest commercial value, hardest to fake convincingly.
4. **Inventory ageing, receivables, HR** — smaller, mostly list-and-flag.
5. **Spares** — only genuinely useful once job cards exist.
6. **The DMS dashboard**, once there is enough in it to be worth showing.

Sources:
[Excellon DMS](https://www.excellonsoft.com/) ·
[Excellon — Mahindra Two Wheelers](https://www.rushlane.com/mahindra-two-wheelers-dealer-management-software-from-excellon-12101552.html) ·
[DealerSetu — what is automotive DMS](https://dealersetu.com/what-is-automotive-dms-software/) ·
[DealerSetu — best DMS in India](https://dealersetu.com/best-dealer-management-software-in-india/) ·
[aPro — TVS showroom and workshop](http://aprosolution.in/blog/Manage-TVS-two-wheeler-showroom-and-Workshop) ·
[Wheelz](https://www.wheelzonline.co.in/)

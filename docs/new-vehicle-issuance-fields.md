# What a new two-wheeler policy actually requires

Reference for the `dealer-new-vehicle` branch. Scope is deliberately one case: **a
dealer selling a brand-new two-wheeler**, insured at the point of sale.

Everything below is either sourced (linked) or marked as needing confirmation.
The single highest-value missing input is a real dealer-channel proposal form —
field *names* here are constructed, field *coverage* is researched.

## Why this case is small

Three facts collapse most of the complexity:

1. **Third-party cover is compulsory** under s.146 of the Motor Vehicles Act
   1988, and no vehicle can be registered without it.
2. **New two-wheelers sold since September 2018 must carry a 5-year third-party
   policy**, bundled at the point of sale. The customer cannot decline it and
   cannot buy it annually.
3. **TP premium is fixed by IRDAI and rated on engine capacity alone.** Every
   insurer charges the identical figure. There is nothing to compare and nothing
   to negotiate.

And because the vehicle is new, an entire category of fields drops out: no
previous insurer, no policy number, no expiry date, no No Claim Bonus, no claims
history, no pre-inspection. Real proposal forms carry a whole "Previous Insurance
Details" block that is `N/A` for every deal in this scope.

## The paradox that shapes the data model

An RTO will not register a vehicle without live insurance. So at the moment the
policy is issued:

- **there is no registration number** — the policy is issued against the
  *chassis number*, and endorsed with the registration number weeks later
- **there is no RC book** — the document VeloDocs was originally built to read
  does not exist yet
- what *does* exist is **Form 21** (dealer's sale certificate), **Form 22**
  (manufacturer's roadworthiness certificate), the **tax invoice**, and the
  customer's **KYC**

Any lookup keyed on registration number is unusable in this scope. The natural
key is the chassis number, or the dealer's own deal ID.

## Where the data really comes from

The important realisation: with a DMS in place, **almost none of the vehicle data
comes from a document**. The dealer allocated a physical unit from stock, so
every vehicle attribute is already authoritative in their own system.

| Group | Source | Notes |
|---|---|---|
| Vehicle identity and specs | **DMS** | Chassis, engine, model, variant, cc/kW, colour, mfg month/year, seating |
| Ex-showroom price | **DMS** | Drives IDV, which drives the own-damage premium |
| Customer name, address, DOB | **KYC document** → OCR | Aadhaar / PAN. IRDAI has mandated KYC for all policies since 1 Jan 2023 |
| Mobile, email | **Asked** | No document carries them |
| Nominee | **Asked** | See below — the notable gap |
| Hypothecation | **Loan sanction** / DMS | Most two-wheelers are financed |
| RTO code | **Derived from pincode** | Not extracted; there is nothing to extract it from |
| Registration number | **Does not exist yet** | Written back after the RC is issued |

OCR's role in this scope is therefore narrow and specific: **read the customer's
KYC**. That is a real reduction from what VeloDocs was built to do, and it is the
honest consequence of the paradox above.

### The nominee gap

The compulsory owner-driver personal-accident cover requires a nominee — name,
age and relationship, plus an appointee if the nominee is a minor.

**No document a customer brings to a dealership carries this.** Not the invoice,
not Form 21, not Aadhaar, not the PAN card. A vehicle sale has no reason to
collect it either, so a DMS usually will not have it.

It must be *asked*, every time, and there is no fallback. Deal `000182` in the
mock is seeded with a null nominee specifically so this cannot be forgotten.

## Field table

Status column: **DMS** = in the mock, **ASK** = must be collected from the
customer, **DERIVE** = computed from another field, **LATER** = does not exist at
issuance.

### Vehicle — all mandatory

| Field | Status | Notes |
|---|---|---|
| Make / model / variant | DMS | |
| Cubic capacity | DMS | **Sets the entire TP premium.** Null on electric |
| Motor rating (kW) | DMS | Electric only — EVs are rated on kW, not cc |
| Chassis number | DMS | The natural key in this scope |
| Engine number | DMS | |
| Manufacture month / year | DMS | Affects IDV depreciation |
| Seating capacity | DMS | |
| Fuel type | DMS | Also selects the rating basis (cc vs kW) |
| Ex-showroom price | DMS | Basis for IDV |
| Colour | DMS | Printed on the policy and the RC |
| Indigenous / imported | DMS | Asked explicitly on real forms |
| Registration number | **LATER** | Endorsed after the RC is issued |

### Proposer

| Field | Status | Notes |
|---|---|---|
| Salutation, first / middle / last name | DMS | |
| Date of birth | DMS | Null for corporate buyers |
| Gender | DMS | Current forms offer a third option; null for corporates |
| Full address, split to components | DMS | House, building, street, locality, city, district, state |
| Pincode | DMS | Also drives the RTO derivation and the OD zone |
| Mobile | DMS / ASK | |
| Email | **ASK** | Policy delivery. Frequently absent — deal `000183` |
| PAN | DMS | |
| Aadhaar | DMS | Masked to last 4 in the DMS; full number needs the document |
| GSTIN | DMS | Corporate buyers only |
| Occupation | DMS | |
| Urban / rural segment | DMS | Appears on current proposal forms |

### Nominee — mandatory for the compulsory PA cover

| Field | Status |
|---|---|
| Nominee name | **ASK** |
| Nominee date of birth / age | **ASK** |
| Relationship to proposer | **ASK** |
| Appointee name + relationship | **ASK**, when the nominee is a minor |

### Hypothecation — mandatory when financed

| Field | Status |
|---|---|
| Financed yes/no | DMS |
| Financier name and branch | DMS |
| Loan account number | DMS |

Goes on the policy *and* on the RC. Not optional when a loan exists.

### Coverage — none of this exists in the schema yet

| Field | Notes |
|---|---|
| Cover type | Bundled (1yr OD + 5yr TP) is the default for a new two-wheeler |
| OD start / end | One year |
| TP start / end | Five years |
| IDV | Derived from ex-showroom price less depreciation |
| TP premium | IRDAI table, by cc or kW |
| OD premium | Insurer-specific — this is the only part that varies |
| Compulsory PA cover | ₹15 lakh; requires the nominee. Can be waived only if the customer holds equivalent cover elsewhere |
| Add-ons | Zero-dep, roadside assistance etc. — optional |

### Intermediary — how the dealer reaches the insurer

Real proposal forms carry a block for this, and it maps directly onto the dealer
model: intermediary name, code, contact, sales-person name and code, POS UID, and
issuing-office code. In the mock this is `dealer.intermediary`, with two channels
seeded:

- **`BROKER`** — the dealer transacts on a broker's consolidated platform that
  fronts several insurers behind one login. Integrating that one platform reaches
  every insurer on it.
- **`DIRECT_AGENT`** — the dealer holds its own agency code with a single insurer
  and uses that insurer's portal.

## IRDAI third-party premium rates

Rated on engine capacity alone. FY 2025–26 figures; most bands have been
unchanged since the 2022–23 revision. **These move by government notification —
keep them in configuration, never as constants in code.**

### Petrol two-wheelers

| Engine capacity | 1 year | 5 years (new vehicle) |
|---|---|---|
| Up to 75cc | ₹538 | ₹2,901 |
| 75cc – 150cc | ₹714 | ₹3,851 |
| 150cc – 350cc | ₹1,366 | ₹7,365 |
| Above 350cc | ₹2,804 | ₹15,117 |

### Electric two-wheelers — rated on kW

| Motor rating | 1 year |
|---|---|
| Up to 3 kW | ₹457 |
| 3 – 7 kW | ₹607 |
| 7 – 16 kW | ₹1,161 |
| Above 16 kW | ₹2,383 |

The seeded models straddle these bands on purpose: Splendor Plus (97.2cc) and
Xtreme 125R sit in the 75–150 band, Xpulse 200 (199.6cc) crosses into 150–350,
and Vida V2 Plus (6 kW electric) has **no cc at all**. Code that reads `cc`
unconditionally breaks on the last one.

## Still to confirm

1. **A real dealer-channel proposal form.** Confirms the mandatory list and gives
   real field names. Highest-value missing input.
2. **Whether the compulsory PA cover applies to a corporate buyer** the same way.
   A company has no owner-driver. Deal `000184` exists to force this question.
3. **The 5-year TP figures above** are widely republished but should be checked
   against the current IRDAI notification before anything is charged on them.
4. **Hero service intervals** in the mock are representative placeholders, not
   booklet values.

## Sources

- [Motor Vehicles Act third-party requirement — New India Assurance](https://www.newindia.co.in/motor-insurance/own-damage-insurance-for-bikes)
- [Two-wheeler proposal form — Universal Sompo](https://www.universalsompo.com/assets/file/motor-two-wheeler-insurance/motor-two-wheeler-insurance-proposal-form.pdf)
- [Two-wheeler proposal form — SBI General](https://content.sbigeneral.in/uploads/187032942bdf423f994e769a08a42b60.pdf)
- [Standalone long-term TP proposal form — Tata AIG](https://tata-cms.s3.ap-south-1.amazonaws.com/Proposal_Forms_standalone_third_party_long_term_two_wheeler_insurance_policy.pdf_e8471590f0.pdf)
- [IRDAI TP rate table by cc, incl. EV kW bands](https://vehicleinfo.app/rto-news/bikeinsurance/two-wheeler-third-party-premium-rates-irdai)
- [5-year TP rates for new two-wheelers — ACKO](https://www.acko.com/third-party-bike-insurance/)
- [IRDAI TP rate revision — HDFC ERGO](https://www.hdfcergo.com/blogs/two-wheeler-insurance/irdai-increases-third-party-bike-insurance-premiums)
- [Hero warranty: 5 years / 70,000 km motorcycles, 50,000 km scooters](https://www.heromotocorp.com/en-in/services/service-and-maintenance.html)
- [Hero 5-year warranty announcement — BikeWale](https://www.bikewale.com/news/hero-motocorp-announces-5year-warranty-on-all-twowheelers/)

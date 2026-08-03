/**
 * The mock's own database — a SQLite file, separate from ours.
 *
 * Two reasons it is a file and not an array in memory.
 *
 * **State stopped dying on restart.** It used to, and that produced a false
 * conclusion in this project: a mock left running from an earlier session had
 * accumulated issued policies, was read as the seed state, and "deals 181 and
 * 182 ship pre-insured" went into the session log as fact before being
 * retracted. A fixture whose contents depend on how long the process has been
 * up is not a fixture.
 *
 * **The boundary is physical.** The whole premise of DDMS is that the OEM's
 * data lives in somebody else's system and can only be read. Putting it in a
 * different database file means no query can accidentally join their tables
 * against ours — the constraint is enforced by the storage layout, not by
 * remembering.
 *
 * `node:sqlite` is built into Node 24, so this adds no dependency.
 *
 * ── On the two storage styles ────────────────────────────────────────────────
 * Job cards are **fully relational** — header, labour lines, part lines, PSF —
 * because that is the module being demonstrated and because its queries are
 * relational ("job cards with an unissued part"). Deals are stored as a
 * document with the queried fields lifted into columns. That is deliberate: the
 * deal fixtures and the portal that reads them already work, and renormalising
 * them would risk a working pipeline to change nothing anyone can see. The
 * relational shape a real DMS uses for deals is written down in
 * docs/dms-data-model.md, which is where that belongs.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEALERS, DEALS, FREE_STOCK } from "./deals.ts";
import { EMPLOYEES, JOB_CARD_SEEDS, PARTS } from "./workshop.ts";
import { ENQUIRY_SEEDS } from "./crm.ts";
import type {
  DmsDeal,
  DmsEmployee,
  DmsEnquiry,
  DmsJobCard,
  DmsJobCardStatus,
} from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = join(HERE, "..", "data", "dms.sqlite");

/** `DD-MM-YYYY`, the only date format this system knows. */
function dmsDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}

/** `DD-MM-YYYY HH:mm:ss`, what a legacy ERP puts in a modified column. */
function dmsTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dmsDate(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Parse `DD-MM-YYYY[ HH:mm:ss]` back to a Date.
 *
 * Exported because `modifiedSince` filtering needs it and because comparing
 * these as strings would sort by day-of-month — the exact bug the format
 * invites, and the reason an incremental sync against a real DMS has to do this
 * conversion rather than trusting lexical order.
 */
export function parseDmsTimestamp(value: string): Date | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const [, dd, mm, yyyy, hh = "00", mi = "00", ss = "00"] = m;
  const d = new Date(
    Number(yyyy), Number(mm) - 1, Number(dd),
    Number(hh), Number(mi), Number(ss),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

/**
 * Sortable form, stored alongside every displayed date.
 *
 * A real DMS keeps a DATE column and formats on the way out; this mock stores
 * the formatted string, so without a companion column `order by jc_dt` sorts by
 * day-of-month and puts 31-07 above 03-08. These columns never leave the
 * database — the wire format stays awkward, the ordering stays correct.
 */
function isoOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function isoStampOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${isoOf(d)}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

let db: DatabaseSync;

const SCHEMA = `
create table if not exists deals (
  deal_id      text primary key,
  dealer_code  text not null,
  status       text not null,
  chassis_no   text not null,
  policy_no    text,
  reg_no       text,
  modified_at  text not null,
  modified_iso text not null,
  doc          text not null
);
create index if not exists deals_dealer_status on deals (dealer_code, status);

create table if not exists employees (
  emp_code    text primary key,
  emp_name    text not null,
  dealer_code text not null,
  role        text not null,
  doj         text not null,
  dol         text,
  active_flg  text not null,
  mobile_no   text
);

create table if not exists part_master (
  part_no   text primary key,
  part_desc text not null,
  mrp_amt   text not null
);

create table if not exists job_cards (
  jc_no               text primary key,
  jc_dt               text not null,
  dealer_code         text not null,
  chassis_no          text not null,
  reg_no              text,
  cust_id             text not null,
  cust_name           text not null,
  mobile_no           text,
  model_desc          text not null,
  odometer_km         integer not null,
  jc_type             text not null,
  status              text not null,
  advisor_emp_code    text not null,
  technician_emp_code text,
  bay_no              text,
  complaint_desc      text not null,
  observation_desc    text,
  promised_dt         text not null,
  actual_close_dt     text,
  estimate_amt        text not null,
  approved_amt        text,
  final_amt           text,
  modified_at         text not null,
  jc_dt_iso           text not null,
  promised_iso        text not null,
  modified_iso        text not null
);
create index if not exists job_cards_dealer_status on job_cards (dealer_code, status);

create table if not exists jc_labour (
  jc_no        text not null,
  seq          integer not null,
  labour_code  text not null,
  labour_desc  text not null,
  hrs          real not null,
  rate_amt     text not null,
  primary key (jc_no, seq)
);

create table if not exists jc_parts (
  jc_no         text not null,
  seq           integer not null,
  part_no       text not null,
  part_desc     text not null,
  qty           integer not null,
  rate_amt      text not null,
  warranty_flg  text not null,
  issued_flg    text not null,
  primary key (jc_no, seq)
);

create table if not exists jc_psf (
  jc_no              text primary key,
  call_dt            text,
  satisfaction_score integer,
  complaint_flg      text,
  remarks_desc       text
);

create table if not exists enquiries (
  enq_id              text primary key,
  dealer_code         text not null,
  enq_dt              text not null,
  source              text not null,
  grade               text not null,
  stage               text not null,
  cust_name           text not null,
  mobile_no           text not null,
  email_id            text,
  city_desc           text,
  model_code_interest text not null,
  assigned_emp_code   text not null,
  first_contact_at    text,
  last_contact_dt     text,
  next_follow_up_dt   text,
  lost_reason_desc    text,
  converted_deal_id   text,
  modified_at         text not null,
  enq_iso             text not null,
  first_contact_iso   text,
  next_follow_up_iso  text,
  modified_iso        text not null
);
create index if not exists enquiries_dealer_stage on enquiries (dealer_code, stage);

create table if not exists enquiry_followups (
  fu_id        text primary key,
  enq_id       text not null,
  due_dt       text not null,
  done_dt      text,
  outcome_desc text,
  emp_code     text not null
);

create table if not exists test_rides (
  tr_id        text primary key,
  enq_id       text not null,
  model_code   text not null,
  scheduled_dt text not null,
  done_flg     text not null
);
`;

export interface OpenOptions {
  /** `:memory:` is honoured, for a throwaway instance. */
  path?: string;
  /** Wipe and re-seed. The mock's own reset, not something a real DMS has. */
  reset?: boolean;
}

export function openStore(opts: OpenOptions = {}): void {
  const path = opts.path ?? process.env.DMS_DB_PATH ?? DEFAULT_PATH;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal");
  db.exec("pragma foreign_keys = on");
  db.exec(SCHEMA);

  if (opts.reset) {
    for (const t of [
      "deals", "employees", "part_master", "job_cards", "jc_labour", "jc_parts",
      "jc_psf", "enquiries", "enquiry_followups", "test_rides",
    ]) {
      db.exec(`delete from ${t}`);
    }
  }

  seedIfEmpty();
  hydrateDeals();
}

function count(table: string): number {
  const row = db.prepare(`select count(*) as n from ${table}`).get() as { n: number };
  return row.n;
}

function seedIfEmpty(): void {
  if (count("deals") === 0) {
    for (const deal of DEALS) saveDeal(deal);
  }

  if (count("employees") === 0) {
    const ins = db.prepare(
      `insert into employees (emp_code, emp_name, dealer_code, role, doj, dol, active_flg, mobile_no)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of EMPLOYEES) {
      ins.run(e.empCode, e.empName, e.dealerCode, e.role, e.doj, e.dol, e.activeFlg, e.mobileNo);
    }
  }

  if (count("part_master") === 0) {
    const ins = db.prepare(`insert into part_master (part_no, part_desc, mrp_amt) values (?, ?, ?)`);
    for (const [partNo, p] of Object.entries(PARTS)) ins.run(partNo, p.partDesc, p.mrpAmt);
  }

  if (count("job_cards") === 0) seedJobCards();
  if (count("enquiries") === 0) seedEnquiries();
}

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60_000);
}

/**
 * Enquiries, resolved against now to the minute.
 *
 * Days would not do here. An OEM lead is judged on a thirty-minute response
 * window, so a fixture that only knows what day it is cannot demonstrate the
 * thing the module exists to show.
 */
function seedEnquiries(): void {
  const insEnq = db.prepare(
    `insert into enquiries (
       enq_id, dealer_code, enq_dt, source, grade, stage, cust_name, mobile_no,
       email_id, city_desc, model_code_interest, assigned_emp_code,
       first_contact_at, last_contact_dt, next_follow_up_dt, lost_reason_desc,
       converted_deal_id, modified_at,
       enq_iso, first_contact_iso, next_follow_up_iso, modified_iso
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insFu = db.prepare(
    `insert into enquiry_followups (fu_id, enq_id, due_dt, done_dt, outcome_desc, emp_code) values (?, ?, ?, ?, ?, ?)`,
  );
  const insTr = db.prepare(
    `insert into test_rides (tr_id, enq_id, model_code, scheduled_dt, done_flg) values (?, ?, ?, ?, ?)`,
  );

  for (const s of ENQUIRY_SEEDS) {
    const arrived = minutesAgo(s.arrivedMinutesAgo);
    const firstContact =
      s.firstContactAfterMinutes === null
        ? null
        : new Date(arrived.getTime() + s.firstContactAfterMinutes * 60_000);
    const nextFollowUp =
      s.nextFollowUpInDays === null ? null : daysAgo(-s.nextFollowUpInDays);
    const modified = minutesAgo(s.modifiedMinutesAgo);

    insEnq.run(
      s.enqId, s.dealerCode, dmsTimestamp(arrived), s.source, s.grade, s.stage,
      s.custName, s.mobileNo, s.emailId, s.cityDesc, s.modelCodeInterest,
      s.assignedEmpCode,
      firstContact ? dmsTimestamp(firstContact) : null,
      s.lastContactDaysAgo === null ? null : dmsDate(daysAgo(s.lastContactDaysAgo)),
      nextFollowUp ? dmsDate(nextFollowUp) : null,
      s.lostReasonDesc, s.convertedDealId, dmsTimestamp(modified),
      isoStampOf(arrived),
      firstContact ? isoStampOf(firstContact) : null,
      nextFollowUp ? isoOf(nextFollowUp) : null,
      isoStampOf(modified),
    );

    for (const f of s.followUpSeeds) {
      insFu.run(
        f.fuId, s.enqId, dmsDate(daysAgo(-f.dueInDays)),
        f.doneDaysAgo === null ? null : dmsDate(daysAgo(f.doneDaysAgo)),
        f.outcomeDesc, f.empCode,
      );
    }
    for (const t of s.testRideSeeds) {
      insTr.run(t.trId, s.enqId, t.modelCode, dmsTimestamp(minutesAgo(t.scheduledMinutesAgo)), t.doneFlg);
    }
  }
}

/**
 * Resolve the relative-day seeds against today.
 *
 * Ageing is the entire point of these rows — a part outstanding for nine days
 * is the fixture. Storing absolute dates would let that drift with the calendar
 * until the demo showed a part outstanding for four months, which reads as a
 * broken mock rather than a neglected job card.
 */
function seedJobCards(): void {
  const insJc = db.prepare(
    `insert into job_cards (
       jc_no, jc_dt, dealer_code, chassis_no, reg_no, cust_id, cust_name, mobile_no,
       model_desc, odometer_km, jc_type, status, advisor_emp_code, technician_emp_code,
       bay_no, complaint_desc, observation_desc, promised_dt, actual_close_dt,
       estimate_amt, approved_amt, final_amt, modified_at,
       jc_dt_iso, promised_iso, modified_iso
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insLab = db.prepare(
    `insert into jc_labour (jc_no, seq, labour_code, labour_desc, hrs, rate_amt) values (?, ?, ?, ?, ?, ?)`,
  );
  const insPart = db.prepare(
    `insert into jc_parts (jc_no, seq, part_no, part_desc, qty, rate_amt, warranty_flg, issued_flg)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insPsf = db.prepare(
    `insert into jc_psf (jc_no, call_dt, satisfaction_score, complaint_flg, remarks_desc) values (?, ?, ?, ?, ?)`,
  );

  for (const s of JOB_CARD_SEEDS) {
    const opened = daysAgo(s.openedDaysAgo);
    const promised = new Date(opened);
    promised.setDate(promised.getDate() + s.promisedDaysFromOpen);

    const modified = daysAgo(s.modifiedDaysAgo);
    insJc.run(
      s.jcNo, dmsDate(opened), s.dealerCode, s.chassisNo, s.regNo, s.custId, s.custName,
      s.mobileNo, s.modelDesc, s.odometerKm, s.jcType, s.status, s.advisorEmpCode,
      s.technicianEmpCode, s.bayNo, s.complaintDesc, s.observationDesc,
      dmsDate(promised),
      s.closedDaysAgo === null ? null : dmsDate(daysAgo(s.closedDaysAgo)),
      s.estimateAmt, s.approvedAmt, s.finalAmt,
      dmsTimestamp(modified),
      isoOf(opened), isoOf(promised), isoStampOf(modified),
    );

    for (const l of s.labour) insLab.run(s.jcNo, l.seq, l.labourCode, l.labourDesc, l.hrs, l.rateAmt);
    for (const p of s.parts) {
      insPart.run(s.jcNo, p.seq, p.partNo, p.partDesc, p.qty, p.rateAmt, p.warrantyFlg, p.issuedFlg);
    }
    if (s.psf) {
      insPsf.run(
        s.jcNo,
        s.psfDaysAgo === null ? null : dmsDate(daysAgo(s.psfDaysAgo)),
        s.psf.satisfactionScore, s.psf.complaintFlg, s.psf.remarksDesc,
      );
    }
  }
}

// ── Deals ───────────────────────────────────────────────────────────────────

/**
 * Replace the in-memory deal array's contents with what is on disk.
 *
 * The array identity is preserved rather than reassigned, because the portal
 * imported it directly long before there was a database and there is no reason
 * to rewrite working screens to introduce one.
 */
function hydrateDeals(): void {
  const rows = db.prepare(`select doc from deals order by deal_id`).all() as Array<{ doc: string }>;
  DEALS.length = 0;
  for (const r of rows) DEALS.push(JSON.parse(r.doc) as DmsDeal);
}

/** Called after any mutation, so the process is no longer the source of truth. */
export function saveDeal(deal: DmsDeal): void {
  const now = new Date();
  db.prepare(
    `insert into deals (deal_id, dealer_code, status, chassis_no, policy_no, reg_no, modified_at, modified_iso, doc)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(deal_id) do update set
       dealer_code  = excluded.dealer_code,
       status       = excluded.status,
       chassis_no   = excluded.chassis_no,
       policy_no    = excluded.policy_no,
       reg_no       = excluded.reg_no,
       modified_at  = excluded.modified_at,
       modified_iso = excluded.modified_iso,
       doc          = excluded.doc`,
  ).run(
    deal.dealId, deal.dealerCode, deal.status, deal.vehicle.chassisNo,
    deal.insurance.policyNo, deal.registration.regNo,
    dmsTimestamp(now), isoStampOf(now),
    JSON.stringify(deal),
  );
}

/** Deal ids touched since a `DD-MM-YYYY HH:mm:ss` instant. */
export function dealIdsModifiedSince(since: Date): Set<string> {
  const rows = db
    .prepare(`select deal_id from deals where modified_iso >= ?`)
    .all(isoStampOf(since)) as Array<{ deal_id: string }>;
  return new Set(rows.map((r) => r.deal_id));
}

// ── Workshop ────────────────────────────────────────────────────────────────

interface JobCardRow {
  jc_no: string; jc_dt: string; dealer_code: string; chassis_no: string; reg_no: string | null;
  cust_id: string; cust_name: string; mobile_no: string | null; model_desc: string;
  odometer_km: number; jc_type: string; status: string; advisor_emp_code: string;
  technician_emp_code: string | null; bay_no: string | null; complaint_desc: string;
  observation_desc: string | null; promised_dt: string; actual_close_dt: string | null;
  estimate_amt: string; approved_amt: string | null; final_amt: string | null; modified_at: string;
}

function toJobCard(r: JobCardRow, withLines: boolean): DmsJobCard {
  const jc: DmsJobCard = {
    jcNo: r.jc_no,
    jcDt: r.jc_dt,
    dealerCode: r.dealer_code,
    chassisNo: r.chassis_no,
    regNo: r.reg_no,
    custId: r.cust_id,
    custName: r.cust_name,
    mobileNo: r.mobile_no,
    modelDesc: r.model_desc,
    odometerKm: r.odometer_km,
    jcType: r.jc_type as DmsJobCard["jcType"],
    status: r.status as DmsJobCardStatus,
    advisorEmpCode: r.advisor_emp_code,
    technicianEmpCode: r.technician_emp_code,
    bayNo: r.bay_no,
    complaintDesc: r.complaint_desc,
    observationDesc: r.observation_desc,
    promisedDt: r.promised_dt,
    actualCloseDt: r.actual_close_dt,
    estimateAmt: r.estimate_amt,
    approvedAmt: r.approved_amt,
    finalAmt: r.final_amt,
    labour: [],
    parts: [],
    psf: null,
    modifiedAt: r.modified_at,
  };

  if (!withLines) return jc;

  jc.labour = db
    .prepare(`select seq, labour_code, labour_desc, hrs, rate_amt from jc_labour where jc_no = ? order by seq`)
    .all(r.jc_no)
    .map((l) => {
      const row = l as { seq: number; labour_code: string; labour_desc: string; hrs: number; rate_amt: string };
      return { seq: row.seq, labourCode: row.labour_code, labourDesc: row.labour_desc, hrs: row.hrs, rateAmt: row.rate_amt };
    });

  jc.parts = db
    .prepare(`select seq, part_no, part_desc, qty, rate_amt, warranty_flg, issued_flg from jc_parts where jc_no = ? order by seq`)
    .all(r.jc_no)
    .map((p) => {
      const row = p as { seq: number; part_no: string; part_desc: string; qty: number; rate_amt: string; warranty_flg: string; issued_flg: string };
      return {
        seq: row.seq, partNo: row.part_no, partDesc: row.part_desc, qty: row.qty,
        rateAmt: row.rate_amt,
        warrantyFlg: row.warranty_flg as "Y" | "N",
        issuedFlg: row.issued_flg as "Y" | "N",
      };
    });

  const psf = db
    .prepare(`select call_dt, satisfaction_score, complaint_flg, remarks_desc from jc_psf where jc_no = ?`)
    .get(r.jc_no) as
    | { call_dt: string | null; satisfaction_score: number | null; complaint_flg: string | null; remarks_desc: string | null }
    | undefined;

  if (psf) {
    jc.psf = {
      callDt: psf.call_dt,
      satisfactionScore: psf.satisfaction_score,
      complaintFlg: psf.complaint_flg as "Y" | "N" | null,
      remarksDesc: psf.remarks_desc,
    };
  }

  return jc;
}

export interface JobCardFilter {
  dealerCode?: string;
  status?: string;
  /** Only cards touched at or after this instant. */
  modifiedSince?: Date;
  /** Only cards with at least one part line still unissued. */
  awaitingPartsOnly?: boolean;
}

export function listJobCards(filter: JobCardFilter = {}): DmsJobCard[] {
  const where: string[] = [];
  const args: Array<string | number> = [];

  if (filter.dealerCode) { where.push("dealer_code = ?"); args.push(filter.dealerCode); }
  if (filter.status) { where.push("status = ?"); args.push(filter.status); }
  if (filter.awaitingPartsOnly) {
    where.push("exists (select 1 from jc_parts p where p.jc_no = job_cards.jc_no and p.issued_flg = 'N')");
  }
  // Compared against the sortable column, never the displayed one. The caller
  // still sends DD-MM-YYYY HH:mm:ss and it is parsed on the way in.
  if (filter.modifiedSince) {
    where.push("modified_iso >= ?");
    args.push(isoStampOf(filter.modifiedSince));
  }

  const sql =
    `select * from job_cards${where.length ? ` where ${where.join(" and ")}` : ""} order by jc_dt_iso desc, jc_no desc`;
  const rows = db.prepare(sql).all(...args) as unknown as JobCardRow[];

  return rows.map((r) => toJobCard(r, false));
}

export function getJobCard(jcNo: string): DmsJobCard | null {
  const row = db.prepare(`select * from job_cards where jc_no = ?`).get(jcNo) as JobCardRow | undefined;
  return row ? toJobCard(row, true) : null;
}

export function listEmployees(dealerCode?: string, activeOnly?: boolean): DmsEmployee[] {
  const where: string[] = [];
  const args: string[] = [];
  if (dealerCode) { where.push("dealer_code = ?"); args.push(dealerCode); }
  if (activeOnly) where.push("active_flg = 'Y'");

  const rows = db
    .prepare(`select * from employees${where.length ? ` where ${where.join(" and ")}` : ""} order by dealer_code, emp_code`)
    .all(...args) as Array<{
      emp_code: string; emp_name: string; dealer_code: string; role: string;
      doj: string; dol: string | null; active_flg: string; mobile_no: string | null;
    }>;

  return rows.map((r) => ({
    empCode: r.emp_code,
    empName: r.emp_name,
    dealerCode: r.dealer_code,
    role: r.role as DmsEmployee["role"],
    doj: r.doj,
    dol: r.dol,
    activeFlg: r.active_flg as "Y" | "N",
    mobileNo: r.mobile_no,
  }));
}

// ── CRM ─────────────────────────────────────────────────────────────────────

interface EnquiryRow {
  enq_id: string; dealer_code: string; enq_dt: string; source: string; grade: string;
  stage: string; cust_name: string; mobile_no: string; email_id: string | null;
  city_desc: string | null; model_code_interest: string; assigned_emp_code: string;
  first_contact_at: string | null; last_contact_dt: string | null;
  next_follow_up_dt: string | null; lost_reason_desc: string | null;
  converted_deal_id: string | null; modified_at: string;
}

function toEnquiry(r: EnquiryRow, withLines: boolean): DmsEnquiry {
  const e: DmsEnquiry = {
    enqId: r.enq_id,
    dealerCode: r.dealer_code,
    enqDt: r.enq_dt,
    source: r.source as DmsEnquiry["source"],
    grade: r.grade as DmsEnquiry["grade"],
    stage: r.stage as DmsEnquiry["stage"],
    custName: r.cust_name,
    mobileNo: r.mobile_no,
    emailId: r.email_id,
    cityDesc: r.city_desc,
    modelCodeInterest: r.model_code_interest,
    assignedEmpCode: r.assigned_emp_code,
    firstContactAt: r.first_contact_at,
    lastContactDt: r.last_contact_dt,
    nextFollowUpDt: r.next_follow_up_dt,
    lostReasonDesc: r.lost_reason_desc,
    convertedDealId: r.converted_deal_id,
    followUps: [],
    testRides: [],
    modifiedAt: r.modified_at,
  };

  if (!withLines) return e;

  e.followUps = db
    .prepare(`select fu_id, due_dt, done_dt, outcome_desc, emp_code from enquiry_followups where enq_id = ? order by due_dt`)
    .all(r.enq_id)
    .map((f) => {
      const row = f as { fu_id: string; due_dt: string; done_dt: string | null; outcome_desc: string | null; emp_code: string };
      return { fuId: row.fu_id, dueDt: row.due_dt, doneDt: row.done_dt, outcomeDesc: row.outcome_desc, empCode: row.emp_code };
    });

  e.testRides = db
    .prepare(`select tr_id, model_code, scheduled_dt, done_flg from test_rides where enq_id = ?`)
    .all(r.enq_id)
    .map((t) => {
      const row = t as { tr_id: string; model_code: string; scheduled_dt: string; done_flg: string };
      return { trId: row.tr_id, modelCode: row.model_code, scheduledDt: row.scheduled_dt, doneFlg: row.done_flg as "Y" | "N" };
    });

  return e;
}

export interface EnquiryFilter {
  dealerCode?: string;
  stage?: string;
  source?: string;
  modifiedSince?: Date;
  /** Only enquiries nobody has yet made contact with. */
  uncontactedOnly?: boolean;
}

export function listEnquiries(filter: EnquiryFilter = {}): DmsEnquiry[] {
  const where: string[] = [];
  const args: string[] = [];

  if (filter.dealerCode) { where.push("dealer_code = ?"); args.push(filter.dealerCode); }
  if (filter.stage) { where.push("stage = ?"); args.push(filter.stage); }
  if (filter.source) { where.push("source = ?"); args.push(filter.source); }
  if (filter.uncontactedOnly) where.push("first_contact_at is null");
  if (filter.modifiedSince) { where.push("modified_iso >= ?"); args.push(isoStampOf(filter.modifiedSince)); }

  const rows = db
    .prepare(`select * from enquiries${where.length ? ` where ${where.join(" and ")}` : ""} order by enq_iso desc`)
    .all(...args) as unknown as EnquiryRow[];

  return rows.map((r) => toEnquiry(r, false));
}

export function getEnquiry(enqId: string): DmsEnquiry | null {
  const row = db.prepare(`select * from enquiries where enq_id = ?`).get(enqId) as EnquiryRow | undefined;
  return row ? toEnquiry(row, true) : null;
}

/** Reference data the API still serves straight from the fixtures. */
export { DEALERS, DEALS, FREE_STOCK };

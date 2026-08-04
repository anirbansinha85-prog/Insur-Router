/**
 * The composer: what DDMS would say, and the leash on how it may say it.
 *
 * Every screen in this product ends in a sentence — *tell the customer their
 * vehicle is ready*, *this file is nobody's*, *the RTO has gone quiet*. Until
 * now the sentence was the end of the line. This turns it into a draft.
 *
 * ## Two writers, and only one of them is trusted
 *
 * A template writes the message from `facts` — values a rule pulled out of the
 * mirror. That draft is always produced and is always usable.
 *
 * A model may then *rephrase* it. It is given the facts and the rule draft and
 * asked for better wording, and what comes back is accepted only if
 * `checkRewrite()` agrees: every figure in it was already in the facts, every
 * figure the draft asserted is still there, and it ends in a finished sentence.
 * A rewrite that adds a delivery date nobody promised, drops the registration
 * number the customer needs, or stops mid-word is discarded and the rule draft
 * goes forward.
 *
 * That check is R-49 in code. The model phrases; the rule authorises. It is the
 * same discipline as the OCR stub never being auto-eligible: plausible output
 * that nobody verified must not be able to reach a customer looking like fact.
 *
 * ## Nothing here decides whether to send
 *
 * `composeDraft()` produces text and returns it. Whether the resulting message
 * may leave the building is `authoriseSend()` in `outbound.ts`, which never
 * calls a model and never will.
 */

import { logger } from "../logger";
import type { LeadWorklistRow } from "./lead-worklist";
import type { RegistrationWorklistRow } from "./registration-worklist";
import type { ServiceWorklistRow } from "./service-worklist";
import type { ReceivablesWorklistRow } from "./receivables-worklist";

export type MessageAudience = "INTERNAL" | "CUSTOMER";
export type MessageChannel = "EMAIL" | "WHATSAPP" | "SMS";
export type MessageModule =
  | "DEAL"
  | "JOB_CARD"
  | "ENQUIRY"
  | "REGISTRATION"
  | "PART"
  | "RECEIVABLE"
  | "VEHICLE";

export interface ComposedDraft {
  template: string;
  module: MessageModule;
  recordKey: string;
  showroomId: number;
  audience: MessageAudience;
  channel: MessageChannel;
  toName: string | null;
  toAddress: string | null;
  toEmpCode: string | null;
  subject: string | null;
  body: string;
  /** The values the body is permitted to assert. */
  facts: Record<string, unknown>;
  draftedBy: "RULE" | "AGENT";
  /** Why this message exists, for the person deciding whether to approve it. */
  rationale: string;
}

// ── The fact guard ──────────────────────────────────────────────────────────

/**
 * Every number-shaped token in a piece of text.
 *
 * Deliberately crude, and crude in the safe direction: it catches more than it
 * needs to, so a rewrite is rejected for a number that was harmless rather than
 * accepted for one that was not. A composer that occasionally falls back to the
 * template costs nothing; one that occasionally sends an invented date costs a
 * dealership its credibility with a customer.
 */
function numericTokens(text: string): string[] {
  const out: string[] = [];
  // Dates in any separator, registration numbers, amounts with separators,
  // and bare runs of digits. Normalised to digits-only for comparison so
  // "12/08/2026", "12-08-2026" and "12.08.2026" are one token.
  for (const m of text.matchAll(/\d[\d,./-]*\d|\d/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length > 0) out.push(digits);
  }
  return out;
}

/**
 * Is this rewrite safe to send in place of the draft a rule wrote?
 *
 * Three failure modes, and the first version of this function only caught one
 * of them. The other two were found by reading what actually came back.
 *
 * **Invented.** A number in the rewrite that the facts do not support. Allowed
 * if it appears in the facts, in the rule draft, or as a substring of either —
 * the last because a model may reasonably write "₹9,901" where the facts hold
 * `9901`, or split a phone number.
 *
 * **Dropped.** A number the rule draft asserted that the rewrite left out. A
 * "your vehicle is ready" message with the registration number removed is a
 * message the customer cannot act on, and it is the same class of defect as an
 * invented one: the finished text no longer says what the rule decided to say.
 *
 * **Truncated.** A reply that stops mid-sentence. This is not hypothetical —
 * the first customer draft this composer produced was *"Dear Mr Satish Verma,
 * your HF Deluxe"* and nothing else, because the model's token budget ran out
 * inside its own reasoning. It passed every check there was, because a
 * truncated message invents nothing. A message that goes out under a
 * dealership's name half-written is worse than one that reads like a template.
 *
 * Small integers up to three digits are exempt from both numeric tests. They
 * are how ordinary prose counts things ("2 days", "one of 3 documents"), and
 * policing them would reject every readable rewrite while catching nothing
 * that matters: a wrong "2 days" is a wrong emphasis, a wrong registration
 * number is a wrong fact.
 */
export function checkRewrite(
  rewrite: string,
  ruleDraft: string,
  facts: Record<string, unknown>,
): { ok: true } | { ok: false; problem: string } {
  const text = rewrite.trim();

  // Truncation, checked first because a cut-off reply fails the other tests for
  // the wrong reason and the wrong reason is what would get logged.
  if (!/[.!?]$/.test(text)) {
    return { ok: false, problem: "it does not end in a finished sentence" };
  }
  if (text.length < ruleDraft.length * 0.4) {
    return { ok: false, problem: "it is far shorter than the draft it replaces" };
  }

  const permittedFlat = numericTokens(`${ruleDraft} ${JSON.stringify(facts)}`);
  const permitted = new Set(permittedFlat);
  const haystack = permittedFlat.join(" ");

  for (const token of numericTokens(text)) {
    if (token.length <= 3) continue;
    if (permitted.has(token)) continue;
    if (haystack.includes(token)) continue;
    return { ok: false, problem: `it asserts ${token}, which the facts do not support` };
  }

  const rewritten = numericTokens(text).join(" ");
  for (const token of numericTokens(ruleDraft)) {
    if (token.length <= 3) continue;
    if (!rewritten.includes(token)) {
      return { ok: false, problem: `it drops ${token}, which the draft asserted` };
    }
  }

  return { ok: true };
}

// ── The optional rewrite ────────────────────────────────────────────────────

const REWRITE_SYSTEM = [
  "You rewrite short operational messages for an Indian car dealership.",
  "Rules you must follow exactly:",
  "- Use ONLY the facts given. Never add a date, amount, registration number,",
  "  phone number or any other figure that is not in the facts.",
  "- Never promise anything: no delivery dates, no timelines, no compensation.",
  "- Keep it under 60 words. Plain Indian English. Courteous, not effusive.",
  "- No emoji, no marketing language, no signature block.",
  "Return the message text only, with no preamble and no quotation marks.",
].join("\n");

/**
 * Ask a model for better wording, and take it only if it stayed honest.
 *
 * Runs only when a key is present, and never blocks: a timeout, a refusal, a
 * malformed reply and an invented figure all end the same way — the rule draft
 * goes forward. The screen shows which writer produced what is on it.
 */
async function rewriteWithModel(
  ruleDraft: string,
  facts: Record<string, unknown>,
  audience: MessageAudience,
): Promise<{ body: string; draftedBy: "RULE" | "AGENT" }> {
  const key = process.env["GEMINI_API_KEY"];
  if (!key || process.env["OUTBOUND_DRAFT_MODEL"] === "off") {
    return { body: ruleDraft, draftedBy: "RULE" };
  }

  const model = process.env["OUTBOUND_DRAFT_MODEL"] || "gemini-flash-latest";
  const controller = new AbortController();
  // Long enough to be worth waiting for, short enough that composing still
  // feels like pressing a button. Affordable because drafting is a deliberate
  // action rather than something a screen does while it loads — and because
  // the deadline expiring costs nothing but the template wording.
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: REWRITE_SYSTEM }] },
          generationConfig: {
            temperature: 0.3,
            // Generous on purpose. On a thinking model this budget covers the
            // reasoning *and* the output, so the 300 it started at bought a
            // paragraph of deliberation and half a sentence of message — which
            // is how the first draft this composer ever produced went out
            // reading "Dear Mr Satish Verma, your HF Deluxe" and nothing else.
            //
            // `thinkingConfig: { thinkingBudget: 0 }` would be the direct fix
            // and `gemini-flash-latest` rejects it with a bare 400, so the
            // budget does the work instead.
            maxOutputTokens: 1_000,
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: [
                    `Audience: ${audience === "CUSTOMER" ? "the customer" : "a member of staff"}.`,
                    `Facts (the only figures you may use): ${JSON.stringify(facts)}`,
                    "",
                    "Current wording:",
                    ruleDraft,
                  ].join("\n"),
                },
              ],
            },
          ],
        }),
      },
    );

    if (!res.ok) {
      // Logged rather than swallowed, and that is not fussiness. A malformed
      // request made this whole path inert for a while — every draft came back
      // `RULE`, which is exactly what a healthy fallback looks like, so nothing
      // about the output said the model was never being reached. A silent
      // fallback and a silent failure are indistinguishable unless one of them
      // says so.
      logger.warn(
        { status: res.status, body: (await res.text()).slice(0, 300) },
        "Model rewrite unavailable — the rule draft was used instead",
      );
      return { body: ruleDraft, draftedBy: "RULE" };
    }

    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    const finish = json.candidates?.[0]?.finishReason;
    if (!text || text.length > 1_200) {
      return { body: ruleDraft, draftedBy: "RULE" };
    }
    // The model itself says when it ran out of room. Cheaper and more certain
    // than inferring it from the text, though `checkRewrite` infers it too —
    // one of these is a guess and the other is not, and both are wanted.
    if (finish && finish !== "STOP") {
      logger.warn({ finish, audience }, "Model rewrite rejected — it did not finish");
      return { body: ruleDraft, draftedBy: "RULE" };
    }

    const check = checkRewrite(text, ruleDraft, facts);
    if (!check.ok) {
      // Worth a log line rather than a silent fallback: a model that keeps
      // failing this is a signal about the prompt, and the alternative is
      // discovering it only when somebody notices the wording never improves.
      logger.warn(
        { problem: check.problem, audience },
        "Model rewrite rejected — the rule draft was used instead",
      );
      return { body: ruleDraft, draftedBy: "RULE" };
    }

    return { body: text, draftedBy: "AGENT" };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Model rewrite threw — the rule draft was used instead",
    );
    return { body: ruleDraft, draftedBy: "RULE" };
  } finally {
    clearTimeout(timer);
  }
}

// ── Templates ───────────────────────────────────────────────────────────────

function inr(n: number): string {
  return `₹${n.toLocaleString("en-IN")}`;
}

/**
 * `2026-06-02` → `02-06-2026`.
 *
 * ISO is what the mirror stores and it is wrong in a letter to an Indian
 * accounts department: `2026-06-02` reads as the second of June to us and as
 * nothing at all to the clerk who has to match it against their own ledger,
 * where every date is day-first.
 */
function indianDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}

/**
 * A customer whose vehicle has been ready and uncollected.
 *
 * The one message on the service screen worth sending, and the reason is the
 * number beside it: the DMS closes a job card when the work is finished, and
 * whether anybody rang the customer is a different field nothing reads.
 */
export function draftVehicleReady(
  row: ServiceWorklistRow,
  dealershipName: string,
): Omit<ComposedDraft, "draftedBy"> {
  const facts: Record<string, unknown> = {
    customerName: row.customerName,
    registrationNumber: row.regNo,
    model: row.modelDescription,
    jobCardNumber: row.jcNo,
    finalAmount: row.dms.finalAmount,
    dealership: dealershipName,
  };

  const amount =
    row.dms.finalAmount && row.dms.finalAmount > 0
      ? ` The bill comes to ${inr(row.dms.finalAmount)}.`
      : "";

  const body =
    `Hello${row.customerName ? ` ${row.customerName}` : ""}, your ` +
    `${row.modelDescription ?? "vehicle"}${row.regNo ? ` (${row.regNo})` : ""} is ready ` +
    `for collection at ${dealershipName}.${amount} ` +
    `Please let us know when it suits you to come in. Job card ${row.jcNo}.`;

  return {
    template: "SERVICE_VEHICLE_READY",
    module: "JOB_CARD",
    recordKey: row.jcNo,
    showroomId: row.showroomId,
    audience: "CUSTOMER",
    channel: "WHATSAPP",
    toName: row.customerName,
    toAddress: row.customerMobile,
    toEmpCode: null,
    subject: null,
    body,
    facts,
    rationale:
      `The work is finished and the job card shows nobody has told them. ` +
      `It has been ${row.daysInStatus} day${row.daysInStatus === 1 ? "" : "s"} in this state.`,
  };
}

/**
 * A customer whose registration certificate is sitting in the dealership.
 *
 * The DMS treats a vehicle as finished when the RTO allots a number, because
 * that is when the sale can be reported. Whether the card ever reached the
 * customer is two fields further down and no screen puts them side by side.
 */
export function draftRcReady(
  row: RegistrationWorklistRow,
  dealershipName: string,
): Omit<ComposedDraft, "draftedBy"> {
  const facts: Record<string, unknown> = {
    customerName: row.customerName,
    registrationNumber: row.dms.regNo,
    model: row.modelDescription,
    fileNumber: row.regnFileNo,
    daysHeld: row.rcHeldDays,
    dealership: dealershipName,
  };

  const body =
    `Hello${row.customerName ? ` ${row.customerName}` : ""}, the registration ` +
    `certificate for your ${row.modelDescription ?? "vehicle"}` +
    `${row.dms.regNo ? ` (${row.dms.regNo})` : ""} has arrived and is with us at ` +
    `${dealershipName}. Please collect it at your convenience, or tell us a ` +
    `time and we will arrange to hand it over.`;

  return {
    template: "REGISTRATION_RC_READY",
    module: "REGISTRATION",
    recordKey: row.regnFileNo,
    showroomId: row.showroomId,
    audience: "CUSTOMER",
    channel: "WHATSAPP",
    toName: row.customerName,
    toAddress: row.customerMobile,
    toEmpCode: null,
    subject: null,
    body,
    facts,
    rationale:
      `The certificate has been at the dealership ` +
      `${row.rcHeldDays ?? 0} day${row.rcHeldDays === 1 ? "" : "s"} and the customer has not been told.`,
  };
}

/**
 * The email telling a member of staff a registration file is theirs.
 *
 * This is the message R-50 says to build first. It goes to somebody who already
 * works at the dealership, about work that is already theirs, and it is the one
 * kind of message a rule can permit without a person reading it.
 */
export function draftAgentAssignment(
  row: RegistrationWorklistRow,
  toName: string,
  toAddress: string | null,
  toEmpCode: string,
  dealershipName: string,
): Omit<ComposedDraft, "draftedBy"> {
  const facts: Record<string, unknown> = {
    agentName: toName,
    fileNumber: row.regnFileNo,
    customerName: row.customerName,
    model: row.modelDescription,
    chassisNumber: row.chassisNo,
    rtoOffice: row.dms.rtoOffice,
    state: row.state,
    ageDays: row.ageDays,
    tempRegDaysLeft: row.tempRegDaysLeft,
    roadTaxAmount: row.dms.roadTaxAmount,
    dealership: dealershipName,
  };

  const lines = [
    `${toName},`,
    "",
    `Registration file ${row.regnFileNo} is now assigned to you.`,
    "",
    `Customer: ${row.customerName ?? "—"}`,
    `Vehicle: ${row.modelDescription ?? "—"}${row.chassisNo ? ` · chassis ${row.chassisNo}` : ""}`,
    `RTO: ${row.dms.rtoOffice ?? row.dms.rtoCode ?? "—"}`,
    `Status: ${row.state.replace(/_/g, " ").toLowerCase()}`,
    "",
    row.actionRequired ? `What is needed: ${row.actionRequired}` : "",
    row.note ? row.note : "",
    // Only when the note has not already said it. `registration-worklist.ts`
    // puts the lapse in the note as a prefix, so adding it unconditionally
    // produced an email that told the agent the same thing twice in
    // consecutive lines.
    row.tempRegDaysLeft !== null &&
    row.tempRegDaysLeft < 0 &&
    !(row.note ?? "").toLowerCase().includes("temporary registration")
      ? `The temporary registration has already lapsed.`
      : "",
    "",
    `— ${dealershipName}, via DDMS`,
  ].filter((l) => l !== "");

  return {
    template: "REGISTRATION_AGENT_ASSIGNED",
    module: "REGISTRATION",
    recordKey: row.regnFileNo,
    showroomId: row.showroomId,
    audience: "INTERNAL",
    channel: "EMAIL",
    toName,
    toAddress,
    toEmpCode,
    subject: `Registration file ${row.regnFileNo} — ${row.customerName ?? "customer"}`,
    body: lines.join("\n"),
    facts,
    rationale: `${toName} has been assigned this file and needs to know what is on it.`,
  };
}

/**
 * The email telling a salesperson a lead is now theirs.
 *
 * Internal, and the counterpart to the reassignment control: reassigning a lead
 * on a screen changes who owns it; this is what tells them.
 */
export function draftLeadHandover(
  row: LeadWorklistRow,
  toName: string,
  toAddress: string | null,
  toEmpCode: string,
  dealershipName: string,
): Omit<ComposedDraft, "draftedBy"> {
  const facts: Record<string, unknown> = {
    salespersonName: toName,
    enquiryId: row.enqId,
    customerName: row.customerName,
    customerMobile: row.customerMobile,
    modelInterest: row.modelInterest,
    source: row.dms.source,
    state: row.state,
    responseMinutes: row.responseMinutes,
    dealership: dealershipName,
  };

  const lines = [
    `${toName},`,
    "",
    `Enquiry ${row.enqId} is now assigned to you.`,
    "",
    `Customer: ${row.customerName ?? "—"}${row.customerMobile ? ` · ${row.customerMobile}` : ""}`,
    `Interested in: ${row.modelInterest ?? "—"}`,
    `Source: ${row.dms.source}`,
    "",
    row.actionRequired ? `What is needed: ${row.actionRequired}` : "",
    row.slaNote ? row.slaNote : "",
    "",
    `— ${dealershipName}, via DDMS`,
  ].filter((l) => l !== "");

  return {
    template: "LEAD_HANDOVER",
    module: "ENQUIRY",
    recordKey: row.enqId,
    showroomId: row.showroomId,
    audience: "INTERNAL",
    channel: "EMAIL",
    toName,
    toAddress,
    toEmpCode,
    subject: `Enquiry ${row.enqId} — ${row.customerName ?? "customer"}`,
    body: lines.join("\n"),
    facts,
    rationale: `${toName} now owns this enquiry and the clock is already running.`,
  };
}

/**
 * A statement of account — what a party owes, and what it is for.
 *
 * This is R-17 read honestly. "Invoice generation, automated" cannot mean
 * generating the dealer's tax invoice: that document lives in their DMS, has a
 * statutory number series, and the integration is read-only and always will be
 * (R-5, R-40). Producing a second one would create two invoices for one debt,
 * which is worse than producing none.
 *
 * What DDMS can generate is the document the dealership actually never gets
 * round to: a statement addressed to the party, listing the open items with
 * their invoice numbers and dates, **totalled across every outlet the party
 * owes at**. That total is the thing no branch ledger can produce, and putting
 * it in front of an insurer is the point of having computed it.
 *
 * Audience is CUSTOMER — an insurer or a fleet account is outside the building
 * however corporate it sounds — so no rule can send it and a person approves
 * every one (R-50).
 */
export function draftStatementOfAccount(
  row: ReceivablesWorklistRow,
  dealershipName: string,
): Omit<ComposedDraft, "draftedBy"> {
  const exposure = row.groupExposure;
  const lines = exposure
    ? exposure.outlets.map((o) => ({ outlet: o.showroomCode, balance: o.balance, items: o.open }))
    : [{ outlet: row.showroomCode, balance: row.balance, items: 1 }];
  const total = exposure ? exposure.totalBalance : row.balance;

  const facts: Record<string, unknown> = {
    party: row.partyName,
    invoiceNumber: row.dms.invoiceNo,
    invoiceDate: indianDate(row.dms.invoiceDate),
    dueDate: indianDate(row.dms.dueDate),
    balanceOnThisInvoice: row.balance,
    daysOverdue: row.daysOverdue,
    totalOwedToTheGroup: total,
    outlets: lines,
    dealership: dealershipName,
  };

  const body = [
    `Dear ${row.partyName},`,
    "",
    `This is a statement of account from ${dealershipName}.`,
    "",
    `Invoice ${row.dms.invoiceNo}` +
      (indianDate(row.dms.invoiceDate) ? ` dated ${indianDate(row.dms.invoiceDate)}` : "") +
      ` — ${inr(row.balance)} outstanding` +
      (row.daysOverdue > 0 ? `, ${row.daysOverdue} days past its due date.` : "."),
    "",
    // The group total goes in only when there genuinely is one. A "total across
    // outlets" that repeats the single invoice above would read as padding to
    // the one person guaranteed to check it — their accounts clerk.
    ...(exposure
      ? [
          `Across our group the total outstanding with you is ${inr(total)}:`,
          ...lines.map((l) => `  ${l.outlet ?? "—"}: ${inr(l.balance)} over ${l.items} item${l.items === 1 ? "" : "s"}`),
          "",
        ]
      : []),
    `We would be grateful for settlement, or for a date we can note against the account.`,
    "",
    `— ${dealershipName}`,
  ].join("\n");

  return {
    template: "RECEIVABLE_STATEMENT",
    module: "RECEIVABLE",
    recordKey: row.receivableId,
    showroomId: row.showroomId,
    audience: "CUSTOMER",
    channel: "EMAIL",
    toName: row.partyName,
    toAddress: row.partyEmail,
    toEmpCode: null,
    subject: `Statement of account — ${dealershipName}`,
    body,
    facts,
    rationale: exposure
      ? `${row.partyName} owes ${inr(total)} across ${exposure.outletCount} outlets, and neither branch's own ledger shows it.`
      : `${inr(row.balance)} outstanding` +
        (row.daysOverdue > 0 ? `, ${row.daysOverdue} days past due.` : "."),
  };
}

/**
 * Finish a draft: optionally rephrase it, and say which writer produced it.
 *
 * Internal email is left alone. It is a structured handover — labelled lines a
 * member of staff scans in three seconds — and a model asked to improve it
 * would turn a form into a paragraph, which is worse for the reader and adds a
 * network round trip to a screen that does not need one.
 */
export async function finishDraft(
  draft: Omit<ComposedDraft, "draftedBy">,
): Promise<ComposedDraft> {
  if (draft.audience === "INTERNAL") {
    return { ...draft, draftedBy: "RULE" };
  }
  const { body, draftedBy } = await rewriteWithModel(draft.body, draft.facts, draft.audience);
  return { ...draft, body, draftedBy };
}

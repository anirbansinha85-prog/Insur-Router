/**
 * The panel that explains — and the leash that keeps it from deciding.
 *
 * Every screen in DDMS answers *what is wrong*. None of them answers the three
 * questions somebody actually asks next, standing in front of a row that has
 * not moved for a fortnight:
 *
 *   why is this stuck · who else is affected · what happens if it waits
 *
 * All three are answerable from rows the mirrors already hold. None of them is
 * answerable by the row itself, because each one reaches across a boundary the
 * dealer's own system keys everything by — another module, another outlet,
 * another person's workload.
 *
 * ## The evidence comes first, and the model comes second
 *
 * `explainRecord()` calls the tools, assembles a **deterministic** answer from
 * what they returned, and only then offers a model the chance to narrate over
 * exactly that evidence. The narration is accepted if `citationsHold()` agrees
 * that every figure in it appears in the evidence; otherwise the deterministic
 * answer stands. With no key, no network and no model, the panel still works
 * and still says something true — which is the property that decides whether
 * this is a feature or a demo.
 *
 * ## What it must never do
 *
 * Decide whether something is wrong. `classify()` already does that, in each
 * module, deterministically and for free, and replacing a rule that is right
 * every time with a model that is right most of the time would be a downgrade
 * dressed as an upgrade (R-49). The state, the note and the action on every row
 * here arrive as **input**. The panel is allowed to look up why, and to say it
 * in sentences. It is not allowed to form a view.
 *
 * Nor may it act. There is no tool here that writes anything, and the registry
 * is a closed set of typed functions rather than query access, so the worst a
 * confused model can do is ask for a lookup it is entitled to and get rows it
 * was already allowed to see.
 */

import { logger } from "../logger";
import {
  recordState,
  samePartWaiting,
  whatTheClockSays,
  whatWeHaveDone,
  whoElseIsAffected,
  whoIsCarryingIt,
  type Evidence,
  type ExplainModule,
  type ToolContext,
} from "./tools";

export interface ExplainInput {
  ownerId: number;
  showroomId: number;
  ownerShowroomIds: number[];
  module: ExplainModule;
  recordKey: string;
}

export interface Explanation {
  module: ExplainModule;
  recordKey: string;
  /** The module's own classification, carried through untouched. */
  state: string | null;
  /**
   * What the findings add up to, in prose, when a model wrote one and it
   * passed the citation check. Null otherwise, and the panel is complete
   * without it.
   */
  summary: string | null;
  /**
   * The findings themselves: one short sentence per claim, each assembled by a
   * rule from one of the evidence rows below.
   *
   * **Always present, and always shown**, including when a summary exists. The
   * summary is a reading of these; if it replaced them, the traceable form of
   * the answer would be the one thing the screen dropped — and "every claim
   * traces to rows a query returned" would be true of an object nobody sees.
   */
  findings: string[];
  /** Every tool that ran and every row it returned. The citation. */
  evidence: Evidence[];
  /** Present when a narration was rejected, so the panel says why rather than going quiet. */
  narrationRejected: string | null;
}

// ── The citation check ──────────────────────────────────────────────────────

function numericTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\d[\d,./-]*\d|\d/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length > 0) out.push(digits);
  }
  return out;
}

/**
 * Does every figure in this narration appear in the evidence?
 *
 * The same shape of check as the composer's, and for a sharper reason. A
 * message that invents a figure embarrasses a dealership in front of one
 * customer. An *explanation* that invents one is worse: it is offered as a
 * reading of the dealership's own data, so it will be believed, and the person
 * reading it has no way to tell which half came from a query.
 *
 * Figures of three digits or fewer are exempt — that is how prose counts things
 * ("2 days", "one of 3 files"), and policing them would reject every readable
 * sentence while catching nothing that matters.
 */
export function citationsHold(
  narration: string,
  evidence: Evidence[],
  deterministic: string[],
): { ok: true } | { ok: false; problem: string } {
  const text = narration.trim();
  if (!/[.!?]$/.test(text)) {
    return { ok: false, problem: "it does not end in a finished sentence" };
  }

  const source = `${JSON.stringify(evidence)} ${deterministic.join(" ")}`;
  const permitted = new Set(numericTokens(source));
  const haystack = [...permitted].join(" ");

  for (const token of numericTokens(text)) {
    if (token.length <= 3) continue;
    if (permitted.has(token)) continue;
    if (haystack.includes(token)) continue;
    return { ok: false, problem: `it states ${token}, which no tool returned` };
  }
  return { ok: true };
}

// ── The deterministic answer ────────────────────────────────────────────────

function n(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The answer assembled from the rows, before any model sees them.
 *
 * Written as a list of short sentences rather than a paragraph, because each
 * one is a separate claim with a separate source, and a paragraph would blur
 * where one piece of evidence stops and the next begins.
 */
function deterministicAnswer(evidence: Evidence[]): string[] {
  const by = (tool: string) => evidence.find((e) => e.tool === tool)?.rows ?? [];
  const out: string[] = [];

  // Why it is stuck — the module's own words, not ours.
  const [row] = by("record_state");
  if (row) {
    const why = s(row.why);
    const need = s(row.whatIsNeeded);
    if (why) out.push(why);
    if (need) out.push(`What it needs: ${need}.`);
    const limit = s(row.theHonestLimit);
    if (limit) out.push(limit);
  }

  // Who else is affected.
  const others = by("who_else_is_affected");
  if (others.length > 0) {
    const outlets = new Set(others.map((r) => s(r.outlet)).filter(Boolean));
    const needing = others.filter((r) => s(r.whatIsNeeded));
    out.push(
      `The same customer has ${plural(others.length, "other open record")} with this group` +
        (outlets.size > 1 ? `, across ${plural(outlets.size, "outlet")}` : "") +
        (needing.length > 0 ? `, and ${needing.length} of them also need somebody.` : "."),
    );
    for (const r of needing.slice(0, 3)) {
      out.push(`· ${s(r.module)} ${s(r.record)} — ${s(r.state)}: ${s(r.whatIsNeeded)}`);
    }
  }

  // The part, from both ends.
  const part = by("same_part_waiting");
  const waiting = part.filter((r) => r.kind === "waiting");
  const free = part.filter((r) => r.kind === "free at another outlet");
  const short = part.filter((r) => r.kind === "short at another outlet");
  if (waiting.length > 0) {
    const worst = Math.max(...waiting.map((w) => n(w.daysWaiting) ?? 0));
    out.push(
      `${plural(waiting.length, "customer")} waiting on this part, the longest for ${plural(worst, "day")}.`,
    );
  }
  if (free.length > 0) {
    const f = free[0]!;
    out.push(
      `${s(f.outlet)} has ${n(f.qtyFree)} free` +
        (s(f.bin) ? `, bin ${s(f.bin)}` : "") +
        " — the group already owns what this customer is waiting for.",
    );
  }
  if (short.length > 0) {
    out.push(
      `${s(short[0]!.outlet)} is below its reorder level on the same part` +
        (n(short[0]!.onOrder) ? ` and has ${n(short[0]!.onOrder)} on order.` : "."),
    );
  }

  // Who is carrying it.
  const [person, ...theirs] = by("who_is_carrying_it");
  if (person) {
    if (person.stillEmployed === false) {
      out.push(
        `It is assigned to ${s(person.name)}, who left the dealership` +
          (s(person.leftOn) ? ` on ${s(person.leftOn)}` : "") +
          ` — nobody is working it.`,
      );
    } else {
      out.push(
        `${s(person.name)} (${s(person.role)}) is carrying it, along with ` +
          `${plural(theirs.length, "other open record")}.`,
      );
    }
  }

  // What happens if it waits.
  for (const c of by("what_the_clock_says")) {
    const clock = s(c.clock);
    if (clock === "temporary registration") {
      out.push(
        c.status === "already lapsed"
          ? `The temporary registration lapsed ${plural(n(c.daysAgo) ?? 0, "day")} ago, so ${s(c.consequence)}.`
          : `The temporary registration has ${plural(n(c.daysLeft) ?? 0, "day")} left; in another week it ${s(c.inAWeek)}.`,
      );
    } else if (clock === "road tax") {
      out.push(`₹${n(c.amount)?.toLocaleString("en-IN")} of the customer's road tax is still held — ${s(c.consequence)}.`);
    } else if (clock === "certificate in the drawer") {
      out.push(
        `The certificate has been here ${plural(n(c.daysHeld) ?? 0, "day")}; leave it a week and that is ${n(c.inAWeek)}.`,
      );
    } else if (clock === "the promise made to the customer") {
      const late = n(c.daysLate) ?? 0;
      out.push(
        late > 0
          ? `It is ${plural(late, "day")} past the date promised to the customer; in another week it is ${n(c.inAWeek)}.`
          : `The date promised to the customer has not passed yet.`,
      );
    } else if (clock === "the manufacturer's response window") {
      out.push(String(c.consequence));
    } else if (clock === "a customer waiting") {
      // Already covered by same_part_waiting; repeating it reads as padding.
    } else if (clock === "stock on order") {
      out.push(`${n(c.qty)} on order` + (s(c.eta) ? `, expected ${s(c.eta)}.` : "."));
    } else if (clock === "days since it last moved") {
      const idle = n(c.idleCapital);
      // "It has not moved" was the first wording, and a model reading these
      // findings turned it into "the record has not moved" — a different and
      // wrong claim, about the transfer request rather than the stock. The
      // figure was cited correctly, so the check passed it. Naming the subject
      // is the fix: an ambiguous finding is a finding waiting to be misread,
      // and by a person as easily as by a model.
      out.push(
        `This part has not been issued to anybody for ${plural(n(c.days) ?? 0, "day")}` +
          (idle ? `, and ₹${Math.round(idle).toLocaleString("en-IN")} of stock is sitting on it.` : "."),
      );
    }
  }

  // Receivables and the floor. Both carry a figure the row itself does not
  // show, and both are the reason the tool reads across outlets.
  for (const c of by("what_the_clock_says")) {
    const clock = s(c.clock);
    if (clock === "what this party owes the group") {
      const outlets = Array.isArray(c.outlets) ? c.outlets : [];
      out.push(
        `Across the group this party owes ₹${Math.round(n(c.totalBalance) ?? 0).toLocaleString("en-IN")}, ` +
          `spread over ${plural(outlets.length, "outlet")} — a figure neither branch's own ledger can produce.`,
      );
    } else if (clock === "floor-plan interest") {
      out.push(
        `The floor-plan line charges ₹${(n(c.perDay) ?? 0).toLocaleString("en-IN")} a day on this unit; ` +
          `₹${(n(c.accruedSoFar) ?? 0).toLocaleString("en-IN")} so far, and another week costs ` +
          `₹${(n(c.anotherWeekCosts) ?? 0).toLocaleString("en-IN")}.`,
      );
    } else if (clock === "somebody asking for this model") {
      out.push(
        `${s(c.customer) ?? s(c.enquiry)} is asking for this model — enquiry ${s(c.enquiry)}, ` +
          `${String(s(c.stage)).replace(/_/g, " ").toLowerCase()}` +
          (c.atAnotherOutlet ? `, at ${s(c.outlet)} rather than here.` : "."),
      );
    }
  }

  // What has already been done — and the absence is the answer more often.
  const done = by("what_we_have_done");
  if (done.length === 0) {
    out.push("Nobody has recorded anything against this in DDMS.");
  } else {
    const decisions = done.filter((d) => d.kind === "decision").length;
    const messages = done.filter((d) => d.kind === "message");
    if (decisions > 0) out.push(`${plural(decisions, "decision")} recorded against it here.`);
    if (messages.length > 0) {
      const sent = messages.filter((m) => m.status === "SENT").length;
      out.push(
        `${plural(messages.length, "message")} drafted about it` +
          (sent === 0 ? ", none of which has actually been delivered." : `, ${sent} delivered.`),
      );
    }
  }

  if (out.length === 0) out.push("Nothing on this record needs anybody today.");
  return dedupe(out);
}

/**
 * Drop findings that say what an earlier one already said.
 *
 * Needed because the tools overlap on purpose. `record_state` carries the
 * module's note, and a note is often *about* a deadline — a lapsed temporary
 * registration, a manufacturer's window that has closed — which
 * `what_the_clock_says` then reports again from the dates. Narrowing either
 * tool to avoid the collision would make each worse on its own; the overlap is
 * a property of the evidence, so it is resolved here where the sentences are.
 *
 * Substring as well as equality, because the second telling is usually the
 * shorter one: the note gives the cause *and* the consequence, the clock gives
 * the consequence alone.
 */
function dedupe(lines: string[]): string[] {
  const kept: string[] = [];
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  for (const line of lines) {
    const n = norm(line);
    if (!n) continue;
    const idx = kept.findIndex((k) => {
      const kn = norm(k);
      return kn === n || kn.includes(n) || n.includes(kn);
    });
    if (idx === -1) {
      kept.push(line);
    } else if (norm(kept[idx]!).length < n.length) {
      // Keep whichever telling says more. The note usually beats the clock,
      // but not always, and picking by length is the only rule that does not
      // require knowing which tool a sentence came from.
      kept[idx] = line;
    }
  }
  return kept;
}

// ── The narration ───────────────────────────────────────────────────────────

const NARRATE_SYSTEM = [
  "You explain one stuck record to the owner of an Indian vehicle dealership.",
  "You are given findings a set of database queries returned. Rules:",
  "- Use ONLY those findings. Never add a figure, date, name or cause that is",
  "  not in them. Never estimate and never guess at a reason.",
  "- Do not recommend anything the findings do not already state as needed.",
  "- Do not repeat the findings as a list. Say what they add up to, in at most",
  "  four short sentences of plain Indian English.",
  "- Lead with the thing that would cost the dealership most if ignored.",
  "Return the explanation only, with no preamble and no bullet points.",
].join("\n");

async function narrate(
  deterministic: string[],
  evidence: Evidence[],
): Promise<{ text: string | null; rejected: string | null }> {
  const key = process.env["GEMINI_API_KEY"];
  if (!key || process.env["EXPLAIN_MODEL"] === "off") return { text: null, rejected: null };

  const model = process.env["EXPLAIN_MODEL"] || "gemini-flash-latest";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: NARRATE_SYSTEM }] },
          generationConfig: {
            temperature: 0.2,
            // Four times the composer's, because this prompt is four times the
            // size and the budget covers the model's reasoning as well as its
            // reply. At 1,000 every single narration came back `MAX_TOKENS`
            // and the panel silently ran on rules alone — which looked exactly
            // like a model that had nothing to add.
            maxOutputTokens: 4_000,
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: [
                    "Findings:",
                    ...deterministic.map((d) => `- ${d}`),
                    "",
                    "Supporting rows:",
                    // Trimmed, and the findings above are the real input. The
                    // rows are here so a figure in them can be recognised, not
                    // so the model can go looking for a story in them.
                    JSON.stringify(evidence).slice(0, 3_000),
                  ].join("\n"),
                },
              ],
            },
          ],
        }),
      },
    );

    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      logger.warn({ status: res.status, body }, "Explanation narration unavailable");
      return { text: null, rejected: null };
    }

    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    const finish = json.candidates?.[0]?.finishReason;
    if (!text) return { text: null, rejected: null };
    if (finish && finish !== "STOP") {
      return { text: null, rejected: "the model ran out of room before it finished" };
    }

    const check = citationsHold(text, evidence, deterministic);
    if (!check.ok) {
      logger.warn({ problem: check.problem }, "Explanation narration rejected");
      return { text: null, rejected: check.problem };
    }
    return { text, rejected: null };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Explanation narration threw",
    );
    return { text: null, rejected: null };
  } finally {
    clearTimeout(timer);
  }
}

// ── The panel ───────────────────────────────────────────────────────────────

export async function explainRecord(input: ExplainInput): Promise<Explanation | null> {
  const ctx: ToolContext = {
    ownerId: input.ownerId,
    showroomId: input.showroomId,
    ownerShowroomIds: input.ownerShowroomIds,
    module: input.module,
    recordKey: input.recordKey,
  };

  const state = await recordState(ctx);
  // No row means no record, and a panel that explained a record that is not
  // there would be explaining nothing at all.
  if (state.rows.length === 0) return null;

  const first = state.rows[0]!;
  const assignedTo =
    typeof first.assignedTo === "string" ? first.assignedTo : null;

  const rest = await Promise.all([
    whoElseIsAffected(ctx),
    samePartWaiting(ctx),
    whoIsCarryingIt(ctx, assignedTo),
    whatTheClockSays(ctx),
    whatWeHaveDone(ctx),
  ]);

  // Tools that found nothing are dropped from the evidence rather than shown
  // empty. "We looked and there was nothing" is worth saying once, in the
  // answer, not five times in a list of citations.
  const evidence = [state, ...rest].filter((e) => e.rows.length > 0);

  const findings = deterministicAnswer(evidence);
  const { text, rejected } = await narrate(findings, evidence);

  return {
    module: input.module,
    recordKey: input.recordKey,
    state: typeof first.state === "string" ? first.state : null,
    summary: text,
    findings,
    evidence,
    narrationRejected: rejected,
  };
}

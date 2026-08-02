import {
  DELAY_CATEGORY_LABELS,
  isDelayCategory,
  type DelayEventStatus,
} from "@/lib/eot/lifecycle";

/**
 * EOT — the contractual NOTICE OF DELAY composer (PURE).
 *
 * ── A NOTICE, NOT A CLAIM ───────────────────────────────────────────────────
 * The delay-events lane (20261084) deliberately produces no CLAIM: a claim
 * asserts contractual entitlement and a quantum, which are legal positions, and
 * inventing either is the "invented contractual facts" failure the whole lane
 * refuses. This file composes something narrower and honest — a contemporaneous
 * NOTICE OF DELAY (the NEC cl.61 / JCT cl.2.27 notification step): it states
 * WHAT was recorded, WHEN, and points at the records relied upon. It asserts no
 * entitlement, computes no quantum, and — this is the load-bearing rule —
 * INVENTS NO CONTRACT TERM.
 *
 * ── HONESTY DOCTRINE ────────────────────────────────────────────────────────
 * Every field is filled ONLY from a value the caller passed in. A contract
 * reference, the clause relied upon, and the contract completion date are NOT
 * columns anywhere in the schema today; they arrive as null and render as the
 * explicit NOT_SPECIFIED placeholder — NEVER a fabricated clause number, date
 * or figure. `unspecified` collects the label of every particular left as the
 * placeholder, so the gap is stated, never papered over (the pack.ts ethos).
 *
 * `workingDaysLost` is the recorder's CLAIM, passed through untouched; nothing
 * here derives it from the date range (the migration's central rule).
 *
 * Deterministic: no Date is constructed here (`noticeDate` is injected), dates
 * are sliced to day keys, and particulars render in a fixed order. Pure and
 * permutation-independent — unit-testable without a database.
 */

/** The one placeholder for a value genuinely absent from the record. */
export const NOT_SPECIFIED = "[not specified]";

/** The standing disclaimer the notice carries, verbatim, on its face. */
export const EOT_NOTICE_DISCLAIMER =
  "This notice is generated from the delay record held in CrewFlow and states only " +
  "recorded facts. Fields shown as [not specified] are not held in the record and must " +
  "be completed by the sender before issue. " +
  "It does not itself assert contractual entitlement: whether this event is a Relevant " +
  "Event or Compensation Event under the contract, and the extension of time it justifies, " +
  "remain matters for the sender to determine in accordance with the contract. The " +
  "working-days figure is the recorder's own claim, not a calculated amount. Review and " +
  "complete before issuing.";

// ── Inputs (already fetched, org-scoped by the caller) ───────────────────────

export interface EotNoticePartyInput {
  /** Legal/trading name. Contractor name is org.name (never null); employer may be null. */
  name: string | null;
  /** One-line postal address, flattened by the caller. Null when not held. */
  address: string | null;
}

export interface EotNoticeEventInput {
  id: string;
  category: string;
  status: DelayEventStatus;
  startedOn: string;
  /** Null = the delay is ongoing (a recorded fact, not an absent field). */
  endedOn: string | null;
  /** The recorder's CLAIM. Null = not yet quantified. Never computed. */
  workingDaysLost: number | null;
  description: string;
}

export interface EotNoticeVariationInput {
  number: number | null;
  title: string | null;
  requestedCompletionDate: string | null;
  agreedCompletionDate: string | null;
}

export interface EotNoticeInput {
  /** The party issuing the notice — the org. */
  contractor: EotNoticePartyInput;
  /** The party the notice is addressed to — the customer/employer. */
  employer: EotNoticePartyInput;
  /** A human label for the project/job (customer · date), or null. */
  jobReference: string | null;
  /** Not a column today ⇒ null ⇒ [not specified]. Never fabricated. */
  contractReference: string | null;
  /** Not a column today ⇒ null ⇒ [not specified]. Never fabricated. */
  contractClause: string | null;
  /** Not a column today ⇒ null ⇒ [not specified]. Never fabricated. */
  contractCompletionDate: string | null;
  /** The linked site-diary entry's date, when one is linked. */
  diaryEntryDate: string | null;
  /** The linked variation, when one is linked. */
  variation: EotNoticeVariationInput | null;
  event: EotNoticeEventInput;
  /** ISO timestamp — injected, never `new Date()` here. */
  noticeDate: string;
}

// ── Output ───────────────────────────────────────────────────────────────────

export interface EotNoticeField {
  label: string;
  /** The rendered value, or NOT_SPECIFIED when the source value was absent. */
  value: string;
  /** False when `value` is the placeholder — i.e. the record held nothing. */
  specified: boolean;
}

export interface EotNoticeParty {
  name: EotNoticeField;
  address: EotNoticeField;
}

export interface EotNotice {
  /** YYYY-MM-DD, from the injected noticeDate. */
  noticeDate: string;
  /** Deterministic internal reference, e.g. EOT/1A2B3C4D. */
  reference: string;
  contractor: EotNoticeParty;
  employer: EotNoticeParty;
  /** Labelled facts, in a fixed display order. */
  particulars: EotNoticeField[];
  /** Deterministic prose paragraphs — the body of the notice. */
  statements: string[];
  /** The standing disclaimer (=== EOT_NOTICE_DISCLAIMER). */
  disclaimer: string;
  /** The label of every particular left as NOT_SPECIFIED. Never hidden. */
  unspecified: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Day key from an ISO date/timestamp, or null. Constructs no Date. */
const dd = (iso: string | null): string | null => (iso ? iso.slice(0, 10) : null);

/**
 * A field from a value that may be genuinely absent. Empty/whitespace and null
 * both collapse to the placeholder — a blank string is not a specified value.
 */
function field(label: string, value: string | null): EotNoticeField {
  const trimmed = value === null ? "" : value.trim();
  const specified = trimmed.length > 0;
  return { label, value: specified ? trimmed : NOT_SPECIFIED, specified };
}

/** A field whose value IS a recorded fact (never a placeholder). */
function fact(label: string, value: string): EotNoticeField {
  return { label, value, specified: true };
}

function party(input: EotNoticePartyInput): EotNoticeParty {
  return {
    name: field("Name", input.name),
    address: field("Address", input.address),
  };
}

function categoryLabel(category: string): string {
  return isDelayCategory(category) ? DELAY_CATEGORY_LABELS[category] : category;
}

function daysPhrase(n: number): string {
  return `${n} working day${n === 1 ? "" : "s"}`;
}

/** Assemble the records relied upon into one field; placeholder when none. */
function evidenceField(input: EotNoticeInput): EotNoticeField {
  const parts: string[] = [];
  const diary = dd(input.diaryEntryDate);
  if (diary) parts.push(`Site diary entry dated ${diary}`);
  if (input.variation) {
    const num = `Variation #${String(input.variation.number ?? 0).padStart(3, "0")}`;
    parts.push(input.variation.title ? `${num} — ${input.variation.title}` : num);
  }
  return field("Records relied upon", parts.length > 0 ? parts.join("; ") : null);
}

// ── Composition ──────────────────────────────────────────────────────────────

/**
 * Compose the notice. Pure; safe to call with any permutation of the inputs.
 * The event is expected to be RECORDED (the caller gates this) — a draft is a
 * half-written account and a withdrawn event is retracted, neither of which a
 * formal notice should be raised from — but the composer itself asserts nothing
 * about status beyond stating it in the record it is given.
 */
export function composeEotNotice(input: EotNoticeInput): EotNotice {
  const e = input.event;
  const started = dd(e.startedOn)!;
  const ended = dd(e.endedOn);
  const cause = categoryLabel(e.category);
  const requested = dd(input.variation?.requestedCompletionDate ?? null);

  // Dates: an ongoing delay is a recorded fact, not an absent field.
  const periodField: EotNoticeField = ended
    ? fact("Period of delay", `${started} to ${ended}`)
    : fact("Period of delay", `Commenced ${started}; ongoing (no end date recorded)`);

  const extensionField: EotNoticeField =
    e.workingDaysLost !== null
      ? fact("Extension of time claimed", daysPhrase(e.workingDaysLost))
      : field("Extension of time claimed", null);

  const particulars: EotNoticeField[] = [
    field("Contract reference", input.contractReference),
    field("Clause relied upon", input.contractClause),
    field("Project / works", input.jobReference),
    fact("Nature of delay", cause),
    periodField,
    fact("Cause of delay", e.description.trim()),
    extensionField,
    field("Contract completion date", input.contractCompletionDate),
    field("Revised completion date sought", requested),
    evidenceField(input),
  ];

  // Deterministic body, built ONLY from the recorded facts above.
  const statements: string[] = [];
  statements.push(
    "We hereby give notice of a delay to the progress of the Works under the above contract.",
  );
  statements.push(`The delay is attributable to ${cause.toLowerCase()}. ${e.description.trim()}`);
  statements.push(
    ended
      ? `The delay commenced on ${started} and ceased on ${ended}.`
      : `The delay commenced on ${started} and is ongoing; no end date has yet been recorded.`,
  );
  statements.push(
    e.workingDaysLost !== null
      ? `The extension of time claimed in respect of this event is ${daysPhrase(
          e.workingDaysLost,
        )}. This figure is the amount recorded by us and has not been calculated from the calendar.`
      : "The extension of time attributable to this event has not yet been quantified.",
  );
  statements.push(
    requested
      ? `A revised completion date of ${requested} has been sought in connection with this event${
          input.variation
            ? ` (Variation #${String(input.variation.number ?? 0).padStart(3, "0")})`
            : ""
        }.`
      : "No revised completion date has been recorded in connection with this event.",
  );
  const evidence = evidenceField(input);
  statements.push(
    evidence.specified
      ? `The following records are relied upon in support of this notice: ${evidence.value}.`
      : "No contemporaneous records are currently linked to this delay in the register.",
  );
  statements.push(
    "This notice records the facts held for this event. Whether it constitutes a Relevant " +
      "Event or Compensation Event under the contract, and the extension of time it justifies, " +
      "are reserved for determination in accordance with the contract.",
  );

  const unspecified = particulars.filter((f) => !f.specified).map((f) => f.label);

  return {
    noticeDate: dd(input.noticeDate)!,
    reference: `EOT/${e.id.replace(/-/g, "").slice(0, 8).toUpperCase()}`,
    contractor: party(input.contractor),
    employer: party(input.employer),
    particulars,
    statements,
    disclaimer: EOT_NOTICE_DISCLAIMER,
    unspecified,
  };
}

// =====================================================================
// THE CONVERSATION INFORMATION ENGINE — PURE CORE (CEO Directive #018; R20: CONVERSATION
// INFORMATION ENGINE).
//
// R15 gave the runtime a coarse OWNERSHIP marker; R17 wrapped it in a formal STATE MACHINE ("which
// party owes the next turn"); R18 added the INTENT ENGINE ("what does the customer WANT?"); R19 added
// the GOAL ENGINE ("what is the conversation trying to ACCOMPLISH?"). R20 is the next layer UP — the
// single, canonical authority over a FOURTH question: "what STRUCTURED INFORMATION has the customer
// actually PROVIDED?" — the conversational INFORMATION (its extracted facts). It executes ON TOP of the
// whole stack (runtime → state machine → intent engine → goal engine) and consumes the SAME canonical
// context the runtime already assembled and the SAME goal the goal engine already resolved. It does NOT
// move the ownership state, the intent marker or the goal marker; it does NOT re-orchestrate the
// runtime, re-assemble context, reconstruct a conversation, re-classify the customer's message, or
// re-resolve intent or goal — every one of those layers already exists and this engine reuses them
// wholesale. It becomes the SINGLE SOURCE OF TRUTH for structured conversational information: no feature
// may extract information independently, and every future slot-filling, booking, scheduling, CRM-update,
// memory-retrieval, customer-support or workflow capability consumes THIS engine's information.
//
// IT EXTRACTS, IT NEVER ACTS. Recognising that the customer stated a postcode, an email, a phone number
// or a job type is INFORMATION EXTRACTION — a structured READ of what they provided. Booking execution,
// AI scheduling, slot-fill-driven prompting, memory retrieval, CRM writes and human handoff are EXPLICIT
// R20 NON-GOALS this engine does not perform: it extracts the information and stops. Acting on that
// information is a future capability that will CONSUME this engine. Slot filling is the FIRST such
// consumer — the {@link outstandingSlots} / {@link isInformationComplete} surface below is the seam it
// reads — but the engine itself only extracts; it never prompts, never books, never schedules.
//
// IT KEYS ON THE GOAL, IT READS THE CONTEXT. The goal answers "what is the conversation trying to
// accomplish?"; the INFORMATION is the set of facts that objective NEEDS. So the engine takes TWO inputs
// — the resolved {@link ConversationGoal} (which SELECTS the relevant fields, via {@link GOAL_SLOTS})
// and the canonical {@link ConversationContext} (which it READS the facts FROM). It reads ONLY the
// customer's own turns (`role === "customer"`); it NEVER extracts from the assistant's own drafts, so
// the receptionist can never "learn" a fact it merely proposed. It NEVER calls the goal resolver, the
// intent resolver or the context assembler — those are consumed at the runtime seam and threaded in — so
// it DUPLICATES no runtime orchestration, no context assembly, no intent resolution and no goal
// resolution (all four are R20 boundaries it must not re-implement). The layering is a clean, linear
// stack: Context → Intent → Goal → Information.
//
// IT IS A PURE, MODEL-FREE EXTRACTION CALCULUS, exactly like lib/receptionist/runtime.ts and the R18/R19
// engines. It reaches NO policy, NO provider, NO ledger, NO database, NO clock, NO RNG and — the cardinal
// rule shared with the R12 assembler and the R18/R19 engines — NO MODEL: every field is extracted by a
// NAMED, TOTAL, DETERMINISTIC regex/keyword matcher, never by an opaque model sample, so the same
// context always yields the same information and the extraction is reconstructable from source. Its only
// imports are the R12 context TYPE (its input contract), the R19 goal TYPE (its field selector) and the
// canonical UK phone normaliser {@link toE164} (a pure primitive the runtime ALREADY uses, so an
// extracted phone is stored in the SAME E.164 form the transport dials — never a second, divergent
// normalisation). It reaches no other module.
//
// EXTRACTION AND VALIDATION ARE UNIFIED. Every field extractor is ALSO that field's validator: it
// returns a value ONLY when the candidate passes the field's format check (a real email, a UK-shaped
// phone, a UK-shaped postcode, a known job type), so an INVALID candidate never enters the information
// record. Validation is therefore not a separate, fallible pass that could admit malformed data; it is
// intrinsic to extraction. The same predicates are exposed ({@link isValidFieldValue}) and re-applied on
// READ ({@link coerceConversationInformation}) as defence-in-depth against a malformed persisted value.
//
// INFORMATION PROGRESSION IS MONOTONIC ACCUMULATION. A conversation's information only ever GROWS: the
// turn fold ({@link advanceInformation}) merges freshly-extracted fields onto the prior record, keeping
// every known field and adopting the freshest value for a field the customer restated. The turn planner
// ({@link planInformationUpdate}) classifies the turn as `updated` (new or changed fields to persist) or
// `unchanged` (nothing new). Unlike the R17/R18/R19 markers there is no `rejected` arm — extraction
// validates on the way in, so an invalid value can never be proposed; the only outcomes are "learned
// something" or "learned nothing". The engine accumulates information WITHIN the turn the state machine
// already owns, the intent engine already classified and the goal engine already resolved; it moves none
// of their markers, so information extraction can never bypass any layer beneath it.
// =====================================================================

import { toE164 } from "@/lib/phone";
import type { ConversationContext } from "@/lib/receptionist/conversation-context";
import type { ConversationGoal } from "@/lib/receptionist/conversation-goal";

// ---------------------------------------------------------------------
// The information MODEL — the closed field vocabulary and the record shape.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of structured INFORMATION FIELDS the engine extracts — the facts a customer can
 * provide that a conversational objective needs:
 *   • email_address — the customer's email, extracted verbatim + lower-cased (a real address, not a
 *                     placeholder).
 *   • phone_number  — the customer's phone, normalised to canonical E.164 (`+44…`) — the SAME form the
 *                     SMS transport dials — from a UK-shaped number in the message.
 *   • postcode      — the customer's UK postcode, normalised to canonical `OUTWARD INWARD` upper-case.
 *   • job_type      — WHAT the customer needs done, mapped to one of {@link JOB_TYPES} by deterministic
 *                     keyword.
 * A deliberately small, closed set — the engine extracts only facts it can read DETERMINISTICALLY from
 * free text (regex / keyword), never a fact that would need a model to infer. (Contact NAME is
 * deliberately excluded: it cannot be extracted reliably without a model, and the R10 container already
 * carries `contact_name`.) The single source of the field vocabulary on the TypeScript side — kept in
 * lock-step with the migration's key validation
 * (supabase/migrations/20260825000000_receptionist_conversation_information.sql).
 */
export const INFORMATION_FIELDS = [
  "email_address",
  "phone_number",
  "postcode",
  "job_type",
] as const;

/** One structured information field the engine can extract. */
export type InformationField = (typeof INFORMATION_FIELDS)[number];

/**
 * The closed vocabulary of JOB TYPES — the canonical categories the `job_type` field resolves to, one per
 * broad trade the customer might describe. Deliberately coarse: the engine LABELS what kind of work the
 * customer needs (so a future capability can route it), it does not model a job specification. A closed
 * set, so an extracted job type is always one of these known values (and {@link isValidFieldValue}
 * enforces that on read).
 */
export const JOB_TYPES = [
  "plumbing",
  "electrical",
  "roofing",
  "carpentry",
  "plastering",
  "painting",
  "landscaping",
  "building",
] as const;

/** One canonical job-type category. */
export type JobType = (typeof JOB_TYPES)[number];

/**
 * The structured INFORMATION a conversation has accumulated — a partial map from field to its canonical
 * string value. Partial by design: a field is PRESENT only once the customer has actually provided it, so
 * the mere presence of a key is itself the "we know this" signal (and its absence, "still outstanding").
 * This is the exact shape persisted as the `information` jsonb column and the shape every future consumer
 * reads. A brand-new conversation has {@link EMPTY_INFORMATION}.
 */
export type ConversationInformation = Partial<Record<InformationField, string>>;

/** A conversation that has provided nothing yet: the initial value, and the safe default for an absent or
 *  unparseable persisted value. Frozen so the shared constant can never be mutated by a consumer. */
export const EMPTY_INFORMATION: ConversationInformation = Object.freeze({});

// ---------------------------------------------------------------------
// The field EXTRACTORS — deterministic, total, model-free. Each is ALSO its field's validator: it
// returns a canonical value ONLY for a candidate that passes the field's format check, else null.
// ---------------------------------------------------------------------

/** A single email address in free text: the standard local@domain.tld shape. */
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/** Substrings that mark a "placeholder" email — reserved example domains and form stand-ins that are
 *  never a real customer contact. An address containing any of these is refused, so the engine never
 *  stores a fabricated contact (mirrors the R5 research extractor's noise filter). */
const EMAIL_PLACEHOLDERS: readonly string[] = [
  "example.",
  "yourdomain",
  "domain.com",
  "email@",
  "name@",
  "your@",
  "test@test",
];

/** Extract the customer's email: the first real address in the text, lower-cased, or null. Refuses
 *  placeholder / reserved-example addresses so a fabricated contact never enters the record. */
function extractEmail(text: string): string | null {
  const m = EMAIL_RE.exec(text);
  if (!m) return null;
  const email = m[0].toLowerCase();
  if (EMAIL_PLACEHOLDERS.some((p) => email.includes(p))) return null;
  return email;
}

/** A UK phone number in free text: a `+44` international prefix or a leading-`0` national trunk, then
 *  8 to 11 further digits with optional human separators (spaces, dashes, brackets, dots). Conservative —
 *  it matches only UK-prefixed shapes, so a bare run of digits (a house number, a quantity) is ignored. */
const PHONE_RE = /(?:\+44\s?|\b0)(?:\d[\s().-]?){8,11}\d/;

/** Extract the customer's phone: the first UK-shaped number, normalised to canonical E.164 (`+44…`) via
 *  the SAME {@link toE164} the SMS transport uses, or null. Validates the digit count (10 to 13, covering UK
 *  national and `+44` international forms) BEFORE normalising, so a too-short/too-long candidate is
 *  refused rather than coerced into a malformed `+44…` string. */
function extractPhone(text: string): string | null {
  const m = PHONE_RE.exec(text);
  if (!m) return null;
  const digits = m[0].replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 13) return null;
  return toE164(m[0]);
}

/** A UK postcode in free text: outward code (1 to 2 letters, a digit, an optional letter/digit), an optional
 *  space, then the inward code (a digit and two letters). Captures the two halves so they can be joined in
 *  the one canonical `OUTWARD INWARD` form. */
const POSTCODE_RE = /\b([A-Za-z]{1,2}\d[A-Za-z\d]?)\s*(\d[A-Za-z]{2})\b/;

/** Extract the customer's UK postcode, normalised to canonical upper-case `OUTWARD INWARD` (a single
 *  space between the halves regardless of how it was typed), or null. */
function extractPostcode(text: string): string | null {
  const m = POSTCODE_RE.exec(text);
  if (!m || !m[1] || !m[2]) return null;
  return `${m[1].toUpperCase()} ${m[2].toUpperCase()}`;
}

/**
 * The keyword cues that map free text to a canonical {@link JobType}. Each entry is `[job type, cue]`; the
 * FIRST cue that matches wins, so the order encodes priority. Deterministic and closed — the same text
 * always resolves the same job type, and an extracted job type is always one of {@link JOB_TYPES}. The
 * cues are the customer's OWN vocabulary ("boiler", "socket", "leak", "roof") mapped to the trade that
 * handles it — not the trade name alone, so a customer describing the SYMPTOM still resolves the category.
 */
const JOB_TYPE_CUES: ReadonlyArray<readonly [JobType, RegExp]> = [
  ["plumbing", /\b(?:plumb(?:er|ing)?|boiler|radiator|leak(?:ing|s)?|tap|pipe|drain|drainage|heating|hot water|toilet|shower|sink|central heating)\b/i],
  ["electrical", /\b(?:electric(?:al|ian|s)?|socket|wiring|rewir(?:e|ing)|fuse ?board|consumer unit|lighting|light fitting|fuse|circuit)\b/i],
  ["roofing", /\b(?:roof(?:ing|er|s)?|gutter(?:ing|s)?|tile(?:s|d)?|slate(?:s)?|chimney|fascia|soffit|flashing|leadwork)\b/i],
  ["carpentry", /\b(?:carpenter|carpentry|joiner|joinery|skirting|architrave|shelv(?:es|ing)|worktop|stud wall|door frame)\b/i],
  ["plastering", /\b(?:plaster(?:er|ing)?|render(?:ing)?|skim(?:ming)?|artex|coving)\b/i],
  ["painting", /\b(?:paint(?:er|ing|work)?|decorat(?:or|ing|e)?|wallpaper(?:ing)?|emulsion)\b/i],
  ["landscaping", /\b(?:landscap(?:er|ing|e)?|garden(?:er|ing|s)?|patio|decking|deck|fenc(?:e|ing)|paving|turf|lawn|hedge)\b/i],
  ["building", /\b(?:build(?:er|ing)?|extension|renovat(?:e|ion|ing)?|conversion|brick(?:work|laying)?|blockwork|construction|groundwork|foundation)\b/i],
];

/** Extract the job type the customer described, mapped to a canonical {@link JobType} by the first
 *  matching cue, or null when no cue matches. */
function extractJobType(text: string): string | null {
  for (const [jobType, cue] of JOB_TYPE_CUES) {
    if (cue.test(text)) return jobType;
  }
  return null;
}

/** One field's extractor: a pure, total, model-free reader that returns the field's canonical value for a
 *  message, or null when the message carries no valid value for it. */
type FieldExtractor = (text: string) => string | null;

/**
 * The canonical field → extractor binding. TOTAL over {@link InformationField} — the `Record` type makes
 * the exhaustiveness a COMPILE-TIME guarantee (a missing or out-of-vocabulary key fails `tsc`), so a new
 * field cannot be added to the vocabulary without also binding its extractor. Module-private:
 * {@link extractInformation} is the ONLY exported reader, so extraction happens in exactly one place.
 */
const EXTRACTORS: Readonly<Record<InformationField, FieldExtractor>> = {
  email_address: extractEmail,
  phone_number: extractPhone,
  postcode: extractPostcode,
  job_type: extractJobType,
};

// ---------------------------------------------------------------------
// The field VALIDATORS — the SAME format checks the extractors apply, exposed as named predicates and
// re-applied on read. Extraction guarantees a stored value passes its validator; the validator guards a
// PERSISTED value on the way back in.
// ---------------------------------------------------------------------

/** Whether a value is a well-formed member of a field — the canonical, post-extraction shape:
 *  a real (non-placeholder) email, a `+44…`-canonical phone, an `OUTWARD INWARD` postcode, or a known
 *  {@link JobType}. TOTAL and DETERMINISTIC per field. */
const VALIDATORS: Readonly<Record<InformationField, (value: string) => boolean>> = {
  email_address: (v) => EMAIL_RE.test(v) && !EMAIL_PLACEHOLDERS.some((p) => v.includes(p)),
  phone_number: (v) => /^\+\d{10,15}$/.test(v),
  postcode: (v) => /^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/.test(v),
  job_type: (v) => (JOB_TYPES as readonly string[]).includes(v),
};

/** Narrow an arbitrary value to a known {@link InformationField}. */
export function isInformationField(value: unknown): value is InformationField {
  return typeof value === "string" && (INFORMATION_FIELDS as readonly string[]).includes(value);
}

/** Whether `value` is a well-formed value for `field` — the field's canonical format check, exposed so
 *  every consumer validates a value the ONE way the engine defines. */
export function isValidFieldValue(field: InformationField, value: string): boolean {
  return VALIDATORS[field](value);
}

/**
 * Coerce a possibly-unknown persisted value (the raw `information` jsonb) to a
 * {@link ConversationInformation}, keeping ONLY well-formed, in-vocabulary fields and dropping everything
 * else. DENY-UNKNOWN and TOTAL: any input resolves to a valid record (an empty one for a non-object), so
 * the runtime can read a raw column value without a throw and never adopt a field or a malformed value the
 * engine would reject. Defence-in-depth: even though the writer and the extractors both guarantee a valid
 * shape, a value read back from the database is re-validated here before the runtime trusts it.
 */
export function coerceConversationInformation(value: unknown): ConversationInformation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: ConversationInformation = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (isInformationField(key) && typeof raw === "string" && isValidFieldValue(key, raw)) {
      out[key] = raw;
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// The GOAL → SLOTS schema — which fields each objective NEEDS. This is the slot-filling schema, and it
// lives HERE (in the information engine), NOT in the goal engine: the goal engine only NAMES the
// objective; deciding which facts that objective requires is an INFORMATION concern, so R19 stays
// untouched and R20 owns the mapping.
// ---------------------------------------------------------------------

/**
 * The information fields each {@link ConversationGoal} needs to be actionable — the "slots" a future
 * capability would fill for that objective. TOTAL over the whole goal vocabulary — the `Record` type makes
 * the exhaustiveness a COMPILE-TIME guarantee, so this schema and the goal vocabulary can never drift.
 * `undetermined` and `answer_enquiry` need NOTHING structured (there is no objective to fill yet, and an
 * enquiry is answered from the message itself), so the engine extracts nothing for them — extraction is
 * SCOPED to what the current objective actually needs, never a blanket scrape of every field.
 */
export const GOAL_SLOTS: Readonly<Record<ConversationGoal, readonly InformationField[]>> = {
  undetermined: [],
  answer_enquiry: [],
  arrange_booking: ["job_type", "postcode", "phone_number"],
  arrange_callback: ["phone_number"],
  provide_quote: ["job_type", "postcode", "phone_number", "email_address"],
  handoff_to_human: ["phone_number"],
};

// ---------------------------------------------------------------------
// EXTRACTION — read the customer's turns, extract the fields the current goal needs.
// ---------------------------------------------------------------------

/**
 * Extract the structured information the current {@link ConversationGoal} needs from a conversation's
 * canonical {@link ConversationContext}. THE single exported extractor: every consumer extracts through
 * this function and no other way, so the engine is the single source of truth for conversational
 * information.
 *
 * DETERMINISTIC, TOTAL and MODEL-FREE. It reads ONLY the customer's own turns (`role === "customer"`) —
 * NEVER the assistant's drafts, so the receptionist can never "learn" a fact it merely proposed. For each
 * field the goal needs (via {@link GOAL_SLOTS}) it scans the customer turns NEWEST→OLDEST and takes the
 * first valid value, so the customer's MOST RECENT statement of a fact wins (a correction supersedes an
 * earlier value). A goal that needs no structured information (`undetermined` / `answer_enquiry`) yields
 * the empty record without reading anything. The result is a fresh record of ONLY what THIS context
 * provides — it is folded onto the prior persisted information by {@link advanceInformation}; it is not
 * itself the accumulated total.
 */
export function extractInformation(
  context: ConversationContext,
  goal: ConversationGoal,
): ConversationInformation {
  const slots = GOAL_SLOTS[goal];
  if (slots.length === 0) return {};
  // The customer's own turns, oldest→newest as the context orders them.
  const customerTexts = context.messages
    .filter((message) => message.role === "customer")
    .map((message) => message.text);
  const out: ConversationInformation = {};
  for (const field of slots) {
    const extract = EXTRACTORS[field];
    // Newest→oldest: the customer's most recent statement of the fact wins.
    for (let i = customerTexts.length - 1; i >= 0; i--) {
      const text = customerTexts[i];
      if (text === undefined) continue;
      const value = extract(text);
      if (value !== null) {
        out[field] = value;
        break;
      }
    }
  }
  return out;
}

// =====================================================================
// THE INFORMATION PROGRESSION MODEL (CEO Directive #018, R20).
//
// Extraction answers "what did THIS context provide?"; progression governs "how does the accumulated
// information MOVE?". It is the information analogue of the R17/R18/R19 progression models, with ONE
// structural difference: information is not a single closed marker with a legal-edge relation, it is a
// GROWING record, so its ONE law is MONOTONIC ACCUMULATION — a conversation's known fields only ever grow
// (a field can be RESTATED to a fresher value, but never dropped). There is no `rejected` arm: extraction
// validates on the way in, so an invalid value can never be proposed to the fold. The only turn outcomes
// are `updated` (new or changed fields to persist) and `unchanged` (nothing new).
// =====================================================================

/**
 * Fold freshly-extracted information onto the prior accumulated record — the information analogue of the
 * R18 `advanceIntent` / R19 `advanceGoal` folds. TOTAL: keep every prior field, and adopt each freshly
 * extracted field (a restated fact supersedes its earlier value; a field the turn did not extract is
 * left as it was). This is what makes progression MONOTONIC in the KEYS — the set of known fields never
 * shrinks. DETERMINISTIC — the same (prior, extracted) always yields the same next record — so a
 * conversation's information is a pure fold over its ordered per-turn extractions. Returns a NEW record;
 * neither input is mutated.
 */
export function advanceInformation(
  prior: ConversationInformation,
  extracted: ConversationInformation,
): ConversationInformation {
  return { ...prior, ...extracted };
}

/**
 * A governed information update the runtime executes, discriminated on `kind`:
 *   • updated   — the fold produced new or changed fields; the runtime PERSISTS `information`, and `added`
 *                 names exactly the fields that appeared or changed (for the audit record).
 *   • unchanged — the fold produced nothing the record did not already hold; nothing is persisted.
 * There is deliberately no `rejected` arm (unlike the R17/R18/R19 transition plans): a value can only
 * enter through an extractor, which validates it, so a malformed value can never be proposed. The runtime
 * persists exactly the `updated` case and can never write an unvalidated field.
 */
export type InformationUpdate =
  | { kind: "updated"; information: ConversationInformation; added: readonly InformationField[] }
  | { kind: "unchanged"; information: ConversationInformation };

/**
 * Plan the information update a TURN drives: fold the freshly-extracted information onto the prior via
 * {@link advanceInformation}, then report whether anything actually changed. `added` collects every field
 * whose value in the folded record differs from the prior (a newly-appeared field OR a restated one).
 * When `added` is empty the turn is `unchanged` (nothing to persist); otherwise it is `updated` and
 * carries the full next record to persist. TOTAL and DETERMINISTIC — every (prior, extracted) pair
 * resolves to exactly one plan. THE one entry point the runtime calls to govern a turn's information
 * accumulation.
 */
export function planInformationUpdate(
  prior: ConversationInformation,
  extracted: ConversationInformation,
): InformationUpdate {
  const information = advanceInformation(prior, extracted);
  const added: InformationField[] = [];
  for (const field of INFORMATION_FIELDS) {
    if (information[field] !== prior[field]) added.push(field);
  }
  if (added.length === 0) return { kind: "unchanged", information: prior };
  return { kind: "updated", information, added };
}

// ---------------------------------------------------------------------
// The SLOT-FILLING surface — the FIRST consumer of the engine. It only READS the schema + the accumulated
// information; it never prompts, books or schedules (all R20 non-goals). A future slot-filling capability
// reads these to decide what it still needs to ask for.
// ---------------------------------------------------------------------

/** The information fields a {@link ConversationGoal} needs — the objective's slot schema. */
export function slotsFor(goal: ConversationGoal): readonly InformationField[] {
  return GOAL_SLOTS[goal];
}

/**
 * The fields a goal needs that the conversation has NOT yet provided — the OUTSTANDING slots. Deterministic
 * and total: the goal's slot schema minus the fields already present in `information`. An empty result
 * means the objective's information is complete. This is the exact seam a slot-filling capability reads to
 * decide what to ask for next; the engine computes it but takes no action on it.
 */
export function outstandingSlots(
  goal: ConversationGoal,
  information: ConversationInformation,
): readonly InformationField[] {
  return GOAL_SLOTS[goal].filter((field) => information[field] === undefined);
}

/**
 * Whether a goal's information is COMPLETE — every field the objective needs has been provided. True (
 * vacuously) for a goal that needs no structured information (`undetermined` / `answer_enquiry`).
 * Deterministic and total. A future capability reads this to know an objective is ready to act on; the
 * engine only reports it.
 */
export function isInformationComplete(
  goal: ConversationGoal,
  information: ConversationInformation,
): boolean {
  return outstandingSlots(goal, information).length === 0;
}

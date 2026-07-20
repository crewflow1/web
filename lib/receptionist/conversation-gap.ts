// =====================================================================
// THE CONVERSATION GAP ENGINE — PURE CORE (CEO Directive #018; R21: CONVERSATION GAP ENGINE).
//
// R15 gave the runtime a coarse OWNERSHIP marker; R17 wrapped it in a formal STATE MACHINE ("which party
// owes the next turn"); R18 added the INTENT ENGINE ("what does the customer WANT?"); R19 added the GOAL
// ENGINE ("what is the conversation trying to ACCOMPLISH?"); R20 added the INFORMATION ENGINE ("what
// STRUCTURED FACTS has the customer PROVIDED?"). R21 is the next layer UP — the single, canonical authority
// over a FIFTH question, one DERIVED from the layers beneath it: "given the objective and the facts we
// hold, WHAT IS STILL MISSING, which missing item matters MOST, is the objective SATISFIED, and is another
// conversational turn REQUIRED?" — the conversational GAP.
//
// IT IS A PURE, DERIVED FUNCTION — IT PERSISTS NOTHING. This engine is the FIRST layer of the stack that
// adds NO column and NO migration. The gap is a TOTAL, DETERMINISTIC function of two ALREADY-PERSISTED
// observations — the resolved {@link ConversationGoal} (R19) and the accumulated {@link ConversationInformation}
// (R20). Persisting the gap would create a SECOND source of truth that could drift from the goal + information
// it derives from; instead the gap is COMPUTED wherever it is needed (surfaced on the runtime turn result;
// re-derived on every read of the read model) and never stored. Goal + information remain the ONLY persisted
// conversational state; the gap is always a fresh projection of them, so it can never be stale.
//
// IT DERIVES, IT NEVER ACTS. Determining that a booking objective still needs a postcode, or that a quote
// objective is complete, is a READ over what the customer has provided — a completeness OBSERVATION. Booking
// execution, AI scheduling, slot-fill-driven prompting, memory retrieval, CRM writes and human handoff are
// EXPLICIT R21 NON-GOALS this engine does not perform: it identifies the missing information and stops.
// ACTING on the gap — asking the next question, booking, scheduling — is a future capability that will
// CONSUME this engine. Slot filling is the FIRST such consumer: it reads {@link detectGap} to know which
// field to request next, but the request itself, and every business action, lives OUTSIDE this engine.
//
// IT REUSES THE R20 COMPLETENESS SURFACE — IT FORKS NO COMPLETENESS LOGIC. The question "which fields does
// this objective NEED, and which are OUTSTANDING?" is answered by the R20 information engine's slot surface
// ({@link outstandingSlots}, {@link isInformationComplete}) — the SINGLE source of truth for the goal→slots
// schema and for completeness. This engine IMPORTS that surface and re-implements NONE of it: it adds only
// the completeness SEMANTICS that sit on top — a cross-goal PRIORITY ordering ({@link FIELD_PRIORITY}), the
// SINGLE next-required item, and the "another turn required?" predicate. So there is exactly ONE definition
// of "what a goal needs / what is missing" (R20) and exactly ONE definition of "which missing item is most
// important / is the objective satisfied / is another turn required" (R21) — no feature computes either
// independently.
//
// IT DUPLICATES NOTHING BENEATH IT. It consumes an ALREADY-resolved goal and ALREADY-extracted information;
// it NEVER re-assembles context, re-classifies intent, re-resolves goal, or RE-EXTRACTS information — it
// names none of those resolvers, planners or extractors. Its only imports are the R19 goal TYPE (which it
// keys the gap on) and the R20 information engine's slot surface + types (which it reads completeness from).
// It reaches NO policy, NO provider, NO ledger, NO DB, NO clock, NO RNG and — the cardinal rule shared with
// the whole stack — NO MODEL: the gap is computed by named, total, deterministic set arithmetic, so the same
// (goal, information) always yields the same gap and the derivation is reconstructable from source. The
// layering stays a clean, linear stack: Context → Intent → Goal → Information → Gap.
// =====================================================================

import type { ConversationGoal } from "@/lib/receptionist/conversation-goal";
import {
  isInformationComplete,
  outstandingSlots,
  type ConversationInformation,
  type InformationField,
} from "@/lib/receptionist/conversation-information";

// ---------------------------------------------------------------------
// The PRIORITY model — a cross-goal ordering over the whole information vocabulary.
// ---------------------------------------------------------------------

/**
 * The order in which OUTSTANDING information should be requested, most-important FIRST — the gap engine's
 * one PRIORITY rule, defined ONCE here. A cross-goal TOTAL ORDER over the whole {@link InformationField}
 * vocabulary (a permutation of R20's `INFORMATION_FIELDS`): qualify the WORK and its LOCATION first
 * (`job_type`, then `postcode`), then a means of CONTACT (`phone_number`), then the email (`email_address`)
 * last. This is an INDEPENDENT semantic ordering, NOT a copy of the field vocabulary's declaration order
 * nor of any single goal's slot schema: a goal's slots are a SUBSET of these fields, and prioritising that
 * subset against this global order yields the next field to request. Because it is a permutation of the
 * closed field vocabulary, every field the schema can ask for has a defined rank, so {@link prioritiseFields}
 * is total. `satisfies` pins every entry to a real field at compile time; the unit + security tiers pin that
 * it is an exact permutation (no missing field, no duplicate, no out-of-vocabulary entry).
 */
export const FIELD_PRIORITY = [
  "job_type",
  "postcode",
  "phone_number",
  "email_address",
] as const satisfies readonly InformationField[];

/**
 * Order a set of information fields by {@link FIELD_PRIORITY}, most-important first. Pure, total and
 * NON-MUTATING: it copies before sorting, so a caller's array is never reordered under it, and every field
 * has a defined rank (FIELD_PRIORITY is a permutation of the whole vocabulary), so the result is a stable,
 * deterministic reordering of exactly the input fields. Duplicates in the input are preserved (the schema
 * never produces them, but the function does not assume it).
 */
export function prioritiseFields(
  fields: readonly InformationField[],
): InformationField[] {
  return [...fields].sort(
    (a, b) => FIELD_PRIORITY.indexOf(a) - FIELD_PRIORITY.indexOf(b),
  );
}

// ---------------------------------------------------------------------
// The GAP model — the derived completeness view of a (goal, information) pair.
// ---------------------------------------------------------------------

/**
 * The conversational GAP for one (goal, information) pair — the DERIVED completeness view a future
 * capability reads:
 *   • goal         — the objective the gap is measured against (the R19 goal of record).
 *   • missing      — the fields the objective NEEDS that the conversation has NOT yet provided, ordered by
 *                    {@link FIELD_PRIORITY} (most-important first). Empty ⇔ the objective is `satisfied`.
 *   • nextRequired — the single highest-priority missing field (`missing[0]`), or null when nothing is
 *                    outstanding. THE one item a slot-filling capability would request next.
 *   • satisfied    — whether the objective's information is COMPLETE (delegated to R20's
 *                    {@link isInformationComplete} — the single completeness authority). True (vacuously)
 *                    for a goal that needs no structured information.
 *   • turnRequired — whether another conversational turn is required to GATHER outstanding information,
 *                    i.e. `!satisfied`. A pure OBSERVATION about completeness — it does NOT gate the
 *                    runtime (the turn still generates its reply); it tells a future capability whether the
 *                    objective still needs something from the customer.
 * Every field is a total, deterministic function of (goal, information); the whole object is derived, never
 * persisted.
 */
export type ConversationGap = {
  goal: ConversationGoal;
  missing: readonly InformationField[];
  nextRequired: InformationField | null;
  satisfied: boolean;
  turnRequired: boolean;
};

/**
 * The fields a goal NEEDS that the conversation has NOT yet provided, ordered by {@link FIELD_PRIORITY} —
 * R20's schema-ordered {@link outstandingSlots} re-ordered by the gap engine's priority. Deterministic and
 * total. THE missing-information list, most-important first.
 */
export function missingInformation(
  goal: ConversationGoal,
  information: ConversationInformation,
): readonly InformationField[] {
  return prioritiseFields(outstandingSlots(goal, information));
}

/**
 * The SINGLE highest-priority field the objective still needs, or null when its information is complete —
 * the head of {@link missingInformation}. THE one item a slot-filling capability requests next.
 * Deterministic and total.
 */
export function nextRequiredInformation(
  goal: ConversationGoal,
  information: ConversationInformation,
): InformationField | null {
  return missingInformation(goal, information)[0] ?? null;
}

/**
 * Whether the goal's information is COMPLETE — every field the objective needs has been provided. Delegates
 * WHOLESALE to R20's {@link isInformationComplete}, the single completeness authority; the gap engine adds
 * no second completeness rule. True (vacuously) for a goal that needs no structured information.
 */
export function isGoalSatisfied(
  goal: ConversationGoal,
  information: ConversationInformation,
): boolean {
  return isInformationComplete(goal, information);
}

/**
 * Whether another conversational turn is required to GATHER outstanding information — the negation of
 * {@link isGoalSatisfied}. A pure completeness OBSERVATION: it reports that the objective still needs
 * something from the customer; it does NOT gate the runtime or trigger any action. Deterministic and total.
 */
export function isTurnRequired(
  goal: ConversationGoal,
  information: ConversationInformation,
): boolean {
  return !isGoalSatisfied(goal, information);
}

/**
 * Detect the conversational GAP for a (goal, information) pair — THE single entry point the runtime and the
 * read model call. Composes the derived view: the priority-ordered {@link missingInformation}, its head
 * ({@link nextRequiredInformation}), completeness ({@link isGoalSatisfied}, delegated to R20) and the
 * turn-required predicate. Pure, TOTAL over the whole goal vocabulary × any information record, and
 * DETERMINISTIC — the same (goal, information) always yields the same gap. Persists NOTHING: the gap is a
 * fresh projection of the two persisted observations, never a stored third one. THE single source of truth
 * for conversational completeness — every consumer derives the gap through this function and no other way.
 */
export function detectGap(
  goal: ConversationGoal,
  information: ConversationInformation,
): ConversationGap {
  const missing = missingInformation(goal, information);
  const satisfied = isInformationComplete(goal, information);
  return {
    goal,
    missing,
    nextRequired: missing[0] ?? null,
    satisfied,
    turnRequired: !satisfied,
  };
}

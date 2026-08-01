/**
 * EOT delay events — the LIFECYCLE domain (PURE).
 *
 * Mirrors the database graph in supabase/migrations/20261084000000 exactly.
 * The DATABASE is the authority (tg_delay_event_transition refuses illegal
 * writes for every role); these functions exist so the UI and actions can
 * produce readable refusals BEFORE the round-trip, and so the graph is
 * unit-testable without Postgres. If this file and the trigger ever disagree,
 * the trigger wins and this file is the bug.
 *
 * No I/O, no Date construction (`today` is always injected), no AI, no money.
 */

// ── Categories ───────────────────────────────────────────────────────────────

/**
 * The heads of delay. MUST match the `category` CHECK in 20261084 byte for
 * byte — asserted by __tests__/security/eot-delay-events.test.ts (the
 * attachment-target-drift idiom), so the list cannot drift from the DB.
 */
export const DELAY_CATEGORIES = [
  "weather",
  "client_instruction",
  "access_restriction",
  "third_party_dependency",
  "design_change",
  "other",
] as const;
export type DelayCategory = (typeof DELAY_CATEGORIES)[number];

export const DELAY_CATEGORY_LABELS: Record<DelayCategory, string> = {
  weather: "Weather",
  client_instruction: "Client instruction",
  access_restriction: "Access restriction",
  third_party_dependency: "Third-party dependency",
  design_change: "Design change / information",
  other: "Other",
};

/** One-line meaning, shown beside the picker so events are filed consistently. */
export const DELAY_CATEGORY_DESCRIPTIONS: Record<DelayCategory, string> = {
  weather: "Work stopped or slowed by weather at the site — rain, wind, frost, heat.",
  client_instruction:
    "The client or their agent told you to stop, suspend, resequence or wait for a decision.",
  access_restriction:
    "The site could not be accessed or occupied as planned — possession, other trades, closures.",
  third_party_dependency:
    "Waiting on a party neither side controls — utilities, building control, supplier failure.",
  design_change:
    "Works stopped or redone because design information changed or was still awaited.",
  other: "Anything else — say what happened in the description.",
};

export function isDelayCategory(value: unknown): value is DelayCategory {
  return (
    typeof value === "string" && (DELAY_CATEGORIES as readonly string[]).includes(value)
  );
}

// ── Statuses + the graph ─────────────────────────────────────────────────────

export const DELAY_STATUSES = ["draft", "recorded", "withdrawn"] as const;
export type DelayEventStatus = (typeof DELAY_STATUSES)[number];

export const DELAY_STATUS_LABELS: Record<DelayEventStatus, string> = {
  draft: "Draft",
  recorded: "Recorded",
  withdrawn: "Withdrawn",
};

/**
 * The whole graph: draft → recorded → withdrawn. Nothing else.
 * draft → withdrawn is deliberately absent (a draft is deleted, not
 * withdrawn — a terminal row must never skip the recording gate), and there
 * is no route back from either non-draft state.
 */
export function canTransition(from: DelayEventStatus, to: DelayEventStatus): boolean {
  return (from === "draft" && to === "recorded") || (from === "recorded" && to === "withdrawn");
}

/** Drafts are freely editable; everything after is trigger-frozen. */
export function isEditable(status: DelayEventStatus): boolean {
  return status === "draft";
}

/** Hard delete is draft-only (and admin-only via RLS — a role fact, not a graph fact). */
export function isDeletable(status: DelayEventStatus): boolean {
  return status === "draft";
}

// ── Gates ────────────────────────────────────────────────────────────────────

/** The fields the recording gate examines. Dates are `YYYY-MM-DD` day keys. */
export interface DelayEventDraft {
  status: DelayEventStatus;
  category: string;
  startedOn: string;
  endedOn: string | null;
  workingDaysLost: number | null;
  description: string;
}

export interface GateResult {
  ok: boolean;
  /** Human-readable refusals, in display order. Empty when ok. */
  reasons: string[];
}

/**
 * May this draft be RECORDED? A friendly mirror of the DB gate (born-draft +
 * CHECKs + no-future guard). `today` is the viewer's Europe/London day key,
 * injected — never read from a clock here.
 *
 * An ONGOING delay (endedOn null) and an UNQUANTIFIED one (workingDaysLost
 * null) are both recordable ON PURPOSE: contemporaneous recording beats
 * completeness, and the DB permits write-once completion of both fields
 * later. The evidence pack surfaces them as gaps instead.
 */
export function recordGate(event: DelayEventDraft, today: string): GateResult {
  const reasons: string[] = [];
  if (event.status !== "draft") {
    reasons.push("Only a draft can be recorded.");
  }
  if (!isDelayCategory(event.category)) {
    reasons.push("Pick a delay category.");
  }
  if (event.description.trim().length === 0) {
    reasons.push("Describe what happened — the description is the record.");
  }
  if (!event.startedOn) {
    reasons.push("A delay needs a start date.");
  } else if (event.startedOn > today) {
    reasons.push("A delay cannot start in the future.");
  }
  if (event.endedOn !== null) {
    if (event.endedOn < event.startedOn) {
      reasons.push("The end date cannot be before the start date.");
    }
    if (event.endedOn > today) {
      reasons.push("A delay cannot end in the future.");
    }
  }
  if (event.workingDaysLost !== null && (event.workingDaysLost < 0 || !Number.isInteger(event.workingDaysLost))) {
    reasons.push("Working days lost must be a whole number, zero or more.");
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Which write-once completions are still open on a RECORDED event.
 * (NULL → value is a data COMPLETION the trigger permits; anything else on a
 * recorded event is refused — the 20261073 §4 idiom.)
 */
export function openCompletions(event: {
  status: DelayEventStatus;
  endedOn: string | null;
  workingDaysLost: number | null;
}): { endedOn: boolean; workingDaysLost: boolean } {
  const recorded = event.status === "recorded";
  return {
    endedOn: recorded && event.endedOn === null,
    workingDaysLost: recorded && event.workingDaysLost === null,
  };
}

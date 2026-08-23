import type { Tone } from "@/components/ui/tokens";

/**
 * CrewFlow HQ — the ONE decision/approval/work state language (product UX
 * rebuild, HQ phase).
 *
 * The Decision area spans four engines with four different status vocabularies
 * (approvals, decisions, the task engine, workflow sagas). A leader shouldn't
 * have to learn all four. This module maps each engine's REAL status onto one
 * small presentation vocabulary so the same word means the same thing everywhere:
 *
 *   NEEDS DECISION · NEEDS APPROVAL · DRAFT · READY · EXECUTING · COMPLETED ·
 *   REJECTED · FAILED
 *
 * PRESENTATION ONLY. This is a pure, display-layer module (no `server-only`, no
 * kernel import) — exactly like lib/approvals/state.ts and server/sdk/gate.ts
 * stay pure so the UI can read them. It changes NO enum, NO transition table, NO
 * authority. The governance kernel (server/sdk/*, the DB triggers, the
 * append-only histories) is untouched.
 *
 * HONESTY OVER TIDINESS. Several real states have no truthful home in the eight
 * and are deliberately left AS-IS (`canonical: false`) rather than forced into a
 * wrong bucket — the load-bearing examples:
 *   • an approval `approved` is READY, not COMPLETED — it is granted but the
 *     executor is dark, so nothing has run;
 *   • a decision `approved` is COMPLETED — recording the call is the whole act,
 *     there is no in-system next step (the same word, a different truth);
 *   • `expired` / `delayed` / `delegated` / `blocked` / `cancelled` /
 *     `abandoned` / `skipped` keep their own name — none of the eight means
 *     "the deadline lapsed" or "handed to someone else".
 */

/** The eight unified presentation states. */
export const PRESENTATION_STATES = [
  "needs_decision",
  "needs_approval",
  "draft",
  "ready",
  "executing",
  "completed",
  "rejected",
  "failed",
] as const;
export type PresentationState = (typeof PRESENTATION_STATES)[number];

export interface PresentationBadge {
  /** One of the eight unified states, or `null` when the real status has no honest home in them. */
  state: PresentationState | null;
  /** The label to render — the unified label, or the state's own name when left as-is. */
  label: string;
  /** Design-system tone (components/ui/tokens). Colour never carries meaning alone. */
  tone: Tone;
  /** True for one of the eight unified states; false for an honest as-is passthrough. */
  canonical: boolean;
  /** Optional emphasis (e.g. an escalated approval) — a badge, never a separate bucket. */
  urgent?: boolean;
}

/** The canonical eight — label + tone in one place. */
export const PRESENTATION_META: Record<
  PresentationState,
  { label: string; tone: Tone; blurb: string }
> = {
  needs_decision: {
    label: "Needs decision",
    tone: "amber",
    blurb: "Awaiting your call — nothing happens until you decide.",
  },
  needs_approval: {
    label: "Needs approval",
    tone: "amber",
    blurb: "An AI employee proposed this; a human must approve before anything is applied.",
  },
  draft: {
    label: "Draft",
    tone: "slate",
    blurb: "Prepared but not yet submitted for approval.",
  },
  ready: {
    label: "Ready",
    tone: "blue",
    blurb: "Approved/queued and waiting to run — the executor is dark, so nothing has run yet.",
  },
  executing: {
    label: "Executing",
    tone: "indigo",
    blurb: "In flight right now.",
  },
  completed: {
    label: "Completed",
    tone: "emerald",
    blurb: "Finished. For a decision, the call is recorded (acting on it stays a human's job).",
  },
  rejected: {
    label: "Rejected",
    tone: "red",
    blurb: "A human turned it down, with a reason.",
  },
  failed: {
    label: "Failed",
    tone: "red",
    blurb: "It ran and errored.",
  },
};

/** As-is states that keep their own name (never forced into the eight). */
const AS_IS: Record<string, { label: string; tone: Tone }> = {
  expired: { label: "Expired", tone: "slate" },
  delayed: { label: "Delayed", tone: "blue" },
  delegated: { label: "Delegated", tone: "slate" },
  blocked: { label: "Blocked", tone: "amber" },
  cancelled: { label: "Cancelled", tone: "slate" },
  abandoned: { label: "Abandoned", tone: "slate" },
  skipped: { label: "Skipped", tone: "slate" },
};

function canonical(state: PresentationState, extra?: Partial<PresentationBadge>): PresentationBadge {
  const meta = PRESENTATION_META[state];
  return { state, label: meta.label, tone: meta.tone, canonical: true, ...extra };
}

function asIs(status: string): PresentationBadge {
  const known = AS_IS[status];
  if (known) return { state: null, label: known.label, tone: known.tone, canonical: false };
  // Unknown status — title-case it, neutral tone, never guess a bucket.
  const label = status
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return { state: null, label, tone: "slate", canonical: false };
}

// ---------------------------------------------------------------------
// Per-engine mappers. Each takes the engine's REAL status string.
// (Sources audited: lib/approvals/state.ts, server/services/hq-decisions.ts,
//  server/services/hq-tasks.ts, lib/hq/workflow/model.ts, lib/drafts/model.ts.)
// ---------------------------------------------------------------------

/** Approval Engine: pending·escalated → NEEDS APPROVAL; approved → READY (granted, not run); rejected → REJECTED; expired → as-is. */
export function presentApprovalState(status: string): PresentationBadge {
  switch (status) {
    case "pending":
      return canonical("needs_approval");
    case "escalated":
      return canonical("needs_approval", { urgent: true });
    case "approved":
      return canonical("ready"); // granted; the executor is dark — NOT completed.
    case "rejected":
      return canonical("rejected");
    default:
      return asIs(status); // expired
  }
}

/** Decision Centre: proposed → NEEDS DECISION; approved → COMPLETED (recorded); rejected → REJECTED; delayed/delegated → as-is. */
export function presentDecisionState(status: string): PresentationBadge {
  switch (status) {
    case "proposed":
      return canonical("needs_decision");
    case "approved":
      return canonical("completed"); // the call is recorded — the whole act. NOT "ready to run".
    case "rejected":
      return canonical("rejected");
    default:
      return asIs(status); // delayed, delegated
  }
}

/** Task Engine: pending → READY; claimed/running/verifying → EXECUTING; waiting_approval → NEEDS APPROVAL; completed/failed direct; blocked/cancelled → as-is. */
export function presentTaskState(status: string): PresentationBadge {
  switch (status) {
    case "pending":
      return canonical("ready");
    case "claimed":
    case "running":
    case "verifying":
      return canonical("executing");
    case "waiting_approval":
      return canonical("needs_approval");
    case "completed":
      return canonical("completed");
    case "failed":
      return canonical("failed");
    default:
      return asIs(status); // blocked, cancelled
  }
}

/** Workflow saga: planned → READY; running → EXECUTING; done → COMPLETED; failed → FAILED; blocked/abandoned → as-is. */
export function presentSagaState(status: string): PresentationBadge {
  switch (status) {
    case "planned":
      return canonical("ready");
    case "running":
      return canonical("executing");
    case "done":
      return canonical("completed");
    case "failed":
      return canonical("failed");
    default:
      return asIs(status); // blocked, abandoned
  }
}

/** Saga step: pending → READY; running → EXECUTING; done → COMPLETED; failed → FAILED; blocked/skipped → as-is. */
export function presentStepState(status: string): PresentationBadge {
  switch (status) {
    case "pending":
      return canonical("ready");
    case "running":
      return canonical("executing");
    case "done":
      return canonical("completed");
    case "failed":
      return canonical("failed");
    default:
      return asIs(status); // blocked, skipped
  }
}

/** Draft: generated·fallback → DRAFT (provenance, not lifecycle). */
export function presentDraftState(_status: string): PresentationBadge {
  return canonical("draft");
}

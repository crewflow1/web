/**
 * AI Receptionist — the Reply Review Inbox PRESENTATION model (Directive #018, R14:
 * HUMAN HANDOFF & REPLY REVIEW INBOX).
 *
 * Pure presentation layer over the read-only `receptionist_review_queue` database view
 * (migration 20260821000000). NO I/O, NO vendor SDK, NO write path — it only shapes the
 * resolution fields of one queue row into the single COARSE STATE the inbox renders, and
 * holds the operator's triage vocabulary (labels, styles, filters). The view is the sole
 * source of truth; this module holds no state and mutates nothing.
 *
 * A held reply moves through exactly three states, decided PURELY by the resolution ledger:
 *   • pending   — no resolution recorded yet; the reply is awaiting a human decision.
 *   • sent      — a human sent it (a NEW allow-audit was transported through the pipeline).
 *   • dismissed — a human decided NOT to send it.
 * `deriveReviewState` folds the two resolution columns into that one triage bucket; it invents
 * no state the ledger did not record.
 */

/** The single coarse state a held reply is in — the operator's triage signal. */
export type ReviewState = "pending" | "sent" | "dismissed";

export const REVIEW_STATE_LABELS: Record<ReviewState, string> = {
  pending: "Awaiting review",
  sent: "Sent",
  dismissed: "Dismissed",
};

export const REVIEW_STATE_STYLES: Record<ReviewState, string> = {
  pending: "bg-amber-100 text-amber-800",
  sent: "bg-emerald-100 text-emerald-800",
  dismissed: "bg-slate-100 text-slate-700",
};

/** The minimal shape `deriveReviewState` needs — just the two resolution columns. A full
 *  `ReviewQueueItem` is structurally compatible, so the inbox passes one directly; tests pass
 *  this minimal shape. */
export type ReviewResolutionState = {
  resolution_id: string | null;
  resolution: "sent" | "dismissed" | null;
};

/**
 * Fold a queue row's resolution columns into its single coarse state. `resolution_id === null`
 * IS the definition of "still pending" (it mirrors `isPendingReview` in the service, so the UI
 * and the send/dismiss guards agree on exactly one predicate). A resolved row is `sent` or
 * `dismissed` per the ledger's `resolution`. Total and pure.
 */
export function deriveReviewState(item: ReviewResolutionState): ReviewState {
  if (item.resolution_id === null) return "pending";
  return item.resolution === "sent" ? "sent" : "dismissed";
}

/** True when a held reply is still awaiting a human decision — the one pending predicate the
 *  presentation layer shares with the service's `isPendingReview`. */
export function isPending(item: ReviewResolutionState): boolean {
  return deriveReviewState(item) === "pending";
}

/**
 * The operator triage filters for the inbox. `pending` first — the inbox opens on the
 * actionable bucket, unlike the (all-first) delivery monitor. Kept here so the surface and its
 * tests share one vocabulary.
 */
export const REVIEW_FILTERS = [
  { key: "pending", label: "Awaiting review" },
  { key: "sent", label: "Sent" },
  { key: "dismissed", label: "Dismissed" },
  { key: "all", label: "All" },
] as const;
export type ReviewFilter = (typeof REVIEW_FILTERS)[number]["key"];

export function isReviewFilter(value: unknown): value is ReviewFilter {
  return (
    typeof value === "string" &&
    (REVIEW_FILTERS as readonly { key: string }[]).some((f) => f.key === value)
  );
}

/**
 * Whether a derived state belongs in a given filter bucket. Pure — the inbox uses it both to
 * bucket-count the pills and to filter the rendered rows, so the counts and the filter can
 * never disagree.
 */
export function stateMatchesFilter(state: ReviewState, filter: ReviewFilter): boolean {
  if (filter === "all") return true;
  return state === filter;
}

/** Format a view timestamp as "YYYY-MM-DD HH:MM" (or an em dash when absent). */
export function formatReviewTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 16).replace("T", " ");
}

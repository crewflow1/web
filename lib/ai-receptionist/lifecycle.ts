/**
 * AI Receptionist — the reply-delivery LIFECYCLE read model (Directive #018, R9:
 * DELIVERY MONITORING — OPERATOR VISIBILITY).
 *
 * Pure presentation layer over the read-only `ai_reply_lifecycle` database view (migration
 * 20260818000000). NO I/O, NO vendor SDK, NO write path — it only shapes one lifecycle row
 * (an ai_reply_audits row ⟕ its ai_reply_transports attempt ⟕ its latest
 * ai_reply_delivery_receipts) into the labels the HQ monitoring surface renders, and
 * derives the single COARSE STAGE that answers "where did this reply actually get to?" at a
 * glance. The view is the sole source of truth; this module holds no state and mutates
 * nothing.
 *
 * The eight operator questions map onto a `LifecycleRow` like so:
 *   (1) Was a reply produced?              → the row exists (audit_id, draft, audit_at)
 *   (2) Allowed / reviewed / blocked?      → verdict, allowed
 *   (3) Was a transport attempted?         → transport_id (null ⇒ none)
 *   (4) Sent / failed?                     → transport_status, transport_failure_reason
 *   (5) Provider message id?               → provider_message_id
 *   (6) Terminal delivery status?          → delivery_status, delivery_terminal
 *   (7) When did each step happen?         → audit_at, transport_at, receipt_at
 *   (8) What caused any failure?           → enforcement_reason / transport_failure_reason /
 *                                            delivery_error_code
 * `deriveLifecycleStage` folds (2)→(6) into one triage bucket for the list view.
 */

/** One row of the `ai_reply_lifecycle` view. The transport_* and delivery_* fields are
 *  LEFT-joined, so they are null when no send was attempted / no receipt has arrived. */
export type LifecycleRow = {
  // (1)(2) the reply + its enforcement decision
  audit_id: string;
  org_id: string;
  employee_slug: string;
  channel: string;
  enquiry_id: string | null;
  lead_id: string | null;
  customer_ref: string | null;
  correlation_id: string;
  draft: string;
  verdict: string;
  allowed: boolean;
  categories: string[] | null;
  enforcement_reason: string;
  safe_text: string | null;
  audit_at: string;
  // (3)(4)(5) the transport attempt (null ⇒ none)
  transport_id: string | null;
  transport_status: string | null;
  transport_provider: string | null;
  provider_message_id: string | null;
  transport_failure_reason: string | null;
  to_ref: string | null;
  attempt: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  dedup_key: string | null;
  transport_at: string | null;
  // (6)(8) the latest delivery receipt (null ⇒ none yet)
  receipt_id: string | null;
  delivery_status: string | null;
  delivery_terminal: boolean | null;
  delivery_provider_status: string | null;
  delivery_error_code: string | null;
  receipt_at: string | null;
  receipt_count: number;
};

/**
 * The single coarse stage a reply reached — the operator's triage signal. Ordered from
 * "stopped before send" to "final delivery fate". Derived PURELY from a row; it invents no
 * status the ledgers did not record.
 */
export type LifecycleStage =
  | "blocked" // enforcement refused the reply — no transport
  | "review" // enforcement held the reply for a human — no auto-transport
  | "not_sent" // allowed, but no transport attempted (yet)
  | "send_failed" // transport attempt failed (never reached / rejected by provider)
  | "awaiting_receipt" // sent; the provider has reported no status yet
  | "in_transit" // sent; a non-terminal provider status has arrived (queued/sending/…)
  | "delivered" // terminal receipt: delivered
  | "delivery_failed"; // terminal receipt: undelivered / failed / canceled

export const LIFECYCLE_STAGE_LABELS: Record<LifecycleStage, string> = {
  blocked: "Blocked",
  review: "Held for review",
  not_sent: "Not sent",
  send_failed: "Send failed",
  awaiting_receipt: "Awaiting receipt",
  in_transit: "In transit",
  delivered: "Delivered",
  delivery_failed: "Delivery failed",
};

export const LIFECYCLE_STAGE_STYLES: Record<LifecycleStage, string> = {
  blocked: "bg-red-100 text-red-800",
  review: "bg-amber-100 text-amber-800",
  not_sent: "bg-slate-100 text-slate-700",
  send_failed: "bg-red-100 text-red-800",
  awaiting_receipt: "bg-blue-100 text-blue-800",
  in_transit: "bg-blue-100 text-blue-800",
  delivered: "bg-emerald-100 text-emerald-800",
  delivery_failed: "bg-red-100 text-red-800",
};

/**
 * Fold a lifecycle row into its single coarse stage — the read model's one derived value.
 * The order of the checks IS the lifecycle: enforcement first (a held/blocked reply never
 * reaches a transport), then the transport attempt, then the provider's async fate. Every
 * branch is decided by a fact the ledgers recorded — this never fabricates a status.
 */
export function deriveLifecycleStage(row: LifecycleRow): LifecycleStage {
  // (2) Enforcement stopped it — a transport can never exist for these (DB-enforced).
  if (row.verdict === "block" || row.allowed === false) {
    return row.verdict === "review" ? "review" : "blocked";
  }
  if (row.verdict === "review") return "review";

  // (3) Allowed, but nothing was carried out.
  if (!row.transport_id) return "not_sent";

  // (4) The transport attempt itself failed.
  if (row.transport_status === "failed") return "send_failed";

  // (6) The provider's asynchronous fate, when it has reported one.
  if (row.delivery_terminal === true) {
    return row.delivery_status === "delivered" ? "delivered" : "delivery_failed";
  }
  if (row.receipt_id) return "in_transit"; // a non-terminal status has arrived
  return "awaiting_receipt"; // sent, provider silent so far
}

/** True when the stage is a settled, final outcome (no further transition expected). */
export function isTerminalStage(stage: LifecycleStage): boolean {
  return (
    stage === "blocked" ||
    stage === "send_failed" ||
    stage === "delivered" ||
    stage === "delivery_failed"
  );
}

/** Enforcement-verdict presentation (answers question 2). */
export const VERDICT_LABELS: Record<string, string> = {
  allow: "Allowed",
  review: "Review",
  block: "Blocked",
};
export const VERDICT_STYLES: Record<string, string> = {
  allow: "bg-emerald-100 text-emerald-800",
  review: "bg-amber-100 text-amber-800",
  block: "bg-red-100 text-red-800",
};

/**
 * The operator triage filters for the monitoring list. Each key maps (in the page) to a
 * predicate over the view; kept here so the surface and its tests share one vocabulary.
 */
export const LIFECYCLE_FILTERS = [
  { key: "all", label: "All" },
  { key: "held", label: "Held (block/review)" },
  { key: "awaiting", label: "Awaiting receipt" },
  { key: "delivered", label: "Delivered" },
  { key: "failed", label: "Failed" },
] as const;
export type LifecycleFilter = (typeof LIFECYCLE_FILTERS)[number]["key"];

export function isLifecycleFilter(value: unknown): value is LifecycleFilter {
  return (
    typeof value === "string" &&
    (LIFECYCLE_FILTERS as readonly { key: string }[]).some((f) => f.key === value)
  );
}

/**
 * Whether a derived stage belongs in a given operator filter bucket. Pure — the list
 * surface uses it both to bucket-count the pills and to filter the rendered rows, so the
 * counts and the filter can never disagree.
 */
export function stageMatchesFilter(stage: LifecycleStage, filter: LifecycleFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "held":
      return stage === "blocked" || stage === "review";
    case "awaiting":
      return stage === "awaiting_receipt" || stage === "in_transit";
    case "delivered":
      return stage === "delivered";
    case "failed":
      return stage === "send_failed" || stage === "delivery_failed";
  }
}

/** Format a view timestamp as "YYYY-MM-DD HH:MM" (or an em dash when absent). */
export function formatLifecycleTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 16).replace("T", " ");
}

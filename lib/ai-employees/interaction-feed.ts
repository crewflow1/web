/**
 * CrewFlow HQ — AI employee interaction feed (contract item 5: conversation
 * history), pure merge layer.
 *
 * WHY A FEED AND NOT A CHAT LOG. No chat UI exists for an AI employee to hold
 * a literal conversation in — and inventing one would fabricate a transcript
 * the system never produced. The employee's REAL conversation with the company
 * is already recorded, in three places:
 *
 *   • hq_ai_tasks        — the work it was asked to do and what came back
 *                          (result summaries, failures)
 *   • admin_activity_log — every configuration decision a human made about it
 *   • hq_approvals       — every action it proposed and what the human decided
 *
 * This module merges those three honest streams into ONE ordered feed. Pure and
 * server/client-safe (no Supabase imports) exactly like `lib/hq/boardroom-cards.ts`
 * and `lib/ai-employees/stats.ts`, so the service layer, the boardroom page and
 * the unit tests share one vocabulary. Nothing is generated; every entry points
 * at a stored row.
 */

// ---------------------------------------------------------------------
// Lean input row shapes — structural subsets of the three source tables.
// ---------------------------------------------------------------------

export type FeedTaskRow = {
  id: string;
  task_type: string;
  status: string;
  result: Record<string, unknown> | null;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
};

export type FeedActivityRow = {
  id: string;
  actor_email: string | null;
  action: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type FeedApprovalRow = {
  id: string;
  subject_type: string;
  action: string;
  state: string;
  reviewer_email: string | null;
  decision_reason: string | null;
  requested_at: string;
  decided_at: string | null;
};

// ---------------------------------------------------------------------
// The merged item.
// ---------------------------------------------------------------------

export type InteractionKind = "task" | "config" | "approval";

export type InteractionItem = {
  /** Stable per-source key ("task:<id>" etc.) for React lists. */
  key: string;
  kind: InteractionKind;
  /** ISO timestamp the feed orders by (newest first). */
  at: string;
  title: string;
  /** Result summary / decision reason / config detail — null when the row carries none. */
  detail: string | null;
  /** The source row's own status/state vocabulary ("completed", "approved", …). */
  status: string | null;
  /** The human on the other side of the interaction, when recorded. */
  actor: string | null;
};

const DETAIL_MAX = 280;

function clip(text: string): string {
  const t = text.trim();
  return t.length <= DETAIL_MAX ? t : `${t.slice(0, DETAIL_MAX - 1)}…`;
}

/**
 * Pull an honest one-line summary out of a task's `result` jsonb, tolerating
 * the shapes workers actually write. Returns null rather than inventing one.
 */
export function taskResultSummary(
  result: Record<string, unknown> | null,
  errorMessage: string | null,
): string | null {
  if (result && typeof result === "object") {
    for (const k of ["summary", "message", "headline", "note"]) {
      const v = result[k];
      if (typeof v === "string" && v.trim().length > 0) return clip(v);
    }
  }
  if (typeof errorMessage === "string" && errorMessage.trim().length > 0) {
    return clip(errorMessage);
  }
  return null;
}

/** "hq.worker.security_posture" → "hq worker security posture" (readable, honest). */
function humaniseToken(token: string): string {
  return token.replace(/[._-]+/g, " ").trim();
}

// ---------------------------------------------------------------------
// The merge.
// ---------------------------------------------------------------------

export function mergeInteractionFeed(
  tasks: ReadonlyArray<FeedTaskRow>,
  activity: ReadonlyArray<FeedActivityRow>,
  approvals: ReadonlyArray<FeedApprovalRow>,
  limit = 60,
): InteractionItem[] {
  const items: InteractionItem[] = [];

  for (const t of tasks) {
    items.push({
      key: `task:${t.id}`,
      kind: "task",
      // A finished task sits in the feed at the moment it finished — that is
      // when it "said" something back; an unfinished one at its creation.
      at: t.finished_at ?? t.created_at,
      title: `Task · ${humaniseToken(t.task_type)}`,
      detail: taskResultSummary(t.result, t.error_message),
      status: t.status,
      actor: null,
    });
  }

  for (const a of activity) {
    items.push({
      key: `config:${a.id}`,
      kind: "config",
      at: a.created_at,
      title: humaniseToken(a.action.replace(/^ai_employee\./, "")),
      detail: configDetail(a.metadata),
      status: null,
      actor: a.actor_email,
    });
  }

  for (const ap of approvals) {
    items.push({
      key: `approval:${ap.id}`,
      kind: "approval",
      at: ap.decided_at ?? ap.requested_at,
      title: `Approval · ${humaniseToken(ap.action)} ${humaniseToken(ap.subject_type)}`,
      detail: ap.decision_reason ? clip(ap.decision_reason) : null,
      status: ap.state,
      actor: ap.reviewer_email,
    });
  }

  // Newest first; ISO-8601 strings order lexicographically. Ties break by key
  // so the order is fully deterministic (testable).
  items.sort((x, y) => (x.at === y.at ? (x.key < y.key ? 1 : -1) : x.at < y.at ? 1 : -1));
  return items.slice(0, Math.max(0, limit));
}

/** A compact, honest one-liner from a config event's metadata, when it has one. */
function configDetail(metadata: Record<string, unknown> | null): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const from = metadata["status_from"];
  const to = metadata["status_to"];
  if (typeof from === "string" && typeof to === "string" && from !== to) {
    return `status ${from} → ${to}`;
  }
  if (typeof metadata["title"] === "string") return clip(String(metadata["title"]));
  return null;
}

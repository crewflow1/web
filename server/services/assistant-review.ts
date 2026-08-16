import "server-only";

/**
 * WhatsApp assistant REVIEW queue — the reader (MP Wave R4 · Communications audit).
 *
 * The assistant files inbound WhatsApp COMMITMENTS (a priced variation, a task/
 * booking) as `pending_review` in `whatsapp_assistant_actions` — never auto-
 * committed (the receptionist doctrine: AI never books/prices/commits; a HUMAN
 * decides). This surfaces that queue so a human can convert a draft into a real
 * variation/task through the existing session-bound writer, or dismiss it.
 *
 * The read is ACTIVE-ORG PINNED (`.eq("org_id", orgId)` on top of RLS), LOUD
 * (a query error throws `readFailure`, never an empty queue), and F-1 SAFE
 * (`fetchAllRows` + a stable (created_at, id) order).
 */

import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";

export type AssistantReviewItem = {
  id: string;
  action_type: string;
  target_table: string | null;
  target_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
  /** The extracted request text, if the draft carried one. */
  requested: string | null;
  /** The caller the message came from, if known. */
  caller: string | null;
  /** Why it needs review (human_in_the_loop, no_job_context, …). */
  reason: string | null;
  /** The job this concerns, when the draft resolved one. */
  job_id: string | null;
};

type Row = Record<string, unknown>;
type ReadChain = {
  eq: (k: string, v: unknown) => ReadChain;
  order: (col: string, opts: { ascending: boolean }) => ReadChain;
  range: (
    from: number,
    to: number,
  ) => Promise<{ data: Row[] | null; error: SupabaseReadError | null }>;
};
type ReadClient = { from: (t: string) => { select: (cols: string) => ReadChain } };

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Reduce a stored `detail` jsonb into the fields the reviewer UI renders. */
export function projectReviewItem(row: Row): AssistantReviewItem {
  const detail = (row.detail && typeof row.detail === "object" ? row.detail : {}) as Record<
    string,
    unknown
  >;
  const targetTable = str(row.target_table);
  const jobId = targetTable === "jobs" ? str(row.target_id) : null;
  return {
    id: String(row.id),
    action_type: String(row.action_type ?? ""),
    target_table: targetTable,
    target_id: str(row.target_id),
    detail: (row.detail as Record<string, unknown> | null) ?? null,
    created_at: String(row.created_at),
    requested: str(detail.requested) ?? str(detail.text),
    caller: str(detail.caller),
    reason: str(detail.reason),
    job_id: jobId,
  };
}

/**
 * List an org's pending_review assistant actions, newest first. Loud + F-1 +
 * active-org pinned.
 */
export async function listPendingAssistantActions(
  orgId: string,
): Promise<AssistantReviewItem[]> {
  const supabase = (await createClient()) as unknown as ReadClient;
  const { data, error } = await fetchAllRows<Row>((from, to) =>
    supabase
      .from("whatsapp_assistant_actions")
      .select(
        "id, action_type, target_table, target_id, detail, status, created_at",
      )
      .eq("org_id", orgId)
      .eq("status", "pending_review")
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw readFailure("assistant review: pending queue", error as SupabaseReadError);
  return data.map(projectReviewItem);
}

/**
 * The destination an operator is sent to when they CONVERT a pending action,
 * PURE so it is unit-tested. A variation_draft goes to the existing variation
 * writer's form when a job is known (the human prices + submits — the real
 * domain write); everything else lands on the job (or the inbox when no job),
 * where the operator files it through the existing surfaces. Never auto-commits.
 */
export function convertDestination(item: {
  action_type: string;
  job_id: string | null;
}): string {
  if (item.action_type === "variation_draft" && item.job_id) {
    return `/jobs/${item.job_id}/variations/new`;
  }
  if (item.job_id) return `/jobs/${item.job_id}`;
  return "/inbox/conversations";
}

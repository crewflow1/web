import "server-only";
import { readFailure } from "@/lib/supabase/read-failure";
import {
  validateCustomRuleDefinition,
  type CustomRuleDefinition,
} from "@/lib/automation/custom-rules";
import { isExposableAutomationTrigger } from "@/lib/automation/events";
import { runApprovedDownstream } from "@/server/services/automation-dispatcher";

/**
 * Automation OS — per-org CUSTOM rules + the approval gate (20261133).
 *
 * The UI/orchestration layer over the two new tables. The DISPATCHER
 * (automation-dispatcher.ts) is the engine: it loads + runs these rules and
 * creates approval gates. This service handles everything AROUND that — the
 * admin CRUD the builder calls, the loud paginated reads the settings page
 * renders, and the approve/reject flow that resumes a gated rule.
 *
 * SCOPING — the money-table doctrine, applied to automation config:
 *   1. RLS is the OUTER boundary (member-read / admin-write, DB-enforced).
 *   2. `org_id` is PINNED on every read AND write here. current_org_ids() returns
 *      every org the caller belongs to, so RLS alone BLENDS orgs for a dual-org
 *      member — the pin is what scopes a write to the intended company.
 *
 * VALIDATION IS THE INJECTION BOUNDARY. Every create/update runs the untrusted
 * definition through validateCustomRuleDefinition (lib/automation/custom-rules.ts)
 * BEFORE persisting: unknown action types rejected, params sanitised to the
 * registry whitelist, condition tree bounded, field paths proven safe. A rule can
 * never be stored in a shape the dispatcher would run unsafely.
 *
 * F-1: the rule + approval lists page via .range() on a stable (created_at, id)
 * order, so a busy org's lists are never silently clamped at the PostgREST cap.
 *
 * The new tables are not in the generated Supabase types → the established
 * loose-client cast idiom (job-budget / automation-rules). TypeScript-only.
 */

type Row = Record<string, unknown>;
type Builder = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  select: (c: string) => Builder;
  eq: (k: string, v: unknown) => Builder;
  order: (k: string, o: { ascending: boolean }) => Builder;
  range: (from: number, to: number) => Builder;
  limit: (n: number) => Builder;
  insert: (r: unknown) => Builder;
  update: (r: unknown) => Builder;
  delete: () => Builder;
  maybeSingle: () => PromiseLike<{ data: Row | null; error: unknown }>;
  single: () => PromiseLike<{ data: Row | null; error: unknown }>;
};
export type AutomationCustomRuleClient = { from: (t: string) => Builder };

export const CUSTOM_RULE_PAGE_SIZE = 20;

const RULE_COLS =
  "id, org_id, name, description, trigger_event, definition, enabled, created_by, updated_by, created_at, updated_at";

export type CustomRuleRecord = {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  trigger_event: string;
  definition: CustomRuleDefinition | Record<string, unknown>;
  enabled: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type Page<T> = { items: T[]; page: number; hasMore: boolean };

/**
 * List an org's custom rules, newest first. LOUD (throws on error), org-pinned,
 * F-1 paged. Fetches PAGE_SIZE+1 to report hasMore without a second count query.
 */
export async function listCustomRulesForOrg(
  client: AutomationCustomRuleClient,
  orgId: string,
  page = 0,
): Promise<Page<CustomRuleRecord>> {
  const safePage = Number.isInteger(page) && page >= 0 ? page : 0;
  const from = safePage * CUSTOM_RULE_PAGE_SIZE;
  const to = from + CUSTOM_RULE_PAGE_SIZE; // inclusive → fetches PAGE_SIZE + 1
  const res = await client
    .from("automation_custom_rules")
    .select(RULE_COLS)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, to);
  if (res.error) throw readFailure("automation custom rules: list", res.error);
  const rows = (res.data ?? []) as unknown as CustomRuleRecord[];
  return {
    items: rows.slice(0, CUSTOM_RULE_PAGE_SIZE),
    page: safePage,
    hasMore: rows.length > CUSTOM_RULE_PAGE_SIZE,
  };
}

/** Read one custom rule by (id, org_id). LOUD, org-pinned. */
export async function getCustomRule(
  client: AutomationCustomRuleClient,
  orgId: string,
  id: string,
): Promise<CustomRuleRecord | null> {
  const res = await client
    .from("automation_custom_rules")
    .select(RULE_COLS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (res.error) throw readFailure("automation custom rules: get", res.error);
  return (res.data as unknown as CustomRuleRecord) ?? null;
}

export type CustomRuleInput = {
  name: string;
  description: string | null;
  /** The untrusted definition JSON from the builder (validated here). */
  definition: unknown;
};

function normaliseName(name: string): string {
  return name.trim().slice(0, 120);
}
function normaliseDescription(d: string | null): string | null {
  if (d === null) return null;
  const t = d.trim();
  return t.length === 0 ? null : t.slice(0, 500);
}

/**
 * Create a custom rule. Validates the definition (the injection chokepoint), then
 * persists it with `trigger_event` pulled from the validated tree so the column
 * and the jsonb can never disagree. Org-pinned; RLS admin-write is the real
 * boundary. Returns the new id. Throws on validation or DB error.
 */
export async function createCustomRule(
  client: AutomationCustomRuleClient,
  orgId: string,
  input: CustomRuleInput,
  userId: string | null,
): Promise<string> {
  const name = normaliseName(input.name);
  if (name.length === 0) throw new Error("rule name is required");
  const valid = validateCustomRuleDefinition(input.definition);
  if (!valid.ok) throw new Error(`invalid rule: ${valid.error}`);
  // The trigger must be a verb a real producer actually fires — otherwise the
  // rule is a phantom that can never run. The builder only offers exposable
  // verbs; this is the server-side chokepoint that rejects a crafted payload.
  if (!isExposableAutomationTrigger(valid.value.trigger)) {
    throw new Error(
      `invalid rule: trigger "${valid.value.trigger}" is not available for custom rules`,
    );
  }

  const res = await client
    .from("automation_custom_rules")
    .insert({
      org_id: orgId,
      name,
      description: normaliseDescription(input.description),
      trigger_event: valid.value.trigger,
      definition: valid.value,
      enabled: true,
      created_by: userId,
      updated_by: userId,
    })
    .select("id")
    .single();
  if (res.error) throw new Error(`custom rule create failed: ${(res.error as { message?: string }).message ?? String(res.error)}`);
  return String((res.data as { id?: string })?.id ?? "");
}

/**
 * Update a custom rule's name/description/definition. Re-validates the definition.
 * Org-pinned on the update predicate (id AND org_id), so a crafted id from another
 * org cannot be edited even before RLS. Throws on validation or DB error.
 */
export async function updateCustomRule(
  client: AutomationCustomRuleClient,
  orgId: string,
  id: string,
  input: CustomRuleInput,
  userId: string | null,
): Promise<void> {
  const name = normaliseName(input.name);
  if (name.length === 0) throw new Error("rule name is required");
  const valid = validateCustomRuleDefinition(input.definition);
  if (!valid.ok) throw new Error(`invalid rule: ${valid.error}`);
  if (!isExposableAutomationTrigger(valid.value.trigger)) {
    throw new Error(
      `invalid rule: trigger "${valid.value.trigger}" is not available for custom rules`,
    );
  }

  const res = await client
    .from("automation_custom_rules")
    .update({
      name,
      description: normaliseDescription(input.description),
      trigger_event: valid.value.trigger,
      definition: valid.value,
      updated_by: userId,
    })
    .eq("id", id)
    .eq("org_id", orgId);
  if (res.error) throw new Error(`custom rule update failed: ${(res.error as { message?: string }).message ?? String(res.error)}`);
}

/** Enable/disable a custom rule. Org-pinned; RLS admin-write is the real boundary. */
export async function setCustomRuleEnabled(
  client: AutomationCustomRuleClient,
  orgId: string,
  id: string,
  enabled: boolean,
): Promise<void> {
  const res = await client
    .from("automation_custom_rules")
    .update({ enabled })
    .eq("id", id)
    .eq("org_id", orgId);
  if (res.error) throw new Error(`custom rule toggle failed: ${(res.error as { message?: string }).message ?? String(res.error)}`);
}

/** Delete a custom rule. Org-pinned; RLS admin-write is the real boundary. */
export async function deleteCustomRule(
  client: AutomationCustomRuleClient,
  orgId: string,
  id: string,
): Promise<void> {
  const res = await client
    .from("automation_custom_rules")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (res.error) throw new Error(`custom rule delete failed: ${(res.error as { message?: string }).message ?? String(res.error)}`);
}

// ── Approvals ─────────────────────────────────────────────────────────────────

const APPROVAL_COLS =
  "id, org_id, custom_rule_id, rule_name, event_type, source_table, source_id, correlation_id, payload, pending_actions, status, decided_by, decided_at, note, executed_at, execution_result, created_at, updated_at";

export type ApprovalRecord = {
  id: string;
  org_id: string;
  custom_rule_id: string;
  rule_name: string;
  event_type: string;
  source_table: string;
  source_id: string;
  correlation_id: string;
  payload: unknown;
  pending_actions: unknown;
  status: "pending" | "approved" | "rejected";
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
  executed_at: string | null;
  execution_result: unknown;
  created_at: string;
  updated_at: string;
};

/**
 * List an org's PENDING approvals, newest first. LOUD, org-pinned, F-1 paged.
 */
export async function listPendingApprovals(
  client: AutomationCustomRuleClient,
  orgId: string,
  page = 0,
): Promise<Page<ApprovalRecord>> {
  const safePage = Number.isInteger(page) && page >= 0 ? page : 0;
  const from = safePage * CUSTOM_RULE_PAGE_SIZE;
  const to = from + CUSTOM_RULE_PAGE_SIZE;
  const res = await client
    .from("automation_approvals")
    .select(APPROVAL_COLS)
    .eq("org_id", orgId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, to);
  if (res.error) throw readFailure("automation approvals: list", res.error);
  const rows = (res.data ?? []) as unknown as ApprovalRecord[];
  return {
    items: rows.slice(0, CUSTOM_RULE_PAGE_SIZE),
    page: safePage,
    hasMore: rows.length > CUSTOM_RULE_PAGE_SIZE,
  };
}

export type ApprovalDecision = "approve" | "reject";
export type DecisionOutcome = {
  status: "approved" | "rejected" | "already_decided";
  executed?: { type: string; ok: boolean; error?: string }[];
};

/**
 * Approve or reject a pending gate.
 *
 * THE DECISION IS AN ATOMIC CLAIM. A conditional UPDATE flips status only while it
 * is still 'pending' (WHERE id = ? AND org_id = ? AND status = 'pending'), pinned
 * to the org and gated by RLS admin-write via the tenant client. Two admins racing
 * the same row: Postgres serialises, one flips it, the other updates 0 rows and is
 * an idempotent no-op — so downstream actions run AT MOST ONCE.
 *
 * On APPROVE the winner executes the snapshotted downstream actions via the engine
 * (runApprovedDownstream re-sanitises each one), then stamps executed_at +
 * execution_result. On REJECT nothing runs; the gate is simply closed.
 */
export async function decideApproval(
  client: AutomationCustomRuleClient,
  orgId: string,
  approvalId: string,
  userId: string | null,
  decision: ApprovalDecision,
  note: string | null,
): Promise<DecisionOutcome> {
  const nowIso = new Date().toISOString();
  const nextStatus = decision === "approve" ? "approved" : "rejected";
  const trimmedNote = note && note.trim().length > 0 ? note.trim().slice(0, 500) : null;

  // The atomic claim: flip pending → approved|rejected, return the snapshot.
  const claim = await client
    .from("automation_approvals")
    .update({
      status: nextStatus,
      decided_by: userId,
      decided_at: nowIso,
      note: trimmedNote,
    })
    .eq("id", approvalId)
    .eq("org_id", orgId)
    .eq("status", "pending")
    .select(APPROVAL_COLS);
  if (claim.error) {
    throw new Error(`approval decision failed: ${(claim.error as { message?: string }).message ?? String(claim.error)}`);
  }
  const rows = (claim.data ?? []) as unknown as ApprovalRecord[];
  const won = rows[0];
  if (!won) {
    // 0 rows updated → the gate was already decided (or does not belong to this
    // org). Idempotent no-op; never re-run downstream.
    return { status: "already_decided" };
  }

  if (decision === "reject") {
    return { status: "rejected" };
  }

  // Approved and we hold the claim → run the downstream actions through the engine.
  const result = await runApprovedDownstream({
    org_id: orgId,
    event_type: won.event_type,
    source_table: won.source_table,
    source_id: won.source_id,
    payload: won.payload,
    rule_name: won.rule_name,
    actions: won.pending_actions,
  });

  // Stamp the execution outcome (org-pinned). Best-effort: the actions already
  // ran, so a failure to record the outcome is logged, not thrown.
  const stamp = await client
    .from("automation_approvals")
    .update({ executed_at: new Date().toISOString(), execution_result: result })
    .eq("id", approvalId)
    .eq("org_id", orgId);
  if (stamp.error) {
    console.error("[automation] approval execution stamp failed", {
      approval_id: approvalId,
      error: (stamp.error as { message?: string }).message ?? String(stamp.error),
    });
  }

  return { status: "approved", executed: result.ran };
}

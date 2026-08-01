import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import type {
  ItpRow,
  PlanItemRow,
  PlanStatusRow,
  SignoffRow,
} from "@/lib/quality/schema";
import type { PlanProgress } from "@/lib/quality/itp";

/**
 * Works Quality — ITP read layer.
 *
 * Every query runs on the tenant (user-JWT) client so RLS scopes it to the
 * caller's orgs; the service-role client is never used here.
 *
 * ACTIVE-ORG PINNING. RLS is the OUTER boundary, not the scope:
 * `current_org_ids()` returns EVERY org the viewer belongs to, so an unpinned
 * read blends a dual-org member's two companies (#456/#463/#468). Every read
 * below therefore carries its own `.eq("org_id", orgId)` predicate, supplied by
 * the caller so the scope is visible at the call site.
 *
 * LOUD READS. A rejected query must never render as "no outstanding hold
 * points". That is a control failing OPEN on a safety-adjacent surface: the page
 * would assert the works are clear when it in fact knows nothing. Every read
 * here THROWS via @/lib/supabase/read-failure on error, so the route-group error
 * boundary renders "Something went wrong" and instrumentation.ts reports it.
 * `[]` and `null` mean genuinely-empty and genuinely-missing, nothing else.
 */

const ITP_COLUMNS =
  "id, org_id, job_id, reference, title, work_package, location, specification_ref, prepared_by, plan_date, notes, status, issued_at, issued_by, supersedes_id, created_by, created_at, updated_at, root_plan_id, revision_number";

const ITEM_COLUMNS =
  "id, org_id, inspection_test_plan_id, item_number, title, acceptance_criteria, inspection_method, specification_ref, control_point, is_hold_point, required, created_at";

const SIGNOFF_COLUMNS =
  "id, org_id, inspection_plan_item_id, plan_version, result, comments, inspected_by, signed_name, inspected_at, recorded_at, witness_name, witness_organisation, voided_at, voided_by, void_reason, hold_point_breach, open_hold_item_number, created_at, witness_invitation_id";

const STATUS_COLUMNS =
  "plan_id, org_id, job_id, status, total_items, hold_point_items, signed_off_items, outstanding_required_items, open_hold_points, failed_items, hold_point_breaches, open_hold_item_number";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFrom = { from: (t: string) => any };
// Bind `this` to the client — `.from` is a prototype method, so extracting it
// unbound makes `this` undefined and supabase-js throws on the first call.
const tbl = (c: unknown) => (c as AnyFrom).from.bind(c);
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Map a read-model row onto the pure-domain progress shape. */
export function toProgress(s: PlanStatusRow | undefined): PlanProgress {
  return {
    totalItems: s?.total_items ?? 0,
    holdPointItems: s?.hold_point_items ?? 0,
    signedOffItems: s?.signed_off_items ?? 0,
    outstandingRequiredItems: s?.outstanding_required_items ?? 0,
    openHoldPoints: s?.open_hold_points ?? 0,
    failedItems: s?.failed_items ?? 0,
    holdPointBreaches: s?.hold_point_breaches ?? 0,
    openHoldItemNumber: s?.open_hold_item_number ?? null,
  };
}

export type PlanListItem = ItpRow & {
  progress: PlanProgress;
  jobLabel: string | null;
};

/**
 * The register: every ITP in the ACTIVE org, newest first, each with its
 * DB-computed progress. Three bounded reads (plans, the status read-model, the
 * job labels) — never one per row.
 */
export async function listPlans(orgId: string): Promise<PlanListItem[]> {
  const supabase = await createClient();

  const { data: plans, error } = await tbl(supabase)("inspection_test_plans")
    .select(ITP_COLUMNS)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw readFailure("quality: itp register", error as SupabaseReadError);
  const rows = (plans ?? []) as ItpRow[];
  if (rows.length === 0) return [];

  const { data: statuses, error: statusError } = await tbl(supabase)("works_quality_plan_status")
    .select(STATUS_COLUMNS)
    .eq("org_id", orgId)
    .in("plan_id", rows.map((r) => r.id));
  // A failed progress read would render every plan as "0 hold points open" —
  // the exact false all-clear this module exists to prevent. Fail the page.
  if (statusError) throw readFailure("quality: itp progress", statusError as SupabaseReadError);
  const byPlan = new Map<string, PlanStatusRow>();
  for (const s of (statuses ?? []) as PlanStatusRow[]) byPlan.set(s.plan_id, s);

  const jobLabels = await loadJobLabels(orgId, rows.map((r) => r.job_id));

  return rows.map((r) => ({
    ...r,
    progress: toProgress(byPlan.get(r.id)),
    jobLabel: r.job_id ? (jobLabels.get(r.job_id) ?? null) : null,
  }));
}

/**
 * One plan + its items + every sign-off against them, pinned to the ACTIVE org.
 *
 * A plan in a non-active org is deliberately INDISTINGUISHABLE from a missing
 * one: callers notFound() on null.
 */
export async function getPlan(
  orgId: string,
  id: string,
): Promise<{
  plan: ItpRow;
  items: PlanItemRow[];
  signoffs: SignoffRow[];
  progress: PlanProgress;
  jobLabel: string | null;
  priorReference: string | null;
} | null> {
  const supabase = await createClient();

  const { data: plan, error } = await tbl(supabase)("inspection_test_plans")
    .select(ITP_COLUMNS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw readFailure("quality: inspection plan", error as SupabaseReadError);
  if (!plan) return null;
  const row = plan as ItpRow;

  const [itemsRes, statusRes] = await Promise.all([
    tbl(supabase)("inspection_plan_items")
      .select(ITEM_COLUMNS)
      .eq("inspection_test_plan_id", id)
      .eq("org_id", orgId)
      .order("item_number", { ascending: true }),
    tbl(supabase)("works_quality_plan_status")
      .select(STATUS_COLUMNS)
      .eq("plan_id", id)
      .eq("org_id", orgId)
      .maybeSingle(),
  ]);
  if (itemsRes.error) throw readFailure("quality: plan items", itemsRes.error as SupabaseReadError);
  if (statusRes.error) throw readFailure("quality: plan progress", statusRes.error as SupabaseReadError);
  const items = (itemsRes.data ?? []) as PlanItemRow[];

  let signoffs: SignoffRow[] = [];
  if (items.length > 0) {
    const { data, error: sErr } = await tbl(supabase)("inspection_signoffs")
      .select(SIGNOFF_COLUMNS)
      .eq("org_id", orgId)
      .in("inspection_plan_item_id", items.map((i) => i.id))
      .order("recorded_at", { ascending: false });
    // An empty sign-off list on a failed read would show every check as
    // un-inspected AND every hold point as open. Fail loudly instead.
    if (sErr) throw readFailure("quality: sign-offs", sErr as SupabaseReadError);
    signoffs = (data ?? []) as SignoffRow[];
  }

  const jobLabels = await loadJobLabels(orgId, [row.job_id]);

  let priorReference: string | null = null;
  if (row.supersedes_id) {
    const { data: prior, error: pErr } = await tbl(supabase)("inspection_test_plans")
      .select("reference")
      .eq("id", row.supersedes_id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (pErr) throw readFailure("quality: superseded plan", pErr as SupabaseReadError);
    priorReference = (prior as { reference: string | null } | null)?.reference ?? null;
  }

  return {
    plan: row,
    items,
    signoffs,
    progress: toProgress((statusRes.data ?? undefined) as PlanStatusRow | undefined),
    jobLabel: row.job_id ? (jobLabels.get(row.job_id) ?? null) : null,
    priorReference,
  };
}

const WITNESS_COLUMNS =
  "id, org_id, inspection_plan_item_id, witness_name, witness_organisation, witness_email, scheduled_for, status, invited_by, attendance_recorded_by, attendance_recorded_at, created_at, updated_at";

const NCR_COLUMNS =
  "id, org_id, inspection_plan_item_id, source_signoff_id, reference, title, description, severity, responsible_user_id, responsible_subcontractor, due_date, status, raised_by, verified_by, verified_at, closure_comment, created_at, updated_at";

/**
 * Witness invitations for a set of plan items, ACTIVE-org pinned. Newest first
 * within each item; one bounded read for the whole plan.
 */
export async function listWitnessInvitations(
  orgId: string,
  itemIds: string[],
): Promise<import("@/lib/quality/schema").WitnessInvitationRow[]> {
  if (itemIds.length === 0) return [];
  const supabase = await createClient();
  const { data, error } = await tbl(supabase)("inspection_witness_invitations")
    .select(WITNESS_COLUMNS)
    .eq("org_id", orgId)
    .in("inspection_plan_item_id", itemIds)
    .order("created_at", { ascending: false });
  // A failed read must never render as "no witnesses were invited".
  if (error) throw readFailure("quality: witness invitations", error as SupabaseReadError);
  return (data ?? []) as import("@/lib/quality/schema").WitnessInvitationRow[];
}

/**
 * NCRs raised against a plan's items, ACTIVE-org pinned. Used by the plan
 * detail page and the evidence PDF's NCR register.
 */
export async function listPlanNcrs(
  orgId: string,
  itemIds: string[],
): Promise<import("@/lib/quality/schema").NcrRow[]> {
  if (itemIds.length === 0) return [];
  const supabase = await createClient();
  const { data, error } = await tbl(supabase)("non_conformance_reports")
    .select(NCR_COLUMNS)
    .eq("org_id", orgId)
    .in("inspection_plan_item_id", itemIds)
    .order("created_at", { ascending: false });
  // An empty NCR register on a failed read would claim the works conform.
  if (error) throw readFailure("quality: plan NCR register", error as SupabaseReadError);
  return (data ?? []) as import("@/lib/quality/schema").NcrRow[];
}

/** Batched job labels (customer name + scheduled date) — never one query per row. */
async function loadJobLabels(
  orgId: string,
  jobIds: Array<string | null>,
): Promise<Map<string, string>> {
  const ids = [...new Set(jobIds.filter((j): j is string => Boolean(j)))];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("jobs")
    .select("id, scheduled_date, customer:customers ( name )")
    .eq("org_id", orgId)
    .in("id", ids);
  if (error) throw readFailure("quality: job labels", error);
  for (const j of data ?? []) {
    const customer = (j as unknown as { customer: { name: string | null } | null }).customer;
    const parts = [customer?.name ?? "Job", j.scheduled_date ?? null].filter(Boolean);
    out.set(j.id, parts.join(" · "));
  }
  return out;
}

/** Jobs the ACTIVE org can attach a plan to. */
export async function listJobOptions(
  orgId: string,
): Promise<Array<{ id: string; label: string }>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("jobs")
    .select("id, status, scheduled_date, customer:customers ( name )")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw readFailure("quality: job picker", error);
  return (data ?? []).map((j) => {
    const customer = (j as unknown as { customer: { name: string | null } | null }).customer;
    const parts = [customer?.name ?? "Job", j.scheduled_date ?? null, j.status ?? null].filter(Boolean);
    return { id: j.id, label: parts.join(" · ") };
  });
}

/** Members of the ACTIVE org who can be named as the plan's author. */
export async function listMembers(orgId: string): Promise<Array<{ id: string; name: string }>> {
  const supabase = await createClient();
  const { data, error } = await tbl(supabase)("memberships")
    .select("user_id, users(full_name, email)")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });
  if (error) throw readFailure("quality: member picker", error as SupabaseReadError);
  return ((data ?? []) as Array<{
    user_id: string;
    users: { full_name: string | null; email: string | null } | null;
  }>).map((m) => ({
    id: m.user_id,
    name: m.users?.full_name || m.users?.email || "Member",
  }));
}

/** Batched signer names for the sign-off rows. */
export async function loadUserNames(userIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const supabase = await createClient();
  const { data, error } = await tbl(supabase)("users")
    .select("id, full_name, email")
    .in("id", ids);
  if (error) throw readFailure("quality: signer names", error as SupabaseReadError);
  for (const u of (data ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>) {
    out.set(u.id, u.full_name || u.email || "Member");
  }
  return out;
}

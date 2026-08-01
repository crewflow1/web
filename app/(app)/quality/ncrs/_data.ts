import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import type {
  CorrectiveActionRow,
  ItpRow,
  NcrRow,
  PlanItemRow,
  SignoffRow,
} from "@/lib/quality/schema";

/**
 * Works Quality — NCR read layer (M2).
 *
 * Same discipline as app/(app)/quality/_data.ts, stated once there and held
 * here: every query runs on the tenant (user-JWT) client; RLS is the OUTER
 * boundary and every read carries its own `.eq("org_id", orgId)` ACTIVE-org
 * pin (#456/#463/#468); every rejected query THROWS via read-failure — an
 * empty NCR register on a failed read would claim the works conform, which is
 * a control failing open.
 */

const NCR_COLUMNS =
  "id, org_id, inspection_plan_item_id, source_signoff_id, reference, title, description, severity, responsible_user_id, responsible_subcontractor, due_date, status, raised_by, verified_by, verified_at, closure_comment, created_at, updated_at";

const ACTION_COLUMNS =
  "id, org_id, ncr_id, description, assigned_to, due_date, proposed_by, proposed_at, decision, decision_reason, decided_by, decided_at, completed_at, completion_comment, created_at, updated_at";

const ITEM_COLUMNS =
  "id, org_id, inspection_test_plan_id, item_number, title, acceptance_criteria, inspection_method, specification_ref, control_point, is_hold_point, required, created_at";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFrom = { from: (t: string) => any };
// Bind `this` — `.from` is a prototype method; unbound it throws on first use.
const tbl = (c: unknown) => (c as AnyFrom).from.bind(c);
/* eslint-enable @typescript-eslint/no-explicit-any */

export type NcrListItem = NcrRow & {
  itemNumber: number | null;
  itemTitle: string | null;
  planId: string | null;
  planReference: string | null;
};

/**
 * The NCR register for the ACTIVE org, newest first, each row labelled with
 * its plan item + plan reference. Three bounded reads — never one per row.
 */
export async function listNcrs(orgId: string): Promise<NcrListItem[]> {
  const supabase = await createClient();

  const { data, error } = await tbl(supabase)("non_conformance_reports")
    .select(NCR_COLUMNS)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw readFailure("quality: ncr register", error as SupabaseReadError);
  const rows = (data ?? []) as NcrRow[];
  if (rows.length === 0) return [];

  const itemIds = [...new Set(rows.map((r) => r.inspection_plan_item_id))];
  const { data: items, error: itemsError } = await tbl(supabase)("inspection_plan_items")
    .select("id, org_id, inspection_test_plan_id, item_number, title")
    .eq("org_id", orgId)
    .in("id", itemIds);
  if (itemsError) throw readFailure("quality: ncr items", itemsError as SupabaseReadError);
  const itemById = new Map(
    ((items ?? []) as Array<{
      id: string;
      inspection_test_plan_id: string;
      item_number: number;
      title: string;
    }>).map((i) => [i.id, i]),
  );

  const planIds = [...new Set([...itemById.values()].map((i) => i.inspection_test_plan_id))];
  const planById = new Map<string, { id: string; reference: string | null }>();
  if (planIds.length > 0) {
    const { data: plans, error: plansError } = await tbl(supabase)("inspection_test_plans")
      .select("id, reference")
      .eq("org_id", orgId)
      .in("id", planIds);
    if (plansError) throw readFailure("quality: ncr plans", plansError as SupabaseReadError);
    for (const p of (plans ?? []) as Array<{ id: string; reference: string | null }>) {
      planById.set(p.id, p);
    }
  }

  return rows.map((r) => {
    const item = itemById.get(r.inspection_plan_item_id) ?? null;
    const plan = item ? (planById.get(item.inspection_test_plan_id) ?? null) : null;
    return {
      ...r,
      itemNumber: item?.item_number ?? null,
      itemTitle: item?.title ?? null,
      planId: item?.inspection_test_plan_id ?? null,
      planReference: plan?.reference ?? null,
    };
  });
}

/**
 * One NCR + its corrective actions + the plan item and plan it hangs off,
 * pinned to the ACTIVE org. An NCR in a non-active org is INDISTINGUISHABLE
 * from a missing one: callers notFound() on null.
 */
export async function getNcr(
  orgId: string,
  id: string,
): Promise<{
  ncr: NcrRow;
  actions: CorrectiveActionRow[];
  item: PlanItemRow | null;
  plan: ItpRow | null;
  sourceSignoff: SignoffRow | null;
} | null> {
  const supabase = await createClient();

  const { data, error } = await tbl(supabase)("non_conformance_reports")
    .select(NCR_COLUMNS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw readFailure("quality: ncr", error as SupabaseReadError);
  if (!data) return null;
  const ncr = data as NcrRow;

  const { data: actionsData, error: actionsError } = await tbl(supabase)("ncr_corrective_actions")
    .select(ACTION_COLUMNS)
    .eq("org_id", orgId)
    .eq("ncr_id", id)
    .order("created_at", { ascending: false });
  // A missing proposal history would misstate where the NCR is in its life.
  if (actionsError) throw readFailure("quality: corrective actions", actionsError as SupabaseReadError);
  const actions = (actionsData ?? []) as CorrectiveActionRow[];

  const { data: itemData, error: itemError } = await tbl(supabase)("inspection_plan_items")
    .select(ITEM_COLUMNS)
    .eq("id", ncr.inspection_plan_item_id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (itemError) throw readFailure("quality: ncr item", itemError as SupabaseReadError);
  const item = (itemData ?? null) as PlanItemRow | null;

  let plan: ItpRow | null = null;
  if (item) {
    const { data: planData, error: planError } = await tbl(supabase)("inspection_test_plans")
      .select("id, org_id, job_id, reference, title, work_package, status, root_plan_id, revision_number, location, specification_ref, prepared_by, plan_date, notes, issued_at, issued_by, supersedes_id, created_by, created_at, updated_at")
      .eq("id", item.inspection_test_plan_id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (planError) throw readFailure("quality: ncr plan", planError as SupabaseReadError);
    plan = (planData ?? null) as ItpRow | null;
  }

  let sourceSignoff: SignoffRow | null = null;
  if (ncr.source_signoff_id) {
    const { data: soData, error: soError } = await tbl(supabase)("inspection_signoffs")
      .select("id, org_id, inspection_plan_item_id, plan_version, result, comments, inspected_by, signed_name, inspected_at, recorded_at, witness_name, witness_organisation, voided_at, voided_by, void_reason, hold_point_breach, open_hold_item_number, created_at, witness_invitation_id")
      .eq("id", ncr.source_signoff_id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (soError) throw readFailure("quality: ncr source sign-off", soError as SupabaseReadError);
    sourceSignoff = (soData ?? null) as SignoffRow | null;
  }

  return { ncr, actions, item, plan, sourceSignoff };
}

/**
 * The plan item an NCR is being raised against (+ its plan + its failed
 * sign-offs, as source candidates), ACTIVE-org pinned. Null when the item is
 * outside the active org — indistinguishable from missing.
 */
export async function getRaiseContext(
  orgId: string,
  itemId: string,
): Promise<{
  item: PlanItemRow;
  plan: ItpRow | null;
  failedSignoffs: SignoffRow[];
} | null> {
  const supabase = await createClient();

  const { data: itemData, error: itemError } = await tbl(supabase)("inspection_plan_items")
    .select(ITEM_COLUMNS)
    .eq("id", itemId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (itemError) throw readFailure("quality: raise context item", itemError as SupabaseReadError);
  if (!itemData) return null;
  const item = itemData as PlanItemRow;

  const { data: planData, error: planError } = await tbl(supabase)("inspection_test_plans")
    .select("id, org_id, job_id, reference, title, work_package, status, root_plan_id, revision_number, location, specification_ref, prepared_by, plan_date, notes, issued_at, issued_by, supersedes_id, created_by, created_at, updated_at")
    .eq("id", item.inspection_test_plan_id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (planError) throw readFailure("quality: raise context plan", planError as SupabaseReadError);

  const { data: soData, error: soError } = await tbl(supabase)("inspection_signoffs")
    .select("id, org_id, inspection_plan_item_id, plan_version, result, comments, inspected_by, signed_name, inspected_at, recorded_at, witness_name, witness_organisation, voided_at, voided_by, void_reason, hold_point_breach, open_hold_item_number, created_at, witness_invitation_id")
    .eq("org_id", orgId)
    .eq("inspection_plan_item_id", itemId)
    .eq("result", "fail")
    .order("recorded_at", { ascending: false });
  if (soError) throw readFailure("quality: raise context sign-offs", soError as SupabaseReadError);

  return {
    item,
    plan: (planData ?? null) as ItpRow | null,
    failedSignoffs: (soData ?? []) as SignoffRow[],
  };
}

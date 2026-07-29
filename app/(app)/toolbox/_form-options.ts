import { createClient } from "@/lib/supabase/server";

/**
 * Toolbox-talk form options — the lists a draft can link to. Only ISSUED RAMS and
 * live (issued/active) permits are offered: a talk is evidence you briefed a
 * *current* control, so linking a draft RAMS would be misleading — and the DB
 * link-integrity trigger only checks same-org, not currency, so the UI leads here.
 *
 * These reads used to rely on RLS alone ("the tenant client is intrinsically
 * intra-org"). That is wrong for a member of more than one organisation:
 * `current_org_ids()` returns EVERY org the viewer belongs to, so the pickers
 * blended both companies' jobs, RAMS and permits. The caller now passes the
 * ACTIVE org explicitly, so the scope is visible at the call site and cannot be
 * silently dropped (the convention set by app/(app)/jobs/_form-helpers.ts in
 * #456 and app/(app)/purchase-orders/_data.ts in #463).
 */

export type JobOption = {
  id: string;
  status: string | null;
  scheduled_date: string | null;
  customer: { name: string | null } | null;
};
export type RamsOption = { id: string; reference: string | null; title: string };
export type PermitOption = { id: string; reference: string | null; title: string; status: string };

export type ToolboxFormOptions = {
  jobs: JobOption[];
  rams: RamsOption[];
  permits: PermitOption[];
};

type AnyFrom = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const tbl = (c: unknown) => (c as AnyFrom).from.bind(c);

export async function loadToolboxFormOptions(orgId: string): Promise<ToolboxFormOptions> {
  const supabase = await createClient();

  const [jobsRes, ramsRes, permitsRes] = await Promise.all([
    supabase
      .from("jobs")
      .select("id, status, scheduled_date, customer:customers ( name )")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(200),
    tbl(supabase)("risk_assessments")
      .select("id, reference, title")
      .eq("org_id", orgId)
      .eq("status", "issued")
      .order("reference", { ascending: false })
      .limit(200),
    tbl(supabase)("permits_to_work")
      .select("id, reference, title, status")
      .eq("org_id", orgId)
      .in("status", ["issued", "active"])
      .order("reference", { ascending: false })
      .limit(200),
  ]);

  return {
    jobs: (jobsRes.data ?? []) as unknown as JobOption[],
    rams: (ramsRes.data ?? []) as RamsOption[],
    permits: (permitsRes.data ?? []) as PermitOption[],
  };
}

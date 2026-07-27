import { createClient } from "@/lib/supabase/server";

/**
 * Toolbox-talk form options — the org-scoped lists a draft can link to. All reads
 * are on the tenant (RLS) client, so they are intrinsically intra-org. Only ISSUED
 * RAMS and live (issued/active) permits are offered: a talk is evidence you briefed
 * a *current* control, so linking a draft RAMS would be misleading — and the DB
 * link-integrity trigger only checks same-org, not currency, so the UI leads here.
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

export async function loadToolboxFormOptions(): Promise<ToolboxFormOptions> {
  const supabase = await createClient();

  const [jobsRes, ramsRes, permitsRes] = await Promise.all([
    supabase
      .from("jobs")
      .select("id, status, scheduled_date, customer:customers ( name )")
      .order("created_at", { ascending: false })
      .limit(200),
    tbl(supabase)("risk_assessments")
      .select("id, reference, title")
      .eq("status", "issued")
      .order("reference", { ascending: false })
      .limit(200),
    tbl(supabase)("permits_to_work")
      .select("id, reference, title, status")
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

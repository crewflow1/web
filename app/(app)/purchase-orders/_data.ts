import { createClient } from "@/lib/supabase/server";
import { listSuppliersForOrg, type SuppliersClient } from "@/server/services/suppliers";

/**
 * Supplier + job option lists for the PO builder selects.
 *
 * BOTH lists are pinned to the ACTIVE org, not merely to RLS. `current_org_ids()`
 * returns every org the viewer belongs to, so for a dual-org member an RLS-only
 * read offered the OTHER company's suppliers and jobs (with their customers'
 * names) in this org's builder — and a PO written against one of them would be
 * created with this org's org_id. Same class as #456 / #459 / #461.
 *
 * The jobs query embeds `customer:customers ( name )`; the generated Supabase
 * types don't resolve that embed cleanly here, so the reader is cast (the same
 * `as never` idiom used for not-yet-typed tables).
 */
export async function listPoFormOptions(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
): Promise<{ suppliers: Array<{ id: string; name: string }>; jobs: Array<{ id: string; name: string }> }> {
  const [suppliers, jobsRes] = await Promise.all([
    listSuppliersForOrg(supabase as unknown as SuppliersClient, orgId),
    (
      supabase.from("jobs" as never) as unknown as {
        select: (c: string) => {
          eq: (k: string, v: unknown) => {
            order: (k: string, o: { ascending: boolean }) => {
              limit: (n: number) => Promise<{
                data: Array<{ id: string; status: string; customer: { name: string } | null }> | null;
              }>;
            };
          };
        };
      }
    )
      .select("id, status, customer:customers ( name )")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  const jobs = (jobsRes.data ?? []).map((j) => ({
    id: j.id,
    name: `${j.customer?.name ?? "Job"} · ${j.status}`,
  }));
  return { suppliers, jobs };
}

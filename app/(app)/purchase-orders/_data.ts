import { createClient } from "@/lib/supabase/server";

/**
 * Supplier + job option lists for the PO builder selects.
 *
 * The jobs query embeds `customer:customers ( name )`; the generated Supabase
 * types don't resolve that embed cleanly here, so the reader is cast (the same
 * `as never` idiom used for not-yet-typed tables). Both are org-scoped by RLS.
 */
export async function listPoFormOptions(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ suppliers: Array<{ id: string; name: string }>; jobs: Array<{ id: string; name: string }> }> {
  const [suppliersRes, jobsRes] = await Promise.all([
    (
      supabase.from("suppliers" as never) as unknown as {
        select: (c: string) => {
          order: (k: string, o: { ascending: boolean }) => Promise<{ data: Array<{ id: string; name: string }> | null }>;
        };
      }
    )
      .select("id, name")
      .order("name", { ascending: true }),
    (
      supabase.from("jobs" as never) as unknown as {
        select: (c: string) => {
          order: (k: string, o: { ascending: boolean }) => {
            limit: (n: number) => Promise<{
              data: Array<{ id: string; status: string; customer: { name: string } | null }> | null;
            }>;
          };
        };
      }
    )
      .select("id, status, customer:customers ( name )")
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  const suppliers = suppliersRes.data ?? [];
  const jobs = (jobsRes.data ?? []).map((j) => ({
    id: j.id,
    name: `${j.customer?.name ?? "Job"} · ${j.status}`,
  }));
  return { suppliers, jobs };
}

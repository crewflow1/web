import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

/**
 * Assets on the job (integration slice) — every asset currently allocated to
 * this job via an OPEN custody assignment. One bounded, RLS-scoped read; links
 * into the asset detail where custody/inspection/maintenance actions live.
 */

type Row = {
  id: string;
  asset_id: string;
  assigned_at: string;
  expected_return_at: string | null;
  assets: { id: string; name: string; status: string } | null;
};

export async function JobAssetsSection({ jobId }: { jobId: string }) {
  const supabase = await createClient();
  const { data } = await (
    supabase.from("asset_assignments" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            order: (
              c: string,
              o: { ascending: boolean },
            ) => { limit: (n: number) => Promise<{ data: Row[] | null }> };
          };
        };
      };
    }
  )
    .select("id, asset_id, assigned_at, expected_return_at, assets(id, name, status)")
    .eq("job_id", jobId)
    .eq("status", "open")
    .order("assigned_at", { ascending: false })
    .limit(50);
  const rows = data ?? [];
  if (rows.length === 0) return null;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">Assets on this job</h2>
        <span className="text-xs text-slate-500">{rows.length} allocated</span>
      </div>
      <ul className="mt-3 divide-y divide-slate-100 text-sm">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 py-2.5">
            <Link href={`/assets/${r.asset_id}`} className="font-medium text-slate-900 hover:underline">
              {r.assets?.name ?? "Asset"}
            </Link>
            <span className="text-xs text-slate-500">since {r.assigned_at.slice(0, 10)}</span>
            {r.expected_return_at ? (
              <span className="ml-auto text-xs text-slate-400">due back {r.expected_return_at}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

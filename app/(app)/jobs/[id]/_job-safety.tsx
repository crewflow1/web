import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { effectiveStatus, PERMIT_TYPE_LABELS, type PermitStatus, type PermitType } from "@/lib/health-safety/permits";

/**
 * Job Safety hub — the H&S surface on a job page (M6b). Two bounded, RLS-scoped
 * reads: the job's RAMS (current issued highlighted, plus history) and its
 * permits (with the DERIVED status so an expired permit never reads "active").
 * Mirrors the JobAssetsSection pattern; renders nothing when the job has neither.
 */

type RaRow = { id: string; reference: string | null; title: string; status: string; revision_number: number };
type PermitRow = { id: string; reference: string | null; title: string; permit_type: string; status: string; valid_until: string | null };

const RA_STATUS_STYLE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  issued: "bg-emerald-100 text-emerald-800",
  superseded: "bg-amber-100 text-amber-800",
  withdrawn: "bg-slate-100 text-slate-500",
};
const PERMIT_STATUS_STYLE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  issued: "bg-emerald-100 text-emerald-800",
  active: "bg-emerald-100 text-emerald-800",
  suspended: "bg-amber-100 text-amber-800",
  expired: "bg-red-100 text-red-800",
  closed: "bg-slate-100 text-slate-500",
  cancelled: "bg-slate-100 text-slate-500",
};

export async function JobSafetySection({ jobId }: { jobId: string }) {
  const supabase = await createClient();
  const s = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => { eq: (k: string, v: unknown) => { order: (c: string, o: { ascending: boolean }) => { limit: (n: number) => Promise<{ data: unknown[] | null }> } } };
    };
  };
  const [ramsRes, permitsRes] = await Promise.all([
    s.from("risk_assessments").select("id, reference, title, status, revision_number").eq("job_id", jobId).order("created_at", { ascending: false }).limit(50),
    s.from("permits_to_work").select("id, reference, title, permit_type, status, valid_until").eq("job_id", jobId).order("created_at", { ascending: false }).limit(50),
  ]);
  const rams = (ramsRes.data ?? []) as RaRow[];
  const permits = (permitsRes.data ?? []) as PermitRow[];
  if (rams.length === 0 && permits.length === 0) return null;

  const now = new Date();
  const currentRams = rams.find((r) => r.status === "issued") ?? null;
  const hasNoCurrent = rams.length > 0 && !currentRams;

  return (
    <section aria-labelledby="job-safety-heading" className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 id="job-safety-heading" className="text-base font-semibold text-slate-900">Health &amp; safety</h2>
        <span className="text-xs text-slate-500">{rams.length} RAMS · {permits.length} permit{permits.length === 1 ? "" : "s"}</span>
      </div>

      {hasNoCurrent ? (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          No issued RAMS is current for this job. Issue one before work starts.
        </p>
      ) : null}

      {rams.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">Risk assessments</h3>
          <ul className="mt-2 divide-y divide-slate-100 text-sm">
            {rams.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-2">
                <Link href={`/health-safety/${r.id}`} className="font-mono text-xs font-medium text-slate-600 hover:underline">
                  {r.reference ?? "Draft"}
                </Link>
                <span className="min-w-0 flex-1 truncate text-slate-800">{r.title}</span>
                {r.revision_number > 1 ? <span className="text-xs text-slate-500">rev {r.revision_number}</span> : null}
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RA_STATUS_STYLE[r.status] ?? "bg-slate-100 text-slate-600"}`}>
                  {r.status === "issued" ? "Current" : r.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {permits.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">Permits to work</h3>
          <ul className="mt-2 divide-y divide-slate-100 text-sm">
            {permits.map((p) => {
              const eff = effectiveStatus(p.status as PermitStatus, p.valid_until, now);
              const typeLabel = PERMIT_TYPE_LABELS[p.permit_type as PermitType] ?? p.permit_type;
              return (
                <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
                  <Link href={`/health-safety/permits/${p.id}`} className="font-mono text-xs font-medium text-slate-600 hover:underline">
                    {p.reference ?? "Draft"}
                  </Link>
                  <span className="min-w-0 flex-1 truncate text-slate-800">{p.title} <span className="text-xs text-slate-500">· {typeLabel}</span></span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PERMIT_STATUS_STYLE[eff] ?? "bg-slate-100 text-slate-600"}`}>
                    {eff === "expired" ? "EXPIRED" : eff}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

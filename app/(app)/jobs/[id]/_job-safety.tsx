import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { effectiveStatus, PERMIT_TYPE_LABELS, type PermitStatus, type PermitType } from "@/lib/health-safety/permits";
import { TOOLBOX_TALK_STATUS_META, toolboxStatusLabel, type ToolboxTalkStatus } from "@/lib/health-safety/toolbox-talks";
import { formatDiaryDate } from "@/lib/site-diary/schema";

/**
 * Job Safety hub — the H&S surface on a job page (M6b + toolbox M6). Three bounded,
 * RLS-scoped reads: the job's RAMS (current issued highlighted, plus history), its
 * permits (DERIVED status so an expired permit never reads "active"), and its toolbox
 * talks (delivered briefings, current revision highlighted). Mirrors the
 * JobAssetsSection pattern; renders nothing when the job has none of the three.
 */

type RaRow = { id: string; reference: string | null; title: string; status: string; revision_number: number };
type PermitRow = { id: string; reference: string | null; title: string; permit_type: string; status: string; valid_from: string | null; valid_until: string | null };
type TalkRow = { id: string; reference: string | null; topic: string; status: ToolboxTalkStatus; revision_number: number; talk_date: string };

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
  const [ramsRes, permitsRes, talksRes] = await Promise.all([
    s.from("risk_assessments").select("id, reference, title, status, revision_number").eq("job_id", jobId).order("created_at", { ascending: false }).limit(50),
    s.from("permits_to_work").select("id, reference, title, permit_type, status, valid_from, valid_until").eq("job_id", jobId).order("created_at", { ascending: false }).limit(50),
    s.from("toolbox_talks").select("id, reference, topic, status, revision_number, talk_date").eq("job_id", jobId).order("talk_date", { ascending: false }).limit(50),
  ]);
  const rams = (ramsRes.data ?? []) as RaRow[];
  const permits = (permitsRes.data ?? []) as PermitRow[];
  const talks = (talksRes.data ?? []) as TalkRow[];
  if (rams.length === 0 && permits.length === 0 && talks.length === 0) return null;

  const now = new Date();
  const currentRams = rams.find((r) => r.status === "issued") ?? null;
  const hasNoCurrent = rams.length > 0 && !currentRams;
  // Only the delivered talks are evidence; the current one is the single issued revision.
  const deliveredTalks = talks.filter((t) => t.status !== "draft");

  return (
    <section aria-labelledby="job-safety-heading" className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 id="job-safety-heading" className="text-base font-semibold text-slate-900">Health &amp; safety</h2>
        <span className="text-xs text-slate-500">
          {rams.length} RAMS · {permits.length} permit{permits.length === 1 ? "" : "s"} · {talks.length} talk{talks.length === 1 ? "" : "s"}
        </span>
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
              const eff = effectiveStatus(p.status as PermitStatus, p.valid_until, now, p.valid_from);
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

      {talks.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Toolbox talks {deliveredTalks.length > 0 ? `· latest ${formatDiaryDate(deliveredTalks[0]!.talk_date)}` : ""}
          </h3>
          <ul className="mt-2 divide-y divide-slate-100 text-sm">
            {talks.map((t) => {
              const meta = TOOLBOX_TALK_STATUS_META[t.status] ?? TOOLBOX_TALK_STATUS_META.draft;
              return (
                <li key={t.id} className="flex flex-wrap items-center gap-2 py-2">
                  <Link href={`/toolbox/${t.id}`} className="font-mono text-xs font-medium text-slate-600 hover:underline">
                    {t.reference ?? "Draft"}
                  </Link>
                  <span className="min-w-0 flex-1 truncate text-slate-800">{t.topic}</span>
                  {t.revision_number > 1 ? <span className="text-xs text-slate-500">rev {t.revision_number}</span> : null}
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.tone}`}>{toolboxStatusLabel(t.status)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

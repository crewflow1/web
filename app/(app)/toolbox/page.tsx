import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../_components/empty-state";
import { formatDiaryDate } from "@/lib/site-diary/schema";
import { TOOLBOX_TALK_STATUS_META, type ToolboxTalkStatus } from "@/lib/health-safety/toolbox-talks";

/**
 * /toolbox — on-site safety briefings that evolve into acknowledgeable evidence.
 * One org-scoped read; job names resolve in one batched lookup. A row shows its
 * lifecycle status (Draft / Delivered / Superseded / Withdrawn) and reference.
 */

type TalkRow = {
  id: string;
  status: ToolboxTalkStatus;
  reference: string | null;
  talk_date: string;
  topic: string;
  presenter: string | null;
  attendees: string | null;
  attendee_count: number | null;
  job_id: string | null;
  created_at: string;
};

const ERROR_MAP: Record<string, string> = {
  bad_id: "Invalid talk.",
  forbidden: "Only an owner or admin can delete a toolbox talk.",
  delete_failed: "Couldn't delete that talk.",
  not_deletable: "Only a draft can be deleted.",
  not_found: "That talk no longer exists.",
};
const SAVED_MAP: Record<string, string> = {
  created: "Toolbox talk drafted.",
  deleted: "Draft deleted.",
};

type SP = Promise<{ saved?: string; error?: string }>;

export default async function ToolboxPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  const { data } = await (
    supabase.from("toolbox_talks" as never) as unknown as {
      select: (cols: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          order: (
            col: string,
            opts: { ascending: boolean },
          ) => {
            order: (
              col: string,
              opts: { ascending: boolean },
            ) => { limit: (n: number) => Promise<{ data: TalkRow[] | null }> };
          };
        };
      };
    }
  )
    .select(
      "id, status, reference, talk_date, topic, presenter, attendees, attendee_count, job_id, created_at",
    )
    // ACTIVE-org pin — the safety-briefing record is inspector-facing evidence
    // and must be one company's; RLS admits every org the viewer belongs to.
    .eq("org_id", ctx.org.id)
    .order("talk_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500);
  const rows = data ?? [];

  const jobIds = [
    ...new Set(rows.map((r) => r.job_id).filter((x): x is string => !!x)),
  ];
  const jobsMap = new Map<string, string>();
  if (jobIds.length) {
    const { data: jobs } = await supabase
      .from("jobs")
      .select("id, customer:customers ( name )")
      .eq("org_id", ctx.org.id)
      .in("id", jobIds);
    for (const j of jobs ?? []) jobsMap.set(j.id, j.customer?.name ?? "Job");
  }

  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? null) : null;
  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Toolbox talks</h1>
          <p className="mt-1 text-sm text-slate-600">
            Your record of on-site safety briefings — topic, who delivered it, and
            who attended. Evidence you can show an inspector.
          </p>
        </div>
        <Link
          href="/toolbox/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          + Record a talk
        </Link>
      </header>

      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}
      {savedMessage ? (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {savedMessage}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon="🦺"
          title="No toolbox talks recorded yet"
          body="Record the safety briefings you give on site — the topic, who ran it, who was there. Attach the signed sheet as a photo."
          primary={{ href: "/toolbox/new", label: "Record a talk" }}
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const jobName = row.job_id ? jobsMap.get(row.job_id) : null;
            const meta = TOOLBOX_TALK_STATUS_META[row.status] ?? TOOLBOX_TALK_STATUS_META.draft;
            return (
              <li key={row.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-slate-900">{row.topic}</p>
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.tone}`}>
                        {meta.label}
                      </span>
                      {row.reference ? <span className="font-mono text-xs text-slate-500">{row.reference}</span> : null}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                      <span className="font-medium text-slate-700">
                        {formatDiaryDate(row.talk_date)}
                      </span>
                      {jobName ? <span>📋 {jobName}</span> : null}
                      {row.presenter ? <span>🎤 {row.presenter}</span> : null}
                      {row.attendee_count != null ? (
                        <span>👥 {row.attendee_count} attended</span>
                      ) : null}
                    </div>
                  </div>
                  <Link
                    href={`/toolbox/${row.id}`}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    View
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-slate-500">
        {rows.length} talk{rows.length === 1 ? "" : "s"} recorded.
      </p>
    </div>
  );
}

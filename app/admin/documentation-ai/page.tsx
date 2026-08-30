import { Suspense } from "react";
import { BookOpenText, Sparkles, FileSearch, History } from "lucide-react";
import { requireHqPage } from "@/server/auth/hq";
import {
  getDocumentationAiOverview,
  type DocumentationRunRow,
} from "@/server/services/hq-documentation-runner";

/**
 * CrewFlow HQ — Documentation AI (super-admin surface, L9a / P10).
 *
 * The Documentation AI's board: the latest deterministic doc-drift scan
 * (`documentation_drift`, now extended with the roster↔Bible workforce file
 * cross-check) and the latest composed release-notes draft
 * (`release_notes_draft`, built from admin_activity_log + hq_events +
 * hq_decisions in a real window), plus the recent run history. Every artifact
 * states its sources; an unreadable source is an honest insufficient, never a
 * fabricated all-clear.
 *
 * The generative prose leg is DARK: it populates only once a model tier is
 * bound behind the governor (`hq.doc_draft`). Until then the empty state says
 * so.
 *
 * Auth: the parent /admin layout gates on requireHqPage; this page re-gates for
 * defence-in-depth.
 */

export const dynamic = "force-dynamic";

const SEVERITY_PILL: Record<string, { pill: string; label: string }> = {
  ok: { pill: "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30", label: "OK" },
  warning: { pill: "bg-amber-500/10 text-amber-300 ring-amber-400/30", label: "Warning" },
  critical: { pill: "bg-red-500/10 text-red-300 ring-red-400/30", label: "Critical" },
  insufficient: {
    pill: "bg-slate-700/40 text-slate-400 ring-slate-600/40",
    label: "Insufficient data",
  },
};

function severityOf(artifact: Record<string, unknown> | null): string {
  if (artifact == null) return "insufficient";
  if (artifact.insufficient === true) return "insufficient";
  const s = artifact.severity;
  return typeof s === "string" && s in SEVERITY_PILL ? s : "insufficient";
}

export default async function DocumentationAiPage() {
  await requireHqPage();
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      <Header />
      <div className="space-y-8 p-5 sm:p-7">
        <Suspense fallback={<BoardSkeleton />}>
          <Body />
        </Suspense>
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="relative border-b border-slate-800 px-5 py-6 sm:px-7">
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            "radial-gradient(60% 120% at 15% 0%, rgba(56,189,248,0.14), transparent 60%), radial-gradient(50% 120% at 90% 0%, rgba(129,140,248,0.12), transparent 55%)",
        }}
        aria-hidden
      />
      <div className="relative flex items-start gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-400/30">
          <BookOpenText className="h-6 w-6" strokeWidth={1.75} aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white">Documentation AI</h1>
          <p className="mt-0.5 max-w-xl text-sm text-slate-400">
            Deterministic doc-drift scans (roster and capability descriptions,
            plus the roster↔Bible workforce cross-check) and release-notes
            drafts composed from the real activity, event and decision ledgers.
            Nothing is invented; a human reviews everything before it is
            published anywhere.
          </p>
        </div>
      </div>
    </div>
  );
}

async function Body() {
  const overview = await getDocumentationAiOverview();
  return (
    <>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ArtifactPanel
          title="Doc-drift scan"
          subtitle="documentation_drift — blank descriptions + roster↔Bible coverage"
          artifact={overview.latestDrift}
          emptyText="No completed doc-drift scan yet — the daily documentation_drift task has not run."
        />
        <ArtifactPanel
          title="Release-notes draft"
          subtitle="release_notes_draft — composed from admin activity, HQ events and decisions"
          artifact={overview.latestReleaseNotes}
          emptyText="No composed release notes yet — enqueue a release_notes_draft task to produce one."
        />
      </div>
      <SectionsPanel artifact={overview.latestReleaseNotes} />
      <GenerativePanel artifact={overview.latestReleaseNotes} />
      <RecentRuns rows={overview.recent} />
      <p className="text-center text-[11px] text-slate-600">
        Every artifact is a deterministic envelope over real ledgers — sourced,
        explainable, and approval-required; nothing is fabricated.
      </p>
    </>
  );
}

function ArtifactPanel({
  title,
  subtitle,
  artifact,
  emptyText,
}: {
  title: string;
  subtitle: string;
  artifact: Record<string, unknown> | null;
  emptyText: string;
}) {
  const sev = severityOf(artifact);
  const style = SEVERITY_PILL[sev]!;
  const summary = typeof artifact?.summary === "string" ? artifact.summary : null;
  const reasoning = typeof artifact?.reasoning === "string" ? artifact.reasoning : null;
  const generatedAt = typeof artifact?.generatedAt === "string" ? artifact.generatedAt : null;
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <FileSearch className="h-4 w-4 text-slate-400" aria-hidden />
        <h2 className="text-sm font-semibold text-white">{title}</h2>
      </div>
      {artifact == null ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/30 p-4 text-xs text-slate-500">
          {emptyText}
        </div>
      ) : (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="flex items-center justify-between gap-2">
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset ${style.pill}`}
            >
              {style.label}
            </span>
            {generatedAt ? (
              <span className="text-[10px] text-slate-600">
                {new Date(generatedAt).toLocaleString("en-GB")}
              </span>
            ) : null}
          </div>
          {summary ? (
            <p className="mt-3 text-sm leading-relaxed text-slate-200">{summary}</p>
          ) : null}
          {reasoning ? (
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{reasoning}</p>
          ) : null}
          <p className="mt-3 text-[10px] uppercase tracking-wide text-slate-600">{subtitle}</p>
        </div>
      )}
    </section>
  );
}

type NotesSection = { key?: unknown; heading?: unknown; entries?: unknown };

function SectionsPanel({ artifact }: { artifact: Record<string, unknown> | null }) {
  const raw = artifact?.sections;
  const sections = Array.isArray(raw) ? (raw as NotesSection[]) : [];
  if (sections.length === 0) return null;
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-white">Composed sections</h2>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sections.map((sec, i) => (
          <div key={typeof sec.key === "string" ? sec.key : i} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {typeof sec.heading === "string" ? sec.heading : "Section"}
            </p>
            <ul className="mt-2 space-y-1">
              {(Array.isArray(sec.entries) ? sec.entries : []).slice(0, 8).map((e, j) => (
                <li key={j} className="text-[12px] leading-relaxed text-slate-400">
                  {String(e)}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function GenerativePanel({ artifact }: { artifact: Record<string, unknown> | null }) {
  const prose =
    typeof artifact?.generativeProse === "string" ? (artifact.generativeProse as string) : null;
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-white">Reader-facing prose</h2>
      </div>
      {prose ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm leading-relaxed text-slate-300">
          {prose}
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-xl border border-dashed border-slate-800 bg-slate-900/30 p-4">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-800/60 text-slate-400 ring-1 ring-inset ring-slate-700/50">
            <Sparkles className="h-4 w-4" aria-hidden />
          </span>
          <div>
            <p className="text-sm font-medium text-slate-300">
              Prose drafting populates once a model tier is bound
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Governed prose over the composed sections runs behind the AI
              governor (hq.doc_draft). It stays dark — and the deterministic
              composition above stays fully honest — until a model tier is
              armed for it.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

function RecentRuns({ rows }: { rows: DocumentationRunRow[] }) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <History className="h-4 w-4 text-slate-400" aria-hidden />
        <h2 className="text-sm font-semibold text-white">Recent artifacts</h2>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/30 p-4 text-xs text-slate-500">
          No documentation tasks have run yet — an empty history, honestly empty.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full min-w-[560px] text-left text-xs">
            <thead className="bg-slate-900/80 text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-semibold">Task</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Summary</th>
                <th className="px-3 py-2 font-semibold">Finished</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 bg-slate-950/40">
              {rows.map((r) => (
                <tr key={r.taskId}>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-300">{r.taskType}</td>
                  <td className="px-3 py-2 text-slate-400">{r.status}</td>
                  <td className="max-w-[320px] truncate px-3 py-2 text-slate-400">
                    {r.summary ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-500">
                    {r.finishedAt ? new Date(r.finishedAt).toLocaleString("en-GB") : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function BoardSkeleton() {
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <div className="h-5 w-24 animate-pulse rounded-full bg-slate-800" />
            <div className="mt-3 h-3 w-full animate-pulse rounded bg-slate-800" />
            <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-slate-800" />
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="h-3 w-full animate-pulse rounded bg-slate-800" />
        <div className="mt-2 h-3 w-3/4 animate-pulse rounded bg-slate-800" />
      </div>
    </div>
  );
}

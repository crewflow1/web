import { Suspense } from "react";
import { Palette, Sparkles, SwatchBook, History } from "lucide-react";
import { requireHqPage } from "@/server/auth/hq";
import { getDesignAiOverview, type DesignRunRow } from "@/server/services/hq-design-runner";

/**
 * CrewFlow HQ — Design AI (super-admin surface, L9a / P8).
 *
 * The Design AI's board: the latest deterministic brand-token audit
 * (`design_consistency`) and design review (`design_review`) artifacts, plus
 * the recent run history. Every artifact is a deterministic envelope over REAL
 * roster data (ai_employees icon/accent/department) — token gaps, format
 * coherence, accent/icon collisions — and states its own sources and basis.
 * Honest scope: component-adoption audits live in CI design-system tests, and
 * this page says so rather than pretending a runtime file-system audit ran.
 *
 * The generative UI critique is DARK: it populates only once a model tier is
 * bound behind the governor (`hq.design_review`). Until then the empty state
 * says so.
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

export default async function DesignAiPage() {
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
            "radial-gradient(60% 120% at 15% 0%, rgba(217,70,239,0.14), transparent 60%), radial-gradient(50% 120% at 90% 0%, rgba(129,140,248,0.12), transparent 55%)",
        }}
        aria-hidden
      />
      <div className="relative flex items-start gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-fuchsia-500/15 text-fuchsia-300 ring-1 ring-inset ring-fuchsia-400/30">
          <Palette className="h-6 w-6" strokeWidth={1.75} aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white">Design AI</h1>
          <p className="mt-0.5 max-w-xl text-sm text-slate-400">
            Deterministic design audits over the data the platform actually
            stores — roster brand tokens, format coherence, accent and icon
            collisions. Component-adoption audits live in the CI design-system
            tests; nothing here pretends otherwise, and no design asset is
            changed by an audit.
          </p>
        </div>
      </div>
    </div>
  );
}

async function Body() {
  const overview = await getDesignAiOverview();
  return (
    <>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ArtifactPanel
          title="Brand-token audit"
          subtitle="design_consistency — icon/accent coverage over the roster"
          artifact={overview.latestConsistency}
          emptyText="No completed brand-token audit yet — the daily design_consistency task has not run."
        />
        <ArtifactPanel
          title="Design review"
          subtitle="design_review — token-format coherence, accent & icon collisions"
          artifact={overview.latestReview}
          emptyText="No completed design review yet — enqueue a design_review task to produce one."
        />
      </div>
      <GenerativePanel artifact={overview.latestReview} />
      <RecentRuns rows={overview.recent} />
      <p className="text-center text-[11px] text-slate-600">
        Every artifact is a deterministic envelope over ai_employees — sourced,
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
        <SwatchBook className="h-4 w-4 text-slate-400" aria-hidden />
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

function GenerativePanel({ artifact }: { artifact: Record<string, unknown> | null }) {
  const critique =
    typeof artifact?.generativeCritique === "string" ? (artifact.generativeCritique as string) : null;
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-white">Design critique</h2>
      </div>
      {critique ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm leading-relaxed text-slate-300">
          {critique}
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-xl border border-dashed border-slate-800 bg-slate-900/30 p-4">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-800/60 text-slate-400 ring-1 ring-inset ring-slate-700/50">
            <Sparkles className="h-4 w-4" aria-hidden />
          </span>
          <div>
            <p className="text-sm font-medium text-slate-300">
              Design critique populates once a model tier is bound
            </p>
            <p className="mt-1 text-xs text-slate-500">
              A governed prose critique of the deterministic findings runs
              behind the AI governor (hq.design_review). It stays dark — and the
              audits above stay fully honest — until a model tier is armed for
              it.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

function RecentRuns({ rows }: { rows: DesignRunRow[] }) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <History className="h-4 w-4 text-slate-400" aria-hidden />
        <h2 className="text-sm font-semibold text-white">Recent artifacts</h2>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/30 p-4 text-xs text-slate-500">
          No design tasks have run yet — an empty history, honestly empty.
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

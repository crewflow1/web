import { Clock } from "lucide-react";
import { requireHqPage } from "@/server/auth/hq";
import { listCadences, type CadenceScheduleRow } from "@/server/services/hq-cadence";
import { relativeTime } from "@/lib/time/relative";
import { setCadenceEnabledAction } from "./actions";

/**
 * HQ operating-model cadence clock — the schedule registry surface.
 *
 * One modelled clock over the hand-rolled HQ cron cadences. Each row is a cadence
 * bound to its EXISTING HQ authority; the deterministic tick fires the enabled
 * ones. This board views the registry and enables/pauses cadences — DARK by
 * default, so enabling a cadence is an explicit super-admin opt-in and the legacy
 * crons keep firing regardless.
 *
 * Gated twice: app/admin/layout.tsx (requireHqPage) plus this page's own
 * requireHqPage() call (defence-in-depth, same as the Workflow-Saga board).
 */

export const dynamic = "force-dynamic";

type SP = Promise<{ saved?: string; error?: string }>;

const SAVED_LABEL: Record<string, string> = {
  enabled: "Cadence enabled — the tick will fire its due occurrences.",
  paused: "Cadence paused — it is dark again; the legacy cron is unaffected.",
};

export default async function HqCadencePage({ searchParams }: { searchParams: SP }) {
  await requireHqPage();
  const sp = await searchParams;

  const rows = await listCadences();
  const enabled = rows.filter((r) => r.enabled);
  const dark = rows.filter((r) => !r.enabled);

  const savedMsg = sp.saved ? (SAVED_LABEL[sp.saved] ?? null) : null;
  const errorMsg = (sp.error ?? "").trim() || null;

  return (
    <div className="space-y-5">
      <header className="flex items-start gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-cyan-100 text-cyan-700">
          <Clock className="h-6 w-6" strokeWidth={1.75} aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900">Cadence Clock</h1>
          <p className="mt-0.5 max-w-2xl text-sm text-slate-600">
            The operating-model schedule registry — one modelled clock over the HQ cron
            cadences. Each cadence routes to its existing authority; the deterministic
            tick fires the enabled ones. Cadences are dark by default, so the legacy
            crons keep running unchanged until you opt one in here.
          </p>
        </div>
      </header>

      {savedMsg ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          {savedMsg}
        </p>
      ) : null}
      {errorMsg ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">
          {errorMsg}
        </p>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Enabled ({enabled.length})
        </h2>
        {enabled.length === 0 ? (
          <EmptyState label="No cadence is enabled. The tick is inert; every cron runs on its own schedule." />
        ) : (
          <ul className="space-y-3">
            {enabled.map((row) => (
              <li key={row.id}>
                <CadenceCard row={row} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Dark ({dark.length})
        </h2>
        {dark.length === 0 ? (
          <EmptyState label="Every modelled cadence is enabled." />
        ) : (
          <ul className="space-y-3">
            {dark.map((row) => (
              <li key={row.id}>
                <CadenceCard row={row} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <p className="text-sm text-slate-500">{label}</p>
    </div>
  );
}

function CadenceCard({ row }: { row: CadenceScheduleRow }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            row.enabled ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"
          }`}
        >
          {row.enabled ? "enabled" : "dark"}
        </span>
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
          {row.cadence_key}
        </h3>
        <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
          {row.cron_expr}
        </code>
      </div>
      {row.description ? (
        <p className="mt-1.5 text-xs text-slate-500">{row.description}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
        <span>next: {row.next_run_at ? relativeTime(row.next_run_at) : "—"}</span>
        <span>last: {row.last_run_at ? relativeTime(row.last_run_at) : "never"}</span>
      </div>
      <form action={setCadenceEnabledAction} className="mt-3">
        <input type="hidden" name="cadence_key" value={row.cadence_key} />
        <input type="hidden" name="enabled" value={row.enabled ? "false" : "true"} />
        <button
          type="submit"
          className={`rounded-md px-3 py-1.5 text-xs font-semibold text-white transition ${
            row.enabled
              ? "bg-slate-600 hover:bg-slate-500"
              : "bg-cyan-600 hover:bg-cyan-500"
          }`}
        >
          {row.enabled ? "Pause cadence" : "Enable cadence"}
        </button>
      </form>
    </div>
  );
}

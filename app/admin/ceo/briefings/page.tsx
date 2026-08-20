import Link from "next/link";
import {
  ArrowDownRight,
  ArrowLeft,
  ArrowUpRight,
  CalendarDays,
  Crown,
  FileText,
  Minus,
  ScrollText,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { requireHqPage } from "@/server/auth/hq";
import {
  getCeoBriefingArchive,
  selectBriefingByDate,
} from "@/server/services/hq-ceo-briefing-reader";
import {
  BRIEFING_TONE_ORDER,
  type CeoBriefingRecord,
} from "@/lib/hq/ceo-briefing-record";
import { formatExec } from "@/lib/hq/executive";
import type { DeptHealthTone } from "@/lib/hq/ceo";
import type { CeoBriefingSignals } from "@/lib/hq/ceo-briefing";

/**
 * CrewFlow HQ — the morning CEO briefing READER (P2 HQ AI Operating System).
 *
 * The daily briefing has been COMPOSED and STORED (server/services/hq-ceo-briefing.ts,
 * table hq_ceo_briefings, migration 20261128) by a morning cron since it shipped — but
 * nothing has ever read it back. This page is the reader: the latest briefing with its
 * structured sections (vitals, departments by health, competitor intel), its provenance
 * (deterministic source + generated timestamp + correlation id), the full narrative, and
 * an archive of every prior day with drill-down by date.
 *
 * STRICTLY READ-ONLY: no actions, no forms, no writes — it renders what the read service
 * SELECTed and nothing else. It does NOT re-compose or re-derive; the composition
 * (lib/hq/ceo-briefing.ts) is untouched. The `signals` snapshot is the honesty record the
 * narrative was built from; this page displays it verbatim.
 *
 * Auth: gated on requireHqPage (isSuperAdminEmail) — the parent /admin layout also gates,
 * this is the defence-in-depth self-check every HQ reader makes (mirrors executor-shadow).
 *
 * UNTRUSTED-SAFE: every field renders as React-escaped plain text (no raw-HTML
 * injection sink anywhere), so a competitor-note headline can carry no active content.
 */

export const dynamic = "force-dynamic";

type SP = Promise<{ date?: string | string[] }>;

const TONE_STYLE: Record<DeptHealthTone, { dot: string; pill: string; heading: string }> = {
  attention: {
    dot: "bg-amber-400",
    pill: "bg-amber-500/10 text-amber-300 ring-amber-400/30",
    heading: "Needs attention",
  },
  insufficient: {
    dot: "bg-zinc-400 ring-1 ring-zinc-300/40",
    pill: "bg-zinc-500/10 text-zinc-300 ring-zinc-400/40",
    heading: "Signal unavailable",
  },
  foundation: {
    dot: "bg-slate-500",
    pill: "bg-slate-700/40 text-slate-400 ring-slate-600/40",
    heading: "Foundation (built, no volume yet)",
  },
  steady: {
    dot: "bg-sky-400",
    pill: "bg-sky-500/10 text-sky-300 ring-sky-400/30",
    heading: "Steady",
  },
  healthy: {
    dot: "bg-emerald-400",
    pill: "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30",
    heading: "Healthy",
  },
};

const IMPORTANCE_STYLE: Record<string, string> = {
  critical: "bg-rose-500/15 text-rose-300 ring-rose-400/30",
  high: "bg-amber-500/15 text-amber-300 ring-amber-400/30",
  normal: "bg-slate-700/40 text-slate-300 ring-slate-600/40",
  low: "bg-slate-800/60 text-slate-400 ring-slate-700/50",
};

function firstParam(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function formatDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString("en-GB");
}

export default async function CeoBriefingReaderPage({ searchParams }: { searchParams: SP }) {
  await requireHqPage();
  const sp = await searchParams;
  const requestedDate = firstParam(sp.date);

  const archive = await getCeoBriefingArchive();
  const selected = selectBriefingByDate(archive, requestedDate);

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      <Header count={archive.all.length} />
      <div className="space-y-8 p-5 sm:p-7">
        {selected === null ? (
          <EmptyState />
        ) : (
          <>
            <BriefingDetail briefing={selected} isLatest={selected.id === archive.latest?.id} />
            <ArchiveList
              all={archive.all}
              selectedId={selected.id}
              latestId={archive.latest?.id ?? null}
            />
          </>
        )}
      </div>
    </div>
  );
}

function Header({ count }: { count: number }) {
  return (
    <div className="relative border-b border-slate-800 px-5 py-6 sm:px-7">
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            "radial-gradient(60% 120% at 15% 0%, rgba(99,102,241,0.18), transparent 60%), radial-gradient(50% 120% at 90% 0%, rgba(16,185,129,0.12), transparent 55%)",
        }}
        aria-hidden
      />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30">
            <ScrollText className="h-6 w-6" strokeWidth={1.75} aria-hidden />
          </span>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">Morning CEO briefings</h1>
            <p className="mt-0.5 max-w-xl text-sm text-slate-400">
              The deterministic daily briefing the HQ cron composes from the real CEO board — one
              record per day, narrated from the board&apos;s own figures, fabricating nothing.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-[11px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-400/30">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
            Read-only · HQ only · {count} recorded
          </span>
          <Link
            href="/admin/ceo"
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
          >
            <Crown className="h-3.5 w-3.5" aria-hidden />
            CEO Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/40 px-6 py-16 text-center">
      <ScrollText className="mx-auto h-8 w-8 text-slate-600" strokeWidth={1.5} aria-hidden />
      <p className="mt-3 text-sm font-medium text-slate-300">No briefings recorded yet</p>
      <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
        The morning cron composes one briefing per day from the CEO board and records it here. The
        first row appears after the next scheduled run — this empty state is an honest read, not a
        failed one.
      </p>
    </div>
  );
}

function BriefingDetail({
  briefing,
  isLatest,
}: {
  briefing: CeoBriefingRecord;
  isLatest: boolean;
}) {
  const { signals } = briefing;
  return (
    <section className="space-y-6">
      {/* Headline + provenance */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 ring-1 ring-inset ring-white/5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
            <CalendarDays className="h-3 w-3" aria-hidden />
            {formatDay(briefing.briefingDate)}
          </span>
          {isLatest ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300 ring-1 ring-inset ring-emerald-400/30">
              <Sparkles className="h-3 w-3" aria-hidden />
              Latest
            </span>
          ) : (
            <Link
              href="/admin/ceo/briefings"
              className="inline-flex items-center gap-1 rounded-full bg-slate-800 px-2.5 py-0.5 text-[11px] font-semibold text-slate-300 ring-1 ring-inset ring-slate-700 transition hover:bg-slate-700"
            >
              <ArrowLeft className="h-3 w-3" aria-hidden />
              Back to latest
            </Link>
          )}
        </div>
        <h2 className="mt-3 text-lg font-bold leading-snug text-white">{briefing.headline}</h2>
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-slate-500">
          <div>
            <dt className="inline text-slate-500">source </dt>
            <dd className="inline font-semibold text-slate-300">{briefing.source}</dd>
          </div>
          <div>
            <dt className="inline text-slate-500">generated </dt>
            <dd className="inline font-semibold text-slate-300">
              {formatStamp(briefing.generatedAt)}
            </dd>
          </div>
          {briefing.correlationId ? (
            <div className="min-w-0">
              <dt className="inline text-slate-500">correlation </dt>
              <dd className="inline break-all font-mono text-slate-400">
                {briefing.correlationId}
              </dd>
            </div>
          ) : null}
        </dl>
      </div>

      <VitalsSection signals={signals} />
      <DepartmentsSection signals={signals} />
      <CompetitorsSection signals={signals} />
      <NarrativeSection narrative={briefing.narrative} />
    </section>
  );
}

function VitalsSection({ signals }: { signals: CeoBriefingSignals }) {
  return (
    <div>
      <SectionHeading title="Company vitals" hint="The board figures the briefing was composed from" />
      {signals.vitals.length === 0 ? (
        <UnavailableRow text="No vitals in the recorded snapshot." />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {signals.vitals.map((v) => (
            <div
              key={v.key}
              className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 ring-1 ring-inset ring-white/5"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  {v.label}
                </p>
                <TrendChip
                  direction={v.trendDirection}
                  pct={v.trendPct}
                />
              </div>
              <p className="mt-2 text-2xl font-bold tabular-nums text-slate-100">
                {formatExec(v.value, v.format)}
              </p>
              {v.foundation ? (
                <p className="mt-1 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                  Foundation
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DepartmentsSection({ signals }: { signals: CeoBriefingSignals }) {
  return (
    <div>
      <SectionHeading title="Departments" hint="Grouped by their honest health signal — most urgent first" />
      {signals.departments.length === 0 ? (
        <UnavailableRow text="No departments in the recorded snapshot." />
      ) : (
        <div className="space-y-3">
          {BRIEFING_TONE_ORDER.map((tone) => {
            const inTone = signals.departments.filter((d) => d.healthTone === tone);
            if (inTone.length === 0) return null;
            const style = TONE_STYLE[tone];
            return (
              <div
                key={tone}
                className="rounded-xl border border-slate-800 bg-slate-900/40 p-3.5 ring-1 ring-inset ring-white/5"
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden />
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    {style.heading}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {inTone.map((d) => (
                    <span
                      key={d.key}
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${style.pill}`}
                    >
                      {d.title}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CompetitorsSection({ signals }: { signals: CeoBriefingSignals }) {
  const { competitors } = signals;
  const shown = competitors.notes.length;
  return (
    <div>
      <SectionHeading
        title="Competitor intelligence"
        hint={
          competitors.total > 0
            ? `Operator-authored notes — showing ${shown} of ${competitors.total} active`
            : "Operator-authored notes"
        }
      />
      {shown === 0 ? (
        <UnavailableRow text="Insufficient — no competitor intelligence was recorded for this day." />
      ) : (
        <ul className="space-y-2">
          {competitors.notes.map((c, idx) => (
            <li
              key={`${c.name}-${idx}`}
              className="rounded-xl border border-slate-800 bg-slate-900/60 p-3.5 ring-1 ring-inset ring-white/5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-slate-100">{c.name}</span>
                {c.category ? (
                  <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400 ring-1 ring-inset ring-slate-700">
                    {c.category}
                  </span>
                ) : null}
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${
                    IMPORTANCE_STYLE[c.importance] ?? IMPORTANCE_STYLE.normal
                  }`}
                >
                  {c.importance}
                </span>
                {c.capturedAt ? (
                  <span className="ml-auto text-[11px] text-slate-500">{c.capturedAt}</span>
                ) : null}
              </div>
              <p className="mt-1.5 text-sm text-slate-300">{c.headline}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NarrativeSection({ narrative }: { narrative: string }) {
  return (
    <div>
      <SectionHeading
        title="Full narrative"
        hint="The composed deterministic text — re-derivable from the snapshot above"
      />
      <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 ring-1 ring-inset ring-white/5">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
          <FileText className="h-3.5 w-3.5" aria-hidden />
          As recorded
        </div>
        <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-slate-300">
          {narrative}
        </pre>
      </div>
    </div>
  );
}

function ArchiveList({
  all,
  selectedId,
  latestId,
}: {
  all: ReadonlyArray<CeoBriefingRecord>;
  selectedId: number;
  latestId: number | null;
}) {
  if (all.length <= 1) return null;
  return (
    <section>
      <SectionHeading title="Archive" hint={`Every recorded briefing (${all.length}) — open one to drill in`} />
      <ul className="divide-y divide-slate-800 overflow-hidden rounded-xl border border-slate-800">
        {all.map((b) => {
          const active = b.id === selectedId;
          return (
            <li key={b.id}>
              <Link
                href={
                  b.id === latestId
                    ? "/admin/ceo/briefings"
                    : `/admin/ceo/briefings?date=${b.briefingDate}`
                }
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-3 px-4 py-3 text-sm transition ${
                  active
                    ? "bg-slate-800/70 text-white"
                    : "bg-slate-900/40 text-slate-300 hover:bg-slate-900"
                }`}
              >
                <span className="inline-flex w-28 shrink-0 items-center gap-1.5 text-[11px] font-semibold text-slate-400">
                  <CalendarDays className="h-3 w-3" aria-hidden />
                  {b.briefingDate}
                </span>
                <span className="min-w-0 flex-1 truncate">{b.headline}</span>
                {b.id === latestId ? (
                  <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 ring-1 ring-inset ring-emerald-400/30">
                    Latest
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SectionHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mb-3">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      <p className="mt-0.5 text-xs text-slate-500">{hint}</p>
    </div>
  );
}

function UnavailableRow({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/40 px-4 py-6 text-center text-xs text-slate-500">
      {text}
    </div>
  );
}

function TrendChip({
  direction,
  pct,
}: {
  direction: "up" | "down" | "flat" | null;
  pct: number | null;
}) {
  if (direction === null || pct === null) return null;
  if (direction === "flat") {
    return (
      <span className="inline-flex items-center gap-0.5 rounded-full bg-slate-700/40 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400 ring-1 ring-inset ring-slate-600/40">
        <Minus className="h-3 w-3" strokeWidth={2.5} aria-hidden />
        flat
      </span>
    );
  }
  const up = direction === "up";
  const cls = up
    ? "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30"
    : "bg-rose-500/15 text-rose-300 ring-rose-400/30";
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${cls}`}
    >
      <Icon className="h-3 w-3" strokeWidth={2.5} aria-hidden />
      {Math.abs(pct)}%
    </span>
  );
}

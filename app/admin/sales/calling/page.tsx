import Link from "next/link";
import { AnimatedNumber } from "@/components/ui";
import {
  BookOpen,
  Clock,
  ListChecks,
  MessageSquareWarning,
  PhoneCall,
  PhoneIncoming,
  PhoneOutgoing,
  Plug,
  Search,
  ShieldCheck,
  Target,
  Voicemail,
  X,
} from "lucide-react";
import { getCallingCentre } from "@/server/services/hq-sales";
import { relativeTime } from "@/lib/sales/model";
import {
  CALL_SENTIMENTS,
  callDirectionLabel,
  callOutcomeLabel,
  callOutcomeTone,
  callSentimentLabel,
  callStatusLabel,
  formatDuration,
  isOpenCallStatus,
  scriptCategoryLabel,
  objectionCategoryLabel,
  playbookStatusLabel,
  sentimentTone,
  aiTaskPriorityLabel,
} from "@/lib/sales/calling";
import type {
  SalesCallItem,
  SalesCallScript,
  SalesObjection,
} from "@/lib/sales/model";
import { Chip, EmptyState, Pill, Section, Tile } from "../_components";
import { callStatusPill, inputCls, tonerPill } from "../_styles";

/**
 * Sales AI — AI Calling Centre (CEO Directive 004, Phase 6).
 *
 * The durable home of the calling operation: a live call queue, a per-call
 * record carrying recording / transcript / AI summary / sentiment / outcome /
 * duration / follow-up, a reusable call-script library, and an objection-
 * handling playbook. FOUNDATION ONLY — nothing here places, records or
 * transcribes a call; it presents the permanent, audited hq_sales_calls data
 * the autonomous engine will one day write, plus the seeded, immediately-
 * useful CrewFlow construction-sales scripts + objection plays. The telephony
 * connector (Aircall) is shown honestly as planned, never faked. HQ operator
 * only (the layout gates the whole module to Super Admin).
 */

export const dynamic = "force-dynamic";

type SP = Promise<{ q?: string }>;

function integrationPill(status: string): string {
  if (status === "connected") {
    return "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30";
  }
  if (status === "disabled") {
    return "bg-slate-700/40 text-slate-500 ring-1 ring-inset ring-slate-600/40";
  }
  return "bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30";
}

export default async function CallingPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const query = sp.q?.trim() ?? "";

  const centre = await getCallingCentre({ search: query || undefined });
  const { stats, queue, recent, scripts, objections, integrations } = centre;

  const telephony = integrations.filter((i) => i.category === "comms");
  const topOutcomes = stats.byOutcome
    .filter((o) => o.count > 0)
    .sort((a, b) => b.count - a.count);

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      {/* Header */}
      <div className="relative border-b border-slate-800 px-5 py-6 sm:px-7">
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background:
              "radial-gradient(60% 120% at 15% 0%, rgba(99,102,241,0.18), transparent 60%), radial-gradient(50% 120% at 90% 0%, rgba(16,185,129,0.12), transparent 55%)",
          }}
          aria-hidden
        />
        <div className="relative">
          <p className="text-sm text-slate-500">
            <Link href="/admin/sales" className="transition-colors hover:text-slate-300">
              Sales AI
            </Link>{" "}
            / <span className="text-slate-300">Calling</span>
          </p>
          <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
                <PhoneCall className="h-6 w-6" strokeWidth={1.75} aria-hidden />
              </span>
              <div>
                <h1 className="text-xl font-bold tracking-tight text-white">
                  Calling Centre
                </h1>
                <p className="mt-0.5 max-w-xl text-sm text-slate-400">
                  The call queue, per-call records, the reusable script library
                  and the objection playbook — one searchable command centre for
                  the calling operation.
                </p>
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-1 text-[11px] font-medium text-amber-300 ring-1 ring-inset ring-amber-400/30">
              <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Architecture only · no live calls are placed
            </span>
          </div>
        </div>
      </div>

      <div className="space-y-5 p-5 sm:p-7">
        {/* Totals */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label="Total calls" value={<AnimatedNumber value={stats.total} />} accent sub="all time" />
          <Tile label="In queue" value={<AnimatedNumber value={stats.queued} />} sub="waiting / live" />
          <Tile label="Completed" value={<AnimatedNumber value={stats.completed} />} sub="dialled to end" />
          <Tile label="Connect rate" value={`${stats.connectRate}%`} sub="connected ÷ dialled" />
          <Tile label="Avg talk" value={formatDuration(stats.avgTalkSeconds)} sub="per connected call" />
          <Tile label="Follow-ups due" value={<AnimatedNumber value={stats.followUpsDue} />} sub="overdue call-backs" />
        </div>

        {/* Sentiment + outcome breakdown */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Section title="Sentiment" subtitle="Conversation tone across logged calls">
            <div className="flex flex-wrap gap-2">
              {CALL_SENTIMENTS.map((s) => {
                const stat = stats.bySentiment.find((x) => x.slug === s);
                return (
                  <span
                    key={s}
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1.5"
                  >
                    <Pill className={tonerPill(sentimentTone(s))}>
                      {callSentimentLabel(s)}
                    </Pill>
                    <span className="text-sm font-bold tabular-nums text-white">
                      {(stat?.count ?? 0).toLocaleString()}
                    </span>
                  </span>
                );
              })}
            </div>
          </Section>
          <Section title="Outcomes" subtitle="How dialled calls have landed">
            {topOutcomes.length === 0 ? (
              <p className="text-sm text-slate-500">
                No call outcomes yet — dispositions appear here as calls are logged.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {topOutcomes.map((o) => (
                  <span
                    key={o.slug}
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1.5"
                  >
                    <Pill className={tonerPill(callOutcomeTone(o.slug))}>
                      {callOutcomeLabel(o.slug)}
                    </Pill>
                    <span className="text-sm font-bold tabular-nums text-white">
                      {o.count.toLocaleString()}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </Section>
        </div>

        {/* Call queue */}
        <Section
          title="Call queue"
          subtitle="Open calls in dequeue order — highest priority, then earliest scheduled"
          action={
            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
              <ListChecks className="h-3.5 w-3.5" aria-hidden />
              {queue.length}
            </span>
          }
        >
          {queue.length === 0 ? (
            <EmptyState
              message="The call queue is empty. Calls appear here the moment the engine (or an operator) schedules one — ordered by priority automatically."
              cta={
                <Link
                  href="/admin/sales/companies"
                  className="text-xs font-medium text-indigo-400 transition-colors hover:text-indigo-300"
                >
                  Browse companies →
                </Link>
              }
            />
          ) : (
            <ul className="space-y-2">
              {queue.map((c) => (
                <CallRow key={c.id} call={c} queued />
              ))}
            </ul>
          )}
        </Section>

        {/* Recent calls + search */}
        <Section
          title="Recent calls"
          subtitle="Every logged call — recording, transcript, AI summary, sentiment and outcome"
        >
          <form method="get" className="mb-4 flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                aria-hidden
              />
              <input
                type="search"
                name="q"
                defaultValue={query}
                placeholder="Search every call — summary, transcript, notes, outcome…"
                aria-label="Search calls"
                className={`${inputCls} mt-0 pl-9`}
              />
            </div>
            <button
              type="submit"
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
            >
              Search
            </button>
            {query ? (
              <Link
                href="/admin/sales/calling"
                className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-800"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
                Clear
              </Link>
            ) : null}
          </form>

          {recent.length === 0 ? (
            <EmptyState
              message={
                query
                  ? "No calls match that search yet."
                  : "No calls logged yet. Completed calls land here with their full transcript, AI summary, sentiment and outcome."
              }
            />
          ) : (
            <ul className="space-y-2">
              {recent.map((c) => (
                <CallRow key={c.id} call={c} />
              ))}
            </ul>
          )}
        </Section>

        {/* Script library */}
        <Section
          title="Call-script library"
          subtitle="Reusable, versioned scripts for every call type — the right words for the moment"
          action={
            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
              <BookOpen className="h-3.5 w-3.5" aria-hidden />
              {scripts.length}
            </span>
          }
        >
          {scripts.length === 0 ? (
            <p className="text-sm text-slate-500">No scripts in the library yet.</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {scripts.map((s) => (
                <ScriptCard key={s.id} script={s} />
              ))}
            </div>
          )}
        </Section>

        {/* Objection playbook */}
        <Section
          title="Objection playbook"
          subtitle="When they say X, respond Y — the live reference card for the call"
          action={
            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
              <MessageSquareWarning className="h-3.5 w-3.5" aria-hidden />
              {objections.length}
            </span>
          }
        >
          {objections.length === 0 ? (
            <p className="text-sm text-slate-500">No objection plays yet.</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {objections.map((o) => (
                <ObjectionCard key={o.id} objection={o} />
              ))}
            </div>
          )}
        </Section>

        {/* Telephony connector */}
        <Section
          title="Telephony connector"
          subtitle="The provider that will place + record calls and feed this centre. Future work — wired into the schema, never faked."
          action={
            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
              <Plug className="h-3.5 w-3.5" aria-hidden />
              {telephony.length}
            </span>
          }
        >
          {telephony.length === 0 ? (
            <p className="text-sm text-slate-500">No connectors registered yet.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {telephony.map((i) => (
                <li
                  key={i.slug}
                  className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-slate-200">
                      {i.label}
                    </span>
                    <span className="text-[10px] uppercase tracking-wide text-slate-500">
                      {i.category}
                    </span>
                  </span>
                  <Pill className={integrationPill(i.status)}>{i.status}</Pill>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Row + card components (server, no client JS).
// ---------------------------------------------------------------------

function CallRow({ call, queued }: { call: SalesCallItem; queued?: boolean }) {
  const DirIcon = call.direction === "inbound" ? PhoneIncoming : PhoneOutgoing;
  const when = call.ended_at ?? call.scheduled_at ?? call.created_at;
  const blurb = call.summary?.trim() || call.objective?.trim() || "";
  return (
    <li className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 transition hover:border-slate-700">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-800 text-slate-400">
            <DirIcon className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-100">
              {call.company_name ?? "Unknown company"}
            </p>
            {blurb ? (
              <p className="mt-0.5 line-clamp-2 text-xs text-slate-400">{blurb}</p>
            ) : (
              <p className="mt-0.5 text-xs text-slate-600">No summary yet</p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <Pill className={callStatusPill(call.status)}>
            {callStatusLabel(call.status)}
          </Pill>
          {queued && isOpenCallStatus(call.status) ? (
            <Chip>{aiTaskPriorityLabel(call.priority)}</Chip>
          ) : null}
          {!queued && call.outcome !== "unknown" ? (
            <Pill className={tonerPill(callOutcomeTone(call.outcome))}>
              {callOutcomeLabel(call.outcome)}
            </Pill>
          ) : null}
          {!queued && call.sentiment !== "unknown" ? (
            <Pill className={tonerPill(sentimentTone(call.sentiment))}>
              {callSentimentLabel(call.sentiment)}
            </Pill>
          ) : null}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
        <span>{callDirectionLabel(call.direction)}</span>
        {call.duration_seconds != null && call.duration_seconds > 0 ? (
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" aria-hidden />
            {formatDuration(call.duration_seconds)}
          </span>
        ) : null}
        {call.recording_url ? (
          <span className="inline-flex items-center gap-1 text-slate-400">
            <Voicemail className="h-3 w-3" aria-hidden />
            Recording
          </span>
        ) : null}
        {when ? <span>{relativeTime(when)}</span> : null}
        {call.follow_up_at && !call.follow_up_done ? (
          <span className="inline-flex items-center gap-1 text-amber-400">
            <Clock className="h-3 w-3" aria-hidden />
            Follow-up {relativeTime(call.follow_up_at)}
          </span>
        ) : null}
      </div>
    </li>
  );
}

function ScriptCard({ script }: { script: SalesCallScript }) {
  return (
    <article className="flex flex-col rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-white">{script.name}</h3>
        <div className="flex shrink-0 items-center gap-1.5">
          <Chip>{scriptCategoryLabel(script.category)}</Chip>
          {script.status !== "active" ? (
            <Chip>{playbookStatusLabel(script.status)}</Chip>
          ) : null}
        </div>
      </div>
      {script.summary ? (
        <p className="mt-1.5 text-xs text-slate-400">{script.summary}</p>
      ) : null}
      {script.opening ? (
        <p className="mt-3 border-l-2 border-indigo-500/40 pl-3 text-xs italic text-slate-300">
          “{script.opening}”
        </p>
      ) : null}
      {script.talking_points.length > 0 ? (
        <div className="mt-3">
          <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            <Target className="h-3 w-3" aria-hidden />
            Talking points
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-slate-300">
            {script.talking_points.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {script.questions.length > 0 ? (
        <div className="mt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Questions to ask
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-slate-300">
            {script.questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-800 pt-2 text-[11px] text-slate-500">
        {script.target_persona ? <span>{script.target_persona}</span> : null}
        {script.estimated_duration_seconds ? (
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" aria-hidden />
            {formatDuration(script.estimated_duration_seconds)}
          </span>
        ) : null}
        <span className="ml-auto">v{script.version}</span>
      </div>
    </article>
  );
}

function ObjectionCard({ objection }: { objection: SalesObjection }) {
  return (
    <article className="flex flex-col rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-white">“{objection.objection}”</h3>
        <div className="flex shrink-0 items-center gap-1.5">
          <Chip>{objectionCategoryLabel(objection.category)}</Chip>
          {objection.confidence != null ? (
            <Pill className={tonerPill("positive")}>{objection.confidence}%</Pill>
          ) : null}
        </div>
      </div>
      {objection.response ? (
        <p className="mt-2 text-xs text-slate-300">{objection.response}</p>
      ) : null}
      {objection.supporting_points.length > 0 ? (
        <ul className="mt-3 list-disc space-y-0.5 pl-4 text-xs text-slate-400">
          {objection.supporting_points.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      ) : null}
      {objection.follow_up ? (
        <p className="mt-3 border-t border-slate-800 pt-2 text-[11px] text-slate-500">
          <span className="font-semibold text-slate-400">Follow-up: </span>
          {objection.follow_up}
        </p>
      ) : null}
    </article>
  );
}

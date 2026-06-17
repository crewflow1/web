import Link from "next/link";
import type { ReactNode } from "react";
import {
  Building2,
  Phone,
  Mail,
  Linkedin,
  Instagram,
  Facebook,
  StickyNote,
  CalendarClock,
  MonitorPlay,
  FileText,
  Repeat,
  Sparkles,
  Lightbulb,
  GitCommitHorizontal,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import {
  eventCategory,
  eventLabel,
  employeeBandLabel,
  formatGbp,
  relativeTime,
  scoreBand,
  scoreBandLabel,
  statusLabel,
  type FacetCount,
  type FunnelStage,
  type GrowthPoint,
  type SalesCompanyListItem,
  type SalesFeedItem,
  type SalesTimelineEvent,
} from "@/lib/sales/model";
import { eventDotClass, scorePill, statusPill } from "./_styles";

/**
 * Sales AI Platform — reusable dark-UI primitives (CEO Directive 003).
 * Server components; no client JS. Shared by the dashboard, companies
 * list, detail, analytics, and activity surfaces so styling lives once.
 */

export function Section({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-white">{title}</h2>
          {subtitle ? (
            <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>
          ) : null}
        </div>
        {action ?? null}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Tile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p
        className={`mt-1 truncate text-lg font-bold tabular-nums ${
          accent ? "text-indigo-300" : "text-white"
        }`}
      >
        {value}
      </p>
      {sub ? (
        <p className="mt-0.5 truncate text-[10px] text-slate-500">{sub}</p>
      ) : null}
    </div>
  );
}

export function Pill({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${className}`}
    >
      {children}
    </span>
  );
}

export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-300 ring-1 ring-inset ring-slate-700">
      {children}
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block text-[11px] font-medium text-slate-400">
      {label}
      {hint ? <span className="ml-1 text-slate-600">{hint}</span> : null}
      {children}
    </label>
  );
}

export function StatusPill({ status }: { status: string }) {
  return <Pill className={statusPill(status)}>{statusLabel(status)}</Pill>;
}

export function ScorePill({
  score,
  prefix,
}: {
  score: number | null;
  prefix?: string;
}) {
  const band = scoreBand(score);
  return (
    <Pill className={scorePill(band)}>
      {prefix ? `${prefix} ` : ""}
      {score == null ? scoreBandLabel(score) : `${score} · ${scoreBandLabel(score)}`}
    </Pill>
  );
}

export function Banner({
  kind,
  children,
}: {
  kind: "error" | "success";
  children: ReactNode;
}) {
  const cls =
    kind === "error"
      ? "border-red-500/30 bg-red-500/10 text-red-300"
      : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={`rounded-md border px-3 py-2 text-sm ${cls}`}
    >
      {children}
    </div>
  );
}

export function EmptyState({
  message,
  cta,
}: {
  message: string;
  cta?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 px-6 py-16 text-center">
      <p className="text-sm text-slate-400">{message}</p>
      {cta ? <div className="mt-2">{cta}</div> : null}
    </div>
  );
}

/** Compact company card used in the list, search, and dashboard. */
export function CompanyCard({ company: c }: { company: SalesCompanyListItem }) {
  return (
    <Link
      href={`/admin/sales/companies/${c.id}`}
      className="group relative flex h-full flex-col rounded-xl border border-slate-800 bg-slate-900/60 p-4 shadow-lg ring-1 ring-inset ring-white/5 transition duration-200 hover:-translate-y-0.5 hover:bg-slate-900 hover:shadow-xl"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
            <Building2 className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="truncate font-semibold leading-snug text-white">
              {c.name}
            </p>
            <p className="truncate text-xs text-slate-500">
              {c.industry ?? "Industry —"}
              {c.county ? ` · ${c.county}` : c.region ? ` · ${c.region}` : ""}
            </p>
          </div>
        </div>
        <StatusPill status={c.status} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <ScorePill score={c.ai_qualification_score} prefix="AI" />
        <Chip>{employeeBandLabel(c.employee_count)} staff</Chip>
        {c.estimated_deal_value_gbp ? (
          <Chip>{formatGbp(c.estimated_deal_value_gbp)}</Chip>
        ) : null}
      </div>

      {c.tags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {c.tags.slice(0, 4).map((t) => (
            <span
              key={t}
              className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400 ring-1 ring-inset ring-slate-700"
            >
              #{t}
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-between border-t border-slate-800 pt-3 text-[10px] font-medium uppercase tracking-wide text-slate-500">
        <span>{c.assigned_to_email ? c.assigned_to_email.split("@")[0] : "Unassigned"}</span>
        <span className="normal-case">
          {c.last_researched_at
            ? `Researched ${relativeTime(c.last_researched_at)}`
            : `Added ${relativeTime(c.created_at)}`}
        </span>
      </div>
    </Link>
  );
}

/** Horizontal funnel bars with conversion percentages. */
export function FunnelChart({ funnel }: { funnel: FunnelStage[] }) {
  const max = Math.max(1, ...funnel.map((f) => f.reached));
  return (
    <ul className="space-y-2.5">
      {funnel.map((f) => (
        <li key={f.stage}>
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-300">{f.label}</span>
            <span className="font-semibold tabular-nums text-slate-400">
              {f.reached}
              {f.conversionFromPrev != null ? (
                <span className="ml-2 text-[10px] font-normal text-slate-600">
                  {f.conversionFromPrev}% →
                </span>
              ) : null}
            </span>
          </div>
          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-indigo-600/70 to-emerald-500/70"
              style={{ width: `${(f.reached / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function FacetBars({
  facets,
  emptyLabel = "No data yet.",
}: {
  facets: FacetCount[];
  emptyLabel?: string;
}) {
  if (facets.length === 0) {
    return <p className="text-sm text-slate-500">{emptyLabel}</p>;
  }
  const max = Math.max(1, ...facets.map((f) => f.count));
  return (
    <ul className="space-y-2.5">
      {facets.map((f) => (
        <li key={f.key}>
          <div className="flex items-center justify-between text-xs">
            <span className="truncate text-slate-300">{f.label}</span>
            <span className="font-semibold tabular-nums text-slate-400">
              {f.count}
            </span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full bg-indigo-500/70"
              style={{ width: `${(f.count / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ActivityChart({ points }: { points: GrowthPoint[] }) {
  const max = Math.max(1, ...points.map((p) => p.count));
  return (
    <div>
      <div className="flex h-24 items-end gap-1">
        {points.map((p) => (
          <div
            key={p.date}
            className="group relative flex-1"
            title={`${p.date}: ${p.count}`}
          >
            <div
              className="w-full rounded-t bg-gradient-to-t from-indigo-600/40 to-indigo-400/80 transition group-hover:from-indigo-500/60 group-hover:to-indigo-300"
              style={{ height: `${Math.max(4, (p.count / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-slate-600">
        <span>{points[0]?.date.slice(5)}</span>
        <span>{points[points.length - 1]?.date.slice(5)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Timeline.
// ---------------------------------------------------------------------

const EVENT_ICONS: Record<string, LucideIcon> = {
  email: Mail,
  call: Phone,
  linkedin: Linkedin,
  instagram: Instagram,
  facebook: Facebook,
  note: StickyNote,
  meeting: CalendarClock,
  demo: MonitorPlay,
  quote: FileText,
  follow_up: Repeat,
  created: Building2,
  research: Sparkles,
  recommendation: Lightbulb,
  status_change: GitCommitHorizontal,
  system: Settings2,
};

export function EventIcon({
  type,
  className,
}: {
  type: string;
  className?: string;
}) {
  const Icon = EVENT_ICONS[type] ?? StickyNote;
  return <Icon className={className ?? "h-4 w-4"} strokeWidth={1.75} aria-hidden />;
}

export function TimelineItem({
  event,
  showCompany,
}: {
  event: SalesTimelineEvent | SalesFeedItem;
  showCompany?: boolean;
}) {
  const category = eventCategory(event.event_type);
  const companyName =
    "company_name" in event ? event.company_name : null;
  const actor =
    event.ai_employee_id != null
      ? "Sales AI"
      : event.actor_email
        ? event.actor_email.split("@")[0]
        : "System";
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      <span
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-100 ring-2 ${eventDotClass(category)}`}
      >
        <EventIcon type={event.event_type} className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-xs font-semibold text-slate-200">
            {eventLabel(event.event_type)}
          </span>
          {showCompany && companyName ? (
            <Link
              href={`/admin/sales/companies/${event.company_id}`}
              className="text-xs font-medium text-indigo-400 hover:text-indigo-300"
            >
              {companyName}
            </Link>
          ) : null}
          <span className="text-[10px] text-slate-600">
            {actor} · {relativeTime(event.occurred_at)}
          </span>
        </div>
        {event.subject ? (
          <p className="mt-0.5 text-sm text-slate-300">{event.subject}</p>
        ) : null}
        {event.body ? (
          <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-slate-400">
            {event.body}
          </p>
        ) : null}
        {event.outcome ? (
          <span className="mt-1 inline-flex rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400 ring-1 ring-inset ring-slate-700">
            {event.outcome}
          </span>
        ) : null}
      </div>
    </li>
  );
}

/** Key/value row used on the company intelligence panel. */
export function KV({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-800/70 py-2 last:border-0">
      <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <span className="min-w-0 break-words text-right text-sm text-slate-200">
        {children}
      </span>
    </div>
  );
}

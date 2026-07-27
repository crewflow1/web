import Link from "next/link";
import type { ReactNode } from "react";
import { Pin } from "lucide-react";
import {
  departmentLabel,
  importanceLabel,
  memoryStatusLabel,
  relativeTime,
  visibilityLabel,
  type MemoryListItem,
  type MemoryType,
} from "@/lib/memory/model";
import { MemoryTypeIcon } from "./_icon";
import {
  accentClasses,
  importancePill,
  statusPill,
  visibilityPill,
} from "./_styles";

/**
 * Shared Memory Engine — reusable dark-UI primitives (CEO Directive 002).
 * Server components; no client JS. Used by the dashboard, search, detail,
 * and form surfaces so styling lives in one place.
 */

export type TypeMap = Record<string, MemoryType>;

export function buildTypeMap(types: MemoryType[]): TypeMap {
  return Object.fromEntries(types.map((t) => [t.slug, t]));
}

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
        className={`mt-1 truncate text-sm font-bold ${
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

export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-300 ring-1 ring-inset ring-slate-700">
      {children}
    </span>
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

export function MemoryTypeBadge({
  type,
  slug,
}: {
  type?: MemoryType;
  slug: string;
}) {
  const accent = accentClasses(type?.accent ?? "slate");
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium ${accent.icon}`}
    >
      <MemoryTypeIcon icon={type?.icon ?? "brain"} className="h-3.5 w-3.5" />
      {type?.label ?? slug}
    </span>
  );
}

/** Compact memory card used in search results + dashboard lists. */
export function MemoryCard({
  memory: m,
  typeMap,
}: {
  memory: MemoryListItem;
  typeMap: TypeMap;
}) {
  const type = typeMap[m.memory_type];
  const accent = accentClasses(type?.accent ?? "slate");
  return (
    <Link
      href={`/admin/memory/${m.id}`}
      className={`group relative flex h-full flex-col rounded-xl border border-slate-800 bg-slate-900/60 p-4 shadow-lg ring-1 ring-inset ring-white/5 transition duration-200 hover:-translate-y-0.5 hover:bg-slate-900 hover:shadow-xl ${accent.ring} ${accent.glow}`}
    >
      <div className="flex items-start justify-between gap-3">
        <MemoryTypeBadge type={type} slug={m.memory_type} />
        <div className="flex shrink-0 items-center gap-1.5">
          {m.pinned ? (
            <Pin
              className="h-3.5 w-3.5 text-amber-300"
              strokeWidth={2}
              aria-label="Pinned"
            />
          ) : null}
          <Pill className={importancePill(m.importance)}>
            {importanceLabel(m.importance)}
          </Pill>
        </div>
      </div>

      <p className="mt-3 font-semibold leading-snug text-white">{m.title}</p>
      {m.summary ? (
        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-400">
          {m.summary}
        </p>
      ) : null}

      {m.tags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {m.tags.slice(0, 4).map((t) => (
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
        <span className="inline-flex items-center gap-1.5">
          {m.department ? departmentLabel(m.department) : "All HQ"}
          <span className="text-slate-700">·</span>
          <span className="normal-case">{memoryStatusLabel(m.status)}</span>
        </span>
        <span className="normal-case text-slate-500">
          {relativeTime(m.created_at)}
        </span>
      </div>
    </Link>
  );
}

export function VisibilityPill({ visibility }: { visibility: string }) {
  return (
    <Pill className={visibilityPill(visibility)}>
      {visibilityLabel(visibility)}
    </Pill>
  );
}

export function StatusPill({ status }: { status: string }) {
  return <Pill className={statusPill(status)}>{memoryStatusLabel(status)}</Pill>;
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

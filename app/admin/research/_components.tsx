import Link from "next/link";
import type { ResearchProvenance } from "@/lib/research/model";
import type { ResearchScoreFactor } from "@/lib/research/score";
import {
  FACTOR_BAR,
  FACTOR_TONE,
  PROVENANCE_LABEL,
  PROVENANCE_PILL,
  scoreRing,
  scoreTone,
} from "./_styles";

/**
 * Research AI — shared, pure presentational components (CEO Directive 005).
 *
 * No "use client", no server-only imports: safe to render from the server
 * pages AND the client live view. Every figure shown here is one the runner
 * actually produced — unknowns render as honest "—", never invented.
 */

export function Tile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-3.5 ${
        accent
          ? "border-indigo-500/30 bg-indigo-500/10"
          : "border-slate-800 bg-slate-900/60"
      }`}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold tracking-tight text-white">{value}</p>
      {sub ? <p className="mt-0.5 text-[11px] text-slate-500">{sub}</p> : null}
    </div>
  );
}

export function ProvenanceBadge({
  provenance,
}: {
  provenance: ResearchProvenance | null;
}) {
  if (!provenance) return null;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${PROVENANCE_PILL[provenance]}`}
    >
      {PROVENANCE_LABEL[provenance]}
    </span>
  );
}

/** A large, calm score read-out with its confidence — or an honest "unknown". */
export function ScoreDial({
  score,
  band,
  confidence,
}: {
  score: number | null;
  band: string | null;
  confidence?: number | null;
}) {
  return (
    <div
      className={`flex items-center gap-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-5 ring-1 ring-inset ${scoreRing(
        score,
      )}`}
    >
      <div className="flex h-20 w-20 shrink-0 flex-col items-center justify-center rounded-full bg-slate-950 ring-1 ring-inset ring-slate-800">
        <span className={`text-2xl font-bold leading-none ${scoreTone(score)}`}>
          {score == null ? "—" : score}
        </span>
        <span className="mt-0.5 text-[9px] uppercase tracking-wide text-slate-500">
          /100
        </span>
      </div>
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Company score
        </p>
        <p className={`text-lg font-semibold ${scoreTone(score)}`}>
          {band ?? "Unscored"}
        </p>
        {typeof confidence === "number" ? (
          <p className="mt-0.5 text-[11px] text-slate-500">
            {confidence}% confidence · scored on known factors only
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** One transparent score factor — the "no black box" requirement made visible. */
export function FactorRow({ factor }: { factor: ResearchScoreFactor }) {
  const tone = factor.known ? FACTOR_TONE[factor.tone] : FACTOR_TONE.unknown;
  const bar = factor.known ? FACTOR_BAR[factor.tone] : FACTOR_BAR.unknown;
  return (
    <div className="py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium text-slate-200">{factor.label}</p>
        <p className={`text-xs font-semibold ${tone}`}>
          {factor.known ? `${Math.round(factor.value)}/100` : "Unknown"}
        </p>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div
          className={`h-full rounded-full ${bar}`}
          style={{ width: `${factor.known ? Math.max(3, Math.round(factor.value)) : 0}%` }}
        />
      </div>
      {factor.detail ? (
        <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{factor.detail}</p>
      ) : null}
    </div>
  );
}

/** A titled dark card section. */
export function Panel({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p> : null}
        </div>
        {action ?? null}
      </div>
      {children}
    </section>
  );
}

/** A simple labelled chip list for services / pain points / signals. */
export function ChipList({
  items,
  tone = "slate",
  empty = "—",
}: {
  items: string[];
  tone?: "slate" | "emerald" | "amber" | "indigo";
  empty?: string;
}) {
  if (!items.length) return <p className="text-xs text-slate-500">{empty}</p>;
  const toneClass =
    tone === "emerald"
      ? "bg-emerald-500/10 text-emerald-300 ring-emerald-400/20"
      : tone === "amber"
        ? "bg-amber-500/10 text-amber-300 ring-amber-400/20"
        : tone === "indigo"
          ? "bg-indigo-500/10 text-indigo-300 ring-indigo-400/20"
          : "bg-slate-800/80 text-slate-300 ring-slate-700";
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((it, i) => (
        <li
          key={`${it}-${i}`}
          className={`rounded-full px-2.5 py-1 text-xs ring-1 ring-inset ${toneClass}`}
        >
          {it}
        </li>
      ))}
    </ul>
  );
}

/** A key/value definition row that hides itself when the value is unknown. */
export function Fact({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-slate-800/70 py-2 last:border-0">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-right text-sm font-medium text-slate-200">{value}</dd>
    </div>
  );
}

export function BackToResearch() {
  return (
    <Link
      href="/admin/research"
      className="text-xs font-medium text-indigo-400 transition hover:text-indigo-300"
    >
      ← Research AI
    </Link>
  );
}

import Link from "next/link";
import type { ResearchProvenance } from "@/lib/research/model";
import type { ResearchScoreFactor } from "@/lib/research/score";
import { ChipList as UIChipList } from "@/components/ui";
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
 *
 * The generic surfaces (Panel, Fact, chip styling) now come from the shared
 * design system (CEO Directive 006) so Research reuses the exact same atoms as
 * the rest of HQ — one source of truth, no duplicated class strings.
 */
export { Panel, Fact } from "@/components/ui";

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

/**
 * A labelled chip list for services / pain points / signals. Thin adapter over
 * the shared <ChipList> — keeps Research's `tone` prop while the styling itself
 * lives once in the design system.
 */
export function ChipList({
  items,
  tone = "slate",
  empty = "—",
}: {
  items: string[];
  tone?: "slate" | "emerald" | "amber" | "indigo";
  empty?: string;
}) {
  return <UIChipList items={items} accent={tone} empty={empty} />;
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

import Link from "next/link";
import {
  decisionLabel,
  type QualificationCriterion,
  type QualificationDecision,
} from "@/lib/qualification/model";
import {
  CRITERION_BAR,
  CRITERION_TONE,
  DECISION_DOT,
  DECISION_NUMBER_TONE,
  DECISION_PILL,
  DECISION_RING,
} from "./_styles";

/**
 * Lead Qualification AI — shared, pure presentational components (CEO Directive
 * 003, Module 3). Mirrors app/admin/research/_components.tsx.
 *
 * No "use client", no server-only imports: safe to render from the server pages
 * AND the client live view. Every figure shown here is one the deterministic
 * rubric actually produced — an unevidenced criterion renders as an honest
 * "Unknown", never invented or silently scored as zero.
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

/** The verdict pill — qualified | disqualified | needs review. */
export function DecisionBadge({
  decision,
  size = "md",
}: {
  decision: QualificationDecision;
  size?: "sm" | "md";
}) {
  const pad = size === "sm" ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-xs";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-semibold ${pad} ${DECISION_PILL[decision]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DECISION_DOT[decision]}`} aria-hidden />
      {decisionLabel(decision)}
    </span>
  );
}

/**
 * The headline verdict read-out: the call, the fit score it was made on, and
 * the confidence — or an honest "Needs review" when the engine held the lead.
 */
export function VerdictDial({
  decision,
  score,
  tierLabel,
  confidence,
}: {
  decision: QualificationDecision;
  score: number | null;
  tierLabel: string;
  confidence: number;
}) {
  return (
    <div
      className={`flex items-center gap-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-5 ring-1 ring-inset ${DECISION_RING[decision]}`}
    >
      <div className="flex h-20 w-20 shrink-0 flex-col items-center justify-center rounded-full bg-slate-950 ring-1 ring-inset ring-slate-800">
        <span className={`text-2xl font-bold leading-none ${DECISION_NUMBER_TONE[decision]}`}>
          {score == null ? "—" : score}
        </span>
        <span className="mt-0.5 text-[9px] uppercase tracking-wide text-slate-500">
          fit /100
        </span>
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Verdict
        </p>
        <div className="mt-0.5">
          <DecisionBadge decision={decision} />
        </div>
        <p className="mt-1 text-[11px] text-slate-500">
          {tierLabel} fit · {confidence}% confidence on evidenced criteria
        </p>
      </div>
    </div>
  );
}

/**
 * One weighted criterion — the "no black box" requirement made visible. An
 * unevidenced criterion is shown but marked Unknown and visually muted, so the
 * operator sees the gap rather than a fabricated score.
 */
export function CriterionRow({ criterion }: { criterion: QualificationCriterion }) {
  const tone = criterion.known ? CRITERION_TONE[criterion.tone] : CRITERION_TONE.unknown;
  const bar = criterion.known ? CRITERION_BAR[criterion.tone] : CRITERION_BAR.unknown;
  const weightPct = Math.round(criterion.weight * 100);
  return (
    <div className="py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium text-slate-200">
          {criterion.label}
          <span className="ml-1.5 text-[11px] font-normal text-slate-600">
            ·{weightPct}% weight
          </span>
        </p>
        <p className={`flex items-center gap-1.5 text-xs font-semibold ${tone}`}>
          {criterion.known ? `${Math.round(criterion.value)}/100` : "Unknown"}
          {criterion.passed === true ? (
            <span className="text-emerald-400" aria-label="pass">✓</span>
          ) : criterion.passed === false ? (
            <span className="text-amber-400" aria-label="not met">✕</span>
          ) : null}
        </p>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div
          className={`h-full rounded-full ${bar}`}
          style={{
            width: `${criterion.known ? Math.max(3, Math.round(criterion.value)) : 0}%`,
          }}
        />
      </div>
      {criterion.detail ? (
        <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{criterion.detail}</p>
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

export function BackToQualification() {
  return (
    <Link
      href="/admin/qualification"
      className="text-xs font-medium text-indigo-400 transition hover:text-indigo-300"
    >
      ← Lead Qualification AI
    </Link>
  );
}

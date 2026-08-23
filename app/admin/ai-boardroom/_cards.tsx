import {
  GaugeCircle,
  CalendarClock,
  HeartPulse,
  GitBranch,
  SlidersHorizontal,
} from "lucide-react";
import {
  PIPELINE_STAGES,
  PIPELINE_STAGE_LABELS,
  type EmployeeCards,
  type ConfidenceCard,
  type EtaCard,
  type HealthCard,
  type PipelineSummary,
} from "@/lib/hq/boardroom-cards";
import {
  AI_APPROVAL_LEVELS,
  type ApprovalLevelResult,
} from "@/lib/ai-employees/approval-levels";
import { approvalLevelStyle } from "./_styles";

/**
 * AI Boardroom — the Confidence / ETA / Health cards (the mandated card gap).
 *
 * Presentation only, over the DETERMINISTIC read-model in lib/hq/boardroom-cards.
 * Every card is HONEST: an "Insufficient data" state renders in a neutral slate tone,
 * never a green that absent data cannot support. The product pipeline stage is surfaced
 * where present.
 *
 * Product UX rebuild (HQ phase): re-skinned from the old dark/neon surface onto
 * the light operational system — solid `-100`/`-800` pills (AA-verified in
 * components/ui/tokens.ts), never the blended `text-*-300` opacity fills.
 */

// ---------------------------------------------------------------------
// Tone maps — one place, so a level always paints the same way.
// ---------------------------------------------------------------------

const NEUTRAL = "bg-slate-100 text-slate-700 ring-slate-200";

const CONFIDENCE_TONE: Record<ConfidenceCard["level"], string> = {
  high: "bg-emerald-100 text-emerald-800 ring-emerald-200",
  medium: "bg-amber-100 text-amber-800 ring-amber-200",
  low: "bg-red-100 text-red-800 ring-red-200",
  insufficient: NEUTRAL,
};

const ETA_TONE: Record<EtaCard["level"], string> = {
  scheduled: "bg-blue-100 text-blue-800 ring-blue-200",
  overdue: "bg-red-100 text-red-800 ring-red-200",
  insufficient: NEUTRAL,
};

const HEALTH_TONE: Record<HealthCard["level"], string> = {
  green: "bg-emerald-100 text-emerald-800 ring-emerald-200",
  amber: "bg-amber-100 text-amber-800 ring-amber-200",
  red: "bg-red-100 text-red-800 ring-red-200",
  insufficient: NEUTRAL,
};

const CONFIDENCE_LABEL: Record<ConfidenceCard["level"], string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  insufficient: "Insufficient data",
};

const HEALTH_LABEL: Record<HealthCard["level"], string> = {
  green: "Healthy",
  amber: "Watch",
  red: "At risk",
  insufficient: "Insufficient data",
};

// ---------------------------------------------------------------------
// Value formatting.
// ---------------------------------------------------------------------

function confidenceValue(c: ConfidenceCard): string {
  if (c.level === "insufficient" || c.pct === null) return "—";
  return `${c.pct}%`;
}

/** A compact, deterministic ETA label from an ISO deadline and the injected `now`. */
export function formatEtaLabel(at: string | null, now: Date): string {
  if (!at) return "—";
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return "—";
  const diff = ms - now.getTime();
  const past = diff < 0;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  let rel: string;
  if (mins < 60) rel = `${mins}m`;
  else if (mins < 60 * 24) rel = `${Math.round(mins / 60)}h`;
  else rel = `${Math.round(mins / (60 * 24))}d`;
  return past ? `${rel} overdue` : `in ${rel}`;
}

// ---------------------------------------------------------------------
// The compact trio (roster card).
// ---------------------------------------------------------------------

function CompactCard({
  label,
  value,
  tone,
  Icon,
}: {
  label: string;
  value: string;
  tone: string;
  Icon: typeof GaugeCircle;
}) {
  return (
    <div className={`rounded-lg px-2 py-1.5 ring-1 ring-inset ${tone}`}>
      <p className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide opacity-80">
        <Icon className="h-3 w-3" strokeWidth={2} aria-hidden />
        {label}
      </p>
      <p className="mt-0.5 truncate text-xs font-bold tabular-nums">{value}</p>
    </div>
  );
}

/** The three cards, compact, for a roster tile. `now` drives the ETA label. */
export function BoardroomCardTrio({ cards, now }: { cards: EmployeeCards; now: Date }) {
  const { confidence, eta, health } = cards;
  return (
    <div className="grid grid-cols-3 gap-2">
      <CompactCard
        label="Confidence"
        value={confidenceValue(confidence)}
        tone={CONFIDENCE_TONE[confidence.level]}
        Icon={GaugeCircle}
      />
      <CompactCard
        label="ETA"
        value={eta.level === "insufficient" ? "—" : formatEtaLabel(eta.at, now)}
        tone={ETA_TONE[eta.level]}
        Icon={CalendarClock}
      />
      <CompactCard
        label="Health"
        value={HEALTH_LABEL[health.level]}
        tone={HEALTH_TONE[health.level]}
        Icon={HeartPulse}
      />
    </div>
  );
}

/** A single pipeline stage chip (the furthest-along active stage), or nothing. */
export function PipelineStagePill({ pipeline }: { pipeline: PipelineSummary }) {
  if (!pipeline.current) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-800 ring-1 ring-inset ring-indigo-200">
      <GitBranch className="h-3 w-3" strokeWidth={2} aria-hidden />
      {PIPELINE_STAGE_LABELS[pipeline.current]}
      {pipeline.staged > 1 ? (
        <span className="text-indigo-500">+{pipeline.staged - 1}</span>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------
// The full panel (detail page).
// ---------------------------------------------------------------------

function DetailCard({
  label,
  value,
  tone,
  Icon,
  sub,
  reasons,
}: {
  label: string;
  value: string;
  tone: string;
  Icon: typeof GaugeCircle;
  sub?: string;
  reasons?: string[];
}) {
  return (
    <div className={`rounded-xl p-4 ring-1 ring-inset ${tone}`}>
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide opacity-80">
        <Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
        {label}
      </p>
      <p className="mt-2 text-2xl font-bold tabular-nums">{value}</p>
      {sub ? <p className="mt-0.5 text-[11px] opacity-80">{sub}</p> : null}
      {reasons && reasons.length > 0 ? (
        <ul className="mt-2 space-y-0.5 border-t border-current/10 pt-2 text-[11px] opacity-80">
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The three cards, full size, for the employee detail page. */
export function BoardroomCardPanel({ cards, now }: { cards: EmployeeCards; now: Date }) {
  const { confidence, eta, health } = cards;
  const confSub =
    confidence.level === "insufficient"
      ? "No verified or finished tasks yet."
      : `${confidence.passed} passed · ${confidence.failed} failed`;
  const etaSub =
    eta.level === "insufficient"
      ? "No active task carries a deadline."
      : `${eta.activeWithDeadline} active with a deadline`;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <DetailCard
        label="Confidence"
        value={CONFIDENCE_LABEL[confidence.level]}
        sub={confidence.pct === null ? confSub : `${confidenceValue(confidence)} · ${confSub}`}
        tone={CONFIDENCE_TONE[confidence.level]}
        Icon={GaugeCircle}
      />
      <DetailCard
        label="ETA"
        value={eta.level === "insufficient" ? "—" : formatEtaLabel(eta.at, now)}
        sub={etaSub}
        tone={ETA_TONE[eta.level]}
        Icon={CalendarClock}
      />
      <DetailCard
        label="Health"
        value={HEALTH_LABEL[health.level]}
        tone={HEALTH_TONE[health.level]}
        Icon={HeartPulse}
        reasons={health.reasons}
      />
    </div>
  );
}

/** The full pipeline stage strip for the detail page — the eleven stages, counts shown. */
export function PipelineStageStrip({ pipeline }: { pipeline: PipelineSummary }) {
  if (pipeline.staged === 0) {
    return (
      <p className="text-sm text-slate-500">
        No active task is on the product pipeline yet.
      </p>
    );
  }
  return (
    <ol className="flex flex-wrap gap-1.5">
      {PIPELINE_STAGES.map((stage) => {
        const count = pipeline.counts[stage] ?? 0;
        const isCurrent = pipeline.current === stage;
        const active = count > 0;
        return (
          <li
            key={stage}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium ring-1 ring-inset ${
              isCurrent
                ? "bg-indigo-100 text-indigo-800 ring-indigo-300"
                : active
                  ? "bg-slate-100 text-slate-700 ring-slate-200"
                  : "bg-white text-slate-400 ring-slate-200"
            }`}
          >
            {PIPELINE_STAGE_LABELS[stage]}
            {active ? <span className="tabular-nums opacity-80">· {count}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------
// Approval-level ladder — badge (roster card + header) and panel (detail).
// Presentation only, over the DETERMINISTIC derivation in
// lib/ai-employees/approval-levels. The level classifies the CURRENT posture;
// it grants nothing.
// ---------------------------------------------------------------------

/** A compact "Ln · Label" pill — the per-employee approval rung on the roster and header. */
export function ApprovalLevelBadge({
  result,
  className = "",
}: {
  result: ApprovalLevelResult;
  className?: string;
}) {
  const style = approvalLevelStyle(result.key);
  return (
    <span
      title={result.summary}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${style.pill} ${className}`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden />
      L{result.level} · {result.label}
    </span>
  );
}

/**
 * The full approval-level panel for the detail page — the derived rung, its summary and the
 * platform mechanism that realises it, the deterministic evidence that produced it, and the whole
 * 1–5 ladder with the current rung highlighted. Read-only: the ladder is a classification of the
 * served posture, so there is no control here.
 */
export function ApprovalLevelPanel({ result }: { result: ApprovalLevelResult }) {
  const style = approvalLevelStyle(result.key);
  return (
    <div className="space-y-4">
      <div className={`rounded-xl p-4 ring-1 ring-inset ${style.pill}`}>
        <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide opacity-80">
          <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          Approval level
        </p>
        <p className="mt-2 text-2xl font-bold">
          Level {result.level} · {result.label}
        </p>
        <p className="mt-0.5 text-[13px] opacity-90">{result.summary}</p>
        <p className="mt-2 border-t border-current/10 pt-2 text-[11px] opacity-80">
          {result.mechanism}
        </p>
      </div>

      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Why this level
        </p>
        <ul className="space-y-1 text-xs text-slate-600">
          {result.evidence.map((line) => (
            <li key={line} className="flex gap-2">
              <span className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-slate-400" aria-hidden />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          The ladder
        </p>
        <ol className="space-y-1.5">
          {AI_APPROVAL_LEVELS.map((def) => {
            const active = def.level === result.level;
            const rung = approvalLevelStyle(def.key);
            return (
              <li
                key={def.key}
                className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 ${
                  active
                    ? "border-slate-300 bg-slate-50"
                    : "border-slate-200 bg-white"
                }`}
              >
                <span
                  className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                    active ? rung.pill : "bg-slate-100 text-slate-500 ring-1 ring-inset ring-slate-200"
                  }`}
                >
                  {def.level}
                </span>
                <div className="min-w-0">
                  <p className={`text-xs font-semibold ${active ? "text-slate-900" : "text-slate-600"}`}>
                    {def.label}
                  </p>
                  <p className="text-[11px] leading-relaxed text-slate-500">{def.summary}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

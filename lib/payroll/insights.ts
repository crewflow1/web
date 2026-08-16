/**
 * Payroll "AI" — a DETERMINISTIC, explainable insight layer over payroll runs.
 *
 * There is NO language model here, and there must not be one. This respects the
 * house no-fake-AI doctrine: every insight is a pure function of the numbers, and
 * every insight carries the exact figures that produced it (`reasoning`) so an
 * owner can check the arithmetic themselves. Same inputs ⇒ same output, always.
 *
 * WHAT IT DOES
 * ------------
 * Given the current run's lines and a short window of PRIOR runs for the same org,
 * it produces:
 *   - a plain-language run SUMMARY (headcount, hours, gross/net, biggest line);
 *   - ANOMALY findings the owner should eyeball before finalising:
 *       · hours_outlier   — someone's hours are far from their usual;
 *       · gross_jump      — someone's gross moved sharply vs their last run;
 *       · missing_timesheet — a regular is absent / on zero this run;
 *       · new_starter     — first run for this person (context, not a problem);
 *       · zero_hours      — a line exists but with no hours.
 *
 * Everything is an ESTIMATE / a prompt to check — never an assertion of error. It
 * reads only figures already computed elsewhere; it does not itself compute pay.
 *
 * PURE: no Supabase, no clock, no I/O. The page supplies the rows.
 */

// --- Tunable thresholds (exported so tests pin them and the UI can cite them) ---

/** Prior runs needed before "usual" comparisons (outlier/gross-jump) are attempted. */
export const MIN_HISTORY_RUNS = 2;
/** Hours must differ from the usual by at least this FRACTION to flag an outlier. */
export const HOURS_OUTLIER_PCT = 0.4;
/** ...AND by at least this many hours, so tiny timesheets don't spam warnings. */
export const HOURS_OUTLIER_MIN_ABS = 8;
/** Gross must move by at least this FRACTION vs the last run to flag a jump. */
export const GROSS_JUMP_PCT = 0.5;
/** ...AND by at least this many pounds, so trivial pay wobbles don't flag. */
export const GROSS_JUMP_MIN_ABS = 100;
/**
 * A person counts as a "regular" (so their absence flags a missing timesheet) once
 * they have appeared with hours in at least this many of the recent prior runs.
 */
export const REGULAR_MIN_PRIOR_APPEARANCES = 2;

export type PayrollInsightSeverity = "info" | "warning";

export type PayrollInsightCode =
  | "run_summary"
  | "insufficient_history"
  | "hours_outlier"
  | "gross_jump"
  | "missing_timesheet"
  | "new_starter"
  | "zero_hours";

export type PayrollInsight = {
  code: PayrollInsightCode;
  severity: PayrollInsightSeverity;
  /** Short headline. */
  title: string;
  /** One human sentence describing the finding. */
  detail: string;
  /** The exact numbers behind the finding — the "show your working" line. */
  reasoning: string;
  /** The employee the finding is about, when applicable. */
  user_id?: string;
  /** Display name/label for that employee, when known. */
  subject?: string;
};

/** One line from a prior run, as needed for history. */
export type HistoricalLine = { user_id: string; hours: number; gross_pay: number };
/** A prior run reduced to its lines, plus its period start for ordering. */
export type HistoricalRun = {
  run_id: string;
  period_start: string;
  lines: HistoricalLine[];
};
/** One line from the current run. */
export type CurrentLine = {
  user_id: string;
  subject?: string | null;
  hours: number;
  gross_pay: number;
};

export type PayrollInsightsResult = {
  /** Always present — the deterministic run narration. */
  summary: PayrollInsight;
  /** Anomaly findings, most severe first. May be empty. */
  insights: PayrollInsight[];
  /** True once there are ≥ MIN_HISTORY_RUNS prior runs to compare against. */
  hasSufficientHistory: boolean;
};

// --- pure helpers ---

function num(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Median of a numeric list. Empty ⇒ 0. Pure, no mutation of the input. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});
const money = (n: number) => GBP.format(Math.round(n * 100) / 100);
const hrs = (n: number) => `${(Math.round(n * 100) / 100).toFixed(2)}h`;

/**
 * Deterministic run narration. Pure over the reduced totals — no history needed, so
 * it is always available (even on a first-ever run).
 */
export function summarisePayrollRun(input: {
  cycle: string;
  period_start: string;
  period_end: string;
  lines: CurrentLine[];
}): PayrollInsight {
  const { lines } = input;
  const headcount = lines.length;
  const totalHours = lines.reduce((a, l) => a + num(l.hours), 0);
  const totalGross = lines.reduce((a, l) => a + num(l.gross_pay), 0);
  const largest = lines.reduce<CurrentLine | null>(
    (best, l) => (best === null || num(l.gross_pay) > num(best.gross_pay) ? l : best),
    null,
  );
  const nameFor = (l: CurrentLine) => l.subject ?? l.user_id.slice(0, 8);

  const parts: string[] = [];
  if (headcount === 0) {
    parts.push("No staff had hours logged in this period.");
  } else {
    parts.push(
      `${headcount} ${headcount === 1 ? "person" : "people"} on this ${input.cycle} run, ` +
        `${hrs(totalHours)} logged for ${money(totalGross)} gross.`,
    );
    if (largest) {
      parts.push(
        `Largest line: ${nameFor(largest)} at ${money(num(largest.gross_pay))}.`,
      );
    }
  }

  return {
    code: "run_summary",
    severity: "info",
    title: "Run summary",
    detail: parts.join(" "),
    reasoning:
      `${headcount} line(s); hours ${hrs(totalHours)}; gross ${money(totalGross)}; ` +
      `period ${input.period_start} → ${input.period_end}.`,
  };
}

const SEVERITY_ORDER: Record<PayrollInsightSeverity, number> = {
  warning: 0,
  info: 1,
};
const CODE_ORDER: Record<PayrollInsightCode, number> = {
  run_summary: 0,
  missing_timesheet: 1,
  hours_outlier: 2,
  gross_jump: 3,
  zero_hours: 4,
  new_starter: 5,
  insufficient_history: 6,
};

/**
 * Detect anomalies in the current run against a window of prior runs.
 *
 * Deterministic and self-explaining: each finding names the figures that triggered
 * it. History is used only where it exists — the zero-hours and new-starter checks
 * need none, so they fire even on a first run.
 *
 * Ordering is stable: warnings before info, then by check, then by employee id.
 */
export function detectPayrollAnomalies(
  current: CurrentLine[],
  history: HistoricalRun[],
): PayrollInsight[] {
  // Order history oldest→newest so "most recent prior" is unambiguous.
  const runs = [...history].sort((a, b) =>
    a.period_start < b.period_start ? -1 : a.period_start > b.period_start ? 1 : 0,
  );

  // Per-user history: every prior hours reading, plus the most-recent prior gross,
  // plus a count of runs the person appeared in with hours (for "regular").
  const histHours = new Map<string, number[]>();
  const lastGross = new Map<string, number>();
  const appearances = new Map<string, number>();
  for (const r of runs) {
    for (const l of r.lines) {
      const h = num(l.hours);
      const arr = histHours.get(l.user_id) ?? [];
      arr.push(h);
      histHours.set(l.user_id, arr);
      lastGross.set(l.user_id, num(l.gross_pay)); // runs are oldest→newest ⇒ ends on most recent
      if (h > 0) appearances.set(l.user_id, (appearances.get(l.user_id) ?? 0) + 1);
    }
  }

  const nameFor = (l: CurrentLine) => l.subject ?? l.user_id.slice(0, 8);
  const out: PayrollInsight[] = [];
  const currentUserIds = new Set(current.map((l) => l.user_id));

  for (const l of current) {
    const h = num(l.hours);
    const priorHours = histHours.get(l.user_id) ?? [];
    const name = nameFor(l);

    // Zero-hours line — needs no history.
    if (h <= 0) {
      out.push({
        code: "zero_hours",
        severity: "warning",
        title: "Zero-hours line",
        detail: `${name} has a line on this run but no hours.`,
        reasoning: `Hours this run = ${hrs(h)}, gross = ${money(num(l.gross_pay))}.`,
        user_id: l.user_id,
        subject: name,
      });
      continue; // outlier/jump comparisons are meaningless on a zero line
    }

    // First appearance — context, not a defect.
    if (priorHours.length === 0) {
      out.push({
        code: "new_starter",
        severity: "info",
        title: "First run for this person",
        detail: `${name} appears on payroll for the first time in this window.`,
        reasoning: `No prior runs found for this employee in the last ${runs.length} run(s).`,
        user_id: l.user_id,
        subject: name,
      });
      continue;
    }

    // Hours outlier vs the person's usual (median of prior hours).
    if (priorHours.length >= MIN_HISTORY_RUNS) {
      const usual = median(priorHours);
      const dev = Math.abs(h - usual);
      if (usual > 0 && dev >= HOURS_OUTLIER_MIN_ABS && dev / usual >= HOURS_OUTLIER_PCT) {
        const dir = h > usual ? "above" : "below";
        out.push({
          code: "hours_outlier",
          severity: "warning",
          title: "Unusual hours",
          detail: `${name}'s ${hrs(h)} is well ${dir} their usual ${hrs(usual)}.`,
          reasoning:
            `Usual (median of ${priorHours.length} prior runs) = ${hrs(usual)}; ` +
            `this run = ${hrs(h)}; deviation ${hrs(dev)} = ` +
            `${Math.round((dev / usual) * 100)}% (flags at ${Math.round(HOURS_OUTLIER_PCT * 100)}% ` +
            `and ${HOURS_OUTLIER_MIN_ABS}h).`,
          user_id: l.user_id,
          subject: name,
        });
      }
    }

    // Gross jump vs the most recent prior run.
    const prevGross = lastGross.get(l.user_id);
    if (prevGross !== undefined && prevGross > 0) {
      const g = num(l.gross_pay);
      const dev = Math.abs(g - prevGross);
      if (dev >= GROSS_JUMP_MIN_ABS && dev / prevGross >= GROSS_JUMP_PCT) {
        const dir = g > prevGross ? "up" : "down";
        out.push({
          code: "gross_jump",
          severity: "warning",
          title: "Gross pay jump",
          detail: `${name}'s gross is ${dir} sharply on their last run.`,
          reasoning:
            `Last run ${money(prevGross)} → this run ${money(g)} ` +
            `(${dir} ${money(dev)}, ${Math.round((dev / prevGross) * 100)}%; ` +
            `flags at ${Math.round(GROSS_JUMP_PCT * 100)}% and ${money(GROSS_JUMP_MIN_ABS)}).`,
          user_id: l.user_id,
          subject: name,
        });
      }
    }
  }

  // Missing timesheet — a regular who is absent from (or zero on) this run.
  for (const [userId, count] of appearances) {
    if (count < REGULAR_MIN_PRIOR_APPEARANCES) continue;
    const onThisRun = currentUserIds.has(userId);
    const line = current.find((l) => l.user_id === userId);
    const hasHours = line ? num(line.hours) > 0 : false;
    if (onThisRun && hasHours) continue; // present and paid — fine
    const usual = median(histHours.get(userId) ?? []);
    out.push({
      code: "missing_timesheet",
      severity: "warning",
      title: "Regular is missing",
      detail: onThisRun
        ? `${line?.subject ?? userId.slice(0, 8)} is on this run but with no hours.`
        : `${userId.slice(0, 8)} usually appears but is absent from this run.`,
      reasoning:
        `Appeared with hours in ${count} of the last ${runs.length} run(s) ` +
        `(usual ${hrs(usual)}); this run ${onThisRun ? hrs(0) : "absent"}. ` +
        `Check for an unclocked or missing timesheet.`,
      user_id: userId,
      subject: line?.subject ?? undefined,
    });
  }

  // Stable, deterministic ordering.
  out.sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) return s;
    const c = CODE_ORDER[a.code] - CODE_ORDER[b.code];
    if (c !== 0) return c;
    return (a.user_id ?? "") < (b.user_id ?? "")
      ? -1
      : (a.user_id ?? "") > (b.user_id ?? "")
        ? 1
        : 0;
  });
  return out;
}

/**
 * Top-level builder the page calls: run summary + anomalies + a clear
 * insufficient-history signal.
 *
 * When there are fewer than MIN_HISTORY_RUNS prior runs, the "usual"-based checks
 * (hours outlier, gross jump, missing timesheet) cannot be trusted, so we still
 * return the summary and the history-free checks (zero-hours, new-starter) and add
 * one explicit `insufficient_history` note rather than silently under-reporting.
 */
export function buildPayrollInsights(input: {
  cycle: string;
  period_start: string;
  period_end: string;
  current: CurrentLine[];
  history: HistoricalRun[];
}): PayrollInsightsResult {
  const { current, history } = input;
  const hasSufficientHistory = history.length >= MIN_HISTORY_RUNS;

  const summary = summarisePayrollRun({
    cycle: input.cycle,
    period_start: input.period_start,
    period_end: input.period_end,
    lines: current,
  });

  const insights = detectPayrollAnomalies(current, history);

  if (!hasSufficientHistory) {
    insights.push({
      code: "insufficient_history",
      severity: "info",
      title: "Limited history",
      detail:
        history.length === 0
          ? "This is the first run in view, so hours and pay comparisons aren't available yet."
          : "Only one prior run is in view — comparisons to a person's usual pattern need at least two.",
      reasoning:
        `${history.length} prior run(s) available; ${MIN_HISTORY_RUNS} needed for ` +
        `outlier, gross-jump and missing-timesheet checks. Zero-hours and new-starter ` +
        `checks still run.`,
    });
  }

  return { summary, insights, hasSufficientHistory };
}

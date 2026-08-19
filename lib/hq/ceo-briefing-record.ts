import type { CeoBriefingSignals } from "@/lib/hq/ceo-briefing";
import type { ExecFormat } from "@/lib/hq/executive";
import type { DeptHealthTone } from "@/lib/hq/ceo";

/**
 * CrewFlow HQ — the READ-side projection of a recorded morning CEO briefing
 * (P2 HQ AI Operating System).
 *
 * The composer (lib/hq/ceo-briefing.ts) and the store (hq_ceo_briefings, migration
 * 20261128) are WRITE-ONLY: a cron records one deterministic briefing per day and,
 * until now, nothing reads it back. This module is the pure, DB-free half of the
 * reader — the row → view projection and a defensive `signals` normaliser — so the
 * reader's shape can be proven without a database (mirroring how the composer is
 * proven without one).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DEFENSIVE, NEVER GENERATIVE
 * ───────────────────────────────────────────────────────────────────────────
 * The narrative is composed from real board figures and the `signals` snapshot is
 * the honesty record it can always be re-derived from. This reader NEVER re-derives,
 * re-computes or invents anything — it projects exactly what was recorded. The one
 * safety it adds is structural: `signals` is JSONB with a `'{}'` default, so a very
 * old or partially-written row can carry an empty or malformed snapshot; the
 * normaliser coerces any such value into a total, well-typed shape (empty arrays,
 * never a throw) so the page renders the header/narrative even when the structured
 * drill-down is unavailable.
 */

/** The valid execution formats a vital can carry — anything else normalises to "int". */
const EXEC_FORMATS: ReadonlyArray<ExecFormat> = ["gbp", "int", "pct"];

/** The valid department health tones — anything else normalises to "insufficient". */
const HEALTH_TONES: ReadonlyArray<DeptHealthTone> = [
  "healthy",
  "steady",
  "attention",
  "foundation",
  "insufficient",
];

/** The valid trend directions a vital can carry. */
const TREND_DIRECTIONS: ReadonlyArray<"up" | "down" | "flat"> = ["up", "down", "flat"];

/** One recorded briefing, projected for the reader page. JSON-safe and read-only. */
export interface CeoBriefingRecord {
  readonly id: number;
  /** The calendar day (ISO `YYYY-MM-DD`) this briefing is the record of. */
  readonly briefingDate: string;
  /** Provenance — CHECK-pinned to the single literal by the store (never generative). */
  readonly source: "deterministic";
  /** The cron run's spine trace id, or null on a very old row. */
  readonly correlationId: string | null;
  /** The one-line executive headline (deterministic). */
  readonly headline: string;
  /** The composed deterministic narrative (multi-line plain text). */
  readonly narrative: string;
  /** The real signal snapshot the narrative was composed from — normalised, never null. */
  readonly signals: CeoBriefingSignals;
  /** When the store stamped the briefing. */
  readonly generatedAt: string;
  /** When the row was inserted. */
  readonly createdAt: string;
}

/** The raw shape a `select()` returns from `hq_ceo_briefings` (snake_case, JSONB `signals`). */
export interface CeoBriefingRow {
  readonly id: number | string;
  readonly briefing_date: string;
  readonly source: string;
  readonly correlation_id: string | null;
  readonly headline: string;
  readonly narrative: string;
  readonly signals: unknown;
  readonly generated_at: string;
  readonly created_at: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asFiniteNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asFormat(v: unknown): ExecFormat {
  return EXEC_FORMATS.includes(v as ExecFormat) ? (v as ExecFormat) : "int";
}

function asTone(v: unknown): DeptHealthTone {
  return HEALTH_TONES.includes(v as DeptHealthTone) ? (v as DeptHealthTone) : "insufficient";
}

function asTrendDirection(v: unknown): "up" | "down" | "flat" | null {
  return TREND_DIRECTIONS.includes(v as "up" | "down" | "flat")
    ? (v as "up" | "down" | "flat")
    : null;
}

/**
 * Coerce an arbitrary recorded `signals` value (possibly `{}`, partial, or absent)
 * into a total {@link CeoBriefingSignals}. Never throws — an unreadable snapshot
 * projects to empty arrays / zero totals, which the page renders as an honest
 * "structured snapshot unavailable", NEVER as a fabricated all-clear.
 */
export function normalizeSignals(raw: unknown): CeoBriefingSignals {
  const root = isRecord(raw) ? raw : {};

  const vitalsRaw = Array.isArray(root.vitals) ? root.vitals : [];
  const vitals = vitalsRaw.filter(isRecord).map((v) => ({
    key: asString(v.key),
    label: asString(v.label),
    value: asFiniteNumber(v.value),
    format: asFormat(v.format),
    trendPct: typeof v.trendPct === "number" && Number.isFinite(v.trendPct) ? v.trendPct : null,
    trendDirection: asTrendDirection(v.trendDirection),
    foundation: v.foundation === true,
  }));

  const departmentsRaw = Array.isArray(root.departments) ? root.departments : [];
  const departments = departmentsRaw.filter(isRecord).map((d) => ({
    key: asString(d.key),
    title: asString(d.title),
    healthTone: asTone(d.healthTone),
    healthLabel: asString(d.healthLabel, "Unavailable"),
  }));

  const competitorsRaw = isRecord(root.competitors) ? root.competitors : {};
  const notesRaw = Array.isArray(competitorsRaw.notes) ? competitorsRaw.notes : [];
  const notes = notesRaw.filter(isRecord).map((c) => ({
    name: asString(c.name),
    headline: asString(c.headline),
    category: typeof c.category === "string" ? c.category : null,
    importance: asString(c.importance, "normal"),
    capturedAt: asString(c.capturedAt),
  }));
  const total =
    typeof competitorsRaw.total === "number" && Number.isFinite(competitorsRaw.total)
      ? competitorsRaw.total
      : notes.length;

  return { vitals, departments, competitors: { total, notes } };
}

/** Project a raw store row into the read-only {@link CeoBriefingRecord} view. */
export function projectBriefingRow(row: CeoBriefingRow): CeoBriefingRecord {
  return {
    // bigint identity comes back from PostgREST as a JS number (safe past this
    // horizon) or a numeric string — coerce either to a number.
    id: Number(row.id),
    briefingDate: asString(row.briefing_date),
    // The store CHECK-pins source to 'deterministic'; the reader trusts that pin.
    source: "deterministic",
    correlationId: row.correlation_id ?? null,
    headline: asString(row.headline),
    narrative: asString(row.narrative),
    signals: normalizeSignals(row.signals),
    generatedAt: asString(row.generated_at),
    createdAt: asString(row.created_at),
  };
}

/** The order health tones surface in on the reader — most operationally urgent first. */
export const BRIEFING_TONE_ORDER: ReadonlyArray<DeptHealthTone> = [
  "attention",
  "insufficient",
  "foundation",
  "steady",
  "healthy",
];

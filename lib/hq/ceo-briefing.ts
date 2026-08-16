import type { CeoBoard, DeptCard, DeptHealthTone } from "@/lib/hq/ceo";
import type { ExecCard, ExecFormat } from "@/lib/hq/executive";

/**
 * CrewFlow HQ — the deterministic morning CEO briefing composer (P2 HQ AI Operating System).
 *
 * The CEO board (lib/hq/ceo.ts, assembled by server/services/hq-ceo.ts) is a read-only surface an
 * operator sees only when they open /admin. This composer turns that same assembled board into a
 * durable morning briefing — a one-line headline plus a plain-text narrative — that a cron records
 * once per day (app/api/cron/hq-ceo-briefing, table hq_ceo_briefings).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DETERMINISTIC + HONEST — narrates the real board, fabricates nothing
 * ───────────────────────────────────────────────────────────────────────────
 * The narrative is composed purely from the board's OWN figures and health signals: each vital is
 * stated with its formatted value and trend; departments are grouped by their honest health tone,
 * with "insufficient" reported as unavailable (an unreadable signal is never dressed up as an
 * all-clear — it inherits the board's own honesty rule). It invents no commentary and paraphrases
 * no number. The GENERATIVE variant — a model writing executive prose over these signals — is DARK:
 * it would be recorded as `source: "generated"`, which the store's CHECK forbids, and it would pass
 * through the governor (lib/ai/governor), whose every tier is null today. This module makes NO model
 * call.
 *
 * PURE + TOTAL: same board → same briefing, always. No clock, no randomness, no I/O — so the
 * recorded narrative can always be re-derived from the recorded `signals` snapshot.
 */

/**
 * One operator-authored competitor observation, projected for the briefing. JSON-safe
 * and honest — every field is copied verbatim from the intel store (hq_competitor_notes),
 * NEVER inferred or generated.
 */
export interface CeoBriefingCompetitor {
  readonly name: string;
  readonly headline: string;
  /** Intel facet (positioning/pricing/…), or null when uncategorised. */
  readonly category: string | null;
  /** Reuses the memory importance vocabulary (low/normal/high/critical). */
  readonly importance: string;
  /** ISO date the note was captured. */
  readonly capturedAt: string;
}

/**
 * The competitor-intelligence snapshot the briefing narrates. `notes` are the most
 * recent active notes (bounded), `total` is the full count of active notes so the
 * narrative can honestly say "showing N of M". Empty ⇒ the section reports an honest
 * "insufficient" rather than conjuring an all-clear.
 */
export interface CeoBriefingCompetitorIntel {
  readonly notes: ReadonlyArray<CeoBriefingCompetitor>;
  readonly total: number;
}

const EMPTY_COMPETITOR_INTEL: CeoBriefingCompetitorIntel = { notes: [], total: 0 };

/** A compact, JSON-safe snapshot of the board the briefing was composed from — the honesty record. */
export interface CeoBriefingSignals {
  readonly vitals: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly value: number;
    readonly format: ExecFormat;
    readonly trendPct: number | null;
    readonly trendDirection: "up" | "down" | "flat" | null;
    readonly foundation: boolean;
  }>;
  readonly departments: ReadonlyArray<{
    readonly key: string;
    readonly title: string;
    readonly healthTone: DeptHealthTone;
    readonly healthLabel: string;
  }>;
  /** The competitor-intelligence snapshot the briefing was composed from. */
  readonly competitors: CeoBriefingCompetitorIntel;
}

/** The composed briefing — exactly what the store records. */
export interface CeoBriefing {
  /** The one-line executive headline. */
  readonly headline: string;
  /** The full deterministic narrative (multi-line plain text). */
  readonly narrative: string;
  /** The signal snapshot the narrative was composed from. */
  readonly signals: CeoBriefingSignals;
}

/** Format a raw figure the way the board's card would — GBP, integer, or percentage. */
function formatValue(value: number, format: ExecFormat): string {
  if (!Number.isFinite(value)) return "n/a";
  if (format === "gbp") {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: "GBP",
      maximumFractionDigits: 0,
    }).format(value);
  }
  if (format === "pct") return `${Math.round(value * 10) / 10}%`;
  return new Intl.NumberFormat("en-GB").format(Math.round(value));
}

/** A signed trend suffix (e.g. " (up 4.2%)"), or "" when there is no trend. */
function trendSuffix(card: ExecCard): string {
  const t = card.trend;
  if (!t || t.direction === "flat") return t ? " (flat)" : "";
  const arrow = t.direction === "up" ? "up" : "down";
  return ` (${arrow} ${Math.abs(t.pct)}%)`;
}

/** The order health tones are surfaced in — the most operationally urgent first. */
const TONE_ORDER: ReadonlyArray<DeptHealthTone> = [
  "attention",
  "insufficient",
  "foundation",
  "steady",
  "healthy",
];

const TONE_HEADING: Record<DeptHealthTone, string> = {
  attention: "Needs attention",
  insufficient: "Signal unavailable",
  foundation: "Foundation (built, no volume yet)",
  steady: "Steady",
  healthy: "Healthy",
};

function toSignals(board: CeoBoard, competitors: CeoBriefingCompetitorIntel): CeoBriefingSignals {
  return {
    vitals: board.vitals.map((v: ExecCard) => ({
      key: v.key,
      label: v.label,
      value: v.value,
      format: v.format,
      trendPct: v.trend ? v.trend.pct : null,
      trendDirection: v.trend ? v.trend.direction : null,
      foundation: v.foundation === true,
    })),
    departments: board.departments.map((d: DeptCard) => ({
      key: d.key,
      title: d.title,
      healthTone: d.health.tone,
      healthLabel: d.health.label,
    })),
    competitors: {
      total: competitors.total,
      notes: competitors.notes.map((c) => ({
        name: c.name,
        headline: c.headline,
        category: c.category,
        importance: c.importance,
        capturedAt: c.capturedAt,
      })),
    },
  };
}

/**
 * Compose the deterministic morning CEO briefing from an assembled {@link CeoBoard}. Pure and total.
 * The headline leads with the primary money vital (MRR when present, else the first vital) and the
 * count of departments needing attention; the narrative lists every vital, then every department
 * grouped by honest health tone. Makes no model call.
 */
export function composeCeoBriefing(
  board: CeoBoard,
  now: Date,
  competitors: CeoBriefingCompetitorIntel = EMPTY_COMPETITOR_INTEL,
): CeoBriefing {
  const signals = toSignals(board, competitors);
  const dateLabel = now.toISOString().slice(0, 10);

  const primary =
    board.vitals.find((v) => v.key === "mrr") ?? board.vitals[0] ?? null;
  const attention = board.departments.filter((d) => d.health.tone === "attention");
  const unavailable = board.departments.filter((d) => d.health.tone === "insufficient");

  // ── Headline — the money read plus the single most important operational fact.
  const headParts: string[] = [];
  if (primary) headParts.push(`${primary.label} ${formatValue(primary.value, primary.format)}`);
  headParts.push(
    attention.length > 0
      ? `${attention.length} department${attention.length === 1 ? "" : "s"} need attention`
      : "no departments flagged for attention",
  );
  if (unavailable.length > 0) {
    headParts.push(`${unavailable.length} signal${unavailable.length === 1 ? "" : "s"} unavailable`);
  }
  // Only surfaced when intel exists — an empty store leaves the headline unchanged.
  if (competitors.total > 0) {
    headParts.push(
      `${competitors.total} competitor note${competitors.total === 1 ? "" : "s"} tracked`,
    );
  }
  const headline = `CEO briefing ${dateLabel} — ${headParts.join("; ")}.`;

  // ── Narrative — vitals, then departments grouped by honest health tone.
  const lines: string[] = [];
  lines.push(`Morning CEO briefing for ${dateLabel}.`);
  lines.push("");
  lines.push("Company vitals:");
  if (board.vitals.length === 0) {
    lines.push("  - Vitals unavailable — the board reported no figures.");
  } else {
    for (const v of board.vitals) {
      const foundation = v.foundation === true ? " [foundation]" : "";
      lines.push(`  - ${v.label}: ${formatValue(v.value, v.format)}${trendSuffix(v)}${foundation}`);
    }
  }
  lines.push("");
  lines.push("Departments:");
  if (board.departments.length === 0) {
    lines.push("  - No departments reported.");
  } else {
    for (const tone of TONE_ORDER) {
      const inTone = board.departments.filter((d) => d.health.tone === tone);
      if (inTone.length === 0) continue;
      const names = inTone.map((d) => d.title).join(", ");
      lines.push(`  - ${TONE_HEADING[tone]}: ${names}.`);
    }
  }

  // ── Competitor intelligence — the operator-authored intel store, narrated honestly.
  lines.push("");
  lines.push("Competitor intelligence:");
  if (competitors.total === 0 || competitors.notes.length === 0) {
    lines.push("  - Insufficient — no competitor intelligence has been recorded.");
  } else {
    if (competitors.total > competitors.notes.length) {
      lines.push(`  - Showing ${competitors.notes.length} of ${competitors.total} active notes.`);
    }
    for (const c of competitors.notes) {
      const facet = c.category ? ` [${c.category}]` : "";
      const importance = c.importance && c.importance !== "normal" ? ` (${c.importance})` : "";
      lines.push(`  - ${c.name}: ${c.headline}${facet}${importance} — ${c.capturedAt}`);
    }
  }

  return { headline, narrative: lines.join("\n"), signals };
}

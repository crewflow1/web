/**
 * TENANT LEAD SCORE — a transparent, DETERMINISTIC scoring rubric over a
 * tenant's OWN leads. PURE: no I/O, no clock (the clock is injected as
 * `asOfMs`), no server-only imports — the server actions, the pipeline page,
 * the lead-detail page and the tests all import the same rubric.
 *
 * ── THIS IS NOT AI. IT IS A RUBRIC. ─────────────────────────────────────────
 * There is no model, no embedding, no training here. Every point is produced
 * by a rule a human can read, reproduce by hand, and argue with. The score is
 * a weighted blend of six named factors over the lead's OWN signals; the same
 * lead row + the same `asOfMs` always yields the same number. The word "score"
 * means exactly a rubric total — never a prediction.
 *
 * (CrewFlow already ships a lead scorer for its OWN prospects inside HQ —
 * lib/research/score.ts — but tenants had none. This is the tenant-facing
 * equivalent, deliberately scoped to a single lead row so it recomputes purely
 * on lead change and can never read across the tenant boundary: it takes no
 * org id because it touches no other org's data.)
 *
 * ── EVERY FACTOR LABELS ITSELF (the provenance doctrine) ─────────────────────
 * Mirroring lib/intelligence/provenance.ts, each factor carries a `kind`:
 *   · fact       — a stored column read straight back (none here scores on a
 *                  bare fact alone; facts feed the derived/heuristic factors).
 *   · derived    — exact arithmetic over stored facts (contactability: how many
 *                  of the three contact fields are filled, ÷3).
 *   · heuristic  — a JUDGEMENT RULE with a threshold somebody chose. The rule is
 *                  stated VERBATIM in `detail`, because a heuristic whose
 *                  thresholds are hidden reads to the user like a fact — and
 *                  that is the lie this labelling exists to prevent.
 * A factor with no supporting signal is still listed (so the gap is visible)
 * but marked `known: false` and EXCLUDED from the blend — an unknown never
 * silently drags a lead to the middle. `confidence` reports the share of weight
 * that was actually backed by evidence.
 */

import { type SignalKind } from "@/lib/intelligence/provenance";

// ---------------------------------------------------------------------------
// Bands — hot / warm / cold (the roadmap's three-band ask).
// ---------------------------------------------------------------------------

export const LEAD_SCORE_BANDS = ["hot", "warm", "cold"] as const;
export type LeadScoreBand = (typeof LEAD_SCORE_BANDS)[number];

export const LEAD_SCORE_BAND_LABELS: Record<LeadScoreBand, string> = {
  hot: "Hot",
  warm: "Warm",
  cold: "Cold",
};

/** Text badge styles — colour is never the only signal (the label word is). */
export const LEAD_SCORE_BAND_STYLES: Record<LeadScoreBand, string> = {
  hot: "bg-red-100 text-red-800",
  warm: "bg-amber-100 text-amber-800",
  cold: "bg-slate-100 text-slate-700",
};

/**
 * Band cut-lines. HEURISTIC screening thresholds — chosen, not measured — so
 * they live here as named constants the basis strings and tests both cite.
 */
export const LEAD_SCORE_HOT_MIN = 67;
export const LEAD_SCORE_WARM_MIN = 34;

export function leadScoreBand(score: number): LeadScoreBand {
  if (score >= LEAD_SCORE_HOT_MIN) return "hot";
  if (score >= LEAD_SCORE_WARM_MIN) return "warm";
  return "cold";
}

// ---------------------------------------------------------------------------
// Factors
// ---------------------------------------------------------------------------

export const LEAD_SCORE_FACTOR_KEYS = [
  "budget",
  "stage",
  "recency",
  "source",
  "contactability",
  "relationship",
] as const;
export type LeadScoreFactorKey = (typeof LEAD_SCORE_FACTOR_KEYS)[number];

export type LeadScoreFactor = {
  key: LeadScoreFactorKey;
  label: string;
  /** fact | derived | heuristic — the self-labelling contract. */
  kind: SignalKind;
  /** 0..1 share of the blend this factor carries. Weights sum to 1. */
  weight: number;
  /** 0..100. Zero (and never blended) when `known` is false. */
  value: number;
  /** False when the supporting signal is absent — excluded from the blend. */
  known: boolean;
  /** Plain English: the reading, and — for a heuristic — the rule verbatim. */
  detail: string;
};

export type LeadScore = {
  /** 0..100, weighted over KNOWN factors only. Always defined (see below). */
  score: number;
  band: LeadScoreBand;
  /** 0..100 — share of total weight backed by evidence. */
  confidence: number;
  /** All six factors, always present, in fixed order. */
  factors: LeadScoreFactor[];
};

/** The single lead row this rubric reads — nothing beyond it, plus the clock. */
export type LeadScoreInput = {
  status: string | null;
  source: string | null;
  estimatedValue: number | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  lastActivityAt: string | null;
  createdAt?: string | null;
  customerId: string | null;
  /** Injected clock (ms since epoch) so recency is deterministic + testable. */
  asOfMs: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp100(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

type Built = { value: number; known: boolean; detail: string };

const GBP = (n: number) =>
  `£${Math.round(n).toLocaleString("en-GB")}`;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days between an ISO timestamp and `asOfMs`; null if unparseable. */
function daysSince(iso: string | null | undefined, asOfMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  // A future timestamp (clock skew) reads as "just now", never negative days.
  return Math.max(0, Math.floor((asOfMs - t) / DAY_MS));
}

// ---------------------------------------------------------------------------
// The six factor builders. Each pure; each returns an honest "unknown" when
// its signal is absent.
// ---------------------------------------------------------------------------

/** Budget — HEURISTIC banding over the stored estimated value. */
function budget(estimatedValue: number | null): Built {
  if (estimatedValue == null || !Number.isFinite(estimatedValue)) {
    return { value: 0, known: false, detail: "No estimated value on the lead yet" };
  }
  const v = estimatedValue;
  const m = GBP(v);
  if (v < 500) return { value: 30, known: true, detail: `${m} — under £500, a small job` };
  if (v < 2_000) return { value: 55, known: true, detail: `${m} — £500–£2,000` };
  if (v < 10_000) return { value: 78, known: true, detail: `${m} — £2,000–£10,000, a solid job` };
  if (v < 50_000) return { value: 90, known: true, detail: `${m} — £10,000–£50,000, a major job` };
  return { value: 96, known: true, detail: `${m} — £50,000+, a flagship enquiry` };
}

/**
 * Stage progression — HEURISTIC. Further down the funnel = closer to won.
 * `lost` is a known, terminal cold; unknown/legacy statuses read as "new".
 */
const STAGE_POINTS: Record<string, { value: number; detail: string }> = {
  won: { value: 100, detail: "Won — closed successfully" },
  job_booked: { value: 100, detail: "Job booked — won and scheduled" },
  quoted: { value: 82, detail: "Quoted — awaiting the customer's decision" },
  qualified: { value: 64, detail: "Qualified — a genuine opportunity" },
  contacted: { value: 46, detail: "Contacted — first touch made" },
  new: { value: 30, detail: "New — not yet worked" },
  lost: { value: 0, detail: "Lost — closed out" },
};

function stage(status: string | null): Built {
  const key = status ?? "new";
  const hit = STAGE_POINTS[key];
  if (hit) return { value: hit.value, known: true, detail: hit.detail };
  // Legacy / unrecognised status (e.g. archived): score as an un-worked lead
  // rather than inventing a stage. Known — the status is observable.
  return { value: 30, known: true, detail: `Stage "${key}" — treated as a new lead` };
}

/** Recency — HEURISTIC banding over days since the last activity. */
export const RECENCY_FRESH_DAYS = 3;
export const RECENCY_WEEK_DAYS = 7;
export const RECENCY_FORTNIGHT_DAYS = 14;
export const RECENCY_MONTH_DAYS = 30;

function recency(
  lastActivityAt: string | null,
  createdAt: string | null | undefined,
  asOfMs: number,
): Built {
  const days = daysSince(lastActivityAt, asOfMs) ?? daysSince(createdAt, asOfMs);
  if (days == null) {
    return { value: 0, known: false, detail: "No activity timestamp on the lead" };
  }
  const d = `${days} day${days === 1 ? "" : "s"} since last activity`;
  if (days <= RECENCY_FRESH_DAYS) return { value: 90, known: true, detail: `${d} — active now (≤${RECENCY_FRESH_DAYS}d)` };
  if (days <= RECENCY_WEEK_DAYS) return { value: 72, known: true, detail: `${d} — active this week (≤${RECENCY_WEEK_DAYS}d)` };
  if (days <= RECENCY_FORTNIGHT_DAYS) return { value: 54, known: true, detail: `${d} — within a fortnight (≤${RECENCY_FORTNIGHT_DAYS}d)` };
  if (days <= RECENCY_MONTH_DAYS) return { value: 36, known: true, detail: `${d} — going quiet (≤${RECENCY_MONTH_DAYS}d)` };
  return { value: 18, known: true, detail: `${d} — stale, over a month cold` };
}

/**
 * Source quality — HEURISTIC ranking of enquiry channels by typical intent.
 * Every source is known (it's a required field), so this never withholds.
 */
const SOURCE_OTHER = { value: 40, detail: "Other / unspecified source" } as const;
const SOURCE_POINTS: Record<string, { value: number; detail: string }> = {
  repeat: { value: 92, detail: "Repeat customer — highest intent" },
  referral: { value: 90, detail: "Referral — high-intent, warm introduction" },
  phone: { value: 74, detail: "Inbound phone enquiry" },
  walk_in: { value: 70, detail: "Walk-in enquiry" },
  portal: { value: 66, detail: "Customer-portal request" },
  web: { value: 58, detail: "Web enquiry" },
  social: { value: 46, detail: "Social channel" },
  other: SOURCE_OTHER,
};

function source(src: string | null): Built {
  const hit = (src != null && SOURCE_POINTS[src]) || SOURCE_OTHER;
  return { value: hit.value, known: true, detail: hit.detail };
}

/**
 * Contactability — DERIVED. Exact: how many of {name, email, phone} are filled,
 * out of three. No threshold, no opinion — pure arithmetic over stored facts.
 */
function contactability(
  name: string | null,
  email: string | null,
  phone: string | null,
): Built {
  const present = [name, email, phone].filter((v) => !!v && v.trim().length > 0);
  const labels = [
    name && name.trim() ? "name" : null,
    email && email.trim() ? "email" : null,
    phone && phone.trim() ? "phone" : null,
  ].filter(Boolean);
  const value = Math.round((present.length / 3) * 100);
  return {
    value,
    known: true,
    detail: `${present.length} of 3 contact fields filled${labels.length ? ` (${labels.join(", ")})` : ""}`,
  };
}

/**
 * Relationship — HEURISTIC. A lead tied to an existing customer, or flagged as
 * a repeat enquiry, is warmer than a first-time cold contact. Observable from
 * the lead's own row (source + customer_id), so always known.
 */
function relationship(src: string | null, customerId: string | null): Built {
  const isRepeat = src === "repeat";
  const linked = !!customerId;
  if (isRepeat && linked) {
    return { value: 88, known: true, detail: "Repeat enquiry, linked to an existing customer" };
  }
  if (linked) {
    return { value: 74, known: true, detail: "Linked to an existing customer record" };
  }
  if (isRepeat) {
    return { value: 70, known: true, detail: "Marked as a repeat-customer enquiry" };
  }
  return { value: 40, known: true, detail: "New contact — no existing relationship on file" };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

type FactorSpec = {
  key: LeadScoreFactorKey;
  label: string;
  kind: SignalKind;
  weight: number;
  build: (i: LeadScoreInput) => Built;
};

/** The six factors, in fixed display order. Weights sum to exactly 1.0. */
export const LEAD_SCORE_FACTOR_SPECS: ReadonlyArray<FactorSpec> = [
  { key: "budget", label: "Budget", kind: "heuristic", weight: 0.25, build: (i) => budget(i.estimatedValue) },
  { key: "stage", label: "Stage progress", kind: "heuristic", weight: 0.22, build: (i) => stage(i.status) },
  { key: "recency", label: "Recency", kind: "heuristic", weight: 0.18, build: (i) => recency(i.lastActivityAt, i.createdAt, i.asOfMs) },
  { key: "source", label: "Source quality", kind: "heuristic", weight: 0.15, build: (i) => source(i.source) },
  { key: "contactability", label: "Contactability", kind: "derived", weight: 0.12, build: (i) => contactability(i.contactName, i.contactEmail, i.contactPhone) },
  { key: "relationship", label: "Relationship", kind: "heuristic", weight: 0.08, build: (i) => relationship(i.source, i.customerId) },
];

/**
 * Score one lead. Deterministic: identical input + `asOfMs` ⇒ identical output.
 *
 * The blend runs over KNOWN factors only. Because stage, source, contactability
 * and relationship are always known (their signals are required columns), the
 * known weight is never zero — every lead, including every pre-existing one,
 * gets a valid 0 to 100 score and a band. It never returns null and never throws.
 */
export function scoreLead(input: LeadScoreInput): LeadScore {
  const factors: LeadScoreFactor[] = [];
  let weighted = 0;
  let knownWeight = 0;
  let totalWeight = 0;

  for (const spec of LEAD_SCORE_FACTOR_SPECS) {
    const built = spec.build(input);
    const value = clamp100(built.value);
    totalWeight += spec.weight;
    if (built.known) {
      weighted += value * spec.weight;
      knownWeight += spec.weight;
    }
    factors.push({
      key: spec.key,
      label: spec.label,
      kind: spec.kind,
      weight: spec.weight,
      value: built.known ? value : 0,
      known: built.known,
      detail: built.detail,
    });
  }

  const score = knownWeight > 0 ? clamp100(weighted / knownWeight) : 0;
  const confidence = totalWeight > 0 ? Math.round((knownWeight / totalWeight) * 100) : 0;

  return { score, band: leadScoreBand(score), confidence, factors };
}

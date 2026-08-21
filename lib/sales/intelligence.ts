/**
 * CrewFlow HQ — AI Company Intelligence, derived-signal layer
 * (CEO Directive 004, Phase 4).
 *
 * Server/client-safe. NO Supabase / server-only imports — the company
 * detail page imports these pure functions to synthesise the directive's
 * three *derived* intelligence fields that the reserved schema can't store
 * directly:
 *
 *   • relationship score   — strength of the live relationship, read from
 *                            the communication history (the timeline).
 *   • likelihood to buy    — one explainable composite that blends the AI
 *                            qualification score, the enrichment signals,
 *                            engagement and pipeline momentum.
 *   • AI reasoning         — the ordered list of factors behind that
 *                            composite, so a human can see exactly why.
 *   • profile completeness — how much of the intelligence profile is
 *                            actually enriched (data coverage).
 *
 * Everything here is a pure read of data the detail loader already
 * returns (company + timeline). Nothing is invented: a signal that is
 * null is simply omitted from the blend, and a company with no contact
 * history has a null relationship score rather than a fabricated one.
 * `nowMs` is injectable so the recency maths are deterministic in tests.
 */

import {
  likelihoodBandFromScore,
  scoreBand,
  statusLabel,
  type LikelihoodBand,
  type SalesCompany,
  type SalesTimelineEvent,
} from "./model";

// ---------------------------------------------------------------------
// Relationship score — derived from the communication history.
// ---------------------------------------------------------------------

export const RELATIONSHIP_BANDS = [
  "strong",
  "engaged",
  "warming",
  "cold",
  "none",
] as const;
export type RelationshipBand = (typeof RELATIONSHIP_BANDS)[number];

export const RELATIONSHIP_BAND_LABELS: Record<RelationshipBand, string> = {
  strong: "Strong",
  engaged: "Engaged",
  warming: "Warming",
  cold: "Cold",
  none: "No contact",
};

export function relationshipBand(score: number | null): RelationshipBand {
  if (score == null) return "none";
  if (score >= 75) return "strong";
  if (score >= 50) return "engaged";
  if (score >= 25) return "warming";
  return "cold";
}

export function relationshipBandLabel(score: number | null): string {
  return RELATIONSHIP_BAND_LABELS[relationshipBand(score)];
}

/**
 * Timeline event types that count as a genuine relationship "touch" — a
 * communication with the prospect. Internal notes, lifecycle markers, AI
 * scoring/enrichment and task-queue churn are excluded; only real contact
 * (human-logged or an AI comm that actually reached out) builds rapport.
 */
const RELATIONSHIP_TOUCH_TYPES = new Set<string>([
  "email",
  "call",
  "linkedin",
  "instagram",
  "facebook",
  "meeting",
  "demo",
  "quote",
  "follow_up",
  "email_sent",
  "linkedin_sent",
  "call_completed",
  "demo_booked",
  "demo_completed",
  "objection_handled",
]);

/** Touches that represent a substantive, high-trust conversation. */
const DEEP_TOUCH_TYPES = new Set<string>([
  "call",
  "call_completed",
  "meeting",
  "demo",
  "demo_completed",
]);

export type RelationshipScore = {
  /** 0–100, or null when there has been no contact at all. */
  score: number | null;
  band: RelationshipBand;
  touches: number;
  inbound: number;
  outbound: number;
  /** True once the prospect has engaged back at least once. */
  twoWay: boolean;
  lastTouchAt: string | null;
  daysSinceLastTouch: number | null;
};

function recencyPoints(days: number): number {
  if (days <= 3) return 40;
  if (days <= 7) return 34;
  if (days <= 14) return 28;
  if (days <= 30) return 20;
  if (days <= 60) return 12;
  if (days <= 90) return 6;
  return 2;
}

function clamp100(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function computeRelationshipScore(
  timeline: ReadonlyArray<SalesTimelineEvent>,
  opts: { nowMs?: number } = {},
): RelationshipScore {
  const nowMs = opts.nowMs ?? Date.now();

  let touches = 0;
  let inbound = 0;
  let outbound = 0;
  let deep = 0;
  let lastTouchMs: number | null = null;
  let lastTouchAt: string | null = null;

  for (const e of timeline) {
    if (!RELATIONSHIP_TOUCH_TYPES.has(e.event_type)) continue;
    touches += 1;
    if (e.direction === "inbound") inbound += 1;
    else if (e.direction === "outbound") outbound += 1;
    if (DEEP_TOUCH_TYPES.has(e.event_type)) deep += 1;

    const t = new Date(e.occurred_at).getTime();
    if (Number.isFinite(t) && (lastTouchMs == null || t > lastTouchMs)) {
      lastTouchMs = t;
      lastTouchAt = e.occurred_at;
    }
  }

  if (touches === 0) {
    return {
      score: null,
      band: "none",
      touches: 0,
      inbound: 0,
      outbound: 0,
      twoWay: false,
      lastTouchAt: null,
      daysSinceLastTouch: null,
    };
  }

  const daysSinceLastTouch =
    lastTouchMs == null
      ? null
      : Math.max(0, Math.floor((nowMs - lastTouchMs) / 86_400_000));

  // 0–40 recency · 0–25 frequency · 0–20 two-way · 0–15 depth.
  const recencyPts = daysSinceLastTouch == null ? 2 : recencyPoints(daysSinceLastTouch);
  const frequencyPts = Math.round((Math.min(touches, 10) / 10) * 25);
  const twoWayPts = inbound >= 3 ? 20 : inbound === 2 ? 15 : inbound === 1 ? 10 : 0;
  const depthPts = Math.round((Math.min(deep, 3) / 3) * 15);

  const score = clamp100(recencyPts + frequencyPts + twoWayPts + depthPts);

  return {
    score,
    band: relationshipBand(score),
    touches,
    inbound,
    outbound,
    twoWay: inbound > 0,
    lastTouchAt,
    daysSinceLastTouch,
  };
}

// ---------------------------------------------------------------------
// Likelihood to buy — one explainable composite + the reasoning factors.
// ---------------------------------------------------------------------

export type FactorTone = "positive" | "neutral" | "negative";

/** One contributing signal behind the likelihood composite (the reasoning). */
export type IntelligenceFactor = {
  key: string;
  label: string;
  /** 0–100 value this signal contributed. */
  value: number;
  /** Relative weight in the blend. */
  weight: number;
  detail: string;
  tone: FactorTone;
};

export type LikelihoodToBuy = {
  /** 0–100 composite, or null when nothing is known yet. */
  score: number | null;
  band: LikelihoodBand;
  factors: IntelligenceFactor[];
};

function toneFor(value: number): FactorTone {
  if (value >= 60) return "positive";
  if (value >= 40) return "neutral";
  return "negative";
}

/** Pipeline stage → 0–100 momentum. Always present (status is never null). */
function pipelineMomentum(status: string): number {
  switch (status) {
    case "won":
      return 100;
    case "demo_booked":
      return 90;
    case "replied":
      return 78;
    case "contacted":
      return 60;
    case "outreach_ready":
      return 55;
    case "qualified":
      return 45;
    case "new":
      return 30;
    case "lost":
      return 5;
    case "disqualified":
      return 0;
    default:
      return 30;
  }
}

function isNum(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n);
}

function avgPresent(values: ReadonlyArray<number | null>): number | null {
  const present = values.filter(isNum);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

export function computeLikelihoodToBuy(
  company: Pick<
    SalesCompany,
    | "ai_qualification_score"
    | "growth_score"
    | "website_quality_score"
    | "marketing_quality_score"
    | "hiring_activity_score"
    | "digital_maturity_score"
    | "status"
  >,
  relationshipScore: number | null,
): LikelihoodToBuy {
  const factors: IntelligenceFactor[] = [];
  let weighted = 0;
  let weightSum = 0;

  const add = (
    key: string,
    label: string,
    value: number,
    weight: number,
    detail: string,
    tone: FactorTone = toneFor(value),
  ) => {
    factors.push({ key, label, value: Math.round(value), weight, detail, tone });
    weighted += value * weight;
    weightSum += weight;
  };

  // Fit — the AI qualification score is the strongest single signal.
  if (isNum(company.ai_qualification_score)) {
    add(
      "qualification",
      "AI qualification",
      company.ai_qualification_score,
      0.34,
      `Score ${company.ai_qualification_score} · ${scoreBand(company.ai_qualification_score)}`,
    );
  }

  // Enrichment fit — the mean of whatever enrichment signals are present.
  const enrichment = avgPresent([
    company.growth_score,
    company.website_quality_score,
    company.marketing_quality_score,
    company.hiring_activity_score,
    company.digital_maturity_score,
  ]);
  if (enrichment != null) {
    add(
      "enrichment",
      "Enrichment fit",
      enrichment,
      0.22,
      "Mean of growth, website, marketing, hiring & digital signals",
    );
  }

  // Engagement — the live relationship, when there has been any contact.
  if (relationshipScore != null) {
    add(
      "engagement",
      "Engagement",
      relationshipScore,
      0.22,
      `${relationshipBandLabel(relationshipScore)} relationship from contact history`,
    );
  }

  // Momentum — where they sit in the funnel. Always present.
  const momentum = pipelineMomentum(company.status);
  add(
    "momentum",
    "Pipeline stage",
    momentum,
    0.22,
    statusLabel(company.status),
    company.status === "lost" || company.status === "disqualified"
      ? "negative"
      : toneFor(momentum),
  );

  const score = weightSum > 0 ? clamp100(weighted / weightSum) : null;

  return {
    score,
    band: likelihoodBandFromScore(score),
    factors,
  };
}

// ---------------------------------------------------------------------
// Profile completeness — how much intelligence is actually enriched.
// ---------------------------------------------------------------------

type CompletenessField = {
  key: string;
  label: string;
  has: (c: SalesCompany) => boolean;
};

const hasStr = (v: string | null | undefined): boolean =>
  typeof v === "string" && v.trim().length > 0;

const INTELLIGENCE_PROFILE_FIELDS: ReadonlyArray<CompletenessField> = [
  { key: "industry", label: "Industry", has: (c) => hasStr(c.industry) },
  { key: "employee_count", label: "Employees", has: (c) => isNum(c.employee_count) },
  { key: "annual_turnover_gbp", label: "Turnover", has: (c) => isNum(c.annual_turnover_gbp) },
  { key: "revenue_estimate_gbp", label: "Revenue estimate", has: (c) => isNum(c.revenue_estimate_gbp) },
  { key: "construction_sector", label: "Construction sector", has: (c) => hasStr(c.construction_sector) },
  { key: "software_used", label: "Software in use", has: (c) => c.software_used.length > 0 },
  { key: "estimated_software_spend_gbp", label: "Software spend", has: (c) => isNum(c.estimated_software_spend_gbp) },
  { key: "fleet_size", label: "Fleet size", has: (c) => isNum(c.fleet_size) },
  { key: "staff_size", label: "Staff size", has: (c) => isNum(c.staff_size) },
  { key: "growth_score", label: "Growth score", has: (c) => isNum(c.growth_score) },
  { key: "website_quality_score", label: "Website quality", has: (c) => isNum(c.website_quality_score) },
  { key: "marketing_quality_score", label: "Marketing quality", has: (c) => isNum(c.marketing_quality_score) },
  { key: "hiring_activity_score", label: "Hiring activity", has: (c) => isNum(c.hiring_activity_score) },
  { key: "digital_maturity_score", label: "Digital maturity", has: (c) => isNum(c.digital_maturity_score) },
  { key: "website", label: "Website", has: (c) => hasStr(c.website) },
  { key: "primary_email", label: "Email", has: (c) => hasStr(c.primary_email) },
  { key: "primary_phone", label: "Phone", has: (c) => hasStr(c.primary_phone) },
  { key: "linkedin_url", label: "LinkedIn", has: (c) => hasStr(c.linkedin_url) },
  { key: "ai_qualification_score", label: "AI qualification", has: (c) => isNum(c.ai_qualification_score) },
];

export type IntelligenceCompleteness = {
  pct: number;
  present: number;
  total: number;
  missing: string[];
};

export function intelligenceCompleteness(
  company: SalesCompany,
): IntelligenceCompleteness {
  const total = INTELLIGENCE_PROFILE_FIELDS.length;
  let present = 0;
  const missing: string[] = [];
  for (const f of INTELLIGENCE_PROFILE_FIELDS) {
    if (f.has(company)) present += 1;
    else missing.push(f.label);
  }
  return {
    pct: total > 0 ? Math.round((present / total) * 100) : 0,
    present,
    total,
    missing,
  };
}

// ---------------------------------------------------------------------
// One assembled profile — the shape the detail page renders.
// ---------------------------------------------------------------------

export type IntelligenceProfile = {
  relationship: RelationshipScore;
  likelihood: LikelihoodToBuy;
  completeness: IntelligenceCompleteness;
};

export function buildIntelligenceProfile(args: {
  company: SalesCompany;
  timeline: ReadonlyArray<SalesTimelineEvent>;
  nowMs?: number;
}): IntelligenceProfile {
  const relationship = computeRelationshipScore(args.timeline, {
    nowMs: args.nowMs,
  });
  const likelihood = computeLikelihoodToBuy(args.company, relationship.score);
  const completeness = intelligenceCompleteness(args.company);
  return { relationship, likelihood, completeness };
}

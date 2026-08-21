/**
 * CrewFlow HQ — Lead Qualification rubric (CEO Directive 003, Module 3).
 * Pure, server/client-safe. NO Supabase / server-only imports.
 *
 * `qualifyCompany` is the whole decision engine: it takes the signals the
 * runner has already persisted (the Research AI fit score, how much of the
 * intelligence profile is enriched, registered territory, sector, and
 * decision-maker reach) and returns ONE explainable verdict — qualified |
 * disqualified | review — with the weighted criteria, a confidence figure, and
 * a plain-English rationale behind it.
 *
 * Why deterministic (no LLM): a qualify/disqualify call gates a company's place
 * in the pipeline. The directive's transparency bar ("every decision must be
 * explainable; no black box") means that verdict must be reconstructable from
 * named rules and thresholds, not an opaque model sample. So this module is the
 * arbiter, and the model layer is nowhere near it.
 *
 * The rules, in one place:
 *   • Territory is a HARD gate — a company confidently outside the UK is
 *     disqualified regardless of fit (out of market). Unknown territory never
 *     hard-fails; only a confident overseas read does.
 *   • The AI fit score is the arbiter for everything in-territory:
 *       ≥ QUALIFY_THRESHOLD  → qualified  (unless evidence is too thin to trust)
 *       < DISQUALIFY_FLOOR   → disqualified
 *       in between / unknown → review (hold at 'new' for a human)
 *   • Evidence is a guard, not an arbiter: a strong score on a near-empty
 *     profile is held for review rather than auto-qualified.
 *   • Sector + decision-maker access are informational — they shape confidence
 *     and the rationale, but never override the score.
 */

import {
  clampScore,
  scoreBand,
  scoreBandLabel,
} from "@/lib/sales/model";
import type { FactorTone } from "@/lib/sales/intelligence";
import {
  recommendedStatusFor,
  type QualificationCriterion,
  type QualificationDecision,
  type QualificationVerdict,
} from "./model";

// ---------------------------------------------------------------------
// Named thresholds — the qualification bar, the disqualify floor, and the
// minimum profile coverage required to trust a passing score. Exported so the
// UI can explain them and the tests can pin them.
// ---------------------------------------------------------------------

/** Fit score at/above which a UK lead qualifies (the "warm" band boundary). */
export const QUALIFY_THRESHOLD = 60;
/** Fit score below which a UK lead is disqualified (a clear miss). */
export const DISQUALIFY_FLOOR = 30;
/** Minimum profile-enrichment coverage (%) to trust a passing score; below
 *  this a strong score is held for review rather than auto-qualified. */
export const EVIDENCE_FLOOR = 25;

// ---------------------------------------------------------------------
// The inputs the rubric reads — built by the runner from the company row, its
// contacts, and the shared intelligence-completeness helper. Kept as a flat,
// explicit shape so the unit tests can exercise the rules without a DB.
// ---------------------------------------------------------------------

export type QualificationInput = {
  /** The Research AI fit score (hq_sales_companies.ai_qualification_score). */
  score: number | null;
  /** 0 to 100 share of the intelligence profile that is enriched, or null. */
  evidence: number | null;
  /** Whether the company has been researched at all (last_researched_at set). */
  researched: boolean;
  /** Registered country (hq_sales_companies.country). */
  country: string | null;
  /** Free-text location / region — a secondary territory signal. */
  location: string | null;
  /** Construction sector classification, if known. */
  sector: string | null;
  /** Industry label — a fallback sector signal. */
  industry: string | null;
  /** Count of identified decision-maker contacts. */
  decisionMakers: number;
  /** Of those, how many have a direct channel (email / phone / LinkedIn). */
  reachableDecisionMakers: number;
};

// ---------------------------------------------------------------------
// Territory + sector classification (deterministic, conservative).
// ---------------------------------------------------------------------

export type Territory = "uk" | "overseas" | "unknown";
export type SectorClass = "construction" | "other" | "unknown";

// UK nations/regions as whole phrases. Deliberately NO bare city names: a hard
// disqualifier must not hinge on "Manchester" (which could be Connecticut), and
// the soft location nuance already lives in the Research AI score.
const UK_PHRASES = [
  "united kingdom",
  "england",
  "scotland",
  "wales",
  "northern ireland",
  "great britain",
  "britain",
];

/** True when the text carries a confident UK signal. The abbreviations UK / GB
 *  are matched on WORD boundaries so "Ukraine" or "Edgbaston" never count. */
function hasUkSignal(text: string): boolean {
  const norm = text.toLowerCase();
  if (UK_PHRASES.some((p) => norm.includes(p))) return true;
  if (norm.includes("u.k")) return true;
  return /\b(uk|gb)\b/.test(norm);
}

/**
 * Resolve territory from the structured country field (authoritative) with the
 * free-text location as a secondary confirmation. A non-empty country that is
 * not UK-ish is treated as a deliberate overseas marker (a hard disqualifier);
 * a bare free-text location that merely fails to mention the UK is NOT — that
 * stays "unknown" so the gate never fires on a noisy signal.
 */
export function territoryOf(country: string | null, location: string | null): Territory {
  const countryStr = (country ?? "").trim();
  const hay = [country, location].filter(Boolean).join(" ");
  if (!hay.trim()) return "unknown";
  if (hasUkSignal(hay)) return "uk";
  // A structured, non-empty, non-UK country is a confident overseas read.
  if (countryStr) return "overseas";
  return "unknown";
}

const CONSTRUCTION_WORDS = [
  "construction",
  "builder",
  "building",
  "contractor",
  "groundwork",
  "scaffold",
  "roofing",
  "plumbing",
  "electrical",
  "electrician",
  "joinery",
  "carpentry",
  "plastering",
  "bricklay",
  "civil engineering",
  "civils",
  "demolition",
  "fit-out",
  "fit out",
  "fitout",
  "landscaping",
  "fencing",
  "paving",
  "surfacing",
  "drainage",
  "hvac",
  "mechanical",
  "facilities",
  "maintenance",
  "renovation",
  "refurbishment",
  "trades",
  "plant hire",
];

export function sectorOf(sector: string | null, industry: string | null): SectorClass {
  if (sector && sector.trim()) return "construction";
  const ind = (industry ?? "").trim().toLowerCase();
  if (!ind) return "unknown";
  return CONSTRUCTION_WORDS.some((w) => ind.includes(w)) ? "construction" : "other";
}

// ---------------------------------------------------------------------
// The five criteria builders. Each returns the criterion fields the verdict
// surfaces; weights sum to 1.0 so confidence is a clean share of evidence.
// ---------------------------------------------------------------------

type Built = Omit<QualificationCriterion, "key" | "label" | "weight">;

function fitCriterion(score: number | null): Built {
  if (score == null) {
    return {
      value: 0,
      known: false,
      passed: null,
      tone: "neutral",
      detail: "No AI fit score yet — not researched/scored",
    };
  }
  const tone: FactorTone =
    score >= QUALIFY_THRESHOLD ? "positive" : score < DISQUALIFY_FLOOR ? "negative" : "neutral";
  return {
    value: score,
    known: true,
    passed: score >= QUALIFY_THRESHOLD,
    tone,
    detail: `AI fit score ${score}/100 (${scoreBandLabel(score)})`,
  };
}

function evidenceCriterion(evidence: number | null, researched: boolean): Built {
  if (!researched || evidence == null) {
    return {
      value: 0,
      known: false,
      passed: null,
      tone: "neutral",
      detail: "Not yet researched — no evidence to weigh",
    };
  }
  const tone: FactorTone = evidence >= 50 ? "positive" : evidence >= EVIDENCE_FLOOR ? "neutral" : "negative";
  return {
    value: clamp100(evidence),
    known: true,
    passed: evidence >= EVIDENCE_FLOOR,
    tone,
    detail: `Intelligence profile ${clamp100(evidence)}% enriched`,
  };
}

function territoryCriterion(territory: Territory, country: string | null, location: string | null): Built {
  if (territory === "uk") {
    const where = (location ?? country ?? "UK").trim() || "UK";
    return { value: 100, known: true, passed: true, tone: "positive", detail: `UK-based — in market (${where})` };
  }
  if (territory === "overseas") {
    const where = (country ?? location ?? "overseas").trim() || "overseas";
    return { value: 0, known: true, passed: false, tone: "negative", detail: `Outside the UK market (${where})` };
  }
  return { value: 0, known: false, passed: null, tone: "neutral", detail: "Territory unknown" };
}

function sectorCriterion(sectorClass: SectorClass, sector: string | null, industry: string | null): Built {
  if (sectorClass === "construction") {
    const what = (sector ?? industry ?? "construction").trim() || "construction";
    return { value: 100, known: true, passed: true, tone: "positive", detail: `Construction sector (${what})` };
  }
  if (sectorClass === "other") {
    return {
      value: 35,
      known: true,
      passed: false,
      tone: "neutral",
      detail: `${(industry ?? "").trim() || "Sector"} — outside core construction ICP`,
    };
  }
  return { value: 0, known: false, passed: null, tone: "neutral", detail: "Sector not determined" };
}

function decisionMakerCriterion(count: number, reachable: number): Built {
  // The count is always observable, so this criterion is "known" even at zero.
  if (count <= 0) {
    return {
      value: 25,
      known: true,
      passed: false,
      tone: "negative",
      detail: "No decision makers identified yet",
    };
  }
  if (reachable >= 1) {
    return {
      value: 88,
      known: true,
      passed: true,
      tone: "positive",
      detail: `${count} decision maker${count === 1 ? "" : "s"} — ${reachable} with a direct channel`,
    };
  }
  return {
    value: 55,
    known: true,
    passed: false,
    tone: "neutral",
    detail: `${count} decision maker${count === 1 ? "" : "s"} — no direct channel yet`,
  };
}

// ---------------------------------------------------------------------
// Assembly + the decision rule.
// ---------------------------------------------------------------------

type CriterionSpec = {
  key: string;
  label: string;
  weight: number;
  build: (i: QualificationInput, ctx: Ctx) => Built;
};

type Ctx = { territory: Territory; sectorClass: SectorClass };

const CRITERIA: ReadonlyArray<CriterionSpec> = [
  { key: "fit_score", label: "Fit score", weight: 0.45, build: (i) => fitCriterion(i.score) },
  { key: "evidence", label: "Evidence depth", weight: 0.15, build: (i) => evidenceCriterion(i.evidence, i.researched) },
  { key: "territory", label: "Territory", weight: 0.2, build: (i, c) => territoryCriterion(c.territory, i.country, i.location) },
  { key: "sector", label: "Sector", weight: 0.1, build: (i, c) => sectorCriterion(c.sectorClass, i.sector, i.industry) },
  {
    key: "decision_maker_access",
    label: "Decision-maker access",
    weight: 0.1,
    build: (i) => decisionMakerCriterion(i.decisionMakers, i.reachableDecisionMakers),
  },
];

function clamp100(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function qualifyCompany(input: QualificationInput): QualificationVerdict {
  const score = clampScore(input.score);
  const territory = territoryOf(input.country, input.location);
  const sectorClass = sectorOf(input.sector, input.industry);
  const ctx: Ctx = { territory, sectorClass };

  // Build the explainable criteria + the confidence (share of known weight).
  const criteria: QualificationCriterion[] = [];
  let knownWeight = 0;
  let totalWeight = 0;
  for (const spec of CRITERIA) {
    const built = spec.build(input, ctx);
    totalWeight += spec.weight;
    if (built.known) knownWeight += spec.weight;
    criteria.push({ key: spec.key, label: spec.label, weight: spec.weight, ...built });
  }
  const confidence = totalWeight > 0 ? Math.round((knownWeight / totalWeight) * 100) : 0;

  // The decision rule. Territory is the only hard gate; the score arbitrates
  // everything in-territory, with evidence as a guard against thin data.
  let decision: QualificationDecision;
  const rationale: string[] = [];

  if (territory === "overseas") {
    decision = "disqualified";
    rationale.push(
      `Outside the UK construction market${input.country ? ` (${input.country.trim()})` : ""} — out of territory.`,
    );
  } else if (score == null) {
    decision = "review";
    rationale.push("No AI fit score yet — research the company before a qualification call can be made.");
  } else if (score >= QUALIFY_THRESHOLD) {
    if (input.evidence != null && input.evidence < EVIDENCE_FLOOR) {
      decision = "review";
      rationale.push(
        `Strong fit (${score}/100) but only ${clamp100(input.evidence)}% of the profile is enriched — verify before qualifying.`,
      );
    } else {
      decision = "qualified";
      rationale.push(
        `Strong fit: AI score ${score}/100 (${scoreBandLabel(score)}) clears the ${QUALIFY_THRESHOLD} qualification bar.`,
      );
    }
  } else if (score < DISQUALIFY_FLOOR) {
    decision = "disqualified";
    rationale.push(`Poor fit: AI score ${score}/100 is below the ${DISQUALIFY_FLOOR} disqualify floor.`);
  } else {
    decision = "review";
    rationale.push(
      `Marginal fit: AI score ${score}/100 sits between the ${DISQUALIFY_FLOOR} floor and the ${QUALIFY_THRESHOLD} bar — a human should decide.`,
    );
  }

  // Supporting notes — the strongest confirming + limiting signals, so the
  // operator sees the why beyond the headline rule.
  appendSupportingRationale(rationale, decision, ctx, criteria);

  return {
    decision,
    tier: scoreBand(score),
    score,
    confidence,
    criteria,
    recommendedStatus: recommendedStatusFor(decision),
    rationale,
    summary: summarise(decision, score, territory, input.evidence),
  };
}

function appendSupportingRationale(
  rationale: string[],
  decision: QualificationDecision,
  ctx: Ctx,
  criteria: QualificationCriterion[],
): void {
  // Territory confirmation only matters when it wasn't the decisive rule.
  if (decision !== "disqualified" && ctx.territory === "uk") {
    rationale.push("Confirmed in the UK market.");
  }
  if (ctx.sectorClass === "other") {
    rationale.push("Industry reads as outside core construction — confirm the fit.");
  }
  const dm = criteria.find((c) => c.key === "decision_maker_access");
  if (dm && dm.passed === false) {
    rationale.push(
      decision === "qualified"
        ? "No reachable decision maker yet — research a contact before outreach."
        : dm.detail + ".",
    );
  }
}

function summarise(
  decision: QualificationDecision,
  score: number | null,
  territory: Territory,
  evidence: number | null,
): string {
  if (decision === "qualified") {
    return `Qualified — strong fit (${score}/100, ${scoreBandLabel(score)}) in the UK construction market.`;
  }
  if (decision === "disqualified") {
    if (territory === "overseas") return "Disqualified — outside the UK construction market.";
    return `Disqualified — fit score ${score ?? "?"}/100 is below the qualification bar.`;
  }
  // review
  if (score == null) return "Held for review — not yet scored, no basis to qualify.";
  if (score >= QUALIFY_THRESHOLD && evidence != null && evidence < EVIDENCE_FLOOR) {
    return `Held for review — strong score but thin evidence (${clamp100(evidence)}% enriched).`;
  }
  return `Held for review — marginal fit (${score}/100), a human should decide.`;
}

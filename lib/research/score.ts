/**
 * CrewFlow HQ — Research AI transparent company score (CEO Directive 005,
 * Phase 6). Pure, server/client-safe.
 *
 * The directive is explicit: "Every score must include reasoning. No black
 * box." So this module never returns a bare number. It returns the ten factors
 * the directive names — Revenue Fit, Company Size, Digital Maturity, Buying
 * Intent, Growth, Technology, Construction Type, Location, Decision Maker
 * Access, Engagement — each carrying its own 0 to 100 value, weight, plain-English
 * reasoning, and a `known` flag, plus the composite blended over the factors we
 * actually have evidence for.
 *
 * Honesty rules baked in:
 *   • A factor with no supporting signal is still listed (so the operator sees
 *     the gap) but marked `known: false` and EXCLUDED from the composite — an
 *     unknown never silently drags a score to the middle.
 *   • `confidence` reports the share of weight that was actually known, so a
 *     thin profile yields a real-but-low-confidence score rather than a
 *     confident guess.
 *   • When nothing at all is known the composite is `null`, not 0.
 *
 * It reuses the existing `IntelligenceFactor` / `FactorTone` contract and the
 * shared `scoreBand` banding so the Research AI score renders through the same
 * Sales-AI reasoning UI with no new presentation vocabulary.
 */

import type { FactorTone, IntelligenceFactor } from "@/lib/sales/intelligence";
import { scoreBand, scoreBandLabel, type ScoreBand } from "@/lib/sales/model";
import type { CompanyIntelligence, DecisionMaker } from "./model";

// ---------------------------------------------------------------------
// Public shapes.
// ---------------------------------------------------------------------

/** A scoring factor that also records whether it had real evidence. */
export type ResearchScoreFactor = IntelligenceFactor & { known: boolean };

export type ResearchScore = {
  /** 0 to 100 weighted over KNOWN factors, or null when nothing is known. */
  overall: number | null;
  band: ScoreBand;
  bandLabel: string;
  /** 0 to 100 share of total weight that was backed by evidence. */
  confidence: number;
  /** All ten factors, always present, in the directive's order. */
  factors: ResearchScoreFactor[];
};

/** Everything the runner has after analysis — the inputs the score reads. */
export type ResearchScoreInput = {
  intelligence: CompanyIntelligence;
  decisionMakers: ReadonlyArray<DecisionMaker>;
  /** Names of technologies detected on the site (deterministic extraction). */
  detectedTechnologies: ReadonlyArray<string>;
  /** Free-text company location/region from the CRM record, if any. */
  location: string | null;
  /** 0 to 100 live relationship score from the timeline, or null (no contact). */
  relationshipScore: number | null;
};

// ---------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------

function clamp100(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function toneFor(value: number): FactorTone {
  if (value >= 60) return "positive";
  if (value >= 40) return "neutral";
  return "negative";
}

type Built = { value: number; known: boolean; detail: string; tone?: FactorTone };

function isNum(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n);
}

function firstNum(...vals: Array<number | null | undefined>): number | null {
  for (const v of vals) if (isNum(v)) return v;
  return null;
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
  "property maintenance",
  "trades",
  "tradespeople",
  "plant hire",
  "civils",
];

function looksConstruction(...text: Array<string | null>): boolean {
  const hay = text.filter(Boolean).join(" ").toLowerCase();
  if (!hay) return false;
  return CONSTRUCTION_WORDS.some((w) => hay.includes(w));
}

const UK_WORDS = [
  "united kingdom",
  "england",
  "scotland",
  "wales",
  "northern ireland",
  "great britain",
  " uk",
  "uk ",
  "u.k",
  "london",
  "manchester",
  "birmingham",
  "leeds",
  "glasgow",
  "liverpool",
  "bristol",
  "sheffield",
  "edinburgh",
  "cardiff",
  "belfast",
  "yorkshire",
  "midlands",
  "essex",
  "kent",
  "surrey",
  "lancashire",
  "cheshire",
];

// ---------------------------------------------------------------------
// The ten factor builders. Each is pure and returns honest "unknown" when the
// supporting signal is absent.
// ---------------------------------------------------------------------

function revenueFit(intel: CompanyIntelligence): Built {
  const rev = firstNum(intel.revenueEstimateGbp);
  if (rev == null) {
    const spend = firstNum(intel.estimatedSoftwareSpendGbp);
    if (spend == null)
      return { value: 0, known: false, detail: "No revenue or software-spend estimate yet" };
    // Software spend as a weaker proxy for budget.
    const v = spend >= 1000 ? 78 : spend >= 300 ? 62 : 45;
    return {
      value: v,
      known: true,
      detail: `Est. software spend ~£${Math.round(spend).toLocaleString("en-GB")}/mo (revenue unknown)`,
    };
  }
  const m = (n: number) => `Est. revenue ~£${Math.round(n).toLocaleString("en-GB")}`;
  if (rev < 250_000) return { value: 35, known: true, detail: `${m(rev)} — likely too small to invest` };
  if (rev < 500_000) return { value: 56, known: true, detail: `${m(rev)} — emerging, watch budget` };
  if (rev < 2_000_000) return { value: 82, known: true, detail: `${m(rev)} — core ICP band` };
  if (rev < 10_000_000) return { value: 90, known: true, detail: `${m(rev)} — strong budget fit` };
  if (rev < 30_000_000) return { value: 76, known: true, detail: `${m(rev)} — larger, may have incumbents` };
  return { value: 58, known: true, detail: `${m(rev)} — enterprise, likely bespoke tooling` };
}

function companySize(intel: CompanyIntelligence): Built {
  const heads = firstNum(intel.employeeEstimate, intel.staffSize);
  const fleet = firstNum(intel.fleetSize);
  if (heads == null) {
    if (fleet != null && fleet >= 2) {
      const v = fleet >= 5 ? 78 : 62;
      return { value: v, known: true, detail: `~${fleet} vehicles in fleet (headcount unknown)` };
    }
    return { value: 0, known: false, detail: "No headcount or fleet estimate yet" };
  }
  const f = fleet != null ? ` · ~${fleet} vehicles` : "";
  const m = (n: number) => `~${n} staff${f}`;
  if (heads < 3) return { value: 36, known: true, detail: `${m(heads)} — very small` };
  if (heads < 10) return { value: 70, known: true, detail: `${m(heads)} — small team, good fit` };
  if (heads < 50) return { value: 90, known: true, detail: `${m(heads)} — core ICP` };
  if (heads < 150) return { value: 84, known: true, detail: `${m(heads)} — strong fit` };
  if (heads < 250) return { value: 70, known: true, detail: `${m(heads)} — larger, longer cycle` };
  return { value: 54, known: true, detail: `${m(heads)} — enterprise scale` };
}

function digitalMaturity(intel: CompanyIntelligence): Built {
  const dm = firstNum(intel.digitalMaturityScore);
  if (dm == null) return { value: 0, known: false, detail: "Digital maturity not assessed" };
  // Moderate-to-high maturity = ready for SaaS without being over-tooled.
  const detail =
    dm >= 70
      ? "Digitally mature — invests in its web channel"
      : dm >= 40
        ? "Some digital adoption"
        : "Low digital maturity — early adopter risk";
  return { value: dm, known: true, detail: `${detail} (${dm}/100)` };
}

function buyingIntent(intel: CompanyIntelligence): Built {
  const signals = intel.buyingSignals.filter(Boolean);
  const urgency = (intel.urgency ?? "").toLowerCase();
  const urgent = /urgent|immediate|asap|now|this (week|month)|growing fast|expanding/.test(urgency);
  // Absence of signals is observable, so this factor is "known" even at zero.
  let value: number;
  if (signals.length === 0) value = 30;
  else if (signals.length === 1) value = 56;
  else if (signals.length === 2) value = 70;
  else if (signals.length === 3) value = 82;
  else value = 90;
  if (urgent) value = clamp100(value + 10);
  const detail =
    signals.length === 0
      ? "No explicit buying signals observed"
      : `${signals.length} buying signal${signals.length === 1 ? "" : "s"}${urgent ? " · stated urgency" : ""}`;
  return { value, known: true, detail };
}

function growth(intel: CompanyIntelligence): Built {
  const gs = firstNum(intel.growthScore);
  const indicators = intel.growthIndicators.filter(Boolean);
  const hiring = Boolean(intel.recruitmentActivity);
  if (gs != null) {
    const extra = hiring ? " · actively recruiting" : "";
    return { value: gs, known: true, detail: `Growth signals ${gs}/100${extra}` };
  }
  if (indicators.length === 0 && !hiring)
    return { value: 0, known: false, detail: "No growth or recruitment signals found" };
  let value = indicators.length >= 3 ? 84 : indicators.length === 2 ? 72 : indicators.length === 1 ? 58 : 40;
  if (hiring) value = clamp100(value + 12);
  const bits = [
    indicators.length ? `${indicators.length} growth indicator${indicators.length === 1 ? "" : "s"}` : null,
    hiring ? "actively recruiting" : null,
  ].filter(Boolean);
  return { value, known: true, detail: bits.join(" · ") };
}

function technology(
  intel: CompanyIntelligence,
  detected: ReadonlyArray<string>,
): Built {
  const stack = new Set<string>(
    [...intel.softwareUsed, ...detected].map((s) => s.trim()).filter(Boolean),
  );
  const n = stack.size;
  if (n === 0)
    return {
      value: 42,
      known: true,
      detail: "No software stack detected — greenfield",
    };
  const names = [...stack].slice(0, 4).join(", ");
  const value = n >= 5 ? 88 : n >= 3 ? 78 : 64;
  return {
    value,
    known: true,
    detail: `${n} tool${n === 1 ? "" : "s"} detected: ${names}${n > 4 ? "…" : ""}`,
  };
}

function constructionType(intel: CompanyIntelligence): Built {
  if (intel.constructionSector) {
    return { value: 88, known: true, detail: `Construction sector: ${intel.constructionSector}` };
  }
  const services = intel.services.join(" ");
  const isConstruction = looksConstruction(intel.industry, intel.overview, services, intel.specialisms.join(" "));
  if (isConstruction) return { value: 80, known: true, detail: "Construction trade identified from profile" };
  if (intel.industry)
    return { value: 30, known: true, detail: `${intel.industry} — outside core construction ICP` };
  return { value: 0, known: false, detail: "Sector not determined" };
}

function location(intel: CompanyIntelligence, loc: string | null): Built {
  const hay = [loc, intel.geographicCoverage, ...intel.locations].filter(Boolean).join(" ").toLowerCase();
  if (!hay) return { value: 0, known: false, detail: "Location unknown" };
  const isUk = UK_WORDS.some((w) => hay.includes(w.trim()));
  if (isUk) {
    const where = loc || intel.locations[0] || intel.geographicCoverage || "UK";
    return { value: 90, known: true, detail: `UK-based — in market (${where})` };
  }
  if (/ireland|dublin/.test(hay)) return { value: 58, known: true, detail: "Ireland — adjacent market" };
  return { value: 32, known: true, detail: `Outside UK market (${loc ?? intel.locations[0] ?? "overseas"})` };
}

function decisionMakerAccess(dms: ReadonlyArray<DecisionMaker>): Built {
  if (dms.length === 0)
    return { value: 30, known: true, detail: "No decision makers identified yet" };
  const withEmail = dms.filter((d) => d.email).length;
  const withLinkedIn = dms.filter((d) => d.linkedinUrl).length;
  let value: number;
  let how: string;
  if (withEmail > 0) {
    value = 90;
    how = `${withEmail} with a public email`;
  } else if (withLinkedIn > 0) {
    value = 74;
    how = `${withLinkedIn} reachable on LinkedIn`;
  } else {
    value = 58;
    how = "named, no direct channel yet";
  }
  // Marginal credit for breadth of the buying committee.
  if (dms.length >= 2) value = clamp100(value + 4);
  return { value, known: true, detail: `${dms.length} decision maker${dms.length === 1 ? "" : "s"} — ${how}` };
}

function engagement(relationshipScore: number | null): Built {
  if (relationshipScore == null)
    return { value: 0, known: false, detail: "No contact history yet" };
  const detail =
    relationshipScore >= 60
      ? "Active relationship from contact history"
      : relationshipScore >= 30
        ? "Some prior contact"
        : "Minimal prior contact";
  return { value: relationshipScore, known: true, detail: `${detail} (${relationshipScore}/100)` };
}

// ---------------------------------------------------------------------
// Assembly.
// ---------------------------------------------------------------------

type FactorSpec = {
  key: string;
  label: string;
  weight: number;
  build: (i: ResearchScoreInput) => Built;
};

/** The directive's ten factors, with weights summing to 1.0. */
const FACTOR_SPECS: ReadonlyArray<FactorSpec> = [
  { key: "revenue_fit", label: "Revenue fit", weight: 0.14, build: (i) => revenueFit(i.intelligence) },
  { key: "company_size", label: "Company size", weight: 0.12, build: (i) => companySize(i.intelligence) },
  { key: "buying_intent", label: "Buying intent", weight: 0.12, build: (i) => buyingIntent(i.intelligence) },
  { key: "construction_type", label: "Construction type", weight: 0.1, build: (i) => constructionType(i.intelligence) },
  { key: "digital_maturity", label: "Digital maturity", weight: 0.1, build: (i) => digitalMaturity(i.intelligence) },
  { key: "growth", label: "Growth", weight: 0.1, build: (i) => growth(i.intelligence) },
  { key: "technology", label: "Technology", weight: 0.08, build: (i) => technology(i.intelligence, i.detectedTechnologies) },
  { key: "location", label: "Location", weight: 0.08, build: (i) => location(i.intelligence, i.location) },
  { key: "decision_maker_access", label: "Decision maker access", weight: 0.08, build: (i) => decisionMakerAccess(i.decisionMakers) },
  { key: "engagement", label: "Engagement", weight: 0.08, build: (i) => engagement(i.relationshipScore) },
];

export function scoreCompany(input: ResearchScoreInput): ResearchScore {
  const factors: ResearchScoreFactor[] = [];
  let weighted = 0;
  let knownWeight = 0;
  let totalWeight = 0;

  for (const spec of FACTOR_SPECS) {
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
      value: built.known ? value : 0,
      weight: spec.weight,
      detail: built.detail,
      tone: built.known ? (built.tone ?? toneFor(value)) : "neutral",
      known: built.known,
    });
  }

  const overall = knownWeight > 0 ? clamp100(weighted / knownWeight) : null;
  const confidence =
    totalWeight > 0 ? Math.round((knownWeight / totalWeight) * 100) : 0;

  return {
    overall,
    band: scoreBand(overall),
    bandLabel: scoreBandLabel(overall),
    confidence,
    factors,
  };
}

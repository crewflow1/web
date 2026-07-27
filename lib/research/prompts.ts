/**
 * CrewFlow HQ — Research AI prompt + parse layer (CEO Directive 005,
 * Phases 2–5). Pure, server/client-safe (no Supabase, no SDK import).
 *
 * The runner fetches REAL page content and lifts deterministic signals
 * (lib/research/extract.ts); this module turns that real evidence into two
 * tightly-scoped LLM calls and safely parses what comes back:
 *
 *   1. ANALYSIS  → CompanyIntelligence + DecisionMaker[]   (Phases 2–3)
 *   2. SALES PREP → SalesBrief + CommsDrafts               (Phases 4–5)
 *
 * Splitting the work keeps each JSON small enough to come back whole inside a
 * single function invocation, and maps cleanly onto the lifecycle (Analysing →
 * Reasoning).
 *
 * The contract is enforced twice over. The prompt itself forbids invention —
 * "if the SOURCE does not state it, the value is null / []" — and then every
 * parser re-validates and coerces, so a hallucinated string where a number
 * belongs, or a missing field, degrades to the honest null rather than crashing
 * the run or persisting a fabricated figure. Nothing here ever sends anything:
 * the drafts are drafts.
 */

import {
  emptyIntelligence,
  type CommsDrafts,
  type CompanyIntelligence,
  type DecisionMaker,
  type SalesBrief,
} from "./model";

// ---------------------------------------------------------------------
// CrewFlow product context — so the brief + drafts recommend the REAL product,
// not an invented one. The model may only recommend from these modules.
// ---------------------------------------------------------------------

export const CREWFLOW_MODULES = [
  "Job Management",
  "Scheduling & Dispatch",
  "Quotes & Estimates",
  "Invoicing & Payments",
  "Timesheets & Time Tracking",
  "Team & Staff Management",
  "Fleet & Vehicle Tracking",
  "Compliance & Certifications",
  "Customer CRM",
  "Job Documents & Photos",
  "AI Receptionist",
  "Reporting & Analytics",
] as const;

const CREWFLOW_CONTEXT = `CrewFlow is a UK-built operations platform for construction and field-service businesses (builders, contractors, trades, maintenance and plant firms). It replaces spreadsheets, paper and disconnected apps with one system covering: ${CREWFLOW_MODULES.join(
  ", ",
)}. It is pitched at SMB construction firms (roughly 5–250 staff) who are growing and feeling the pain of manual admin, missed jobs, slow invoicing, compliance risk and poor visibility across crews and vehicles.`;

// ---------------------------------------------------------------------
// JSON extraction — strip fences, parse, regex-fallback.
// ---------------------------------------------------------------------

/** Best-effort parse of an LLM response into a JS object. Returns null when
 *  the text contains no recoverable JSON object. */
export function extractJson(raw: string): unknown | null {
  if (!raw) return null;
  let text = raw.trim();
  // Strip ```json … ``` or ``` … ``` fences.
  text = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(text);
  } catch {
    // Fallback: grab the outermost brace-delimited span.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------
// Coercion helpers — every value the model returns passes through these.
// ---------------------------------------------------------------------

function rec(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : {};
}

function asString(x: unknown, max = 2000): string | null {
  if (typeof x !== "string") return null;
  const t = x.trim();
  if (!t) return null;
  const low = t.toLowerCase();
  // The model was told to use null; guard against it stringifying "unknown".
  if (low === "unknown" || low === "n/a" || low === "null" || low === "none")
    return null;
  return t.length > max ? t.slice(0, max) : t;
}

function asStr(x: unknown, fallback = "", max = 4000): string {
  return asString(x, max) ?? fallback;
}

function asStringArray(x: unknown, cap = 20, itemMax = 500): string[] {
  if (!Array.isArray(x)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of x) {
    const s = asString(item, itemMax);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/** Finite non-negative number, else null. Used for counts + GBP estimates. */
function asPosNumber(x: unknown): number | null {
  const n = typeof x === "string" ? Number(x.replace(/[,£$\s]/g, "")) : Number(x);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** 0–100 integer, else null. */
function asScore(x: unknown): number | null {
  const n = asPosNumber(x);
  if (n == null) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

const SENIORITIES = new Set<DecisionMaker["seniority"]>([
  "c_level",
  "director",
  "manager",
  "other",
  "unknown",
]);

function asSeniority(x: unknown): DecisionMaker["seniority"] {
  if (typeof x === "string" && SENIORITIES.has(x as DecisionMaker["seniority"]))
    return x as DecisionMaker["seniority"];
  return "unknown";
}

function asEmail(x: unknown): string | null {
  const s = asString(x, 200);
  if (!s) return null;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s.toLowerCase() : null;
}

function asUrl(x: unknown): string | null {
  const s = asString(x, 500);
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : null;
}

// ---------------------------------------------------------------------
// Prompt 1 — analysis (CompanyIntelligence + DecisionMaker[]).
// ---------------------------------------------------------------------

export type AnalysisSignals = {
  title: string | null;
  metaDescription: string | null;
  emails: ReadonlyArray<string>;
  phones: ReadonlyArray<string>;
  socials: {
    linkedin: string | null;
    instagram: string | null;
    facebook: string | null;
    twitter: string | null;
    youtube: string | null;
  };
  technologies: ReadonlyArray<string>;
  hiring: boolean;
};

export type AnalysisPromptInput = {
  companyName: string | null;
  domain: string | null;
  signals: AnalysisSignals;
  /** Bounded, tag-stripped visible text from the fetched page(s). */
  siteText: string;
  /** Pre-formatted Companies House facts block, or null when unavailable. */
  companiesHouseText: string | null;
};

const ANALYSIS_SYSTEM = `You are Research AI for CrewFlow, an autonomous company-research specialist. You analyse the REAL fetched content of one company and produce a structured intelligence profile and a list of decision makers.

ABSOLUTE RULES:
- Never invent data. If the SOURCE TEXT does not state or clearly imply something, the value is null (for single values) or [] (for lists). "Unknown" is the correct, expected answer for much of this — do not guess.
- Every number must be grounded in the source. Estimates are allowed ONLY when the text gives a basis (e.g. "established 1998" → yearsTrading; "team of 40" → employeeEstimate); otherwise null.
- Only list a decision maker who is actually named in the source. Never fabricate a person, email, or LinkedIn URL. Use null for any field you cannot evidence.
- Output STRICT JSON only — no prose, no markdown, no code fences.`;

function bulletList(label: string, items: ReadonlyArray<string>): string {
  if (items.length === 0) return `${label}: (none found)`;
  return `${label}:\n${items.map((i) => `  - ${i}`).join("\n")}`;
}

export function buildAnalysisMessages(input: AnalysisPromptInput): {
  system: string;
  user: string;
} {
  const { signals } = input;
  const socials = Object.entries(signals.socials)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`);

  const evidence = [
    `COMPANY: ${input.companyName ?? "(name unknown)"}`,
    input.domain ? `DOMAIN: ${input.domain}` : null,
    signals.title ? `PAGE TITLE: ${signals.title}` : null,
    signals.metaDescription ? `META DESCRIPTION: ${signals.metaDescription}` : null,
    bulletList("PUBLIC EMAILS FOUND", signals.emails),
    bulletList("PUBLIC PHONES FOUND", signals.phones),
    bulletList("SOCIAL PROFILES FOUND", socials),
    bulletList("TECHNOLOGIES DETECTED", signals.technologies),
    `RECRUITMENT SIGNAL ON SITE: ${signals.hiring ? "yes" : "none detected"}`,
    input.companiesHouseText ? `COMPANIES HOUSE:\n${input.companiesHouseText}` : null,
    "",
    "WEBSITE TEXT (verbatim, may be truncated):",
    input.siteText || "(no readable text was extracted)",
  ]
    .filter(Boolean)
    .join("\n");

  const schema = `Return STRICT JSON with exactly this shape:
{
  "intelligence": {
    "overview": string|null,                // 1-3 sentence factual summary, from the text only
    "industry": string|null,
    "constructionSector": string|null,      // e.g. "Groundworks", "Roofing", "M&E", null if not construction/unknown
    "services": string[],                    // services the company actually lists
    "specialisms": string[],
    "employeeEstimate": number|null,         // only if the text gives a basis
    "revenueEstimateGbp": number|null,       // only if stated/strongly implied
    "estimatedSoftwareSpendGbp": number|null,// monthly, only if inferable
    "fleetSize": number|null,
    "staffSize": number|null,
    "yearsTrading": number|null,             // e.g. from "established 2005"
    "locations": string[],                   // towns/cities/regions stated
    "geographicCoverage": string|null,       // e.g. "South-East England", "Nationwide"
    "softwareUsed": string[],                // tools the company mentions using
    "painPoints": string[],                  // operational pains evident or implied
    "buyingSignals": string[],               // signs they might buy ops software
    "growthIndicators": string[],            // expansion, new sites, awards, hiring
    "recruitmentActivity": string|null,      // summary if they are hiring, else null
    "urgency": string|null,                  // any time pressure evident
    "marketingQualityScore": number|null,    // 0-100, your read of their marketing
    "hiringActivityScore": number|null,      // 0-100
    "growthScore": number|null,              // 0-100
    "confidence": number|null                // 0-100, your confidence in this profile
  },
  "decisionMakers": [
    {
      "fullName": string,                    // must be named in the source
      "title": string|null,
      "seniority": "c_level"|"director"|"manager"|"other"|"unknown",
      "email": string|null,                  // only a real, evidenced address
      "linkedinUrl": string|null,
      "confidence": number|null,             // 0-100
      "reasoning": string|null               // why you believe this, citing the source
    }
  ]
}
Leave websiteQualityScore and digitalMaturityScore OUT — those are computed deterministically. If you found no decision makers, return "decisionMakers": [].`;

  return {
    system: ANALYSIS_SYSTEM,
    user: `Analyse this company from the evidence below. Ground every field in the source; use null/[] for anything not evidenced.\n\n=== EVIDENCE ===\n${evidence}\n\n=== OUTPUT ===\n${schema}`,
  };
}

export type ParsedAnalysis = {
  intelligence: CompanyIntelligence;
  decisionMakers: DecisionMaker[];
};

export function parseAnalysis(raw: string): ParsedAnalysis | null {
  const parsed = extractJson(raw);
  if (!parsed) return null;
  const root = rec(parsed);
  const i = rec(root.intelligence);

  const intelligence: CompanyIntelligence = {
    ...emptyIntelligence(),
    overview: asString(i.overview, 1200),
    industry: asString(i.industry, 200),
    constructionSector: asString(i.constructionSector, 200),
    services: asStringArray(i.services, 24),
    specialisms: asStringArray(i.specialisms, 24),
    employeeEstimate: asPosNumber(i.employeeEstimate),
    revenueEstimateGbp: asPosNumber(i.revenueEstimateGbp),
    estimatedSoftwareSpendGbp: asPosNumber(i.estimatedSoftwareSpendGbp),
    fleetSize: asPosNumber(i.fleetSize),
    staffSize: asPosNumber(i.staffSize),
    yearsTrading: asPosNumber(i.yearsTrading),
    locations: asStringArray(i.locations, 16),
    geographicCoverage: asString(i.geographicCoverage, 200),
    softwareUsed: asStringArray(i.softwareUsed, 24),
    painPoints: asStringArray(i.painPoints, 16),
    buyingSignals: asStringArray(i.buyingSignals, 16),
    growthIndicators: asStringArray(i.growthIndicators, 16),
    recruitmentActivity: asString(i.recruitmentActivity, 600),
    urgency: asString(i.urgency, 400),
    // websiteQualityScore + digitalMaturityScore are filled deterministically.
    marketingQualityScore: asScore(i.marketingQualityScore),
    hiringActivityScore: asScore(i.hiringActivityScore),
    growthScore: asScore(i.growthScore),
    confidence: asScore(i.confidence),
  };

  const dmRaw = Array.isArray(root.decisionMakers) ? root.decisionMakers : [];
  const decisionMakers: DecisionMaker[] = [];
  for (const d of dmRaw) {
    const o = rec(d);
    const fullName = asString(o.fullName, 160);
    if (!fullName) continue; // a DM with no name is not a DM
    decisionMakers.push({
      fullName,
      title: asString(o.title, 200),
      seniority: asSeniority(o.seniority),
      email: asEmail(o.email),
      linkedinUrl: asUrl(o.linkedinUrl),
      confidence: asScore(o.confidence),
      reasoning: asString(o.reasoning, 600),
    });
    if (decisionMakers.length >= 12) break;
  }

  return { intelligence, decisionMakers };
}

// ---------------------------------------------------------------------
// Prompt 2 — sales preparation (SalesBrief + CommsDrafts).
// ---------------------------------------------------------------------

export type SalesPromptInput = {
  companyName: string | null;
  intelligence: CompanyIntelligence;
  decisionMakers: ReadonlyArray<DecisionMaker>;
  /** The transparent score + band, to ground the brief in reality. */
  score: number | null;
  scoreBandLabel: string;
  /** Top reasoning factors ("Construction type — clear fit", …). */
  topFactors: ReadonlyArray<{ label: string; detail: string }>;
};

const SALES_SYSTEM = `You are Research AI for CrewFlow, preparing a salesperson for first contact with a company you have just analysed. You write a practical sales brief and DRAFT outreach.

${CREWFLOW_CONTEXT}

ABSOLUTE RULES:
- These are DRAFTS for a human to review and send. You never send anything.
- Be specific to THIS company using the analysis provided; do not invent facts about them. If you lack a fact, write around it rather than fabricating one.
- Only recommend CrewFlow modules from the provided product list, and only ones that map to this company's evidenced pain points.
- British English. Confident, concise, no hype, no false claims, no fake social proof or invented customer names.
- Output STRICT JSON only — no prose, no markdown, no code fences.`;

export function buildSalesMessages(input: SalesPromptInput): {
  system: string;
  user: string;
} {
  const intel = input.intelligence;
  const dmSummary =
    input.decisionMakers.length > 0
      ? input.decisionMakers
          .map((d) => `  - ${d.fullName}${d.title ? `, ${d.title}` : ""} (${d.seniority})`)
          .join("\n")
      : "  (none identified)";

  const analysis = [
    `COMPANY: ${input.companyName ?? "(unknown)"}`,
    intel.overview ? `OVERVIEW: ${intel.overview}` : null,
    intel.constructionSector ? `SECTOR: ${intel.constructionSector}` : null,
    intel.industry ? `INDUSTRY: ${intel.industry}` : null,
    bulletList("SERVICES", intel.services),
    bulletList("PAIN POINTS", intel.painPoints),
    bulletList("BUYING SIGNALS", intel.buyingSignals),
    bulletList("GROWTH INDICATORS", intel.growthIndicators),
    bulletList("SOFTWARE THEY USE", intel.softwareUsed),
    `BUYING SCORE: ${input.score ?? "n/a"} / 100 (${input.scoreBandLabel})`,
    bulletList(
      "SCORE REASONING",
      input.topFactors.map((f) => `${f.label}: ${f.detail}`),
    ),
    `DECISION MAKERS:\n${dmSummary}`,
    `AVAILABLE CREWFLOW MODULES: ${CREWFLOW_MODULES.join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");

  const schema = `Return STRICT JSON with exactly this shape (all strings non-empty, written for THIS company):
{
  "brief": {
    "coldCallOpener": string,
    "discoveryQuestions": string[],     // 4-7 questions
    "likelyObjections": string[],       // 3-5
    "objectionResponses": string[],     // aligned 1:1 with likelyObjections
    "valueProposition": string,
    "recommendedModules": string[],     // from the CrewFlow list only
    "demoFocus": string,
    "meetingAgenda": string[],          // 3-5 items
    "bestAngle": string,
    "bestTimeToCall": string|null
  },
  "drafts": {
    "coldEmailSubject": string,
    "coldEmail": string,
    "linkedinMessage": string,
    "followUpEmail": string,
    "voicemailScript": string,
    "firstCallOpening": string,
    "demoConfirmation": string
  }
}`;

  return {
    system: SALES_SYSTEM,
    user: `Prepare the salesperson using this analysis. Keep it specific and honest.\n\n=== ANALYSIS ===\n${analysis}\n\n=== OUTPUT ===\n${schema}`,
  };
}

export type ParsedSalesPrep = {
  brief: SalesBrief;
  drafts: CommsDrafts;
};

/** Modules the model may legally recommend (lower-cased for matching). */
const MODULE_SET = new Set(CREWFLOW_MODULES.map((m) => m.toLowerCase()));

export function parseSalesPrep(raw: string): ParsedSalesPrep | null {
  const parsed = extractJson(raw);
  if (!parsed) return null;
  const root = rec(parsed);
  const b = rec(root.brief);
  const d = rec(root.drafts);

  // Keep only recommended modules that are real CrewFlow modules.
  const recommendedModules = asStringArray(b.recommendedModules, 12).filter((m) =>
    MODULE_SET.has(m.toLowerCase()),
  );

  const brief: SalesBrief = {
    coldCallOpener: asStr(b.coldCallOpener),
    discoveryQuestions: asStringArray(b.discoveryQuestions, 10, 400),
    likelyObjections: asStringArray(b.likelyObjections, 8, 400),
    objectionResponses: asStringArray(b.objectionResponses, 8, 600),
    valueProposition: asStr(b.valueProposition),
    recommendedModules,
    demoFocus: asStr(b.demoFocus),
    meetingAgenda: asStringArray(b.meetingAgenda, 8, 300),
    bestAngle: asStr(b.bestAngle),
    bestTimeToCall: asString(b.bestTimeToCall, 200),
  };

  const drafts: CommsDrafts = {
    coldEmailSubject: asStr(d.coldEmailSubject, "", 300),
    coldEmail: asStr(d.coldEmail, "", 6000),
    linkedinMessage: asStr(d.linkedinMessage, "", 2000),
    followUpEmail: asStr(d.followUpEmail, "", 6000),
    voicemailScript: asStr(d.voicemailScript, "", 2000),
    firstCallOpening: asStr(d.firstCallOpening, "", 2000),
    demoConfirmation: asStr(d.demoConfirmation, "", 3000),
  };

  return { brief, drafts };
}

/** True when an analysis produced at least one substantive field — the runner
 *  uses this to decide whether the LLM leg actually contributed anything. */
export function analysisHasContent(a: ParsedAnalysis): boolean {
  const i = a.intelligence;
  return Boolean(
    i.overview ||
      i.industry ||
      i.services.length ||
      i.painPoints.length ||
      a.decisionMakers.length,
  );
}

/** True when the sales prep produced a usable brief or any draft. */
export function salesPrepHasContent(s: ParsedSalesPrep): boolean {
  return Boolean(
    s.brief.coldCallOpener ||
      s.brief.valueProposition ||
      s.drafts.coldEmail ||
      s.drafts.linkedinMessage,
  );
}

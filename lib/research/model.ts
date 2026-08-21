/**
 * CrewFlow HQ — Research AI lifecycle + contracts (CEO Directive 005).
 *
 * Server/client-safe pure layer. NO Supabase, NO server-only imports — the
 * runner (server/services/hq-research.ts), the prompt builders
 * (lib/research/prompts.ts) and the live UI all share these types, and the
 * lifecycle helpers are unit-tested directly.
 *
 * Two state vocabularies live here:
 *
 *   • ResearchPhase  — the coarse lifecycle the directive names
 *     (Queued → Running → Researching → Analysing → Scoring → Reasoning →
 *     Completed / Failed). Persisted in hq_sales_ai_tasks.result.phase.
 *
 *   • ResearchStep   — the fine-grained checklist an operator watches live
 *     (website analysed, technologies detected, decision makers identified,
 *     AI score calculated, memory updated, task completed …). Each step is
 *     mirrored to a hq_sales_timeline_events row for the permanent audit
 *     trail (Phase 9) AND to result.steps for fast polling.
 *
 * The structured AI-output contracts (CompanyIntelligence, DecisionMaker,
 * SalesBrief, CommsDrafts) are deliberately all-nullable: when a source does
 * not state something the honest value is null / "unknown". Nothing here ever
 * fabricates a figure.
 */

// ---------------------------------------------------------------------
// Coarse lifecycle phase.
// ---------------------------------------------------------------------

export const RESEARCH_PHASES = [
  "queued",
  "running",
  "researching",
  "analysing",
  "scoring",
  "reasoning",
  "completed",
  "failed",
] as const;
export type ResearchPhase = (typeof RESEARCH_PHASES)[number];

export const RESEARCH_PHASE_LABELS: Record<ResearchPhase, string> = {
  queued: "Queued",
  running: "Starting up",
  researching: "Researching",
  analysing: "Analysing",
  scoring: "Scoring",
  reasoning: "Reasoning",
  completed: "Completed",
  failed: "Failed",
};

/** Coarse task status, mirroring hq_sales_ai_tasks.status. */
export type ResearchTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** 0 to 1 progress for a smooth bar; the live phases advance monotonically. */
export function phaseProgress(phase: ResearchPhase): number {
  switch (phase) {
    case "queued":
      return 0.04;
    case "running":
      return 0.1;
    case "researching":
      return 0.34;
    case "analysing":
      return 0.62;
    case "scoring":
      return 0.78;
    case "reasoning":
      return 0.92;
    case "completed":
      return 1;
    case "failed":
      return 1;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------
// Fine-grained live checklist.
// ---------------------------------------------------------------------

export type ResearchStepKey =
  | "website"
  | "technology"
  | "contacts"
  | "companies_house"
  | "intelligence"
  | "decision_makers"
  | "score"
  | "brief"
  | "drafts"
  | "memory"
  | "completed";

export type ResearchStepStatus =
  | "pending"
  | "active"
  | "done"
  | "skipped"
  | "failed";

/** Static definition of every step: its label, the phase it belongs to, and
 *  the hq_sales_timeline_events.event_type it is logged under. */
export type ResearchStepDef = {
  key: ResearchStepKey;
  label: string;
  phase: ResearchPhase;
  /** Must be a value of the hq_sales_timeline_events event_type check. */
  eventType: string;
};

export const RESEARCH_STEP_DEFS: ReadonlyArray<ResearchStepDef> = [
  { key: "website", label: "Website analysed", phase: "researching", eventType: "research" },
  { key: "technology", label: "Technologies detected", phase: "researching", eventType: "enriched" },
  { key: "contacts", label: "Contact channels extracted", phase: "researching", eventType: "enriched" },
  { key: "companies_house", label: "Companies House checked", phase: "researching", eventType: "enriched" },
  { key: "intelligence", label: "Company intelligence built", phase: "analysing", eventType: "enriched" },
  { key: "decision_makers", label: "Decision makers identified", phase: "analysing", eventType: "enriched" },
  { key: "score", label: "AI score calculated", phase: "scoring", eventType: "scored" },
  { key: "brief", label: "Sales brief created", phase: "reasoning", eventType: "recommendation" },
  { key: "drafts", label: "Outreach drafts generated", phase: "reasoning", eventType: "email_generated" },
  { key: "memory", label: "Shared Memory updated", phase: "reasoning", eventType: "system" },
  { key: "completed", label: "Task completed", phase: "completed", eventType: "task_completed" },
];

export const RESEARCH_STEP_LABEL: Record<ResearchStepKey, string> =
  Object.fromEntries(RESEARCH_STEP_DEFS.map((s) => [s.key, s.label])) as Record<
    ResearchStepKey,
    string
  >;

export function stepDef(key: ResearchStepKey): ResearchStepDef {
  const def = RESEARCH_STEP_DEFS.find((s) => s.key === key);
  if (!def) throw new Error(`Unknown research step: ${key}`);
  return def;
}

export function phaseForStep(key: ResearchStepKey): ResearchPhase {
  return stepDef(key).phase;
}

/** Live status of one checklist step, persisted in result.steps + polled. */
export type ResearchStepState = {
  key: ResearchStepKey;
  label: string;
  status: ResearchStepStatus;
  detail: string | null;
  at: string | null;
};

/** A fresh checklist with every step pending — written when the task starts. */
export function initialSteps(): ResearchStepState[] {
  return RESEARCH_STEP_DEFS.map((s) => ({
    key: s.key,
    label: s.label,
    status: "pending" as ResearchStepStatus,
    detail: null,
    at: null,
  }));
}

const TERMINAL_STEP_STATUSES: ReadonlySet<ResearchStepStatus> = new Set([
  "done",
  "skipped",
  "failed",
]);

export function isStepTerminal(status: ResearchStepStatus): boolean {
  return TERMINAL_STEP_STATUSES.has(status);
}

/**
 * Pure reducer: return a new steps array with one step set to a terminal (or
 * active) status. Unknown keys are ignored so a malformed result row never
 * throws in the UI. The matching step's `at` stamp is set for terminal moves.
 */
export function applyStep(
  steps: ReadonlyArray<ResearchStepState>,
  key: ResearchStepKey,
  status: ResearchStepStatus,
  detail: string | null = null,
  at: string = new Date().toISOString(),
): ResearchStepState[] {
  return steps.map((s) =>
    s.key === key
      ? { ...s, status, detail, at: isStepTerminal(status) ? at : s.at }
      : s,
  );
}

/** Count of steps that reached a terminal status — drives the "N of M" label. */
export function completedStepCount(
  steps: ReadonlyArray<ResearchStepState>,
): number {
  return steps.filter((s) => isStepTerminal(s.status)).length;
}

// ---------------------------------------------------------------------
// Structured AI-output contracts. Every field is nullable by design:
// "Never invent data. Unknown is acceptable." (Directive 005, Phase 3.)
// ---------------------------------------------------------------------

/** The complete company intelligence profile (Phase 2). */
export type CompanyIntelligence = {
  overview: string | null;
  industry: string | null;
  constructionSector: string | null;
  services: string[];
  specialisms: string[];
  employeeEstimate: number | null;
  revenueEstimateGbp: number | null;
  estimatedSoftwareSpendGbp: number | null;
  fleetSize: number | null;
  staffSize: number | null;
  yearsTrading: number | null;
  locations: string[];
  geographicCoverage: string | null;
  softwareUsed: string[];
  painPoints: string[];
  buyingSignals: string[];
  growthIndicators: string[];
  recruitmentActivity: string | null;
  urgency: string | null;
  /** 0 to 100 derived quality signals — null when there is not enough to judge. */
  websiteQualityScore: number | null;
  marketingQualityScore: number | null;
  digitalMaturityScore: number | null;
  hiringActivityScore: number | null;
  growthScore: number | null;
  /** The model's own 0 to 100 confidence in this profile. */
  confidence: number | null;
};

export function emptyIntelligence(): CompanyIntelligence {
  return {
    overview: null,
    industry: null,
    constructionSector: null,
    services: [],
    specialisms: [],
    employeeEstimate: null,
    revenueEstimateGbp: null,
    estimatedSoftwareSpendGbp: null,
    fleetSize: null,
    staffSize: null,
    yearsTrading: null,
    locations: [],
    geographicCoverage: null,
    softwareUsed: [],
    painPoints: [],
    buyingSignals: [],
    growthIndicators: [],
    recruitmentActivity: null,
    urgency: null,
    websiteQualityScore: null,
    marketingQualityScore: null,
    digitalMaturityScore: null,
    hiringActivityScore: null,
    growthScore: null,
    confidence: null,
  };
}

/** A decision maker (Phase 3). Only ever populated from a real source. */
export type DecisionMaker = {
  fullName: string;
  title: string | null;
  seniority: "c_level" | "director" | "manager" | "other" | "unknown";
  email: string | null;
  linkedinUrl: string | null;
  confidence: number | null;
  reasoning: string | null;
};

/** The cold-call / first-meeting brief (Phase 4). */
export type SalesBrief = {
  coldCallOpener: string;
  discoveryQuestions: string[];
  likelyObjections: string[];
  objectionResponses: string[];
  valueProposition: string;
  recommendedModules: string[];
  demoFocus: string;
  meetingAgenda: string[];
  bestAngle: string;
  bestTimeToCall: string | null;
};

/** Draft-only outreach (Phase 5). Nothing here is ever sent. */
export type CommsDrafts = {
  coldEmailSubject: string;
  coldEmail: string;
  linkedinMessage: string;
  followUpEmail: string;
  voicemailScript: string;
  firstCallOpening: string;
  demoConfirmation: string;
};

/** Provenance carried on every persisted artifact. */
export type ResearchProvenance = "anthropic" | "openai" | "deterministic";

/** Headline summary of a finished run, surfaced on the live view + queue. */
export type ResearchRunSummary = {
  score: number | null;
  scoreBand: string | null;
  likelihoodBand: string | null;
  decisionMakers: number;
  technologies: number;
  painPoints: number;
  confidence: number | null;
  generatedBy: ResearchProvenance | null;
};

/** What the live-polling endpoint returns to the watching UI. */
export type ResearchRunState = {
  taskId: string;
  companyId: string | null;
  companyName: string | null;
  status: ResearchTaskStatus;
  phase: ResearchPhase;
  steps: ResearchStepState[];
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  summary: ResearchRunSummary | null;
};

// ---------------------------------------------------------------------
// Honest band helpers — used to label estimates without inventing precision.
// ---------------------------------------------------------------------

/** Map an employee headcount estimate to an honest band label. */
export function employeeBandLabel(n: number | null): string {
  if (n == null) return "Unknown";
  if (n < 10) return "Micro (1 to 9)";
  if (n < 50) return "Small (10 to 49)";
  if (n < 250) return "Mid (50 to 249)";
  return "Large (250+)";
}

/** Clamp helper shared by the score + extract layers. */
export function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

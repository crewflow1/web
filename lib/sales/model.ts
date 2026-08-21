/**
 * CrewFlow HQ — Sales AI Platform, pure model + presentation layer
 * (CEO Directive 003, Phase 1).
 *
 * Server/client-safe. NO Supabase / server-only imports — the service
 * layer, the server actions, and the React components all import from
 * here so the vocabulary (pipeline statuses, timeline kinds, seniority,
 * likelihood/risk bands, labels) and the pure helpers (funnel maths,
 * analytics aggregation, currency/score formatting) live in exactly one
 * place.
 *
 * FOUNDATION ONLY. Nothing here calls a model provider, runs research,
 * or executes outreach. AI-authored artifacts carry `generated_by`,
 * `model`, and `ai_employee_id` so every AI action is traceable, but no
 * function in this module is autonomous.
 *
 * Departments are reused from the Phase 1 AI Employee Framework so the
 * Sales AI, the boardroom, and the memory engine share one vocabulary.
 */

import {
  DEPARTMENTS,
  DEPARTMENT_LABELS,
  departmentLabel,
  relativeTime,
  type Department,
} from "@/lib/ai-employees/model";

export {
  DEPARTMENTS,
  DEPARTMENT_LABELS,
  departmentLabel,
  relativeTime,
  type Department,
};

// ---------------------------------------------------------------------
// Pipeline status — the sales funnel. Order matters: FUNNEL_STAGES below
// encodes progression; lost / disqualified are terminal-negative and sit
// off the linear funnel.
// ---------------------------------------------------------------------

export const PIPELINE_STATUSES = [
  "new",
  "qualified",
  "outreach_ready",
  "contacted",
  "replied",
  "demo_booked",
  "won",
  "lost",
  "disqualified",
] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export const STATUS_LABELS: Record<PipelineStatus, string> = {
  new: "New",
  qualified: "Qualified",
  outreach_ready: "Outreach ready",
  contacted: "Contacted",
  replied: "Replied",
  demo_booked: "Demo booked",
  won: "Won",
  lost: "Lost",
  disqualified: "Disqualified",
};

export const STATUS_HELP: Record<PipelineStatus, string> = {
  new: "Captured in the database, not yet qualified.",
  qualified: "Assessed as a genuine fit for CrewFlow.",
  outreach_ready: "Researched and an angle prepared — ready to contact.",
  contacted: "First outbound message or call sent.",
  replied: "The prospect has responded.",
  demo_booked: "A demo is scheduled.",
  won: "Closed-won — now a customer.",
  lost: "Closed-lost after engagement.",
  disqualified: "Not a fit; removed from the funnel.",
};

export function statusLabel(s: string): string {
  return STATUS_LABELS[s as PipelineStatus] ?? s;
}

/** The linear funnel, in order. Lost / disqualified are excluded. */
export const FUNNEL_STAGES = [
  "new",
  "qualified",
  "outreach_ready",
  "contacted",
  "replied",
  "demo_booked",
  "won",
] as const;
export type FunnelStageKey = (typeof FUNNEL_STAGES)[number];

/** A company currently in one of these statuses is "open pipeline". */
export const OPEN_STATUSES: readonly PipelineStatus[] = [
  "new",
  "qualified",
  "outreach_ready",
  "contacted",
  "replied",
  "demo_booked",
];

export function isOpenStatus(s: string): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(s);
}
export function isWonStatus(s: string): boolean {
  return s === "won";
}
export function isLostStatus(s: string): boolean {
  return s === "lost" || s === "disqualified";
}

// ---------------------------------------------------------------------
// Contact seniority — for prioritising decision makers.
// ---------------------------------------------------------------------

export const SENIORITIES = [
  "c_level",
  "director",
  "manager",
  "other",
  "unknown",
] as const;
export type Seniority = (typeof SENIORITIES)[number];

export const SENIORITY_LABELS: Record<Seniority, string> = {
  c_level: "C-level",
  director: "Director",
  manager: "Manager",
  other: "Other",
  unknown: "Unknown",
};

export function seniorityLabel(s: string): string {
  return SENIORITY_LABELS[s as Seniority] ?? s;
}

// ---------------------------------------------------------------------
// Timeline events — the per-company chronological timeline + the global
// activity feed. Each type is either an `interaction` (a logged touch) or
// a `lifecycle` marker (engine-emitted milestone).
// ---------------------------------------------------------------------

export const TIMELINE_EVENT_TYPES = [
  // Interactions (human-loggable touches).
  "email",
  "call",
  "linkedin",
  "instagram",
  "facebook",
  "note",
  "meeting",
  "demo",
  "quote",
  "follow_up",
  // Lifecycle markers (engine-emitted milestones).
  "created",
  "research",
  "recommendation",
  "status_change",
  "system",
  // AI actions — the autonomous sales engine's permanent, searchable
  // footprint (Directive 003: "every AI action must become part of the
  // permanent timeline"). No worker emits these yet; the vocabulary and
  // the audit trail exist so future autonomous work is traceable.
  "enriched",
  "scored",
  "email_generated",
  "email_sent",
  "linkedin_generated",
  "linkedin_sent",
  "call_completed",
  "objection_handled",
  "demo_booked",
  "demo_completed",
  "follow_up_created",
  "proposal_generated",
  // AI task-queue lifecycle.
  "task_scheduled",
  "task_started",
  "task_completed",
  "task_failed",
] as const;
export type TimelineEventType = (typeof TIMELINE_EVENT_TYPES)[number];

export const EVENT_LABELS: Record<TimelineEventType, string> = {
  email: "Email",
  call: "Call",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  facebook: "Facebook",
  note: "Note",
  meeting: "Meeting",
  demo: "Demo",
  quote: "Quote",
  follow_up: "Follow-up",
  created: "Company added",
  research: "AI research",
  recommendation: "AI recommendation",
  status_change: "Status changed",
  system: "System",
  enriched: "AI enrichment",
  scored: "AI scored",
  email_generated: "Email drafted",
  email_sent: "Email sent",
  linkedin_generated: "LinkedIn drafted",
  linkedin_sent: "LinkedIn sent",
  call_completed: "Call completed",
  objection_handled: "Objection handled",
  demo_booked: "Demo booked",
  demo_completed: "Demo completed",
  follow_up_created: "Follow-up created",
  proposal_generated: "Proposal generated",
  task_scheduled: "Task scheduled",
  task_started: "Task started",
  task_completed: "Task completed",
  task_failed: "Task failed",
};

/** Interaction types a human (or AI) logs against a company. */
export const INTERACTION_EVENT_TYPES: readonly TimelineEventType[] = [
  "email",
  "call",
  "linkedin",
  "instagram",
  "facebook",
  "note",
  "meeting",
  "demo",
  "quote",
  "follow_up",
];

/**
 * AI-action timeline types — emitted by the autonomous engine, never the
 * human "log interaction" form. They carry the AI footprint on the
 * timeline and the global feed.
 */
export const AI_ACTION_EVENT_TYPES: readonly TimelineEventType[] = [
  "enriched",
  "scored",
  "email_generated",
  "email_sent",
  "linkedin_generated",
  "linkedin_sent",
  "call_completed",
  "objection_handled",
  "demo_booked",
  "demo_completed",
  "follow_up_created",
  "proposal_generated",
  "task_scheduled",
  "task_started",
  "task_completed",
  "task_failed",
];

/**
 * Timeline events that capture reusable sales knowledge — a handled
 * objection, a completed cold call, a completed demo. The detail page
 * offers to promote these into the Shared Memory Engine (Directive 002)
 * so every AI employee can learn from a real outcome.
 */
export const PROMOTABLE_EVENT_TYPES: readonly string[] = [
  "objection_handled",
  "call_completed",
  "demo_completed",
  "call",
  "demo",
  "meeting",
];

export function isPromotableOutcome(t: string): boolean {
  return PROMOTABLE_EVENT_TYPES.includes(t);
}

export function eventLabel(t: string): string {
  return EVENT_LABELS[t as TimelineEventType] ?? t.replace(/_/g, " ");
}

export function eventCategory(
  t: string,
): "interaction" | "lifecycle" | "ai_action" {
  if ((INTERACTION_EVENT_TYPES as readonly string[]).includes(t)) {
    return "interaction";
  }
  if ((AI_ACTION_EVENT_TYPES as readonly string[]).includes(t)) {
    return "ai_action";
  }
  return "lifecycle";
}

export const EVENT_DIRECTIONS = ["inbound", "outbound", "internal"] as const;
export type EventDirection = (typeof EVENT_DIRECTIONS)[number];

export const DIRECTION_LABELS: Record<EventDirection, string> = {
  inbound: "Inbound",
  outbound: "Outbound",
  internal: "Internal",
};

export function directionLabel(d: string): string {
  return DIRECTION_LABELS[d as EventDirection] ?? d;
}

// ---------------------------------------------------------------------
// Research bands — likelihood of needing CrewFlow + risk level.
// ---------------------------------------------------------------------

export const LIKELIHOOD_BANDS = [
  "very_high",
  "high",
  "medium",
  "low",
  "unknown",
] as const;
export type LikelihoodBand = (typeof LIKELIHOOD_BANDS)[number];

export const LIKELIHOOD_LABELS: Record<LikelihoodBand, string> = {
  very_high: "Very high",
  high: "High",
  medium: "Medium",
  low: "Low",
  unknown: "Unknown",
};

export function likelihoodLabel(b: string): string {
  return LIKELIHOOD_LABELS[b as LikelihoodBand] ?? b;
}

/** Map a 0–100 fit score to a likelihood band. */
export function likelihoodBandFromScore(score: number | null): LikelihoodBand {
  if (score == null) return "unknown";
  if (score >= 80) return "very_high";
  if (score >= 60) return "high";
  if (score >= 40) return "medium";
  return "low";
}

export const RISK_LEVELS = ["low", "medium", "high", "unknown"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RISK_LABELS: Record<RiskLevel, string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
  unknown: "Unknown",
};

export function riskLabel(r: string): string {
  return RISK_LABELS[r as RiskLevel] ?? r;
}

export const GENERATED_BY = ["ai", "human"] as const;
export type GeneratedBy = (typeof GENERATED_BY)[number];

// ---------------------------------------------------------------------
// AI Task Queue — the foundation every future autonomous worker polls,
// claims, and updates. No worker runs yet; this is the vocabulary the
// queue table, the service, and the /admin/sales/tasks page all share.
// ---------------------------------------------------------------------

export const AI_TASK_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type AiTaskStatus = (typeof AI_TASK_STATUSES)[number];

export const AI_TASK_STATUS_LABELS: Record<AiTaskStatus, string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function aiTaskStatusLabel(s: string): string {
  return AI_TASK_STATUS_LABELS[s as AiTaskStatus] ?? s;
}

/** Tasks that are still live (not yet terminal). */
export const OPEN_TASK_STATUSES: readonly AiTaskStatus[] = ["pending", "running"];

export function isOpenTaskStatus(s: string): boolean {
  return (OPEN_TASK_STATUSES as readonly string[]).includes(s);
}

/** Priorities, highest urgency first (display + select order). */
export const AI_TASK_PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type AiTaskPriority = (typeof AI_TASK_PRIORITIES)[number];

export const AI_TASK_PRIORITY_LABELS: Record<AiTaskPriority, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

export function aiTaskPriorityLabel(p: string): string {
  return AI_TASK_PRIORITY_LABELS[p as AiTaskPriority] ?? p;
}

/** Mirror of the DB `priority_rank` generated column (urgent = 0 = first). */
export function priorityRank(p: string): number {
  switch (p) {
    case "urgent":
      return 0;
    case "high":
      return 1;
    case "normal":
      return 2;
    case "low":
      return 3;
    default:
      return 2;
  }
}

export type TaskStatusCounts = Record<AiTaskStatus, number>;

export function emptyTaskStatusCounts(): TaskStatusCounts {
  return { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
}

export function tallyTaskStatuses(
  rows: ReadonlyArray<{ status: string }>,
): TaskStatusCounts {
  const counts = emptyTaskStatusCounts();
  for (const r of rows) {
    if ((r.status as AiTaskStatus) in counts) {
      counts[r.status as AiTaskStatus] += 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------
// Channels — the polymorphic "multiple of everything" vocabulary
// (multiple phones, emails, LinkedIn profiles, social accounts). The
// concrete channel types are DATA (hq_sales_channel_types); these are the
// coarse categories the UI groups by.
// ---------------------------------------------------------------------

export const CHANNEL_CATEGORIES = [
  "phone",
  "email",
  "linkedin",
  "social",
  "web",
  "messaging",
  "other",
] as const;
export type ChannelCategory = (typeof CHANNEL_CATEGORIES)[number];

export const CHANNEL_CATEGORY_LABELS: Record<ChannelCategory, string> = {
  phone: "Phone",
  email: "Email",
  linkedin: "LinkedIn",
  social: "Social",
  web: "Web",
  messaging: "Messaging",
  other: "Other",
};

export function channelCategoryLabel(c: string): string {
  return CHANNEL_CATEGORY_LABELS[c as ChannelCategory] ?? c;
}

export const CHANNEL_STATUSES = ["active", "inactive", "invalid"] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

// ---------------------------------------------------------------------
// Scoring — CRM score + AI qualification score share one 0–100 banding.
// ---------------------------------------------------------------------

export const SCORE_BANDS = ["hot", "warm", "cool", "cold", "unscored"] as const;
export type ScoreBand = (typeof SCORE_BANDS)[number];

export const SCORE_BAND_LABELS: Record<ScoreBand, string> = {
  hot: "Hot",
  warm: "Warm",
  cool: "Cool",
  cold: "Cold",
  unscored: "Unscored",
};

export function scoreBand(score: number | null | undefined): ScoreBand {
  if (score == null) return "unscored";
  if (score >= 80) return "hot";
  if (score >= 60) return "warm";
  if (score >= 40) return "cool";
  return "cold";
}

export function scoreBandLabel(score: number | null | undefined): string {
  return SCORE_BAND_LABELS[scoreBand(score)];
}

/** Clamp arbitrary input to a valid 0–100 integer score, or null. */
export function clampScore(n: unknown): number | null {
  if (n == null || n === "") return null;
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, v));
}

// ---------------------------------------------------------------------
// Employee-size bands — for "search by Size" + size analytics.
// ---------------------------------------------------------------------

export type EmployeeBand = {
  key: string;
  label: string;
  min: number;
  max: number | null; // null = no upper bound
};

export const EMPLOYEE_BANDS: readonly EmployeeBand[] = [
  { key: "micro", label: "1–10", min: 1, max: 10 },
  { key: "small", label: "11–50", min: 11, max: 50 },
  { key: "medium", label: "51–200", min: 51, max: 200 },
  { key: "large", label: "201–500", min: 201, max: 500 },
  { key: "xlarge", label: "501–1000", min: 501, max: 1000 },
  { key: "enterprise", label: "1000+", min: 1001, max: null },
];

export function employeeBand(count: number | null | undefined): EmployeeBand | null {
  if (count == null || !Number.isFinite(count) || count < 1) return null;
  for (const b of EMPLOYEE_BANDS) {
    if (count >= b.min && (b.max == null || count <= b.max)) return b;
  }
  return null;
}

export function employeeBandLabel(count: number | null | undefined): string {
  return employeeBand(count)?.label ?? "—";
}

// ---------------------------------------------------------------------
// Formatting helpers (pure).
// ---------------------------------------------------------------------

/** "£1.2M" | "£450k" | "£900" | "—" for a whole-GBP amount. */
export function formatGbp(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return "—";
  const n = Math.round(amount);
  if (Math.abs(n) >= 1_000_000) {
    return `£${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (Math.abs(n) >= 1_000) {
    return `£${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  }
  return `£${n}`;
}

/** Compact integer formatting ("1,234"). */
export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "0";
  return Math.round(n).toLocaleString("en-GB");
}

/** Percentage helper — `pct(3, 12)` → 25. Returns 0 when denom is 0. */
export function pct(numerator: number, denominator: number): number {
  if (!denominator || denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10; // 1 d.p.
}

/**
 * Best-effort registrable domain from a website string. Pure + never
 * throws — strips scheme, path, and a leading "www.". Returns null when
 * nothing host-like can be extracted.
 */
export function deriveDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  let s = website.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip scheme
  s = s.replace(/^www\./, "");
  s = s.split(/[/?#]/)[0] ?? s; // drop path/query/hash
  s = s.split("@").pop() ?? s; // drop any user-info
  s = s.split(":")[0] ?? s; // drop port
  s = s.trim();
  if (!s || !s.includes(".")) return null;
  if (!/^[a-z0-9.-]+$/.test(s)) return null;
  return s;
}

/** Parse a free-form tag string ("a, b c") into clean, slug-ish tags. */
export function normalizeTags(
  input: string | null | undefined,
  max = 24,
): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(",")) {
    let t = raw.trim().toLowerCase().replace(/\s+/g, "-");
    if (!t) continue;
    if (t.length > 40) t = t.slice(0, 40);
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Clean a free-form, newline/comma-separated list (pain points,
 * features, objections) into a trimmed, de-duped string array.
 */
export function normalizeList(
  input: string | null | undefined,
  max = 24,
): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[\n,]/)) {
    const t = raw.trim().replace(/^[-*•]\s*/, "");
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t.length > 280 ? t.slice(0, 280) : t);
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------
// Domain row types (mirror the DB columns).
// ---------------------------------------------------------------------

/** Row from the extensible hq_sales_sources lookup. */
export type SalesSource = {
  slug: string;
  label: string;
  category: "manual" | "research" | "integration";
  is_active: boolean;
  sort_order: number;
};

/** The master company-intelligence record. */
export type SalesCompany = {
  id: string;
  name: string;
  summary: string;
  website: string | null;
  domain: string | null;
  industry: string | null;
  employee_count: number | null;
  annual_turnover_gbp: number | null;
  location: string | null;
  region: string | null;
  county: string | null;
  country: string;
  primary_email: string | null;
  primary_phone: string | null;
  linkedin_url: string | null;
  instagram_url: string | null;
  facebook_url: string | null;
  companies_house_url: string | null;
  companies_house_number: string | null;
  website_technology: string[];
  crm_score: number | null;
  ai_qualification_score: number | null;
  estimated_deal_value_gbp: number | null;
  status: string;
  source: string;
  assigned_to_email: string | null;
  tags: string[];
  last_researched_at: string | null;
  // Company Intelligence — reserved, nullable signals filled in by future
  // enrichment. Null everywhere today (Directive 003: "reserve schema").
  revenue_estimate_gbp: number | null;
  growth_score: number | null;
  construction_sector: string | null;
  software_used: string[];
  estimated_software_spend_gbp: number | null;
  fleet_size: number | null;
  staff_size: number | null;
  website_quality_score: number | null;
  marketing_quality_score: number | null;
  hiring_activity_score: number | null;
  digital_maturity_score: number | null;
  enrichment: Record<string, unknown> | null;
  created_by_id: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * List/search projection — every column EXCEPT the (potentially long)
 * `summary` and the heavier Company Intelligence signals, so cards and
 * search results stay lightweight at scale.
 */
export type SalesCompanyListItem = Omit<
  SalesCompany,
  | "summary"
  | "revenue_estimate_gbp"
  | "growth_score"
  | "construction_sector"
  | "software_used"
  | "estimated_software_spend_gbp"
  | "fleet_size"
  | "staff_size"
  | "website_quality_score"
  | "marketing_quality_score"
  | "hiring_activity_score"
  | "digital_maturity_score"
  | "enrichment"
>;

/** The Company Intelligence 0–100 score signals (reuse scoreBand colours). */
export type IntelligenceScoreKey =
  | "growth_score"
  | "website_quality_score"
  | "marketing_quality_score"
  | "hiring_activity_score"
  | "digital_maturity_score";

export const INTELLIGENCE_SCORE_FIELDS: ReadonlyArray<{
  key: IntelligenceScoreKey;
  label: string;
}> = [
  { key: "growth_score", label: "Growth" },
  { key: "website_quality_score", label: "Website quality" },
  { key: "marketing_quality_score", label: "Marketing quality" },
  { key: "hiring_activity_score", label: "Hiring activity" },
  { key: "digital_maturity_score", label: "Digital maturity" },
];

export type SalesContact = {
  id: string;
  company_id: string;
  full_name: string;
  title: string | null;
  seniority: string;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  is_primary: boolean;
  is_decision_maker: boolean;
  notes: string;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
};

export type SalesResearchReport = {
  id: string;
  company_id: string;
  summary: string;
  pain_points: string[];
  likelihood_score: number | null;
  likelihood_band: string;
  estimated_software_spend_gbp: number | null;
  estimated_spend_note: string;
  best_angle: string;
  opening_line: string;
  recommended_follow_up: string;
  risk_assessment: string;
  risk_level: string;
  generated_by: string;
  model: string | null;
  ai_employee_id: string | null;
  authored_by_email: string | null;
  status: string;
  memory_id: string | null;
  created_at: string;
  updated_at: string;
};

export type SalesRecommendation = {
  id: string;
  company_id: string;
  why_buy: string;
  key_features: string[];
  likely_objections: string[];
  recommended_pricing: string;
  recommended_plan: string | null;
  recommended_price_gbp: number | null;
  best_salesperson: string | null;
  best_time_to_call: string;
  follow_up_schedule: string;
  follow_up_steps: unknown | null;
  generated_by: string;
  model: string | null;
  ai_employee_id: string | null;
  authored_by_email: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

export type SalesTimelineEvent = {
  id: string;
  company_id: string;
  contact_id: string | null;
  event_type: string;
  direction: string;
  subject: string | null;
  body: string;
  outcome: string | null;
  occurred_at: string;
  actor_email: string | null;
  ai_employee_id: string | null;
  source: string;
  metadata: Record<string, unknown> | null;
  memory_id: string | null;
  created_at: string;
};

/** A timeline event joined with its company name, for the global feed. */
export type SalesFeedItem = SalesTimelineEvent & {
  company_name: string | null;
};

/** Row from the extensible hq_sales_channel_types lookup. */
export type SalesChannelType = {
  slug: string;
  label: string;
  category: ChannelCategory;
  is_active: boolean;
  sort_order: number;
};

/** Row from the extensible hq_sales_task_types lookup. */
export type SalesTaskType = {
  slug: string;
  label: string;
  category: "research" | "outreach" | "call" | "meeting" | "admin" | "memory" | "other";
  is_active: boolean;
  sort_order: number;
};

/** Row from the hq_sales_integrations lookup (future connectors). */
export type SalesIntegration = {
  slug: string;
  label: string;
  category: "social" | "comms" | "registry" | "maps" | "crawler" | "other";
  status: "planned" | "connected" | "disabled";
  is_active: boolean;
  sort_order: number;
};

/** A physical location for a company (multiple per company). */
export type SalesLocation = {
  id: string;
  company_id: string;
  label: string | null;
  is_primary: boolean;
  is_headquarters: boolean;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  county: string | null;
  region: string | null;
  postcode: string | null;
  country: string;
  latitude: number | null;
  longitude: number | null;
  phone: string | null;
  notes: string;
  generated_by: string;
  model: string | null;
  ai_employee_id: string | null;
  created_by_email: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

/**
 * A polymorphic contact channel — one row per phone / email / LinkedIn /
 * social account, anchored to a company and optionally a contact or
 * location. This is the directive's "multiple of everything".
 */
export type SalesChannel = {
  id: string;
  company_id: string;
  contact_id: string | null;
  location_id: string | null;
  channel_type: string;
  value: string;
  label: string | null;
  is_primary: boolean;
  is_verified: boolean;
  status: string;
  generated_by: string;
  model: string | null;
  ai_employee_id: string | null;
  created_by_email: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

/** A row in the AI Task Queue (foundation — no worker executes it yet). */
export type SalesAiTask = {
  id: string;
  company_id: string | null;
  contact_id: string | null;
  task_type: string;
  status: string;
  priority: string;
  priority_rank: number;
  retry_count: number;
  max_retries: number;
  assigned_ai_employee_id: string | null;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  dedupe_key: string | null;
  source: string;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
};

/** An AI task joined with its company name, for the global tasks page. */
export type SalesTaskItem = SalesAiTask & {
  company_name: string | null;
};

/** A future-integration link + snapshot, joined back to a company. */
export type SalesExternalRecord = {
  id: string;
  integration: string;
  company_id: string | null;
  contact_id: string | null;
  location_id: string | null;
  external_id: string | null;
  external_url: string | null;
  status: string;
  payload: Record<string, unknown> | null;
  synced_at: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
};

export type SalesCompanyDetail = {
  company: SalesCompany;
  contacts: SalesContact[];
  locations: SalesLocation[];
  channels: SalesChannel[];
  research: SalesResearchReport[];
  recommendations: SalesRecommendation[];
  timeline: SalesTimelineEvent[];
  tasks: SalesAiTask[];
};

// ---------------------------------------------------------------------
// AI Calling Centre row types (Directive 004, Phase 6). Enum-style columns
// stay `string` (matching SalesCompany / SalesAiTask); lib/sales/calling.ts
// owns the typed vocabulary + roll-up maths. search_tsv is never selected.
// ---------------------------------------------------------------------

/** A reusable call-script template from hq_sales_call_scripts. */
export type SalesCallScript = {
  id: string;
  name: string;
  category: string;
  status: string;
  version: number;
  summary: string;
  opening: string;
  body: string;
  talking_points: string[];
  questions: string[];
  target_persona: string | null;
  target_status: string | null;
  estimated_duration_seconds: number | null;
  tags: string[];
  usage_count: number;
  generated_by: string;
  model: string | null;
  ai_employee_id: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
};

/** An objection → recommended-response play from hq_sales_objections. */
export type SalesObjection = {
  id: string;
  objection: string;
  category: string;
  response: string;
  supporting_points: string[];
  follow_up: string;
  tags: string[];
  confidence: number | null;
  win_rate: number | null;
  times_used: number;
  status: string;
  memory_id: string | null;
  generated_by: string;
  model: string | null;
  ai_employee_id: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
};

/** A per-call record + queue row from hq_sales_calls. */
export type SalesCall = {
  id: string;
  company_id: string;
  contact_id: string | null;
  script_id: string | null;
  ai_task_id: string | null;
  direction: string;
  status: string;
  priority: string;
  priority_rank: number;
  outcome: string;
  objective: string;
  scheduled_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  recording_url: string | null;
  transcript: string;
  summary: string;
  notes: string;
  sentiment: string;
  sentiment_score: number | null;
  objections_raised: string[];
  follow_up_at: string | null;
  follow_up_notes: string;
  follow_up_done: boolean;
  tags: string[];
  memory_id: string | null;
  generated_by: string;
  model: string | null;
  ai_employee_id: string | null;
  source: string;
  created_by_email: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

/** A call joined with its company name, for the global calling feed. */
export type SalesCallItem = SalesCall & {
  company_name: string | null;
};

/**
 * A distilled, reusable winning pattern — the Learning Engine record
 * (Directive 004, Phase 7). The directive's reusable-knowledge shape
 * (prompt / context / result / metrics / tags / confidence) maps to
 * explicit columns; `search_tsv` is never selected. Enums stay `string`
 * (the bounded vocabularies live in lib/sales/learning.ts).
 */
export type SalesLearning = {
  id: string;
  title: string;
  pattern_type: string;
  channel: string | null;
  status: string;
  summary: string;
  prompt: string;
  context: string;
  result: string;
  supporting_points: string[];
  tags: string[];
  metrics: Record<string, unknown> | null;
  confidence: number | null;
  times_used: number;
  times_won: number;
  win_rate: number | null;
  last_used_at: string | null;
  company_id: string | null;
  source_call_id: string | null;
  source_event_id: string | null;
  source_objection_id: string | null;
  memory_id: string | null;
  generated_by: string;
  model: string | null;
  ai_employee_id: string | null;
  source: string;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
};

/** A learning joined with its source company name, for the engine feed. */
export type SalesLearningItem = SalesLearning & {
  company_name: string | null;
};

// ---------------------------------------------------------------------
// Funnel maths (pure). Conversion is modelled on current pipeline
// position: a company currently at stage N has "reached" stages 1..N,
// and won counts as having reached the final stage. Lost / disqualified
// are reported separately and excluded from the cumulative funnel.
// ---------------------------------------------------------------------

export type StatusCounts = Record<PipelineStatus, number>;

export function emptyStatusCounts(): StatusCounts {
  return {
    new: 0,
    qualified: 0,
    outreach_ready: 0,
    contacted: 0,
    replied: 0,
    demo_booked: 0,
    won: 0,
    lost: 0,
    disqualified: 0,
  };
}

export function tallyStatuses(
  rows: ReadonlyArray<{ status: string }>,
): StatusCounts {
  const counts = emptyStatusCounts();
  for (const r of rows) {
    if ((r.status as PipelineStatus) in counts) {
      counts[r.status as PipelineStatus] += 1;
    }
  }
  return counts;
}

export type FunnelStage = {
  stage: FunnelStageKey;
  label: string;
  /** Companies that have reached this stage or beyond. */
  reached: number;
  /** Conversion from the previous stage (%, 1 d.p.); null for the first. */
  conversionFromPrev: number | null;
};

export function buildFunnel(counts: StatusCounts): FunnelStage[] {
  // reached[i] = sum of current counts for stage i and every later stage.
  const reached = FUNNEL_STAGES.map((_, i) =>
    FUNNEL_STAGES.slice(i).reduce((sum, st) => sum + counts[st], 0),
  );
  return FUNNEL_STAGES.map((stage, i) => {
    const here = reached[i] ?? 0;
    const prev = i === 0 ? null : reached[i - 1] ?? 0;
    return {
      stage,
      label: statusLabel(stage),
      reached: here,
      conversionFromPrev: prev == null ? null : pct(here, prev),
    };
  });
}

/** Won ÷ all companies. */
export function winRate(counts: StatusCounts): number {
  const total = (Object.values(counts) as number[]).reduce((a, b) => a + b, 0);
  return pct(counts.won, total);
}

/** Won ÷ (won + lost + disqualified) — close rate among decided deals. */
export function closeRate(counts: StatusCounts): number {
  const decided = counts.won + counts.lost + counts.disqualified;
  return pct(counts.won, decided);
}

// ---------------------------------------------------------------------
// Analytics aggregation (pure) — facets the directive requires: lead
// source, industry, county, region, salesperson, plus status + size.
// ---------------------------------------------------------------------

export type FacetCount = { key: string; label: string; count: number };

type CompanyFacetRow = {
  status: string;
  industry: string | null;
  county: string | null;
  region: string | null;
  source: string;
  assigned_to_email: string | null;
  employee_count: number | null;
  estimated_deal_value_gbp: number | null;
};

function tally(
  rows: ReadonlyArray<CompanyFacetRow>,
  pick: (r: CompanyFacetRow) => string | null,
  labelFn: (key: string) => string,
): FacetCount[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = pick(r);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: labelFn(key), count }))
    .sort((a, b) => b.count - a.count);
}

export type SalesFacets = {
  byStatus: FacetCount[];
  byIndustry: FacetCount[];
  byCounty: FacetCount[];
  byRegion: FacetCount[];
  bySource: FacetCount[];
  bySalesperson: FacetCount[];
  bySize: FacetCount[];
};

export function aggregateSalesFacets(
  rows: ReadonlyArray<CompanyFacetRow>,
  sourceLabels: Record<string, string> = {},
): SalesFacets {
  return {
    byStatus: tally(rows, (r) => r.status, statusLabel),
    byIndustry: tally(rows, (r) => r.industry, (k) => k),
    byCounty: tally(rows, (r) => r.county, (k) => k),
    byRegion: tally(rows, (r) => r.region, (k) => k),
    bySource: tally(rows, (r) => r.source, (k) => sourceLabels[k] ?? k),
    bySalesperson: tally(rows, (r) => r.assigned_to_email, (k) => k),
    bySize: tally(
      rows,
      (r) => employeeBand(r.employee_count)?.key ?? null,
      (k) => EMPLOYEE_BANDS.find((b) => b.key === k)?.label ?? k,
    ),
  };
}

/** Sum estimated deal value across the OPEN pipeline only. */
export function pipelineValue(
  rows: ReadonlyArray<Pick<CompanyFacetRow, "status" | "estimated_deal_value_gbp">>,
): number {
  let total = 0;
  for (const r of rows) {
    if (isOpenStatus(r.status) && r.estimated_deal_value_gbp) {
      total += r.estimated_deal_value_gbp;
    }
  }
  return total;
}

// ---------------------------------------------------------------------
// Activity aggregation (pure) — weekly/monthly counts + a daily series
// for the dashboard sparkline, from a bounded sample of timeline events.
// ---------------------------------------------------------------------

export type GrowthPoint = { date: string; count: number };

function withinDays(iso: string, days: number, now: number): boolean {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return now - t <= days * 86_400_000 && t <= now;
}

export type ActivitySummary = {
  weekly: number;
  monthly: number;
  series: GrowthPoint[]; // last 14 days, oldest → newest, zero-filled
};

export function summariseActivity(
  events: ReadonlyArray<{ occurred_at: string }>,
  now: number = Date.now(),
): ActivitySummary {
  let weekly = 0;
  let monthly = 0;
  const dayCounts = new Map<string, number>();
  for (const e of events) {
    if (withinDays(e.occurred_at, 7, now)) weekly += 1;
    if (withinDays(e.occurred_at, 30, now)) monthly += 1;
    const d = e.occurred_at.slice(0, 10);
    dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
  }
  const series: GrowthPoint[] = [];
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(now - i * 86_400_000);
    const key = dt.toISOString().slice(0, 10);
    series.push({ date: key, count: dayCounts.get(key) ?? 0 });
  }
  return { weekly, monthly, series };
}

// ---------------------------------------------------------------------
// Dashboard shape — assembled in the service from indexed COUNT queries
// plus the pure aggregators above.
// ---------------------------------------------------------------------

export type AiProductivity = {
  researchReports: number;
  recommendations: number;
  loggedActions: number;
  total: number;
};

export type SalesDashboard = {
  // Headline status counts (drive the directive's dashboard tiles).
  total: number;
  counts: StatusCounts;
  // Derived funnel + rates.
  funnel: FunnelStage[];
  winRate: number;
  closeRate: number;
  // Money.
  pipelineValueGbp: number;
  wonValueGbp: number;
  // Activity + AI output.
  activity: ActivitySummary;
  aiProductivity: AiProductivity;
  // Facets + recents for the page body.
  facets: SalesFacets;
  recentCompanies: SalesCompanyListItem[];
  recentActivity: SalesFeedItem[];
};

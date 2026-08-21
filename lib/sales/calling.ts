/**
 * CrewFlow HQ — AI Calling Centre, pure call model (CEO Directive 004,
 * Phase 6).
 *
 * Server/client-safe. NO Supabase / server-only imports. The Calling Centre
 * renders its queue, its per-call records, its script library and its
 * objection playbook from these pure functions, so this module owns the
 * call vocabulary (statuses, outcomes, sentiments, script / objection
 * categories), the tone mapping the UI pills use, the duration formatter,
 * and the window roll-up maths.
 *
 * FOUNDATION ONLY. Nothing here places, records, or transcribes a call; it
 * classifies and aggregates call rows that already exist in the permanent,
 * audited hq_sales_calls table. The "call queue" is simply calls in an open
 * status; connect-rate and talk-time are computed only from real, logged
 * calls — never faked.
 */

import { AI_TASK_PRIORITIES, aiTaskPriorityLabel, pct, priorityRank } from "./model";

// Re-export the shared priority vocabulary so the Calling Centre page and
// its tests have a single import surface (a call's priority mirrors a task's).
export { AI_TASK_PRIORITIES, aiTaskPriorityLabel, priorityRank };

// ---------------------------------------------------------------------
// Vocabulary — mirrors the hq_sales_calls / _call_scripts / _objections
// CHECK constraints exactly, in display order.
// ---------------------------------------------------------------------

export const CALL_STATUSES = [
  "queued",
  "scheduled",
  "in_progress",
  "completed",
  "no_answer",
  "voicemail",
  "busy",
  "failed",
  "cancelled",
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const CALL_STATUS_LABELS: Record<CallStatus, string> = {
  queued: "Queued",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  no_answer: "No answer",
  voicemail: "Voicemail",
  busy: "Busy",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function callStatusLabel(s: string): string {
  return CALL_STATUS_LABELS[s as CallStatus] ?? s;
}

export const CALL_OUTCOMES = [
  "connected",
  "callback_requested",
  "meeting_booked",
  "demo_booked",
  "not_interested",
  "do_not_call",
  "wrong_number",
  "no_answer",
  "left_voicemail",
  "gatekeeper",
  "unknown",
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export const CALL_OUTCOME_LABELS: Record<CallOutcome, string> = {
  connected: "Connected",
  callback_requested: "Callback requested",
  meeting_booked: "Meeting booked",
  demo_booked: "Demo booked",
  not_interested: "Not interested",
  do_not_call: "Do not call",
  wrong_number: "Wrong number",
  no_answer: "No answer",
  left_voicemail: "Left voicemail",
  gatekeeper: "Gatekeeper",
  unknown: "Unknown",
};

export function callOutcomeLabel(o: string): string {
  return CALL_OUTCOME_LABELS[o as CallOutcome] ?? o;
}

export const CALL_SENTIMENTS = [
  "positive",
  "neutral",
  "negative",
  "mixed",
  "unknown",
] as const;
export type CallSentiment = (typeof CALL_SENTIMENTS)[number];

export const CALL_SENTIMENT_LABELS: Record<CallSentiment, string> = {
  positive: "Positive",
  neutral: "Neutral",
  negative: "Negative",
  mixed: "Mixed",
  unknown: "Unknown",
};

export function callSentimentLabel(s: string): string {
  return CALL_SENTIMENT_LABELS[s as CallSentiment] ?? s;
}

export const CALL_DIRECTIONS = ["outbound", "inbound"] as const;
export type CallDirection = (typeof CALL_DIRECTIONS)[number];

export const CALL_DIRECTION_LABELS: Record<CallDirection, string> = {
  outbound: "Outbound",
  inbound: "Inbound",
};

export function callDirectionLabel(d: string): string {
  return CALL_DIRECTION_LABELS[d as CallDirection] ?? d;
}

export const SCRIPT_CATEGORIES = [
  "cold_call",
  "discovery",
  "demo",
  "follow_up",
  "gatekeeper",
  "closing",
  "voicemail",
  "objection",
  "other",
] as const;
export type ScriptCategory = (typeof SCRIPT_CATEGORIES)[number];

export const SCRIPT_CATEGORY_LABELS: Record<ScriptCategory, string> = {
  cold_call: "Cold call",
  discovery: "Discovery",
  demo: "Demo",
  follow_up: "Follow-up",
  gatekeeper: "Gatekeeper",
  closing: "Closing",
  voicemail: "Voicemail",
  objection: "Objection",
  other: "Other",
};

export function scriptCategoryLabel(c: string): string {
  return SCRIPT_CATEGORY_LABELS[c as ScriptCategory] ?? c;
}

export const OBJECTION_CATEGORIES = [
  "price",
  "timing",
  "authority",
  "need",
  "trust",
  "competitor",
  "contract",
  "feature",
  "other",
] as const;
export type ObjectionCategory = (typeof OBJECTION_CATEGORIES)[number];

export const OBJECTION_CATEGORY_LABELS: Record<ObjectionCategory, string> = {
  price: "Price",
  timing: "Timing",
  authority: "Authority",
  need: "Need",
  trust: "Trust",
  competitor: "Competitor",
  contract: "Contract",
  feature: "Feature",
  other: "Other",
};

export function objectionCategoryLabel(c: string): string {
  return OBJECTION_CATEGORY_LABELS[c as ObjectionCategory] ?? c;
}

/** Shared draft/active/archived lifecycle for scripts + objections. */
export const PLAYBOOK_STATUSES = ["draft", "active", "archived"] as const;
export type PlaybookStatus = (typeof PLAYBOOK_STATUSES)[number];

export const PLAYBOOK_STATUS_LABELS: Record<PlaybookStatus, string> = {
  draft: "Draft",
  active: "Active",
  archived: "Archived",
};

export function playbookStatusLabel(s: string): string {
  return PLAYBOOK_STATUS_LABELS[s as PlaybookStatus] ?? s;
}

// ---------------------------------------------------------------------
// Status / outcome semantics.
// ---------------------------------------------------------------------

/** Calls still in the queue / live — i.e. not yet dispositioned. */
export const OPEN_CALL_STATUSES = ["queued", "scheduled", "in_progress"] as const;

export function isOpenCallStatus(s: string): boolean {
  return (OPEN_CALL_STATUSES as readonly string[]).includes(s);
}

/**
 * Statuses where a dial actually happened (so connect-rate has a
 * denominator). Excludes the queue (queued/scheduled) and cancelled.
 */
export const DIALLED_STATUSES = [
  "in_progress",
  "completed",
  "no_answer",
  "voicemail",
  "busy",
  "failed",
] as const;

export function isDialledStatus(s: string): boolean {
  return (DIALLED_STATUSES as readonly string[]).includes(s);
}

/** Outcomes that count as a real, productive connection. */
export const CONNECTED_OUTCOMES = [
  "connected",
  "callback_requested",
  "meeting_booked",
  "demo_booked",
] as const;

export function isConnectedOutcome(o: string): boolean {
  return (CONNECTED_OUTCOMES as readonly string[]).includes(o);
}

// ---------------------------------------------------------------------
// Tone — maps a value to a pill colour token (the page owns the classes).
// Mirrors intelligence.ts's FactorTone vocabulary.
// ---------------------------------------------------------------------

export type CallTone = "positive" | "neutral" | "negative";

const OUTCOME_TONE: Record<CallOutcome, CallTone> = {
  connected: "positive",
  callback_requested: "positive",
  meeting_booked: "positive",
  demo_booked: "positive",
  not_interested: "negative",
  do_not_call: "negative",
  wrong_number: "negative",
  no_answer: "neutral",
  left_voicemail: "neutral",
  gatekeeper: "neutral",
  unknown: "neutral",
};

export function callOutcomeTone(o: string): CallTone {
  return OUTCOME_TONE[o as CallOutcome] ?? "neutral";
}

const SENTIMENT_TONE: Record<CallSentiment, CallTone> = {
  positive: "positive",
  neutral: "neutral",
  negative: "negative",
  mixed: "neutral",
  unknown: "neutral",
};

export function sentimentTone(s: string): CallTone {
  return SENTIMENT_TONE[s as CallSentiment] ?? "neutral";
}

// ---------------------------------------------------------------------
// Duration formatter — "45s" / "4m 12s" / "1h 3m" / "—".
// ---------------------------------------------------------------------

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ---------------------------------------------------------------------
// Window roll-up — turns a list of calls into the headline call stats.
// ---------------------------------------------------------------------

/** The minimal shape summariseCalls needs — a subset of SalesCall. */
export type CallSummaryInput = {
  status: string;
  outcome: string;
  sentiment: string;
  duration_seconds: number | null;
  ended_at: string | null;
  follow_up_at: string | null;
  follow_up_done: boolean;
};

/** A vocabulary entry rolled up with its count (always includes zeros). */
export type CallFacet = {
  slug: string;
  label: string;
  count: number;
};

export type CallStats = {
  total: number;
  /** Calls still open (queued / scheduled / in progress). */
  queued: number;
  completed: number;
  /** Calls dialled (the connect-rate denominator). */
  dialled: number;
  /** Calls whose outcome was a productive connection. */
  connected: number;
  /** connected ÷ dialled, 0 to 100 to 1 d.p. */
  connectRate: number;
  totalTalkSeconds: number;
  /** Mean talk time over calls with a recorded duration, whole seconds. */
  avgTalkSeconds: number;
  /** One entry per sentiment, in display order — includes zero counts. */
  bySentiment: CallFacet[];
  /** One entry per outcome, in display order — includes zero counts. */
  byOutcome: CallFacet[];
  /** Follow-ups whose due time has passed and aren't done. */
  followUpsDue: number;
  /** Most recent call end time in the window. */
  lastCallAt: string | null;
};

function laterIso(a: string | null, b: string | null): string | null {
  if (!b) return a;
  if (!a) return b;
  return new Date(b).getTime() > new Date(a).getTime() ? b : a;
}

export function summariseCalls(
  calls: ReadonlyArray<CallSummaryInput>,
  nowMs: number = Date.now(),
): CallStats {
  const sentimentCounts = new Map<string, number>();
  for (const s of CALL_SENTIMENTS) sentimentCounts.set(s, 0);
  const outcomeCounts = new Map<string, number>();
  for (const o of CALL_OUTCOMES) outcomeCounts.set(o, 0);

  let total = 0;
  let queued = 0;
  let completed = 0;
  let dialled = 0;
  let connected = 0;
  let totalTalkSeconds = 0;
  let talkCalls = 0;
  let followUpsDue = 0;
  let lastCallAt: string | null = null;

  for (const c of calls) {
    total += 1;
    if (isOpenCallStatus(c.status)) queued += 1;
    if (c.status === "completed") completed += 1;
    if (isDialledStatus(c.status)) dialled += 1;
    if (isConnectedOutcome(c.outcome)) connected += 1;

    if (typeof c.duration_seconds === "number" && c.duration_seconds > 0) {
      totalTalkSeconds += c.duration_seconds;
      talkCalls += 1;
    }

    sentimentCounts.set(
      c.sentiment,
      (sentimentCounts.get(c.sentiment) ?? 0) + 1,
    );
    outcomeCounts.set(c.outcome, (outcomeCounts.get(c.outcome) ?? 0) + 1);

    if (
      c.follow_up_at != null &&
      !c.follow_up_done &&
      new Date(c.follow_up_at).getTime() <= nowMs
    ) {
      followUpsDue += 1;
    }

    lastCallAt = laterIso(lastCallAt, c.ended_at);
  }

  const bySentiment: CallFacet[] = CALL_SENTIMENTS.map((slug) => ({
    slug,
    label: CALL_SENTIMENT_LABELS[slug],
    count: sentimentCounts.get(slug) ?? 0,
  }));
  const byOutcome: CallFacet[] = CALL_OUTCOMES.map((slug) => ({
    slug,
    label: CALL_OUTCOME_LABELS[slug],
    count: outcomeCounts.get(slug) ?? 0,
  }));

  return {
    total,
    queued,
    completed,
    dialled,
    connected,
    connectRate: pct(connected, dialled),
    totalTalkSeconds,
    avgTalkSeconds: talkCalls > 0 ? Math.round(totalTalkSeconds / talkCalls) : 0,
    bySentiment,
    byOutcome,
    followUpsDue,
    lastCallAt,
  };
}

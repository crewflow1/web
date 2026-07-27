/**
 * The Pulse — spine-native render helpers (Module 1, PR5 / CEO Directive #005,
 * STEP 5).
 *
 * Translates one projected `hq_timeline` row into everything the feed needs to
 * paint a card or a drawer: an icon, a human title + description, a severity
 * palette, a deep link, an actor label, a company label, and the day-bucket it
 * belongs to. Pure + client-safe (no `server-only`, no I/O) so the server page
 * and the client feed import the exact same vocabulary — one source of truth for
 * "what does this event look like", the analogue of registry.ts being the one
 * source for "what events exist".
 *
 * This is the SPINE taxonomy (registry.ts verbs), deliberately NOT the legacy
 * activity_log vocabulary in lib/activity/render.ts — we reuse only that module's
 * `relativeTime` + GBP formatting. Actor + company names are resolved HERE, at
 * render time, from the event's ids/payload (CEO #005 decision 5: no denormalised
 * names baked into the projection).
 */
import type { LucideIcon } from "lucide-react";
import {
  Building2,
  UserPlus,
  UserCog,
  Users,
  HardHat,
  FileSignature,
  Send,
  Target,
  Receipt,
  PoundSterling,
  Banknote,
  LifeBuoy,
  Bell,
  Sparkles,
  ShieldCheck,
  ShieldAlert,
  BrainCircuit,
  KeyRound,
  FileText,
  Globe,
  Settings2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Webhook,
  Activity,
} from "lucide-react";
import type { Severity } from "./registry";
import type { TimelineEvent } from "@/server/services/spine-timeline";
import { relativeTime } from "@/lib/activity/render";

export { relativeTime };

// --- Money -------------------------------------------------------------------

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Format a payload money field as GBP (major units, matching activity_log). */
function gbp(v: unknown): string | null {
  const n = num(v);
  return n === null ? null : GBP.format(n);
}

function str(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t.length > 0 ? t : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** First non-empty string among the given payload keys. */
function pick(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const s = str(payload[k]);
    if (s) return s;
  }
  return null;
}

/** A short, human id — UUID → first segment, else first 8 chars. */
export function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  const dash = id.indexOf("-");
  if (dash >= 6) return id.slice(0, dash);
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

// --- Icons -------------------------------------------------------------------

const NAMESPACE_ICON: Record<string, LucideIcon> = {
  org: Building2,
  customer: UserPlus,
  job: HardHat,
  quote: FileSignature,
  lead: Target,
  invoice: Receipt,
  billing: PoundSterling,
  payroll: Banknote,
  support: LifeBuoy,
  notification: Bell,
  ai: Sparkles,
  approval: ShieldCheck,
  memory: BrainCircuit,
  permission: KeyRound,
  staff: UserCog,
  member: Users,
  document: FileText,
  portal: Globe,
  system: Settings2,
};

/** Per-verb overrides where the namespace icon undersells the moment. */
const VERB_ICON: Record<string, LucideIcon> = {
  "quote.sent": Send,
  "quote.accepted": CheckCircle2,
  "quote.declined": XCircle,
  "job.completed": CheckCircle2,
  "job.cancelled": XCircle,
  "invoice.paid": CheckCircle2,
  "invoice.payment_succeeded": CheckCircle2,
  "invoice.payment_failed": AlertTriangle,
  "invoice.voided": XCircle,
  "billing.dispute_opened": AlertTriangle,
  "org.churned": XCircle,
  "org.suspended": ShieldAlert,
  "ai.run_failed": AlertTriangle,
  "ai.escalated": ShieldAlert,
  "ai.budget_exceeded": AlertTriangle,
  "approval.rejected": XCircle,
  "approval.escalated": ShieldAlert,
  "support.ticket_escalated": ShieldAlert,
  "system.cron_failed": AlertTriangle,
  "system.alert_raised": AlertTriangle,
  "system.webhook_received": Webhook,
  "permission.role_revoked": ShieldAlert,
};

/** The icon for an event's verb (per-verb override → namespace → fallback). */
export function eventIcon(verb: string): LucideIcon {
  return VERB_ICON[verb] ?? NAMESPACE_ICON[verb.split(".")[0] ?? ""] ?? Activity;
}

// --- Severity palette (dark theme) -------------------------------------------

export type SeverityToken = {
  label: string;
  /** small status dot */
  dot: string;
  /** pill badge (bg + text + ring) */
  badge: string;
  /** icon chip (bg + text + ring) */
  chip: string;
  /** subtle card hover glow ring */
  glow: string;
};

const SEVERITY_TOKENS: Record<Severity, SeverityToken> = {
  info: {
    label: "Info",
    dot: "bg-sky-400",
    badge: "bg-sky-500/10 text-sky-300 ring-1 ring-inset ring-sky-400/30",
    chip: "bg-sky-500/10 text-sky-300 ring-1 ring-inset ring-sky-400/25",
    glow: "group-hover:ring-sky-400/30",
  },
  success: {
    label: "Success",
    dot: "bg-emerald-400",
    badge: "bg-emerald-500/10 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
    chip: "bg-emerald-500/10 text-emerald-300 ring-1 ring-inset ring-emerald-400/25",
    glow: "group-hover:ring-emerald-400/30",
  },
  warn: {
    label: "Warning",
    dot: "bg-amber-400",
    badge: "bg-amber-500/10 text-amber-300 ring-1 ring-inset ring-amber-400/30",
    chip: "bg-amber-500/10 text-amber-300 ring-1 ring-inset ring-amber-400/25",
    glow: "group-hover:ring-amber-400/30",
  },
  critical: {
    label: "Critical",
    dot: "bg-rose-400",
    badge: "bg-rose-500/10 text-rose-300 ring-1 ring-inset ring-rose-400/30",
    chip: "bg-rose-500/15 text-rose-300 ring-1 ring-inset ring-rose-400/30",
    glow: "group-hover:ring-rose-400/40",
  },
};

const FALLBACK_SEVERITY: SeverityToken = SEVERITY_TOKENS.info;

export function severityToken(severity: string): SeverityToken {
  return SEVERITY_TOKENS[severity as Severity] ?? FALLBACK_SEVERITY;
}

// --- Actor / company labels (resolved at render time) ------------------------

const ACTOR_TYPE_LABEL: Record<string, string> = {
  human: "Operator",
  ai_employee: "AI employee",
  system: "System",
  tenant: "Customer",
};

/**
 * A human label for who did this — payload name/email first, then a humanised
 * actor_type, never a raw UUID. (CEO #005 decision 5: resolve at render time.)
 */
export function actorLabel(event: TimelineEvent): string {
  const p = event.payload ?? {};
  const named = pick(
    p,
    "actor_name",
    "actor_email",
    "agent_name",
    "ai_employee",
    "user_name",
    "user_email",
  );
  if (named) return named;
  if (event.actor_type === "human" && event.actor_id) {
    // Operator ids are usually emails; show as-is, else a short id.
    return event.actor_id.includes("@") ? event.actor_id : shortId(event.actor_id);
  }
  return ACTOR_TYPE_LABEL[event.actor_type] ?? event.actor_type;
}

/** The company/org an event concerns, if the payload carries it. */
export function companyLabel(event: TimelineEvent): string | null {
  const p = event.payload ?? {};
  return pick(p, "company", "org_name", "organisation", "tenant_name", "customer_name", "account_name");
}

// --- Title + description -----------------------------------------------------

const PRETTY_NS: Record<string, string> = {
  ai: "AI",
};

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Generic, never-broken title for any registered (or future) verb. */
function prettifyVerb(verb: string): string {
  const dot = verb.indexOf(".");
  const ns = dot >= 0 ? verb.slice(0, dot) : verb;
  const action = dot >= 0 ? verb.slice(dot + 1) : "";
  const nsLabel = PRETTY_NS[ns] ?? titleCase(ns);
  const actionLabel = action.replace(/_/g, " ");
  return actionLabel ? `${nsLabel} ${actionLabel}` : nsLabel;
}

export type EventDescription = { title: string; description: string };

/**
 * A card's headline + supporting line. Bespoke for the verbs that actually
 * produce today (and a few high-value near-future ones); a clean generic
 * fallback for everything else so nothing ever renders as a raw `verb.string`.
 */
export function describeEvent(event: TimelineEvent): EventDescription {
  const p = event.payload ?? {};
  const title = prettifyVerb(event.verb);

  const number = pick(p, "number", "reference", "ref");
  const name = pick(p, "name", "title", "label");
  const total = gbp(p["total"] ?? p["amount"] ?? p["value"]);
  const company = companyLabel(event);

  // Bespoke descriptions for live + high-value verbs.
  switch (event.verb) {
    case "customer.created":
      return { title, description: joinDot(name ?? "New customer", company) };
    case "customer.updated":
      return { title, description: joinDot(name ?? "Customer details updated", company) };
    case "job.created":
      return { title, description: joinDot(name ?? `Job ${shortId(event.object_id)}`, company) };
    case "job.scheduled":
      return { title, description: joinDot(name ?? `Job ${shortId(event.object_id)}`, pick(p, "scheduled_for", "date")) };
    case "job.completed":
      return { title, description: joinDot(name ?? `Job ${shortId(event.object_id)} completed`, company) };
    case "job.cancelled":
      return { title, description: joinDot(name ?? `Job ${shortId(event.object_id)} cancelled`, company) };
    case "quote.sent":
      return { title, description: joinDot(quoteLine("Quote", number, total), company) };
    case "quote.accepted":
      return { title, description: joinDot(quoteLine("Quote", number, total) + " accepted", company) };
    case "quote.declined":
      return { title, description: joinDot(quoteLine("Quote", number, null) + " declined", company) };
    case "invoice.created":
      return { title, description: joinDot(quoteLine("Invoice", number, total), company) };
    case "invoice.paid":
    case "invoice.payment_succeeded":
      return { title, description: joinDot(quoteLine("Invoice", number, total) + " paid", company) };
    case "invoice.payment_failed":
      return { title, description: joinDot(quoteLine("Invoice", number, total) + " — payment failed", company) };
    case "lead.created":
      return { title, description: joinDot(name ?? "New lead", pick(p, "service", "source")) };
    case "org.created":
      return { title, description: company ?? "New organisation" };
    case "org.trial_started":
      return { title, description: joinDot(company ?? "Trial started", pick(p, "plan")) };
    case "org.churned":
      return { title, description: joinDot(company ?? "Organisation churned", pick(p, "reason")) };
    default:
      break;
  }

  // Generic fallback: object + an interesting payload crumb.
  const crumb = name ?? number ?? total ?? company;
  const obj = `${titleCase(event.object_type)} ${shortId(event.object_id)}`;
  return { title, description: crumb ? joinDot(obj, crumb) : obj };
}

function quoteLine(noun: string, number: string | null, total: string | null): string {
  const head = number ? `${noun} ${number}` : noun;
  return total ? `${head} · ${total}` : head;
}

function joinDot(a: string, b: string | null): string {
  return b ? `${a} · ${b}` : a;
}

// --- Deep links --------------------------------------------------------------

/**
 * A best-effort internal deep link for an event's primary object. HQ-context
 * objects route into /admin; tenant objects route to their canonical page (an
 * operator follows via impersonation). Unknown object types → null (no link).
 */
export function eventHref(event: TimelineEvent): string | null {
  const id = event.object_id;
  switch (event.object_type) {
    case "customer":
      return `/customers/${id}`;
    case "job":
      return `/jobs/${id}`;
    case "quote":
      return `/quotes/${id}`;
    case "invoice":
      return `/invoices/${id}`;
    case "lead":
      return `/leads/${id}`;
    case "org":
    case "organisation":
      return `/admin/customers?org=${id}`;
    case "demo_requests":
    case "demo":
      return `/admin/demos?demo=${id}`;
    case "support_ticket":
    case "ticket":
      return `/admin/support?ticket=${id}`;
    default:
      return null;
  }
}

// --- Day buckets (Today / Yesterday / This Week / Earlier) -------------------

export type DayBucket = "today" | "yesterday" | "week" | "earlier";

export const BUCKET_ORDER: readonly DayBucket[] = ["today", "yesterday", "week", "earlier"];

export const BUCKET_LABEL: Record<DayBucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "This Week",
  earlier: "Earlier",
};

/** YYYY-MM-DD for a date in Europe/London (en-CA yields ISO date order). */
function londonYMD(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Whole-day index for a London YYYY-MM-DD (anchored at noon UTC, DST-safe). */
function dayNumber(ymd: string): number {
  return Math.floor(Date.parse(`${ymd}T12:00:00Z`) / 86_400_000);
}

/**
 * Which bucket an ISO timestamp falls in, relative to "now" in London time.
 * Future-dated rows collapse to "today" (clock skew should never orphan a card).
 */
export function dayBucket(iso: string, now: Date = new Date()): DayBucket {
  const today = dayNumber(londonYMD(now));
  const day = dayNumber(londonYMD(new Date(iso)));
  const diff = today - day;
  if (diff <= 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff <= 7) return "week";
  return "earlier";
}

/** Full, human timestamp for the detail drawer (London time). */
export function absoluteTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

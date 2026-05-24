/**
 * Retention + experience layer — pure module.
 *
 * No Supabase, no server-only. Importable by client + server alike.
 * The server-side data fetcher lives at
 * `server/services/retention-snapshot.ts`; this module just turns the
 * fetched signals into nudges / health / milestones / weekly /
 * inactivity output.
 *
 * Design contract:
 *   - One pure input shape: RetentionSignals.
 *   - One named output per CEO directive widget.
 *   - Deterministic — every call with the same input returns the same
 *     output. Snapshot-testable.
 *   - No "future-proofing". Each widget gets the smallest surface
 *     area the directive demands.
 *
 * Reuses:
 *   - `computeProgress()` from lib/onboarding/checklist for onboarding %.
 *   - `OnboardingSnapshot` for the org/counts shape.
 */

import {
  computeProgress,
  type OnboardingSnapshot,
} from "@/lib/onboarding/checklist";

// =====================================================================
// Input shape
// =====================================================================

export type RetentionSignals = {
  /** Same snapshot the dashboard already uses; covers org fields + counts. */
  onboarding: OnboardingSnapshot;
  /** Window-bucketed activity. Numbers are inclusive of "today". */
  windows: {
    /** Counts over the last 7 days. */
    last_7d: {
      customers_added: number;
      quotes_created: number;
      quotes_accepted: number;
      invoices_sent: number;
      invoiced_gbp: number;
      payments_received_gbp: number;
    };
  };
  /** ISO timestamp of the most recent customer / quote / invoice insert,
   * or null if the org has no activity yet. */
  last_activity_at: string | null;
  /** Count of invoices in `overdue` status. */
  overdue_invoice_count: number;
  /** Sum of all paid + sent invoices' totals. Drives the £-milestones. */
  invoiced_total_gbp: number;
  /** Open support tickets — Phase 2 health/nudge input. */
  support_open_count: number;
  /** Unresolved HQ alerts (admin_alert_state without resolved_at). */
  unresolved_alerts_count: number;
  /** Milestones the org has already celebrated (stored in
   * organizations.onboarding_state.celebrated_milestones). */
  celebrated_milestones: ReadonlySet<MilestoneId>;
  /** Nudges the operator has explicitly dismissed (persisted on
   * organizations.onboarding_state.dismissed_nudges). */
  dismissed_nudges: ReadonlySet<NudgeId>;
  /** Server's idea of "now" — passed in so tests are deterministic. */
  now: string;
};

// =====================================================================
// Nudges — priority engine: impact × urgency
// =====================================================================

export const NUDGE_IMPACT = ["high", "medium", "low"] as const;
export type NudgeImpact = (typeof NUDGE_IMPACT)[number];

export const NUDGE_URGENCY = ["high", "medium", "low"] as const;
export type NudgeUrgency = (typeof NUDGE_URGENCY)[number];

export type NudgeId =
  | "finish_onboarding"
  | "add_first_customer"
  | "create_first_quote"
  | "send_first_invoice"
  | "import_history"
  | "chase_overdue"
  | "upload_logo"
  | "configure_tax"
  | "add_staff"
  | "reply_support"
  | "review_alerts"
  | "weekly_summary"
  | "inactive_quote_drought_soft"
  | "inactive_quote_drought"
  | "complete_company_profile";

export type RetentionNudge = {
  id: NudgeId;
  title: string;
  body: string;
  cta: { label: string; href: string };
  impact: NudgeImpact;
  urgency: NudgeUrgency;
  /** Composite ranking — higher first. impact*3 + urgency*1, both
   *  inverted (high=3, medium=2, low=1). Tie-broken by stable id order. */
  priority: number;
};

const RANK: Record<NudgeImpact | NudgeUrgency, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

export function priorityRank(
  impact: NudgeImpact,
  urgency: NudgeUrgency,
): number {
  return RANK[impact] * 3 + RANK[urgency];
}

/**
 * Generate the priority-ordered nudge list. Returns the top nudges
 * the operator should see today. The dashboard surfaces the top one
 * prominently and the rest as a list.
 *
 * Rules of thumb:
 *   - Hard-required onboarding gates always rank above everything
 *     (operator literally cannot work without them).
 *   - Inactivity beats cosmetic optional steps (don't nag for a logo
 *     when nobody's been in for 2 weeks).
 *   - Overdue invoices are MEDIUM impact / HIGH urgency — money is
 *     at risk but the operator can still work.
 */
export function buildNudges(
  signals: RetentionSignals,
): ReadonlyArray<RetentionNudge> {
  const out: RetentionNudge[] = [];
  const snap = signals.onboarding;
  const progress = computeProgress(snap);

  // 1. Onboarding hasn't started past minimum gate.
  if (!isStepDone(snap, "company_profile")) {
    out.push({
      id: "complete_company_profile",
      title: "Add your company details",
      body: "Trading name, phone, and postcode are required on every quote and invoice.",
      cta: { label: "Open settings", href: "/settings" },
      impact: "high",
      urgency: "high",
      priority: priorityRank("high", "high"),
    });
  }
  if (signals.onboarding.counts.customers === 0) {
    out.push({
      id: "add_first_customer",
      title: "Add your first customer",
      body: "Customers are the anchor for every quote, job, and invoice.",
      cta: { label: "Add customer", href: "/customers/new" },
      impact: "high",
      urgency: "high",
      priority: priorityRank("high", "high"),
    });
  }
  if (signals.onboarding.counts.quotes === 0) {
    out.push({
      id: "create_first_quote",
      title: "Create your first quote",
      body: "Turn a customer into priced work. When accepted, CrewFlow drafts the invoice automatically.",
      cta: { label: "Create quote", href: "/quotes/new" },
      impact: "high",
      urgency: "medium",
      priority: priorityRank("high", "medium"),
    });
  }
  if (
    signals.onboarding.counts.quotes > 0 &&
    signals.onboarding.counts.invoices === 0
  ) {
    out.push({
      id: "send_first_invoice",
      title: "Send your first invoice",
      body: "Closes the loop on accepted quotes and starts the payment timer.",
      cta: { label: "Open invoices", href: "/invoices" },
      impact: "high",
      urgency: "medium",
      priority: priorityRank("high", "medium"),
    });
  }

  // 2. Onboarding still in progress (any incomplete step).
  if (progress.pct < 100 && progress.done >= 1) {
    out.push({
      id: "finish_onboarding",
      title: `Finish setup — ${progress.pct}% complete`,
      body: "Continue the guided checklist. Progress saves as you go.",
      cta: { label: "Continue setup", href: "/onboarding/setup" },
      impact: "high",
      urgency: "medium",
      priority: priorityRank("high", "medium"),
    });
  }

  // 3. Overdue money.
  if (signals.overdue_invoice_count > 0) {
    out.push({
      id: "chase_overdue",
      title: `Chase ${signals.overdue_invoice_count} overdue invoice${
        signals.overdue_invoice_count === 1 ? "" : "s"
      }`,
      body: "Send reminders before the next billing cycle.",
      cta: { label: "Open overdue invoices", href: "/invoices?status=overdue" },
      impact: "medium",
      urgency: "high",
      priority: priorityRank("medium", "high"),
    });
  }

  // 4. Inactivity (no recent quote activity) — only matters once the
  // org has used the system at all.
  const inactiveNudge = inactiveSignal(signals);
  if (inactiveNudge) out.push(inactiveNudge);

  // 5. Migration of historical data.
  if (
    signals.onboarding.counts.importsCommitted === 0 &&
    !snap.dismissed.has("imports")
  ) {
    out.push({
      id: "import_history",
      title: "Import your old spreadsheets",
      body: "Upload CSV / Excel / PDF — CrewFlow detects types and lets you preview before commit.",
      cta: { label: "Open Migration OS", href: "/imports" },
      impact: "medium",
      urgency: "low",
      priority: priorityRank("medium", "low"),
    });
  }

  // 6. Cosmetic: branding.
  if (!snap.org.logo_url && !snap.dismissed.has("logo")) {
    out.push({
      id: "upload_logo",
      title: "Add your logo",
      body: "Customer-facing PDFs look more professional with your branding.",
      cta: { label: "Add logo", href: "/settings" },
      impact: "low",
      urgency: "low",
      priority: priorityRank("low", "low"),
    });
  }

  // 7. Tax/VAT.
  if (!snap.org.vat_number && !snap.dismissed.has("vat")) {
    out.push({
      id: "configure_tax",
      title: "Configure VAT / tax",
      body: "Required on invoices if you're VAT-registered.",
      cta: { label: "Add VAT number", href: "/settings" },
      impact: "low",
      urgency: "low",
      priority: priorityRank("low", "low"),
    });
  }

  // 8. Add staff — Phase 2 directive priority slot #5.
  if (
    signals.onboarding.counts.staffMembers === 0 &&
    !snap.dismissed.has("staff")
  ) {
    out.push({
      id: "add_staff",
      title: "Add a team member",
      body: "Staff can clock in, see their jobs, and free you up from admin.",
      cta: { label: "Invite staff", href: "/staff" },
      impact: "medium",
      urgency: "low",
      priority: priorityRank("medium", "low"),
    });
  }

  // 9. Open support tickets — Phase 2 directive priority slot #8.
  if (signals.support_open_count > 0) {
    out.push({
      id: "reply_support",
      title: `Reply to ${signals.support_open_count} open support ticket${signals.support_open_count === 1 ? "" : "s"}`,
      body: "Your customers are waiting on you.",
      cta: { label: "Open support queue", href: "/support" },
      impact: "medium",
      urgency: "high",
      priority: priorityRank("medium", "high"),
    });
  }

  // 10. Unresolved HQ alerts the operator can act on — Phase 2 #9.
  if (signals.unresolved_alerts_count > 0) {
    out.push({
      id: "review_alerts",
      title: `Review ${signals.unresolved_alerts_count} open alert${signals.unresolved_alerts_count === 1 ? "" : "s"}`,
      body: "CrewFlow's rule engine flagged something. Take a look or snooze.",
      cta: { label: "Open alerts", href: "/admin/alerts" },
      impact: "medium",
      urgency: "medium",
      priority: priorityRank("medium", "medium"),
    });
  }

  // 11. Weekly summary — Phase 2 #10, low-priority informational.
  if (
    signals.onboarding.counts.quotes > 0 &&
    !snap.dismissed.has("first_invoice")
  ) {
    // The "view weekly summary" nudge fires only when there's signal
    // worth viewing (any activity in the last 7 days) AND the user
    // hasn't dismissed it explicitly. Keeps it quiet for brand-new
    // orgs while still nudging active ones to check in.
    const w = signals.windows.last_7d;
    const anySignal =
      w.customers_added + w.quotes_created + w.invoices_sent > 0;
    if (anySignal) {
      out.push({
        id: "weekly_summary",
        title: "Check this week's summary",
        body: "See the numbers behind a productive week — and what to focus on next.",
        cta: { label: "Open dashboard", href: "/dashboard" },
        impact: "low",
        urgency: "low",
        priority: priorityRank("low", "low") - 1, // tie-breaker below other low/low
      });
    }
  }

  // Filter user-dismissed nudges (Phase 2 step 4) and sort.
  return out
    .slice()
    .filter((n) => !signals.dismissed_nudges.has(n.id))
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.id.localeCompare(b.id);
    });
}

/**
 * The single most important nudge — drives the headline banner on
 * the dashboard. Replaces the older onboarding-only
 * `nextRecommendedAction()` for the retention panel.
 */
export function topNudge(signals: RetentionSignals): RetentionNudge | null {
  const list = buildNudges(signals);
  return list[0] ?? null;
}

// =====================================================================
// Health score (customer-facing)
// =====================================================================

export type HealthBand = "green" | "amber" | "red";
export type CustomerHealth = {
  score: number; // 0..100
  band: HealthBand;
  /** Inputs in human-readable shape — drives the "why this score?" copy. */
  drivers: {
    onboarding_pct: number;
    customers: number;
    quotes: number;
    invoices: number;
    overdue: number;
    /** Days since last activity, or null if never active. */
    days_since_activity: number | null;
    support_open: number;
    unresolved_alerts: number;
  };
  /** Up to 3 plain-English reasons explaining the score. */
  reasons: ReadonlyArray<string>;
  /** Up to 3 concrete actions the operator can take to improve. */
  actions: ReadonlyArray<{
    label: string;
    href: string;
  }>;
};

export function computeCustomerHealth(
  signals: RetentionSignals,
): CustomerHealth {
  const progress = computeProgress(signals.onboarding);
  const onboarding_pct = progress.pct;
  const customers = signals.onboarding.counts.customers;
  const quotes = signals.onboarding.counts.quotes;
  const invoices = signals.onboarding.counts.invoices;
  const overdue = signals.overdue_invoice_count;
  const support_open = signals.support_open_count;
  const unresolved_alerts = signals.unresolved_alerts_count;
  const days_since_activity = daysBetween(
    signals.last_activity_at,
    signals.now,
  );

  // Start at 50, layer signals.
  let score = 50;
  score += Math.round((onboarding_pct / 100) * 30);
  if (customers > 0) score += 3;
  if (quotes > 0) score += 5;
  if (invoices > 0) score += 5;
  if (days_since_activity !== null) {
    if (days_since_activity <= 7) score += 7;
    else if (days_since_activity <= 14) score += 0;
    else if (days_since_activity <= 30) score -= 10;
    else score -= 20;
  }
  score -= Math.min(overdue * 4, 20);
  // Phase 2: support + alerts as health drags. Capped so a single
  // unhappy customer can't tank the score below "amber".
  score -= Math.min(support_open * 3, 12);
  score -= Math.min(unresolved_alerts * 2, 10);

  score = clamp(score, 0, 100);
  const band: HealthBand =
    score >= 70 ? "green" : score >= 40 ? "amber" : "red";

  // Build the "3 reasons why" + "3 actions to improve" stripes.
  // We rank candidate drivers by their actual impact on this score
  // and surface the top 3.
  const reasonCandidates: Array<{ delta: number; reason: string }> = [];
  const actionCandidates: Array<{
    delta: number;
    action: { label: string; href: string };
  }> = [];

  if (onboarding_pct < 100) {
    const missing = 100 - onboarding_pct;
    reasonCandidates.push({
      delta: missing * 0.3,
      reason: `Setup ${onboarding_pct}% complete — ${missing}% of the score is waiting on the checklist.`,
    });
    actionCandidates.push({
      delta: missing * 0.3,
      action: { label: "Continue setup", href: "/onboarding/setup" },
    });
  }
  if (days_since_activity !== null && days_since_activity > 14) {
    reasonCandidates.push({
      delta: days_since_activity > 30 ? 20 : 10,
      reason: `${days_since_activity} days since you last created a quote or customer.`,
    });
    actionCandidates.push({
      delta: days_since_activity > 30 ? 20 : 10,
      action: { label: "Create quote", href: "/quotes/new" },
    });
  }
  if (overdue > 0) {
    reasonCandidates.push({
      delta: Math.min(overdue * 4, 20),
      reason: `${overdue} overdue invoice${overdue === 1 ? "" : "s"} dragging your score down.`,
    });
    actionCandidates.push({
      delta: Math.min(overdue * 4, 20),
      action: { label: "Chase overdue", href: "/invoices?status=overdue" },
    });
  }
  if (support_open > 0) {
    reasonCandidates.push({
      delta: Math.min(support_open * 3, 12),
      reason: `${support_open} open support ticket${support_open === 1 ? "" : "s"} from customers.`,
    });
    actionCandidates.push({
      delta: Math.min(support_open * 3, 12),
      action: { label: "Open support", href: "/support" },
    });
  }
  if (customers === 0) {
    reasonCandidates.push({
      delta: 3,
      reason: "No customers added yet.",
    });
    actionCandidates.push({
      delta: 3,
      action: { label: "Add customer", href: "/customers/new" },
    });
  }
  if (quotes === 0) {
    reasonCandidates.push({
      delta: 5,
      reason: "No quote sent yet — the pipeline starts there.",
    });
    actionCandidates.push({
      delta: 5,
      action: { label: "Create quote", href: "/quotes/new" },
    });
  }
  if (
    days_since_activity !== null &&
    days_since_activity <= 7 &&
    band === "green"
  ) {
    reasonCandidates.push({
      delta: 7,
      reason: "Active in the last week — recent activity boosts the score.",
    });
  }

  reasonCandidates.sort((a, b) => b.delta - a.delta);
  actionCandidates.sort((a, b) => b.delta - a.delta);
  // De-dup actions by href; keep the highest-impact occurrence.
  const seenHrefs = new Set<string>();
  const uniqueActions = actionCandidates.filter((a) => {
    if (seenHrefs.has(a.action.href)) return false;
    seenHrefs.add(a.action.href);
    return true;
  });

  return {
    score,
    band,
    drivers: {
      onboarding_pct,
      customers,
      quotes,
      invoices,
      overdue,
      days_since_activity,
      support_open,
      unresolved_alerts,
    },
    reasons: reasonCandidates.slice(0, 3).map((r) => r.reason),
    actions: uniqueActions.slice(0, 3).map((a) => a.action),
  };
}

// =====================================================================
// Milestones
// =====================================================================

export const MILESTONE_IDS = [
  "first_customer",
  "first_quote",
  "first_invoice",
  "first_employee",
  "ten_customers",
  "fifty_customers",
  "hundred_customers",
  "ten_quotes",
  "invoiced_one_k",
  "invoiced_ten_k",
  "invoiced_hundred_k",
  "onboarding_complete",
] as const;
export type MilestoneId = (typeof MILESTONE_IDS)[number];

export type Milestone = {
  id: MilestoneId;
  title: string;
  emoji: string;
  body: string;
};

const MILESTONE_DEFS: Record<MilestoneId, Omit<Milestone, "id">> = {
  first_customer: {
    title: "First customer added",
    emoji: "🎉",
    body: "The anchor for every quote and invoice from here on.",
  },
  first_quote: {
    title: "First quote created",
    emoji: "🎉",
    body: "Your priced work is in CrewFlow.",
  },
  first_invoice: {
    title: "First invoice sent",
    emoji: "🎉",
    body: "Payment timer started. Reminders are automatic.",
  },
  first_employee: {
    title: "First teammate added",
    emoji: "🎉",
    body: "They can clock in and see their own jobs.",
  },
  ten_customers: {
    title: "10 customers",
    emoji: "🚀",
    body: "Your book of work is building.",
  },
  fifty_customers: {
    title: "50 customers",
    emoji: "🚀",
    body: "A real operation.",
  },
  hundred_customers: {
    title: "100 customers",
    emoji: "🏆",
    body: "Serious scale. Onboarding the team yet?",
  },
  ten_quotes: {
    title: "10 quotes sent",
    emoji: "📈",
    body: "Your conversion rate is starting to mean something.",
  },
  invoiced_one_k: {
    title: "£1,000 invoiced",
    emoji: "💷",
    body: "First grand through the system.",
  },
  invoiced_ten_k: {
    title: "£10,000 invoiced",
    emoji: "💷",
    body: "Healthy momentum.",
  },
  invoiced_hundred_k: {
    title: "£100,000 invoiced",
    emoji: "💎",
    body: "Six figures live in CrewFlow.",
  },
  onboarding_complete: {
    title: "Setup complete",
    emoji: "✅",
    body: "Every checklist item is ticked.",
  },
};

/**
 * Return milestones the org has currently REACHED. Idempotent —
 * doesn't track celebration state; that's `unseenMilestones`'s job.
 */
export function reachedMilestones(
  signals: RetentionSignals,
): ReadonlyArray<MilestoneId> {
  const out: MilestoneId[] = [];
  const counts = signals.onboarding.counts;
  if (counts.customers >= 1) out.push("first_customer");
  if (counts.customers >= 10) out.push("ten_customers");
  if (counts.customers >= 50) out.push("fifty_customers");
  if (counts.customers >= 100) out.push("hundred_customers");
  if (counts.quotes >= 1) out.push("first_quote");
  if (counts.quotes >= 10) out.push("ten_quotes");
  if (counts.invoices >= 1) out.push("first_invoice");
  if (counts.staffMembers >= 1) out.push("first_employee");
  if (signals.invoiced_total_gbp >= 1_000) out.push("invoiced_one_k");
  if (signals.invoiced_total_gbp >= 10_000) out.push("invoiced_ten_k");
  if (signals.invoiced_total_gbp >= 100_000) out.push("invoiced_hundred_k");
  if (computeProgress(signals.onboarding).pct === 100) {
    out.push("onboarding_complete");
  }
  return out;
}

/**
 * Milestones reached AND not yet celebrated — drive the celebration UX.
 * The dashboard surfaces these, then a server action moves them into
 * the `celebrated_milestones` set so we don't re-show next render.
 */
export function unseenMilestones(
  signals: RetentionSignals,
): ReadonlyArray<Milestone> {
  return reachedMilestones(signals)
    .filter((id) => !signals.celebrated_milestones.has(id))
    .map((id) => ({ id, ...MILESTONE_DEFS[id] }));
}

export function milestoneById(id: MilestoneId): Milestone {
  return { id, ...MILESTONE_DEFS[id] };
}

// =====================================================================
// Weekly summary
// =====================================================================

export type WeeklySummary = {
  customers_added: number;
  quotes_created: number;
  quotes_accepted: number;
  invoices_sent: number;
  invoiced_gbp: number;
  payments_received_gbp: number;
  /** Is there anything to show? Drives "Nothing yet this week" empty state. */
  hasSignal: boolean;
};

export function buildWeeklySummary(
  signals: RetentionSignals,
): WeeklySummary {
  const w = signals.windows.last_7d;
  const hasSignal =
    w.customers_added +
      w.quotes_created +
      w.quotes_accepted +
      w.invoices_sent +
      w.invoiced_gbp +
      w.payments_received_gbp >
    0;
  return {
    customers_added: w.customers_added,
    quotes_created: w.quotes_created,
    quotes_accepted: w.quotes_accepted,
    invoices_sent: w.invoices_sent,
    invoiced_gbp: w.invoiced_gbp,
    payments_received_gbp: w.payments_received_gbp,
    hasSignal,
  };
}

// =====================================================================
// Inactivity rescue
// =====================================================================

/**
 * Inactivity ladder per Phase 2 directive step 7:
 *   - SOFT (7d):    dashboard nudge ("just checking in")
 *   - STRONG (14d): louder dashboard nudge ("haven't created a quote")
 *   - RISK (30d):   HQ visibility — already covered by HQ-5's
 *                   `customer_inactive` alert rule which fires at the
 *                   THRESHOLDS.customerInactiveDays (14d) threshold and
 *                   stays HOT past 30d. No double-signal here.
 */
export const INACTIVE_SOFT_DAYS = 7;
export const INACTIVE_STRONG_DAYS = 14;
export const INACTIVE_RISK_DAYS = 30;

/** Back-compat alias — old code referenced this constant. */
export const INACTIVE_QUOTE_DAYS = INACTIVE_STRONG_DAYS;

export type InactivitySeverity = "ok" | "soft" | "strong" | "risk";

export function inactivitySeverity(
  signals: RetentionSignals,
): InactivitySeverity {
  if (signals.onboarding.counts.quotes === 0) return "ok";
  const days = daysBetween(signals.last_activity_at, signals.now);
  if (days === null) return "ok";
  if (days >= INACTIVE_RISK_DAYS) return "risk";
  if (days >= INACTIVE_STRONG_DAYS) return "strong";
  if (days >= INACTIVE_SOFT_DAYS) return "soft";
  return "ok";
}

/**
 * Return a nudge based on the inactivity ladder. Brand-new orgs (no
 * quote ever) get the onboarding nudges instead — we don't tell
 * day-1 users they're "inactive".
 */
export function inactiveSignal(
  signals: RetentionSignals,
): RetentionNudge | null {
  const sev = inactivitySeverity(signals);
  if (sev === "ok") return null;
  const days = daysBetween(signals.last_activity_at, signals.now) ?? 0;

  if (sev === "soft") {
    return {
      id: "inactive_quote_drought_soft",
      title: `Quick check-in — ${days} days since a new quote`,
      body: "Nothing wrong yet, but the pipeline runs on momentum. One new quote keeps it warm.",
      cta: { label: "Create quote", href: "/quotes/new" },
      impact: "medium",
      urgency: "medium",
      priority: priorityRank("medium", "medium"),
    };
  }
  // strong + risk both surface the louder nudge; HQ-side risk
  // visibility is handled by the existing alert rules.
  return {
    id: "inactive_quote_drought",
    title: `You haven't created a quote in ${days} days`,
    body:
      sev === "risk"
        ? "It's been over a month. Reach out to a recent lead — or check in with an existing customer."
        : "Pick up a recent lead, or revisit a stalled customer — a single sent quote keeps the pipeline alive.",
    cta: { label: "Create quote", href: "/quotes/new" },
    impact: "high",
    urgency: sev === "risk" ? "high" : "medium",
    priority: priorityRank("high", sev === "risk" ? "high" : "medium"),
  };
}

// =====================================================================
// Helpers
// =====================================================================

function isStepDone(
  snap: OnboardingSnapshot,
  id: "company_profile" | "logo" | "vat" | "bank",
): boolean {
  switch (id) {
    case "company_profile":
      return Boolean(
        snap.org.name && snap.org.phone && snap.org.address?.postcode,
      );
    case "logo":
      return Boolean(snap.org.logo_url);
    case "vat":
      return Boolean(snap.org.vat_number);
    case "bank":
      return Boolean(
        snap.org.bank_details?.sort_code && snap.org.bank_details?.account_number,
      );
  }
}

function daysBetween(iso: string | null, nowIso: string): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  const n = new Date(nowIso).getTime();
  if (!Number.isFinite(t) || !Number.isFinite(n)) return null;
  return Math.floor((n - t) / 86_400_000);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import {
  OVERDUE_COLLECTABLE_STATUSES,
  invoiceBusinessToday,
} from "@/lib/invoices/overdue";
import { buildOnboardingSnapshot } from "@/server/services/onboarding-snapshot";
import type { OnboardingSnapshot } from "@/lib/onboarding/checklist";
import type {
  MilestoneId,
  NudgeId,
  RetentionSignals,
} from "@/lib/retention/signals";

/**
 * Pull every signal the retention layer needs in a small, fixed
 * number of batched queries. Uses the user JWT (server client) so
 * RLS scopes everything to the caller's org automatically — no
 * cross-tenant leak possible.
 *
 * Numbers are inclusive of "today". Date arithmetic is done in JS
 * (UTC ISO strings) so the result is reproducible from any client TZ.
 *
 * Reuses:
 *   - `buildOnboardingSnapshot()` for the org/counts/timestamps shape
 *     the retention module's `RetentionSignals.onboarding` expects.
 */

const SEVEN_DAYS_MS = 7 * 86_400_000;
/** Stored in organizations.onboarding_state.celebrated_milestones[]. */
const CELEBRATED_KEY = "celebrated_milestones" as const;
/** Stored in organizations.onboarding_state.dismissed_nudges[]. */
const DISMISSED_NUDGES_KEY = "dismissed_nudges" as const;

export async function buildRetentionSnapshot(
  orgId: string,
  opts?: {
    /**
     * Pre-built onboarding snapshot (or its in-flight promise) to reuse
     * instead of building a fresh one. The dashboard already builds this
     * for its SetupChecklist card, so passing it in avoids a duplicate
     * org-row fetch + 5 count round-trips per page load. When omitted
     * (e.g. the AI-question path) we build our own as before.
     */
    onboarding?: OnboardingSnapshot | Promise<OnboardingSnapshot>;
  },
): Promise<RetentionSignals> {
  const supabase = await createClient();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const sevenDaysAgo = new Date(nowMs - SEVEN_DAYS_MS).toISOString();

  // Reuse the onboarding snapshot wholesale — gives us org + counts +
  // dismissed + timestamps in one call. Awaiting a passed-in promise is
  // safe: promises memoise, so a shared promise runs the work only once.
  const onboarding = await (opts?.onboarding ?? buildOnboardingSnapshot(orgId));

  // ------------------------------------------------------------------
  // Parallel batched reads. All RLS-scoped via user JWT.
  // ------------------------------------------------------------------
  const [
    customers7Res,
    quotes7Res,
    quotesAccepted7Res,
    invoices7Res,
    payments7Res,
    invoicesTotalRes,
    overdueRes,
    supportOpenRes,
    alertsUnresolvedRes,
    lastActivityRes,
  ] = await Promise.all([
    supabase
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .gte("created_at", sevenDaysAgo),
    supabase
      .from("quotes")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .gte("created_at", sevenDaysAgo),
    supabase
      .from("quotes")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "accepted")
      .gte("accepted_at", sevenDaysAgo),
    supabase
      .from("invoices")
      .select("id, total", { count: "exact" })
      .eq("org_id", orgId)
      .gte("created_at", sevenDaysAgo),
    supabase
      .from("invoice_payments")
      .select("amount")
      .eq("org_id", orgId)
      .gte("paid_at", sevenDaysAgo.slice(0, 10)),
    // All-time invoiced (sent + paid, not draft / void). PAGED (F-1): this feeds
    // the `invoiced_total_gbp` SUM below, so a bare `.select()` truncated at the
    // 1000-row cap would silently under-state lifetime invoiced revenue once an
    // org crosses 1000 non-draft invoices.
    fetchAllRows((from, to) =>
      supabase
        .from("invoices")
        .select("id, total, status")
        .eq("org_id", orgId)
        .in("status", ["sent", "paid", "awaiting_payment", "partially_paid", "overdue"])
        .order("id", { ascending: true })
        .range(from, to),
    ),
    // Overdue count — DERIVED, matching lib/invoices/overdue.ts exactly.
    //
    // This previously filtered `.eq("status", "overdue")`, which counted only
    // invoices someone had manually marked. Nothing kept that value current, so
    // the figure was effectively always 0 — and it feeds `signals.ts`
    // (`score -= min(overdue * 4, 20)`) and ai-question's "No overdue invoices
    // right now." Both were therefore reporting on a number that never moved.
    //
    // BEHAVIOUR CHANGE, called out deliberately: this now returns real counts,
    // so health scores can drop by up to 20 points where overdue invoices
    // genuinely exist. That is the correct figure finally being counted, not a
    // regression — and suppressing it to preserve the old score would be
    // preserving a bug. See the PR report.
    //
    // The predicate is expressed at the DB (status ∈ collectable AND due_date <
    // today) so it selects exactly the population isInvoiceOverdue() accepts.
    supabase
      .from("invoices")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .in("status", [...OVERDUE_COLLECTABLE_STATUSES])
      .lt("due_date", invoiceBusinessToday()),
    // Phase 2 — open support tickets count toward health drag.
    // "open" = anything not 'resolved' / 'closed'. Cast past the
    // generated supabase types since `support_tickets` is not yet
    // in the types bundle.
    supabase
      .from("support_tickets" as never)
      .select("id" as never, { count: "exact", head: true })
      .eq("org_id" as never, orgId)
      .not("status" as never, "in", "(resolved,closed)"),
    // Phase 2 — unresolved + unsnoozed admin_alert_state rows for this org.
    supabase
      .from("admin_alert_state" as never)
      .select("id" as never, { count: "exact", head: true })
      .eq("org_id" as never, orgId)
      .is("resolved_at" as never, null),
    // Most-recent activity: pick newest created_at across the three
    // tables. One small query each — they index `org_id, created_at`.
    supabase
      .from("quotes")
      .select("created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const invoicesTotalRows =
    (invoicesTotalRes.data as Array<{ total: number | string | null }> | null) ??
    [];
  const invoiced_total_gbp = invoicesTotalRows.reduce(
    (acc, r) => acc + Number(r.total ?? 0),
    0,
  );

  const invoiced7Rows =
    (invoices7Res.data as Array<{ total: number | string | null }> | null) ?? [];
  const invoiced_gbp_7d = invoiced7Rows.reduce(
    (acc, r) => acc + Number(r.total ?? 0),
    0,
  );

  const payments7Rows =
    (payments7Res.data as Array<{ amount: number | string | null }> | null) ??
    [];
  const payments_received_gbp_7d = payments7Rows.reduce(
    (acc, r) => acc + Number(r.amount ?? 0),
    0,
  );

  // Fan out the last-activity probe across customers + invoices too —
  // catches orgs that haven't quoted recently but ARE still working.
  const [
    { data: lastCustomer },
    { data: lastInvoice },
  ] = await Promise.all([
    supabase
      .from("customers")
      .select("created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("invoices")
      .select("created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const lastActivityCandidates = [
    (lastActivityRes.data as { created_at: string } | null)?.created_at,
    (lastCustomer as { created_at: string } | null)?.created_at,
    (lastInvoice as { created_at: string } | null)?.created_at,
  ].filter((v): v is string => typeof v === "string");
  const last_activity_at =
    lastActivityCandidates.sort().pop() ?? null;

  // Celebrated milestones live on organizations.onboarding_state.
  // The onboarding snapshot stops before this key, so fetch the raw row.
  const { data: orgState, error: orgStateError } = await supabase
    .from("organizations")
    .select("onboarding_state")
    .eq("id", orgId)
    .maybeSingle();
  if (orgStateError) {
    throw readFailure("retention-snapshot: onboarding_state", orgStateError);
  }
  const stateRaw = (orgState?.onboarding_state ?? {}) as Record<
    string,
    unknown
  >;
  const celebratedArr = Array.isArray(stateRaw[CELEBRATED_KEY])
    ? (stateRaw[CELEBRATED_KEY] as string[])
    : [];
  const celebrated_milestones = new Set<MilestoneId>(
    celebratedArr as MilestoneId[],
  );

  const dismissedNudgesArr = Array.isArray(stateRaw[DISMISSED_NUDGES_KEY])
    ? (stateRaw[DISMISSED_NUDGES_KEY] as string[])
    : [];
  const dismissed_nudges = new Set<NudgeId>(dismissedNudgesArr as NudgeId[]);

  return {
    onboarding,
    windows: {
      last_7d: {
        customers_added: customers7Res.count ?? 0,
        quotes_created: quotes7Res.count ?? 0,
        quotes_accepted: quotesAccepted7Res.count ?? 0,
        invoices_sent: invoices7Res.count ?? 0,
        invoiced_gbp: invoiced_gbp_7d,
        payments_received_gbp: payments_received_gbp_7d,
      },
    },
    last_activity_at,
    overdue_invoice_count: overdueRes.count ?? 0,
    support_open_count: supportOpenRes.count ?? 0,
    unresolved_alerts_count: alertsUnresolvedRes.count ?? 0,
    invoiced_total_gbp,
    celebrated_milestones,
    dismissed_nudges,
    now: nowIso,
  };
}

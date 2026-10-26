import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import {
  OVERDUE_COLLECTABLE_STATUSES,
  invoiceBusinessToday,
} from "@/lib/invoices/overdue";
import {
  buildOnboardingSnapshot,
  type DashboardQuoteRow,
  type DashboardInvoiceRow,
} from "@/server/services/onboarding-snapshot";
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
    /**
     * Pre-fetched org quote rows (or their in-flight promise) to derive the
     * three quote signals from (7-day created count, 7-day accepted count,
     * newest-quote timestamp) instead of issuing three dedicated `quotes`
     * reads. The dashboard already fetches the full quote ledger in its
     * coreWave; this set is its strict superset, so the in-memory filters
     * yield identical values. When omitted (e.g. the AI-question path) the
     * three reads run as before. Same user-JWT security context either way.
     */
    quotes?: DashboardQuoteRow[] | Promise<DashboardQuoteRow[]>;
    /**
     * Pre-fetched org invoice rows (or their in-flight promise) to derive the
     * four invoice signals from (7-day created count + invoiced £, all-time
     * invoiced £ over the non-draft statuses, derived overdue count, and the
     * newest-invoice timestamp for the last-activity probe) instead of issuing
     * four dedicated `invoices` reads. The dashboard already fetches the full
     * invoice ledger in its coreWave; this set is its strict superset (all org
     * invoices, every column these signals need: status · total · due_date ·
     * created_at), so the in-memory filters yield identical values. When omitted
     * (e.g. the AI-question path) the four reads run as before. Same user-JWT
     * security context either way. These reads were already best-effort (soft):
     * the dashboard's coreWave invoice result is `?? []`-coalesced, so reusing
     * it preserves the retention snapshot's existing soft posture — no loud
     * money read is turned soft.
     */
    invoices?: DashboardInvoiceRow[] | Promise<DashboardInvoiceRow[]>;
  },
): Promise<RetentionSignals> {
  const supabase = await createClient();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const sevenDaysAgo = new Date(nowMs - SEVEN_DAYS_MS).toISOString();

  // Reuse the onboarding snapshot wholesale — gives us org + counts +
  // dismissed + timestamps in one call. Awaiting a passed-in promise is
  // safe: promises memoise, so a shared promise runs the work only once.
  // The shared quote + invoice rows (when provided) are awaited alongside it —
  // same single await-gate as before, no added serialisation.
  const [onboarding, sharedQuotes, sharedInvoices] = await Promise.all([
    opts?.onboarding ?? buildOnboardingSnapshot(orgId),
    opts?.quotes ? Promise.resolve(opts.quotes) : Promise.resolve(null),
    opts?.invoices ? Promise.resolve(opts.invoices) : Promise.resolve(null),
  ]);
  // Business "today" for the derived overdue predicate — computed once so the
  // in-memory filter and the DB fallback below judge against the same instant.
  const overdueToday = invoiceBusinessToday();
  // All-time invoiced statuses (sent + paid, not draft / void) — the same set
  // the DB `.in(...)` fallback uses; shared so the two paths stay in lockstep.
  const INVOICED_STATUSES = [
    "sent",
    "paid",
    "awaiting_payment",
    "partially_paid",
    "overdue",
  ] as const;

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
    // Quotes created in the last 7 days — derived from the shared superset when
    // present (same org; created_at >= sevenDaysAgo), else read as a count.
    sharedQuotes
      ? {
          count: sharedQuotes.filter((q) => q.created_at >= sevenDaysAgo).length,
        }
      : supabase
          .from("quotes")
          .select("id", { count: "exact", head: true })
          .eq("org_id", orgId)
          .gte("created_at", sevenDaysAgo),
    // Quotes accepted in the last 7 days — status 'accepted' AND accepted_at in
    // window. A row with a null accepted_at fails the DB `.gte`, so the
    // in-memory guard requires a non-null accepted_at too (identical population).
    sharedQuotes
      ? {
          count: sharedQuotes.filter(
            (q) =>
              q.status === "accepted" &&
              q.accepted_at != null &&
              q.accepted_at >= sevenDaysAgo,
          ).length,
        }
      : supabase
          .from("quotes")
          .select("id", { count: "exact", head: true })
          .eq("org_id", orgId)
          .eq("status", "accepted")
          .gte("accepted_at", sevenDaysAgo),
    // Invoices created in the last 7 days — feeds BOTH `invoices_sent` (count)
    // and the `invoiced_gbp_7d` SUM. Derived from the shared superset when
    // present (same org; created_at >= sevenDaysAgo), yielding an identical row
    // set to the paged read. When no shared set is handed in this stays PAGED
    // (F-1): a bare `.select()` clamped at max_rows (1000) would under-state a
    // busy org's 7-day invoiced revenue AND its sent-count, so the fallback
    // pages and derives the count from the full row set's length.
    sharedInvoices
      ? {
          data: sharedInvoices.filter((i) => i.created_at >= sevenDaysAgo),
        }
      : fetchAllRows<{ total: number | string | null }>((from, to) =>
          supabase
            .from("invoices")
            .select("id, total")
            .eq("org_id", orgId)
            .gte("created_at", sevenDaysAgo)
            .order("id", { ascending: true })
            .range(from, to),
        ),
    // PAGED (F-1): feeds the `payments_received_gbp_7d` SUM — same truncation
    // class as the invoices set above.
    fetchAllRows<{ amount: number | string | null }>((from, to) =>
      supabase
        .from("invoice_payments")
        .select("id, amount")
        .eq("org_id", orgId)
        .gte("paid_at", sevenDaysAgo.slice(0, 10))
        .order("id", { ascending: true })
        .range(from, to),
    ),
    // All-time invoiced (sent + paid, not draft / void) — feeds the
    // `invoiced_total_gbp` SUM. Derived from the shared superset when present
    // (same org; status ∈ INVOICED_STATUSES — identical population to the DB
    // `.in(...)`). When no shared set is handed in this stays PAGED (F-1): a bare
    // `.select()` truncated at the 1000-row cap would silently under-state
    // lifetime invoiced revenue once an org crosses 1000 non-draft invoices.
    sharedInvoices
      ? {
          data: sharedInvoices.filter((i) =>
            (INVOICED_STATUSES as readonly string[]).includes(i.status ?? ""),
          ),
        }
      : fetchAllRows((from, to) =>
          supabase
            .from("invoices")
            .select("id, total, status")
            .eq("org_id", orgId)
            .in("status", [...INVOICED_STATUSES])
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
    // Derived from the shared superset when present: status ∈ collectable AND a
    // NON-NULL due_date strictly before business-today. The null guard mirrors
    // SQL — `due_date < today` is NULL (excluded) for a null due_date — so the
    // in-memory population is identical to the DB count.
    sharedInvoices
      ? {
          count: sharedInvoices.filter(
            (i) =>
              (OVERDUE_COLLECTABLE_STATUSES as readonly string[]).includes(
                i.status ?? "",
              ) &&
              i.due_date != null &&
              i.due_date < overdueToday,
          ).length,
        }
      : supabase
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
    // Derived from the shared quote set when present (max created_at ===
    // the newest-first single-row read the DB would return).
    sharedQuotes
      ? {
          data: sharedQuotes.length
            ? {
                created_at: sharedQuotes.reduce(
                  (max, q) => (q.created_at > max ? q.created_at : max),
                  sharedQuotes[0]!.created_at,
                ),
              }
            : null,
        }
      : supabase
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

  const invoiced7Rows = invoices7Res.data;
  const invoiced_gbp_7d = invoiced7Rows.reduce(
    (acc, r) => acc + Number(r.total ?? 0),
    0,
  );

  const payments7Rows = payments7Res.data;
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
    // Newest invoice created_at — derived from the shared superset when present
    // (max created_at === the newest-first single-row read the DB would return),
    // else read as a single row. Same org, same column.
    sharedInvoices
      ? Promise.resolve({
          data: sharedInvoices.length
            ? {
                created_at: sharedInvoices.reduce(
                  (max, i) => (i.created_at > max ? i.created_at : max),
                  sharedInvoices[0]!.created_at,
                ),
              }
            : null,
        })
      : supabase
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
        // Count derived from the fully-paged row set (see the paged read above),
        // never a truncatable `count` on a clamped page.
        invoices_sent: invoiced7Rows.length,
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

import "server-only";
import { createClient } from "@/lib/supabase/server";
import { buildOnboardingSnapshot } from "@/server/services/onboarding-snapshot";
import type {
  MilestoneId,
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

export async function buildRetentionSnapshot(
  orgId: string,
): Promise<RetentionSignals> {
  const supabase = await createClient();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const sevenDaysAgo = new Date(nowMs - SEVEN_DAYS_MS).toISOString();

  // Reuse the onboarding snapshot wholesale — gives us org + counts +
  // dismissed + timestamps in one call.
  const onboarding = await buildOnboardingSnapshot(orgId);

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
    // All-time invoiced (sent + paid, not draft / void).
    supabase
      .from("invoices")
      .select("total, status")
      .eq("org_id", orgId)
      .in("status", ["sent", "paid", "awaiting_payment", "partially_paid", "overdue"]),
    supabase
      .from("invoices")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "overdue"),
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
  const { data: orgState } = await supabase
    .from("organizations")
    .select("onboarding_state")
    .eq("id", orgId)
    .maybeSingle();
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
    invoiced_total_gbp,
    celebrated_milestones,
    now: nowIso,
  };
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { HealthDeepDiveRow } from "@/lib/hq/health-deep-dive";

/**
 * CrewFlow HQ — Customer Health Deep Dive snapshot service (HQ-11).
 *
 * Aggregates per-customer signals from organizations + health_score_events
 * + support_tickets + billing_invoices + notifications in a small
 * number of batched IN queries — no N+1.
 *
 * Service-role only.
 */

type AnyQuery = {
  eq: (k: string, v: unknown) => AnyQuery;
  in: (k: string, v: unknown[]) => AnyQuery;
  is: (k: string, v: unknown) => AnyQuery;
  not: (k: string, op: string, v: unknown) => AnyQuery;
  order: (k: string, opts: { ascending: boolean }) => Promise<{
    data: unknown[] | null;
    error: { message: string } | null;
  }> & AnyQuery;
  limit: (n: number) => Promise<{
    data: unknown[] | null;
    error: { message: string } | null;
  }> & AnyQuery;
};

function table(name: string) {
  const c = createAdminClient();
  return c.from(name as never) as unknown as {
    select: (cols: string) => AnyQuery;
  };
}

type OrgRow = {
  id: string;
  name: string;
  status: string;
  setup_fee_status: string | null;
  mrr_gbp: number | string | null;
  last_login_at: string | null;
  onboarding_percent: number | null;
  migration_percent: number | null;
  health_score: number | null;
  health_recomputed_at: string | null;
  created_at: string;
};

type HealthEventRow = {
  org_id: string;
  new_score: number;
  recomputed_at: string;
};

type TicketRow = { org_id: string; status: string; priority: string };
type InvoiceRow = {
  org_id: string;
  status: string;
  amount_gbp: number | string;
  failed_at: string | null;
};
type NotificationRow = { org_id: string; created_at: string; audience: string };

// ---------------------------------------------------------------------
// MAIN — list every customer with deep-dive data.
// ---------------------------------------------------------------------

export async function listHealthDeepDive(): Promise<HealthDeepDiveRow[]> {
  // 1. Orgs.
  const orgsRes = await table("organizations")
    .select(
      [
        "id",
        "name",
        "status",
        "setup_fee_status",
        "mrr_gbp",
        "last_login_at",
        "onboarding_percent",
        "migration_percent",
        "health_score",
        "health_recomputed_at",
        "created_at",
      ].join(", "),
    )
    .order("name", { ascending: true });
  const orgs = (orgsRes.data ?? []) as unknown as OrgRow[];
  if (orgs.length === 0) return [];

  const orgIds = orgs.map((o) => o.id);

  // 2. Health events for trend (last 5 per org — fetched as one
  // batched query, bucketed in memory).
  const eventsRes = await table("health_score_events")
    .select("org_id, new_score, recomputed_at")
    .in("org_id", orgIds)
    .order("recomputed_at", { ascending: false })
    .limit(1000); // bounded sample; PostgREST clamps to max_rows=1000; per-org slice below
  const events = (eventsRes.data ?? []) as unknown as HealthEventRow[];
  const trendByOrg = new Map<
    string,
    Array<{ recomputed_at: string; score: number }>
  >();
  for (const e of events) {
    const list = trendByOrg.get(e.org_id) ?? [];
    if (list.length < 5) {
      list.push({ recomputed_at: e.recomputed_at, score: e.new_score });
      trendByOrg.set(e.org_id, list);
    }
  }

  // 3. Support tickets.
  const ticketsRes = await table("support_tickets")
    .select("org_id, status, priority")
    .in("org_id", orgIds)
    .order("created_at", { ascending: false });
  const tickets = (ticketsRes.data ?? []) as unknown as TicketRow[];
  const ticketStats = new Map<
    string,
    { active: number; urgent: number }
  >();
  for (const t of tickets) {
    const isActive =
      t.status === "open" ||
      t.status === "in_progress" ||
      t.status === "waiting_on_customer";
    if (!isActive) continue;
    const cur = ticketStats.get(t.org_id) ?? { active: 0, urgent: 0 };
    cur.active++;
    if (t.priority === "urgent") cur.urgent++;
    ticketStats.set(t.org_id, cur);
  }

  // 4. Billing invoices — outstanding + failed-90d.
  const invRes = await table("billing_invoices")
    .select("org_id, status, amount_gbp, failed_at")
    .in("org_id", orgIds)
    .order("created_at", { ascending: false });
  const invoices = (invRes.data ?? []) as unknown as InvoiceRow[];
  const billingStats = new Map<
    string,
    { outstanding: number; failed_90d: number }
  >();
  const ninetyDaysAgo = Date.now() - 90 * 86_400_000;
  for (const i of invoices) {
    const stats = billingStats.get(i.org_id) ?? {
      outstanding: 0,
      failed_90d: 0,
    };
    if (i.status === "sent" || i.status === "failed") {
      stats.outstanding += Number(i.amount_gbp ?? 0);
    }
    if (
      i.status === "failed" &&
      i.failed_at &&
      new Date(i.failed_at).getTime() >= ninetyDaysAgo
    ) {
      stats.failed_90d++;
    }
    billingStats.set(i.org_id, stats);
  }

  // 5. HQ notifications 7d.
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const notifRes = await table("notifications")
    .select("org_id, created_at, audience")
    .in("org_id", orgIds)
    .in("audience", ["hq", "both"])
    .order("created_at", { ascending: false })
    .limit(1000);
  const notifs = (notifRes.data ?? []) as unknown as NotificationRow[];
  const notifsByOrg = new Map<string, number>();
  for (const n of notifs) {
    if (n.created_at >= sevenDaysAgo) {
      notifsByOrg.set(n.org_id, (notifsByOrg.get(n.org_id) ?? 0) + 1);
    }
  }

  // ---- Map orgs → rows ----
  const now = Date.now();
  return orgs.map<HealthDeepDiveRow>((o) => {
    const tickets = ticketStats.get(o.id) ?? { active: 0, urgent: 0 };
    const billing = billingStats.get(o.id) ?? {
      outstanding: 0,
      failed_90d: 0,
    };
    const trend = (trendByOrg.get(o.id) ?? []).slice().reverse();
    return {
      org_id: o.id,
      org_name: o.name,
      status: o.status,
      health_score: o.health_score,
      health_recomputed_at: o.health_recomputed_at,
      trend,
      mrr_gbp: Number(o.mrr_gbp ?? 0),
      setup_fee_status: o.setup_fee_status ?? "pending",
      days_since_login:
        o.last_login_at !== null
          ? Math.floor(
              (now - new Date(o.last_login_at).getTime()) / 86_400_000,
            )
          : null,
      days_since_signup: Math.floor(
        (now - new Date(o.created_at).getTime()) / 86_400_000,
      ),
      onboarding_percent: Number(o.onboarding_percent ?? 0),
      migration_percent: Number(o.migration_percent ?? 0),
      active_support_tickets: tickets.active,
      urgent_support_tickets: tickets.urgent,
      outstanding_gbp: billing.outstanding,
      failed_payments_90d: billing.failed_90d,
      notifications_7d: notifsByOrg.get(o.id) ?? 0,
    };
  });
}

// ---------------------------------------------------------------------
// Per-org timeline (used by /admin/customers/[id] health section).
// ---------------------------------------------------------------------

export async function listHealthHistoryForOrg(
  orgId: string,
  limit = 50,
): Promise<
  Array<{
    id: string;
    old_score: number | null;
    new_score: number;
    delta: number | null;
    trigger: string;
    reasons: ReadonlyArray<string>;
    recomputed_at: string;
  }>
> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("health_score_events" as never)
    .select(
      "id, old_score, new_score, delta, trigger, reasons, recomputed_at" as never,
    )
    .eq("org_id" as never, orgId)
    .order("recomputed_at" as never, { ascending: false })
    .limit(Math.min(limit, 1000)); // F-1: provable cap; PostgREST clamps to 1000
  if (error) {
    console.error("[health-deep-dive] history failed", error.message);
    return [];
  }
  return (data ?? []) as Array<{
    id: string;
    old_score: number | null;
    new_score: number;
    delta: number | null;
    trigger: string;
    reasons: ReadonlyArray<string>;
    recomputed_at: string;
  }>;
}

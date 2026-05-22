import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { monthBuckets, type HqSnapshot } from "@/lib/hq/metrics";
import { MONTHLY_PRICE_GBP, SETUP_FEE_GBP } from "@/lib/hq/metrics";

/**
 * Build the HQ snapshot — read-only, super-admin only.
 *
 * Cross-tenant queries via the service-role client; RLS would scope
 * the user-JWT client to a single org. Callers MUST confirm
 * isSuperAdminEmail(user.email) before invoking.
 *
 * The 12-month time series is computed by bucketing rows by their
 * created_at / cancelled_at month and walking the buckets in order.
 * No timezone-precise rollups — we use UTC month boundaries to keep
 * the math obvious; "month" in the panel means UTC month.
 */
export async function buildHqSnapshot(): Promise<HqSnapshot> {
  const admin = createAdminClient();
  const buckets = monthBuckets(12);
  const oldestBucketStart = new Date(`${buckets[0]}-01T00:00:00Z`);

  // ---------- Demo lifecycle counts ----------
  const { data: demoRows } = await admin
    .from("demo_requests")
    .select("status" as never);
  const demos = {
    pending_demo: 0,
    demo_booked: 0,
    approved: 0,
    rejected: 0,
    cancelled: 0,
    legacy_new: 0,
  };
  for (const row of (demoRows ?? []) as unknown as Array<{ status: string }>) {
    switch (row.status) {
      case "pending_demo":
        demos.pending_demo++;
        break;
      case "demo_booked":
        demos.demo_booked++;
        break;
      case "approved":
        demos.approved++;
        break;
      case "rejected":
        demos.rejected++;
        break;
      case "cancelled":
        demos.cancelled++;
        break;
      case "new":
        // Legacy enum value, kept valid in the CHECK constraint.
        demos.legacy_new++;
        break;
      default:
        // contacted / qualified / closed_won / closed_lost — count as legacy_new for surfacing.
        demos.legacy_new++;
    }
  }

  // ---------- Organisations ----------
  const { data: orgRows } = await admin
    .from("organizations")
    .select(
      "id, status, created_at, cancelled_at, trial_ends_at" as never,
    );
  const orgs = {
    pending: 0,
    trial: 0,
    active: 0,
    suspended: 0,
    rejected: 0,
    cancelled: 0,
  };
  type OrgRow = {
    id: string;
    status: string;
    created_at: string;
    cancelled_at: string | null;
    trial_ends_at: string | null;
  };
  const orgsList = (orgRows ?? []) as unknown as OrgRow[];
  for (const o of orgsList) {
    switch (o.status) {
      case "pending":
        orgs.pending++;
        break;
      case "trial":
        orgs.trial++;
        break;
      case "active":
        orgs.active++;
        break;
      case "suspended":
        orgs.suspended++;
        break;
      case "rejected":
        orgs.rejected++;
        break;
      case "cancelled":
        orgs.cancelled++;
        break;
    }
  }

  // ---------- Setup fees: assume one paid setup per active/trial org until billing schema lands ----------
  const setupFees = {
    paid_orgs: orgs.active + orgs.trial,
    pending_orgs: orgs.pending,
  };

  // ---------- Time series ----------
  // customerGrowth: orgs that BECAME paying (active OR trial) in each
  // month. We use created_at as the proxy until we add an explicit
  // activated_at column in HQ-4. Backfill clarity: the access-gate
  // migration set pre-existing orgs to active using their created_at,
  // so the proxy is already correct for them.
  const customerGrowth = buckets.map((m) => ({ month: m, count: 0 }));
  const cancellation = buckets.map((m) => ({ month: m, count: 0 }));
  const revenue = buckets.map((m) => ({ month: m, revenue: 0 }));

  const bucketIndex = new Map(buckets.map((m, i) => [m, i]));

  for (const o of orgsList) {
    const createdMonth = monthOf(o.created_at);
    if (
      (o.status === "active" || o.status === "trial") &&
      bucketIndex.has(createdMonth)
    ) {
      const idx = bucketIndex.get(createdMonth)!;
      customerGrowth[idx]!.count++;
      // One-off setup fee booked in the month they became a customer.
      revenue[idx]!.revenue += SETUP_FEE_GBP;
    }
    if (o.status === "cancelled" && o.cancelled_at) {
      const cancelMonth = monthOf(o.cancelled_at);
      if (bucketIndex.has(cancelMonth)) {
        cancellation[bucketIndex.get(cancelMonth)!]!.count++;
      }
    }
  }

  // mrr at end-of-month = sum of active+trial orgs created on or before that month-end × £500.
  const mrr = buckets.map((m, i) => {
    const endOfMonth = endOfMonthDate(m);
    let count = 0;
    for (const o of orgsList) {
      if (o.status !== "active" && o.status !== "trial") continue;
      const created = new Date(o.created_at);
      if (created <= endOfMonth && created >= oldestBucketStart) count++;
    }
    return { month: m, mrr: count * MONTHLY_PRICE_GBP };
    void i;
  });

  // revenue per month = setup fees in that month + MRR at end of that month.
  for (let i = 0; i < buckets.length; i++) {
    revenue[i]!.revenue += mrr[i]?.mrr ?? 0;
  }

  return {
    demos,
    orgs,
    setupFees,
    series: { customerGrowth, mrr, cancellation, revenue },
    generatedAt: new Date().toISOString(),
  };
}

function monthOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function endOfMonthDate(yyyymm: string): Date {
  const [y, m] = yyyymm.split("-").map(Number);
  // Day 0 of next month = last day of current month, end-of-day UTC.
  return new Date(Date.UTC(y!, m!, 0, 23, 59, 59));
}

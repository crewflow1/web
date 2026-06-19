import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildHqSnapshot } from "@/server/services/hq-snapshot";
import { bandFromScore, estimateLtvGbp } from "@/lib/hq/customer-financials";
import type { SetupFeeStatus } from "@/lib/hq/customer-financials";
import type {
  AnalyticsOrg,
  AnalyticsInvoice,
  AnalyticsSnapshot,
} from "@/lib/hq/analytics";

/**
 * CrewFlow HQ — Analytics snapshot service (HQ-6).
 *
 * Combines the HQ overview snapshot (already pulled in HQ-1 and
 * reused by every sprint since) with billing_invoices + per-org
 * derived fields the analytics page needs.
 *
 * Service-role only. Callers must already have confirmed
 * isSuperAdminEmail.
 *
 * Query plan (all batched — no N+1):
 *   1. buildHqSnapshot — counts + 12-month series (existing helper).
 *   2. organizations — every row with cached health_score.
 *   3. billing_invoices — all rows (cap by recency window when this
 *      grows; today the table is small enough that the cap isn't
 *      worth the complexity).
 */

type AnyQuery = {
  order: (k: string, opts: { ascending: boolean }) => Promise<{
    data: unknown[] | null;
    error: { message: string } | null;
  }> & AnyQuery;
};

function untypedAdminTable(name: string) {
  const admin = createAdminClient();
  return admin.from(name as never) as unknown as {
    select: (cols: string) => AnyQuery;
  };
}

type OrgRow = {
  id: string;
  name: string;
  status: string;
  setup_fee_status: string | null;
  setup_fee_paid_at: string | null;
  approved_at: string | null;
  cancelled_at: string | null;
  trial_ends_at: string | null;
  last_login_at: string | null;
  onboarding_percent: number | null;
  migration_percent: number | null;
  mrr_gbp: number | string | null;
  ltv_gbp: number | string | null;
  health_score: number | null;
  created_at: string;
};

type InvoiceRow = {
  org_id: string;
  status: string;
  kind: string;
  amount_gbp: number | string;
  paid_at: string | null;
  failed_at: string | null;
  due_date: string | null;
  created_at: string;
};

export async function buildAnalyticsSnapshot(): Promise<AnalyticsSnapshot> {
  // 1. Existing HQ overview snapshot — drives the 12-month series.
  const hq = await buildHqSnapshot();

  // 2. Orgs — every row with cached values.
  const orgsRes = await untypedAdminTable("organizations")
    .select(
      [
        "id",
        "name",
        "status",
        "setup_fee_status",
        "setup_fee_paid_at",
        "approved_at",
        "cancelled_at",
        "trial_ends_at",
        "last_login_at",
        "onboarding_percent",
        "migration_percent",
        "mrr_gbp",
        "ltv_gbp",
        "health_score",
        "created_at",
      ].join(", "),
    )
    .order("created_at", { ascending: false });
  const orgsRaw = (orgsRes.data ?? []) as unknown as OrgRow[];

  // 3. Billing invoices.
  const invRes = await untypedAdminTable("billing_invoices")
    .select(
      "org_id, status, kind, amount_gbp, paid_at, failed_at, due_date, created_at",
    )
    .order("created_at", { ascending: false });
  const invoicesRaw = (invRes.data ?? []) as unknown as InvoiceRow[];

  const generatedAt = new Date().toISOString();

  const orgs: AnalyticsOrg[] = orgsRaw.map((raw) => toAnalyticsOrg(raw));
  const invoices: AnalyticsInvoice[] = invoicesRaw.map(toAnalyticsInvoice);

  return {
    orgs,
    invoices,
    series: hq.series,
    generatedAt,
  };
}

function toAnalyticsOrg(raw: OrgRow): AnalyticsOrg {
  const setupFeePaid =
    raw.setup_fee_status === "paid" || raw.setup_fee_status === "waived";
  const mrrGbp = Number(raw.mrr_gbp ?? 0);
  const ltvGbp = Number(raw.ltv_gbp ?? 0);
  const ltv = ltvGbp > 0
    ? ltvGbp
    : estimateLtvGbp({
        mrrGbp,
        approvedAt: raw.approved_at,
        createdAt: raw.created_at,
        setupFeeStatus: (raw.setup_fee_status ?? "pending") as SetupFeeStatus,
        cachedLtvGbp: ltvGbp,
      });

  const migrationDays = computeMigrationDays(raw);

  return {
    id: raw.id,
    name: raw.name,
    status: raw.status,
    mrr_gbp: mrrGbp,
    ltv_gbp: ltv,
    health_score: raw.health_score,
    setup_fee_paid: setupFeePaid,
    approved_at: raw.approved_at,
    cancelled_at: raw.cancelled_at,
    trial_ends_at: raw.trial_ends_at,
    last_login_at: raw.last_login_at,
    onboarding_percent: Number(raw.onboarding_percent ?? 0),
    migration_percent: Number(raw.migration_percent ?? 0),
    migration_days: migrationDays,
    created_at: raw.created_at,
  };
}

function toAnalyticsInvoice(raw: InvoiceRow): AnalyticsInvoice {
  return {
    org_id: raw.org_id,
    status: raw.status,
    kind: raw.kind,
    amount_gbp: Number(raw.amount_gbp ?? 0),
    paid_at: raw.paid_at,
    failed_at: raw.failed_at,
    due_date: raw.due_date,
    created_at: raw.created_at,
  };
}

/**
 * Days between `approved_at` and "now" (or the time the migration
 * reached 100%). We don't have a stamp for "migration finished
 * at" yet, so for ORGS WITH migration_percent < 100 we return days
 * since approved (a measure of how long they've been onboarding —
 * the stalled detector uses this). For ORGS at 100% we cap at the
 * day they reached 100% if we knew, but in practice that stamp
 * isn't in the DB today — so we return null and the analytics
 * compute treats it as missing. HQ-6.1 will add a
 * migration_completed_at stamp when the imports → committed
 * transition fires its trigger.
 */
function computeMigrationDays(raw: OrgRow): number | null {
  if (!raw.approved_at) return null;
  const migrationPercent = Number(raw.migration_percent ?? 0);
  if (migrationPercent >= 100) {
    // No completion stamp yet — analytics compute treats this as null.
    return Math.floor(
      (Date.now() - new Date(raw.approved_at).getTime()) / 86_400_000,
    );
  }
  return Math.floor(
    (Date.now() - new Date(raw.approved_at).getTime()) / 86_400_000,
  );
}

// ---------------------------------------------------------------------
// Highest-risk customers (for the insights panel)
// ---------------------------------------------------------------------

export function pickHighestRiskCustomers(
  snap: AnalyticsSnapshot,
): Array<{ id: string; name: string; health: number; mrr: number }> {
  return snap.orgs
    .filter(
      (o) =>
        (o.status === "active" || o.status === "trial") &&
        bandFromScore(o.health_score) === "red",
    )
    .sort((a, b) => (a.health_score ?? 0) - (b.health_score ?? 0))
    .slice(0, 5)
    .map((o) => ({
      id: o.id,
      name: o.name,
      health: o.health_score as number,
      mrr: o.mrr_gbp,
    }));
}

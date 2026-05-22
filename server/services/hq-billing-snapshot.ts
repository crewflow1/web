import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  summariseBillingInvoices,
  type BillingInvoiceRow,
  type BillingSummary,
} from "@/lib/hq/billing";
import {
  estimateLtvGbp,
  subscriptionStatusFromOrg,
  type SetupFeeStatus,
  type SubscriptionStatus,
} from "@/lib/hq/customer-financials";
import type { OrgStatus } from "@/server/auth/session";

/**
 * CrewFlow HQ — Billing OS aggregator (HQ-4).
 *
 * Service-role only — every caller must already have confirmed
 * isSuperAdminEmail. Reads cross-tenant by design.
 */

/**
 * Cast helper for tables not yet present in the generated Supabase
 * types (billing_invoices + billing_events landed in migration
 * 20260607000000). Mirrors the pattern from hq-audit.ts.
 *
 * We return a heavily-lenient any-shape for the chainable query
 * builder so callers can compose `.select(...).eq(...).order(...)`
 * without the generated type union fighting us. Once
 * `pnpm db:generate` regenerates the Supabase types with the new
 * tables, every call-site keeps working without changes.
 */
type AnyQuery = {
  eq: (k: string, v: unknown) => AnyQuery;
  in: (k: string, v: unknown[]) => AnyQuery;
  order: (k: string, opts: { ascending: boolean }) => Promise<{
    data: unknown[] | null;
    error: { message: string } | null;
  }> & AnyQuery;
  single: () => Promise<{
    data: unknown | null;
    error: { message: string } | null;
  }>;
  maybeSingle: () => Promise<{
    data: unknown | null;
    error: { message: string } | null;
  }>;
};

type AnyMutation = {
  eq: (k: string, v: unknown) => Promise<{
    error: { message: string } | null;
  }> & AnyMutation;
  select: (cols?: string) => AnyQuery;
};

function untypedAdminTable(name: string) {
  const admin = createAdminClient();
  return admin.from(name as never) as unknown as {
    insert: (payload: unknown) => Promise<{
      data: unknown | null;
      error: { message: string } | null;
    }> & { select: (cols?: string) => AnyQuery };
    select: (cols: string) => AnyQuery;
    update: (payload: unknown) => AnyMutation;
    delete: () => AnyMutation;
  };
}

export type CustomerBillingRow = {
  org_id: string;
  org_name: string;
  status: OrgStatus;
  setup_fee_status: SetupFeeStatus;
  mrr_gbp: number;
  ltv_gbp: number;
  next_renewal_at: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  billing_email: string | null;
  owner_email: string | null;
  owner_name: string | null;
  created_at: string;
  approved_at: string | null;
  subscription: SubscriptionStatus;
  /** Estimated LTV from cached column or heuristic. */
  ltvEstimate: number;
  /** Roll-up of every billing_invoices row for this org. */
  summary: BillingSummary;
};

/**
 * Pull every org + every billing_invoices row + memberships in three
 * queries, then merge in memory. Stays O(orgs + invoices) and never
 * does N+1 calls per org.
 */
export async function listCustomersForBilling(): Promise<CustomerBillingRow[]> {
  const admin = createAdminClient();

  // ---------- Orgs ----------
  const { data: orgsRaw } = await admin
    .from("organizations")
    .select(
      [
        "id",
        "name",
        "status",
        "setup_fee_status",
        "mrr_gbp",
        "ltv_gbp",
        "next_renewal_at",
        "stripe_customer_id",
        "stripe_subscription_id",
        "billing_email",
        "created_at",
        "approved_at",
      ].join(", ") as never,
    )
    .order("created_at", { ascending: false });

  type OrgRow = {
    id: string;
    name: string;
    status: OrgStatus;
    setup_fee_status: SetupFeeStatus;
    mrr_gbp: number | string;
    ltv_gbp: number | string;
    next_renewal_at: string | null;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    billing_email: string | null;
    created_at: string;
    approved_at: string | null;
  };
  const orgs = ((orgsRaw ?? []) as unknown as OrgRow[]);
  if (orgs.length === 0) return [];

  const ids = orgs.map((o) => o.id);

  // ---------- Owner email per org ----------
  type OwnerRow = {
    org_id: string;
    user: { full_name: string | null; email: string } | null;
  };
  const { data: ownerships } = await admin
    .from("memberships")
    .select("org_id, user:users ( full_name, email )")
    .in("org_id", ids)
    .eq("role", "owner");
  const ownerByOrg = new Map(
    ((ownerships ?? []) as unknown as OwnerRow[]).map((r) => [
      r.org_id,
      {
        email: r.user?.email ?? null,
        name: r.user?.full_name ?? null,
      },
    ]),
  );

  // ---------- Billing invoices ----------
  type InvoiceWithOrg = BillingInvoiceRow & { org_id: string };
  const { data: invoiceData } = await untypedAdminTable("billing_invoices")
    .select(
      [
        "id",
        "org_id",
        "kind",
        "status",
        "amount_gbp",
        "due_date",
        "sent_at",
        "paid_at",
        "failed_at",
        "failure_reason",
        "period_start",
        "period_end",
        "notes",
        "stripe_invoice_id",
        "created_at",
      ].join(", "),
    )
    .order("created_at", { ascending: false });
  const invoices = ((invoiceData as unknown as InvoiceWithOrg[]) ?? []);

  const invByOrg = new Map<string, BillingInvoiceRow[]>();
  for (const inv of invoices) {
    const list = invByOrg.get(inv.org_id) ?? [];
    list.push(inv);
    invByOrg.set(inv.org_id, list);
  }

  // ---------- Merge ----------
  return orgs.map<CustomerBillingRow>((o) => {
    const owner = ownerByOrg.get(o.id) ?? { email: null, name: null };
    const summary = summariseBillingInvoices(invByOrg.get(o.id) ?? []);
    const subscription = subscriptionStatusFromOrg(o.status, o.setup_fee_status);
    const ltvEstimate = estimateLtvGbp({
      mrrGbp: Number(o.mrr_gbp ?? 0),
      approvedAt: o.approved_at,
      createdAt: o.created_at,
      setupFeeStatus: o.setup_fee_status,
      cachedLtvGbp: Number(o.ltv_gbp ?? 0),
    });
    return {
      org_id: o.id,
      org_name: o.name,
      status: o.status,
      setup_fee_status: o.setup_fee_status,
      mrr_gbp: Number(o.mrr_gbp ?? 0),
      ltv_gbp: Number(o.ltv_gbp ?? 0),
      next_renewal_at: o.next_renewal_at,
      stripe_customer_id: o.stripe_customer_id,
      stripe_subscription_id: o.stripe_subscription_id,
      billing_email: o.billing_email,
      owner_email: owner.email,
      owner_name: owner.name,
      created_at: o.created_at,
      approved_at: o.approved_at,
      subscription,
      ltvEstimate,
      summary,
    };
  });
}

/**
 * Per-org billing invoices, newest first. Used by the inline
 * expand-row on /admin/billing.
 */
export async function listBillingInvoicesForOrg(
  orgId: string,
): Promise<BillingInvoiceRow[]> {
  const { data } = await untypedAdminTable("billing_invoices")
    .select(
      [
        "id",
        "kind",
        "status",
        "amount_gbp",
        "due_date",
        "sent_at",
        "paid_at",
        "failed_at",
        "failure_reason",
        "period_start",
        "period_end",
        "notes",
        "stripe_invoice_id",
        "created_at",
      ].join(", "),
    )
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });
  return (data as unknown as BillingInvoiceRow[]) ?? [];
}

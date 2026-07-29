import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { listAdminActivity } from "@/server/services/hq-audit";
import {
  computeHealthScore,
  estimateLtvGbp,
  subscriptionStatusFromOrg,
  type SetupFeeStatus,
  type SubscriptionStatus,
  type HealthResult,
} from "@/lib/hq/customer-financials";
import type { OrgStatus } from "@/server/auth/session";
import { readFailure } from "@/lib/supabase/read-failure";

/**
 * CrewFlow HQ — Customers OS per-customer snapshot.
 *
 * Aggregates everything the /admin/customers/[id] page renders:
 *
 *   - The org row + its owner from memberships
 *   - The matching demo_request (if the company came in through the
 *     landing form — looked up by owner email)
 *   - The cumulative imports / import_rows progress (Migration % +
 *     stage label)
 *   - A unified timeline pulled from admin_activity_log,
 *     demo_requests, imports, and invoices
 *   - A computed health score (today's heuristic; HQ-6 swaps in the
 *     cached cron-driven score without changing the call shape)
 *
 * Service-role client — callers must already have confirmed
 * isSuperAdminEmail.
 */

export type CustomerOwner = {
  user_id: string | null;
  full_name: string | null;
  email: string | null;
  phone: string | null;
};

export type CustomerOrg = {
  id: string;
  name: string;
  slug: string;
  status: OrgStatus;
  phone: string | null;
  email: string | null;
  billing_email: string | null;
  vat_number: string | null;
  created_at: string;
  approved_at: string | null;
  trial_ends_at: string | null;
  cancelled_at: string | null;
  suspended_at: string | null;
  setup_fee_status: SetupFeeStatus;
  setup_fee_paid_at: string | null;
  mrr_gbp: number;
  ltv_gbp: number;
  onboarding_percent: number;
  migration_percent: number;
  migration_stage: string | null;
  migration_eta: string | null;
  last_login_at: string | null;
  health_score: number;
  admin_org_notes: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
};

export type CustomerSnapshot = {
  org: CustomerOrg;
  owner: CustomerOwner | null;
  /** Subscription status derived from org status + setup fee. */
  subscription: SubscriptionStatus;
  /** Estimated LTV (prefers cached if set). */
  ltv: number;
  /** Health score — computed every render until HQ-6 caches it. */
  health: HealthResult;
  /** Timeline events, newest first. */
  timeline: ReadonlyArray<TimelineEvent>;
  /** Linked demo_request, when the customer came in through Book demo. */
  demoRequest: {
    id: string;
    name: string;
    company: string;
    email: string;
    status: string;
    created_at: string;
    approved_at: string | null;
  } | null;
  /** Most-recent imports (audit + status, no row data). */
  imports: ReadonlyArray<{
    id: string;
    name: string;
    status: string;
    created_at: string;
    committed_at: string | null;
    rolled_back_at: string | null;
  }>;
};

export type TimelineEvent = {
  /** Sortable timestamp. */
  at: string;
  /** Coarse bucket — drives the icon + colour in the UI. */
  kind: "demo" | "payment" | "migration" | "support" | "usage" | "admin";
  /** Short headline ("Demo booked", "Invoice paid £450"). */
  label: string;
  /** Optional detail line. */
  detail?: string;
  /** Actor email if recorded. */
  actor?: string | null;
};

export async function loadCustomerSnapshot(
  orgId: string,
): Promise<CustomerSnapshot | null> {
  const admin = createAdminClient();

  // ---------- 1. Org row -----------------------------------------------
  const { data: orgRaw, error: orgError } = await admin
    .from("organizations")
    .select(
      [
        "id",
        "name",
        "slug",
        "status",
        "phone",
        "email",
        "billing_email",
        "vat_number",
        "created_at",
        "approved_at",
        "trial_ends_at",
        "cancelled_at",
        "suspended_at",
        "setup_fee_status",
        "setup_fee_paid_at",
        "mrr_gbp",
        "ltv_gbp",
        "onboarding_percent",
        "migration_percent",
        "migration_stage",
        "migration_eta",
        "last_login_at",
        "health_score",
        "admin_org_notes",
        "stripe_customer_id",
        "stripe_subscription_id",
      ].join(", ") as never,
    )
    .eq("id", orgId)
    .maybeSingle();
  if (orgError) throw readFailure("hq customer: org", orgError);

  if (!orgRaw) return null;
  const org = orgRaw as unknown as CustomerOrg;

  // ---------- 2. Owner via memberships ---------------------------------
  const { data: ownerRow } = await admin
    .from("memberships")
    .select("user_id, user:users ( full_name, email, phone )")
    .eq("org_id", orgId)
    .eq("role", "owner")
    .maybeSingle();

  const owner: CustomerOwner | null = ownerRow
    ? {
        user_id: ownerRow.user_id ?? null,
        full_name: ownerRow.user?.full_name ?? null,
        email: ownerRow.user?.email ?? null,
        phone: ownerRow.user?.phone ?? null,
      }
    : null;

  // ---------- 3. Linked demo request (best-effort by owner email) -----
  let demoRequest: CustomerSnapshot["demoRequest"] = null;
  if (owner?.email) {
    const { data: demoRow } = await admin
      .from("demo_requests")
      .select(
        "id, name, company, email, status, created_at, approved_at" as never,
      )
      .eq("email", owner.email)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (demoRow) {
      demoRequest = demoRow as unknown as CustomerSnapshot["demoRequest"];
    }
  }

  // ---------- 4. Imports (migration timeline source) -------------------
  const { data: importsRaw, error: importsError } = await admin
    .from("imports")
    .select("id, name, status, created_at, committed_at, rolled_back_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(10);
  if (importsError) throw readFailure("hq customer: imports", importsError);
  const imports = (importsRaw ?? []) as CustomerSnapshot["imports"];

  // ---------- 5. Invoice/payment events (best-effort) ------------------
  // We don't need every row — just the aggregate count + recent
  // events for the timeline. invoice_payments is the source of truth
  // for "money came in"; failed reads return empty.
  type PaymentRow = {
    id: string;
    paid_at: string;
    amount: number | string;
    reference: string | null;
  };
  const { data: paymentRows } = await admin
    .from("invoice_payments")
    .select("id, paid_at, amount, reference")
    .eq("org_id", orgId)
    .order("paid_at", { ascending: false })
    .limit(10);
  const payments = (paymentRows ?? []) as unknown as PaymentRow[];

  // ---------- 6. Admin activity log (HQ-side audit) --------------------
  const adminActivity = await listAdminActivity("organizations", orgId, 25);

  // ---------- 7. Compute derived fields --------------------------------
  const subscription = subscriptionStatusFromOrg(
    org.status,
    (org.setup_fee_status ?? "pending") as SetupFeeStatus,
  );
  const ltv = estimateLtvGbp({
    mrrGbp: Number(org.mrr_gbp ?? 0),
    approvedAt: org.approved_at,
    createdAt: org.created_at,
    setupFeeStatus: (org.setup_fee_status ?? "pending") as SetupFeeStatus,
    cachedLtvGbp: Number(org.ltv_gbp ?? 0),
  });
  const health = computeHealthScore({
    status: org.status,
    setupFeeStatus: (org.setup_fee_status ?? "pending") as SetupFeeStatus,
    lastLoginAt: org.last_login_at,
    onboardingPercent: Number(org.onboarding_percent ?? 0),
    migrationPercent: Number(org.migration_percent ?? 0),
  });

  // ---------- 8. Build the timeline ------------------------------------
  const timeline: TimelineEvent[] = [];

  if (demoRequest) {
    timeline.push({
      at: demoRequest.created_at,
      kind: "demo",
      label: "Demo requested",
      detail: `${demoRequest.name} · ${demoRequest.email}`,
    });
    if (demoRequest.approved_at) {
      timeline.push({
        at: demoRequest.approved_at,
        kind: "demo",
        label: "Demo approved",
      });
    }
  }

  timeline.push({
    at: org.created_at,
    kind: "admin",
    label: "Workspace created",
  });
  if (org.approved_at) {
    timeline.push({
      at: org.approved_at,
      kind: "admin",
      label: "Workspace approved",
    });
  }
  if (org.setup_fee_paid_at) {
    timeline.push({
      at: org.setup_fee_paid_at,
      kind: "payment",
      label: "Setup fee paid",
      detail: `£${Number(SETUP_FEE_DEFAULT).toLocaleString("en-GB")}`,
    });
  }
  if (org.suspended_at) {
    timeline.push({
      at: org.suspended_at,
      kind: "admin",
      label: "Workspace suspended",
    });
  }
  if (org.cancelled_at) {
    timeline.push({
      at: org.cancelled_at,
      kind: "admin",
      label: "Workspace cancelled",
    });
  }

  for (const imp of imports) {
    timeline.push({
      at: imp.created_at,
      kind: "migration",
      label: `Migration started: ${imp.name}`,
      detail: imp.status,
    });
    if (imp.committed_at) {
      timeline.push({
        at: imp.committed_at,
        kind: "migration",
        label: `Migration committed: ${imp.name}`,
      });
    }
    if (imp.rolled_back_at) {
      timeline.push({
        at: imp.rolled_back_at,
        kind: "migration",
        label: `Migration rolled back: ${imp.name}`,
      });
    }
  }

  for (const p of payments) {
    timeline.push({
      at: p.paid_at,
      kind: "payment",
      label: `Customer payment received`,
      detail: `£${Number(p.amount).toFixed(2)}${p.reference ? ` · ${p.reference}` : ""}`,
    });
  }

  for (const a of adminActivity) {
    timeline.push({
      at: a.created_at,
      kind: a.action.startsWith("demo.")
        ? "demo"
        : a.action.includes("payment")
          ? "payment"
          : a.action.includes("migration") || a.action.includes("import")
            ? "migration"
            : a.action.includes("support")
              ? "support"
              : "admin",
      label: prettyAdminAction(a.action),
      actor: a.actor_email,
    });
  }

  // Newest first.
  timeline.sort((a, b) => (a.at < b.at ? 1 : -1));

  return {
    org,
    owner,
    subscription,
    ltv,
    health,
    timeline,
    demoRequest,
    imports,
  };
}

const SETUP_FEE_DEFAULT = 1000;

function prettyAdminAction(action: string): string {
  if (action.startsWith("org.status_")) {
    return `Status → ${action.slice("org.status_".length)}`;
  }
  if (action.startsWith("customer.")) {
    return action.slice("customer.".length).replace(/_/g, " ");
  }
  if (action.startsWith("demo.")) {
    return action.slice("demo.".length).replace(/_/g, " ");
  }
  return action;
}

/**
 * Lightweight list-view roll-up — used by /admin/customers (the
 * grid). Skips the full timeline/payments/imports queries so we
 * stay fast at 200+ customers.
 */
export type CustomerListRow = {
  id: string;
  name: string;
  status: OrgStatus;
  setup_fee_status: SetupFeeStatus;
  mrr_gbp: number;
  ltv_gbp: number;
  migration_percent: number;
  health_score: number;
  last_login_at: string | null;
  created_at: string;
  owner_email: string | null;
  owner_name: string | null;
  trial_ends_at: string | null;
};

export async function listCustomersForHq(): Promise<CustomerListRow[]> {
  const admin = createAdminClient();
  const { data: orgs, error: orgsError } = await admin
    .from("organizations")
    .select(
      [
        "id",
        "name",
        "status",
        "setup_fee_status",
        "mrr_gbp",
        "ltv_gbp",
        "migration_percent",
        "health_score",
        "last_login_at",
        "created_at",
        "trial_ends_at",
      ].join(", ") as never,
    )
    .order("created_at", { ascending: false });
  if (orgsError) throw readFailure("hq customers: list", orgsError);

  type Row = Omit<CustomerListRow, "owner_email" | "owner_name">;
  const baseRows = ((orgs ?? []) as unknown as Row[]);
  if (baseRows.length === 0) return [];

  const ids = baseRows.map((r) => r.id);
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

  return baseRows.map((r) => ({
    ...r,
    owner_email: ownerByOrg.get(r.id)?.email ?? null,
    owner_name: ownerByOrg.get(r.id)?.name ?? null,
  }));
}

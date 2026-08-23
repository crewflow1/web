import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  computeHealthScore,
  type SetupFeeStatus,
} from "@/lib/hq/customer-financials";
import { readFailure, reportReadFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import type {
  AlertOrg,
  AlertInvoice,
  AlertImport,
  AlertDemo,
  AlertSnapshotRow,
  AlertsSnapshot,
  AlertState,
} from "@/lib/hq/alert-rules";

/**
 * CrewFlow HQ — Alerts snapshot service (HQ-5).
 *
 * Pulls every signal the deterministic rules engine
 * (lib/hq/alert-rules.ts) needs in a SMALL, FIXED number of batched
 * queries — never N+1 across orgs.
 *
 * Query plan:
 *   1. organizations (every row — typed columns only)
 *   2. billing_invoices for those org ids (status in open/recent set)
 *   3. imports for those org ids (most-recent slice)
 *   4. import_rows.MAX(updated_at) per org for stalled detection
 *   5. demo_requests recently touched (linked to an org via linked_org_id when present;
 *      demo_requests is a GLOBAL marketing funnel with no org_id of its own)
 *   6. admin_alert_state for those org ids (state overlay)
 *
 * Health scores are computed in-memory using computeHealthScore —
 * caching lands in HQ-6 with a cron job. The shape doesn't change.
 *
 * Service-role only. Callers must already have confirmed
 * isSuperAdminEmail.
 *
 * EVERY read here throws on failure (readFailure). This snapshot feeds BOTH
 * the admin alerts board AND the nightly cron (hq-alerts-scheduler via
 * /api/cron/alerts-poll). It used to `?? []` every result: a failed
 * `organizations` read returned ZERO alerts, so the board rendered "all
 * clear" and the scheduler notified nobody — the alerting system went
 * silent at exactly the moment the database was unhealthy. The cron route
 * wraps this in withCronTelemetry, which turns a throw into a logged
 * {ok:false} 500; the page throw hits the admin error boundary and Sentry
 * via instrumentation's onRequestError. Loud beats empty, always.
 */

// Mirrors the helper shape we use in hq-billing-snapshot — keeps the
// service self-contained until generated Supabase types catch up
// with the HQ-4 / HQ-5 tables.
type AnyQuery = {
  eq: (k: string, v: unknown) => AnyQuery;
  in: (k: string, v: unknown[]) => AnyQuery;
  order: (k: string, opts: { ascending: boolean }) => Promise<{
    data: unknown[] | null;
    error: SupabaseReadError | null;
  }> & AnyQuery;
  limit: (n: number) => Promise<{
    data: unknown[] | null;
    error: SupabaseReadError | null;
  }> & AnyQuery;
  range: (from: number, to: number) => PromiseLike<{
    data: unknown[] | null;
    error: unknown;
  }>;
};

function untypedAdminTable(name: string) {
  const admin = createAdminClient();
  return admin.from(name as never) as unknown as {
    select: (cols: string) => AnyQuery;
  };
}

// Row shapes from the DB (loose — we cast through unknown).

type OrgRow = {
  id: string;
  name: string;
  status: string;
  setup_fee_status: string | null;
  setup_fee_paid_at: string | null;
  trial_ends_at: string | null;
  next_renewal_at: string | null;
  approved_at: string | null;
  cancelled_at: string | null;
  suspended_at: string | null;
  created_at: string;
  updated_at: string | null;
  mrr_gbp: number | string | null;
  health_score: number | null;
  last_login_at: string | null;
  onboarding_percent: number | null;
  migration_percent: number | null;
};

type InvoiceRow = {
  id: string;
  org_id: string;
  kind: string;
  status: string;
  amount_gbp: number | string;
  due_date: string | null;
  sent_at: string | null;
  paid_at: string | null;
  failed_at: string | null;
  created_at: string;
};

type ImportRow = {
  id: string;
  org_id: string;
  status: string;
  created_at: string;
  committed_at: string | null;
};

type DemoRow = {
  id: string;
  // demo_requests has NO org_id; it links to an org via linked_org_id once a demo
  // is converted. We alias linked_org_id -> org_id in the select so the rest of the
  // pipeline (bucketing by org, toAlertDemo) is unchanged.
  org_id: string | null;
  email: string | null;
  company: string;
  status: string;
  created_at: string;
  // demo_requests has NO updated_at; approved_at is the real row-level "actioned"
  // stamp used as the booked-at proxy.
  approved_at: string | null;
};

type AlertStateRow = {
  rule_id: string;
  org_id: string;
  read_at: string | null;
  snoozed_until: string | null;
  resolved_at: string | null;
  assigned_to: string | null;
  resolution_note: string | null;
};

/** Result shape returned to the page. */
export type AlertsSnapshotResult = {
  snapshot: AlertsSnapshot;
  /** Map keyed by `${rule_id}:${org_id}` so we can merge state in O(1). */
  states: ReadonlyMap<string, AlertState>;
};

/**
 * Pull every signal in batched queries, run computeHealthScore for
 * orgs missing a cached score, and return the snapshot + state map.
 */
export async function buildAlertsSnapshot(): Promise<AlertsSnapshotResult> {
  // 1. Orgs — PAGED (F-1): the whole estate roster feeds the rules engine and
  //    every alert row; a bare read is silently clamped at max_rows=1000, so past
  //    1000 orgs the busiest customers vanish from the board and the cron.
  //    Stable total order (created_at, id).
  const orgsRes = await fetchAllRows<OrgRow>(
    (from, to) =>
      untypedAdminTable("organizations")
        .select(
          [
            "id",
            "name",
            "status",
            "setup_fee_status",
            "setup_fee_paid_at",
            "trial_ends_at",
            "next_renewal_at",
            "approved_at",
            "cancelled_at",
            "suspended_at",
            "created_at",
            "updated_at",
            "mrr_gbp",
            "health_score",
            "last_login_at",
            "onboarding_percent",
            "migration_percent",
          ].join(", "),
        )
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to) as PromiseLike<PageResult<OrgRow>>,
  );

  if (orgsRes.error) throw readFailure("hq alerts: organizations", orgsRes.error);
  const orgsRaw = orgsRes.data;
  if (orgsRaw.length === 0) {
    return {
      snapshot: { rows: [], now: new Date().toISOString() },
      states: new Map(),
    };
  }
  const orgIds = orgsRaw.map((o) => o.id);

  // 2. Billing invoices — PAGED (F-1): every open/recent invoice across ALL orgs
  //    (.in on the full estate id set) folds into the alert money rules; a
  //    max_rows=1000 clamp silently drops invoices. Stable total order
  //    (created_at, id).
  const invRes = await fetchAllRows<InvoiceRow>(
    (from, to) =>
      untypedAdminTable("billing_invoices")
        .select(
          "id, org_id, kind, status, amount_gbp, due_date, sent_at, paid_at, failed_at, created_at",
        )
        .in("org_id", orgIds)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to) as PromiseLike<PageResult<InvoiceRow>>,
  );
  if (invRes.error) throw readFailure("hq alerts: billing invoices", invRes.error);
  const invoicesRaw = invRes.data;

  // 3. Imports — most-recent per-org slice. We pull every row for
  // these orgs and let the rules engine pick the in-flight ones.
  const impRes = await untypedAdminTable("imports")
    .select("id, org_id, status, created_at, committed_at")
    .in("org_id", orgIds)
    .order("created_at", { ascending: false });
  if (impRes.error) throw readFailure("hq alerts: imports", impRes.error);
  const importsRaw = (impRes.data ?? []) as unknown as ImportRow[];

  // 4. Last row activity per org — single aggregate query.
  // We approximate "last row activity" with the most-recent
  // import_rows.updated_at by org. Falls back to import.created_at.
  const importIds = importsRaw.map((i) => i.id);
  const lastRowByOrg = new Map<string, string>();
  if (importIds.length > 0) {
    const rowsRes = await untypedAdminTable("import_rows")
      .select("import_id, updated_at")
      .in("import_id", importIds)
      .order("updated_at", { ascending: false })
      .limit(1000);
    if (rowsRes.error) throw readFailure("hq alerts: import rows", rowsRes.error);
    const rows = (rowsRes.data ?? []) as unknown as Array<{
      import_id: string;
      updated_at: string | null;
    }>;
    // Map import_id → org_id once.
    const importIdToOrg = new Map<string, string>();
    for (const imp of importsRaw) importIdToOrg.set(imp.id, imp.org_id);
    for (const row of rows) {
      if (!row.updated_at) continue;
      const orgId = importIdToOrg.get(row.import_id);
      if (!orgId) continue;
      const cur = lastRowByOrg.get(orgId);
      if (!cur || row.updated_at > cur) lastRowByOrg.set(orgId, row.updated_at);
    }
  }

  // 5. Demo requests — pull rows linked to known orgs OR recently
  // booked. We keep the column set small.
  // PAGED (F-1): `orgIds` is the estate roster, so this cross-tenant demo read
  // returns up to one row per estate org and a bare select clamped at max_rows
  // (1000) would silently drop demos past the cap from the alerts board. Page it.
  const demoRes = await fetchAllRows<DemoRow>(
    (from, to) =>
      untypedAdminTable("demo_requests")
        // linked_org_id is the real column; alias it to org_id for the row shape.
        .select("id, org_id:linked_org_id, email, company, status, created_at, approved_at")
        .in("linked_org_id", orgIds)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResult<DemoRow>>,
  );
  if (demoRes.error) throw readFailure("hq alerts: demo requests", demoRes.error);
  const demosRaw = (demoRes.data ?? []) as unknown as DemoRow[];

  // 6. Alert state overlay.
  const stateRes = await untypedAdminTable("admin_alert_state")
    .select(
      "rule_id, org_id, read_at, snoozed_until, resolved_at, assigned_to, resolution_note",
    )
    .in("org_id", orgIds)
    .order("updated_at", { ascending: false });
  if (stateRes.error) throw readFailure("hq alerts: alert state", stateRes.error);
  const statesRaw = (stateRes.data ?? []) as unknown as AlertStateRow[];

  // -------------------------------------------------------------------
  // Bucket invoices / imports / demos by org_id for cheap lookups.
  // -------------------------------------------------------------------
  const invoicesByOrg = bucketBy(invoicesRaw, (r) => r.org_id);
  const importsByOrg = bucketBy(importsRaw, (r) => r.org_id);
  const demosByOrg = bucketBy(demosRaw, (r) => r.org_id ?? "__none__");

  // -------------------------------------------------------------------
  // Build snapshot rows + ensure health score is populated.
  // -------------------------------------------------------------------
  const now = new Date().toISOString();
  const rows: AlertSnapshotRow[] = orgsRaw.map((raw) => {
    const org = toAlertOrg(raw, lastRowByOrg.get(raw.id) ?? null);
    return {
      org,
      invoices: (invoicesByOrg.get(org.id) ?? []).map(toAlertInvoice),
      imports: (importsByOrg.get(org.id) ?? []).map((i) =>
        toAlertImport(i, lastRowByOrg.get(org.id) ?? null),
      ),
      demos: (demosByOrg.get(org.id) ?? []).map(toAlertDemo),
    };
  });

  // -------------------------------------------------------------------
  // State map keyed by `${rule_id}:${org_id}`.
  // -------------------------------------------------------------------
  const states = new Map<string, AlertState>();
  for (const s of statesRaw) {
    states.set(`${s.rule_id}:${s.org_id}`, {
      read_at: s.read_at,
      snoozed_until: s.snoozed_until,
      resolved_at: s.resolved_at,
      assigned_to: s.assigned_to,
      resolution_note: s.resolution_note,
    });
  }

  return {
    snapshot: { rows, now },
    states,
  };
}

// ---------------------------------------------------------------------
// Per-org owner contact lookup (for the Call/Email/WhatsApp buttons).
//
// Returned to the page so the action row can populate phone + email
// without re-fetching from the customer detail page. We only fetch
// for orgs that have at least one *unresolved* alert — the page
// passes us the slice.
// ---------------------------------------------------------------------

export type OwnerContact = {
  org_id: string;
  user_id: string | null;
  full_name: string | null;
  email: string | null;
  phone: string | null;
};

type OwnerContactPageRow = {
  org_id: string;
  user_id: string | null;
  user?: { full_name?: string | null; email?: string | null; phone?: string | null } | null;
};

export async function getOwnerContactsForOrgs(
  orgIds: ReadonlyArray<string>,
): Promise<Map<string, OwnerContact>> {
  const out = new Map<string, OwnerContact>();
  if (orgIds.length === 0) return out;
  const admin = createAdminClient();
  // PAGED (F-1): `orgIds` is the distinct set of orgs across every estate alert
  // row, so this cross-tenant owner read returns ~1 row per org and can exceed
  // max_rows (1000) once the estate crosses 1000 alerting orgs. A bare select
  // would then silently drop the owner contact for the overflow orgs from the
  // action row. Page the complete set on the unique `user_id` order.
  const { data, error } = await fetchAllRows<OwnerContactPageRow>(
    (from, to) =>
      admin
        .from("memberships")
        .select("org_id, user_id, user:users ( full_name, email, phone )")
        .in("org_id", orgIds as string[])
        .eq("role", "owner")
        .order("user_id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResult<OwnerContactPageRow>>,
  );
  // Enrichment only (the Call/Email/WhatsApp buttons). The alert rows are
  // already built at this point, so a failure here degrades the action row
  // rather than blanking the board — but it must still reach Sentry.
  if (error) {
    reportReadFailure("hq alerts: owner contacts", error);
    return out;
  }
  if (!data) return out;
  for (const r of data as unknown as OwnerContactPageRow[]) {
    out.set(r.org_id, {
      org_id: r.org_id,
      user_id: r.user_id,
      full_name: r.user?.full_name ?? null,
      email: r.user?.email ?? null,
      phone: r.user?.phone ?? null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------

function toAlertOrg(raw: OrgRow, lastRowActivity: string | null): AlertOrg {
  const setup = (raw.setup_fee_status ?? "pending") as SetupFeeStatus;
  const cached = raw.health_score;
  const live = cached === null
    ? computeHealthScore({
        status: raw.status,
        setupFeeStatus: setup,
        lastLoginAt: raw.last_login_at,
        onboardingPercent: Number(raw.onboarding_percent ?? 0),
        migrationPercent: Number(raw.migration_percent ?? 0),
      }).score
    : cached;
  // Suppress "unused" if lastRowActivity isn't needed at the org level —
  // we attach it to AlertImport instead, but a forward-friendly hook
  // lets us extend later without changing the call shape.
  void lastRowActivity;
  return {
    id: raw.id,
    name: raw.name,
    status: raw.status,
    setup_fee_status: setup,
    setup_fee_paid_at: raw.setup_fee_paid_at,
    trial_ends_at: raw.trial_ends_at,
    next_renewal_at: raw.next_renewal_at,
    approved_at: raw.approved_at,
    cancelled_at: raw.cancelled_at,
    suspended_at: raw.suspended_at,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    mrr_gbp: Number(raw.mrr_gbp ?? 0),
    health_score: live,
    last_login_at: raw.last_login_at,
    onboarding_percent: Number(raw.onboarding_percent ?? 0),
    migration_percent: Number(raw.migration_percent ?? 0),
  };
}

function toAlertInvoice(raw: InvoiceRow): AlertInvoice {
  return {
    id: raw.id,
    org_id: raw.org_id,
    kind: raw.kind,
    status: raw.status,
    amount_gbp: Number(raw.amount_gbp ?? 0),
    due_date: raw.due_date,
    sent_at: raw.sent_at,
    paid_at: raw.paid_at,
    failed_at: raw.failed_at,
    created_at: raw.created_at,
  };
}

function toAlertImport(raw: ImportRow, lastRowActivity: string | null): AlertImport {
  return {
    id: raw.id,
    org_id: raw.org_id,
    status: raw.status,
    created_at: raw.created_at,
    last_row_activity_at: lastRowActivity ?? raw.created_at,
    committed_at: raw.committed_at,
  };
}

function toAlertDemo(raw: DemoRow): AlertDemo {
  // We approximate booked_at as approved_at when the demo is in the
  // demo_booked column — the actual stamp lives in admin_activity_log
  // but for the rules engine the row-level approved_at is a fine proxy.
  const bookedAt = raw.status === "demo_booked" ? raw.approved_at : null;
  return {
    id: raw.id,
    org_id: raw.org_id,
    email: raw.email,
    company: raw.company,
    status: raw.status,
    booked_at: bookedAt,
    created_at: raw.created_at,
  };
}

function bucketBy<T>(rows: ReadonlyArray<T>, keyOf: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

import "server-only";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { readFailure } from "@/lib/supabase/read-failure";
import type { ReportKey, ReportFormat, ReportCadence } from "./registry";

/**
 * REPORT SUBSCRIPTIONS — the ONE typed access point for the
 * `report_subscriptions` table (migration 20261134000000), which post-dates the
 * generated Supabase types. Every loose `as never` cast for this table lives
 * here; callers (the subscribe actions, the /reports page read, the delivery
 * cron) get typed functions instead of scattering casts.
 *
 * Reads page in full via `fetchAllRows` (F-1) and are org-pinned in-statement
 * (on top of RLS) so a multi-org caller never blends orgs — and so the cron's
 * service-role reads (RLS bypassed) stay org-correct.
 */

export type ReportSubscription = {
  id: string;
  org_id: string;
  report_key: ReportKey;
  format: ReportFormat;
  cadence: ReportCadence;
  recipients: string[];
  active: boolean;
  last_run_on: string | null;
  created_at: string;
};

type Row = Record<string, unknown>;

type Builder = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  select: (c: string) => Builder;
  eq: (k: string, v: unknown) => Builder;
  neq: (k: string, v: unknown) => Builder;
  order: (k: string, o: { ascending: boolean; nullsFirst?: boolean }) => Builder;
  range: (f: number, t: number) => PromiseLike<PageResult<Row>>;
  insert: (v: Row) => PromiseLike<{ error: unknown }>;
  delete: () => Builder;
};

/** The minimal client shape needed here — both the ssr and service-role client satisfy it. */
export type SubscriptionsClient = { from: (t: string) => Builder };

const TABLE = "report_subscriptions";

function toSubscription(r: Row): ReportSubscription {
  return {
    id: String(r.id),
    org_id: String(r.org_id),
    report_key: r.report_key as ReportKey,
    format: r.format as ReportFormat,
    cadence: r.cadence as ReportCadence,
    recipients: Array.isArray(r.recipients) ? (r.recipients as string[]) : [],
    active: r.active === true,
    last_run_on: r.last_run_on == null ? null : String(r.last_run_on),
    created_at: String(r.created_at),
  };
}

/** Every subscription for one org, newest first (paged, loud, org-pinned). */
export async function listReportSubscriptions(
  client: SubscriptionsClient,
  orgId: string,
): Promise<ReportSubscription[]> {
  const { data, error } = await fetchAllRows<Row>((from, to) =>
    client
      .from(TABLE)
      .select("id, org_id, report_key, format, cadence, recipients, active, last_run_on, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw readFailure("reports: list subscriptions", error);
  return (data ?? []).map(toSubscription);
}

/**
 * Active subscriptions across ALL orgs, ordered by the fairness cursor
 * (last_run_on ASC NULLS FIRST — stalest / never-run first). Service-role only
 * (the delivery cron). Paged + loud so a partial candidate set can never
 * silently skip an org's delivery.
 */
export async function listActiveSubscriptionsForDelivery(
  client: SubscriptionsClient,
): Promise<ReportSubscription[]> {
  const { data, error } = await fetchAllRows<Row>((from, to) =>
    client
      .from(TABLE)
      .select("id, org_id, report_key, format, cadence, recipients, active, last_run_on, created_at")
      .eq("active", true)
      .order("last_run_on", { ascending: true, nullsFirst: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw readFailure("reports: due subscriptions", error);
  return (data ?? []).map(toSubscription);
}

export type NewReportSubscription = {
  org_id: string;
  report_key: ReportKey;
  format: ReportFormat;
  cadence: ReportCadence;
  recipients: string[];
  created_by: string | null;
};

export async function insertReportSubscription(
  client: SubscriptionsClient,
  row: NewReportSubscription,
): Promise<{ error: unknown }> {
  return client.from(TABLE).insert(row as Row);
}

export async function deleteReportSubscription(
  client: SubscriptionsClient,
  orgId: string,
  id: string,
): Promise<{ error: unknown }> {
  // Org-pin on top of RLS — an id from another org can never match.
  const res = await client.from(TABLE).delete().eq("id", id).eq("org_id", orgId);
  return { error: (res as { error?: unknown }).error ?? null };
}

/**
 * Mark a subscription delivered TODAY — the self-draining cursor advance. Once
 * set, the candidate filter (last_run_on = today) excludes it from the rest of
 * the day's run, so a stalled tail is never re-serviced ahead of it.
 */
export async function markSubscriptionRun(
  client: SubscriptionsClient,
  id: string,
  runDay: string,
): Promise<{ error: unknown }> {
  const res = await (client.from(TABLE) as unknown as {
    update: (v: Row) => { eq: (k: string, v: unknown) => PromiseLike<{ error: unknown }> };
  })
    .update({ last_run_on: runDay })
    .eq("id", id);
  return { error: (res as { error?: unknown }).error ?? null };
}

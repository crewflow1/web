import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  readFailure,
  type SupabaseReadError,
} from "@/lib/supabase/read-failure";
import { round2, toPounds } from "@/lib/money";
import { computeRetentionPosition } from "@/lib/retentions/compute";
import { computeRetentionSchedule } from "@/lib/retentions/schedule";
import { deriveStageStatus } from "@/lib/billing/plan";
import { computePortalSchedule, type PortalSchedule } from "@/lib/customers/portal-schedule";
import { fetchAllRows } from "@/lib/supabase/paginate";

/**
 * Load a customer's agreed payment schedule for the portal (H2-CASH M3).
 *
 * SECURITY — the load-bearing filter. `job_billing_plans`/`job_billing_stages`
 * have NO customer_id, and the portal runs on the RLS-bypassing admin client, so
 * the ONLY thing keeping one customer from reading another's stages is this:
 * resolve the customer's OWN jobs first (`jobs` where org_id + customer_id), then
 * read plans/stages `.in("job_id", customerJobIds)`. Never widen this filter.
 *
 * Customer-safe by construction: it never SELECTs plan basis, stage percent/basis,
 * notes or created_by; only the stage's public face (name, amount, date, status)
 * and a retention amount + release date reach `computePortalSchedule`.
 */

type Row = Record<string, unknown>;
type Q = PromiseLike<{ data: Row[] | null; error: SupabaseReadError | null }> & {
  select: (c: string) => Q;
  eq: (k: string, v: unknown) => Q;
  in: (k: string, v: unknown[]) => Q;
  order: (k: string, o: { ascending: boolean }) => Q;
  range: (from: number, to: number) => Q;
};
type LooseAdmin = { from: (t: string) => Q };
const mv = (v: unknown) => v as number | string | null;

const EMPTY: PortalSchedule = { stages: [], retention: null, totalAgreed: 0, hasSchedule: false };

export async function loadPortalSchedule(orgId: string, customerId: string): Promise<PortalSchedule> {
  const admin = createAdminClient() as unknown as LooseAdmin;

  // 1. The customer's OWN jobs — the cross-customer barrier. PAGED (F-1): a
  // long-running customer can carry more than the 1000-row PostgREST cap of jobs,
  // and a clamped set here would silently drop jobs from the retention schedule.
  const { data: jobData, error: jobError } = await fetchAllRows<Row>((from, to) =>
    admin
      .from("jobs")
      .select("id, retention_percent, practical_completion_date, defects_liability_months, retention_first_release_pct")
      .eq("org_id", orgId)
      .eq("customer_id", customerId)
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (jobError) throw readFailure("portal schedule: jobs", jobError);
  const jobRows = jobData;
  const jobIds = jobRows.map((j) => String(j.id));
  // Legitimate empty state: this customer has no jobs, so there is genuinely
  // no schedule. This is a valid data state (reads SUCCEEDED), not an error —
  // only DB errors above throw readFailure and reach the error boundary.
  if (jobIds.length === 0) return EMPTY;

  // 2. Active plans for those jobs (one active plan per job).
  // F-1: page the full set — a long-running customer's jobs can carry more than
  // the 1000-row PostgREST cap of active plans, and a clamped set here drops
  // planIds, so the stages of later plans vanish from the schedule. Order by the
  // UNIQUE id so fetchAllRows has a stable total order (a non-unique key can drop
  // or duplicate rows at a 500-row page boundary — the very class fixed here).
  const { data: planData, error: planError } = await fetchAllRows<Row>((from, to) =>
    admin
      .from("job_billing_plans")
      .select("id")
      .eq("org_id", orgId)
      .in("job_id", jobIds)
      .eq("status", "active")
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (planError) throw readFailure("portal schedule: billing plans", planError);
  const planIds = planData.map((p) => String(p.id));

  // 3. Invoices + payments + releases for those jobs (stage status + retention).
  // F-1: page the full set — a long-running customer's jobs can carry more
  // than the 1000-row PostgREST cap of invoices, and these feed the schedule
  // status + retention maths that would silently under-report if clamped.
  const { data: invData, error: invError } = await fetchAllRows<Row>((from, to) =>
    admin
      .from("invoices")
      .select("id, status, due_date, total, amount, job_id")
      .eq("org_id", orgId)
      .in("job_id", jobIds)
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (invError) throw readFailure("portal schedule: invoices", invError);
  const invRows = invData;
  const invoiceById = new Map(invRows.map((i) => [String(i.id), i]));
  const paidByInvoice = new Map<string, number>();
  if (invRows.length > 0) {
    const { data: payData, error: payError } = await fetchAllRows<Row>((from, to) =>
      admin
        .from("invoice_payments")
        .select("invoice_id, amount")
        .eq("org_id", orgId)
        .in("invoice_id", invRows.map((i) => String(i.id)))
        .order("id", { ascending: true })
        .range(from, to),
    );
    if (payError) throw readFailure("portal schedule: invoice payments", payError);
    for (const p of payData) {
      const id = String(p.invoice_id);
      paidByInvoice.set(id, round2((paidByInvoice.get(id) ?? 0) + toPounds(mv(p.amount))));
    }
  }
  // F-1: page the full set — a clamped read here UNDER-counts released retention,
  // which OVER-states the retention held shown to the CUSTOMER (held = max(0,
  // accrued − released) in lib/retentions/compute.ts). Order by the UNIQUE id
  // (not the non-unique job_id) so fetchAllRows has a stable total order; the
  // rollup groups by job_id in JS, so the order only has to be stable. Mirrors
  // app/(app)/dashboard/page.tsx.
  const { data: relData, error: relError } = await fetchAllRows<Row>((from, to) =>
    admin
      .from("retention_releases")
      .select("job_id, amount")
      .eq("org_id", orgId)
      .in("job_id", jobIds)
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (relError) throw readFailure("portal schedule: retention releases", relError);

  // 4. Stages of the active plans (job- AND plan-scoped — belt and braces).
  // F-1: page the full set — a clamped read silently drops schedule rows for a
  // long-running customer. Keep the display order by `sequence`, but ADD the
  // UNIQUE id as a stable tiebreaker: sequence is not unique across jobs/plans,
  // and fetchAllRows needs a stable total order or rows sharing a sequence value
  // can be dropped/duplicated at a 500-row page boundary (the class fixed here).
  let stageRows: Row[] = [];
  if (planIds.length > 0) {
    const { data: stageData, error: stageError } = await fetchAllRows<Row>((from, to) =>
      admin
        .from("job_billing_stages")
        .select("id, job_id, sequence, name, amount, vat_rate, due_date, invoice_id")
        .eq("org_id", orgId)
        .in("job_id", jobIds)
        .in("plan_id", planIds)
        .order("sequence", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    );
    if (stageError) throw readFailure("portal schedule: billing stages", stageError);
    stageRows = stageData;
  }

  const stages = stageRows.map((s) => {
    const invId = s.invoice_id ? String(s.invoice_id) : null;
    const inv = invId ? invoiceById.get(invId) : null;
    const status = deriveStageStatus(
      inv
        ? { status: String(inv.status ?? ""), due_date: (inv.due_date as string | null) ?? null, total: mv(inv.total), paid: paidByInvoice.get(invId!) ?? 0 }
        : null,
    );
    return { name: String(s.name ?? ""), amount: mv(s.amount), vatRate: mv(s.vat_rate), dueDate: (s.due_date as string | null) ?? null, status };
  });

  // 5. Retention across the customer's jobs — held total + earliest release date.
  const relByJob = new Map<string, Row[]>();
  for (const r of relData ?? []) {
    const k = String(r.job_id);
    (relByJob.get(k) ?? relByJob.set(k, []).get(k)!).push(r);
  }
  const invByJob = new Map<string, Row[]>();
  for (const i of invRows) {
    const k = String(i.job_id);
    (invByJob.get(k) ?? invByJob.set(k, []).get(k)!).push(i);
  }
  let held = 0;
  let releaseDate: string | null = null;
  for (const j of jobRows) {
    const pos = computeRetentionPosition({
      ratePercent: mv(j.retention_percent),
      invoices: (invByJob.get(String(j.id)) ?? []).map((i) => ({ status: String(i.status ?? ""), amount: mv(i.amount) })),
      releases: (relByJob.get(String(j.id)) ?? []).map((r) => ({ amount: mv(r.amount) })),
    });
    if (pos.held <= 0) continue;
    held = round2(held + pos.held);
    const sched = computeRetentionSchedule({
      position: pos,
      practicalCompletionDate: (j.practical_completion_date as string | null) ?? null,
      defectsLiabilityMonths: Number(j.defects_liability_months ?? 12),
      firstReleasePct: Number(j.retention_first_release_pct ?? 50),
    });
    if (sched.nextDueDate && (!releaseDate || sched.nextDueDate < releaseDate)) releaseDate = sched.nextDueDate;
  }

  // Legitimate empty state again: reads SUCCEEDED but there is no active
  // billing plan / no stages / no retention — computePortalSchedule returns
  // { hasSchedule: false, ... }. Only DB errors throw and reach the boundary.
  return computePortalSchedule({ stages, retention: held > 0 ? { held, releaseDate } : null });
}

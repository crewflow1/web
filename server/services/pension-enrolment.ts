import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import type { PensionEnrolmentInput } from "@/lib/payroll/compute";

/**
 * pension_enrolments is not in the frozen generated types.ts (see MEMORY: the
 * regen is deliberately deferred), so the paged reads go through this minimal
 * chainable shim — the same `as never`/cast idiom used across the recent
 * untyped-table services (notification-preferences-service.ts).
 */
type PagedRow = Record<string, unknown>;
type PagedBuilder = {
  select: (c: string) => PagedBuilder;
  eq: (c: string, v: unknown) => PagedBuilder;
  order: (c: string, o: { ascending: boolean }) => PagedBuilder;
  range: (f: number, t: number) => PromiseLike<PageResult<PagedRow>>;
};
type PensionDb = { from: (t: string) => PagedBuilder };

/**
 * Pension auto-enrolment — the IO half. Reads/writes `pension_enrolments`
 * (per-employee status + contribution rates) on the USER-JWT client, org-pinned.
 * RLS is the boundary (staff read own, admins read/write org). The payroll
 * employer-cost estimate consumes {@link getPensionEnrolmentsForOrg}; the staff
 * profile config form uses the single-row read + upsert.
 */

export type PensionStatus =
  | "not_enrolled"
  | "enrolled"
  | "opted_out"
  | "postponed";

export type PensionEnrolment = {
  user_id: string;
  status: PensionStatus;
  employee_contribution_rate: number;
  employer_contribution_rate: number;
  scheme_name: string | null;
  assessment_date: string | null;
  enrolment_date: string | null;
  opt_out_date: string | null;
  postponement_end_date: string | null;
};

const COLS =
  "user_id, status, employee_contribution_rate, employer_contribution_rate, " +
  "scheme_name, assessment_date, enrolment_date, opt_out_date, postponement_end_date";

const STATUSES: readonly PensionStatus[] = [
  "not_enrolled",
  "enrolled",
  "opted_out",
  "postponed",
];

function coerce(raw: unknown): PensionEnrolment {
  const r = raw as Record<string, unknown>;
  const status = STATUSES.includes(r.status as PensionStatus)
    ? (r.status as PensionStatus)
    : "not_enrolled";
  return {
    user_id: String(r.user_id),
    status,
    employee_contribution_rate: Number(r.employee_contribution_rate ?? 0),
    employer_contribution_rate: Number(r.employer_contribution_rate ?? 0),
    scheme_name: (r.scheme_name as string | null) ?? null,
    assessment_date: (r.assessment_date as string | null) ?? null,
    enrolment_date: (r.enrolment_date as string | null) ?? null,
    opt_out_date: (r.opt_out_date as string | null) ?? null,
    postponement_end_date: (r.postponement_end_date as string | null) ?? null,
  };
}

/** One employee's enrolment, or null if none tracked. */
export async function getPensionEnrolment(
  orgId: string,
  userId: string,
): Promise<PensionEnrolment | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("pension_enrolments" as never)
    .select(COLS as never)
    .eq("org_id" as never, orgId as never)
    .eq("user_id" as never, userId as never)
    .maybeSingle();
  if (error || !data) return null;
  return coerce(data);
}

/**
 * Every tracked enrolment for the org, as a map keyed by user_id, for the
 * payroll employer-cost estimate. Paged (F-1) with an id tiebreak. Org-pinned;
 * RLS admits an admin to read all org rows. Returns an empty map on error or
 * for an org that tracks nothing — in which case payroll falls back to the
 * statutory-minimum estimate for everyone.
 */
export async function getPensionEnrolmentsForOrg(
  orgId: string,
): Promise<Map<string, PensionEnrolmentInput>> {
  const out = new Map<string, PensionEnrolmentInput>();
  const db = (await createClient()) as unknown as PensionDb;
  const { data, error } = await fetchAllRows<PagedRow>((from, to) =>
    db
      .from("pension_enrolments")
      .select("user_id, status, employer_contribution_rate, id")
      .eq("org_id", orgId)
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) return out;
  for (const raw of data ?? []) {
    const r = coerce(raw);
    out.set(r.user_id, {
      status: r.status,
      employer_contribution_rate: r.employer_contribution_rate,
    });
  }
  return out;
}

/**
 * Employee pension CONTRIBUTION rates for the org, keyed by user_id, for the
 * take-home (net-pay) estimate on the payroll run detail. Only ENROLLED employees
 * have a deduction — opted-out / postponed / not-enrolled contribute nothing — so
 * this returns a rate strictly for `status === "enrolled"` rows. Empty map on error
 * or for an org that tracks nothing, in which case net pay is the statutory
 * PAYE+NI-only figure (unchanged). Paged (F-1), org-pinned; admin RLS is the gate.
 */
export async function getEmployeePensionRatesForOrg(
  orgId: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const db = (await createClient()) as unknown as PensionDb;
  const { data, error } = await fetchAllRows<PagedRow>((from, to) =>
    db
      .from("pension_enrolments")
      .select("user_id, status, employee_contribution_rate, id")
      .eq("org_id", orgId)
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) return out;
  for (const raw of data ?? []) {
    const r = coerce(raw);
    if (r.status === "enrolled" && r.employee_contribution_rate > 0) {
      out.set(r.user_id, r.employee_contribution_rate);
    }
  }
  return out;
}

/** The opt-out register for an org: every enrolment currently opted out. */
export async function getOptOutRegisterForOrg(
  orgId: string,
): Promise<PensionEnrolment[]> {
  const db = (await createClient()) as unknown as PensionDb;
  const { data, error } = await fetchAllRows<PagedRow>((from, to) =>
    db
      .from("pension_enrolments")
      .select(COLS + ", id")
      .eq("org_id", orgId)
      .eq("status", "opted_out")
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) return [];
  return (data ?? []).map(coerce);
}

export type PensionEnrolmentUpsert = {
  status: PensionStatus;
  employee_contribution_rate: number;
  employer_contribution_rate: number;
  scheme_name: string | null;
  assessment_date: string | null;
  enrolment_date: string | null;
  opt_out_date: string | null;
  postponement_end_date: string | null;
};

/**
 * Upsert an employee's enrolment. USER JWT so the admin-only RLS write policies
 * are the boundary; org_id/user_id pinned from the server context. onConflict
 * includes org_id so a dual-org admin only touches the active org's row.
 */
export async function upsertPensionEnrolment(
  orgId: string,
  userId: string,
  input: PensionEnrolmentUpsert,
): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase.from("pension_enrolments" as never).upsert(
    {
      org_id: orgId,
      user_id: userId,
      status: input.status,
      employee_contribution_rate: input.employee_contribution_rate,
      employer_contribution_rate: input.employer_contribution_rate,
      scheme_name: input.scheme_name,
      assessment_date: input.assessment_date,
      enrolment_date: input.enrolment_date,
      opt_out_date: input.opt_out_date,
      postponement_end_date: input.postponement_end_date,
    } as never,
    { onConflict: "org_id,user_id" } as never,
  );
  if (error) {
    console.error("[pension-enrolment] upsert failed", error);
    return false;
  }
  return true;
}

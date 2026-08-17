import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginate";
import type { StoredPayrollTaxProfile } from "@/lib/payroll/compute";

/**
 * payroll_tax_profiles — per-employee income-tax region, student-loan plan and annual
 * salary sacrifice. Employer-set config: staff read their OWN row, admins read/write
 * any member's row (RLS is the boundary). Feeds the payroll take-home ESTIMATE via
 * {@link employeeInputFromStoredProfile}; the staff profile form uses the single-row
 * read + upsert. All reads org-pinned on the tenant client.
 */

export type TaxRegionValue = "rest_of_uk" | "scotland";
export type StudentLoanPlanValue =
  | "none"
  | "plan_1"
  | "plan_2"
  | "plan_4"
  | "plan_5"
  | "postgraduate";

export type PayrollTaxProfile = {
  user_id: string;
  tax_region: TaxRegionValue;
  student_loan_plan: StudentLoanPlanValue;
  salary_sacrifice_annual_pence: number;
};

const REGIONS: readonly TaxRegionValue[] = ["rest_of_uk", "scotland"];
const PLANS: readonly StudentLoanPlanValue[] = [
  "none",
  "plan_1",
  "plan_2",
  "plan_4",
  "plan_5",
  "postgraduate",
];

function coerce(raw: unknown): PayrollTaxProfile {
  const r = raw as Record<string, unknown>;
  const region = REGIONS.includes(r.tax_region as TaxRegionValue)
    ? (r.tax_region as TaxRegionValue)
    : "rest_of_uk";
  const plan = PLANS.includes(r.student_loan_plan as StudentLoanPlanValue)
    ? (r.student_loan_plan as StudentLoanPlanValue)
    : "none";
  return {
    user_id: String(r.user_id),
    tax_region: region,
    student_loan_plan: plan,
    salary_sacrifice_annual_pence: Math.max(
      0,
      Number(r.salary_sacrifice_annual_pence ?? 0) || 0,
    ),
  };
}

/** One employee's tax profile, or null if none tracked (⇒ calculator defaults). */
export async function getPayrollTaxProfile(
  orgId: string,
  userId: string,
): Promise<PayrollTaxProfile | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("payroll_tax_profiles")
    .select("user_id, tax_region, student_loan_plan, salary_sacrifice_annual_pence")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return coerce(data);
}

/**
 * Every tracked tax profile for the org, keyed by user_id, as the STORED shape the
 * payroll overlay maps into calculator inputs. Paged (F-1) with an id tiebreak;
 * org-pinned (admin RLS admits the whole org). Empty map on error or when nothing is
 * tracked — in which case every line uses the base (rest-of-UK / no-loan / no-sacrifice)
 * figures, unchanged.
 */
export async function getPayrollTaxProfilesForOrg(
  orgId: string,
): Promise<Map<string, StoredPayrollTaxProfile>> {
  const out = new Map<string, StoredPayrollTaxProfile>();
  const supabase = await createClient();
  const { data, error } = await fetchAllRows<Record<string, unknown>>((from, to) =>
    supabase
      .from("payroll_tax_profiles")
      .select(
        "id, user_id, tax_region, student_loan_plan, salary_sacrifice_annual_pence",
      )
      .eq("org_id", orgId)
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) return out;
  for (const raw of data ?? []) {
    const p = coerce(raw);
    out.set(p.user_id, {
      tax_region: p.tax_region,
      student_loan_plan: p.student_loan_plan,
      salary_sacrifice_annual_pence: p.salary_sacrifice_annual_pence,
    });
  }
  return out;
}

export type PayrollTaxProfileUpsert = {
  tax_region: TaxRegionValue;
  student_loan_plan: StudentLoanPlanValue;
  salary_sacrifice_annual_pence: number;
};

/**
 * Upsert an employee's tax profile. USER JWT so the admin-only RLS write policies are
 * the boundary; org_id/user_id pinned from the server context. onConflict includes
 * org_id so a dual-org admin only touches the active org's row.
 */
export async function upsertPayrollTaxProfile(
  orgId: string,
  userId: string,
  input: PayrollTaxProfileUpsert,
): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase.from("payroll_tax_profiles").upsert(
    {
      org_id: orgId,
      user_id: userId,
      tax_region: input.tax_region,
      student_loan_plan: input.student_loan_plan,
      salary_sacrifice_annual_pence: input.salary_sacrifice_annual_pence,
    },
    { onConflict: "org_id,user_id" },
  );
  if (error) {
    console.error("[payroll-tax-profile] upsert failed", error);
    return false;
  }
  return true;
}

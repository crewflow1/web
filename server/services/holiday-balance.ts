import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import {
  computeHolidayBalance,
  type HolidayBalance,
  type HolidayEntitlementConfig,
  type LeaveSpan,
} from "@/lib/staff/holiday";

/**
 * Holiday entitlement — the IO half. The deterministic accrual/balance maths
 * lives in the pure `lib/staff/holiday.ts`; this module reads the per-employee
 * CONFIG (holiday_entitlements), the employee's employment start date and their
 * `holiday` leave requests, then hands them to the pure engine.
 *
 * All reads run on the USER-JWT client and are org-pinned. RLS is the tenant
 * boundary (staff read own, admins read org); the explicit `.eq("org_id", …)`
 * is the active-org pin the read-pin guard requires.
 */

const CONFIG_COLS =
  "annual_allowance_days, accrual_method, carry_over_max_days, " +
  "leave_year_start_month, leave_year_start_day";

function coerceConfig(raw: unknown): HolidayEntitlementConfig {
  const r = raw as Record<string, unknown>;
  const method = r.accrual_method === "monthly" ? "monthly" : "immediate";
  return {
    annual_allowance_days: Number(r.annual_allowance_days ?? 0),
    accrual_method: method,
    carry_over_max_days: Number(r.carry_over_max_days ?? 0),
    leave_year_start_month: Number(r.leave_year_start_month ?? 1),
    leave_year_start_day: Number(r.leave_year_start_day ?? 1),
  };
}

/**
 * Read one employee's holiday entitlement config, or null if none is set.
 * Returns null on a read error too — a missing/failed config is surfaced as
 * "not configured" by the caller (the balance simply isn't shown).
 */
export async function getHolidayEntitlementConfig(
  orgId: string,
  userId: string,
): Promise<HolidayEntitlementConfig | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("holiday_entitlements" as never)
    .select(CONFIG_COLS as never)
    .eq("org_id" as never, orgId as never)
    .eq("user_id" as never, userId as never)
    .maybeSingle();
  if (error || !data) return null;
  return coerceConfig(data);
}

/**
 * The full holiday balance for one employee, or null when no entitlement is
 * configured. `refIso` defaults to today (UTC) — pass it in tests for
 * determinism.
 */
export async function getHolidayBalanceForUser(
  orgId: string,
  userId: string,
  refIso: string = new Date().toISOString().slice(0, 10),
): Promise<{ config: HolidayEntitlementConfig; balance: HolidayBalance } | null> {
  const config = await getHolidayEntitlementConfig(orgId, userId);
  if (!config) return null;

  const supabase = await createClient();

  // Employment start date drives mid-year-joiner proration. users is not org-
  // scoped, so no org pin here; the user id is the key. A failed read must not
  // masquerade as "no start date" (which would silently over-grant a joiner's
  // allowance) — on error we fall back to null proration but bind the error so
  // it is not silently discarded.
  const { data: userRow, error: userErr } = await supabase
    .from("users")
    .select("start_date")
    .eq("id", userId)
    .maybeSingle();
  const employmentStartIso = userErr
    ? null
    : ((userRow as { start_date?: string | null } | null)?.start_date ?? null);

  // The employee's holiday leave requests (any status — the engine counts
  // approved as taken, pending as booked, ignores the rest). Org-pinned + user-
  // pinned; paged for F-1 safety with an id tiebreak.
  const { data: leaveRows, error: leaveError } = await fetchAllRows<Record<string, unknown>>(
    (from, to) =>
      supabase
        .from("leave_requests")
        .select("starts_at, ends_at, status, id")
        .eq("org_id", orgId)
        .eq("user_id", userId)
        .eq("type", "holiday")
        .order("starts_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResult<Record<string, unknown>>>,
  );
  // A failed leave read must not silently show a full balance (fail-open). Treat
  // it as no data but do not fabricate — the caller can still show config.
  const spans: LeaveSpan[] = leaveError
    ? []
    : (leaveRows ?? []).map((r) => ({
        starts_at: String(r.starts_at),
        ends_at: String(r.ends_at),
        status: String(r.status),
      }));

  const balance = computeHolidayBalance({
    config,
    refIso,
    employmentStartIso,
    spans,
  });
  return { config, balance };
}

/**
 * Upsert an employee's holiday entitlement config. Runs on the USER JWT so the
 * admin-only RLS write policies are the real boundary; `org_id`/`user_id` are
 * pinned from the authenticated server context, never client input. The
 * onConflict target includes org_id so a dual-org admin only ever touches the
 * active org's row. Returns true on success.
 */
export async function upsertHolidayEntitlement(
  orgId: string,
  userId: string,
  input: HolidayEntitlementConfig,
): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase.from("holiday_entitlements" as never).upsert(
    {
      org_id: orgId,
      user_id: userId,
      annual_allowance_days: input.annual_allowance_days,
      accrual_method: input.accrual_method,
      carry_over_max_days: input.carry_over_max_days,
      leave_year_start_month: input.leave_year_start_month,
      leave_year_start_day: input.leave_year_start_day,
    } as never,
    { onConflict: "org_id,user_id" } as never,
  );
  if (error) {
    console.error("[holiday-entitlement] upsert failed", error);
    return false;
  }
  return true;
}

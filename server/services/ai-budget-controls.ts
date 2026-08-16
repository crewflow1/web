import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  AI_MONTHLY_CEILING_PENCE,
  AI_MONTHLY_CEILING_HARD_MAX_PENCE,
  effectiveCeilingPence,
  ukMonthKeyOf,
  ukMonthWindow,
  type MonthKey,
} from "@/lib/ai/governor";
import {
  listEmployeeLimits,
  listOrgCeilingOverrides,
} from "@/lib/ai/governor/limits";

/**
 * /admin/ai-costs — the EDITABLE-controls read.
 *
 * Service-role throughout, exactly like ai-cost-snapshot.ts and for the same
 * reason: the page is HQ-gated (requireHqPage → 404 for non-allowlisted), and
 * the control tables' own RLS is admin-read-only PER ORG, which by construction
 * cannot answer the estate-wide "show me every override" the editor needs. This
 * module holds no privilege the snapshot did not already carry.
 *
 * It only READS. Every write goes through app/admin/ai-costs/actions.ts → the
 * service-role RPCs, which audit atomically. Nothing here mutates.
 */

export const AI_CEILING_DEFAULT_PENCE = AI_MONTHLY_CEILING_PENCE;
export const AI_CEILING_HARD_MAX_PENCE = AI_MONTHLY_CEILING_HARD_MAX_PENCE;

export type OrgCeilingControlRow = {
  orgId: string;
  orgName: string;
  /** The effective ceiling (the override, clamped). */
  ceilingPence: number;
  note: string | null;
  updatedAt: string | null;
};

export type EmployeeLimitControlRow = {
  id: string;
  orgId: string;
  orgName: string;
  userId: string;
  userName: string;
  userEmail: string | null;
  limitPence: number;
  /** This employee's committed + live-reserved spend this UK month. */
  usedPence: number;
  note: string | null;
  updatedAt: string | null;
};

export type AiBudgetControls = {
  month: MonthKey;
  defaultCeilingPence: number;
  hardMaxPence: number;
  overrides: OrgCeilingControlRow[];
  employeeLimits: EmployeeLimitControlRow[];
  generatedAt: string;
};

type Db = {
  from(table: string): {
    select(cols: string): {
      in(col: string, vals: readonly string[]): PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};
const db = (c: unknown) => c as unknown as Db;

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

async function namesFor(
  table: "organizations" | "users",
  cols: string,
  ids: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  if (ids.length === 0) return new Map();
  try {
    const { data, error } = await db(createAdminClient()).from(table).select(cols).in("id", ids);
    if (error) {
      console.error(`[ai-budget-controls] ${table} lookup failed`, error);
      return new Map();
    }
    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    return new Map(rows.map((r) => [String(r.id), r]));
  } catch (e) {
    console.error(`[ai-budget-controls] ${table} lookup threw`, e);
    return new Map();
  }
}

/** One employee's committed + live-reserved spend this UK month, in pence. */
async function employeeUsedPence(
  orgId: string,
  userId: string,
  month: MonthKey,
): Promise<number> {
  const { startMs } = ukMonthWindow(month);
  if (!Number.isFinite(startMs)) return 0;
  try {
    const { data, error } = await db(createAdminClient()).rpc("ai_employee_month_totals", {
      p_org_id: orgId,
      p_user_id: userId,
      p_month: new Date(startMs + 86_400_000).toISOString().slice(0, 10),
    });
    if (error) {
      console.error("[ai-budget-controls] employee totals read failed", error);
      return 0;
    }
    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    return num(rows[0]?.committed_pence) + num(rows[0]?.live_pence);
  } catch (e) {
    console.error("[ai-budget-controls] employee totals read threw", e);
    return 0;
  }
}

/** Build the editable-controls view for a budget month (default: this one). */
export async function buildAiBudgetControls(month?: MonthKey): Promise<AiBudgetControls> {
  const monthKey = month ?? ukMonthKeyOf(new Date());

  const [rawOverrides, rawLimits] = await Promise.all([
    listOrgCeilingOverrides(),
    listEmployeeLimits(),
  ]);

  const orgIds = [
    ...new Set([...rawOverrides.map((o) => o.orgId), ...rawLimits.map((l) => l.orgId)]),
  ];
  const userIds = [...new Set(rawLimits.map((l) => l.userId))];

  const [orgNames, userRows] = await Promise.all([
    namesFor("organizations", "id, name", orgIds),
    namesFor("users", "id, full_name, email", userIds),
  ]);

  const overrides: OrgCeilingControlRow[] = rawOverrides
    .map((o) => ({
      orgId: o.orgId,
      orgName: String(orgNames.get(o.orgId)?.name ?? o.orgId),
      ceilingPence: effectiveCeilingPence(o.ceilingPence),
      note: o.note,
      updatedAt: o.updatedAt,
    }))
    .sort((a, b) => a.orgName.localeCompare(b.orgName));

  const employeeLimits: EmployeeLimitControlRow[] = await Promise.all(
    rawLimits.map(async (l) => {
      const u = userRows.get(l.userId);
      return {
        id: l.id,
        orgId: l.orgId,
        orgName: String(orgNames.get(l.orgId)?.name ?? l.orgId),
        userId: l.userId,
        userName: String((u?.full_name as string) || (u?.email as string) || l.userId),
        userEmail: typeof u?.email === "string" ? (u.email as string) : null,
        limitPence: l.limitPence,
        usedPence: await employeeUsedPence(l.orgId, l.userId, monthKey),
        note: l.note,
        updatedAt: l.updatedAt,
      };
    }),
  );
  employeeLimits.sort(
    (a, b) => a.orgName.localeCompare(b.orgName) || a.userName.localeCompare(b.userName),
  );

  return {
    month: monthKey,
    defaultCeilingPence: AI_CEILING_DEFAULT_PENCE,
    hardMaxPence: AI_CEILING_HARD_MAX_PENCE,
    overrides,
    employeeLimits,
    generatedAt: new Date().toISOString(),
  };
}

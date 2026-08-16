import "server-only";

/**
 * AI Cost Governor — reading the EDITABLE controls (override + per-employee limit).
 *
 * The tables (ai_org_budget_ceilings, ai_employee_budget_limits) are written
 * only through the service-role RPCs in supabase/migrations/20261147000000 and
 * read here, service-role, for two purposes:
 *
 *   1. DISPLAY / ADVISORY — the HQ /admin/ai-costs view and the advisory
 *      `checkBudget` read want the EFFECTIVE ceiling an org runs at.
 *   2. NEVER ENFORCEMENT — enforcement lives in `ai_reserve_invocation`, which
 *      resolves the override and the employee limit itself, under its per-org
 *      advisory lock, atomically with the reservation. A read here could be
 *      stale by the time a call is admitted, so it is deliberately kept OUT of
 *      the authorisation path. This module answers "what is the ceiling for
 *      display", never "may this call spend".
 *
 * FAIL-SAFE, NOT FAIL-CLOSED, and the distinction is deliberate. On a read
 * failure the effective ceiling falls back to the DEFAULT (£100), never to zero
 * and never to the hard max: a blip on an advisory surface must not silently
 * raise a ceiling, and must not manufacture a block that the authoritative
 * reserve path (which reads the real row) would not make. The reserve path is
 * where a read failure fails closed; this is where it falls back to the
 * conservative default. `checkBudget` still fails closed on the SPEND read — the
 * ceiling and the spend are separate reads with separate, correct postures.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import {
  AI_MONTHLY_CEILING_PENCE,
  effectiveCeilingPence,
} from "./policy";

type Db = {
  from(table: string): {
    select(cols: string): {
      eq(
        col: string,
        val: string,
      ): { maybeSingle(): PromiseLike<{ data: unknown; error: unknown }> };
    };
  };
};
const db = (client: unknown) => client as unknown as Db;

/**
 * A fully-PAGED read of one estate-wide table, ordered by a unique column.
 *
 * F-1 (silent-truncation): a bare `.select()` is clamped at max_rows=1000 by
 * PostgREST with NO error — so a >1000-row config set would drop its tail. These
 * control tables are small today, but "small today" is exactly the assumption
 * the F-1 class punishes; ordering by a unique column and paging makes the read
 * complete for any size, matching orgNames in ai-cost-snapshot.ts.
 */
async function pagedSelect<Row>(
  table: string,
  cols: string,
  orderCol: string,
): Promise<Row[]> {
  const client = createAdminClient() as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        order: (c: string, o: { ascending: boolean }) => {
          range: (f: number, t: number) => PromiseLike<PageResult<Row>>;
        };
      };
    };
  };
  const { data, error } = await fetchAllRows<Row>((from, to) =>
    client.from(table).select(cols).order(orderCol, { ascending: true }).range(from, to),
  );
  if (error) throw error;
  return data;
}

const CEILINGS = "ai_org_budget_ceilings";
const EMPLOYEE_LIMITS = "ai_employee_budget_limits";

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * One org's ceiling OVERRIDE in pence, or `null` when it runs at the default.
 * `{ ok: false }` distinguishes an unreadable table from a genuine absence, so
 * the caller can choose its own posture (advisory falls back to the default).
 */
export async function readOrgCeilingOverride(
  orgId: string,
): Promise<{ ok: true; overridePence: number | null } | { ok: false }> {
  try {
    const { data, error } = await db(createAdminClient())
      .from(CEILINGS)
      .select("ceiling_pence")
      .eq("org_id", orgId)
      .maybeSingle();
    if (error) {
      console.error("[ai/governor] org ceiling override read failed", error);
      return { ok: false };
    }
    const row = data as { ceiling_pence?: unknown } | null;
    return { ok: true, overridePence: row ? num(row.ceiling_pence) : null };
  } catch (e) {
    console.error("[ai/governor] org ceiling override read threw", e);
    return { ok: false };
  }
}

/**
 * The EFFECTIVE ceiling for one org, for DISPLAY / ADVISORY use — the override
 * if set and readable, else the default, clamped to the hard safety max. Falls
 * back to the default on any read failure (never silently raises).
 */
export async function resolveEffectiveCeiling(orgId: string): Promise<number> {
  const res = await readOrgCeilingOverride(orgId);
  return effectiveCeilingPence(res.ok ? res.overridePence : null);
}

/**
 * Every org ceiling override, as a `Map<orgId, overridePence>`, for the
 * estate-wide HQ view. Empty on any read failure — the view then shows every org
 * at the default, which is the conservative, never-silently-raise reading.
 */
export async function readAllOrgCeilingOverrides(): Promise<Map<string, number>> {
  try {
    const rows = await pagedSelect<Record<string, unknown>>(
      CEILINGS,
      "org_id, ceiling_pence",
      "org_id",
    );
    const out = new Map<string, number>();
    for (const r of rows) {
      const pence = num(r.ceiling_pence);
      if (typeof r.org_id === "string" && pence !== null) out.set(r.org_id, pence);
    }
    return out;
  } catch (e) {
    console.error("[ai/governor] org ceiling overrides read failed", e);
    return new Map();
  }
}

export type OrgCeilingOverrideRow = {
  orgId: string;
  ceilingPence: number;
  note: string | null;
  updatedAt: string | null;
};

/** Every override row with its metadata, for the editor. Empty on read failure. */
export async function listOrgCeilingOverrides(): Promise<OrgCeilingOverrideRow[]> {
  try {
    const rows = await pagedSelect<Record<string, unknown>>(
      CEILINGS,
      "org_id, ceiling_pence, note, updated_at",
      "org_id",
    );
    return rows
      .map((r) => ({
        orgId: String(r.org_id ?? ""),
        ceilingPence: num(r.ceiling_pence) ?? AI_MONTHLY_CEILING_PENCE,
        note: typeof r.note === "string" ? r.note : null,
        updatedAt: typeof r.updated_at === "string" ? r.updated_at : null,
      }))
      .filter((r) => r.orgId.length > 0);
  } catch (e) {
    console.error("[ai/governor] override list read failed", e);
    return [];
  }
}

export type EmployeeLimitRow = {
  id: string;
  orgId: string;
  userId: string;
  limitPence: number;
  note: string | null;
  updatedAt: string | null;
};

/** Every per-employee limit row, for the editor. Empty on read failure. */
export async function listEmployeeLimits(): Promise<EmployeeLimitRow[]> {
  try {
    const rows = await pagedSelect<Record<string, unknown>>(
      EMPLOYEE_LIMITS,
      "id, org_id, user_id, limit_pence, note, updated_at",
      "id",
    );
    return rows
      .map((r) => ({
        id: String(r.id ?? ""),
        orgId: String(r.org_id ?? ""),
        userId: String(r.user_id ?? ""),
        limitPence: num(r.limit_pence) ?? 0,
        note: typeof r.note === "string" ? r.note : null,
        updatedAt: typeof r.updated_at === "string" ? r.updated_at : null,
      }))
      .filter((r) => r.id.length > 0);
  } catch (e) {
    console.error("[ai/governor] employee limit list read failed", e);
    return [];
  }
}

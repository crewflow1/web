import "server-only";
import type { User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { hasCapability } from "@/server/auth/capabilities";
import { isManagementRole, requireOrgContext, type OrgContext } from "@/server/auth/session";

/**
 * Columns the Data API no longer serves (least-privilege enforcement,
 * migrations 20261341–20261343).
 *
 * Row-level security decides WHICH ROWS a member sees; it cannot hide a COLUMN.
 * A `staff` member legitimately sees some rows that carry a value they must not
 * read — the customer of a job they are assigned to (its portal credential), a
 * colleague's `users` row (phone, employment type, start date), an asset on
 * their job (purchase price, value). Those columns therefore carry NO SELECT
 * grant for the `authenticated` role at all, and the server reads them here with
 * the service role AFTER an explicit authorisation check.
 *
 * Two forms of every reader:
 *   • `readX(id)`            — for pages/actions. Resolves the caller and the
 *                              ACTIVE org from the SESSION (requireOrgContext);
 *                              takes no org argument at all.
 *   • `readXFor(ctx, user…)` — the same check + read on an already-resolved
 *                              context (and the seam the integration tier drives).
 * Both pin `org_id` to the resolved context and return nothing for a caller the
 * rule does not admit. Never add a reader that takes an org id from a request.
 */

export type PrivateProfile = {
  phone: string | null;
  employment_type: string | null;
  start_date: string | null;
};

const EMPTY_PROFILE: PrivateProfile = Object.freeze({
  phone: null,
  employment_type: null,
  start_date: null,
});

type ReadResult = { data: unknown; error: SupabaseReadError | null };
type Filter = {
  eq: (k: string, v: string) => Filter;
  in: (k: string, v: readonly string[]) => Filter;
  order: (k: string, o: { ascending: boolean }) => Filter;
  range: (from: number, to: number) => PromiseLike<ReadResult>;
  maybeSingle: () => PromiseLike<ReadResult>;
};
type Loose = { from: (t: string) => { select: (c: string) => Filter } };

const db = (): Loose => createAdminClient() as unknown as Loose;

// ── users: phone / employment_type / start_date ──────────────────────────────

/**
 * The session user's OWN phone / employment type / start date.
 * `user` is the authenticated session user — a member may always read their own.
 */
export async function readOwnPrivateProfile(user: Pick<User, "id">): Promise<PrivateProfile> {
  const { data, error } = await db()
    .from("users")
    .select("phone, employment_type, start_date")
    .eq("id", user.id)
    .maybeSingle();
  if (error) throw readFailure("private profile: own", error);
  return { ...EMPTY_PROFILE, ...((data as Partial<PrivateProfile> | null) ?? {}) };
}

/**
 * Private profile fields of members of the caller's ACTIVE org.
 *
 * Authorisation: an owner/admin may read any member of their org; anyone else
 * only themselves. Ids that are not members of `ctx.org` resolve to nothing
 * (the membership read is the org pin — `users` has no org column).
 */
export async function readMemberPrivateProfiles(
  ctx: OrgContext,
  viewer: Pick<User, "id">,
  userIds: readonly string[],
): Promise<Map<string, PrivateProfile>> {
  const out = new Map<string, PrivateProfile>();
  const wanted = isManagementRole(ctx.membership.role)
    ? [...new Set(userIds)]
    : userIds.includes(viewer.id)
      ? [viewer.id]
      : [];
  if (wanted.length === 0) return out;

  const members = await fetchAllRows<{ user_id: string }>(
    (from, to) =>
      db()
        .from("memberships")
        .select("user_id")
        .eq("org_id", ctx.org.id)
        .in("user_id", wanted)
        .order("user_id", { ascending: true })
        .range(from, to) as PromiseLike<PageResult<{ user_id: string }>>,
  );
  if (members.error) {
    throw readFailure("private profile: membership pin", members.error as SupabaseReadError);
  }
  const memberIds = members.data.map((m) => m.user_id);
  if (memberIds.length === 0) return out;

  type Row = PrivateProfile & { id: string };
  const profiles = await fetchAllRows<Row>(
    (from, to) =>
      db()
        .from("users")
        .select("id, phone, employment_type, start_date")
        .in("id", memberIds)
        .order("id", { ascending: true })
        .range(from, to) as PromiseLike<PageResult<Row>>,
  );
  if (profiles.error) {
    throw readFailure("private profile: members", profiles.error as SupabaseReadError);
  }
  for (const p of profiles.data) {
    out.set(p.id, {
      phone: p.phone ?? null,
      employment_type: p.employment_type ?? null,
      start_date: p.start_date ?? null,
    });
  }
  return out;
}

// ── customers: portal_token ──────────────────────────────────────────────────

/**
 * A customer's portal credential (the bearer token behind "copy portal link").
 *
 * Authorisation: `customers:view` in the caller's active org (owner always; an
 * admin with the grant; never staff). Anyone else gets null — including a staff
 * member assigned to that customer's job, who can see the customer row but must
 * not be able to open the customer's portal (register ST-07a).
 */
export async function readCustomerPortalTokenFor(
  ctx: OrgContext,
  user: User,
  customerId: string,
): Promise<string | null> {
  if (!(await hasCapability(ctx, user, "customers", "view"))) return null;
  const { data, error } = await db()
    .from("customers")
    .select("portal_token")
    .eq("id", customerId)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (error) throw readFailure("customer: portal credential", error);
  return (data as { portal_token: string | null } | null)?.portal_token ?? null;
}

export async function readCustomerPortalToken(customerId: string): Promise<string | null> {
  const { ctx, user } = await requireOrgContext();
  return readCustomerPortalTokenFor(ctx, user, customerId);
}

// ── assets: purchase_price / current_value / hire_rate ───────────────────────

export type AssetMoney = {
  purchase_price: number | string | null;
  current_value: number | string | null;
  hire_rate: number | string | null;
};

/** Authorisation: `assets:view` in the caller's active org. */
export async function readAssetMoneyFor(
  ctx: OrgContext,
  user: User,
  assetId: string,
): Promise<AssetMoney | null> {
  if (!(await hasCapability(ctx, user, "assets", "view"))) return null;
  const { data, error } = await db()
    .from("assets")
    .select("purchase_price, current_value, hire_rate")
    .eq("id", assetId)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (error) throw readFailure("asset: money columns", error);
  return (data as AssetMoney | null) ?? null;
}

export async function readAssetMoney(assetId: string): Promise<AssetMoney | null> {
  const { ctx, user } = await requireOrgContext();
  return readAssetMoneyFor(ctx, user, assetId);
}

// ── fleet: purchase price + finance agreement ────────────────────────────────

export type VehicleMoney = {
  purchasePrice: number | null;
  financeType: string;
  financeProviderId: string | null;
  financeAgreementRef: string | null;
  financeMonthlyPayment: number | null;
  financeEndDate: string | null;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * A vehicle's purchase price and finance agreement (type, provider, reference,
 * monthly payment, end date). Authorisation: `fleet:view` in the active org.
 */
export async function readVehicleMoneyFor(
  ctx: OrgContext,
  user: User,
  assetId: string,
): Promise<VehicleMoney | null> {
  if (!(await hasCapability(ctx, user, "fleet", "view"))) return null;
  const [asset, vehicle] = await Promise.all([
    db().from("assets").select("purchase_price").eq("id", assetId).eq("org_id", ctx.org.id).maybeSingle(),
    db()
      .from("fleet_vehicles")
      .select(
        "finance_type, finance_provider_id, finance_agreement_ref, finance_monthly_payment, finance_end_date",
      )
      .eq("asset_id", assetId)
      .eq("org_id", ctx.org.id)
      .maybeSingle(),
  ]);
  if (asset.error) throw readFailure("vehicle: purchase price", asset.error);
  if (vehicle.error) throw readFailure("vehicle: finance columns", vehicle.error);
  const a = (asset.data as { purchase_price?: unknown } | null) ?? {};
  const v = (vehicle.data as Record<string, unknown> | null) ?? {};
  return {
    purchasePrice: num(a.purchase_price),
    financeType: typeof v.finance_type === "string" && v.finance_type ? v.finance_type : "none",
    financeProviderId: (v.finance_provider_id as string | null) ?? null,
    financeAgreementRef: (v.finance_agreement_ref as string | null) ?? null,
    financeMonthlyPayment: num(v.finance_monthly_payment),
    financeEndDate: (v.finance_end_date as string | null) ?? null,
  };
}

export async function readVehicleMoney(assetId: string): Promise<VehicleMoney | null> {
  const { ctx, user } = await requireOrgContext();
  return readVehicleMoneyFor(ctx, user, assetId);
}

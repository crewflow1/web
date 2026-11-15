/* eslint-disable @typescript-eslint/no-explicit-any -- raw PostgREST rows; see adversarial/_fixture.ts */
import { afterAll, beforeAll, expect, it } from "vitest";
import type { User } from "@supabase/supabase-js";
import { describeIntegration } from "../_harness";
import { as, createWorld, destroyWorld, loadSurface, publicTables, rawFetch, svc, type World } from "../adversarial/_fixture";
import type { OrgContext } from "@/server/auth/session";

/**
 * PRIVATE COLUMNS — values a member may see the ROW of but must not read.
 *
 * Row-level security cannot hide a column. Migrations 20261341–43 therefore remove the
 * client SELECT grant from these columns; the server reads them with the service role
 * after an explicit check (server/services/private-columns.ts).
 *
 *   customers       portal_token                              ST-07a (portal bearer credential)
 *   customer_contacts portal_token                            ST-07a (per-contact credential; none minted yet)
 *   users           phone, employment_type, start_date         S-2    (a colleague's personal data)
 *   assets          purchase_price, current_value, hire_rate   S-3    (company financial data)
 *   fleet_vehicles  finance_*                                  S-3
 *
 * The ACL is role-wide: NO client JWT — staff, admin or owner — reads these through
 * PostgREST. Each rule is proved three ways: the column is refused; the rest of the row
 * is still served (what staff legitimately need was kept); the server-side reader gives
 * the value to an authorised caller and nothing to a staff caller.
 *
 * PRIVATE is the single list. A column added to one of these tables later must be
 * granted (then it is client-readable) or added here: the completeness case fails on a
 * column that is neither — so the "new column silently unreadable" trap cannot ship.
 */
const PRIVATE = {
  customers: ["portal_token"],
  customer_contacts: ["portal_token"],
  users: ["phone", "employment_type", "start_date"],
  assets: ["purchase_price", "current_value", "hire_rate"],
  fleet_vehicles: ["finance_type", "finance_provider_id", "finance_agreement_ref", "finance_monthly_payment", "finance_end_date"],
} as const satisfies Record<string, readonly string[]>;

const ctxFor = (orgId: string, role: "owner" | "admin" | "staff"): OrgContext =>
  ({ org: { id: orgId }, membership: { role } }) as unknown as OrgContext;
const userFor = (id: string): User => ({ id }) as unknown as User;

describeIntegration("LEAST PRIVILEGE · private columns are not served by the Data API", () => {
  let w: World | null = null;
  let customerId = "";
  let portalToken = "";
  let assetId = "";

  beforeAll(async () => {
    w = await createWorld("seclp-col");
    const A = w.A.id;
    const c = await svc().from("customers").insert({ org_id: A, name: `Col customer ${w.tag}`, phone: "07700 900111" }).select("id, portal_token").single();
    if (c.error) throw new Error(c.error.message);
    customerId = (c.data as any).id;
    portalToken = (c.data as any).portal_token;
    // The realistic insider: a fitter assigned to one of the customer's jobs.
    const j = await svc().from("jobs").insert({ org_id: A, customer_id: customerId, assigned_to: w.A.staff.id }).select("id").single();
    if (j.error) throw new Error(j.error.message);
    await svc().from("job_assignments").insert({ org_id: A, job_id: (j.data as any).id, user_id: w.A.staff.id });
    const a = await svc().from("assets").insert({ org_id: A, name: `Col asset ${w.tag}`, purchase_price: 54321.5, current_value: 40000, hire_rate: 99 }).select("id").single();
    if (a.error) throw new Error(a.error.message);
    assetId = (a.data as any).id;
    const u = await svc().from("users").update({ phone: "07700 900222", employment_type: "employee", start_date: "2024-03-01" }).eq("id", w.A.owner.id);
    if (u.error) throw new Error(u.error.message);
    const s = await svc().from("users").update({ phone: "07700 900333" }).eq("id", w.A.staff.id);
    if (s.error) throw new Error(s.error.message);
  }, 120_000);

  afterAll(async () => {
    await destroyWorld(w);
  }, 120_000);

  it("ST-07a · a staff member assigned to a customer's job sees the customer but can NOT read, select-star or filter on the portal token", async () => {
    const world = w!;
    const staff = as(world.A.staff.token);
    expect(portalToken.length, "fixture: the customer has a server-minted portal token").toBeGreaterThan(10);

    // kept: the row itself (name, phone) — staff need it on site.
    const row = await staff.from("customers").select("id, name, phone").eq("id", customerId);
    expect(row.error, JSON.stringify(row.error)).toBeNull();
    expect(row.data ?? []).toHaveLength(1);

    for (const attempt of [
      staff.from("customers").select("id, portal_token").eq("id", customerId),
      staff.from("customers").select("*").eq("id", customerId),
      staff.from("customers").select("id").eq("portal_token", portalToken),
      staff.from("jobs").select("id, customer:customers ( id, portal_token )").eq("customer_id", customerId),
    ]) {
      const r = await attempt;
      expect(r.error?.code, `expected 42501, got ${JSON.stringify(r.error)} / ${JSON.stringify(r.data)}`).toBe("42501");
    }
    // ...and nothing in a staff response body ever carries the credential.
    const raw = await rawFetch(`/rest/v1/customers?id=eq.${customerId}&select=*`, { bearer: world.A.staff.token });
    expect(JSON.stringify(raw.json)).not.toContain(portalToken);
  });

  it("ST-07a · the admin 'copy portal link' path still works: the server reader returns the token to a customers:view holder and null to staff", async () => {
    const world = w!;
    const { readCustomerPortalTokenFor } = await import("@/server/services/private-columns");
    expect(await readCustomerPortalTokenFor(ctxFor(world.A.id, "owner"), userFor(world.A.owner.id), customerId)).toBe(portalToken);
    expect(await readCustomerPortalTokenFor(ctxFor(world.A.id, "staff"), userFor(world.A.staff.id), customerId)).toBeNull();
    // org pin: an owner of ANOTHER org gets nothing for this customer id.
    expect(await readCustomerPortalTokenFor(ctxFor(world.B.id, "owner"), userFor(world.B.owner.id), customerId)).toBeNull();
    // The rotate action's write path (user JWT, owner/admin by RLS) is intact.
    const rotated = await as(world.A.owner.token).from("customers").update({ portal_token_last_used_at: null }, { count: "exact" }).eq("id", customerId).eq("org_id", world.A.id);
    expect(rotated.error, JSON.stringify(rotated.error)).toBeNull();
    expect(rotated.count).toBe(1);
  });

  it("S-2 · staff can read a colleague's name and e-mail but NOT their phone, employment type or start date", async () => {
    const world = w!;
    const staff = as(world.A.staff.token);
    const kept = await staff.from("users").select("id, full_name, email").eq("id", world.A.owner.id);
    expect(kept.error, JSON.stringify(kept.error)).toBeNull();
    expect(kept.data ?? []).toHaveLength(1);
    for (const col of PRIVATE.users) {
      const r = await staff.from("users").select(`id, ${col}`).eq("id", world.A.owner.id);
      expect(r.error?.code, `users.${col}: ${JSON.stringify(r.error)} / ${JSON.stringify(r.data)}`).toBe("42501");
    }
    const embed = await staff.from("memberships").select("user_id, user:users ( id, phone )").eq("org_id", world.A.id);
    expect(embed.error?.code).toBe("42501");
  });

  it("S-2 · the server reader: a member gets their OWN private profile, staff get nothing for a colleague, an owner gets their org's members only", async () => {
    const world = w!;
    const { readMemberPrivateProfiles, readOwnPrivateProfile } = await import("@/server/services/private-columns");
    expect((await readOwnPrivateProfile(userFor(world.A.staff.id))).phone).toBe("07700 900333");

    const asStaff = await readMemberPrivateProfiles(ctxFor(world.A.id, "staff"), userFor(world.A.staff.id), [world.A.owner.id, world.A.admin.id, world.A.staff.id]);
    expect([...asStaff.keys()]).toEqual([world.A.staff.id]);
    const colleagueOnly = await readMemberPrivateProfiles(ctxFor(world.A.id, "staff"), userFor(world.A.staff.id), [world.A.owner.id]);
    expect(colleagueOnly.size).toBe(0);

    const asOwner = await readMemberPrivateProfiles(ctxFor(world.A.id, "owner"), userFor(world.A.owner.id), [world.A.owner.id, world.A.staff.id, world.B.owner.id]);
    expect(asOwner.get(world.A.owner.id)).toEqual({ phone: "07700 900222", employment_type: "employee", start_date: "2024-03-01" });
    expect(asOwner.has(world.A.staff.id)).toBe(true);
    expect(asOwner.has(world.B.owner.id), "another org's member must not resolve").toBe(false);
  });

  it("S-3 · staff see an asset row but NOT its purchase price, value or hire rate; the server reader serves an assets:view holder only", async () => {
    const world = w!;
    const staff = as(world.A.staff.token);
    const kept = await staff.from("assets").select("id, name, status").eq("id", assetId);
    expect(kept.error, JSON.stringify(kept.error)).toBeNull();
    expect(kept.data ?? []).toHaveLength(1);
    for (const col of PRIVATE.assets) {
      const r = await staff.from("assets").select(`id, ${col}`).eq("id", assetId);
      expect(r.error?.code, `assets.${col}`).toBe("42501");
    }
    for (const col of PRIVATE.fleet_vehicles) {
      const r = await staff.from("fleet_vehicles").select(`asset_id, ${col}`).limit(1);
      expect(r.error?.code, `fleet_vehicles.${col}`).toBe("42501");
    }
    const { readAssetMoneyFor } = await import("@/server/services/private-columns");
    const money = await readAssetMoneyFor(ctxFor(world.A.id, "owner"), userFor(world.A.owner.id), assetId);
    expect(Number(money?.purchase_price)).toBe(54321.5);
    expect(await readAssetMoneyFor(ctxFor(world.A.id, "staff"), userFor(world.A.staff.id), assetId)).toBeNull();
    expect(await readAssetMoneyFor(ctxFor(world.B.id, "owner"), userFor(world.B.owner.id), assetId)).toBeNull();
  });

  it("completeness · on the five tables every column is EITHER client-readable OR listed as private — never silently neither", async () => {
    const world = w!;
    const surface = await loadSurface();
    const problems: string[] = [];
    for (const rel of publicTables(surface)) {
      const priv: readonly string[] | undefined = (PRIVATE as Record<string, readonly string[]>)[rel.name];
      if (!priv) continue;
      for (const col of rel.columns) {
        const r = await rawFetch(`/rest/v1/${rel.name}?select=${col.name}&limit=1`, { bearer: world.A.owner.token });
        const readable = r.status === 200;
        if (priv.includes(col.name) && readable) problems.push(`${rel.name}.${col.name} is PRIVATE but an owner JWT can read it`);
        if (!priv.includes(col.name) && !readable) problems.push(`${rel.name}.${col.name} is not private but is not client-readable (status ${r.status}) — grant it or list it`);
      }
      for (const p of priv) {
        if (!rel.columns.some((c) => c.name === p)) problems.push(`${rel.name}.${p} is listed as private but does not exist`);
      }
    }
    expect(problems).toEqual([]);
  });
});

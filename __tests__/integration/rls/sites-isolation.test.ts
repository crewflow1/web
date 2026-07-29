import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Sites · tenant isolation, the DUAL-ORG active-org proof, and teardown safety
 * (20261061000000).
 *
 * The headline is the dual-org pair. A user who belongs to BOTH org A and org B
 * passes RLS for both, because `current_org_ids()` returns every org they are a
 * member of and `is_org_admin(org_id)` passes for every org they administer. So:
 *
 *   - an RLS-ONLY read returns BOTH orgs' sites — proving RLS alone cannot
 *     express "the company I am currently working in", which is exactly why
 *     every sites query carries its own org predicate;
 *   - the SAME read with `.eq("org_id", A)` returns only A's;
 *   - a MUTATION pinned to org A cannot touch org B's site, which is the pin
 *     that actually protects data rather than merely tidying a list.
 *
 * Plus the three structural controls this milestone adds:
 *   - the site-org guard makes a cross-tenant reference unwritable for EVERY
 *     role, service_role included;
 *   - the delete guard refuses to delete a referenced site (deactivate instead);
 *   - and that guard YIELDS to an org teardown, so `delete from organizations`
 *     still succeeds — the 20261052000000 cascade lesson, re-proved here
 *     because a new BEFORE DELETE trigger is exactly how that P1 came back.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  order(column: string, opts: { ascending: boolean }): Sel;
}
interface Upd extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Upd;
  select(columns?: string): Upd;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Del extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  update(patch: Row): Upd;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const rpc = (client: unknown) =>
  client as unknown as {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<unknown>>;
  };

const TOKEN = `it-sites-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("sites · tenant isolation + active-org pinning", () => {
  let orgA = "";
  let orgB = "";
  let siteA = "";
  let siteB = "";
  let assetA = "";
  let dualUserId = "";
  let dualToken = "";
  let outsiderId = "";
  let outsiderToken = "";

  const svc = () => db(serviceClient());

  async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
    const email = `${TOKEN}-${suffix}@example.test`;
    const password = `Pw-${TOKEN}-${suffix}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    const mirrored = await svc()
      .from("users")
      .insert({ id, email, full_name: `Sites ${suffix}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const token = signedIn.data.session?.access_token ?? "";
    if (!id || !token) throw new Error(`failed to mint user ${suffix}`);
    return { id, token };
  }

  async function makeOrg(name: string, slug: string): Promise<string> {
    const org = await svc()
      .from("organizations")
      .insert({ name, slug })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    return String(org.data?.id ?? "");
  }

  async function makeSite(orgId: string, name: string, kind = "yard"): Promise<string> {
    const site = await svc()
      .from("sites")
      .insert({ org_id: orgId, name, kind, city: "Wakefield", postcode: "WF1 1AA" })
      .select("id")
      .single();
    expect(site.error, site.error?.message).toBeNull();
    return String(site.data?.id ?? "");
  }

  beforeAll(async () => {
    orgA = await makeOrg("Sites Probe A", `${TOKEN}-a`);
    orgB = await makeOrg("Sites Probe B", `${TOKEN}-b`);
    if (!orgA || !orgB) throw new Error("failed to create probe orgs");

    // Deliberately IDENTICAL names in both orgs, so a leak is a real confusion
    // rather than something a human would spot instantly.
    siteA = await makeSite(orgA, "Wakefield yard");
    siteB = await makeSite(orgB, "Wakefield yard");

    const asset = await svc()
      .from("assets")
      .insert({ org_id: orgA, name: "Transit 350", category: "Vehicle" })
      .select("id")
      .single();
    expect(asset.error, asset.error?.message).toBeNull();
    assetA = String(asset.data?.id ?? "");

    const dual = await makeUser("dual");
    dualUserId = dual.id;
    dualToken = dual.token;
    const outsider = await makeUser("outsider");
    outsiderId = outsider.id;
    outsiderToken = outsider.token;

    // THE dual-org membership: this user legitimately administers A and B.
    for (const org of [orgA, orgB]) {
      const m = await svc()
        .from("memberships")
        .insert({ org_id: org, user_id: dualUserId, role: "admin" })
        .select("user_id")
        .single();
      expect(m.error, m.error?.message).toBeNull();
    }
  });

  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (orgB) await svc().from("organizations").delete().eq("id", orgB);
    if (dualUserId) await serviceClient().auth.admin.deleteUser(dualUserId);
    if (outsiderId) await serviceClient().auth.admin.deleteUser(outsiderId);
  });

  // ── baseline RLS ──────────────────────────────────────────────────────────
  it("anon is denied sites entirely", async () => {
    const { data, error } = await db(anonClient()).from("sites").select("*");
    expect(error ? true : (data ?? []).length === 0, "sites leaked to anon").toBe(true);
  });

  it("an authenticated NON-member sees no sites at all", async () => {
    const { data, error } = await db(userClient(outsiderToken)).from("sites").select("id");
    expect(error ? true : (data ?? []).length === 0).toBe(true);
  });

  it("a non-member cannot create a site in someone else's org", async () => {
    const { error } = await db(userClient(outsiderToken))
      .from("sites")
      .insert({ org_id: orgA, name: "Hostile depot", kind: "depot" })
      .select("id")
      .single();
    expect(error, "sites_insert should have refused a non-member").not.toBeNull();
  });

  // ── the reference-data posture: members read, admins write ────────────────
  it("an ordinary MEMBER can read sites but cannot create one", async () => {
    const member = await makeUser("member");
    const m = await svc()
      .from("memberships")
      .insert({ org_id: orgA, user_id: member.id, role: "staff" })
      .select("user_id")
      .single();
    expect(m.error, m.error?.message).toBeNull();

    const read = await db(userClient(member.token)).from("sites").select("id").eq("org_id", orgA);
    expect(read.error, read.error?.message).toBeNull();
    expect((read.data ?? []).map((r) => String(r.id))).toContain(siteA);

    const write = await db(userClient(member.token))
      .from("sites")
      .insert({ org_id: orgA, name: "Member depot", kind: "depot" })
      .select("id")
      .single();
    expect(write.error, "sites_insert is is_org_admin — a member must be refused").not.toBeNull();

    await serviceClient().auth.admin.deleteUser(member.id);
  });

  // ── THE dual-org proof ────────────────────────────────────────────────────
  it("RLS ALONE returns BOTH orgs' sites to a dual-org member", async () => {
    // Not a bug in RLS — it is what current_org_ids() means, and precisely why
    // the app pins the active org on every query. This assertion is the
    // evidence that the pin is load-bearing rather than decoration.
    const { data, error } = await db(userClient(dualToken)).from("sites").select("id");
    expect(error, error?.message).toBeNull();
    const ids = (data ?? []).map((r) => String(r.id));
    expect(ids).toContain(siteA);
    expect(ids).toContain(siteB);
  });

  it("the SAME read pinned to the active org returns only that org's site", async () => {
    const { data, error } = await db(userClient(dualToken))
      .from("sites")
      .select("id")
      .eq("org_id", orgA);
    expect(error, error?.message).toBeNull();
    const ids = (data ?? []).map((r) => String(r.id));
    expect(ids).toEqual([siteA]);
    expect(ids).not.toContain(siteB);
  });

  it("a by-id read pinned to org A cannot fetch org B's site", async () => {
    const { data, error } = await db(userClient(dualToken))
      .from("sites")
      .select("id")
      .eq("id", siteB)
      .eq("org_id", orgA);
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(0); // → notFound() in the app
  });

  // ── THE mutation-proof pin ────────────────────────────────────────────────
  it("an UPDATE pinned to org A cannot rename org B's site", async () => {
    // RLS lets this dual-org ADMIN update B's row; only the `.eq("org_id", A)`
    // predicate the action carries stops it. Remove the pin and this goes red.
    const { error } = await db(userClient(dualToken))
      .from("sites")
      .update({ name: "Hijacked yard" })
      .eq("id", siteB)
      .eq("org_id", orgA);
    expect(error, error?.message).toBeNull(); // zero rows matched is not an error

    const check = await svc().from("sites").select("name").eq("id", siteB);
    expect(String(check.data?.[0]?.name)).toBe("Wakefield yard");
  });

  it("…and the SAME update WITHOUT the pin would have succeeded", async () => {
    // The counter-proof: without this the test above could pass because RLS
    // blocked it, and the pin would be untested decoration.
    const { error } = await db(userClient(dualToken))
      .from("sites")
      .update({ name: "Renamed by RLS alone" })
      .eq("id", siteB);
    expect(error, error?.message).toBeNull();

    const check = await svc().from("sites").select("name").eq("id", siteB);
    expect(String(check.data?.[0]?.name)).toBe("Renamed by RLS alone");

    // Put it back so the rest of the suite reads as written.
    await svc().from("sites").update({ name: "Wakefield yard" }).eq("id", siteB);
  });

  it("a DELETE pinned to org A cannot delete org B's site", async () => {
    const { error } = await db(userClient(dualToken))
      .from("sites")
      .delete()
      .eq("id", siteB)
      .eq("org_id", orgA);
    expect(error, error?.message).toBeNull();

    const survivor = await svc().from("sites").select("id").eq("id", siteB);
    expect(survivor.data ?? []).toHaveLength(1);
  });

  // ── uniqueness ────────────────────────────────────────────────────────────
  it("one name per org, case-insensitively — but the same name in two orgs is fine", async () => {
    // Both orgs already hold "Wakefield yard" (see beforeAll) — that is the
    // cross-org half, proved by the fixtures existing at all.
    const clash = await svc()
      .from("sites")
      .insert({ org_id: orgA, name: "WAKEFIELD YARD", kind: "depot" })
      .select("id")
      .single();
    expect(clash.error, "the case-insensitive unique index should have refused").not.toBeNull();
    expect(clash.error?.code).toBe("23505");
  });

  // ── the cross-tenant reference control ────────────────────────────────────
  it("a vehicle cannot point at another org's site, even for service_role", async () => {
    const veh = await svc()
      .from("fleet_vehicles")
      .insert({ asset_id: assetA, org_id: orgA, home_site_id: siteB })
      .select("asset_id")
      .single();
    expect(veh.error, "the site-org guard should have refused a cross-tenant depot").not.toBeNull();

    // …and the same row with its OWN org's site is accepted.
    const ok = await svc()
      .from("fleet_vehicles")
      .insert({ asset_id: assetA, org_id: orgA, home_site_id: siteA })
      .select("asset_id")
      .single();
    expect(ok.error, ok.error?.message).toBeNull();
  });

  it("a custody record cannot point at another org's site, even for service_role", async () => {
    const bad = await svc()
      .from("asset_assignments")
      .insert({
        org_id: orgA,
        asset_id: assetA,
        assignment_type: "stored_at_depot",
        site_id: siteB,
        status: "open",
      })
      .select("id")
      .single();
    expect(bad.error, "the site-org guard should have refused a cross-tenant site").not.toBeNull();

    const ok = await svc()
      .from("asset_assignments")
      .insert({
        org_id: orgA,
        asset_id: assetA,
        assignment_type: "stored_at_depot",
        site_id: siteA,
        status: "open",
      })
      .select("id")
      .single();
    expect(ok.error, ok.error?.message).toBeNull();
  });

  it("the transfer RPC carries the site and is still atomic", async () => {
    const { data, error } = await rpc(serviceClient()).rpc("transfer_asset_assignment", {
      p_asset_id: assetA,
      p_org_id: orgA,
      p_assignment_type: "stored_at_depot",
      p_job_id: null,
      p_assignee_id: null,
      p_vehicle_asset_id: null,
      p_location: null,
      p_issue_condition: "good",
      p_issue_notes: null,
      p_expected_return_at: null,
      p_assigned_by: dualUserId,
      p_site_id: siteA,
    });
    expect(error, error?.message).toBeNull();
    expect(data).toBeTruthy();

    const open = await svc()
      .from("asset_assignments")
      .select("id, site_id")
      .eq("asset_id", assetA)
      .eq("status", "open");
    expect(open.data ?? []).toHaveLength(1);
    expect(String(open.data?.[0]?.site_id)).toBe(siteA);
  });

  it("the transfer RPC still resolves for callers that omit the new argument", async () => {
    // The parameter was APPENDED with a default precisely so pre-existing
    // 11-argument callers keep working. PGRST202 here would mean the signature
    // change broke them.
    const { error } = await rpc(serviceClient()).rpc("transfer_asset_assignment", {
      p_asset_id: assetA,
      p_org_id: orgA,
      p_assignment_type: "issued_to_staff",
      p_job_id: null,
      p_assignee_id: dualUserId,
      p_vehicle_asset_id: null,
      p_location: null,
      p_issue_condition: "good",
      p_issue_notes: null,
      p_expected_return_at: null,
      p_assigned_by: dualUserId,
    });
    expect(error?.code, `must resolve: ${error?.message}`).not.toBe("PGRST202");
    expect(error, error?.message).toBeNull();
  });

  it("the fleet save RPC refuses another org's site while pinned to org A", async () => {
    const { error } = await rpc(userClient(dualToken)).rpc("save_fleet_vehicle", {
      p_asset_id: null,
      p_org_id: orgA,
      p_name: "Cross-org depot probe",
      p_registration: null,
      p_manufacturer: null,
      p_model: null,
      p_ownership: "owned",
      p_supplier_id: null,
      p_purchase_date: null,
      p_purchase_price: null,
      p_notes: null,
      p_vin: null,
      p_variant: null,
      p_year_of_manufacture: null,
      p_first_registered_on: null,
      p_fuel_type: null,
      p_vehicle_class: null,
      p_gross_weight_kg: null,
      p_mot_exempt: false,
      p_operational_status: "in_service",
      p_finance_type: "none",
      p_finance_provider_id: null,
      p_finance_agreement_ref: null,
      p_finance_monthly_payment: null,
      p_finance_end_date: null,
      p_home_depot: null,
      p_odometer_miles: null,
      p_created_by: dualUserId,
      p_home_site_id: siteB, // org B's yard — the forged reference
    });
    expect(error, "cross-org site should have been refused").not.toBeNull();
    expect(error?.code, `refusal must not be "function not found": ${error?.message}`).not.toBe(
      "PGRST202",
    );

    // The whole RPC is one transaction, so the ASSET half must not survive.
    const orphan = await svc().from("assets").select("id").eq("name", "Cross-org depot probe");
    expect(orphan.data ?? [], "a half-written vehicle would be an invisible orphan").toHaveLength(0);
  });

  // ── deactivate, never delete ──────────────────────────────────────────────
  it("a referenced site cannot be deleted — the guard says deactivate instead", async () => {
    const { error } = await svc().from("sites").delete().eq("id", siteA);
    expect(error, "the delete guard should have refused a referenced site").not.toBeNull();
    expect(error?.message ?? "").toMatch(/deactivate it instead/);

    const survivor = await svc().from("sites").select("id").eq("id", siteA);
    expect(survivor.data ?? []).toHaveLength(1);
  });

  it("deactivating is always allowed and changes nothing that points at it", async () => {
    const off = await svc().from("sites").update({ active: false }).eq("id", siteA);
    expect(off.error, off.error?.message).toBeNull();

    const veh = await svc().from("fleet_vehicles").select("home_site_id").eq("asset_id", assetA);
    expect(String(veh.data?.[0]?.home_site_id)).toBe(siteA);

    await svc().from("sites").update({ active: true }).eq("id", siteA);
  });

  it("an UNreferenced site deletes cleanly", async () => {
    const spare = await makeSite(orgA, "Spare lock-up", "lock_up");
    const { error } = await svc().from("sites").delete().eq("id", spare);
    expect(error, error?.message).toBeNull();
    const gone = await svc().from("sites").select("id").eq("id", spare);
    expect(gone.data ?? []).toHaveLength(0);
  });

  // ── teardown safety (the 20261052000000 lesson, re-proved) ────────────────
  it("deleting an ORG holding a REFERENCED site still succeeds, with no residue", async () => {
    // A BEFORE DELETE trigger on a cascade child is exactly how the activity_log
    // teardown P1 happened. Without the guard's org-existence escape, the
    // cascade below would find a live reference and abort the whole delete.
    const orgC = await makeOrg("Sites Probe C", `${TOKEN}-c`);
    const siteC = await makeSite(orgC, "Teardown yard", "depot");

    const assetC = await svc()
      .from("assets")
      .insert({ org_id: orgC, name: "Teardown tipper", category: "Vehicle" })
      .select("id")
      .single();
    expect(assetC.error, assetC.error?.message).toBeNull();
    const assetCId = String(assetC.data?.id ?? "");

    const veh = await svc()
      .from("fleet_vehicles")
      .insert({ asset_id: assetCId, org_id: orgC, home_site_id: siteC })
      .select("asset_id")
      .single();
    expect(veh.error, veh.error?.message).toBeNull();

    const custody = await svc()
      .from("asset_assignments")
      .insert({
        org_id: orgC,
        asset_id: assetCId,
        assignment_type: "stored_at_depot",
        site_id: siteC,
        status: "open",
      })
      .select("id")
      .single();
    expect(custody.error, custody.error?.message).toBeNull();

    const del = await svc().from("organizations").delete().eq("id", orgC);
    expect(del.error && del.error.message, JSON.stringify(del.error)).toBeNull();

    for (const [table, column] of [
      ["sites", "id"],
      ["fleet_vehicles", "org_id"],
      ["asset_assignments", "org_id"],
    ] as const) {
      const value = table === "sites" ? siteC : orgC;
      const rows = await svc().from(table).select("org_id").eq(column, value);
      expect(rows.data ?? [], `${table} still holds rows for the deleted org`).toHaveLength(0);
    }
  });

  it("leaves the other orgs untouched (the cascade is tenant-scoped)", async () => {
    const a = await svc().from("sites").select("id").eq("id", siteA);
    const b = await svc().from("sites").select("id").eq("id", siteB);
    expect(a.data ?? []).toHaveLength(1);
    expect(b.data ?? []).toHaveLength(1);
  });
});

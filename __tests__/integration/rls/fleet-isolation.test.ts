import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Fleet · tenant isolation and the DUAL-ORG active-org proof (20261056000000).
 *
 * The headline test in this file is the dual-org pair. A user who belongs to
 * BOTH org A and org B passes RLS for both, because `current_org_ids()` returns
 * every org they are a member of. So:
 *
 *   - an RLS-ONLY read returns BOTH orgs' vehicles — proving RLS alone cannot
 *     express "the org I am currently working in", which is exactly why every
 *     fleet query carries its own org predicate;
 *   - the SAME read with `.eq("org_id", A)` returns only A's;
 *   - the save RPC called with p_org_id = A and org B's vehicle id refuses.
 *
 * Plus the structural control: the composite FK to assets(id, org_id) makes a
 * cross-tenant vehicle row unwritable for EVERY role, service_role included.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  order(column: string, opts: { ascending: boolean }): Sel;
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
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const rpc = (client: unknown) =>
  client as unknown as {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<unknown>>;
  };

const TOKEN = `it-fleet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("fleet · tenant isolation + active-org pinning", () => {
  let orgA = "";
  let orgB = "";
  let assetA = "";
  let assetB = "";
  let dualUserId = "";
  let dualToken = "";
  let outsiderId = "";
  let outsiderToken = "";

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
    // No auth.users → public.users trigger in this schema, so mirror the row
    // ourselves (memberships.user_id FKs public.users).
    const mirrored = await db(serviceClient())
      .from("users")
      .insert({ id, email, full_name: `Fleet ${suffix}` })
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
    const org = await db(serviceClient())
      .from("organizations")
      .insert({ name, slug })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    return String(org.data?.id ?? "");
  }

  /** A vehicle = an asset + its 1:1 extension. Created the same way in both orgs. */
  async function makeVehicle(orgId: string, name: string, reg: string): Promise<string> {
    const svc = db(serviceClient());
    const asset = await svc
      .from("assets")
      .insert({ org_id: orgId, name, category: "Vehicle", registration: reg })
      .select("id")
      .single();
    expect(asset.error, asset.error?.message).toBeNull();
    const assetId = String(asset.data?.id ?? "");
    const veh = await svc
      .from("fleet_vehicles")
      .insert({
        asset_id: assetId,
        org_id: orgId,
        vehicle_class: "van",
        fuel_type: "diesel",
        operational_status: "in_service",
        odometer_miles: 42_000,
      })
      .select("asset_id")
      .single();
    expect(veh.error, veh.error?.message).toBeNull();
    return assetId;
  }

  beforeAll(async () => {
    orgA = await makeOrg("Fleet Probe A", `${TOKEN}-a`);
    orgB = await makeOrg("Fleet Probe B", `${TOKEN}-b`);
    if (!orgA || !orgB) throw new Error("failed to create probe orgs");

    // Deliberately SIMILAR vehicles in both orgs, so a leak is a real confusion
    // (two "Transit 350"s) rather than something a human would spot instantly.
    assetA = await makeVehicle(orgA, "Transit 350", "AA11AAA");
    assetB = await makeVehicle(orgB, "Transit 350", "BB11BBB");

    const dual = await makeUser("dual");
    dualUserId = dual.id;
    dualToken = dual.token;
    const outsider = await makeUser("outsider");
    outsiderId = outsider.id;
    outsiderToken = outsider.token;

    // THE dual-org membership: this user legitimately belongs to A and B.
    const svc = db(serviceClient());
    for (const org of [orgA, orgB]) {
      const m = await svc
        .from("memberships")
        .insert({ org_id: org, user_id: dualUserId, role: "admin" })
        .select("user_id")
        .single();
      expect(m.error, m.error?.message).toBeNull();
    }
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
    if (dualUserId) await serviceClient().auth.admin.deleteUser(dualUserId);
    if (outsiderId) await serviceClient().auth.admin.deleteUser(outsiderId);
  });

  // ── baseline RLS ──────────────────────────────────────────────────────────
  it("service_role reads the vehicle it created (RLS bypassed)", async () => {
    const { data, error } = await db(serviceClient())
      .from("fleet_vehicles")
      .select("asset_id")
      .eq("asset_id", assetA);
    expect(error, error?.message).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("anon is denied every fleet table", async () => {
    for (const table of ["fleet_vehicles", "asset_fuel_logs"]) {
      const { data, error } = await db(anonClient()).from(table).select("*");
      expect(error ? true : (data ?? []).length === 0, `${table} leaked to anon`).toBe(true);
    }
  });

  it("an authenticated NON-member sees no vehicles at all", async () => {
    const { data, error } = await db(userClient(outsiderToken))
      .from("fleet_vehicles")
      .select("asset_id");
    expect(error ? true : (data ?? []).length === 0).toBe(true);
  });

  // ── THE dual-org proof ────────────────────────────────────────────────────
  it("RLS ALONE returns BOTH orgs' vehicles to a dual-org member", async () => {
    // This is not a bug in RLS — it is what current_org_ids() means. It is
    // precisely why the app pins the active org on every query, and this
    // assertion is the evidence that the pin is load-bearing rather than
    // defensive decoration.
    const { data, error } = await db(userClient(dualToken))
      .from("fleet_vehicles")
      .select("asset_id");
    expect(error, error?.message).toBeNull();
    const ids = (data ?? []).map((r) => String(r.asset_id));
    expect(ids).toContain(assetA);
    expect(ids).toContain(assetB);
  });

  it("the SAME read pinned to the active org returns only that org's vehicle", async () => {
    const { data, error } = await db(userClient(dualToken))
      .from("fleet_vehicles")
      .select("asset_id")
      .eq("org_id", orgA);
    expect(error, error?.message).toBeNull();
    const ids = (data ?? []).map((r) => String(r.asset_id));
    expect(ids).toEqual([assetA]);
    expect(ids).not.toContain(assetB);
  });

  it("a by-id read pinned to org A cannot fetch org B's vehicle", async () => {
    const { data, error } = await db(userClient(dualToken))
      .from("fleet_vehicles")
      .select("asset_id")
      .eq("asset_id", assetB)
      .eq("org_id", orgA);
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(0); // → notFound() in the app
  });

  it("the save RPC refuses to mutate org B's vehicle while pinned to org A", async () => {
    const { error } = await rpc(userClient(dualToken)).rpc("save_fleet_vehicle", {
      p_asset_id: assetB,
      p_org_id: orgA, // the ACTIVE org — the pin
      p_name: "Hijacked",
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
    });
    expect(error, "cross-org update should have been refused").not.toBeNull();
    // A MISSING function also returns an error, which would make this assertion
    // pass for entirely the wrong reason. Pin that the refusal came from the
    // RPC's own org predicate, not from PostgREST failing to find it.
    expect(error?.code, `refusal must not be "function not found": ${error?.message}`).not.toBe(
      "PGRST202",
    );

    // And org B's vehicle is untouched.
    const { data } = await db(serviceClient())
      .from("assets")
      .select("name")
      .eq("id", assetB);
    expect(String(data?.[0]?.name)).toBe("Transit 350");
  });

  // ── the structural control ────────────────────────────────────────────────
  it("the composite FK blocks a cross-tenant vehicle row even for service_role", async () => {
    // org B's asset claimed under org A's id: no matching (id, org_id) row.
    const { error } = await db(serviceClient())
      .from("fleet_vehicles")
      .insert({ asset_id: assetB, org_id: orgA })
      .select("asset_id")
      .single();
    expect(error, "composite FK should have rejected the cross-tenant row").not.toBeNull();
  });

  it("the composite FK blocks a cross-tenant fuel log even for service_role", async () => {
    const { error } = await db(serviceClient())
      .from("asset_fuel_logs")
      .insert({ org_id: orgA, asset_id: assetB, filled_on: "2026-07-01", cost: 50 })
      .select("id")
      .single();
    expect(error, "composite FK should have rejected the cross-tenant fuel log").not.toBeNull();
  });

  it("one asset can hold at most one vehicle profile", async () => {
    const { error } = await db(serviceClient())
      .from("fleet_vehicles")
      .insert({ asset_id: assetA, org_id: orgA })
      .select("asset_id")
      .single();
    expect(error, "the 1:1 primary key should have rejected a second profile").not.toBeNull();
  });

  // ── custody comes free from the EXISTING engine ──────────────────────────
  it("a vehicle gets custody from asset_assignments with no fleet-specific code", async () => {
    const svc = db(serviceClient());
    const open = await svc
      .from("asset_assignments")
      .insert({
        org_id: orgA,
        asset_id: assetA,
        assignment_type: "issued_to_staff",
        assignee_id: dualUserId,
        status: "open",
      })
      .select("id")
      .single();
    expect(open.error, open.error?.message).toBeNull();

    // And the spine's one-open-assignment invariant still holds for vehicles.
    const second = await svc
      .from("asset_assignments")
      .insert({
        org_id: orgA,
        asset_id: assetA,
        assignment_type: "stored_at_depot",
        status: "open",
      })
      .select("id")
      .single();
    expect(second.error, "a second open custody row should be refused").not.toBeNull();
  });

  it("the atomic transfer RPC works for a vehicle — one custody engine, not two", async () => {
    const { data, error } = await rpc(serviceClient()).rpc("transfer_asset_assignment", {
      p_asset_id: assetA,
      p_org_id: orgA,
      p_assignment_type: "stored_at_depot",
      p_job_id: null,
      p_assignee_id: null,
      p_vehicle_asset_id: null,
      p_location: "Wakefield yard",
      p_issue_condition: "good",
      p_issue_notes: null,
      p_expected_return_at: null,
      p_assigned_by: dualUserId,
    });
    expect(error, error?.message).toBeNull();
    expect(data).toBeTruthy();

    const open = await db(serviceClient())
      .from("asset_assignments")
      .select("id, status")
      .eq("asset_id", assetA)
      .eq("status", "open");
    expect(open.data ?? []).toHaveLength(1);
  });

  // ── guards ────────────────────────────────────────────────────────────────
  it("a disposed asset cannot be put in service", async () => {
    const svc = db(serviceClient());
    const asset = await svc
      .from("assets")
      .insert({ org_id: orgA, name: "Written-off tipper", status: "written_off" })
      .select("id")
      .single();
    expect(asset.error, asset.error?.message).toBeNull();
    const { error } = await svc
      .from("fleet_vehicles")
      .insert({
        asset_id: String(asset.data?.id),
        org_id: orgA,
        operational_status: "in_service",
      })
      .select("asset_id")
      .single();
    expect(error, "an in-service profile on a written-off asset should be refused").not.toBeNull();

    // …but recording it as off road is fine.
    const ok = await svc
      .from("fleet_vehicles")
      .insert({
        asset_id: String(asset.data?.id),
        org_id: orgA,
        operational_status: "off_road",
      })
      .select("asset_id")
      .single();
    expect(ok.error, ok.error?.message).toBeNull();
  });

  it("finance detail without a finance type is refused by the coherence CHECK", async () => {
    const svc = db(serviceClient());
    const asset = await svc
      .from("assets")
      .insert({ org_id: orgA, name: "Coherence probe" })
      .select("id")
      .single();
    const { error } = await svc
      .from("fleet_vehicles")
      .insert({
        asset_id: String(asset.data?.id),
        org_id: orgA,
        finance_type: "none",
        finance_agreement_ref: "HP-1234",
      })
      .select("asset_id")
      .single();
    expect(error, "finance coherence CHECK should have refused").not.toBeNull();
  });

  it("a VIN with I, O or Q is refused at the database, not only in the form", async () => {
    const svc = db(serviceClient());
    const asset = await svc
      .from("assets")
      .insert({ org_id: orgA, name: "VIN probe" })
      .select("id")
      .single();
    const { error } = await svc
      .from("fleet_vehicles")
      .insert({ asset_id: String(asset.data?.id), org_id: orgA, vin: "WF0XXXTTGXKR1234O" })
      .select("asset_id")
      .single();
    expect(error, "the VIN CHECK should have refused an O").not.toBeNull();
  });

  it("deleting an ORG removes its vehicles and fuel logs with no orphans", async () => {
    // Teardown safety: the composite FK cascades from assets, which cascades
    // from organizations. 20261052000000's activity guard keeps the cascade
    // from aborting on the activity_log FK.
    const svc = db(serviceClient());
    const orgC = await makeOrg("Fleet Probe C", `${TOKEN}-c`);
    const assetC = await makeVehicle(orgC, "Teardown tipper", "CC11CCC");
    const fuel = await svc
      .from("asset_fuel_logs")
      .insert({ org_id: orgC, asset_id: assetC, filled_on: "2026-07-01", cost: 80, litres: 55 })
      .select("id")
      .single();
    expect(fuel.error, fuel.error?.message).toBeNull();

    const del = await svc.from("organizations").delete().eq("id", orgC);
    expect(del.error, del.error?.message).toBeNull();

    const veh = await svc.from("fleet_vehicles").select("asset_id").eq("asset_id", assetC);
    const logs = await svc.from("asset_fuel_logs").select("id").eq("asset_id", assetC);
    expect(veh.data ?? []).toHaveLength(0);
    expect(logs.data ?? []).toHaveLength(0);
  });
});

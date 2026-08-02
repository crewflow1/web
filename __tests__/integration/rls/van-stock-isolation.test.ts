import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * VAN / VEHICLE STOCK against real Postgres (migration 20261102000000, on top of
 * the operational-stock ledger 20261063–71).
 *
 * A van is a stock LOCATION — a `sites` row with kind = 'vehicle' and a
 * vehicle_asset_id back-link. The proofs here:
 *
 *   · ENABLE is idempotent and admin-curated — two taps make ONE location; a
 *     plain member cannot create one (the sites_insert admin gate, through the
 *     SECURITY INVOKER RPC);
 *   · LOADING a van is record_stock_transfer(depot -> van): it CONSERVES the
 *     company total, and REFUSES to load more than the depot holds;
 *   · RETURNING is the reverse transfer and conserves too;
 *   · the ACCOUNTING BOUNDARY holds — a full load/return cycle writes NOT ONE
 *     `finances` row;
 *   · CROSS-ORG — a van cannot be enabled for another company's vehicle, and the
 *     org-integrity guard refuses a crafted cross-tenant link even for
 *     service_role;
 *   · the write-path gate still covers a van site — a bare transfer_in direct to
 *     PostgREST is refused (no stock manufactured onto a van);
 *   · ONE location per vehicle (the unique index);
 *   · ORG TEARDOWN still succeeds with a van and its movements present.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Sel;
  eq(column: string, value: unknown): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  delete(): { eq(column: string, value: unknown): PromiseLike<Res<null>> };
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const rpc = (client: unknown) =>
  client as unknown as {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<unknown>>;
  };

const TOKEN = `it-vanstock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("van stock · location model, isolation, conservation", () => {
  let orgA = "";
  let orgB = "";
  let depotA = "";
  let itemA = "";
  let vehicleA = "";
  let vehicleB = "";
  let vanSiteA = "";
  let dualUserId = "";
  let dualToken = "";
  let memberUserId = "";
  let memberToken = "";
  let outsiderToken = "";

  const svc = () => db(serviceClient());

  const balance = async (org: string, item: string, site: string): Promise<number> => {
    const r = await rpc(serviceClient()).rpc("stock_balance", {
      p_org_id: org,
      p_item_id: item,
      p_site_id: site,
    });
    return Number(r.data ?? 0);
  };

  const companyTotal = async (org: string): Promise<number> => {
    const r = await svc().from("stock_movements").select("effect").eq("org_id", org);
    return (r.data ?? []).reduce((acc, m) => acc + Number(m.effect ?? 0), 0);
  };

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
      .insert({ id, email, full_name: `Van ${suffix}` })
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
    const org = await svc().from("organizations").insert({ name, slug }).select("id").single();
    expect(org.error, org.error?.message).toBeNull();
    return String(org.data?.id ?? "");
  }

  async function makeDepot(org: string, name: string): Promise<string> {
    const r = await svc()
      .from("sites")
      .insert({ org_id: org, name, kind: "depot" })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function makeItem(org: string, name: string): Promise<string> {
    const r = await svc()
      .from("stock_items")
      .insert({ org_id: org, name, unit: "ea" })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function makeVehicle(org: string, name: string, reg: string): Promise<string> {
    const asset = await svc()
      .from("assets")
      .insert({ org_id: org, name, category: "Vehicle", registration: reg })
      .select("id")
      .single();
    expect(asset.error, asset.error?.message).toBeNull();
    const assetId = String(asset.data?.id ?? "");
    const fv = await svc()
      .from("fleet_vehicles")
      .insert({ asset_id: assetId, org_id: org })
      .select("asset_id")
      .single();
    expect(fv.error, fv.error?.message).toBeNull();
    return assetId;
  }

  const seed = async (org: string, item: string, site: string, qty: number) => {
    const r = await rpc(serviceClient()).rpc("record_stock_adjustment", {
      p_org_id: org,
      p_item_id: item,
      p_site_id: site,
      p_delta: qty,
      p_reason: "opening count",
    });
    expect(r.error, r.error?.message).toBeNull();
  };

  beforeAll(async () => {
    orgA = await makeOrg("Van Probe A", `${TOKEN}-a`);
    orgB = await makeOrg("Van Probe B", `${TOKEN}-b`);
    depotA = await makeDepot(orgA, "Main yard");
    await makeDepot(orgB, "Main yard");
    itemA = await makeItem(orgA, "Fixings box");
    vehicleA = await makeVehicle(orgA, "Transit 350", "AA11AAA");
    vehicleB = await makeVehicle(orgB, "Sprinter", "BB11BBB");

    const dual = await makeUser("dual");
    dualUserId = dual.id;
    dualToken = dual.token;
    const member = await makeUser("member");
    memberUserId = member.id;
    memberToken = member.token;
    const outsider = await makeUser("outsider");
    outsiderToken = outsider.token;

    // Dual-org ADMIN of both — the strongest tenant role, so nothing passes
    // merely because the user was under-privileged.
    for (const org of [orgA, orgB]) {
      const m = await svc()
        .from("memberships")
        .insert({ org_id: org, user_id: dualUserId, role: "admin" })
        .select("user_id")
        .single();
      expect(m.error, m.error?.message).toBeNull();
    }
    // A plain member of org A — for the admin-only enable gate.
    const mm = await svc()
      .from("memberships")
      .insert({ org_id: orgA, user_id: memberUserId, role: "staff" })
      .select("user_id")
      .single();
    expect(mm.error, mm.error?.message).toBeNull();

    await seed(orgA, itemA, depotA, 100);
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) if (id) await svc().from("organizations").delete().eq("id", id);
    for (const email of ["dual", "member", "outsider"].map((s) => `${TOKEN}-${s}@example.test`)) {
      const r = await svc().from("users").select("id").eq("email", email).maybeSingle();
      const id = String(r.data?.id ?? "");
      if (id) await serviceClient().auth.admin.deleteUser(id);
    }
  });

  // ── baseline ───────────────────────────────────────────────────────────────
  it("anon cannot see vehicle stock locations", async () => {
    const { data, error } = await db(anonClient()).from("sites").select("*").eq("kind", "vehicle");
    expect(error ? true : (data ?? []).length === 0).toBe(true);
  });

  // ── enable ───────────────────────────────────────────────────────────────
  it("an admin enables a van; a second call is IDEMPOTENT (same site id)", async () => {
    const first = await rpc(userClient(dualToken)).rpc("ensure_vehicle_stock_location", {
      p_org_id: orgA,
      p_vehicle_asset_id: vehicleA,
      p_name: null,
    });
    expect(first.error, first.error?.message).toBeNull();
    vanSiteA = String(first.data);
    expect(vanSiteA).not.toBe("");

    const second = await rpc(userClient(dualToken)).rpc("ensure_vehicle_stock_location", {
      p_org_id: orgA,
      p_vehicle_asset_id: vehicleA,
      p_name: "Renamed on the second tap",
    });
    expect(second.error, second.error?.message).toBeNull();
    expect(second.data).toBe(vanSiteA);

    const site = await svc().from("sites").select("kind, vehicle_asset_id, org_id").eq("id", vanSiteA).maybeSingle();
    expect(site.data?.kind).toBe("vehicle");
    expect(site.data?.vehicle_asset_id).toBe(vehicleA);
    expect(site.data?.org_id).toBe(orgA);

    // exactly one vehicle location for this van
    const all = await svc().from("sites").select("id").eq("org_id", orgA).eq("vehicle_asset_id", vehicleA);
    expect(all.data ?? []).toHaveLength(1);
  });

  it("a plain MEMBER cannot enable a NEW van — the sites_insert admin gate holds", async () => {
    const vehicle2 = await makeVehicle(orgA, "Caddy", "AA22AAA");
    const denied = await rpc(userClient(memberToken)).rpc("ensure_vehicle_stock_location", {
      p_org_id: orgA,
      p_vehicle_asset_id: vehicle2,
      p_name: null,
    });
    expect(denied.error, "a member set up a van for stock").not.toBeNull();
    // no location was created
    const none = await svc().from("sites").select("id").eq("org_id", orgA).eq("vehicle_asset_id", vehicle2);
    expect(none.data ?? []).toHaveLength(0);
  });

  it("REFUSES to enable another company's vehicle, even for an admin of both", async () => {
    const cross = await rpc(userClient(dualToken)).rpc("ensure_vehicle_stock_location", {
      p_org_id: orgA, // working in A…
      p_vehicle_asset_id: vehicleB, // …but the vehicle is B's
      p_name: null,
    });
    expect(cross.error).not.toBeNull();
    expect(cross.error?.message ?? "").toMatch(/not found/i);
  });

  it("the org-integrity guard refuses a crafted cross-tenant link even for service_role", async () => {
    const forged = await svc()
      .from("sites")
      .insert({ org_id: orgA, name: `${TOKEN} forged van`, kind: "vehicle", vehicle_asset_id: vehicleB })
      .select("id")
      .single();
    expect(forged.error, "a cross-tenant vehicle link was written").not.toBeNull();
    expect(forged.error?.message ?? "").toMatch(/is not in org/i);
  });

  it("REFUSES a second stock location for the same vehicle (the unique index)", async () => {
    const dupe = await svc()
      .from("sites")
      .insert({ org_id: orgA, name: `${TOKEN} dupe van`, kind: "vehicle", vehicle_asset_id: vehicleA })
      .select("id")
      .single();
    expect(dupe.error?.code).toBe("23505");
  });

  // ── load / return ──────────────────────────────────────────────────────────
  it("LOADS a van from a depot — a transfer that conserves the company total", async () => {
    const before = await companyTotal(orgA);
    const depotBefore = await balance(orgA, itemA, depotA);

    const loaded = await rpc(userClient(dualToken)).rpc("record_stock_transfer", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_from_site_id: depotA,
      p_to_site_id: vanSiteA,
      p_qty: 12,
      p_notes: "load out for the week",
    });
    expect(loaded.error, loaded.error?.message).toBeNull();

    expect(await balance(orgA, itemA, vanSiteA)).toBe(12);
    expect(await balance(orgA, itemA, depotA)).toBe(depotBefore - 12);
    expect(await companyTotal(orgA), "loading a van created or lost stock").toBe(before);
  });

  it("REFUSES to load more than the depot holds", async () => {
    const depot = await balance(orgA, itemA, depotA);
    const over = await rpc(userClient(dualToken)).rpc("record_stock_transfer", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_from_site_id: depotA,
      p_to_site_id: vanSiteA,
      p_qty: depot + 1,
      p_notes: null,
    });
    expect(over.error).not.toBeNull();
    expect(over.error?.message ?? "").toMatch(/not enough/i);
    expect(await balance(orgA, itemA, depotA)).toBe(depot);
  });

  it("RETURNS stock from the van to the depot — the reverse transfer, conserving", async () => {
    const before = await companyTotal(orgA);
    const returned = await rpc(userClient(dualToken)).rpc("record_stock_transfer", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_from_site_id: vanSiteA,
      p_to_site_id: depotA,
      p_qty: 5,
      p_notes: "unused, back to the yard",
    });
    expect(returned.error, returned.error?.message).toBeNull();
    expect(await balance(orgA, itemA, vanSiteA)).toBe(7);
    expect(await companyTotal(orgA)).toBe(before);
  });

  it("REFUSES to return more than is on the van", async () => {
    const onVan = await balance(orgA, itemA, vanSiteA);
    const over = await rpc(userClient(dualToken)).rpc("record_stock_transfer", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_from_site_id: vanSiteA,
      p_to_site_id: depotA,
      p_qty: onVan + 1,
      p_notes: null,
    });
    expect(over.error?.message ?? "").toMatch(/not enough/i);
    expect(await balance(orgA, itemA, vanSiteA)).toBe(onVan);
  });

  // ── the accounting boundary ─────────────────────────────────────────────────
  it("a full load + return cycle writes NOT ONE `finances` row", async () => {
    const before = await svc().from("finances").select("id").eq("org_id", orgA);
    const beforeCount = (before.data ?? []).length;

    await rpc(userClient(dualToken)).rpc("record_stock_transfer", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_from_site_id: depotA,
      p_to_site_id: vanSiteA,
      p_qty: 3,
      p_notes: null,
    });
    await rpc(userClient(dualToken)).rpc("record_stock_transfer", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_from_site_id: vanSiteA,
      p_to_site_id: depotA,
      p_qty: 3,
      p_notes: null,
    });

    const after = await svc().from("finances").select("id").eq("org_id", orgA);
    expect((after.data ?? []).length, "van stock posted a cost").toBe(beforeCount);
  });

  // ── the write-path gate covers a van site too ───────────────────────────────
  it("REFUSES a bare transfer_in DIRECT to a van site — no stock manufactured onto a van", async () => {
    const before = await companyTotal(orgA);
    const direct = await db(userClient(memberToken)).from("stock_movements").insert({
      org_id: orgA,
      stock_item_id: itemA,
      site_id: vanSiteA,
      movement_type: "transfer_in",
      qty: 500,
    });
    expect(direct.error, "a member manufactured stock onto a van by direct insert").not.toBeNull();
    expect(direct.error?.code).toBe("42501");
    expect(await companyTotal(orgA)).toBe(before);
  });

  // ── isolation of the balance ────────────────────────────────────────────────
  it("a member can LOAD a van (an ordinary transfer), but not enable one", async () => {
    const ok = await rpc(userClient(memberToken)).rpc("record_stock_transfer", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_from_site_id: depotA,
      p_to_site_id: vanSiteA,
      p_qty: 1,
      p_notes: null,
    });
    expect(ok.error, ok.error?.message).toBeNull();
  });

  it("an outsider cannot read the van's balance", async () => {
    const outsider = await db(userClient(outsiderToken)).from("stock_balances").select("org_id").eq("org_id", orgA);
    expect(outsider.data ?? []).toHaveLength(0);
  });

  // ── teardown ────────────────────────────────────────────────────────────────
  it("ORG TEARDOWN still succeeds with a van location and its movements present", async () => {
    const doomed = await makeOrg("Van Teardown", `${TOKEN}-teardown`);
    const depot = await makeDepot(doomed, "Yard");
    const item = await makeItem(doomed, "Sand");
    const vehicle = await makeVehicle(doomed, "Tipper", "TD11TDD");
    const van = await rpc(serviceClient()).rpc("ensure_vehicle_stock_location", {
      p_org_id: doomed,
      p_vehicle_asset_id: vehicle,
      p_name: null,
    });
    expect(van.error, van.error?.message).toBeNull();
    await seed(doomed, item, depot, 20);
    const moved = await rpc(serviceClient()).rpc("record_stock_transfer", {
      p_org_id: doomed,
      p_item_id: item,
      p_from_site_id: depot,
      p_to_site_id: String(van.data),
      p_qty: 8,
      p_notes: null,
    });
    expect(moved.error, moved.error?.message).toBeNull();

    const del = await svc().from("organizations").delete().eq("id", doomed);
    expect(del.error, del.error?.message).toBeNull();

    for (const [t, idCol] of [
      ["stock_movements", "id"],
      ["sites", "id"],
      ["fleet_vehicles", "asset_id"],
    ] as const) {
      const left = await svc().from(t).select(idCol).eq("org_id", doomed);
      expect(left.data ?? [], `${t} rows survived teardown`).toHaveLength(0);
    }
  });
});

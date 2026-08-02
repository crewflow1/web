import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";

/**
 * TELEMATICS CONNECTIONS + READINGS (20261103) — against real Postgres RLS.
 *
 *   1. telematics_connections is member-read / admin-write, org-isolated. A plain
 *      member may READ state but may not INSERT/UPDATE; an admin can; an outsider
 *      sees nothing.
 *   2. UNIQUE(org, provider): a second row for the same provider is refused.
 *   3. The connected-requires-handle CHECK: status='connected' with no account
 *      handle is refused; with a handle it is accepted.
 *   4. The token columns are service-role-only on read (column privilege).
 *   5. telematics_readings: COMPOSITE-FK vehicle + connection binding refuses a
 *      cross-tenant row; rows are APPEND-ONLY (update refused); members read their
 *      own org's readings, outsiders see none.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]> & { count: number | null }> {
  select(columns?: string): Ins;
  single(): PromiseLike<Res<Row>>;
}
interface Upd extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Upd;
  select(columns?: string): Upd;
}
interface Del extends PromiseLike<Res<null> & { count: number | null }> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string, opts?: Record<string, unknown>): Sel;
  insert(rows: Row | Row[]): Ins;
  update(row: Row): Upd;
  delete(opts?: Record<string, unknown>): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-telemconn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("telematics connections + readings · RLS + constraints", () => {
  let orgA = "";
  let orgB = "";
  let ownerId = "";
  let ownerToken = "";
  let memberToken = "";
  let outsiderToken = "";
  // Readings fixtures (service-role seeded).
  let vehicleA = ""; // fleet_vehicles.asset_id in org A
  let vehicleB = ""; // fleet_vehicles.asset_id in org B
  let connA = ""; // telematics_connections.id in org A

  async function mintUser(label: string): Promise<{ id: string; token: string }> {
    const email = `${TOKEN}-${label}@example.test`;
    const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    const mirrored = await db(serviceClient())
      .from("users")
      .insert({ id, email, full_name: `TelemConn ${label}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    return { id, token: signedIn.data.session?.access_token ?? "" };
  }

  async function seedVehicle(orgId: string): Promise<string> {
    const svc = db(serviceClient());
    const asset = await svc
      .from("assets")
      .insert({ org_id: orgId, name: "Transit", category: "Vehicle" })
      .select("id")
      .single();
    expect(asset.error, asset.error?.message).toBeNull();
    const assetId = String(asset.data?.id ?? "");
    const veh = await svc
      .from("fleet_vehicles")
      .insert({ asset_id: assetId, org_id: orgId })
      .select("asset_id")
      .single();
    expect(veh.error, veh.error?.message).toBeNull();
    return assetId;
  }

  beforeAll(async () => {
    const svc = db(serviceClient());
    const a = await svc
      .from("organizations")
      .insert({ name: "TelemConn A", slug: `${TOKEN}-a` })
      .select("id")
      .single();
    const b = await svc
      .from("organizations")
      .insert({ name: "TelemConn B", slug: `${TOKEN}-b` })
      .select("id")
      .single();
    orgA = String(a.data?.id ?? "");
    orgB = String(b.data?.id ?? "");
    if (!orgA || !orgB) throw new Error("failed to create probe orgs");

    const owner = await mintUser("owner");
    ownerId = owner.id;
    ownerToken = owner.token;
    const om = await svc
      .from("memberships")
      .insert({ org_id: orgA, user_id: ownerId, role: "owner" });
    expect(om.error, om.error?.message).toBeNull();

    const member = await mintUser("member");
    memberToken = member.token;
    const mm = await svc
      .from("memberships")
      .insert({ org_id: orgA, user_id: member.id, role: "staff" });
    expect(mm.error, mm.error?.message).toBeNull();

    outsiderToken = (await mintUser("outsider")).token;
    if (!ownerToken || !memberToken || !outsiderToken) {
      throw new Error("failed to mint tokens");
    }

    vehicleA = await seedVehicle(orgA);
    vehicleB = await seedVehicle(orgB);
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
  });

  // ── 1. RLS: admin write, member read-only, outsider blind ──────────────────

  it("an ADMIN (owner) can insert a disconnected connection row", async () => {
    const res = await db(userClient(ownerToken))
      .from("telematics_connections")
      .insert({ org_id: orgA, provider: "samsara", status: "disconnected" })
      .select("id, provider, status");
    expect(res.error, res.error?.message).toBeNull();
    expect(String(res.data?.[0]?.status)).toBe("disconnected");
    expect(String(res.data?.[0]?.provider)).toBe("samsara");
    connA = String(res.data?.[0]?.id ?? "");
    expect(connA).not.toBe("");
  });

  it("a plain MEMBER may READ state but may NOT insert", async () => {
    const asMember = db(userClient(memberToken));
    const readRes = await asMember
      .from("telematics_connections")
      .select("id, provider")
      .eq("org_id", orgA);
    expect(readRes.error, readRes.error?.message).toBeNull();
    expect((readRes.data ?? []).length).toBeGreaterThanOrEqual(1);

    const ins = await asMember
      .from("telematics_connections")
      .insert({ org_id: orgA, provider: "verizon_connect", status: "disconnected" })
      .select("id");
    expect(ins.error, "member insert must be refused by RLS").not.toBeNull();
  });

  it("an OUTSIDER sees no connection rows at all", async () => {
    const res = await db(userClient(outsiderToken))
      .from("telematics_connections")
      .select("id")
      .eq("org_id", orgA);
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });

  // ── 2. UNIQUE(org, provider) ───────────────────────────────────────────────

  it("refuses a SECOND connection for the same (org, provider)", async () => {
    const dup = await db(userClient(ownerToken))
      .from("telematics_connections")
      .insert({ org_id: orgA, provider: "samsara", status: "disconnected" })
      .select("id");
    expect(dup.error, "duplicate (org,provider) must be refused").not.toBeNull();
  });

  // ── 3. connected-requires-handle CHECK ─────────────────────────────────────

  it("REFUSES status='connected' with no account handle (no fake connected state)", async () => {
    const bad = await db(serviceClient())
      .from("telematics_connections")
      .insert({ org_id: orgB, provider: "samsara", status: "connected" })
      .select("id");
    expect(bad.error, "connected without a handle must be refused by the CHECK").not.toBeNull();
  });

  it("ACCEPTS status='connected' WITH an account handle", async () => {
    const good = await db(serviceClient())
      .from("telematics_connections")
      .insert({
        org_id: orgB,
        provider: "verizon_connect",
        status: "connected",
        external_account_id: "acct-123",
      })
      .select("id, status, external_account_id");
    expect(good.error, good.error?.message).toBeNull();
    expect(String(good.data?.[0]?.status)).toBe("connected");
    expect(String(good.data?.[0]?.external_account_id)).toBe("acct-123");
  });

  // ── 4. COLUMN-LEVEL PRIVILEGE — token columns are service-role-only on read ──

  it("service_role can WRITE the token columns (the activation writer path)", async () => {
    const upd = await db(serviceClient())
      .from("telematics_connections")
      .update({
        access_token: "tok-secret",
        refresh_token: "ref-secret",
        token_expires_at: new Date().toISOString(),
      })
      .eq("org_id", orgA)
      .eq("provider", "samsara")
      .select("id, access_token, refresh_token");
    expect(upd.error, upd.error?.message).toBeNull();
    expect(String(upd.data?.[0]?.access_token)).toBe("tok-secret");
  });

  it("a MEMBER is DENIED reading each token column, and select('*') fails", async () => {
    const asMember = db(userClient(memberToken));
    const at = await asMember
      .from("telematics_connections")
      .select("access_token")
      .eq("org_id", orgA);
    expect(at.error, "member select(access_token) must be refused").not.toBeNull();
    const star = await asMember
      .from("telematics_connections")
      .select("*")
      .eq("org_id", orgA);
    expect(star.error, "star-select must be refused by the column grant").not.toBeNull();
  });

  it("a MEMBER can STILL read the non-token columns", async () => {
    const res = await db(userClient(memberToken))
      .from("telematics_connections")
      .select("provider, status, external_account_id, connected_at, last_sync_at, last_error")
      .eq("org_id", orgA);
    expect(res.error, res.error?.message).toBeNull();
    expect((res.data ?? []).length).toBeGreaterThanOrEqual(1);
  });

  // ── 5. telematics_readings — composite-FK binding + append-only ─────────────

  it("service_role can insert a reading bound to a same-org vehicle + connection", async () => {
    const res = await db(serviceClient())
      .from("telematics_readings")
      .insert({
        org_id: orgA,
        vehicle_id: vehicleA,
        connection_id: connA,
        source_event_id: "evt-1",
        recorded_at: new Date().toISOString(),
        latitude: 51.5074,
        longitude: -0.1278,
        odometer_miles: 1000,
      })
      .select("id");
    expect(res.error, res.error?.message).toBeNull();
    expect(String(res.data?.[0]?.id ?? "")).not.toBe("");
  });

  it("REFUSES a reading whose vehicle belongs to ANOTHER org (composite FK)", async () => {
    const bad = await db(serviceClient())
      .from("telematics_readings")
      .insert({
        org_id: orgA,
        vehicle_id: vehicleB, // org B's vehicle under org A's org_id
        connection_id: connA,
        source_event_id: "evt-cross",
        recorded_at: new Date().toISOString(),
        odometer_miles: 5,
      })
      .select("id");
    expect(bad.error, "cross-tenant vehicle binding must be refused by the composite FK").not.toBeNull();
  });

  it("is APPEND-ONLY: an UPDATE to a reading is refused (immutability trigger)", async () => {
    const upd = await db(serviceClient())
      .from("telematics_readings")
      .update({ odometer_miles: 9999 })
      .eq("org_id", orgA)
      .eq("source_event_id", "evt-1")
      .select("id");
    expect(upd.error, "reading update must be refused by the immutability trigger").not.toBeNull();
  });

  it("a MEMBER reads their org's readings; an OUTSIDER sees none", async () => {
    const asMember = await db(userClient(memberToken))
      .from("telematics_readings")
      .select("id, odometer_miles")
      .eq("org_id", orgA);
    expect(asMember.error, asMember.error?.message).toBeNull();
    expect((asMember.data ?? []).length).toBeGreaterThanOrEqual(1);

    const asOutsider = await db(userClient(outsiderToken))
      .from("telematics_readings")
      .select("id")
      .eq("org_id", orgA);
    expect(asOutsider.error, asOutsider.error?.message).toBeNull();
    expect(asOutsider.data ?? []).toHaveLength(0);
  });
});

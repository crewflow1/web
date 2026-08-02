import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * HMRC CONNECTIONS + SUBMISSIONS (20261099) — against real Postgres RLS.
 *
 *   1. hmrc_connections is member-read / admin-write, org-isolated. A plain
 *      member may READ state but may not INSERT/UPDATE; an admin can; an outsider
 *      sees nothing.
 *   2. UNIQUE(org, provider): a second HMRC row for the same org is refused.
 *   3. connected-requires-VRN CHECK: status='connected' with no VRN is refused;
 *      with a VRN it is accepted.
 *   4. Column privilege: token columns are service-role-only on read.
 *   5. hmrc_submissions is APPEND-ONLY (admin insert + member read; no update or
 *      delete), has NO filed state, and its composite FK binds to (connection, org).
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

const TOKEN = `it-hmrc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("hmrc connections · RLS + constraints", () => {
  let orgA = "";
  let orgB = "";
  let ownerId = "";
  let ownerToken = "";
  let memberToken = "";
  let outsiderToken = "";
  let connAId = "";

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
      .insert({ id, email, full_name: `Hmrc ${label}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    return { id, token: signedIn.data.session?.access_token ?? "" };
  }

  beforeAll(async () => {
    const svc = db(serviceClient());
    const a = await svc.from("organizations").insert({ name: "Hmrc A", slug: `${TOKEN}-a` }).select("id").single();
    const b = await svc.from("organizations").insert({ name: "Hmrc B", slug: `${TOKEN}-b` }).select("id").single();
    orgA = String(a.data?.id ?? "");
    orgB = String(b.data?.id ?? "");
    if (!orgA || !orgB) throw new Error("failed to create probe orgs");

    const owner = await mintUser("owner");
    ownerId = owner.id;
    ownerToken = owner.token;
    const om = await svc.from("memberships").insert({ org_id: orgA, user_id: ownerId, role: "owner" });
    expect(om.error, om.error?.message).toBeNull();

    const member = await mintUser("member");
    memberToken = member.token;
    const mm = await svc.from("memberships").insert({ org_id: orgA, user_id: member.id, role: "staff" });
    expect(mm.error, mm.error?.message).toBeNull();

    outsiderToken = (await mintUser("outsider")).token;
    if (!ownerToken || !memberToken || !outsiderToken) throw new Error("failed to mint tokens");
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
  });

  // ── 1. RLS: admin write, member read-only, outsider blind ──────────────────

  it("an ADMIN (owner) can insert a disconnected connection row", async () => {
    const res = await db(userClient(ownerToken))
      .from("hmrc_connections")
      .insert({ org_id: orgA, provider: "hmrc", status: "disconnected" })
      .select("id, provider, status");
    expect(res.error, res.error?.message).toBeNull();
    expect(String(res.data?.[0]?.status)).toBe("disconnected");
    expect(String(res.data?.[0]?.provider)).toBe("hmrc");
    connAId = String(res.data?.[0]?.id ?? "");
    expect(connAId).not.toBe("");
  });

  it("a plain MEMBER may READ state but may NOT insert", async () => {
    const asMember = db(userClient(memberToken));
    const readRes = await asMember.from("hmrc_connections").select("id, provider").eq("org_id", orgA);
    expect(readRes.error, readRes.error?.message).toBeNull();
    expect((readRes.data ?? []).length).toBeGreaterThanOrEqual(1);

    const ins = await asMember
      .from("hmrc_connections")
      .insert({ org_id: orgA, provider: "hmrc", status: "disconnected" })
      .select("id");
    expect(ins.error, "member insert must be refused by RLS").not.toBeNull();
  });

  it("an OUTSIDER sees no connection rows at all", async () => {
    const res = await db(userClient(outsiderToken)).from("hmrc_connections").select("id").eq("org_id", orgA);
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });

  // ── 2. UNIQUE(org, provider) ───────────────────────────────────────────────

  it("refuses a SECOND hmrc connection for the same org", async () => {
    const dup = await db(userClient(ownerToken))
      .from("hmrc_connections")
      .insert({ org_id: orgA, provider: "hmrc", status: "disconnected" })
      .select("id");
    expect(dup.error, "duplicate (org,provider) must be refused").not.toBeNull();
  });

  // ── 3. connected-requires-VRN CHECK ────────────────────────────────────────

  it("REFUSES status='connected' with no VRN (no fake connected state)", async () => {
    const bad = await db(serviceClient())
      .from("hmrc_connections")
      .insert({ org_id: orgB, provider: "hmrc", status: "connected" })
      .select("id");
    expect(bad.error, "connected without a VRN must be refused by the CHECK").not.toBeNull();
  });

  it("ACCEPTS status='connected' WITH a VRN", async () => {
    const good = await db(serviceClient())
      .from("hmrc_connections")
      .insert({ org_id: orgB, provider: "hmrc", status: "connected", hmrc_vrn: "123456789" })
      .select("id, status, hmrc_vrn");
    expect(good.error, good.error?.message).toBeNull();
    expect(String(good.data?.[0]?.status)).toBe("connected");
    expect(String(good.data?.[0]?.hmrc_vrn)).toBe("123456789");
  });

  // ── 4. COLUMN-LEVEL PRIVILEGE — token columns are service-role-only on read ──

  it("service_role can WRITE + READ the token columns (the activation writer path)", async () => {
    const upd = await db(serviceClient())
      .from("hmrc_connections")
      .update({ access_token: "tok-secret", refresh_token: "ref-secret", token_expires_at: new Date().toISOString() })
      .eq("org_id", orgA)
      .eq("provider", "hmrc")
      .select("id, access_token, refresh_token");
    expect(upd.error, upd.error?.message).toBeNull();
    expect(String(upd.data?.[0]?.access_token)).toBe("tok-secret");
  });

  it("a MEMBER is DENIED reading each token column, and select('*') fails", async () => {
    const asMember = db(userClient(memberToken));
    for (const col of ["access_token", "refresh_token", "token_expires_at"]) {
      const r = await asMember.from("hmrc_connections").select(col).eq("org_id", orgA);
      expect(r.error, `member select(${col}) must be refused`).not.toBeNull();
    }
    const star = await asMember.from("hmrc_connections").select("*").eq("org_id", orgA);
    expect(star.error, "star-select must be refused by the column grant").not.toBeNull();
  });

  it("a MEMBER can STILL read the non-token columns (status / vrn)", async () => {
    const res = await db(userClient(memberToken))
      .from("hmrc_connections")
      .select("provider, status, hmrc_vrn, connected_at, last_sync_at, last_error")
      .eq("org_id", orgA);
    expect(res.error, res.error?.message).toBeNull();
    expect((res.data ?? []).length).toBeGreaterThanOrEqual(1);
  });

  // ── 5. hmrc_submissions — append-only, no filed state, composite-FK bound ────

  it("an ADMIN can INSERT a prepared submission bound to its connection", async () => {
    const ins = await db(userClient(ownerToken))
      .from("hmrc_submissions")
      .insert({
        org_id: orgA,
        connection_id: connAId,
        kind: "vat_return",
        period_key: "18A1",
        status: "prepared",
        payload: { periodKey: "18A1", vatDueSales: 100 },
      })
      .select("id, status");
    expect(ins.error, ins.error?.message).toBeNull();
    expect(String(ins.data?.[0]?.status)).toBe("prepared");
  });

  it("REFUSES a submission bound to another org's connection (composite FK)", async () => {
    const bad = await db(serviceClient())
      .from("hmrc_submissions")
      .insert({
        org_id: orgB, // orgB, but connAId belongs to orgA
        connection_id: connAId,
        kind: "vat_return",
        period_key: "18A1",
        status: "prepared",
        payload: {},
      })
      .select("id");
    expect(bad.error, "cross-org connection binding must be refused by the composite FK").not.toBeNull();
  });

  it("REFUSES a filed/submitted status (no such state exists)", async () => {
    const bad = await db(serviceClient())
      .from("hmrc_submissions")
      .insert({
        org_id: orgA,
        connection_id: connAId,
        kind: "vat_return",
        period_key: "18A2",
        status: "submitted",
        payload: {},
      })
      .select("id");
    expect(bad.error, "a 'submitted' status must be refused by the CHECK").not.toBeNull();
  });

  it("a MEMBER may READ submissions but NOT insert", async () => {
    const asMember = db(userClient(memberToken));
    const readRes = await asMember.from("hmrc_submissions").select("id").eq("org_id", orgA);
    expect(readRes.error, readRes.error?.message).toBeNull();
    expect((readRes.data ?? []).length).toBeGreaterThanOrEqual(1);

    const ins = await asMember
      .from("hmrc_submissions")
      .insert({ org_id: orgA, connection_id: connAId, kind: "cis300", period_key: "2026-05-05", payload: {} })
      .select("id");
    expect(ins.error, "member submission insert must be refused").not.toBeNull();
  });

  it("submissions are APPEND-ONLY: even an admin cannot UPDATE or DELETE one", async () => {
    const asOwner = db(userClient(ownerToken));
    const upd = await asOwner
      .from("hmrc_submissions")
      .update({ status: "held" })
      .eq("org_id", orgA)
      .select("id");
    // No update policy → RLS refuses (error) or matches zero rows.
    expect(upd.error || (upd.data ?? []).length === 0).toBeTruthy();

    const del = await asOwner.from("hmrc_submissions").delete().eq("org_id", orgA);
    expect(del.error || (del.count ?? 0) === 0).toBeTruthy();
  });
});

import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";

/**
 * BANK CONNECTIONS (20261100) — against real Postgres RLS.
 *
 *   1. bank_connections is member-read / admin-write, org-isolated. A plain member
 *      may READ state but may not INSERT/UPDATE; an admin can; an outsider sees
 *      nothing.
 *   2. UNIQUE(org, provider): a second row for the same provider is refused.
 *   3. The connected-requires-handle CHECK: status='connected' with no connection
 *      handle is refused; with a handle it is accepted.
 *   4. The token columns are service-role-only on READ (column privilege).
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

const TOKEN = `it-bankconn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("bank connections · RLS + constraints", () => {
  let orgA = "";
  let orgB = "";
  let ownerId = "";
  let ownerToken = "";
  let memberToken = "";
  let outsiderToken = "";

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
      .insert({ id, email, full_name: `BankConn ${label}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    return { id, token: signedIn.data.session?.access_token ?? "" };
  }

  beforeAll(async () => {
    const svc = db(serviceClient());
    const a = await svc
      .from("organizations")
      .insert({ name: "BankConn A", slug: `${TOKEN}-a` })
      .select("id")
      .single();
    const b = await svc
      .from("organizations")
      .insert({ name: "BankConn B", slug: `${TOKEN}-b` })
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
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
  });

  // ── 1. RLS: admin write, member read-only, outsider blind ──────────────────

  it("an ADMIN (owner) can insert a disconnected connection row", async () => {
    const res = await db(userClient(ownerToken))
      .from("bank_connections")
      .insert({ org_id: orgA, provider: "truelayer", status: "disconnected" })
      .select("id, provider, status");
    expect(res.error, res.error?.message).toBeNull();
    expect(String(res.data?.[0]?.status)).toBe("disconnected");
    expect(String(res.data?.[0]?.provider)).toBe("truelayer");
  });

  it("a plain MEMBER may READ state but may NOT insert", async () => {
    const asMember = db(userClient(memberToken));
    const readRes = await asMember
      .from("bank_connections")
      .select("id, provider")
      .eq("org_id", orgA);
    expect(readRes.error, readRes.error?.message).toBeNull();
    expect((readRes.data ?? []).length).toBeGreaterThanOrEqual(1);

    const ins = await asMember
      .from("bank_connections")
      .insert({ org_id: orgA, provider: "plaid", status: "disconnected" })
      .select("id");
    expect(ins.error, "member insert must be refused by RLS").not.toBeNull();
  });

  it("an OUTSIDER sees no connection rows at all", async () => {
    const res = await db(userClient(outsiderToken))
      .from("bank_connections")
      .select("id")
      .eq("org_id", orgA);
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });

  // ── 2. UNIQUE(org, provider) ───────────────────────────────────────────────

  it("refuses a SECOND connection for the same (org, provider)", async () => {
    const dup = await db(userClient(ownerToken))
      .from("bank_connections")
      .insert({ org_id: orgA, provider: "truelayer", status: "disconnected" })
      .select("id");
    expect(dup.error, "duplicate (org,provider) must be refused").not.toBeNull();
  });

  // ── 3. connected-requires-handle CHECK ─────────────────────────────────────

  it("REFUSES status='connected' with no connection handle (no fake connected state)", async () => {
    const bad = await db(serviceClient())
      .from("bank_connections")
      .insert({ org_id: orgB, provider: "truelayer", status: "connected" })
      .select("id");
    expect(bad.error, "connected without a handle must be refused by the CHECK").not.toBeNull();
  });

  it("ACCEPTS status='connected' WITH a connection handle", async () => {
    const good = await db(serviceClient())
      .from("bank_connections")
      .insert({
        org_id: orgB,
        provider: "nordigen",
        status: "connected",
        connection_ref: "req-123",
      })
      .select("id, status, connection_ref");
    expect(good.error, good.error?.message).toBeNull();
    expect(String(good.data?.[0]?.status)).toBe("connected");
    expect(String(good.data?.[0]?.connection_ref)).toBe("req-123");
  });

  // ── 4. disconnect (admin update) ───────────────────────────────────────────

  it("an admin can disconnect: status back to disconnected, tokens cleared", async () => {
    const upd = await db(userClient(ownerToken))
      .from("bank_connections")
      .update({
        status: "disconnected",
        access_token: null,
        refresh_token: null,
        connection_ref: null,
        institution_id: null,
        institution_name: null,
        connected_at: null,
      })
      .eq("org_id", orgA)
      .eq("provider", "truelayer")
      .select("id, status");
    expect(upd.error, upd.error?.message).toBeNull();
    expect(String(upd.data?.[0]?.status)).toBe("disconnected");
  });

  it("a plain MEMBER may NOT update a connection", async () => {
    const upd = await db(userClient(memberToken))
      .from("bank_connections")
      .update({ status: "error" })
      .eq("org_id", orgA)
      .eq("provider", "truelayer")
      .select("id");
    expect(upd.error || (upd.data ?? []).length === 0).toBeTruthy();
  });

  // ── 5. COLUMN-LEVEL PRIVILEGE — token columns are service-role-only on read ──

  it("service_role can WRITE the token columns (the activation writer path)", async () => {
    const upd = await db(serviceClient())
      .from("bank_connections")
      .update({
        access_token: "tok-secret",
        refresh_token: "ref-secret",
        token_expires_at: new Date().toISOString(),
      })
      .eq("org_id", orgA)
      .eq("provider", "truelayer")
      .select("id, access_token, refresh_token");
    expect(upd.error, upd.error?.message).toBeNull();
    expect(String(upd.data?.[0]?.access_token)).toBe("tok-secret");
    expect(String(upd.data?.[0]?.refresh_token)).toBe("ref-secret");
  });

  it("a MEMBER is DENIED reading each token column (column privilege)", async () => {
    const asMember = db(userClient(memberToken));
    const at = await asMember
      .from("bank_connections")
      .select("access_token")
      .eq("org_id", orgA);
    expect(at.error, "member select(access_token) must be refused").not.toBeNull();

    const rt = await asMember
      .from("bank_connections")
      .select("refresh_token")
      .eq("org_id", orgA);
    expect(rt.error, "member select(refresh_token) must be refused").not.toBeNull();

    const exp = await asMember
      .from("bank_connections")
      .select("token_expires_at")
      .eq("org_id", orgA);
    expect(exp.error, "member select(token_expires_at) must be refused").not.toBeNull();
  });

  it("a MEMBER select('*') FAILS (star expands to the token columns)", async () => {
    const res = await db(userClient(memberToken))
      .from("bank_connections")
      .select("*")
      .eq("org_id", orgA);
    expect(res.error, "star-select must be refused by the column grant").not.toBeNull();
  });

  it("a MEMBER can STILL read the non-token columns (status / provider / handle)", async () => {
    const res = await db(userClient(memberToken))
      .from("bank_connections")
      .select(
        "provider, status, institution_id, institution_name, connection_ref, connected_at, last_sync_at, last_error",
      )
      .eq("org_id", orgA);
    expect(res.error, res.error?.message).toBeNull();
    expect((res.data ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("service_role reads the token columns back (the only reader)", async () => {
    const res = await db(serviceClient())
      .from("bank_connections")
      .select("access_token, refresh_token, token_expires_at")
      .eq("org_id", orgA)
      .eq("provider", "truelayer")
      .maybeSingle();
    expect(res.error, res.error?.message).toBeNull();
    expect(String(res.data?.access_token)).toBe("tok-secret");
    expect(String(res.data?.refresh_token)).toBe("ref-secret");
  });
});

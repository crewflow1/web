import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";

/**
 * CALENDAR CONNECTIONS (20261097) — against real Postgres RLS.
 *
 *   1. calendar_connections is member-read / admin-write, org-isolated. A plain
 *      member may READ state but may not INSERT/UPDATE; an admin can; an outsider
 *      sees nothing.
 *   2. UNIQUE(org, provider): a second row for the same provider is refused.
 *   3. The connected-requires-handle CHECK: status='connected' with no account
 *      handle is refused; with a handle it is accepted.
 *   4. Disconnect (admin update back to 'disconnected', tokens cleared) works.
 *   5. Token columns are service-role-only on read (column privilege).
 *   6. calendar_event_links is org-bound by a composite FK — an event link whose
 *      org_id differs from its connection's org is refused by Postgres.
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

const TOKEN = `it-calconn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("calendar connections · RLS + constraints", () => {
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
      .insert({ id, email, full_name: `CalConn ${label}` })
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
      .insert({ name: "CalConn A", slug: `${TOKEN}-a` })
      .select("id")
      .single();
    const b = await svc
      .from("organizations")
      .insert({ name: "CalConn B", slug: `${TOKEN}-b` })
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
      .from("calendar_connections")
      .insert({ org_id: orgA, provider: "google", status: "disconnected" })
      .select("id, provider, status");
    expect(res.error, res.error?.message).toBeNull();
    expect(String(res.data?.[0]?.status)).toBe("disconnected");
    expect(String(res.data?.[0]?.provider)).toBe("google");
    connAId = String(res.data?.[0]?.id ?? "");
    expect(connAId).not.toBe("");
  });

  it("a plain MEMBER may READ state but may NOT insert", async () => {
    const asMember = db(userClient(memberToken));
    const readRes = await asMember
      .from("calendar_connections")
      .select("id, provider")
      .eq("org_id", orgA);
    expect(readRes.error, readRes.error?.message).toBeNull();
    expect((readRes.data ?? []).length).toBeGreaterThanOrEqual(1);

    const ins = await asMember
      .from("calendar_connections")
      .insert({ org_id: orgA, provider: "microsoft", status: "disconnected" })
      .select("id");
    expect(ins.error, "member insert must be refused by RLS").not.toBeNull();
  });

  it("an OUTSIDER sees no connection rows at all", async () => {
    const res = await db(userClient(outsiderToken))
      .from("calendar_connections")
      .select("id")
      .eq("org_id", orgA);
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });

  // ── 2. UNIQUE(org, provider) ───────────────────────────────────────────────

  it("refuses a SECOND connection for the same (org, provider)", async () => {
    const dup = await db(userClient(ownerToken))
      .from("calendar_connections")
      .insert({ org_id: orgA, provider: "google", status: "disconnected" })
      .select("id");
    expect(dup.error, "duplicate (org,provider) must be refused").not.toBeNull();
  });

  // ── 3. connected-requires-handle CHECK ─────────────────────────────────────

  it("REFUSES status='connected' with no account handle (no fake connected state)", async () => {
    const bad = await db(serviceClient())
      .from("calendar_connections")
      .insert({ org_id: orgB, provider: "google", status: "connected" })
      .select("id");
    expect(bad.error, "connected without a handle must be refused by the CHECK").not.toBeNull();
  });

  it("ACCEPTS status='connected' WITH an account handle", async () => {
    const good = await db(serviceClient())
      .from("calendar_connections")
      .insert({
        org_id: orgB,
        provider: "microsoft",
        status: "connected",
        external_account_id: "acct-123",
      })
      .select("id, status, external_account_id");
    expect(good.error, good.error?.message).toBeNull();
    expect(String(good.data?.[0]?.status)).toBe("connected");
    expect(String(good.data?.[0]?.external_account_id)).toBe("acct-123");
  });

  // ── 4. disconnect (admin update) ───────────────────────────────────────────

  it("an admin can disconnect: status back to disconnected, tokens cleared", async () => {
    const upd = await db(userClient(ownerToken))
      .from("calendar_connections")
      .update({
        status: "disconnected",
        access_token: null,
        refresh_token: null,
        external_account_id: null,
        connected_at: null,
      })
      .eq("org_id", orgA)
      .eq("provider", "google")
      .select("id, status");
    expect(upd.error, upd.error?.message).toBeNull();
    expect(String(upd.data?.[0]?.status)).toBe("disconnected");
  });

  it("a plain MEMBER may NOT update a connection", async () => {
    const upd = await db(userClient(memberToken))
      .from("calendar_connections")
      .update({ status: "error" })
      .eq("org_id", orgA)
      .eq("provider", "google")
      .select("id");
    expect(upd.error || (upd.data ?? []).length === 0).toBeTruthy();
  });

  // ── 5. COLUMN-LEVEL PRIVILEGE — token columns are service-role-only on read ──

  it("service_role can WRITE the token columns (the activation writer path)", async () => {
    const upd = await db(serviceClient())
      .from("calendar_connections")
      .update({
        access_token: "tok-secret",
        refresh_token: "ref-secret",
        token_expires_at: new Date().toISOString(),
      })
      .eq("org_id", orgA)
      .eq("provider", "google")
      .select("id, access_token, refresh_token");
    expect(upd.error, upd.error?.message).toBeNull();
    expect(String(upd.data?.[0]?.access_token)).toBe("tok-secret");
    expect(String(upd.data?.[0]?.refresh_token)).toBe("ref-secret");
  });

  it("a MEMBER is DENIED reading each token column (column privilege)", async () => {
    const asMember = db(userClient(memberToken));
    const at = await asMember
      .from("calendar_connections")
      .select("access_token")
      .eq("org_id", orgA);
    expect(at.error, "member select(access_token) must be refused by the column grant").not.toBeNull();

    const rt = await asMember
      .from("calendar_connections")
      .select("refresh_token")
      .eq("org_id", orgA);
    expect(rt.error, "member select(refresh_token) must be refused").not.toBeNull();

    const exp = await asMember
      .from("calendar_connections")
      .select("token_expires_at")
      .eq("org_id", orgA);
    expect(exp.error, "member select(token_expires_at) must be refused").not.toBeNull();
  });

  it("a MEMBER select('*') FAILS (star expands to the token columns)", async () => {
    const res = await db(userClient(memberToken))
      .from("calendar_connections")
      .select("*")
      .eq("org_id", orgA);
    expect(res.error, "star-select must be refused by the column grant").not.toBeNull();
  });

  it("a MEMBER can STILL read the non-token columns (status / provider / handle)", async () => {
    const res = await db(userClient(memberToken))
      .from("calendar_connections")
      .select(
        "provider, status, external_account_id, connected_at, last_sync_at, last_error",
      )
      .eq("org_id", orgA);
    expect(res.error, res.error?.message).toBeNull();
    expect((res.data ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("service_role reads the token columns back (the only reader)", async () => {
    const res = await db(serviceClient())
      .from("calendar_connections")
      .select("access_token, refresh_token, token_expires_at")
      .eq("org_id", orgA)
      .eq("provider", "google")
      .maybeSingle();
    expect(res.error, res.error?.message).toBeNull();
    expect(String(res.data?.access_token)).toBe("tok-secret");
    expect(String(res.data?.refresh_token)).toBe("ref-secret");
  });

  // ── 6. calendar_event_links — org-bound by composite FK ─────────────────────

  it("accepts an event link whose org_id matches its connection's org", async () => {
    const ins = await db(serviceClient())
      .from("calendar_event_links")
      .insert({
        org_id: orgA,
        connection_id: connAId,
        local_kind: "job",
        local_id: crypto.randomUUID(),
        external_event_id: "evt-ok-1",
      })
      .select("id");
    expect(ins.error, ins.error?.message).toBeNull();
    expect(String(ins.data?.[0]?.id ?? "")).not.toBe("");
  });

  it("REFUSES an event link whose org_id differs from its connection's org (composite FK)", async () => {
    // connAId belongs to orgA; claiming org_id = orgB must be refused by the
    // composite FK to calendar_connections(id, org_id) — cross-org is impossible.
    const bad = await db(serviceClient())
      .from("calendar_event_links")
      .insert({
        org_id: orgB,
        connection_id: connAId,
        local_kind: "job",
        local_id: crypto.randomUUID(),
        external_event_id: "evt-crossorg",
      })
      .select("id");
    expect(bad.error, "cross-org event link must be refused by the composite FK").not.toBeNull();
  });

  it("a MEMBER may READ event links but may NOT insert (admin-write)", async () => {
    const asMember = db(userClient(memberToken));
    const readRes = await asMember
      .from("calendar_event_links")
      .select("id")
      .eq("org_id", orgA);
    expect(readRes.error, readRes.error?.message).toBeNull();

    const ins = await asMember
      .from("calendar_event_links")
      .insert({
        org_id: orgA,
        connection_id: connAId,
        local_kind: "rota",
        local_id: crypto.randomUUID(),
        external_event_id: "evt-member",
      })
      .select("id");
    expect(ins.error, "member event-link insert must be refused by RLS").not.toBeNull();
  });
});

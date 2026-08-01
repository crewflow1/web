import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import { generateApiKey } from "@/lib/api-auth/keygen";
import { resolveApiKey } from "@/lib/api-auth/resolve";

/**
 * Train 9 — `api_keys` isolation, the column-level key_hash exclusion, and
 * the resolver, against real Postgres.
 *
 * The four live-fire proofs this file exists for:
 *   1. key_hash is UNREADABLE on the tenant (authenticated) client — both
 *      `select('*')` and an explicit `select('key_hash')` must FAIL with a
 *      permission error, while the safe-column list succeeds. This is the
 *      column-privilege mechanism itself, not a re-test of RLS.
 *   2. A plain member of the SAME org can neither see, create, nor revoke
 *      keys (admin-only RLS, the cis_subcontractors stance).
 *   3. Cross-org: org B's admin sees nothing of org A's keys and cannot
 *      revoke them.
 *   4. resolveApiKey end-to-end: a live key resolves; the SAME key returns
 *      null on the very next call after revocation (no cache); an expired
 *      key returns null; revocation is FINAL even for service_role.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(c: string, v: unknown): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Upd extends PromiseLike<Res<null>> {
  eq(c: string, v: unknown): Upd;
  select(c?: string): PromiseLike<Res<Row[]>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(c?: string): { single(): PromiseLike<Res<Row>>; maybeSingle(): PromiseLike<Res<Row>> };
}
interface Table {
  select(c?: string): Sel;
  insert(r: Row): Ins;
  update(v: Row): Upd;
  delete(): { eq(c: string, v: unknown): PromiseLike<Res<null>> };
}
type Client = { from(t: string): Table };
const db = (c: unknown) => c as unknown as Client;

const T = `it-apikeys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Every column EXCEPT key_hash — must match the migration's grant list. */
const SAFE_COLUMNS =
  "id, org_id, name, key_prefix, scopes, created_by, created_at, last_used_at, expires_at, revoked_at";

describeIntegration("Train 9 api_keys (real Postgres)", () => {
  let orgA = "";
  let orgB = "";
  let admin = { id: "", token: "" };
  let member = { id: "", token: "" };
  let adminB = { id: "", token: "" };

  const svc = () => db(serviceClient());
  const asAdmin = () => db(userClient(admin.token));
  const asMember = () => db(userClient(member.token));
  const asAdminB = () => db(userClient(adminB.token));

  async function mkMember(orgId: string, role: string, tag: string) {
    const email = `${T}-${tag}@x.test`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password: `Pw-${T}`,
      email_confirm: true,
    });
    if (created.error) throw new Error(created.error.message);
    const id = created.data.user?.id ?? "";
    await svc().from("users").insert({ id, email, full_name: tag });
    await svc().from("memberships").insert({ org_id: orgId, user_id: id, role });
    const s = await anonClient().auth.signInWithPassword({ email, password: `Pw-${T}` });
    if (s.error) throw new Error(s.error.message);
    return { id, token: s.data.session?.access_token ?? "" };
  }

  /** Service-role fixture key. Returns row id + the plaintext (test-only). */
  async function mkKey(
    orgId: string,
    name: string,
    extra: Row = {},
  ): Promise<{ id: string; plaintext: string }> {
    const key = generateApiKey();
    const inserted = await svc()
      .from("api_keys")
      .insert({
        org_id: orgId,
        name,
        key_prefix: key.keyPrefix,
        key_hash: key.keyHash,
        scopes: ["read:jobs"],
        ...extra,
      })
      .select("id")
      .single();
    if (inserted.error) throw new Error(inserted.error.message);
    return { id: String(inserted.data?.id), plaintext: key.plaintext };
  }

  beforeAll(async () => {
    // resolveApiKey builds its own admin client from NEXT_PUBLIC_SUPABASE_URL;
    // the harness accepts bare SUPABASE_URL too, so mirror it across.
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= process.env.SUPABASE_URL;

    orgA = String(
      (await svc().from("organizations").insert({ name: "Keys A", slug: `${T}-a` }).select("id").single())
        .data?.id,
    );
    orgB = String(
      (await svc().from("organizations").insert({ name: "Keys B", slug: `${T}-b` }).select("id").single())
        .data?.id,
    );
    admin = await mkMember(orgA, "admin", "adm");
    member = await mkMember(orgA, "staff", "mem");
    adminB = await mkMember(orgB, "admin", "admb");
  });

  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (orgB) await svc().from("organizations").delete().eq("id", orgB);
    for (const m of [admin, member, adminB]) {
      if (m.id) await serviceClient().auth.admin.deleteUser(m.id);
    }
  });

  // -------------------------------------------------------------------------
  // Positive control — the admin path works, so the denials below mean something
  // -------------------------------------------------------------------------

  it("org admin can INSERT a key through RLS and read it back via the safe columns", async () => {
    const key = generateApiKey();
    const ins = await asAdmin()
      .from("api_keys")
      .insert({
        org_id: orgA,
        name: `${T} admin-minted`,
        key_prefix: key.keyPrefix,
        key_hash: key.keyHash,
        scopes: ["read:jobs"],
        created_by: admin.id,
      })
      .select("id")
      .single();
    expect(ins.error).toBeNull();

    const list = await asAdmin().from("api_keys").select(SAFE_COLUMNS).eq("org_id", orgA);
    expect(list.error).toBeNull();
    expect((list.data ?? []).some((r) => r.name === `${T} admin-minted`)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 1. THE COLUMN MECHANISM — key_hash is structurally unreadable for tenants
  // -------------------------------------------------------------------------

  it("tenant select('*') FAILS with a permission error (Postgres expands * to key_hash)", async () => {
    const res = await asAdmin().from("api_keys").select("*").eq("org_id", orgA);
    expect(res.error, "star-select must be refused by the column grant").not.toBeNull();
    expect(res.error!.code).toBe("42501"); // insufficient_privilege
  });

  it("tenant select('key_hash') FAILS with a permission error — even on the admin's OWN key", async () => {
    const res = await asAdmin().from("api_keys").select("key_hash").eq("org_id", orgA);
    expect(res.error).not.toBeNull();
    expect(res.error!.code).toBe("42501");
  });

  it("service_role still reads key_hash (the resolver's lookup path)", async () => {
    const { id } = await mkKey(orgA, `${T} svc-readable`);
    const res = await svc().from("api_keys").select("id, key_hash").eq("id", id).maybeSingle();
    expect(res.error).toBeNull();
    expect(String(res.data?.key_hash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tenant cannot UPDATE the credential columns (grant is name + revoked_at only)", async () => {
    const { id } = await mkKey(orgA, `${T} no-credential-updates`);
    const res = await asAdmin()
      .from("api_keys")
      .update({ key_hash: "0".repeat(64) })
      .eq("id", id)
      .select("id");
    expect(res.error, "key_hash update must be refused").not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 2. Same-org member — sees nothing, mints nothing, revokes nothing
  // -------------------------------------------------------------------------

  it("a plain member's SELECT returns zero rows", async () => {
    await mkKey(orgA, `${T} hidden-from-members`);
    const res = await asMember().from("api_keys").select(SAFE_COLUMNS).eq("org_id", orgA);
    expect(res.error).toBeNull();
    expect(res.data).toEqual([]);
  });

  it("a plain member cannot INSERT a key", async () => {
    const key = generateApiKey();
    const res = await asMember()
      .from("api_keys")
      .insert({
        org_id: orgA,
        name: `${T} member-minted`,
        key_prefix: key.keyPrefix,
        key_hash: key.keyHash,
        scopes: ["read:jobs"],
      })
      .select("id")
      .maybeSingle();
    expect(res.error, "member insert must be refused by RLS").not.toBeNull();
  });

  it("a plain member cannot revoke — the key stays live (ground truth via service role)", async () => {
    const { id } = await mkKey(orgA, `${T} member-revoke-target`);
    const res = await asMember()
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id)
      .select("id");
    // RLS hides the row from the member: zero rows updated, no error required.
    expect(res.data ?? []).toEqual([]);
    const truth = await svc().from("api_keys").select("revoked_at").eq("id", id).maybeSingle();
    expect(truth.error).toBeNull();
    expect(truth.data?.revoked_at).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 3. Cross-org — org B's admin
  // -------------------------------------------------------------------------

  it("org B's admin cannot see org A's keys at all", async () => {
    await mkKey(orgA, `${T} invisible-cross-org`);
    const byOrg = await asAdminB().from("api_keys").select(SAFE_COLUMNS).eq("org_id", orgA);
    expect(byOrg.error).toBeNull();
    expect(byOrg.data).toEqual([]);
    const all = await asAdminB().from("api_keys").select(SAFE_COLUMNS);
    expect(all.error).toBeNull();
    expect((all.data ?? []).every((r) => r.org_id === orgB)).toBe(true);
  });

  it("org B's admin cannot revoke org A's key", async () => {
    const { id, plaintext } = await mkKey(orgA, `${T} cross-org-revoke-target`);
    const res = await asAdminB()
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id)
      .select("id");
    expect(res.data ?? []).toEqual([]);
    // And the key still authenticates.
    expect(await resolveApiKey(`Bearer ${plaintext}`)).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 4. No delete, revocation final — for tenants AND service_role
  // -------------------------------------------------------------------------

  it("tenant DELETE is refused (no policy, no grant) — revoke, never erase", async () => {
    const { id } = await mkKey(orgA, `${T} undeletable`);
    const res = await asAdmin().from("api_keys").delete().eq("id", id);
    expect(res.error, "tenant delete must be refused").not.toBeNull();
    const truth = await svc().from("api_keys").select("id").eq("id", id).maybeSingle();
    expect(truth.data?.id).toBe(id);
  });

  it("revocation is FINAL: even service_role cannot un-revoke (trigger, all roles)", async () => {
    const { id } = await mkKey(orgA, `${T} revocation-final`, {
      revoked_at: new Date().toISOString(),
    });
    const res = await svc().from("api_keys").update({ revoked_at: null }).eq("id", id).select("id");
    expect(res.error, "un-revoking must be refused by the trigger").not.toBeNull();
    expect(res.error!.message).toMatch(/revocation is final/i);
  });

  it("service_role cannot swap a key_hash either (credential immutability, all roles)", async () => {
    const { id } = await mkKey(orgA, `${T} hash-immutable`);
    const res = await svc()
      .from("api_keys")
      .update({ key_hash: "f".repeat(64) })
      .eq("id", id)
      .select("id");
    expect(res.error).not.toBeNull();
    expect(res.error!.message).toMatch(/key_hash is immutable/i);
  });

  // -------------------------------------------------------------------------
  // 5. resolveApiKey end-to-end against real Postgres
  // -------------------------------------------------------------------------

  it("a live key resolves to its org + scopes; an unknown key resolves to null", async () => {
    const { plaintext } = await mkKey(orgA, `${T} resolver-live`);
    const resolved = await resolveApiKey(`Bearer ${plaintext}`);
    expect(resolved).not.toBeNull();
    expect(resolved!.orgId).toBe(orgA);
    expect(resolved!.scopes).toEqual(["read:jobs"]);

    const ghost = generateApiKey();
    expect(await resolveApiKey(`Bearer ${ghost.plaintext}`)).toBeNull();
  });

  it("REVOKED key → null on the very next resolve (401 end-to-end, no cache window)", async () => {
    const { id, plaintext } = await mkKey(orgA, `${T} resolver-revoked`);
    expect(await resolveApiKey(`Bearer ${plaintext}`)).not.toBeNull();

    // Revoke exactly the way the UI does: the tenant admin client.
    const revoke = await asAdmin()
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id)
      .select("id");
    expect(revoke.error).toBeNull();
    expect((revoke.data ?? []).length).toBe(1);

    expect(await resolveApiKey(`Bearer ${plaintext}`)).toBeNull();
  });

  it("EXPIRED key → null (fails closed exactly like an unknown key)", async () => {
    const { plaintext } = await mkKey(orgA, `${T} resolver-expired`, {
      created_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      expires_at: new Date(Date.now() - 86_400_000).toISOString(),
    });
    expect(await resolveApiKey(`Bearer ${plaintext}`)).toBeNull();
  });

  it("resolving stamps last_used_at once, then debounces the next call (Postgres WHERE)", async () => {
    const { id, plaintext } = await mkKey(orgA, `${T} resolver-telemetry`);
    expect(await resolveApiKey(`Bearer ${plaintext}`)).not.toBeNull();
    const first = await svc().from("api_keys").select("last_used_at").eq("id", id).maybeSingle();
    expect(first.error).toBeNull();
    expect(first.data?.last_used_at).not.toBeNull();

    // Immediate second resolve: still authenticates, but the coarse touch skips.
    expect(await resolveApiKey(`Bearer ${plaintext}`)).not.toBeNull();
    const second = await svc().from("api_keys").select("last_used_at").eq("id", id).maybeSingle();
    expect(second.data?.last_used_at).toBe(first.data?.last_used_at);
  });
});

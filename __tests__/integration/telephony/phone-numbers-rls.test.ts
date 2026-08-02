import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * phone_numbers (20261098) — against real Postgres RLS + the column privilege.
 *
 *   1. member-read / admin-write, org-isolated: an admin (owner) writes; a plain
 *      member reads state but cannot write; an outsider sees nothing.
 *   2. unique(provider, e164): a second row for the same dialed number is refused.
 *   3. the no-fake CHECK: active=true without a provider SID is refused.
 *   4. provider_auth_secret is service-role-only on read (column privilege).
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Ins;
  single(): PromiseLike<Res<Row>>;
}
interface Upd extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Upd;
  select(columns?: string): Upd;
}
interface Del extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  update(row: Row): Upd;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-phnum-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("phone_numbers · RLS + column privilege", () => {
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
      .insert({ id, email, full_name: `PhNum ${label}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    return { id, token: signedIn.data.session?.access_token ?? "" };
  }

  beforeAll(async () => {
    const svc = db(serviceClient());
    const a = await svc.from("organizations").insert({ name: "PhNum A", slug: `${TOKEN}-a` }).select("id").single();
    const b = await svc.from("organizations").insert({ name: "PhNum B", slug: `${TOKEN}-b` }).select("id").single();
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

  const A_NUM = `+44700${TOKEN.replace(/\D/g, "").slice(-7).padStart(7, "0")}`;

  it("an ADMIN (owner) can insert a routed number", async () => {
    const res = await db(userClient(ownerToken))
      .from("phone_numbers")
      .insert({ org_id: orgA, provider: "twilio", e164: A_NUM, active: false })
      .select("id, provider, e164, active");
    expect(res.error, res.error?.message).toBeNull();
    expect(String(res.data?.[0]?.provider)).toBe("twilio");
    expect(res.data?.[0]?.active).toBe(false);
  });

  it("a plain MEMBER may READ state but may NOT insert", async () => {
    const asMember = db(userClient(memberToken));
    const readRes = await asMember.from("phone_numbers").select("id, e164").eq("org_id", orgA);
    expect(readRes.error, readRes.error?.message).toBeNull();
    expect((readRes.data ?? []).length).toBeGreaterThanOrEqual(1);

    const ins = await asMember
      .from("phone_numbers")
      .insert({ org_id: orgA, provider: "vapi", e164: `${A_NUM}9`, active: false })
      .select("id");
    expect(ins.error, "member insert must be refused by RLS").not.toBeNull();
  });

  it("an OUTSIDER sees no numbers at all", async () => {
    const res = await db(userClient(outsiderToken)).from("phone_numbers").select("id").eq("org_id", orgA);
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });

  it("refuses a SECOND row for the same (provider, e164)", async () => {
    const dup = await db(serviceClient())
      .from("phone_numbers")
      .insert({ org_id: orgB, provider: "twilio", e164: A_NUM, active: false })
      .select("id");
    expect(dup.error, "duplicate (provider, e164) must be refused").not.toBeNull();
  });

  it("REFUSES active=true without a provider SID (no fake provisioned)", async () => {
    const bad = await db(serviceClient())
      .from("phone_numbers")
      .insert({ org_id: orgB, provider: "twilio", e164: `${A_NUM}1`, active: true })
      .select("id");
    expect(bad.error, "active without a SID must be refused by the CHECK").not.toBeNull();
  });

  it("ACCEPTS active=true WITH a provider SID", async () => {
    const good = await db(serviceClient())
      .from("phone_numbers")
      .insert({
        org_id: orgB,
        provider: "twilio",
        e164: `${A_NUM}2`,
        provider_number_sid: "PN123",
        active: true,
      })
      .select("id, active");
    expect(good.error, good.error?.message).toBeNull();
    expect(good.data?.[0]?.active).toBe(true);
  });

  // ── column privilege: provider_auth_secret is service-role-only on read ──────

  it("service_role can WRITE + READ provider_auth_secret", async () => {
    const upd = await db(serviceClient())
      .from("phone_numbers")
      .update({ provider_auth_secret: "sekret" })
      .eq("org_id", orgA)
      .eq("e164", A_NUM)
      .select("id, provider_auth_secret");
    expect(upd.error, upd.error?.message).toBeNull();
    expect(String(upd.data?.[0]?.provider_auth_secret)).toBe("sekret");
  });

  it("a MEMBER is DENIED reading provider_auth_secret (column privilege)", async () => {
    const res = await db(userClient(memberToken))
      .from("phone_numbers")
      .select("provider_auth_secret")
      .eq("org_id", orgA);
    expect(res.error, "member select(provider_auth_secret) must be refused").not.toBeNull();
  });

  it("a MEMBER select('*') FAILS (star expands to the secret column)", async () => {
    const res = await db(userClient(memberToken)).from("phone_numbers").select("*").eq("org_id", orgA);
    expect(res.error, "star-select must be refused by the column grant").not.toBeNull();
  });

  it("a MEMBER can STILL read the non-secret columns", async () => {
    const res = await db(userClient(memberToken))
      .from("phone_numbers")
      .select("provider, e164, active, provider_number_sid, label")
      .eq("org_id", orgA);
    expect(res.error, res.error?.message).toBeNull();
    expect((res.data ?? []).length).toBeGreaterThanOrEqual(1);
  });
});

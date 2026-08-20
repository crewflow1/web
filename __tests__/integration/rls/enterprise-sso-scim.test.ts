import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import {
  findActiveMembershipByEmail,
  deactivateMembership,
  consumeSamlAssertion,
} from "@/lib/enterprise-sso/provisioning";

/**
 * ENTERPRISE SSO + SCIM (migration 20261211000000) — against real Postgres RLS.
 *
 *   1. org_sso_config / org_scim_config are ADMIN-READ only, org-isolated, and
 *      have NO tenant write path: an owner reads, a plain member is blind, an
 *      outsider/anon sees nothing, and even an owner cannot INSERT/UPDATE
 *      (writes are service-role only).
 *   2. Secret columns (oidc_client_secret_ciphertext, token_hash) are WITHHELD
 *      from the authenticated column grant — even an owner cannot select them.
 *   3. Cross-tenant: an owner of org A cannot read org B's config.
 *   4. Provisioning is DENY-UNMATCHED: findActiveMembershipByEmail matches an
 *      existing member and returns null for a non-member — never creates.
 *   5. SCIM deactivate REMOVES the membership (org-scoped), leaving the user
 *      account and other-org memberships intact.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
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
interface Del extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string, opts?: Record<string, unknown>): Sel;
  insert(rows: Row | Row[]): Ins;
  update(row: Row): Upd;
  delete(opts?: Record<string, unknown>): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-entsso-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("enterprise SSO + SCIM · RLS + provisioning", () => {
  let orgA = "";
  let orgB = "";
  let ownerAId = "";
  let ownerAEmail = "";
  let ownerAToken = "";
  let memberToken = "";
  let memberEmail = "";
  let ownerBToken = "";
  let outsiderEmail = "";

  async function mintUser(label: string): Promise<{ id: string; email: string; token: string }> {
    const email = `${TOKEN}-${label}@example.test`;
    const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    const mirrored = await db(serviceClient())
      .from("users")
      .insert({ id, email, full_name: `EntSSO ${label}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    return { id, email, token: signedIn.data.session?.access_token ?? "" };
  }

  beforeAll(async () => {
    // createAdminClient() reads NEXT_PUBLIC_SUPABASE_URL; mirror the harness's
    // resolved URL so the provisioning lib points at the same test DB.
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= process.env.SUPABASE_URL;

    const svc = db(serviceClient());
    const a = await svc.from("organizations").insert({ name: "EntSSO A", slug: `${TOKEN}-a` }).select("id").single();
    const b = await svc.from("organizations").insert({ name: "EntSSO B", slug: `${TOKEN}-b` }).select("id").single();
    orgA = String(a.data?.id ?? "");
    orgB = String(b.data?.id ?? "");
    if (!orgA || !orgB) throw new Error("failed to create probe orgs");

    const owner = await mintUser("owner-a");
    ownerAId = owner.id;
    ownerAEmail = owner.email;
    ownerAToken = owner.token;
    expect((await svc.from("memberships").insert({ org_id: orgA, user_id: ownerAId, role: "owner" })).error).toBeNull();

    const member = await mintUser("member-a");
    memberToken = member.token;
    memberEmail = member.email;
    expect((await svc.from("memberships").insert({ org_id: orgA, user_id: member.id, role: "staff" })).error).toBeNull();

    const ownerB = await mintUser("owner-b");
    ownerBToken = ownerB.token;
    expect((await svc.from("memberships").insert({ org_id: orgB, user_id: ownerB.id, role: "owner" })).error).toBeNull();

    // An existing user who is NOT a member of org A (deny-unmatched probe).
    outsiderEmail = (await mintUser("outsider")).email;

    // Seed a SAML config for org A + a SCIM config (service role only).
    const cfg = await svc.from("org_sso_config").insert({
      org_id: orgA,
      protocol: "saml",
      enabled: false,
      saml_idp_entity_id: "https://idp.example.com",
      saml_idp_sso_url: "https://idp.example.com/sso",
      saml_idp_x509_cert: "MIIDUMMYCERT",
    });
    expect(cfg.error, cfg.error?.message).toBeNull();

    const scim = await svc.from("org_scim_config").insert({
      org_id: orgA,
      enabled: false,
      token_hash: `hash-${TOKEN}`,
      token_prefix: "crewflow_sk_abcd1234",
    });
    expect(scim.error, scim.error?.message).toBeNull();
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
  });

  // ── 1. RLS reads ────────────────────────────────────────────────────────────
  it("an ADMIN (owner) can read their org's SSO config", async () => {
    const res = await db(userClient(ownerAToken))
      .from("org_sso_config")
      .select("id, protocol, enabled")
      .eq("org_id", orgA);
    expect(res.error, res.error?.message).toBeNull();
    expect((res.data ?? []).length).toBe(1);
    expect(String(res.data?.[0]?.protocol)).toBe("saml");
  });

  it("a plain MEMBER is blind to the SSO config (admin-only select)", async () => {
    const res = await db(userClient(memberToken)).from("org_sso_config").select("id").eq("org_id", orgA);
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });

  it("an ANON caller sees no SSO/SCIM config at all", async () => {
    const sso = await db(anonClient()).from("org_sso_config").select("id").eq("org_id", orgA);
    expect(sso.data ?? []).toHaveLength(0);
    const scim = await db(anonClient()).from("org_scim_config").select("id").eq("org_id", orgA);
    expect(scim.data ?? []).toHaveLength(0);
  });

  it("cross-tenant: owner of org B cannot read org A's config", async () => {
    const res = await db(userClient(ownerBToken)).from("org_sso_config").select("id").eq("org_id", orgA);
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });

  // ── 2. No tenant write path ─────────────────────────────────────────────────
  it("even an OWNER cannot INSERT an SSO config (no tenant write policy)", async () => {
    const res = await db(userClient(ownerAToken))
      .from("org_sso_config")
      .insert({ org_id: orgA, protocol: "oidc", enabled: true })
      .select("id");
    expect(res.error, "owner insert must be refused by RLS").not.toBeNull();
  });

  it("even an OWNER cannot UPDATE (e.g. flip enabled) via PostgREST", async () => {
    const res = await db(userClient(ownerAToken))
      .from("org_sso_config")
      .update({ enabled: true })
      .eq("org_id", orgA)
      .select("id");
    // Either a hard error or zero rows affected — never an applied write.
    const rows = res.data ?? [];
    expect(rows.length === 0 || res.error !== null).toBe(true);
    // Ground truth: still disabled.
    const truth = await db(serviceClient()).from("org_sso_config").select("enabled").eq("org_id", orgA);
    expect(Boolean(truth.data?.[0]?.enabled)).toBe(false);
  });

  // ── 3. Secret columns withheld ──────────────────────────────────────────────
  it("an owner CANNOT select the encrypted OIDC secret column", async () => {
    const res = await db(userClient(ownerAToken))
      .from("org_sso_config")
      .select("oidc_client_secret_ciphertext")
      .eq("org_id", orgA);
    expect(res.error, "secret column must be withheld from authenticated").not.toBeNull();
  });

  it("an owner CANNOT select the SCIM token_hash column", async () => {
    const res = await db(userClient(ownerAToken))
      .from("org_scim_config")
      .select("token_hash")
      .eq("org_id", orgA);
    expect(res.error, "token hash must be withheld from authenticated").not.toBeNull();
  });

  // ── 4. Deny-unmatched provisioning ──────────────────────────────────────────
  it("findActiveMembershipByEmail matches an existing member", async () => {
    const match = await findActiveMembershipByEmail(orgA, memberEmail.toUpperCase());
    expect(match).not.toBeNull();
    expect(match?.email.toLowerCase()).toBe(memberEmail.toLowerCase());
  });

  it("findActiveMembershipByEmail returns null for a non-member (deny-unmatched)", async () => {
    expect(await findActiveMembershipByEmail(orgA, outsiderEmail)).toBeNull();
    expect(await findActiveMembershipByEmail(orgA, "nobody@nowhere.test")).toBeNull();
  });

  // ── 5. SCIM deactivate removes the membership, org-scoped ────────────────────
  it("deactivateMembership removes the member's membership (and only in that org)", async () => {
    // Give owner-a a membership in org B too, to prove scoping.
    const svc = db(serviceClient());
    expect((await svc.from("memberships").insert({ org_id: orgB, user_id: ownerAId, role: "staff" })).error).toBeNull();

    const { removed } = await deactivateMembership(orgA, ownerAEmail);
    expect(removed).toBe(true);

    // Org A membership gone…
    const inA = await svc.from("memberships").select("id").eq("org_id", orgA).eq("user_id", ownerAId);
    expect(inA.data ?? []).toHaveLength(0);
    // …org B membership intact; the user account intact.
    const inB = await svc.from("memberships").select("id").eq("org_id", orgB).eq("user_id", ownerAId);
    expect((inB.data ?? []).length).toBe(1);
    const user = await svc.from("users").select("id").eq("id", ownerAId);
    expect((user.data ?? []).length).toBe(1);

    // Idempotent: a second deactivate finds nothing to remove.
    expect((await deactivateMembership(orgA, ownerAEmail)).removed).toBe(false);
  });

  // ── 6. SAML replay guard (F1) ───────────────────────────────────────────────
  it("consumeSamlAssertion consumes once, then rejects the replay (unique 23505)", async () => {
    const assertionId = `_assert-${TOKEN}`;
    const first = await consumeSamlAssertion({
      orgId: orgA,
      assertionId,
      notOnOrAfterMs: Date.now() + 60_000,
    });
    expect(first).toEqual({ consumed: true, errored: false });

    // Re-POST of the same assertion → refused as a replay, not an error.
    const replay = await consumeSamlAssertion({
      orgId: orgA,
      assertionId,
      notOnOrAfterMs: Date.now() + 60_000,
    });
    expect(replay).toEqual({ consumed: false, errored: false });

    // The SAME assertion id in a DIFFERENT org is independent (per-org unique).
    const otherOrg = await consumeSamlAssertion({
      orgId: orgB,
      assertionId,
      notOnOrAfterMs: Date.now() + 60_000,
    });
    expect(otherOrg).toEqual({ consumed: true, errored: false });
  });

  it("consumed-assertions table: anon blind, admin can read own org", async () => {
    const svc = db(serviceClient());
    const aid = `_assert-rls-${TOKEN}`;
    expect(
      (
        await svc.from("sso_consumed_assertions").insert({
          org_id: orgA,
          assertion_id: aid,
          not_on_or_after: new Date(Date.now() + 60_000).toISOString(),
        })
      ).error,
    ).toBeNull();

    const anon = await db(anonClient()).from("sso_consumed_assertions").select("id").eq("org_id", orgA);
    expect(anon.data ?? []).toHaveLength(0);

    const asAdmin = await db(userClient(ownerAToken))
      .from("sso_consumed_assertions")
      .select("id, assertion_id")
      .eq("org_id", orgA)
      .eq("assertion_id", aid);
    expect(asAdmin.error, asAdmin.error?.message).toBeNull();
    expect((asAdmin.data ?? []).length).toBe(1);
  });
});

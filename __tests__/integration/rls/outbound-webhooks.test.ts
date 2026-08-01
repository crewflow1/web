import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import { generateWebhookSecret } from "@/lib/webhooks/secret";

/**
 * Train A — outbound webhooks isolation, the column-level secret exclusion, the
 * composite-FK forgery guard, idempotent fan-out, consumer-offset progression,
 * and the verify-before-activate trigger — against real Postgres.
 *
 * The proofs this file exists for:
 *   1. `secret` is UNREADABLE on the tenant (authenticated) client — both
 *      select('*') and select('secret') FAIL with 42501, while the safe-column
 *      list succeeds. The column-privilege mechanism itself.
 *   2. A plain member sees no endpoints; org B's admin sees nothing of org A's
 *      endpoints or deliveries; no tenant can write deliveries.
 *   3. A delivery cannot name another tenant's endpoint (composite-FK forgery
 *      rejected, even for service_role).
 *   4. Fan-out is idempotent: draining twice yields exactly one delivery per
 *      (endpoint, event); the consumer offset advances.
 *   5. An unverified endpoint cannot be activated (trigger, every role).
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
type Rpc = (fn: string, args?: Row) => Promise<Res<unknown>>;
type Client = { from(t: string): Table; rpc: Rpc };
const db = (c: unknown) => c as unknown as Client;

const T = `it-webhooks-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SAFE_COLUMNS =
  "id, org_id, url, description, event_verbs, status, consecutive_failures, verified_at, last_delivery_at, created_by, created_at, updated_at";

describeIntegration("Train A outbound webhooks (real Postgres)", () => {
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

  /**
   * Service-role endpoint fixture. Endpoints are ALWAYS born paused/unverified
   * (the INSERT guard forces it); `active` promotes via the same NULL→timestamp
   * UPDATE the real delivery pass uses, so the fixture exercises the sanctioned
   * verification path rather than smuggling an active endpoint in at insert.
   */
  async function mkEndpoint(
    orgId: string,
    opts: { verbs?: string[]; active?: boolean; url?: string } = {},
  ): Promise<string> {
    const ins = await svc()
      .from("webhook_endpoints")
      .insert({
        org_id: orgId,
        url: opts.url ?? `https://hooks.example.com/${randomUUID()}`,
        secret: generateWebhookSecret(),
        event_verbs: opts.verbs ?? ["org.created"],
      })
      .select("id")
      .single();
    if (ins.error) throw new Error(ins.error.message);
    const id = String(ins.data?.id);
    if (opts.active) {
      const up = await svc()
        .from("webhook_endpoints")
        .update({ verified_at: new Date().toISOString(), status: "active" })
        .eq("id", id)
        .select("id");
      if (up.error) throw new Error(up.error.message);
    }
    return id;
  }

  beforeAll(async () => {
    orgA = String((await svc().from("organizations").insert({ name: "WH A", slug: `${T}-a` }).select("id").single()).data?.id);
    orgB = String((await svc().from("organizations").insert({ name: "WH B", slug: `${T}-b` }).select("id").single()).data?.id);
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

  // --- Positive control -----------------------------------------------------

  it("org admin can INSERT an endpoint through RLS and read it back via safe columns", async () => {
    const ins = await asAdmin()
      .from("webhook_endpoints")
      .insert({
        org_id: orgA,
        url: `https://hooks.example.com/${randomUUID()}`,
        secret: generateWebhookSecret(),
        event_verbs: ["job.created"],
        created_by: admin.id,
      })
      .select("id")
      .single();
    expect(ins.error).toBeNull();

    const list = await asAdmin().from("webhook_endpoints").select(SAFE_COLUMNS).eq("org_id", orgA);
    expect(list.error).toBeNull();
    expect((list.data ?? []).length).toBeGreaterThan(0);
  });

  // --- 1. The column mechanism ----------------------------------------------

  it("tenant select('*') FAILS with 42501 (Postgres expands * to secret)", async () => {
    const res = await asAdmin().from("webhook_endpoints").select("*").eq("org_id", orgA);
    expect(res.error).not.toBeNull();
    expect(res.error!.code).toBe("42501");
  });

  it("tenant select('secret') FAILS with 42501 — even on the admin's OWN endpoint", async () => {
    const res = await asAdmin().from("webhook_endpoints").select("secret").eq("org_id", orgA);
    expect(res.error).not.toBeNull();
    expect(res.error!.code).toBe("42501");
  });

  it("service_role still reads secret (the delivery pass's signing path)", async () => {
    const id = await mkEndpoint(orgA);
    const res = await svc().from("webhook_endpoints").select("id, secret").eq("id", id).maybeSingle();
    expect(res.error).toBeNull();
    expect(String(res.data?.secret)).toMatch(/^whsec_/);
  });

  it("tenant cannot UPDATE the secret (grant is description/event_verbs/status only)", async () => {
    const id = await mkEndpoint(orgA);
    const res = await asAdmin().from("webhook_endpoints").update({ secret: "whsec_x" }).eq("id", id).select("id");
    expect(res.error, "secret update must be refused").not.toBeNull();
  });

  // --- 2. Same-org member + cross-org ---------------------------------------

  it("a plain member sees zero endpoints and cannot create one", async () => {
    await mkEndpoint(orgA);
    const sel = await asMember().from("webhook_endpoints").select(SAFE_COLUMNS).eq("org_id", orgA);
    expect(sel.error).toBeNull();
    expect(sel.data).toEqual([]);

    const ins = await asMember()
      .from("webhook_endpoints")
      .insert({ org_id: orgA, url: "https://x.example.com/h", secret: generateWebhookSecret(), event_verbs: ["job.created"] })
      .select("id")
      .maybeSingle();
    expect(ins.error, "member insert must be refused by RLS").not.toBeNull();
  });

  it("org B's admin sees nothing of org A's endpoints or deliveries", async () => {
    await mkEndpoint(orgA);
    const eps = await asAdminB().from("webhook_endpoints").select(SAFE_COLUMNS).eq("org_id", orgA);
    expect(eps.error).toBeNull();
    expect(eps.data).toEqual([]);

    const dels = await asAdminB().from("webhook_deliveries").select("id").eq("org_id", orgA);
    expect(dels.error).toBeNull();
    expect(dels.data).toEqual([]);
  });

  it("no tenant can INSERT a delivery (service-role only)", async () => {
    const id = await mkEndpoint(orgA);
    const res = await asAdmin()
      .from("webhook_deliveries")
      .insert({ org_id: orgA, endpoint_id: id, verb: "job.created", payload: {} })
      .select("id")
      .maybeSingle();
    expect(res.error, "tenant delivery insert must be refused").not.toBeNull();
  });

  // --- 3. Composite-FK forgery ----------------------------------------------

  it("a delivery cannot name another tenant's endpoint (composite FK, even service_role)", async () => {
    const endpointA = await mkEndpoint(orgA);
    const res = await svc()
      .from("webhook_deliveries")
      .insert({ org_id: orgB, endpoint_id: endpointA, verb: "org.created", payload: {} })
      .select("id")
      .maybeSingle();
    expect(res.error, "(endpointA, orgB) is unrepresentable").not.toBeNull();
  });

  // --- 4. Idempotent fan-out + offset progression ---------------------------

  it("fan-out is idempotent and advances the consumer offset", async () => {
    const endpoint = await mkEndpoint(orgA, { verbs: ["org.created"], active: true });

    // Emit an org.created event whose object resolves to orgA.
    const emit = await svc().rpc("hq_emit_event", {
      p_actor_type: "system",
      p_actor_id: "test",
      p_verb: "org.created",
      p_object_type: "org",
      p_object_id: orgA,
      p_correlation_id: randomUUID(),
      p_severity: "info",
      p_payload: { hello: "world" },
    });
    expect(emit.error).toBeNull();
    const eventId = Number(emit.data);

    const before = await svc().from("hq_event_consumers").select("last_event_id").eq("consumer", "outbound_webhooks").maybeSingle();
    expect(before.error).toBeNull();

    // Drain twice.
    const d1 = await svc().rpc("webhook_dispatch_drain", { p_max_events: 1000 });
    expect(d1.error).toBeNull();
    const d2 = await svc().rpc("webhook_dispatch_drain", { p_max_events: 1000 });
    expect(d2.error).toBeNull();

    // Exactly one delivery for (endpoint, event) despite two drains.
    const dels = await svc().from("webhook_deliveries").select("id, state, verb").eq("endpoint_id", endpoint).eq("event_id", eventId);
    expect(dels.error).toBeNull();
    expect((dels.data ?? []).length).toBe(1);
    expect(dels.data![0]!.verb).toBe("org.created");

    // Offset advanced to at least our event.
    const after = await svc().from("hq_event_consumers").select("last_event_id").eq("consumer", "outbound_webhooks").maybeSingle();
    expect(Number(after.data?.last_event_id)).toBeGreaterThanOrEqual(eventId);
  });

  it("fan-out does NOT deliver to a PAUSED endpoint", async () => {
    const paused = await mkEndpoint(orgA, { verbs: ["org.created"], active: false });
    const emit = await svc().rpc("hq_emit_event", {
      p_actor_type: "system",
      p_actor_id: "test",
      p_verb: "org.created",
      p_object_type: "org",
      p_object_id: orgA,
      p_correlation_id: randomUUID(),
      p_severity: "info",
      p_payload: {},
    });
    const eventId = Number(emit.data);
    await svc().rpc("webhook_dispatch_drain", { p_max_events: 1000 });
    const dels = await svc().from("webhook_deliveries").select("id").eq("endpoint_id", paused).eq("event_id", eventId);
    expect((dels.data ?? []).length).toBe(0);
  });

  // --- 5. Verify-before-activate (incl. the raw-INSERT bypass, P1) ----------

  it("a raw INSERT of an ACTIVE endpoint is refused — even for an org admin (P1)", async () => {
    // The bypass the review flagged: raw-insert status='active', verified_at=now.
    const asAdminActive = await asAdmin()
      .from("webhook_endpoints")
      .insert({
        org_id: orgA,
        url: `https://hooks.example.com/${randomUUID()}`,
        secret: generateWebhookSecret(),
        event_verbs: ["job.created"],
        status: "active",
        verified_at: new Date().toISOString(),
        created_by: admin.id,
      })
      .select("id")
      .maybeSingle();
    expect(asAdminActive.error, "admin raw-insert of an active endpoint must be refused").not.toBeNull();

    // service_role is refused too (trigger + table CHECK, every role).
    const svcActive = await svc()
      .from("webhook_endpoints")
      .insert({
        org_id: orgA,
        url: `https://hooks.example.com/${randomUUID()}`,
        secret: generateWebhookSecret(),
        event_verbs: ["org.created"],
        status: "active",
        verified_at: new Date().toISOString(),
      })
      .select("id")
      .maybeSingle();
    expect(svcActive.error).not.toBeNull();
  });

  it("a raw INSERT with a supplied verified_at is forced back to NULL (born unverified, P1)", async () => {
    const ins = await svc()
      .from("webhook_endpoints")
      .insert({
        org_id: orgA,
        url: `https://hooks.example.com/${randomUUID()}`,
        secret: generateWebhookSecret(),
        event_verbs: ["org.created"],
        verified_at: new Date().toISOString(), // caller-supplied — must be ignored
      })
      .select("id")
      .single();
    expect(ins.error).toBeNull();
    const row = await svc().from("webhook_endpoints").select("verified_at, status").eq("id", String(ins.data?.id)).maybeSingle();
    expect(row.data?.verified_at).toBeNull(); // forced off at insert
    expect(row.data?.status).toBe("paused");
  });

  it("a raw INSERT with a malformed secret is refused (format CHECK)", async () => {
    const res = await svc()
      .from("webhook_endpoints")
      .insert({
        org_id: orgA,
        url: `https://hooks.example.com/${randomUUID()}`,
        secret: "not-a-valid-secret",
        event_verbs: ["org.created"],
      })
      .select("id")
      .maybeSingle();
    expect(res.error, "malformed secret must be refused").not.toBeNull();
  });

  it("an unverified endpoint cannot be activated (trigger, every role)", async () => {
    const id = await mkEndpoint(orgA, { active: false });
    // Tenant path.
    const tenant = await asAdmin().from("webhook_endpoints").update({ status: "active" }).eq("id", id).select("id");
    expect(tenant.error, "tenant activation of an unverified endpoint must be refused").not.toBeNull();
    // Service-role path is refused too.
    const svcRes = await svc().from("webhook_endpoints").update({ status: "active" }).eq("id", id).select("id");
    expect(svcRes.error).not.toBeNull();
    expect(svcRes.error!.message).toMatch(/cannot be activated/i);
  });

  it("service_role cannot change an endpoint's secret (immutable, all roles)", async () => {
    const id = await mkEndpoint(orgA);
    const res = await svc().from("webhook_endpoints").update({ secret: generateWebhookSecret() }).eq("id", id).select("id");
    expect(res.error).not.toBeNull();
    expect(res.error!.message).toMatch(/secret is immutable/i);
  });
});

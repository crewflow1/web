import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { anonClient, describeIntegration, serviceClient, userClient, ukTodayIso } from "../_harness";
import { generateWebhookSecret } from "@/lib/webhooks/secret";

/**
 * Slice 1.5 — PR 1 regression guard (real Postgres).
 *
 * Proves BOTH sides of every privilege change in
 * supabase/migrations/20261231000000_slice15_pr1_privilege_holes_hygiene.sql:
 *   • each verified attack / excess privilege now FAILS; and
 *   • every legitimate workflow the change touches still SUCCEEDS.
 *
 * Mechanisms used, in order of preference (per the Slice 1.5 directive):
 *   • BEHAVIORAL — drive the real attack/path through the anon/authenticated
 *     client and assert the outcome (the security property itself); and
 *   • CATALOGUE — read the live ACL via the service-role introspection RPCs
 *     (_introspect_client_table_grants + the new _introspect_object_acls) for
 *     objects a client cannot exercise over PostgREST (sequences) or to pin the
 *     exact end-state (views, function EXECUTE). This is a real-DB assertion,
 *     not a source-text scan — same approach as audit-log-grant-lockdown.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(c: string, v: unknown): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Upd extends PromiseLike<Res<null>> {
  eq(c: string, v: unknown): { select(c?: string): PromiseLike<Res<Row[]>> };
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
interface Client {
  from(t: string): Table;
  rpc: Rpc;
}
const db = (c: unknown) => c as unknown as Client;

/** An ACL row from either introspection RPC (table_name OR object_name). */
type AclRow = { table_name?: string; object_name?: string; grantee: string; privilege_type: string };
const clientGrantees = (rows: AclRow[]) =>
  rows.filter((r) => r.grantee === "anon" || r.grantee === "authenticated" || r.grantee === "PUBLIC");
/** A permission/privilege denial (column, table or function) — not an RLS/check error. */
const isPermissionDenied = (e: { message: string; code?: string } | null) =>
  e != null && (/permission denied|not allowed|42501/i.test(e.message) || e.code === "42501");

const T = `it-s15pr1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const SEQUENCES = [
  "api_request_log_id_seq",
  "dead_events_id_seq",
  "hq_ai_executor_shadow_observations_id_seq",
  "hq_application_records_id_seq",
  "hq_apply_audit_id_seq",
  "hq_ceo_briefings_id_seq",
  "hq_embedding_runs_id_seq",
  "hq_events_id_seq",
];
const VIEWS = ["stock_balances", "stock_valuation", "works_quality_plan_status"];
const GOVERNOR_FNS = [
  "ai_reserve_invocation",
  "ai_settle_reservation",
  "ai_release_reservation",
  "ai_set_org_ceiling",
  "ai_clear_org_ceiling",
  "ai_set_employee_limit",
  "ai_clear_employee_limit",
  "ai_employee_month_totals",
  "ai_invocations_month_by_feature",
  "ai_invocations_month_totals",
  "ai_reservations_month_totals",
  "claim_due_maintenance_reminders",
];

describeIntegration("Slice 1.5 PR1 privilege holes + hygiene (real Postgres)", () => {
  let orgA = "";
  let admin = { id: "", token: "" };
  let partnerA = "";
  const createdUserIds: string[] = [];

  const svc = () => db(serviceClient());
  const asAdmin = () => db(userClient(admin.token));
  const asAnon = () => db(anonClient());

  async function mkMember(orgId: string, role: string, tag: string) {
    const email = `${T}-${tag}@x.test`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password: `Pw-${T}`,
      email_confirm: true,
    });
    if (created.error) throw new Error(created.error.message);
    const id = created.data.user?.id ?? "";
    createdUserIds.push(id);
    await svc().from("users").insert({ id, email, full_name: tag });
    await svc().from("memberships").insert({ org_id: orgId, user_id: id, role });
    const s = await anonClient().auth.signInWithPassword({ email, password: `Pw-${T}` });
    if (s.error) throw new Error(s.error.message);
    return { id, token: s.data.session?.access_token ?? "" };
  }

  async function mkEndpoint(orgId: string): Promise<string> {
    const ins = await svc()
      .from("webhook_endpoints")
      .insert({
        org_id: orgId,
        url: `https://hooks.example.com/${randomUUID()}`,
        secret: generateWebhookSecret(),
        event_verbs: ["org.created"],
      })
      .select("id")
      .single();
    if (ins.error) throw new Error(ins.error.message);
    return String(ins.data?.id);
  }

  beforeAll(async () => {
    orgA = String(
      (await svc().from("organizations").insert({ name: "S15 A", slug: `${T}-a` }).select("id").single()).data?.id,
    );
    admin = await mkMember(orgA, "admin", "adm");
    // A partner OWNED by orgA so the owner-insert RLS passes and the column
    // privilege on `status` is the sole gate in the marketplace INSERT attack.
    partnerA = String(
      (
        await svc()
          .from("marketplace_partners")
          .insert({ org_id: orgA, name: "Partner A", slug: `${T}-pa`, created_by: admin.id })
          .select("id")
          .single()
      ).data?.id,
    );
  });

  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    for (const id of createdUserIds) {
      await serviceClient().auth.admin.deleteUser(id).catch(() => undefined);
    }
  });

  // ── A. demo_requests — vestigial anon/authenticated INSERT closed ──────────
  it("A/attack: anon CANNOT insert demo_requests (funnel injection closed)", async () => {
    const res = await asAnon()
      .from("demo_requests")
      .insert({ name: "x", company: "y", email: `${T}@x.test` });
    expect(res.error, "anon could still inject a demo_request").not.toBeNull();
  });
  it("A/attack: authenticated CANNOT insert demo_requests", async () => {
    const res = await asAdmin()
      .from("demo_requests")
      .insert({ name: "x", company: "y", email: `${T}-2@x.test` });
    expect(res.error, "authenticated could still inject a demo_request").not.toBeNull();
  });
  it("A/catalogue: demo_requests carries NO anon/authenticated grant", async () => {
    const res = (await svc().rpc("_introspect_client_table_grants", {
      p_tables: ["demo_requests"],
    })) as Res<AclRow[]>;
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data ?? [], JSON.stringify(res.data)).toHaveLength(0);
  });

  // ── B. marketplace_listings — self-approve via INSERT closed ───────────────
  it("B/attack: owner-admin CANNOT INSERT a listing with status='approved'", async () => {
    const res = await asAdmin()
      .from("marketplace_listings")
      .insert({
        partner_id: partnerA,
        slug: `${T}-l1`,
        name: "L1",
        short_description: "d",
        category: "other",
        requested_scopes: [],
        webhook_events: [],
        created_by: admin.id,
        status: "approved", // the attack: self-approval at creation
      });
    expect(res.error, "owner-admin self-approved a listing via INSERT").not.toBeNull();
    expect(isPermissionDenied(res.error), `expected column-privilege denial, got ${res.error?.message}`).toBe(true);
  });
  it("B/legit: owner-admin CAN still create a draft listing (status defaults 'draft')", async () => {
    const res = await asAdmin()
      .from("marketplace_listings")
      .insert({
        partner_id: partnerA,
        slug: `${T}-l2`,
        name: "L2",
        short_description: "d2",
        category: "other",
        requested_scopes: [],
        webhook_events: [],
        created_by: admin.id,
      })
      .select("id, status")
      .single();
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data?.status).toBe("draft");
  });

  // ── C. marketplace_partners — self-status closed, create behaviour kept ────
  it("C/attack: tenant CANNOT set partner status at INSERT", async () => {
    const res = await asAdmin()
      .from("marketplace_partners")
      .insert({ org_id: orgA, name: "P-attack", slug: `${T}-px`, created_by: admin.id, status: "suspended" });
    expect(res.error, "tenant set partner status at INSERT").not.toBeNull();
    expect(isPermissionDenied(res.error), `expected column-privilege denial, got ${res.error?.message}`).toBe(true);
  });
  it("C/attack: tenant CANNOT UPDATE partner status (self-un-suspend blocked)", async () => {
    const seeded = await svc()
      .from("marketplace_partners")
      .insert({ org_id: orgA, name: "P-susp", slug: `${T}-ps`, created_by: admin.id, status: "suspended" })
      .select("id")
      .single();
    const id = String(seeded.data?.id);
    const res = await asAdmin().from("marketplace_partners").update({ status: "active" }).eq("id", id).select("id");
    expect(res.error, "admin self-un-suspended their partner").not.toBeNull();
    expect(isPermissionDenied(res.error), `expected column-privilege denial, got ${res.error?.message}`).toBe(true);
  });
  it("C/legit: tenant CAN still create a partner (status defaults 'active') and edit its metadata", async () => {
    const created = await asAdmin()
      .from("marketplace_partners")
      .insert({ org_id: orgA, name: "P-ok", slug: `${T}-pok`, created_by: admin.id })
      .select("id, status")
      .single();
    expect(created.error, created.error?.message).toBeNull();
    expect(created.data?.status).toBe("active"); // intended default preserved
    const renamed = await asAdmin()
      .from("marketplace_partners")
      .update({ name: "P-ok renamed" })
      .eq("id", String(created.data?.id))
      .select("id");
    expect(renamed.error, renamed.error?.message).toBeNull();
  });

  // ── D. webhook_endpoints — DELETE now works; secret stays protected ────────
  it("D/legit: an org admin CAN delete their webhook endpoint (grant added)", async () => {
    const id = await mkEndpoint(orgA);
    const res = await asAdmin().from("webhook_endpoints").delete().eq("id", id);
    expect(res.error, `admin could not delete endpoint: ${res.error?.message}`).toBeNull();
    const after = await svc().from("webhook_endpoints").select("id").eq("id", id);
    expect(after.data ?? [], "endpoint was not actually deleted").toHaveLength(0);
  });
  it("D/protect: the webhook secret column stays UNREADABLE by authenticated", async () => {
    const id = await mkEndpoint(orgA);
    const res = await asAdmin().from("webhook_endpoints").select("secret").eq("id", id);
    expect(res.error, "authenticated could read the webhook secret").not.toBeNull();
    await svc().from("webhook_endpoints").delete().eq("id", id);
  });
  it("D/catalogue: webhook_endpoints grants authenticated DELETE", async () => {
    const res = (await svc().rpc("_introspect_client_table_grants", {
      p_tables: ["webhook_endpoints"],
    })) as Res<AclRow[]>;
    expect(res.error, res.error?.message).toBeNull();
    const hasDelete = (res.data ?? []).some((r) => r.grantee === "authenticated" && r.privilege_type === "DELETE");
    expect(hasDelete, "authenticated lacks the DELETE grant").toBe(true);
  });

  // ── E. identity sequences — no client privilege ───────────────────────────
  it("E/catalogue: the 8 identity sequences carry NO anon/authenticated/PUBLIC privilege", async () => {
    const res = (await svc().rpc("_introspect_object_acls", {
      p_kind: "sequence",
      p_names: SEQUENCES,
    })) as Res<AclRow[]>;
    expect(res.error, res.error?.message).toBeNull();
    const leaked = clientGrantees(res.data ?? []);
    expect(leaked, `sequences still client-reachable: ${JSON.stringify(leaked)}`).toHaveLength(0);
  });

  // ── F. over-exposed views — anon denied, authenticated SELECT only ─────────
  it("F/attack: anon CANNOT read the 3 formerly over-exposed views", async () => {
    for (const v of VIEWS) {
      const res = await asAnon().from(v).select("*");
      expect(res.error, `anon could still read view ${v}`).not.toBeNull();
    }
  });
  it("F/catalogue: views grant authenticated SELECT only; no anon/PUBLIC", async () => {
    const res = (await svc().rpc("_introspect_object_acls", { p_kind: "view", p_names: VIEWS })) as Res<AclRow[]>;
    expect(res.error, res.error?.message).toBeNull();
    const rows = res.data ?? [];
    expect(clientGrantees(rows.filter((r) => r.grantee !== "authenticated")), "anon/PUBLIC still on a view").toHaveLength(0);
    for (const v of VIEWS) {
      const authPrivs = rows.filter((r) => r.object_name === v && r.grantee === "authenticated").map((r) => r.privilege_type);
      expect(new Set(authPrivs), `authenticated privileges on ${v}`).toEqual(new Set(["SELECT"]));
    }
  });

  // ── G. governor RPCs — no client EXECUTE ───────────────────────────────────
  it("G/catalogue: the 12 governor RPCs have NO anon/authenticated/PUBLIC EXECUTE (service_role only)", async () => {
    const res = (await svc().rpc("_introspect_object_acls", {
      p_kind: "function",
      p_names: GOVERNOR_FNS,
    })) as Res<AclRow[]>;
    expect(res.error, res.error?.message).toBeNull();
    const rows = res.data ?? [];
    expect(clientGrantees(rows), `governor RPC still client-executable: ${JSON.stringify(clientGrantees(rows))}`).toHaveLength(0);
    // non-vacuity: each function exists and is locked to service_role.
    for (const fn of GOVERNOR_FNS) {
      const svcRow = rows.some((r) => r.object_name === fn && r.grantee === "service_role");
      expect(svcRow, `${fn} not found / not granted to service_role`).toBe(true);
    }
  });
  it("G/attack: authenticated CANNOT execute a governor RPC", async () => {
    const res = await asAdmin().rpc("ai_invocations_month_totals", { p_org_id: orgA, p_month: ukTodayIso() });
    expect(res.error, "authenticated executed a governor RPC").not.toBeNull();
  });
  it("G/attack: anon CANNOT execute a governor RPC", async () => {
    const res = await asAnon().rpc("ai_invocations_month_totals", { p_org_id: orgA, p_month: ukTodayIso() });
    expect(res.error, "anon executed a governor RPC").not.toBeNull();
  });

  // ── H. job-existence RPCs — authenticated kept, anon/PUBLIC dropped ────────
  it("H/catalogue: append/remove_job_photo keep authenticated, drop anon+PUBLIC", async () => {
    const res = (await svc().rpc("_introspect_object_acls", {
      p_kind: "function",
      p_names: ["append_job_photo", "remove_job_photo"],
    })) as Res<AclRow[]>;
    expect(res.error, res.error?.message).toBeNull();
    const rows = res.data ?? [];
    for (const fn of ["append_job_photo", "remove_job_photo"]) {
      const grantees = rows.filter((r) => r.object_name === fn).map((r) => r.grantee);
      expect(grantees, `${fn} lost authenticated EXECUTE`).toContain("authenticated");
      expect(grantees, `${fn} still anon-executable`).not.toContain("anon");
      expect(grantees, `${fn} still PUBLIC-executable`).not.toContain("PUBLIC");
    }
  });
  it("H/attack: anon CANNOT execute append_job_photo (job-existence oracle closed)", async () => {
    const res = await asAnon().rpc("append_job_photo", { target_job_id: randomUUID(), photo_path: "x.jpg" });
    expect(res.error, "anon executed append_job_photo").not.toBeNull();
    expect(isPermissionDenied(res.error), `expected function-permission denial, got ${res.error?.message}`).toBe(true);
  });

  // ── Keep-list — the membership primitives still work for anon ──────────────
  it("keep-list: anon can STILL execute is_org_member / is_org_admin / current_org_ids", async () => {
    const m = await asAnon().rpc("is_org_member", { target_org: orgA });
    expect(m.error, "anon lost EXECUTE on is_org_member (keep-list broken)").toBeNull();
    expect(m.data).toBe(false); // anon is not a member → false, not a denial
    const a = await asAnon().rpc("is_org_admin", { target_org: orgA });
    expect(a.error, "anon lost EXECUTE on is_org_admin").toBeNull();
    const c = await asAnon().rpc("current_org_ids");
    expect(c.error, "anon lost EXECUTE on current_org_ids").toBeNull();
  });
});

import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * PER-COMPANY AI OFF SWITCH on real Postgres (migration 20261366000000, gap G-13).
 *
 * Proves: an OFF company's reservation is refused (block_reason ai_disabled, no
 * reservation row) while an ON company is unaffected; the owner can toggle, staff
 * and non-members cannot; every change is audited; HQ (service-role) can toggle;
 * a non-active company's owner can switch OFF but not back ON.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
const db = (c: unknown) =>
  c as unknown as {
    rpc(fn: string, a: Record<string, unknown>): PromiseLike<Res<Row[]>>;
    from(t: string): {
      select(c: string): { eq(k: string, v: unknown): PromiseLike<Res<Row[]>> };
      insert(r: Row): PromiseLike<Res<null>> & { select(c: string): { single(): PromiseLike<Res<Row>> } };
      delete(): { eq(k: string, v: unknown): PromiseLike<Res<null>> };
      update(r: Row): { eq(k: string, v: unknown): PromiseLike<Res<null>> };
    };
  };

const TOKEN = `it-aioff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("per-company AI off switch · real Postgres", () => {
  let orgA = "", orgB = "", orgHeld = "";
  const users: Record<string, { id: string; token: string }> = {};
  const svc = () => db(serviceClient());

  async function makeUser(label: string) {
    const email = `${TOKEN}-${label}@example.test`;
    const password = `Pw-${TOKEN}-${label}-${Math.random().toString(36).slice(2)}`;
    const c = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
    expect(c.error, c.error?.message).toBeNull();
    const id = c.data.user?.id ?? "";
    const m = await svc().from("users").insert({ id, email, full_name: label }).select("id").single();
    expect(m.error, m.error?.message).toBeNull();
    const s = await anonClient().auth.signInWithPassword({ email, password });
    expect(s.error, s.error?.message).toBeNull();
    users[label] = { id, token: s.data.session?.access_token ?? "" };
  }
  async function makeOrg(name: string, status = "active") {
    const r = await svc().from("organizations").insert({ status, name, slug: `${TOKEN}-${name}` }).select("id").single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }
  async function member(org: string, who: string, role: string) {
    const r = await svc().from("memberships").insert({ org_id: org, user_id: users[who].id, role }).select("user_id").single();
    expect(r.error, r.error?.message).toBeNull();
  }
  async function reserve(org: string) {
    const r = await svc().rpc("ai_reserve_invocation", {
      p_org_id: org, p_feature: "quote.writer_draft", p_task_class: "drafting", p_estimate_pence: 1,
      p_user_id: null, p_content_hash: null, p_ceiling_pence: 10000, p_ttl_seconds: 60, p_dedupe_window_seconds: 0,
    });
    expect(r.error, r.error?.message).toBeNull();
    return (r.data?.[0] ?? {}) as Row;
  }
  const owner = (who: string, org: string, enabled: boolean) =>
    db(userClient(users[who].token)).rpc("ai_owner_set_ai_enabled", { p_org_id: org, p_enabled: enabled });
  async function liveClaims(org: string) {
    const r = await svc().from("ai_cost_reservations").select("id").eq("org_id", org);
    return (r.data ?? []).length;
  }

  beforeAll(async () => {
    orgA = await makeOrg("a");
    orgB = await makeOrg("b");
    orgHeld = await makeOrg("held");
    for (const l of ["ownerA", "staffA", "ownerB", "outsider", "ownerHeld"]) await makeUser(l);
    await member(orgA, "ownerA", "owner");
    await member(orgA, "staffA", "staff");
    await member(orgB, "ownerB", "owner");
    await member(orgHeld, "ownerHeld", "owner");
  });

  afterAll(async () => {
    for (const org of [orgA, orgB, orgHeld]) {
      if (!org) continue;
      await svc().from("ai_cost_reservations").delete().eq("org_id", org);
      const d = await svc().from("organizations").delete().eq("id", org);
      expect(d.error, JSON.stringify(d.error)).toBeNull();
    }
    for (const u of Object.values(users)) await serviceClient().auth.admin.deleteUser(u.id);
  });

  it("default: no row means AI is on and a reservation is granted", async () => {
    expect((await reserve(orgA)).outcome).toBe("reserved");
  });

  it("owner switches OFF: reservation refused with ai_disabled and NO claim row is written", async () => {
    const before = await liveClaims(orgA);
    const r = await owner("ownerA", orgA, false);
    expect(r.error, r.error?.message).toBeNull();
    const row = await reserve(orgA);
    expect(row.outcome).toBe("blocked");
    expect(row.block_reason).toBe("ai_disabled");
    expect(await liveClaims(orgA)).toBe(before);
  });

  it("cross-tenant: company A off does not affect company B", async () => {
    expect((await reserve(orgB)).outcome).toBe("reserved");
  });

  it("owner of B cannot switch A; staff of A cannot; an outsider cannot (42501)", async () => {
    for (const who of ["ownerB", "staffA", "outsider"]) {
      const r = await owner(who, orgA, true);
      expect(r.error?.code, who).toBe("42501");
    }
    expect((await reserve(orgA)).block_reason).toBe("ai_disabled");
  });

  it("anon cannot call the owner RPC or the HQ RPC; authenticated cannot call the HQ RPC", async () => {
    expect((await db(anonClient()).rpc("ai_owner_set_ai_enabled", { p_org_id: orgA, p_enabled: true })).error).not.toBeNull();
    const hq = await db(userClient(users.ownerA.token)).rpc("ai_hq_set_ai_enabled", { p_org_id: orgA, p_enabled: true });
    expect(hq.error).not.toBeNull();
    expect((await reserve(orgA)).block_reason).toBe("ai_disabled");
  });

  it("tenant cannot write the switch table directly; members can read their own row only", async () => {
    const t = db(userClient(users.staffA.token));
    const ins = await t.from("ai_org_switches").insert({ org_id: orgA, ai_enabled: true });
    expect(ins.error).not.toBeNull();
    const upd = await t.from("ai_org_switches").update({ ai_enabled: true }).eq("org_id", orgA);
    expect(upd.error).not.toBeNull();
    expect((await reserve(orgA)).block_reason).toBe("ai_disabled");
    const own = await t.from("ai_org_switches").select("ai_enabled").eq("org_id", orgA);
    expect(own.data).toEqual([{ ai_enabled: false }]);
    const other = await db(userClient(users.ownerB.token)).from("ai_org_switches").select("ai_enabled").eq("org_id", orgA);
    expect(other.data ?? []).toHaveLength(0);
  });

  it("owner switches back ON: reservations resume", async () => {
    const r = await owner("ownerA", orgA, true);
    expect(r.error, r.error?.message).toBeNull();
    expect((await reserve(orgA)).outcome).toBe("reserved");
  });

  it("HQ (service role) can switch a company off; audit records owner and hq changes in order", async () => {
    const hq = await svc().rpc("ai_hq_set_ai_enabled", { p_org_id: orgB, p_enabled: false, p_set_by: null });
    expect(hq.error, hq.error?.message).toBeNull();
    expect((await reserve(orgB)).block_reason).toBe("ai_disabled");
    await svc().rpc("ai_hq_set_ai_enabled", { p_org_id: orgB, p_enabled: true, p_set_by: null });
    expect((await reserve(orgB)).outcome).toBe("reserved");

    const aa = await svc().from("ai_org_switch_audit").select("new_enabled, actor_kind, changed_by").eq("org_id", orgA);
    const kinds = (aa.data ?? []).map((r) => `${r.actor_kind}:${r.new_enabled}`).sort();
    expect(kinds).toEqual(["owner:false", "owner:true"]);
    const ba = await svc().from("ai_org_switch_audit").select("actor_kind").eq("org_id", orgB);
    expect((ba.data ?? []).map((r) => r.actor_kind)).toEqual(["hq", "hq"]);
    // Audit is not tenant-readable.
    const leak = await db(userClient(users.ownerA.token)).from("ai_org_switch_audit").select("id").eq("org_id", orgA);
    expect(leak.data ?? []).toHaveLength(0);
  });

  it("a non-active company's owner can switch AI OFF but not back ON", async () => {
    expect((await owner("ownerHeld", orgHeld, false)).error).toBeNull();
    const held = await svc().from("organizations").update({ status: "suspended" }).eq("id", orgHeld);
    expect(held.error, held.error?.message).toBeNull();
    const on = await owner("ownerHeld", orgHeld, true);
    expect(on.error?.code).toBe("42501");
    expect((await reserve(orgHeld)).block_reason).toBe("ai_disabled");
  });
});

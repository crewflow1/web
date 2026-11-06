import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Push / SMS delivery claim — atomic, SKIP-LOCKED, lease-safe — proved against
 * real Postgres (migration 20261274000000).
 *
 * The defect (F-1 double-send): drainPushQueue / drainSmsQueue SELECTed the
 * queued-and-due rows and then sent them, with no claim in between — so two
 * overlapping drain ticks read the SAME rows and both sent, delivering the
 * push/SMS twice. The fix is an atomic claim RPC (status queued→'sending' under
 * FOR UPDATE ... SKIP LOCKED) run BEFORE sending, mirroring the webhook drain.
 *
 * This is a database race, provable only against real Postgres with genuinely
 * concurrent callers (Promise.all). The observable guarantee: concurrent claims
 * return DISJOINT row sets whose union is every claimable row — i.e. no row is
 * ever handed to two senders, so nothing is sent twice.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
const db = (c: unknown) =>
  c as unknown as {
    from(t: string): {
      insert(r: Row | Row[]): { select(c?: string): { single(): PromiseLike<Res<Row>> } } & PromiseLike<Res<null>>;
      select(c?: string): { eq(k: string, v: unknown): PromiseLike<Res<Row[]>> };
      update(r: Row): { eq(k: string, v: unknown): PromiseLike<Res<null>> };
      delete(): { eq(k: string, v: unknown): PromiseLike<Res<null>> };
    };
    rpc(fn: string, args: Row): PromiseLike<Res<Row[]>>;
  };

const TOKEN = `it-claim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const past = (ms: number) => new Date(Date.now() - ms).toISOString();
const future = (ms: number) => new Date(Date.now() + ms).toISOString();

const insId = async (svc: ReturnType<typeof db>, table: string, row: Row): Promise<string> =>
  String((await svc.from(table).insert(row).select("id").single()).data?.id ?? "");

describeIntegration("push/sms delivery claim · concurrency + lease", () => {
  const svc = db(serviceClient());
  let orgId = "";
  let userId = "";
  let notifId = "";

  beforeAll(async () => {
    orgId = await insId(svc, "organizations", { name: "Claim Org", slug: `${TOKEN}-org` });
    const created = await serviceClient().auth.admin.createUser({
      email: `${TOKEN}@example.test`,
      password: `Pw-${TOKEN}`,
      email_confirm: true,
    });
    userId = created.data.user?.id ?? "";
    await svc.from("users").insert({ id: userId, email: `${TOKEN}@example.test`, full_name: "Claim User" });
    await svc.from("memberships").insert({ org_id: orgId, user_id: userId, role: "owner" });
    notifId = await insId(svc, "notifications", { org_id: orgId, type: "job_update", title: "Claim probe" });
    if (!orgId || !userId || !notifId) throw new Error("fixture setup failed");
  });

  afterAll(async () => {
    if (orgId) {
      const del = await svc.from("organizations").delete().eq("id", orgId);
      expect(del.error, `org teardown: ${JSON.stringify(del.error)}`).toBeNull();
    }
    if (userId) await serviceClient().auth.admin.deleteUser(userId);
  });

  // push_deliveries + sms_deliveries are structurally identical; prove both.
  for (const [table, rpc] of [
    ["push_deliveries", "push_claim_deliveries"],
    ["sms_deliveries", "sms_claim_deliveries"],
  ] as const) {
    describe(`${table} · ${rpc}`, () => {
      const extra = (over: Row = {}): Row =>
        table === "sms_deliveries" ? { to_phone: "+447700900000", ...over } : over;

      // push/sms_deliveries are UNIQUE (notification_id, user_id), so each queued
      // delivery for one user needs its own notification row.
      const seedQueued = async (n: number, scheduledFor: string): Promise<Set<string>> => {
        const ids = new Set<string>();
        for (let i = 0; i < n; i++) {
          const nid = await insId(svc, "notifications", { org_id: orgId, type: "job_update", title: `probe ${i}` });
          const id = await insId(svc, table, extra({
            notification_id: nid, org_id: orgId, user_id: userId,
            category: "job_update", status: "queued", scheduled_for: scheduledFor,
          }));
          expect(id, "seed delivery insert must succeed").not.toBe("");
          ids.add(id);
        }
        return ids;
      };

      // Seed a single 'sending' row with an explicit updated_at. The
      // set_updated_at trigger is BEFORE UPDATE only (it does NOT fire on
      // INSERT), so the lease clock is set verbatim here — the same technique
      // the webhook stale-reclaim test uses. Returns the row id.
      const seedSending = async (updatedAt: string): Promise<string> => {
        const nid = await insId(svc, "notifications", { org_id: orgId, type: "job_update", title: "sending probe" });
        const id = await insId(svc, table, extra({
          notification_id: nid, org_id: orgId, user_id: userId, category: "job_update",
          status: "sending", scheduled_for: past(60_000), updated_at: updatedAt,
        }));
        expect(id, "seed sending insert must succeed").not.toBe("");
        return id;
      };

      beforeEach(async () => {
        await svc.from(table).delete().eq("org_id", orgId);
      });

      it("two SIMULTANEOUS claims return DISJOINT rows (no row sent twice)", async () => {
        const seeded = await seedQueued(20, past(60_000));
        const [a, b] = await Promise.all([
          svc.rpc(rpc, { p_limit: 50 }),
          svc.rpc(rpc, { p_limit: 50 }),
        ]);
        expect(a.error, a.error?.message).toBeNull();
        expect(b.error, b.error?.message).toBeNull();
        const aIds = (a.data ?? []).map((r) => String(r.id));
        const bIds = (b.data ?? []).map((r) => String(r.id));
        // No overlap — the core double-send guarantee.
        expect(aIds.filter((id) => bIds.includes(id))).toHaveLength(0);
        // Together they cover every seeded row exactly once.
        const union = new Set([...aIds, ...bIds]);
        expect(union).toEqual(seeded);
        expect(aIds.length + bIds.length).toBe(20);
      });

      it("claims flip rows to 'sending' (claimed, not re-claimable)", async () => {
        await seedQueued(5, past(60_000));
        const first = await svc.rpc(rpc, { p_limit: 50 });
        expect((first.data ?? [])).toHaveLength(5);
        // All now 'sending'; a second claim (fresh lease) sees nothing.
        const second = await svc.rpc(rpc, { p_limit: 50 });
        expect((second.data ?? [])).toHaveLength(0);
        const rows = await svc.from(table).select("status").eq("org_id", orgId);
        expect((rows.data ?? []).every((r) => r.status === "sending")).toBe(true);
      });

      it("does NOT claim a row scheduled for the future", async () => {
        await seedQueued(3, future(600_000));
        const r = await svc.rpc(rpc, { p_limit: 50 });
        expect((r.data ?? [])).toHaveLength(0);
      });

      it("does NOT reclaim a 'sending' row while its lease is fresh", async () => {
        await seedSending(past(60_000)); // claimed 1 min ago — inside the 5-min lease
        const r = await svc.rpc(rpc, { p_limit: 50 });
        expect((r.data ?? [])).toHaveLength(0); // active lease — not stealable
      });

      it("RECLAIMS a 'sending' row whose lease expired (crashed tick)", async () => {
        const id = await seedSending(past(6 * 60_000)); // 6 min ago — past the 5-min lease
        const r = await svc.rpc(rpc, { p_limit: 50 });
        expect((r.data ?? []).map((x) => String(x.id))).toEqual([id]); // reclaimed
      });

      it("an expired-lease row is reclaimed by EXACTLY ONE of concurrent callers", async () => {
        await seedSending(past(6 * 60_000));
        const results = await Promise.all([
          svc.rpc(rpc, { p_limit: 50 }),
          svc.rpc(rpc, { p_limit: 50 }),
          svc.rpc(rpc, { p_limit: 50 }),
        ]);
        const winners = results.filter((r) => (r.data ?? []).length === 1);
        expect(winners).toHaveLength(1);
      });

      it("respects p_limit (partial claim leaves the rest queued)", async () => {
        await seedQueued(10, past(60_000));
        const r = await svc.rpc(rpc, { p_limit: 4 });
        expect((r.data ?? [])).toHaveLength(4);
        // The other 6 of THIS org's rows remain queued for the next tick.
        const rows = await svc.from(table).select("status").eq("org_id", orgId);
        const queued = (rows.data ?? []).filter((x) => x.status === "queued").length;
        expect(queued).toBe(6);
      });
    });
  }
});

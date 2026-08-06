import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { describeIntegration, serviceClient } from "../_harness";
import { generateWebhookSecret } from "@/lib/webhooks/secret";

/**
 * Train A outbound webhooks — the stranded-'delivering' reclaim, proved against
 * real Postgres (migration 20261115000000).
 *
 * THE DEFECT THIS FILE PINS.
 *   The only exits from 'delivering' are webhook_mark_delivered / _mark_failed,
 *   written by the sequential delivery pass AFTER a row's POST resolves. If that
 *   pass crashes / redeploys / is killed by the cron maxDuration mid-flight, its
 *   already-claimed rows were stranded in 'delivering' FOREVER — no lease, no
 *   sweeper — and because fan-out is ON CONFLICT (endpoint_id, event_id) DO
 *   NOTHING, the event was silently, permanently lost.
 *
 * THE FIX. webhook_claim_deliveries now ALSO claims a 'delivering' row whose
 * updated_at is older than the 5-minute lease, alongside the existing pending
 * path. updated_at is stamped = now() on every claim, so the lease is measured
 * from claim time and an actively-delivering row is never stolen.
 *
 * These are state-transition proofs, not RLS proofs, so everything is asserted
 * through the service-role client (the role the real delivery pass uses). Rows
 * are inserted directly with a back-dated updated_at — the set_updated_at trigger
 * is BEFORE UPDATE only, so an INSERT preserves the timestamp we need.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(c: string, v: unknown): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(c?: string): { single(): PromiseLike<Res<Row>>; maybeSingle(): PromiseLike<Res<Row>> };
}
interface Upd extends PromiseLike<Res<null>> {
  eq(c: string, v: unknown): Upd;
  select(c?: string): PromiseLike<Res<Row[]>>;
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

/** Must match the lease cutoff baked into webhook_claim_deliveries (5 minutes). */
const LEASE_MS = 5 * 60 * 1000;

const T = `it-wh-reclaim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("Train A webhook reclaim · stranded 'delivering' (real Postgres)", () => {
  let orgId = "";
  let endpointId = "";
  const svc = () => db(serviceClient());

  const claim = async (limit = 50): Promise<Set<string>> => {
    const res = await svc().rpc("webhook_claim_deliveries", { p_limit: limit });
    expect(res.error, res.error?.message).toBeNull();
    const rows = (res.data ?? []) as Array<{ delivery_id: string }>;
    return new Set(rows.map((r) => r.delivery_id));
  };

  const claimRows = async (limit = 50): Promise<Array<Record<string, unknown>>> => {
    const res = await svc().rpc("webhook_claim_deliveries", { p_limit: limit });
    expect(res.error, res.error?.message).toBeNull();
    return (res.data ?? []) as Array<Record<string, unknown>>;
  };

  /** Insert one delivery row verbatim (INSERT preserves the given timestamps). */
  const insertDelivery = async (row: Record<string, unknown>): Promise<string> => {
    const id = randomUUID();
    const ins = await svc()
      .from("webhook_deliveries")
      .insert({ id, org_id: orgId, endpoint_id: endpointId, ...row })
      .select("id")
      .single();
    expect(ins.error, ins.error?.message).toBeNull();
    return id;
  };

  const stateOf = async (id: string): Promise<Record<string, unknown> | null> => {
    const res = await svc()
      .from("webhook_deliveries")
      .select("id, state, attempt, updated_at")
      .eq("id", id)
      .maybeSingle();
    expect(res.error, res.error?.message).toBeNull();
    return res.data;
  };

  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  beforeAll(async () => {
    const org = await svc()
      .from("organizations")
      .insert({ name: "WH Reclaim", slug: `${T}-org` })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    orgId = String(org.data?.id);

    // Endpoint is born paused/unverified; promote via the sanctioned NULL→ts path.
    const ep = await svc()
      .from("webhook_endpoints")
      .insert({
        org_id: orgId,
        url: `https://hooks.example.com/${randomUUID()}`,
        secret: generateWebhookSecret(),
        event_verbs: ["org.created"],
      })
      .select("id")
      .single();
    expect(ep.error, ep.error?.message).toBeNull();
    endpointId = String(ep.data?.id);
    const up = await svc()
      .from("webhook_endpoints")
      .update({ verified_at: new Date().toISOString(), status: "active" })
      .eq("id", endpointId)
      .select("id");
    expect(up.error, up.error?.message).toBeNull();
  });

  afterAll(async () => {
    if (orgId) await svc().from("organizations").delete().eq("id", orgId);
  });

  // Each delivery uses a distinct event_id (unique(endpoint_id, event_id)).
  let eventSeq = 1;
  const nextEvent = () => eventSeq++;

  // -------------------------------------------------------------------
  // The core reclaim
  // -------------------------------------------------------------------

  it("a 'delivering' row past the lease cutoff IS re-claimed (the stranded-event fix)", async () => {
    const stranded = await insertDelivery({
      event_id: nextEvent(),
      verb: "org.created",
      payload: {},
      state: "delivering",
      next_attempt_at: iso(10 * 60_000),
      updated_at: iso(LEASE_MS + 60_000), // 1 min past the lease
      created_at: iso(10 * 60_000),
    });

    const claimed = await claim();
    expect(claimed.has(stranded), "stranded delivering row must be reclaimed").toBe(true);

    // Re-stamped: still 'delivering', but the lease is renewed to now.
    const after = await stateOf(stranded);
    expect(after?.state).toBe("delivering");
    expect(Date.parse(String(after?.updated_at))).toBeGreaterThan(Date.now() - LEASE_MS);
  });

  it("a freshly-claimed 'delivering' row (lease still live) is NOT stolen", async () => {
    const active = await insertDelivery({
      event_id: nextEvent(),
      verb: "org.created",
      payload: {},
      state: "delivering",
      next_attempt_at: iso(10 * 60_000),
      updated_at: iso(60_000), // 1 min ago — well within the 5-min lease
      created_at: iso(10 * 60_000),
    });

    const claimed = await claim();
    expect(claimed.has(active), "an active lease must be left alone").toBe(false);
  });

  it("reclaim PRESERVES the attempt counter (retry ceiling stays intact)", async () => {
    const stranded = await insertDelivery({
      event_id: nextEvent(),
      verb: "org.created",
      payload: {},
      attempt: 3,
      state: "delivering",
      next_attempt_at: iso(10 * 60_000),
      updated_at: iso(LEASE_MS + 60_000),
      created_at: iso(10 * 60_000),
    });

    const rows = await claimRows();
    const mine = rows.find((r) => r.delivery_id === stranded);
    expect(mine, "reclaimed row must be returned").toBeTruthy();
    expect(Number(mine?.attempt)).toBe(3); // claim never touches attempt
    const after = await stateOf(stranded);
    expect(Number(after?.attempt)).toBe(3);
  });

  // -------------------------------------------------------------------
  // Existing pending behaviour is untouched
  // -------------------------------------------------------------------

  it("a due 'pending' row is still claimed (existing behaviour preserved)", async () => {
    const pending = await insertDelivery({
      event_id: nextEvent(),
      verb: "org.created",
      payload: {},
      state: "pending",
      next_attempt_at: iso(60_000), // due
      created_at: iso(60_000),
    });
    const claimed = await claim();
    expect(claimed.has(pending)).toBe(true);
    expect((await stateOf(pending))?.state).toBe("delivering");
  });

  it("a NOT-yet-due 'pending' row is still left alone (backoff schedule honoured)", async () => {
    const future = await insertDelivery({
      event_id: nextEvent(),
      verb: "org.created",
      payload: {},
      state: "pending",
      next_attempt_at: new Date(Date.now() + 60 * 60_000).toISOString(), // 1h out
      created_at: iso(60_000),
    });
    const claimed = await claim();
    expect(claimed.has(future)).toBe(false);
    expect((await stateOf(future))?.state).toBe("pending");
  });

  it("terminal rows ('delivered'/'dead') are never reclaimed regardless of age", async () => {
    const delivered = await insertDelivery({
      event_id: nextEvent(),
      verb: "org.created",
      payload: {},
      state: "delivered",
      next_attempt_at: iso(10 * 60_000),
      updated_at: iso(LEASE_MS * 10),
      created_at: iso(10 * 60_000),
    });
    const dead = await insertDelivery({
      event_id: nextEvent(),
      verb: "org.created",
      payload: {},
      state: "dead",
      next_attempt_at: iso(10 * 60_000),
      updated_at: iso(LEASE_MS * 10),
      created_at: iso(10 * 60_000),
    });
    const claimed = await claim();
    expect(claimed.has(delivered)).toBe(false);
    expect(claimed.has(dead)).toBe(false);
  });
});

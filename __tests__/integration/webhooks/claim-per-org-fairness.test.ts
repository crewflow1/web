import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { describeIntegration, serviceClient } from "../_harness";
import { generateWebhookSecret } from "@/lib/webhooks/secret";

/**
 * Outbound-webhook claim — per-org fairness, proved against real Postgres
 * (migration 20261176000000).
 *
 * THE DEFECT THIS FILE PINS.
 *   webhook_claim_deliveries used to claim the p_limit chronologically earliest
 *   due deliveries ACROSS ALL ORGS. An org that queued a big simultaneous burst
 *   with EARLIER next_attempt_at filled the whole batch, starving a tail org's
 *   later-but-due delivery for ceil(burst/limit) passes.
 *
 * THE FIX. The claim now ranks each org's due rows by recency and claims in rank
 * order (every org's oldest first, then each org's second, …), so one org's burst
 * can no longer monopolise a pass. Locking (FOR UPDATE … SKIP LOCKED on the base
 * table) is unchanged.
 *
 * The proof: org A queues a burst that is ENTIRELY older than org B's single
 * delivery, then we claim a limit SMALLER than A's burst. Under the old global
 * FIFO, B (being newest) is never in the batch. Under fair interleaving, B — as
 * the rank-1 row of its org — is claimed in the very first pass.
 *
 * State-transition proof via the service-role client (the role the delivery pass
 * uses). Rows are inserted directly with back-dated next_attempt_at (INSERT
 * preserves timestamps; the set_updated_at trigger is BEFORE UPDATE only).
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

const T = `it-wh-fair-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("outbound webhook claim · per-org fairness (real Postgres)", () => {
  const svc = () => db(serviceClient());
  let orgA = "";
  let orgB = "";
  let epA = "";
  let epB = "";
  let eventSeq = 1;
  const nextEvent = () => eventSeq++;
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  const makeOrgWithEndpoint = async (label: string): Promise<{ org: string; ep: string }> => {
    const org = await svc()
      .from("organizations")
      .insert({ name: label, slug: `${T}-${label}` })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    const org_id = String(org.data?.id);
    const ep = await svc()
      .from("webhook_endpoints")
      .insert({
        org_id,
        url: `https://hooks.example.com/${randomUUID()}`,
        secret: generateWebhookSecret(),
        event_verbs: ["org.created"],
      })
      .select("id")
      .single();
    expect(ep.error, ep.error?.message).toBeNull();
    const ep_id = String(ep.data?.id);
    const up = await svc()
      .from("webhook_endpoints")
      .update({ verified_at: new Date().toISOString(), status: "active" })
      .eq("id", ep_id)
      .select("id");
    expect(up.error, up.error?.message).toBeNull();
    return { org: org_id, ep: ep_id };
  };

  const insertDelivery = async (
    org_id: string,
    endpoint_id: string,
    nextAttemptIso: string,
  ): Promise<string> => {
    const id = randomUUID();
    const ins = await svc()
      .from("webhook_deliveries")
      .insert({
        id,
        org_id,
        endpoint_id,
        event_id: nextEvent(),
        verb: "org.created",
        payload: { hello: "world" },
        state: "pending",
        next_attempt_at: nextAttemptIso,
      })
      .select("id")
      .single();
    expect(ins.error, ins.error?.message).toBeNull();
    return id;
  };

  const claimRows = async (limit: number): Promise<Array<{ delivery_id: string; org_id: string }>> => {
    const res = await svc().rpc("webhook_claim_deliveries", { p_limit: limit });
    expect(res.error, res.error?.message).toBeNull();
    return (res.data ?? []) as Array<{ delivery_id: string; org_id: string }>;
  };

  beforeAll(async () => {
    const a = await makeOrgWithEndpoint("orgA");
    const b = await makeOrgWithEndpoint("orgB");
    orgA = a.org;
    epA = a.ep;
    orgB = b.org;
    epB = b.ep;

    // Org A: a burst of 8 deliveries, ALL older (more overdue) than org B's one.
    for (let i = 0; i < 8; i++) {
      await insertDelivery(orgA, epA, iso(60_000 - i * 1_000)); // 60s..53s ago
    }
    // Org B: a single delivery, NEWER than every A row (only 5s overdue).
    await insertDelivery(orgB, epB, iso(5_000));
  });

  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (orgB) await svc().from("organizations").delete().eq("id", orgB);
  });

  it("serves the tail org in the first pass despite a larger, older burst (no starvation)", async () => {
    // Claim FEWER than org A's burst. Old global-FIFO would return 4 org-A rows
    // and zero org-B rows (B is the newest of all). Fair interleaving must include
    // org B (its rank-1 row) in this same pass.
    const rows = await claimRows(4);
    const orgs = new Set(rows.map((r) => r.org_id));
    expect(rows.length).toBeGreaterThan(0);
    expect(orgs.has(orgB), "tail org B must be claimed in the first pass").toBe(true);
    expect(orgs.has(orgA), "org A is also served").toBe(true);
    // No row is claimed twice.
    expect(new Set(rows.map((r) => r.delivery_id)).size).toBe(rows.length);
  });
});

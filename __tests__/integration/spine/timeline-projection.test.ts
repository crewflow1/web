import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * The Pulse — real-Postgres proof of PR5 (the HQ Timeline projection).
 *
 * PR5 lands the FIRST read-model on the spine: a CQRS projection (hq_timeline)
 * fed by ONE new branch on the PR3 consumer seam, plus three SECURITY DEFINER
 * read RPCs. This tier proves the BEHAVIOUR a mock cannot — against a LIVE
 * database with the real migration applied:
 *   1. it ships DARK — with the global drain gate off, the projection stays empty;
 *   2. with the gate on, draining projects a FAITHFUL copy of each event, with the
 *      generated `namespace` (verb prefix) computed by the table;
 *   3. the apply is IDEMPOTENT — a re-drain projects nothing new, no duplicate row;
 *   4. the read RPCs work end-to-end: newest-first keyset pagination, the
 *      namespace / severity / actor / full-text filters, the correlation chain,
 *      and the facet counts;
 *   5. REPLAY is deterministic — hq_timeline_reset() truncates + rewinds to 0, and
 *      a redrive rebuilds a byte-identical view from history (the disposable-view
 *      oracle the whole CQRS design rests on).
 *
 * Events are written through the PR1 entry point hq_emit_event; the real
 * `timeline` consumer (registered at offset 0 by the migration) projects them.
 * Runs only against a live DB (describeIntegration); the integration config runs
 * files serially, so flipping the shared drain gate here can't race the other
 * spine suites. We return the gate to DARK on teardown.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Thenable<T> = PromiseLike<Res<T>>;
interface Sel extends Thenable<Record<string, unknown>[]> {
  eq(column: string, value: unknown): Sel;
}
interface Upd extends Thenable<null> {
  eq(column: string, value: unknown): Upd;
}
interface Table {
  select(columns?: string): Sel;
  update(patch: Record<string, unknown>): Upd;
}
interface Client {
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Thenable<T>;
  from(table: string): Table;
}
const svc = (): Client => serviceClient() as unknown as Client;

const CONSUMER = "timeline";

// An all-letters token, unique per run, so a full-text search scopes cleanly to
// THIS suite's events regardless of what else the shared DB holds. (Letters only:
// the 'english' tsvector parser keeps a pure-alpha word as one lexeme.)
function alpha(n: number): string {
  const a = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}
const TOKEN = `pulseit${alpha(10)}`;

type DrainSummary = {
  consumer: string;
  processed?: number;
  new_offset?: number;
  stopped?: string | null;
  skipped?: string;
};
type Cursor = { ts: string; event_id: number } | null;
type Page = { items: Record<string, unknown>[]; next_cursor: Cursor };
type Detail = { event: Record<string, unknown>; correlation: Record<string, unknown>[] } | null;
type Facets = {
  total: number;
  namespaces: Record<string, number>;
  severities: Record<string, number>;
  actor_types: Record<string, number>;
};

/** Emit one event through the PR1 validated entry point; returns its bigint id. */
async function emit(over: Record<string, unknown> = {}): Promise<number> {
  const res = await svc().rpc<number | string>("hq_emit_event", {
    p_actor_type: "system",
    p_actor_id: "pr5-pulse-it",
    p_verb: "system.cron_ran",
    p_object_type: "system",
    p_object_id: "pr5-it",
    p_correlation_id: crypto.randomUUID(),
    ...over,
  });
  expect(res.error, res.error?.message).toBeNull();
  return Number(res.data);
}

async function maxEventId(): Promise<number> {
  const res = await svc().rpc<{ max_event_id: number }>("hq_spine_golden_signals");
  expect(res.error, res.error?.message).toBeNull();
  return Number((res.data as { max_event_id: number }).max_event_id);
}

async function drain(): Promise<DrainSummary> {
  const res = await svc().rpc<DrainSummary>("hq_drain_consumer", {
    p_consumer: CONSUMER,
    p_max_events: 500,
    p_max_attempts: 5,
  });
  expect(res.error, res.error?.message).toBeNull();
  return res.data as DrainSummary;
}

/** Drain repeatedly until the consumer is caught up (the gate must be ON). */
async function drainAll(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const res = await drain();
    expect(res.skipped, "gate must be on for drainAll").toBeUndefined();
    if ((res.processed ?? 0) === 0 && !res.stopped) return;
  }
  throw new Error("drainAll did not converge");
}

async function page(args: {
  limit?: number;
  beforeTs?: string | null;
  beforeId?: number | null;
  namespaces?: string[] | null;
  severities?: string[] | null;
  actorTypes?: string[] | null;
  search?: string | null;
} = {}): Promise<Page> {
  const res = await svc().rpc<Page>("hq_timeline_page", {
    p_limit: args.limit ?? 50,
    p_before_ts: args.beforeTs ?? null,
    p_before_id: args.beforeId ?? null,
    p_namespaces: args.namespaces ?? null,
    p_severities: args.severities ?? null,
    p_actor_types: args.actorTypes ?? null,
    p_search: args.search ?? null,
  });
  expect(res.error, res.error?.message).toBeNull();
  return res.data as Page;
}

const ids = (p: Page): number[] => p.items.map((i) => Number(i.event_id));

/** Ascending ids of every projected row matching THIS suite's token. */
async function idsForToken(): Promise<number[]> {
  return ids(await page({ limit: 200, search: TOKEN })).sort((a, b) => a - b);
}

async function eventDetail(id: number): Promise<Detail> {
  const res = await svc().rpc<Detail>("hq_timeline_event", { p_event_id: id });
  expect(res.error, res.error?.message).toBeNull();
  return (res.data as Detail) ?? null;
}

async function facets(): Promise<Facets> {
  const res = await svc().rpc<Facets>("hq_timeline_facets");
  expect(res.error, res.error?.message).toBeNull();
  return res.data as Facets;
}

async function resetProjection(): Promise<Record<string, unknown>> {
  const res = await svc().rpc<Record<string, unknown>>("hq_timeline_reset");
  expect(res.error, res.error?.message).toBeNull();
  return res.data as Record<string, unknown>;
}

async function offset(): Promise<number> {
  const res = await svc()
    .from("hq_event_consumers")
    .select("last_event_id")
    .eq("consumer", CONSUMER);
  expect(res.error, res.error?.message).toBeNull();
  return Number((res.data?.[0] as { last_event_id: number } | undefined)?.last_event_id ?? -1);
}

async function timelineRow(id: number): Promise<Record<string, unknown> | null> {
  const res = await svc().from("hq_timeline").select("*").eq("event_id", id);
  expect(res.error, res.error?.message).toBeNull();
  return (res.data?.[0] as Record<string, unknown> | undefined) ?? null;
}

async function timelineCount(): Promise<number> {
  const res = await svc().from("hq_timeline").select("event_id");
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? []).length;
}

/** Flip the global consumer gate, preserving the rest of the hq_settings blob. */
async function setConsumerEnabled(on: boolean): Promise<void> {
  const cur = await svc().from("hq_settings").select("data").eq("id", "singleton");
  expect(cur.error, cur.error?.message).toBeNull();
  const data = ((cur.data?.[0] as { data?: Record<string, unknown> } | undefined)?.data ??
    {}) as Record<string, unknown>;
  const next = {
    ...data,
    event_spine: {
      ...((data.event_spine as Record<string, unknown>) ?? {}),
      consumer_enabled: on,
    },
  };
  const upd = await svc().from("hq_settings").update({ data: next }).eq("id", "singleton");
  expect(upd.error, upd.error?.message).toBeNull();
}

describeIntegration("HQ Event Spine · the Pulse timeline projection (PR5)", () => {
  // Ids emitted by this suite. e1+e2 share a correlation; e3 stands alone.
  let corr = "";
  let e1 = 0;
  let e2 = 0;
  let e3 = 0;

  beforeAll(async () => {
    await setConsumerEnabled(false);
  });

  afterAll(async () => {
    await setConsumerEnabled(false);
  });

  it("ships DARK — gate off: a freshly-emitted event is NOT projected", async () => {
    await setConsumerEnabled(false);
    const dark = await emit({ p_object_id: `dark-${TOKEN}` });
    const res = await drain();
    expect(res.skipped).toBe("consumer_disabled");
    expect(await timelineRow(dark)).toBeNull();
  });

  it("gate on — drains and projects a FAITHFUL copy, with the namespace generated", async () => {
    await setConsumerEnabled(true);

    corr = crypto.randomUUID();
    e1 = await emit({
      p_actor_type: "human",
      p_actor_id: "op@pulse.it",
      p_verb: "customer.created",
      p_object_type: "customer",
      p_object_id: `cust-${TOKEN}`,
      p_severity: "info",
      p_correlation_id: corr,
      p_payload: { name: "Jane", company: "Acme Ltd", token: TOKEN },
    });
    e2 = await emit({
      p_actor_type: "system",
      p_verb: "invoice.paid",
      p_object_type: "invoice",
      p_object_id: `inv-${TOKEN}`,
      p_severity: "success",
      p_correlation_id: corr,
      p_payload: { number: "INV-1", total: 1200, token: TOKEN },
    });
    e3 = await emit({
      p_actor_type: "ai_employee",
      p_actor_id: "research-ai",
      p_verb: "ai.run_failed",
      p_object_type: "ai_employee",
      p_object_id: `ai-${TOKEN}`,
      p_severity: "critical",
      p_payload: { token: TOKEN },
    });

    await drainAll();

    const row = await timelineRow(e1);
    expect(row).not.toBeNull();
    expect(row?.verb).toBe("customer.created");
    expect(row?.namespace).toBe("customer"); // GENERATED from the verb prefix
    expect(row?.severity).toBe("info");
    expect(row?.actor_type).toBe("human");
    expect(row?.object_id).toBe(`cust-${TOKEN}`);
    expect(row?.correlation_id).toBe(corr);
    expect((row?.payload as Record<string, unknown>)?.company).toBe("Acme Ltd");
    expect(row?.projected_at).toBeTruthy();

    // All three are now in the projection.
    for (const id of [e1, e2, e3]) expect(await timelineRow(id)).not.toBeNull();
    expect(await offset()).toBe(await maxEventId()); // caught up to the head
  });

  it("the apply is IDEMPOTENT — an immediate re-drain projects nothing new", async () => {
    const before = await idsForToken();
    const res = await drain();
    expect(res.processed ?? 0).toBe(0);
    const after = await idsForToken();
    expect(after).toEqual(before);
    // event_id is the PK, so each event appears exactly once (no dup on re-apply).
    expect(new Set(after).size).toBe(after.length);
  });

  it("the feed RPC is newest-first and keyset-paginates without overlap or gaps", async () => {
    const full = await page({ search: TOKEN });
    expect(ids(full)).toEqual([e3, e2, e1]); // ts desc, id desc (ids increase with time)

    const first = await page({ limit: 2, search: TOKEN });
    expect(ids(first)).toEqual([e3, e2]);
    expect(first.next_cursor).not.toBeNull();

    const second = await page({
      limit: 2,
      search: TOKEN,
      beforeTs: first.next_cursor?.ts ?? null,
      beforeId: first.next_cursor?.event_id ?? null,
    });
    expect(ids(second)).toEqual([e1]);
    expect(second.next_cursor).toBeNull(); // last page

    // The two pages together cover the set exactly once.
    expect([...ids(first), ...ids(second)].sort((a, b) => a - b)).toEqual([e1, e2, e3]);
  });

  it("the namespace / severity / actor filters each narrow to the right event", async () => {
    expect(ids(await page({ search: TOKEN, namespaces: ["invoice"] }))).toEqual([e2]);
    expect(ids(await page({ search: TOKEN, severities: ["critical"] }))).toEqual([e3]);
    expect(ids(await page({ search: TOKEN, actorTypes: ["ai_employee"] }))).toEqual([e3]);
    // AND-combined: a contradiction yields nothing, never an error.
    expect(ids(await page({ search: TOKEN, namespaces: ["invoice"], severities: ["critical"] }))).toEqual(
      [],
    );
  });

  it("the event RPC returns the full correlation chain in causal order", async () => {
    const detail = await eventDetail(e1);
    expect(detail).not.toBeNull();
    expect(Number(detail?.event.event_id)).toBe(e1);
    const chain = (detail?.correlation ?? []).map((c) => Number(c.event_id));
    expect(chain).toEqual([e1, e2]); // shared correlation, ts asc / id asc
    expect(chain).not.toContain(e3); // a different correlation
  });

  it("an unknown id returns null (the drawer renders its own not-found state)", async () => {
    expect(await eventDetail(-1)).toBeNull();
  });

  it("the facets RPC counts the projection by namespace / severity / actor", async () => {
    const f = await facets();
    expect(f.total).toBeGreaterThanOrEqual(3);
    expect(f.namespaces.customer ?? 0).toBeGreaterThanOrEqual(1);
    expect(f.namespaces.invoice ?? 0).toBeGreaterThanOrEqual(1);
    expect(f.namespaces.ai ?? 0).toBeGreaterThanOrEqual(1);
    expect(f.severities.critical ?? 0).toBeGreaterThanOrEqual(1);
    expect(f.actor_types.ai_employee ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("REPLAY is deterministic — reset (truncate + rewind to 0) then redrive rebuilds an identical view", async () => {
    const before = await idsForToken();
    expect(before).toEqual([e1, e2, e3]);

    const summary = await resetProjection();
    expect(summary.reset).toBe(true);
    expect(await timelineCount()).toBe(0); // truncated
    expect(await offset()).toBe(0); // rewound to the beginning

    await drainAll(); // redrive the ENTIRE history from 0

    const after = await idsForToken();
    expect(after).toEqual(before); // byte-identical oracle — the view is disposable
  });
});

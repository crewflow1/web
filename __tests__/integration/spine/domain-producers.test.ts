import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * HQ Event Spine — real-Postgres proof of PR2 (Domain Event Producers).
 *
 * PR2 generalises public._record_activity() so that every domain mutation which
 * already writes activity_log ALSO emits the canonical hq_events row — in the
 * SAME transaction (D1, Ch.04 transactional outbox). This tier proves the
 * BEHAVIOUR a mock cannot: against a LIVE database, with the real triggers and
 * the real migration applied, that
 *   1. it ships DARK — with the flag off, a mutation logs activity but emits no
 *      event (so applying PR2 changes nothing until an operator opts in);
 *   2. with the flag on, the curated OPERATIONS verbs are mirrored, each in the
 *      same statement as the state change (a single INSERT and its AFTER trigger
 *      are one transaction — "state and narrative are inseparable", P1);
 *   3. actions OUTSIDE the curated subset (customer.deleted, a job → 'blocked'
 *      status change, quote.created) are deliberately NOT mirrored;
 *   4. activity_log is written identically either way (backwards compatible).
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no
 * database, FAILED loudly in CI if the database is missing.
 *
 * Note: hq_events is append-only, so these tests intentionally leave their event
 * rows behind — harmless in the ephemeral CI database. We DO drop the seeded org
 * (cascading its customers/jobs/quotes) and return the flag to DARK in afterAll.
 */

// hq_events and the hq_settings JSONB blob aren't ergonomically covered by the
// generated Database types; use the same minimal untyped surface the PR1 spine
// suite uses for the service-role-only spine internals (the `as unknown as`
// convention, not `any`).
type Res<T> = { data: T | null; error: { message: string } | null };
type Thenable<T> = PromiseLike<Res<T>>;
interface Selectable<T> extends Thenable<T[]> {
  eq(column: string, value: unknown): Selectable<T>;
  single(): Thenable<T>;
}
interface Insertable extends Thenable<null> {
  select(columns?: string): Selectable<Record<string, unknown>>;
}
interface Mutable extends Thenable<null> {
  eq(column: string, value: unknown): Mutable;
}
interface Table {
  select(columns?: string): Selectable<Record<string, unknown>>;
  insert(row: Record<string, unknown>): Insertable;
  update(patch: Record<string, unknown>): Mutable;
  delete(): Mutable;
}
interface Client {
  from(table: string): Table;
}
const svc = (): Client => serviceClient() as unknown as Client;

type EventRow = {
  id: number;
  verb: string;
  actor_type: string;
  object_type: string;
  object_id: string;
  correlation_id: string;
  payload: Record<string, unknown>;
};

/** Canonical events about a given object, in id (total-order) order. */
async function eventsFor(objectId: string): Promise<EventRow[]> {
  const res = await svc()
    .from("hq_events")
    .select("id, verb, actor_type, object_type, object_id, correlation_id, payload")
    .eq("object_id", objectId);
  expect(res.error, res.error?.message).toBeNull();
  return ((res.data ?? []) as unknown as EventRow[]).slice().sort((a, b) => a.id - b.id);
}

const verbs = (rows: EventRow[]): string[] => rows.map((r) => r.verb);

/** Flip the dual-write flag in the reused hq_settings singleton, preserving the
 *  rest of the blob — exactly the runtime toggle an operator would perform. */
async function setDualWrite(on: boolean): Promise<void> {
  const cur = await svc().from("hq_settings").select("data").eq("id", "singleton").single();
  expect(cur.error, cur.error?.message).toBeNull();
  const data = (((cur.data as { data?: Record<string, unknown> } | null)?.data) ??
    {}) as Record<string, unknown>;
  const next = {
    ...data,
    event_spine: {
      ...((data.event_spine as Record<string, unknown>) ?? {}),
      dual_write_enabled: on,
    },
  };
  const upd = await svc().from("hq_settings").update({ data: next }).eq("id", "singleton");
  expect(upd.error, upd.error?.message).toBeNull();
}

const idOf = (r: Res<Record<string, unknown>>): string => String((r.data as { id: string }).id);

describeIntegration("HQ Event Spine · domain producers (PR2)", () => {
  let orgId = "";
  const slug = `it-pr2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    const org = await svc()
      .from("organizations")
      .insert({ name: "PR2 Producers Org", slug })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    orgId = idOf(org);
  });

  afterAll(async () => {
    await setDualWrite(false);
    if (orgId) await svc().from("organizations").delete().eq("id", orgId);
  });

  it("ships DARK — flag off: a mutation writes activity_log but emits NO event", async () => {
    await setDualWrite(false);

    const ins = await svc()
      .from("customers")
      .insert({ org_id: orgId, name: "Dark Co" })
      .select("id")
      .single();
    expect(ins.error, ins.error?.message).toBeNull();
    const custId = idOf(ins);

    // activity_log captured it exactly as before…
    const log = await svc().from("activity_log").select("action").eq("target_id", custId);
    expect(log.error, log.error?.message).toBeNull();
    expect((log.data ?? []).map((r) => (r as { action: string }).action)).toContain(
      "customer.created",
    );

    // …but the spine stayed dark: zero events for this object.
    expect(await eventsFor(custId)).toHaveLength(0);
  });

  it("flag on — customers: created + updated are mirrored; deleted is NOT", async () => {
    await setDualWrite(true);

    const ins = await svc()
      .from("customers")
      .insert({ org_id: orgId, name: "Bright Co" })
      .select("id")
      .single();
    expect(ins.error, ins.error?.message).toBeNull();
    const custId = idOf(ins);

    let events = await eventsFor(custId);
    expect(verbs(events)).toEqual(["customer.created"]);
    const created = events[0];
    expect(created?.actor_type).toBe("system"); // service_role mutation: no auth principal
    expect(created?.object_type).toBe("customer"); // object_type is the verb namespace
    expect(created?.object_id).toBe(custId);
    // correlation_id is NOT NULL — a fresh trace when no GUC is set (Ch.04 coalesce).
    expect(created?.correlation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
    // The spine carries NO tenant PII: name/email/phone never cross over.
    const createdKeys = Object.keys(created?.payload ?? {});
    expect(createdKeys).not.toContain("name");
    expect(createdKeys).not.toContain("email");
    expect(createdKeys).not.toContain("phone");
    expect(JSON.stringify(created?.payload ?? {})).not.toContain("Bright Co");

    const upd = await svc().from("customers").update({ name: "Bright & Co" }).eq("id", custId);
    expect(upd.error, upd.error?.message).toBeNull();
    events = await eventsFor(custId);
    expect(verbs(events)).toEqual(["customer.created", "customer.updated"]);

    const del = await svc().from("customers").delete().eq("id", custId);
    expect(del.error, del.error?.message).toBeNull();
    // customer.deleted is outside the curated subset → no third event appears,
    // even though activity_log recorded the deletion.
    events = await eventsFor(custId);
    expect(verbs(events)).toEqual(["customer.created", "customer.updated"]);
  });

  it("flag on — jobs: created maps; status→completed maps; status→blocked does not", async () => {
    await setDualWrite(true);

    const ins = await svc()
      .from("jobs")
      .insert({ org_id: orgId, status: "new" })
      .select("id")
      .single();
    expect(ins.error, ins.error?.message).toBeNull();
    const jobId = idOf(ins);
    expect(verbs(await eventsFor(jobId))).toEqual(["job.created"]);

    // → 'blocked': a status change the registry has no verb for (jobs.status is
    // 'new'|'in-progress'|'completed'|'blocked'; scheduled/cancelled don't exist).
    const blocked = await svc().from("jobs").update({ status: "blocked" }).eq("id", jobId);
    expect(blocked.error, blocked.error?.message).toBeNull();
    expect(verbs(await eventsFor(jobId))).toEqual(["job.created"]);

    // → 'completed': the one status transition that maps to a canonical verb.
    const done = await svc().from("jobs").update({ status: "completed" }).eq("id", jobId);
    expect(done.error, done.error?.message).toBeNull();
    const events = await eventsFor(jobId);
    expect(verbs(events)).toEqual(["job.created", "job.completed"]);
    const completed = events.find((e) => e.verb === "job.completed");
    expect(completed?.object_type).toBe("job");
    // Non-PII status hints survive curation (from 'blocked' → to 'completed').
    expect(completed?.payload?.to).toBe("completed");
  });

  it("flag on — quotes: sent + accepted are mirrored; created is NOT", async () => {
    await setDualWrite(true);

    const cust = await svc()
      .from("customers")
      .insert({ org_id: orgId, name: "Quote Co" })
      .select("id")
      .single();
    expect(cust.error, cust.error?.message).toBeNull();
    const custId = idOf(cust);

    const number = `Q-${Date.now()}`;
    const ins = await svc()
      .from("quotes")
      .insert({ org_id: orgId, customer_id: custId, number })
      .select("id")
      .single();
    expect(ins.error, ins.error?.message).toBeNull();
    const quoteId = idOf(ins);

    // quote.created is outside the curated subset → nothing yet.
    expect(await eventsFor(quoteId)).toHaveLength(0);

    const sent = await svc()
      .from("quotes")
      .update({ sent_at: new Date().toISOString() })
      .eq("id", quoteId);
    expect(sent.error, sent.error?.message).toBeNull();
    expect(verbs(await eventsFor(quoteId))).toEqual(["quote.sent"]);

    const accepted = await svc()
      .from("quotes")
      .update({
        accepted_at: new Date().toISOString(),
        accept_signature: { name: "Jane Signer", source: "public_link" },
      })
      .eq("id", quoteId);
    expect(accepted.error, accepted.error?.message).toBeNull();
    const events = await eventsFor(quoteId);
    expect(verbs(events)).toEqual(["quote.sent", "quote.accepted"]);

    // The signer's name is PII — it stays in activity_log and is NOT copied into
    // the event payload (Ch.04: payloads are small, structured, never PII-heavy)…
    const accept = events.find((e) => e.verb === "quote.accepted");
    expect(JSON.stringify(accept?.payload ?? {})).not.toContain("Jane Signer");
    // …but the non-PII context (the quote number) DOES survive — curation, not omission.
    expect(accept?.payload?.number).toBe(number);
  });
});

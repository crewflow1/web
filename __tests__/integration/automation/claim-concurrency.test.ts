import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Automation dispatch — claim-before-action concurrency safety.
 *
 * The defect this proves fixed: `dispatchAutomation` decided with a READ
 * (`select … where rule_id/correlation_id` → miss → run actions → insert). The
 * window between that select and the insert was the ENTIRE action execution, so
 * two concurrent callers both missed, both ran the actions, and only the second
 * INSERT collided on `unique (rule_id, correlation_id)` — after the duplicate
 * alert and notification had already been written. The constraint guarded the
 * ROW, never the WORK, and the collision was silently discarded because
 * Supabase returns `{ error }` rather than throwing.
 *
 * These tests exercise the REAL dispatcher against REAL Postgres, because the
 * claim is a database race: a mocked client cannot prove that Postgres admits
 * exactly one winner. Concurrency is driven with Promise.all so both callers
 * genuinely interleave against the same rows.
 *
 * `quote.accepted` is the vehicle — a real, enabled rule
 * (`quote_accepted_notify`) whose actions write observable side effects. Its
 * actions are counted directly, so "did the work run twice?" is answered by the
 * side effects themselves, not by inspecting the run row.
 */

type Db = {
  from: (t: string) => {
    insert: (v: unknown) => {
      select: (c: string) => {
        single: () => Promise<{
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        }>;
      };
    };
    select: (c: string) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => Promise<{
          data: unknown[] | null;
          error: { message: string } | null;
        }>;
        maybeSingle: () => Promise<{
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        }>;
      };
    };
    update: (v: unknown) => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
    };
    delete: () => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
    };
  };
};
const db = (c: unknown): Db => c as unknown as Db;

const TOKEN = `it-claim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** The rule under test — real, enabled, and it writes observable side effects. */
const RULE_ID = "quote_accepted_notify";
const EVENT_TYPE = "quote.accepted";

describeIntegration("automation dispatch · claim-before-action", () => {
  let orgId = "";
  let dispatchAutomation: typeof import("@/server/services/automation-dispatcher").dispatchAutomation;
  let LEASE_MS = 0;

  /**
   * A fresh source id per test → a fresh correlation identity.
   *
   * Must be a real UUID: the rule's `add_internal_note` action passes
   * event.source_id into recordAdminActivity, and activity_log.target_id is
   * `uuid not null`. A synthetic string would fail at the database rather than
   * at the assertion, which would test the wrong thing.
   */
  const freshSource = () => crypto.randomUUID();
  const correlationFor = (sourceId: string) =>
    `${EVENT_TYPE}:quotes:${sourceId}`;

  const eventFor = (sourceId: string) => ({
    type: EVENT_TYPE as never,
    org_id: orgId,
    source_table: "quotes",
    source_id: sourceId,
    payload: { probe: TOKEN },
  });

  const runRow = async (sourceId: string) => {
    const res = await db(serviceClient())
      .from("automation_runs")
      .select("id, status, completed_at, claimed_at, error_message")
      .eq("rule_id", RULE_ID)
      .eq("correlation_id", correlationFor(sourceId));
    expect(res.error, res.error?.message).toBeNull();
    return (res.data ?? []) as Array<Record<string, unknown>>;
  };

  /** Side effects the rule's actions write — the real "did the work run?" signal. */
  const notificationCount = async (sourceId: string) => {
    const res = await db(serviceClient())
      .from("notifications")
      .select("id")
      .eq("source_id", sourceId)
      .eq("org_id", orgId);
    expect(res.error, res.error?.message).toBeNull();
    return (res.data ?? []).length;
  };

  beforeAll(async () => {
    const svc = db(serviceClient());
    const org = await svc
      .from("organizations")
      .insert({ name: "Claim Probe Org", slug: `${TOKEN}-org` })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    orgId = org.data?.id as string;
    if (!orgId) throw new Error("failed to create probe org");

    const mod = await import("@/server/services/automation-dispatcher");
    dispatchAutomation = mod.dispatchAutomation;
    LEASE_MS = mod.AUTOMATION_CLAIM_LEASE_MS;
  });

  afterAll(async () => {
    if (orgId) await db(serviceClient()).from("organizations").delete().eq("id", orgId);
  });

  afterEach(async () => {
    // Runs are org-cascaded on teardown; nothing per-test to undo.
  });

  // -------------------------------------------------------------------
  // The core race
  // -------------------------------------------------------------------

  it("two SIMULTANEOUS first calls → exactly one action execution", async () => {
    const src = freshSource();

    // Both callers start before either can finish: the exact interleaving that
    // made the old read-then-insert run the actions twice.
    const [a, b] = await Promise.all([
      dispatchAutomation(eventFor(src)),
      dispatchAutomation(eventFor(src)),
    ]);

    const statuses = [
      a.ran.find((r) => r.rule_id === RULE_ID)?.status,
      b.ran.find((r) => r.rule_id === RULE_ID)?.status,
    ];
    // Exactly one winner; the loser skipped.
    expect(statuses.filter((s) => s === "ok")).toHaveLength(1);
    expect(statuses.filter((s) => s === "skipped")).toHaveLength(1);
  });

  it("…and exactly ONE durable claim exists", async () => {
    const src = freshSource();
    await Promise.all([
      dispatchAutomation(eventFor(src)),
      dispatchAutomation(eventFor(src)),
    ]);
    expect(await runRow(src)).toHaveLength(1);
  });

  it("…and the loser produced NO duplicate side effect", async () => {
    // The whole point: the old code's unique constraint stopped the duplicate
    // ROW but not the duplicate NOTIFICATION. Count the side effect itself.
    const src = freshSource();
    await Promise.all([
      dispatchAutomation(eventFor(src)),
      dispatchAutomation(eventFor(src)),
    ]);
    expect(await notificationCount(src)).toBe(1);
  });

  it("five simultaneous callers still yield exactly one execution", async () => {
    const src = freshSource();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => dispatchAutomation(eventFor(src))),
    );
    const oks = results.filter(
      (r) => r.ran.find((x) => x.rule_id === RULE_ID)?.status === "ok",
    );
    expect(oks).toHaveLength(1);
    expect(await runRow(src)).toHaveLength(1);
    expect(await notificationCount(src)).toBe(1);
  });

  // -------------------------------------------------------------------
  // Completed work is terminal
  // -------------------------------------------------------------------

  it("a completed run is skipped on every later call", async () => {
    const src = freshSource();
    const first = await dispatchAutomation(eventFor(src));
    expect(first.ran.find((r) => r.rule_id === RULE_ID)?.status).toBe("ok");

    const rows = await runRow(src);
    expect(rows[0]?.status).toBe("ok");
    expect(rows[0]?.completed_at).toBeTruthy();

    const second = await dispatchAutomation(eventFor(src));
    expect(second.ran.find((r) => r.rule_id === RULE_ID)?.status).toBe("skipped");
    expect(await notificationCount(src)).toBe(1);
  });

  it("a completed run cannot be reclaimed even with an ancient claimed_at", async () => {
    // completed_at — not the lease — is what makes work terminal. An expired
    // lease must never resurrect finished work.
    const src = freshSource();
    await dispatchAutomation(eventFor(src));

    const ancient = new Date(Date.now() - LEASE_MS * 10).toISOString();
    const upd = await db(serviceClient())
      .from("automation_runs")
      .update({ claimed_at: ancient })
      .eq("correlation_id", correlationFor(src));
    expect(upd.error, upd.error?.message).toBeNull();

    const again = await dispatchAutomation(eventFor(src));
    expect(again.ran.find((r) => r.rule_id === RULE_ID)?.status).toBe("skipped");
    expect(await notificationCount(src)).toBe(1);
  });

  // -------------------------------------------------------------------
  // Leases
  // -------------------------------------------------------------------

  it("an ACTIVE lease cannot be stolen", async () => {
    const src = freshSource();
    await dispatchAutomation(eventFor(src));

    // Simulate a caller that claimed moments ago and is still working.
    const upd = await db(serviceClient())
      .from("automation_runs")
      .update({
        status: "running",
        completed_at: null,
        claimed_at: new Date().toISOString(),
      })
      .eq("correlation_id", correlationFor(src));
    expect(upd.error, upd.error?.message).toBeNull();

    const before = await notificationCount(src);
    const res = await dispatchAutomation(eventFor(src));
    expect(res.ran.find((r) => r.rule_id === RULE_ID)?.status).toBe("skipped");
    // No actions ran: the in-flight worker keeps its claim.
    expect(await notificationCount(src)).toBe(before);
  });

  it("an EXPIRED lease is reclaimed — an orphaned run is not blocked forever", async () => {
    const src = freshSource();
    await dispatchAutomation(eventFor(src));

    // A process that claimed and died: 'running', never completed, lease stale.
    const stale = new Date(Date.now() - LEASE_MS - 60_000).toISOString();
    const upd = await db(serviceClient())
      .from("automation_runs")
      .update({ status: "running", completed_at: null, claimed_at: stale })
      .eq("correlation_id", correlationFor(src));
    expect(upd.error, upd.error?.message).toBeNull();

    const res = await dispatchAutomation(eventFor(src));
    expect(res.ran.find((r) => r.rule_id === RULE_ID)?.status).toBe("ok");

    const rows = await runRow(src);
    expect(rows).toHaveLength(1); // reclaimed in place, not duplicated
    expect(rows[0]?.completed_at).toBeTruthy();
  });

  it("an expired lease is reclaimed by EXACTLY ONE of many concurrent callers", async () => {
    const src = freshSource();
    await dispatchAutomation(eventFor(src));
    const stale = new Date(Date.now() - LEASE_MS - 60_000).toISOString();
    await db(serviceClient())
      .from("automation_runs")
      .update({ status: "running", completed_at: null, claimed_at: stale })
      .eq("correlation_id", correlationFor(src));

    const before = await notificationCount(src);
    const results = await Promise.all([
      dispatchAutomation(eventFor(src)),
      dispatchAutomation(eventFor(src)),
      dispatchAutomation(eventFor(src)),
    ]);
    const oks = results.filter(
      (r) => r.ran.find((x) => x.rule_id === RULE_ID)?.status === "ok",
    );
    // The conditional UPDATE serialises on the row lock: one reclaimer wins.
    expect(oks).toHaveLength(1);
    expect(await notificationCount(src)).toBe(before + 1);
  });

  // -------------------------------------------------------------------
  // Failure release + retry
  // -------------------------------------------------------------------

  it("a FAILED run is reclaimable immediately — no lease wait", async () => {
    const src = freshSource();
    await dispatchAutomation(eventFor(src));

    // A live dispatcher caught an error and RELEASED the claim: nothing is in
    // flight, so a retry must not have to wait out a lease.
    const upd = await db(serviceClient())
      .from("automation_runs")
      .update({
        status: "failed",
        completed_at: null,
        error_message: "probe: simulated failure",
        claimed_at: new Date().toISOString(), // lease still fresh, deliberately
      })
      .eq("correlation_id", correlationFor(src));
    expect(upd.error, upd.error?.message).toBeNull();

    const res = await dispatchAutomation(eventFor(src));
    expect(res.ran.find((r) => r.rule_id === RULE_ID)?.status).toBe("ok");
  });

  it("a successful retry stamps completion and CLEARS the stale error", async () => {
    const src = freshSource();
    await dispatchAutomation(eventFor(src));
    await db(serviceClient())
      .from("automation_runs")
      .update({
        status: "failed",
        completed_at: null,
        error_message: "probe: simulated failure",
        claimed_at: new Date().toISOString(),
      })
      .eq("correlation_id", correlationFor(src));

    await dispatchAutomation(eventFor(src));

    const rows = await runRow(src);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("ok");
    expect(rows[0]?.completed_at).toBeTruthy();
    // A retry that fixes a failure must not leave the old error behind.
    expect(rows[0]?.error_message).toBeNull();
  });

  it("an incomplete run never becomes permanently blocked", async () => {
    // The Stripe-webhook defect restated: if row EXISTENCE were the gate, this
    // row could never be retried. completed_at is the gate, so it can.
    const src = freshSource();
    await dispatchAutomation(eventFor(src));
    await db(serviceClient())
      .from("automation_runs")
      .update({ status: "failed", completed_at: null, error_message: "stuck" })
      .eq("correlation_id", correlationFor(src));

    const res = await dispatchAutomation(eventFor(src));
    expect(res.ran.find((r) => r.rule_id === RULE_ID)?.status).toBe("ok");
  });

  // -------------------------------------------------------------------
  // Existing behaviour survives
  // -------------------------------------------------------------------

  it("database uniqueness on (rule_id, correlation_id) is still enforced", async () => {
    const src = freshSource();
    await dispatchAutomation(eventFor(src));
    const dupe = await db(serviceClient())
      .from("automation_runs")
      .insert({
        org_id: orgId,
        event_type: EVENT_TYPE,
        rule_id: RULE_ID,
        correlation_id: correlationFor(src),
        status: "ok",
      })
      .select("id")
      .single();
    expect(dupe.error).not.toBeNull();
    expect(dupe.error?.message ?? "").toMatch(/duplicate|unique/i);
  });

  it("a normal single dispatch still executes and records accurate metadata", async () => {
    const src = freshSource();
    const res = await dispatchAutomation(eventFor(src));
    expect(res.ran.find((r) => r.rule_id === RULE_ID)?.status).toBe("ok");

    const rows = await runRow(src);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("ok");
    expect(rows[0]?.completed_at).toBeTruthy();
    expect(rows[0]?.claimed_at).toBeTruthy();
    expect(rows[0]?.error_message).toBeNull();
  });

  it("an unmatched event type still no-ops without writing anything", async () => {
    const res = await dispatchAutomation({
      type: "definitely.not.a.rule" as never,
      org_id: orgId,
      source_table: "quotes",
      source_id: freshSource(),
      payload: {},
    });
    expect(res.ran).toHaveLength(0);
  });
});

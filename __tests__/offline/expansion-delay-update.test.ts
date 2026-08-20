import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrgContext } from "@/server/auth/session";

/**
 * OFFLINE UPDATE — the DRAFT delay-event edit (registry expansion), exercised for
 * REAL against a scripted Supabase mock. This proves the novelty of THIS kind on
 * top of the shared conflict engine (which is unchanged):
 *
 *   - the columnMap: the camelCase schema keys (startedOn, workingDaysLost…) are
 *     read from and written to their snake_case columns (started_on, …);
 *   - the DRAFT guard: a row that is no longer 'draft' is a permanent
 *     `not_editable` rejection, and the compare-and-swap ALSO carries
 *     `.eq('status','draft')` so a promotion racing the swap fails it;
 *   - the 3-way merge + idempotency marker + conflict surfacing behave exactly as
 *     they do for the diary/snag updates (the engine is shared, not forked).
 */

const h = vi.hoisted(() => {
  type PgErr = { message: string; code?: string } | null;
  type Upd = { table: string; patch: Record<string, unknown>; eqs: Array<[string, unknown]> };
  const state = {
    updates: [] as Upd[],
    readScript: new Map<string, Array<{ data: unknown; error: PgErr }>>(),
    updateScript: new Map<string, Array<{ error: PgErr; count: number | null }>>(),
  };
  const nextRead = (t: string) => {
    const q = state.readScript.get(t);
    if (!q || q.length === 0) throw new Error(`unscripted read on ${t}`);
    return q.shift()!;
  };
  const nextUpdate = (t: string) => {
    const q = state.updateScript.get(t);
    if (!q || q.length === 0) throw new Error(`unscripted update on ${t}`);
    return q.shift()!;
  };
  const client = {
    from(table: string) {
      return {
        select() {
          const rc = { eq: () => rc, maybeSingle: async () => nextRead(table) };
          return rc;
        },
        update(patch: Record<string, unknown>) {
          const rec: Upd = { table, patch, eqs: [] };
          state.updates.push(rec);
          const uc = {
            eq(k: string, v: unknown) {
              rec.eqs.push([k, v]);
              return uc;
            },
            then(
              resolve: (x: { error: PgErr; count: number | null }) => unknown,
              reject: (e: unknown) => unknown,
            ) {
              return Promise.resolve(nextUpdate(table)).then(resolve, reject);
            },
          };
          return uc;
        },
      };
    },
  };
  return { state, client };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.client }));
const auditCalls = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/server/services/hq-audit", () => ({
  recordAdminActivity: async (a: Record<string, unknown>) => {
    auditCalls.calls.push(a);
  },
}));

import {
  updateDelayEventRecord,
  dispatchOfflineWrite,
} from "@/server/services/offline-writes";

const ORG = "org-1";
const V1 = "2026-07-30T16:00:00.000Z";
const V2 = "2026-07-30T18:30:00.000Z";
const KEY = "55555555-5555-4555-8555-555555555555";
const ID = "d1d1d1d1-1111-4111-8111-111111111111";
const JOB = "11111111-1111-4111-8111-111111111111";

const ctx = (orgId = ORG) =>
  ({
    membership: { org_id: orgId, role: "staff" },
    org: {
      id: orgId,
      name: "Org",
      slug: "org",
      status: "active",
      plan: "trial",
      trial_ends_at: null,
      created_at: "2026-01-01",
      onboarding_state: {},
    },
  }) as OrgContext;
const user = { id: "user-1", email: "a@b.test" };

/** The DB row the server reads back for `theirs` (snake_case columns + status). */
const delayRow = (over: Record<string, unknown> = {}) => ({
  category: "weather",
  started_on: "2026-07-30",
  ended_on: null,
  working_days_lost: 2,
  description: "Heavy rain stopped groundworks",
  diary_entry_id: null,
  variation_quote_id: null,
  weather_district: null,
  status: "draft",
  updated_at: V1,
  last_offline_write_key: null,
  ...over,
});

/** The camelCase base the foreman started editing from. */
const base = () => ({
  category: "weather",
  startedOn: "2026-07-30",
  endedOn: "",
  workingDaysLost: 2,
  description: "Heavy rain stopped groundworks",
  diaryEntryId: "",
  variationQuoteId: "",
  weatherDistrict: "",
});

const input = (over: Record<string, unknown> = {}) => ({
  id: ID,
  jobId: JOB,
  ...base(),
  ...over,
});

beforeEach(() => {
  h.state.updates.length = 0;
  h.state.readScript.clear();
  h.state.updateScript.clear();
  auditCalls.calls.length = 0;
});

describe("offline updateDelayEventRecord — columnMap + clean merge as a compare-and-swap", () => {
  it("writes the foreman's edit to the MAPPED columns, draft-guarded, marker stamped", async () => {
    // Foreman corrects working_days_lost and the description; server changed nothing.
    h.state.readScript.set("delay_events", [{ data: delayRow(), error: null }]);
    h.state.updateScript.set("delay_events", [{ error: null, count: 1 }]);

    const out = await updateDelayEventRecord({
      ctx: ctx(),
      user,
      input: input({ workingDaysLost: 3, description: "Rain then flooding" }),
      baseVersion: V1,
      baseValues: base(),
      clientKey: KEY,
      offlineAuthoredAt: V1,
    });

    expect(out).toEqual({ status: "accepted", id: ID });
    const upd = h.state.updates[0]!;
    expect(upd.table).toBe("delay_events");
    // camelCase payload keys landed in snake_case columns
    expect(upd.patch.working_days_lost).toBe(3);
    expect(upd.patch.description).toBe("Rain then flooding");
    expect(upd.patch.started_on).toBe("2026-07-30");
    // an emptied optional is stored NULL, not ""
    expect(upd.patch.ended_on).toBeNull();
    expect(upd.patch.weather_district).toBeNull();
    expect(upd.patch.last_offline_write_key).toBe(KEY);
    // the merge never widens to a column outside the map/field set (no job_id)
    expect(upd.patch.job_id).toBeUndefined();
    // COMPARE-AND-SWAP guards: id + org + version + DRAFT
    expect(upd.eqs).toContainEqual(["id", ID]);
    expect(upd.eqs).toContainEqual(["org_id", ORG]);
    expect(upd.eqs).toContainEqual(["updated_at", V1]);
    expect(upd.eqs).toContainEqual(["status", "draft"]);
  });
});

describe("offline updateDelayEventRecord — DRAFT-only guard", () => {
  it("permanently rejects a row that has been promoted out of draft (no write)", async () => {
    h.state.readScript.set("delay_events", [
      { data: delayRow({ status: "recorded" }), error: null },
    ]);

    const out = await updateDelayEventRecord({
      ctx: ctx(),
      user,
      input: input({ description: "too late" }),
      baseVersion: V1,
      baseValues: base(),
      clientKey: KEY,
    });

    expect(out).toEqual({ status: "rejected", reason: "not_editable" });
    expect(h.state.updates.length).toBe(0); // nothing written
  });
});

describe("offline updateDelayEventRecord — divergence is surfaced, never overwritten", () => {
  it("returns a conflict on the clashing MAPPED field and writes nothing", async () => {
    // Both changed description to different values.
    h.state.readScript.set("delay_events", [
      { data: delayRow({ description: "Office: rescheduled pour" }), error: null },
    ]);

    const out = await updateDelayEventRecord({
      ctx: ctx(),
      user,
      input: input({ description: "Site: flooding all day" }),
      baseVersion: V1,
      baseValues: base(),
      clientKey: KEY,
    });

    expect(out.status).toBe("conflict");
    if (out.status === "conflict") {
      expect(out.serverVersion).toBe(V1);
      expect(out.fields).toContainEqual({
        field: "description",
        mine: "Site: flooding all day",
        theirs: "Office: rescheduled pour",
      });
    }
    expect(h.state.updates.length).toBe(0);
  });
});

describe("offline updateDelayEventRecord — idempotency", () => {
  it("recognises a re-delivered update by last_offline_write_key (duplicate, no write)", async () => {
    h.state.readScript.set("delay_events", [
      { data: delayRow({ last_offline_write_key: KEY }), error: null },
    ]);

    const out = await updateDelayEventRecord({
      ctx: ctx(),
      user,
      input: input({ description: "already applied" }),
      baseVersion: V1,
      baseValues: base(),
      clientKey: KEY,
    });

    expect(out).toEqual({ status: "duplicate", id: ID });
    expect(h.state.updates.length).toBe(0);
  });
});

describe("offline updateDelayEventRecord — version moved under us is a retry, never a clobber", () => {
  it("returns retry when the compare-and-swap matches zero rows", async () => {
    h.state.readScript.set("delay_events", [{ data: delayRow(), error: null }]);
    h.state.updateScript.set("delay_events", [{ error: null, count: 0 }]);

    const out = await updateDelayEventRecord({
      ctx: ctx(),
      user,
      input: input({ workingDaysLost: 5 }),
      baseVersion: V1,
      baseValues: base(),
      clientKey: KEY,
    });

    expect(out).toEqual({ status: "retry", reason: "version_moved" });
  });
});

describe("offline updateDelayEventRecord — keep-mine resolution", () => {
  it("forces the author's value on a divergent field when the acknowledged version holds", async () => {
    // Author acknowledged V1 and chose keep-mine; server still at V1.
    h.state.readScript.set("delay_events", [
      { data: delayRow({ description: "Office version" }), error: null },
    ]);
    h.state.updateScript.set("delay_events", [{ error: null, count: 1 }]);

    const out = await updateDelayEventRecord({
      ctx: ctx(),
      user,
      input: input({ description: "My version wins" }),
      baseVersion: V1,
      baseValues: base(),
      resolution: "keep_mine",
      clientKey: KEY,
    });

    expect(out).toEqual({ status: "accepted", id: ID });
    expect(h.state.updates[0]!.patch.description).toBe("My version wins");
  });

  it("re-surfaces the conflict if the server moved again since the author looked", async () => {
    h.state.readScript.set("delay_events", [
      { data: delayRow({ description: "Newer office version", updated_at: V2 }), error: null },
    ]);

    const out = await updateDelayEventRecord({
      ctx: ctx(),
      user,
      input: input({ description: "My version" }),
      baseVersion: V1, // author acknowledged V1, but row is now V2
      baseValues: base(),
      resolution: "keep_mine",
      clientKey: KEY,
    });

    expect(out.status).toBe("conflict");
    if (out.status === "conflict") expect(out.serverVersion).toBe(V2);
    expect(h.state.updates.length).toBe(0);
  });
});

describe("dispatchOfflineWrite — delay_event.update through the full trust boundary", () => {
  it("refuses an update authored for another org (no re-home, no write)", async () => {
    const out = await dispatchOfflineWrite({
      ctx: ctx("org-B"),
      user,
      item: {
        clientKey: KEY,
        kind: "delay_event.update",
        orgId: "org-A",
        payload: input(),
        authoredAt: V1,
        baseVersion: V1,
        baseValues: base(),
      },
    });
    expect(out).toEqual({ status: "rejected", reason: "org_mismatch" });
    expect(h.state.updates.length).toBe(0);
  });

  it("refuses an update with no concurrency anchor / merge base as malformed", async () => {
    const out = await dispatchOfflineWrite({
      ctx: ctx(),
      user,
      item: {
        clientKey: KEY,
        kind: "delay_event.update",
        orgId: ORG,
        payload: input(),
        authoredAt: V1,
        // no baseVersion / baseValues
      },
    });
    expect(out).toEqual({ status: "rejected", reason: "malformed_item" });
  });

  it("routes a well-formed update to the draft-guarded core", async () => {
    h.state.readScript.set("delay_events", [{ data: delayRow(), error: null }]);
    h.state.updateScript.set("delay_events", [{ error: null, count: 1 }]);
    const out = await dispatchOfflineWrite({
      ctx: ctx(),
      user,
      item: {
        clientKey: KEY,
        kind: "delay_event.update",
        orgId: ORG,
        payload: input({ workingDaysLost: 4 }),
        authoredAt: V1,
        baseVersion: V1,
        baseValues: base(),
      },
    });
    expect(out).toEqual({ status: "accepted", id: ID });
    expect(h.state.updates[0]!.patch.working_days_lost).toBe(4);
    expect(h.state.updates[0]!.eqs).toContainEqual(["status", "draft"]);
  });
});

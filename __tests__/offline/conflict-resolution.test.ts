import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrgContext } from "@/server/auth/session";

/**
 * OFFLINE UPDATE — conflict resolution, exercised for REAL against a scripted
 * Supabase mock. This proves the load-bearing novelty of the milestone:
 *
 *   - the 3-way merge applied as a compare-and-swap (clean merge → one UPDATE
 *     keyed on the version we read, with the idempotency marker stamped);
 *   - a divergent field surfaced as a conflict with NO write;
 *   - idempotency: a re-delivered update recognised by last_offline_write_key
 *     instead of racing its own version bump;
 *   - target_missing, version-moved retry, and the "keep mine" resolution
 *     (forced when the acknowledged version still holds, re-surfaced when it
 *     moved again).
 *
 * The org-pin / malformed-envelope trust-boundary refusals for update kinds are
 * in __tests__/security/offline-write-conflict.test.ts (hermetic, no client).
 */

// ── scripted supabase mock ───────────────────────────────────────────────────
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
          const rc = {
            eq: () => rc,
            maybeSingle: async () => nextRead(table),
          };
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

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => h.client,
}));
const auditCalls = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/server/services/hq-audit", () => ({
  recordAdminActivity: async (a: Record<string, unknown>) => {
    auditCalls.calls.push(a);
  },
}));

import {
  updateDiaryEntryRecord,
  updateSnagRecord,
  dispatchOfflineWrite,
} from "@/server/services/offline-writes";

const ORG = "org-1";
const V1 = "2026-07-30T16:00:00.000Z";
const V2 = "2026-07-30T18:30:00.000Z";
const KEY = "55555555-5555-4555-8555-555555555555";
const DIARY_ID = "d1d1d1d1-1111-4111-8111-111111111111";

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

/** The diary row the server reads back for `theirs`. */
const diaryRow = (over: Record<string, unknown> = {}) => ({
  entry_date: "2026-07-30",
  job_id: null,
  weather: "wet",
  labour_count: 4,
  work_summary: "first fix",
  delays: null,
  notes: null,
  updated_at: V1,
  last_offline_write_key: null,
  ...over,
});

const diaryBase = () => ({
  entry_date: "2026-07-30",
  job_id: "",
  weather: "wet",
  labour_count: 4,
  work_summary: "first fix",
  delays: "",
  notes: "",
});

beforeEach(() => {
  h.state.updates.length = 0;
  h.state.readScript.clear();
  h.state.updateScript.clear();
  auditCalls.calls.length = 0;
});

describe("updateDiaryEntryRecord — clean merge applied as a compare-and-swap", () => {
  it("keeps the admin's field + the foreman's field, stamps the idempotency marker", async () => {
    // Server changed weather; foreman changed labour_count. No field diverges.
    h.state.readScript.set("site_diary_entries", [
      { data: diaryRow({ weather: "dry am, rain pm" }), error: null },
    ]);
    h.state.updateScript.set("site_diary_entries", [{ error: null, count: 1 }]);

    const out = await updateDiaryEntryRecord({
      ctx: ctx(),
      user,
      input: { id: "d1", ...diaryBase(), labour_count: 6 },
      baseVersion: V1,
      baseValues: diaryBase(),
      clientKey: KEY,
      offlineAuthoredAt: V1,
    });

    expect(out).toEqual({ status: "accepted", id: "d1" });
    const upd = h.state.updates[0]!;
    expect(upd.table).toBe("site_diary_entries");
    expect(upd.patch.labour_count).toBe(6); // foreman's owned change
    expect(upd.patch.weather).toBe("dry am, rain pm"); // admin's owned change survives
    expect(upd.patch.last_offline_write_key).toBe(KEY); // idempotency marker
    // COMPARE-AND-SWAP: the write is keyed on (id, org, the version we read).
    expect(upd.eqs).toContainEqual(["id", "d1"]);
    expect(upd.eqs).toContainEqual(["org_id", ORG]);
    expect(upd.eqs).toContainEqual(["updated_at", V1]);
  });
});

describe("updateDiaryEntryRecord — divergence is surfaced, never overwritten", () => {
  it("returns a conflict with the clashing field and writes NOTHING", async () => {
    // Both changed weather, to different values.
    h.state.readScript.set("site_diary_entries", [
      { data: diaryRow({ weather: "overcast" }), error: null },
    ]);

    const out = await updateDiaryEntryRecord({
      ctx: ctx(),
      user,
      input: { id: "d1", ...diaryBase(), weather: "dry am, rain pm" },
      baseVersion: V1,
      baseValues: diaryBase(),
      clientKey: KEY,
    });

    expect(out).toEqual({
      status: "conflict",
      serverVersion: V1,
      fields: [{ field: "weather", mine: "dry am, rain pm", theirs: "overcast" }],
    });
    expect(h.state.updates).toHaveLength(0); // nothing written
  });
});

describe("updateDiaryEntryRecord — idempotency", () => {
  it("a re-delivered update is a duplicate (marker matches), not a re-apply", async () => {
    h.state.readScript.set("site_diary_entries", [
      { data: diaryRow({ updated_at: V2, last_offline_write_key: KEY }), error: null },
    ]);

    const out = await updateDiaryEntryRecord({
      ctx: ctx(),
      user,
      input: { id: "d1", ...diaryBase(), labour_count: 6 },
      baseVersion: V1,
      baseValues: diaryBase(),
      clientKey: KEY,
    });

    expect(out).toEqual({ status: "duplicate", id: "d1" });
    expect(h.state.updates).toHaveLength(0); // no second write over our own bump
  });

  it("a missing target row is a permanent rejection", async () => {
    h.state.readScript.set("site_diary_entries", [{ data: null, error: null }]);
    const out = await updateDiaryEntryRecord({
      ctx: ctx(),
      user,
      input: { id: "gone", ...diaryBase(), notes: "x" },
      baseVersion: V1,
      baseValues: diaryBase(),
      clientKey: KEY,
    });
    expect(out).toEqual({ status: "rejected", reason: "target_missing" });
  });

  it("a CAS that matches nothing (row moved under us) is a RETRY, never a loss", async () => {
    h.state.readScript.set("site_diary_entries", [
      { data: diaryRow(), error: null },
    ]);
    h.state.updateScript.set("site_diary_entries", [{ error: null, count: 0 }]);
    const out = await updateDiaryEntryRecord({
      ctx: ctx(),
      user,
      input: { id: "d1", ...diaryBase(), notes: "late note" },
      baseVersion: V1,
      baseValues: diaryBase(),
      clientKey: KEY,
    });
    expect(out).toEqual({ status: "retry", reason: "version_moved" });
  });
});

describe("updateDiaryEntryRecord — the 'keep mine' resolution", () => {
  it("forces the author's value when the acknowledged version still holds", async () => {
    h.state.readScript.set("site_diary_entries", [
      { data: diaryRow({ weather: "overcast" }), error: null },
    ]);
    h.state.updateScript.set("site_diary_entries", [{ error: null, count: 1 }]);

    const out = await updateDiaryEntryRecord({
      ctx: ctx(),
      user,
      input: { id: "d1", ...diaryBase(), weather: "dry am, rain pm" },
      baseVersion: V1, // the version the author acknowledged (matches current)
      baseValues: diaryBase(),
      resolution: "keep_mine",
      clientKey: KEY,
    });

    expect(out).toEqual({ status: "accepted", id: "d1" });
    expect(h.state.updates[0]!.patch.weather).toBe("dry am, rain pm"); // mine forced
  });

  it("re-surfaces the conflict if the server moved AGAIN since the author looked", async () => {
    // The author acknowledged V1, but the row is now at V2 — a newer edit landed.
    h.state.readScript.set("site_diary_entries", [
      { data: diaryRow({ updated_at: V2, weather: "foggy" }), error: null },
    ]);

    const out = await updateDiaryEntryRecord({
      ctx: ctx(),
      user,
      input: { id: "d1", ...diaryBase(), weather: "dry am, rain pm" },
      baseVersion: V1,
      baseValues: diaryBase(),
      resolution: "keep_mine",
      clientKey: KEY,
    });

    expect(out).toEqual({
      status: "conflict",
      serverVersion: V2,
      fields: [{ field: "weather", mine: "dry am, rain pm", theirs: "foggy" }],
    });
    expect(h.state.updates).toHaveLength(0); // nothing clobbered
  });
});

describe("updateSnagRecord — the same engine, with the snag guards on the merged value", () => {
  const snagRow = (over: Record<string, unknown> = {}) => ({
    title: "Cracked tile",
    description: "reseal",
    location: "ensuite",
    trade: "Tiling",
    priority: "medium",
    job_id: null,
    assigned_to: null,
    due_date: null,
    updated_at: V1,
    last_offline_write_key: null,
    ...over,
  });
  const snagBase = () => ({
    title: "Cracked tile",
    description: "reseal",
    location: "ensuite",
    trade: "Tiling",
    priority: "medium" as const,
    job_id: "",
    assigned_to: "",
    due_date: "",
  });

  it("applies a clean edit (no status ever touched) as a compare-and-swap", async () => {
    h.state.readScript.set("snags", [{ data: snagRow(), error: null }]);
    h.state.updateScript.set("snags", [{ error: null, count: 1 }]);

    const out = await updateSnagRecord({
      ctx: ctx(),
      user,
      input: { id: "s1", ...snagBase(), priority: "high" as const },
      baseVersion: V1,
      baseValues: snagBase(),
      clientKey: KEY,
    });

    expect(out).toEqual({ status: "accepted", id: "s1" });
    const upd = h.state.updates[0]!;
    expect(upd.patch.priority).toBe("high");
    expect(upd.patch).not.toHaveProperty("status"); // lifecycle never written
    expect(upd.patch.last_offline_write_key).toBe(KEY);
    expect(upd.eqs).toContainEqual(["updated_at", V1]);
  });

  it("rejects when the merged assignee is no longer a member of the org", async () => {
    h.state.readScript.set("snags", [
      { data: snagRow({ assigned_to: null }), error: null },
    ]);
    // guard: membership lookup returns nothing for the newly-assigned user
    h.state.readScript.set("memberships", [{ data: null, error: null }]);

    const out = await updateSnagRecord({
      ctx: ctx(),
      user,
      input: {
        id: "s1",
        ...snagBase(),
        assigned_to: "99999999-9999-4999-8999-999999999999",
      },
      baseVersion: V1,
      baseValues: snagBase(),
      clientKey: KEY,
    });

    expect(out).toEqual({ status: "rejected", reason: "assignee_missing" });
    expect(h.state.updates).toHaveLength(0);
  });
});

describe("dispatchOfflineWrite — routes update kinds through the merge core", () => {
  it("a valid site_diary.update envelope reaches the core and applies cleanly", async () => {
    h.state.readScript.set("site_diary_entries", [
      { data: diaryRow(), error: null },
    ]);
    h.state.updateScript.set("site_diary_entries", [{ error: null, count: 1 }]);

    const out = await dispatchOfflineWrite({
      ctx: ctx(),
      user,
      item: {
        clientKey: KEY,
        kind: "site_diary.update",
        orgId: ORG,
        payload: { id: DIARY_ID, ...diaryBase(), notes: "added later" },
        authoredAt: V1,
        baseVersion: V1,
        baseValues: diaryBase(),
      },
    });
    expect(out).toEqual({ status: "accepted", id: DIARY_ID });
  });
});

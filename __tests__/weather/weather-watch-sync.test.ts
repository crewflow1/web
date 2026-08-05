import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  planWatchSync,
  type ExistingJobWatch,
  type JobWatchInput,
} from "@/server/services/weather-watch-sync";
import type { PostcodeDistrict } from "@/lib/weather/types";

/**
 * The weather WATCH PRODUCER — the half that was missing entirely: nothing
 * wrote `weather_watches`, so the fetch pipeline always short-circuited on "no
 * active watches" and the feature was inert even with a provider bound.
 *
 * Everything here is hermetic: the admin client is MOCKED (no Supabase, no
 * realtime client under Node-20 CI), and the pure reconciliation is tested
 * directly. What is proven:
 *
 *   - a live job with a resolvable address becomes ONE active watch, carrying
 *     the correct district and its OWN job's org_id (org scoping without RLS);
 *   - the customer address is the fallback when the job has no site override;
 *   - a job with NO resolvable address is a safe no-op — never a guessed watch;
 *   - a watch whose job is no longer live is DEACTIVATED (closing cleanup);
 *   - a matching paused watch is REACTIVATED, not duplicated.
 */

const adminHolder = vi.hoisted(() => ({
  create: (): unknown => {
    throw new Error("createAdminClient called before the test configured a fake");
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => adminHolder.create(),
}));

const { runWeatherWatchSync } = await import("@/server/services/weather-watch-sync");

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type JobRow = {
  id: string;
  org_id: string;
  customer_id: string | null;
  site_address_line1: string | null;
  site_address_line2: string | null;
  site_city: string | null;
  site_county: string | null;
  site_postcode: string | null;
  site_country: string | null;
};
type CustomerRow = {
  id: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  country: string | null;
};
type WatchRow = { id: string; job_id: string | null; postcode_district: string; active: boolean };

type Op =
  | { table: string; type: "insert"; rows: Array<Record<string, unknown>> }
  | { table: string; type: "update"; values: Record<string, unknown>; ids: readonly unknown[] };

function job(overrides: Partial<JobRow> & Pick<JobRow, "id" | "org_id">): JobRow {
  return {
    customer_id: null,
    site_address_line1: null,
    site_address_line2: null,
    site_city: null,
    site_county: null,
    site_postcode: null,
    site_country: null,
    ...overrides,
  };
}

function customer(overrides: Partial<CustomerRow> & Pick<CustomerRow, "id">): CustomerRow {
  return {
    address_line1: null,
    address_line2: null,
    city: null,
    county: null,
    postcode: null,
    country: null,
    ...overrides,
  };
}

function makeAdmin(config: {
  jobs?: JobRow[] | { error: string };
  customers?: CustomerRow[] | { error: string };
  watches?: WatchRow[] | { error: string };
  insertError?: string;
  updateError?: string;
}) {
  const ops: Op[] = [];
  const result = (data: unknown, err?: string) =>
    err ? { data: null, error: { message: err } } : { data, error: null };

  const thenable = (r: { data: unknown; error: unknown }) => {
    const obj: Record<string, unknown> = {};
    obj["eq"] = () => obj;
    obj["in"] = () => obj;
    // The reads now page via `.order().range()` (F-1). Model the range window by
    // slicing the (small) result set; an error result short-circuits unchanged.
    obj["order"] = () => obj;
    obj["range"] = (from: number, to: number) =>
      Promise.resolve(
        r.error
          ? r
          : { data: (Array.isArray(r.data) ? r.data : []).slice(from, to + 1), error: null },
      );
    obj["then"] = (res: (v: unknown) => unknown) => Promise.resolve(r).then(res);
    return obj;
  };

  const client = {
    from(table: string) {
      if (table === "jobs") {
        const j = config.jobs ?? [];
        return { select: () => thenable(Array.isArray(j) ? result(j) : result(null, j.error)) };
      }
      if (table === "customers") {
        const c = config.customers ?? [];
        return { select: () => thenable(Array.isArray(c) ? result(c) : result(null, c.error)) };
      }
      if (table === "weather_watches") {
        const w = config.watches ?? [];
        return {
          select: () => thenable(Array.isArray(w) ? result(w) : result(null, w.error)),
          insert: (rows: Array<Record<string, unknown>>) => {
            ops.push({ table, type: "insert", rows });
            return Promise.resolve(result(null, config.insertError));
          },
          update: (values: Record<string, unknown>) => ({
            in: (_k: string, ids: readonly unknown[]) => {
              ops.push({ table, type: "update", values, ids });
              return Promise.resolve(result(null, config.updateError));
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client, ops };
}

const inserts = (ops: Op[]) => ops.filter((o): o is Extract<Op, { type: "insert" }> => o.type === "insert");
const updates = (ops: Op[]) => ops.filter((o): o is Extract<Op, { type: "update" }> => o.type === "update");

beforeEach(() => {
  adminHolder.create = () => {
    throw new Error("createAdminClient called before the test configured a fake");
  };
});

// ---------------------------------------------------------------------------
// The pure reconciliation.
// ---------------------------------------------------------------------------

describe("planWatchSync — the pure reconciliation", () => {
  const j = (id: string, org: string, district: string | null): JobWatchInput => ({
    id,
    org_id: org,
    district: district as PostcodeDistrict | null,
  });
  const w = (id: string, jobId: string, district: string, active: boolean): ExistingJobWatch => ({
    id,
    job_id: jobId,
    postcode_district: district,
    active,
  });

  it("inserts a watch for a live job with a district and no existing watch", () => {
    const plan = planWatchSync([j("j1", "o1", "LS1")], []);
    expect(plan.inserts).toEqual([{ org_id: "o1", job_id: "j1", postcode_district: "LS1" }]);
    expect(plan.activate).toEqual([]);
    expect(plan.deactivate).toEqual([]);
  });

  it("ignores a live job with no resolvable district — no guessed watch", () => {
    const plan = planWatchSync([j("j1", "o1", null)], []);
    expect(plan.inserts).toEqual([]);
  });

  it("leaves a matching active watch untouched", () => {
    const plan = planWatchSync([j("j1", "o1", "LS1")], [w("wa", "j1", "LS1", true)]);
    expect(plan.inserts).toEqual([]);
    expect(plan.activate).toEqual([]);
    expect(plan.deactivate).toEqual([]);
  });

  it("reactivates a matching PAUSED watch instead of inserting a duplicate", () => {
    const plan = planWatchSync([j("j1", "o1", "LS1")], [w("wa", "j1", "LS1", false)]);
    expect(plan.inserts).toEqual([]);
    expect(plan.activate).toEqual(["wa"]);
    expect(plan.deactivate).toEqual([]);
  });

  it("deactivates a watch whose job is no longer live", () => {
    const plan = planWatchSync([], [w("wa", "j-old", "LS1", true)]);
    expect(plan.deactivate).toEqual(["wa"]);
    expect(plan.inserts).toEqual([]);
  });

  it("handles an address that moved districts: pause the old, insert the new", () => {
    const plan = planWatchSync([j("j1", "o1", "M1")], [w("wa", "j1", "LS1", true)]);
    expect(plan.deactivate).toEqual(["wa"]);
    expect(plan.inserts).toEqual([{ org_id: "o1", job_id: "j1", postcode_district: "M1" }]);
  });
});

// ---------------------------------------------------------------------------
// The orchestrator, over a mocked admin client.
// ---------------------------------------------------------------------------

describe("runWeatherWatchSync — the producer over a mocked admin client", () => {
  it("creates one active watch with the correct district from a job's SITE address", async () => {
    const { client, ops } = makeAdmin({
      jobs: [job({ id: "j1", org_id: "o1", site_postcode: "LS1 4AP" })],
    });
    adminHolder.create = () => client;

    const summary = await runWeatherWatchSync();

    expect(summary.ok).toBe(true);
    expect(summary.ran).toBe(true);
    expect(summary.jobsConsidered).toBe(1);
    expect(summary.districtsResolved).toBe(1);
    expect(summary.inserted).toBe(1);
    const ins = inserts(ops);
    expect(ins).toHaveLength(1);
    expect(ins[0]!.rows).toEqual([
      { org_id: "o1", job_id: "j1", postcode_district: "LS1", active: true },
    ]);
  });

  it("falls back to the CUSTOMER address when the job has no site override", async () => {
    const { client, ops } = makeAdmin({
      jobs: [job({ id: "j1", org_id: "o1", customer_id: "c1" })],
      customers: [customer({ id: "c1", postcode: "M1 1AA" })],
    });
    adminHolder.create = () => client;

    const summary = await runWeatherWatchSync();

    expect(summary.inserted).toBe(1);
    expect(inserts(ops)[0]!.rows[0]).toMatchObject({
      job_id: "j1",
      postcode_district: "M1",
      active: true,
    });
  });

  it("is ORG-SCOPED: each watch carries its own job's org_id", async () => {
    const { client, ops } = makeAdmin({
      jobs: [
        job({ id: "j1", org_id: "org-A", site_postcode: "LS1 4AP" }),
        job({ id: "j2", org_id: "org-B", site_postcode: "M1 1AA" }),
      ],
    });
    adminHolder.create = () => client;

    await runWeatherWatchSync();

    const rows = inserts(ops).flatMap((o) => o.rows);
    expect(rows).toContainEqual({
      org_id: "org-A",
      job_id: "j1",
      postcode_district: "LS1",
      active: true,
    });
    expect(rows).toContainEqual({
      org_id: "org-B",
      job_id: "j2",
      postcode_district: "M1",
      active: true,
    });
  });

  it("NO-OPS safely for a job with no resolvable address — no insert, no guess", async () => {
    const { client, ops } = makeAdmin({
      // A site line but no postcode, and no customer to inherit from.
      jobs: [job({ id: "j1", org_id: "o1", site_address_line1: "A yard with no postcode" })],
    });
    adminHolder.create = () => client;

    const summary = await runWeatherWatchSync();

    expect(summary.ok).toBe(true);
    expect(summary.jobsConsidered).toBe(1);
    expect(summary.districtsResolved).toBe(0);
    expect(summary.inserted).toBe(0);
    expect(ops).toHaveLength(0);
  });

  it("deactivates a stale watch when its job is no longer live", async () => {
    const { client, ops } = makeAdmin({
      jobs: [], // nothing live
      watches: [{ id: "w-old", job_id: "j-old", postcode_district: "LS1", active: true }],
    });
    adminHolder.create = () => client;

    const summary = await runWeatherWatchSync();

    expect(summary.deactivated).toBe(1);
    expect(summary.inserted).toBe(0);
    const upd = updates(ops);
    expect(upd).toHaveLength(1);
    expect(upd[0]!.values).toEqual({ active: false });
    expect(upd[0]!.ids).toEqual(["w-old"]);
  });

  it("reactivates a matching paused watch rather than inserting a colliding duplicate", async () => {
    const { client, ops } = makeAdmin({
      jobs: [job({ id: "j1", org_id: "o1", site_postcode: "LS1 4AP" })],
      watches: [{ id: "w1", job_id: "j1", postcode_district: "LS1", active: false }],
    });
    adminHolder.create = () => client;

    const summary = await runWeatherWatchSync();

    expect(summary.activated).toBe(1);
    expect(summary.inserted).toBe(0);
    expect(inserts(ops)).toHaveLength(0);
    const upd = updates(ops);
    expect(upd[0]!.values).toEqual({ active: true });
    expect(upd[0]!.ids).toEqual(["w1"]);
  });

  it("a failed jobs read is LOUD (ok:false) and writes nothing", async () => {
    const { client, ops } = makeAdmin({ jobs: { error: "permission denied" } });
    adminHolder.create = () => client;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const summary = await runWeatherWatchSync();
      expect(summary.ok).toBe(false);
      expect(summary.note).toMatch(/jobs read failed/);
      expect(ops).toHaveLength(0);
    } finally {
      errSpy.mockRestore();
    }
  });
});

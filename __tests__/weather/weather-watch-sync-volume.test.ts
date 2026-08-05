import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WEATHER WATCH SYNC — volume + reconciliation-integrity proof (F-1, C35-B).
 *
 * This is a LIVE prod cron whose `planWatchSync` is a reconciliation DIFF, so a
 * truncated read is not a missed row — it is active harm:
 *   · a truncated JOBS read makes live jobs beyond the 1000-row cap look "not
 *     live", so their watches get DEACTIVATED (flapping), and on the next pass
 *     re-INSERTED into a unique index they still occupy (collision);
 *   · a truncated WATCHES read hides existing watches, so `planWatchSync`
 *     re-inserts a watch that already exists → the same unique-index collision.
 *
 * Both reads are now paged via fetchAllRows and the customer `.in()` is chunked
 * at ≤200. This suite MODELS the PostgREST max_rows clamp (1000) on every read
 * and seeds WELL past it, asserting completeness and NO spurious inserts. The
 * pre-fix single-page reads would fail every assertion here.
 *
 * Hermetic: the admin client is a cap-emulating fake — no Supabase, no realtime
 * client under Node-20.
 */

const CLAMP = 1000;
type Row = Record<string, unknown>;

type State = {
  jobs: Row[];
  customers: Row[];
  weather_watches: Row[];
};

type Ops = {
  inserted: Row[];
  activated: unknown[];
  deactivated: unknown[];
  customerInBatchSizes: number[];
};

function makeAdmin(state: State) {
  const ops: Ops = { inserted: [], activated: [], deactivated: [], customerInBatchSizes: [] };

  function selectBuilder(table: keyof State) {
    const preds: Array<(r: Row) => boolean> = [];
    const orderSpecs: Array<[string, boolean]> = [];
    const compute = (): Row[] => {
      let rows = state[table].filter((r) => preds.every((p) => p(r)));
      if (orderSpecs.length) {
        rows = [...rows].sort((a, b) => {
          for (const [c, asc] of orderSpecs) {
            const av = a[c] as string;
            const bv = b[c] as string;
            if (av < bv) return asc ? -1 : 1;
            if (av > bv) return asc ? 1 : -1;
          }
          return 0;
        });
      }
      return rows;
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), builder),
      in: (c: string, v: readonly unknown[]) => {
        if (table === "customers" && c === "id") ops.customerInBatchSizes.push(v.length);
        preds.push((r) => v.includes(r[c]));
        return builder;
      },
      order: (c: string, o: { ascending: boolean }) => (orderSpecs.push([c, o.ascending !== false]), builder),
      // The clamp: no single page window ever exceeds CLAMP rows.
      range: (from: number, to: number) =>
        Promise.resolve({ data: compute().slice(from, from + Math.min(to - from + 1, CLAMP)), error: null }),
      // A bare (unpaged) await would be clamped, exactly like PostgREST.
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: compute().slice(0, CLAMP), error: null }).then(res),
    };
    return builder;
  }

  const client = {
    from(table: string) {
      if (table === "weather_watches") {
        return {
          select: () => selectBuilder("weather_watches"),
          insert: (rows: Row[]) => {
            ops.inserted.push(...rows);
            return Promise.resolve({ data: null, error: null });
          },
          update: (values: Record<string, unknown>) => ({
            in: (_k: string, ids: readonly unknown[]) => {
              if (values.active === true) ops.activated.push(...ids);
              else ops.deactivated.push(...ids);
              return Promise.resolve({ data: null, error: null });
            },
          }),
        };
      }
      if (table === "jobs" || table === "customers") {
        return { select: () => selectBuilder(table) };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client, ops };
}

const adminHolder = vi.hoisted(() => ({ create: (): unknown => { throw new Error("not configured"); } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminHolder.create() }));

const { runWeatherWatchSync } = await import("@/server/services/weather-watch-sync");

const ORG = "org-A";
/** A valid postcode that resolves to the "LS1" district for every seeded job. */
const POSTCODE = "LS1 4AP";

function liveJob(i: number): Row {
  return {
    id: `job-${String(i).padStart(5, "0")}`,
    org_id: ORG,
    status: "in-progress",
    customer_id: null,
    site_address_line1: "1 Test St",
    site_address_line2: null,
    site_city: "Leeds",
    site_county: null,
    site_postcode: POSTCODE,
    site_country: "GB",
  };
}

beforeEach(() => {
  adminHolder.create = () => { throw new Error("not configured"); };
});
afterEach(() => vi.restoreAllMocks());

describe("runWeatherWatchSync — completeness past the 1000-row clamp", () => {
  it("inserts a watch for ALL 1500 live jobs (a single clamped read would give 1000)", async () => {
    const state: State = {
      jobs: Array.from({ length: 1500 }, (_, i) => liveJob(i)),
      customers: [],
      weather_watches: [],
    };
    const { client, ops } = makeAdmin(state);
    adminHolder.create = () => client;

    const summary = await runWeatherWatchSync();

    expect(summary.ok).toBe(true);
    expect(summary.jobsConsidered).toBe(1500);
    expect(summary.districtsResolved).toBe(1500);
    // The crux: every one of the 1500 jobs got a watch — the tail (1001+) is NOT
    // silently dropped. A pre-fix single-page read would insert only 1000.
    expect(summary.inserted).toBe(1500);
    expect(ops.inserted).toHaveLength(1500);
    expect(ops.inserted.some((r) => r.job_id === "job-01499")).toBe(true);
  });
});

describe("runWeatherWatchSync — no spurious re-insert (unique-index collision) past the clamp", () => {
  it("re-inserts NOTHING when all 1500 jobs already have a matching active watch", async () => {
    const jobs = Array.from({ length: 1500 }, (_, i) => liveJob(i));
    const watches: Row[] = jobs.map((j, i) => ({
      id: `watch-${String(i).padStart(5, "0")}`,
      job_id: j.id,
      postcode_district: "LS1",
      active: true,
    }));
    const { client, ops } = makeAdmin({ jobs, customers: [], weather_watches: watches });
    adminHolder.create = () => client;

    const summary = await runWeatherWatchSync();

    expect(summary.ok).toBe(true);
    // If the watches read had clamped to 1000, ~500 jobs would look uncovered and
    // be re-inserted into rows that already exist — the exact collision. Full
    // paging sees all 1500 existing watches, so nothing is inserted or flapped.
    expect(summary.inserted).toBe(0);
    expect(summary.activated).toBe(0);
    expect(summary.deactivated).toBe(0);
    expect(ops.inserted).toHaveLength(0);
    expect(ops.deactivated).toHaveLength(0);
  });
});

describe("runWeatherWatchSync — the customer .in() is chunked at <=200", () => {
  it("resolves districts for 450 customer-addressed jobs across chunked reads", async () => {
    const jobs: Row[] = Array.from({ length: 450 }, (_, i) => {
      const j = liveJob(i);
      j.customer_id = `cust-${String(i).padStart(5, "0")}`;
      // NO site address at all → resolveJobAddress falls back to the customer,
      // so the district must come from the (chunked) customers read.
      j.site_address_line1 = null;
      j.site_address_line2 = null;
      j.site_city = null;
      j.site_county = null;
      j.site_postcode = null;
      j.site_country = null;
      return j;
    });
    const customers: Row[] = Array.from({ length: 450 }, (_, i) => ({
      id: `cust-${String(i).padStart(5, "0")}`,
      address_line1: "2 Client Rd",
      address_line2: null,
      city: "Leeds",
      county: null,
      postcode: POSTCODE,
      country: "GB",
    }));
    const { client, ops } = makeAdmin({ jobs, customers, weather_watches: [] });
    adminHolder.create = () => client;

    const summary = await runWeatherWatchSync();

    // Every job's district resolved via its customer — proving all chunks ran.
    expect(summary.districtsResolved).toBe(450);
    expect(summary.inserted).toBe(450);
    // The 450 ids were fetched in <=200-id batches (200 + 200 + 50), never one
    // oversized `.in()` that would 414 on the URL.
    expect(ops.customerInBatchSizes.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...ops.customerInBatchSizes)).toBeLessThanOrEqual(200);
    expect(ops.customerInBatchSizes.reduce((a, b) => a + b, 0)).toBe(450);
  });
});

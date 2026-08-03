import { describe, it, expect, vi } from "vitest";

// The super-admin allowlist is an ENV allowlist parsed once at import, so it can't
// be stubbed after the fact — mock the predicate directly to exercise both sides
// of the gate deterministically.
vi.mock("@/server/auth/superadmin", () => ({
  isSuperAdminEmail: (email: string | null | undefined) => email === "boss@crewflow.uk",
}));

import { computeNextRun } from "@/lib/automation/cron";
import {
  tickCadences,
  setCadenceEnabled,
  type CadenceClient,
  type CadenceDispatch,
} from "@/server/services/hq-cadence";

/**
 * HQ cadence clock — the tick / claim logic, hermetic (injected clock + an
 * in-memory fake client). Proves the deterministic substrate WITHOUT a database:
 *
 *   · due detection: only enabled cadences whose next_run_at <= now are scanned;
 *   · single-fire under CONCURRENT ticks: the optimistic next_run_at CAS lets
 *     exactly one of three overlapping ticks own an occurrence;
 *   · next_run_at advancement is computed by the SHARED evaluator (computeNextRun);
 *   · an unknown cadence_key routes to no dispatch (never invents a side effect);
 *   · a disabled cadence never fires.
 *
 * The fake models Postgres row serialisation faithfully: the claim's
 * read-check-write happens SYNCHRONOUSLY inside `.select()`, so among concurrent
 * ticks only the first to reach it matches the observed next_run_at.
 */

type StoreRow = {
  id: string;
  cadence_key: string;
  cron_expr: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

function makeRow(over: Partial<StoreRow>): StoreRow {
  return {
    id: over.id ?? crypto.randomUUID(),
    cadence_key: over.cadence_key ?? "research-drain",
    cron_expr: over.cron_expr ?? "*/5 * * * *",
    enabled: over.enabled ?? true,
    next_run_at: over.next_run_at ?? null,
    last_run_at: over.last_run_at ?? null,
    description: over.description ?? null,
    created_by: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

/** An in-memory CadenceClient over a shared row store + a run-log array. */
function fakeClient(store: StoreRow[], runLog: Record<string, unknown>[]): CadenceClient {
  return {
    from(table: string) {
      if (table === "hq_ai_schedule_runs") {
        return {
          insert(row: unknown) {
            runLog.push(row as Record<string, unknown>);
            return Promise.resolve({ error: null });
          },
          // unused branches for this table
          select() {
            throw new Error("not used");
          },
          update() {
            throw new Error("not used");
          },
        } as never;
      }
      // hq_ai_schedules
      return {
        select(_c: string) {
          return {
            // listCadences path
            order(_k: string, _o: { ascending: boolean }) {
              return Promise.resolve({ data: store.map((r) => ({ ...r })), error: null });
            },
            // tick due-scan path: .eq('enabled',true).lte('next_run_at',iso).order().limit()
            eq(_ek: string, ev: unknown) {
              return {
                lte(_lk: string, lv: unknown) {
                  return {
                    order(_ok: string, _oo: { ascending: boolean }) {
                      return {
                        limit(n: number) {
                          const due = store
                            .filter(
                              (r) =>
                                r.enabled === ev &&
                                r.next_run_at !== null &&
                                r.next_run_at <= (lv as string),
                            )
                            .slice(0, n)
                            .map((r) => ({ ...r })); // snapshot copies
                          return Promise.resolve({ data: due, error: null });
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
        update(vals: Record<string, unknown>) {
          return {
            eq(k1: string, v1: unknown) {
              return {
                eq(k2: string, v2: unknown) {
                  return {
                    // The CAS: mutate synchronously so concurrent claims serialise.
                    select(_c: string) {
                      const row = store.find(
                        (r) => (r as Record<string, unknown>)[k1] === v1,
                      );
                      const matches =
                        row && (row as Record<string, unknown>)[k2] === v2;
                      if (row && matches) {
                        Object.assign(row, vals);
                        return Promise.resolve({ data: [{ id: row.id }], error: null });
                      }
                      return Promise.resolve({ data: [], error: null });
                    },
                  };
                },
              };
            },
          };
        },
        insert() {
          throw new Error("not used");
        },
      } as never;
    },
  } as CadenceClient;
}

const NOW = new Date("2026-06-01T12:00:03.000Z");
const PAST = new Date("2026-06-01T11:00:00.000Z").toISOString();
const FUTURE = new Date("2026-06-01T13:00:00.000Z").toISOString();

function countingDispatch(): { map: Record<string, CadenceDispatch>; calls: string[] } {
  const calls: string[] = [];
  const one: CadenceDispatch = async () => {
    calls.push("call");
    return { ok: true };
  };
  return {
    map: {
      "research-drain": one,
      "qualification-drain": one,
      "outreach-drain": one,
      "notifications-drain": one,
      "automation-schedules-drain": one,
    },
    calls,
  };
}

describe("tickCadences — due detection", () => {
  it("fires a due, enabled cadence and skips a future one", async () => {
    const store = [
      makeRow({ cadence_key: "research-drain", next_run_at: PAST }),
      makeRow({ cadence_key: "outreach-drain", next_run_at: FUTURE }),
    ];
    const { map, calls } = countingDispatch();
    const out = await tickCadences({ now: NOW, client: fakeClient(store, []), dispatch: map });

    expect(out.fired).toBe(1);
    expect(out.results.find((r) => r.cadence_key === "research-drain")?.status).toBe("fired");
    expect(out.results.find((r) => r.cadence_key === "outreach-drain")).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("never fires a disabled cadence (dark by default)", async () => {
    const store = [makeRow({ cadence_key: "research-drain", enabled: false, next_run_at: PAST })];
    const { map, calls } = countingDispatch();
    const out = await tickCadences({ now: NOW, client: fakeClient(store, []), dispatch: map });

    expect(out.scanned).toBe(0);
    expect(out.fired).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("tickCadences — next_run_at advances via the shared evaluator", () => {
  it("advances next_run_at to computeNextRun(cron, now) and stamps last_run_at", async () => {
    const store = [makeRow({ cadence_key: "research-drain", cron_expr: "*/5 * * * *", next_run_at: PAST })];
    const { map } = countingDispatch();
    await tickCadences({ now: NOW, client: fakeClient(store, []), dispatch: map });

    const expected = computeNextRun("*/5 * * * *", NOW).toISOString();
    expect(store[0]!.next_run_at).toBe(expected);
    expect(new Date(store[0]!.next_run_at!).getTime()).toBeGreaterThan(NOW.getTime());
    expect(store[0]!.last_run_at).toBe(NOW.toISOString());
  });
});

describe("tickCadences — single-fire under concurrent ticks", () => {
  it("three concurrent ticks fire an occurrence exactly once", async () => {
    const store = [makeRow({ cadence_key: "research-drain", next_run_at: PAST })];
    const { map, calls } = countingDispatch();
    const client = fakeClient(store, []);

    const outs = await Promise.all([
      tickCadences({ now: NOW, client, dispatch: map }),
      tickCadences({ now: NOW, client, dispatch: map }),
      tickCadences({ now: NOW, client, dispatch: map }),
    ]);

    const fires = outs.flatMap((o) => o.results).filter((r) => r.status === "fired");
    expect(fires).toHaveLength(1);
    // The side effect ran exactly once.
    expect(calls).toHaveLength(1);
    // The other ticks recorded a lost claim.
    const lost = outs.flatMap((o) => o.results).filter((r) => r.status === "claim_lost");
    expect(lost.length).toBeGreaterThanOrEqual(2);
  });
});

describe("tickCadences — unknown cadence never invents a side effect", () => {
  it("a registry key with no catalogue binding routes to no_dispatch", async () => {
    const store = [makeRow({ cadence_key: "ghost-cadence", next_run_at: PAST })];
    const { map, calls } = countingDispatch();
    const runLog: Record<string, unknown>[] = [];
    const out = await tickCadences({ now: NOW, client: fakeClient(store, runLog), dispatch: map });

    expect(out.fired).toBe(0);
    expect(out.results[0]?.status).toBe("no_dispatch");
    expect(calls).toHaveLength(0);
    // The occurrence was NOT claimed — next_run_at is untouched.
    expect(store[0]!.next_run_at).toBe(PAST);
    // …and the skip was logged.
    expect(runLog.some((r) => r.outcome === "no_dispatch")).toBe(true);
  });
});

describe("setCadenceEnabled — super-admin gate + catalogue validation", () => {
  it("rejects a non-super-admin without touching the registry", async () => {
    const res = await setCadenceEnabled({
      actor: { id: "u1", email: "nobody@example.com" },
      cadenceKey: "research-drain",
      enabled: true,
    });
    expect(res).toEqual({ ok: false, error: "forbidden" });
  });

  it("rejects an unknown cadence key (after passing the gate)", async () => {
    const res = await setCadenceEnabled({
      actor: { id: "u1", email: "boss@crewflow.uk" },
      cadenceKey: "not-a-cadence",
      enabled: true,
    });
    expect(res).toEqual({ ok: false, error: "unknown_cadence" });
  });
});

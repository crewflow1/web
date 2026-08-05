import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DAILY BRIEFING — compliance-expiry volume proof (F-1, C35-B).
 *
 * THE TRAP. The compliance-expiry read was unpaginated AND carried no LOWER
 * date bound. PostgREST clamps every response to max_rows (1000), so once an org
 * accumulated more than 1000 compliance documents the single 1000-row page —
 * ordered by expiry — could be filled ENTIRELY by long-expired historical docs,
 * and every genuinely-upcoming expiry fell off the end. The briefing then showed
 * a clean all-clear on a certificate that expires next week.
 *
 * THE FIX. The read is now bounded to `[today, cutoff]` (the exact window the
 * counting loop uses) AND paged via fetchAllRows. This test seeds 1200 historical
 * (already-expired) documents plus a handful of genuinely-upcoming ones and
 * proves the upcoming set survives — the pre-fix unbounded clamped read would
 * have returned 1000 historical rows and reported zero upcoming.
 *
 * Hermetic: `@/lib/supabase/server` is mocked with a cap-emulating fake client
 * (no Supabase, no realtime client under Node-20). Every other briefing signal
 * degrades to its honest empty via the same fake; only compliance_documents is
 * seeded, so the sole item under test is the compliance line.
 */

const CLAMP = 1000; // supabase/config.toml max_rows
type Row = Record<string, unknown>;

const dbTables: Record<string, Row[]> = {};

/** A chainable builder that MODELS the PostgREST max_rows clamp + the filters. */
function makeBuilder(table: string) {
  const preds: Array<(r: Row) => boolean> = [];
  const orderSpecs: Array<[string, boolean]> = [];
  let limitN: number | null = null;

  const compute = (): Row[] => {
    let rows = (dbTables[table] ?? []).filter((r) => preds.every((p) => p(r)));
    if (orderSpecs.length) {
      rows = [...rows].sort((a, b) => {
        for (const [c, asc] of orderSpecs) {
          const av = a[c] as string | number | null;
          const bv = b[c] as string | number | null;
          if (av == null && bv == null) continue;
          if (av == null) return asc ? -1 : 1;
          if (bv == null) return asc ? 1 : -1;
          if (av < bv) return asc ? -1 : 1;
          if (av > bv) return asc ? 1 : -1;
        }
        return 0;
      });
    }
    return rows;
  };

  // A bare (unpaged) read is clamped to 1000, exactly like PostgREST.
  const resolveAll = () => {
    const all = compute();
    const capped = limitN != null ? all.slice(0, Math.min(limitN, CLAMP)) : all.slice(0, CLAMP);
    return { data: capped, error: null, count: all.length };
  };

  const proxy: Record<string | symbol, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        switch (prop) {
          case "eq":
            return (c: string, v: unknown) => (preds.push((r) => r[c] === v), proxy);
          case "neq":
            return (c: string, v: unknown) => (preds.push((r) => r[c] !== v), proxy);
          case "in":
            return (c: string, v: readonly unknown[]) => (preds.push((r) => v.includes(r[c])), proxy);
          case "is":
            return (c: string, v: unknown) =>
              (preds.push((r) => (v === null ? r[c] == null : r[c] === v)), proxy);
          case "not":
            return (c: string, op: string, v: unknown) => (
              preds.push((r) => (op === "is" && v === null ? r[c] != null : r[c] !== v)),
              proxy
            );
          case "gte":
            return (c: string, v: unknown) =>
              (preds.push((r) => r[c] != null && (r[c] as string) >= (v as string)), proxy);
          case "gt":
            return (c: string, v: unknown) =>
              (preds.push((r) => r[c] != null && (r[c] as string) > (v as string)), proxy);
          case "lte":
            return (c: string, v: unknown) =>
              (preds.push((r) => r[c] != null && (r[c] as string) <= (v as string)), proxy);
          case "lt":
            return (c: string, v: unknown) =>
              (preds.push((r) => r[c] != null && (r[c] as string) < (v as string)), proxy);
          case "order":
            return (c: string, o?: { ascending?: boolean }) => (
              orderSpecs.push([c, o?.ascending !== false]),
              proxy
            );
          case "limit":
            return (n: number) => ((limitN = n), proxy);
          case "range":
            return (from: number, to: number) =>
              Promise.resolve({
                data: compute().slice(from, from + Math.min(to - from + 1, CLAMP)),
                error: null,
              });
          case "maybeSingle":
            return () => Promise.resolve({ data: compute()[0] ?? null, error: null });
          case "single":
            return () => Promise.resolve({ data: compute()[0] ?? null, error: null });
          case "then":
            return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
              Promise.resolve(resolveAll()).then(res, rej);
          // select() and any other chainable method → no-op returning the builder.
          default:
            return () => proxy;
        }
      },
    },
  );
  return proxy;
}

const fakeClient = { from: (t: string) => makeBuilder(t), rpc: () => Promise.resolve({ data: null, error: null }) };
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient }));

import { buildDailyBriefing } from "@/server/services/briefing";

const ORG = "org-A";
const USER = "user-1";
const NOW = new Date("2026-08-06T09:00:00Z");
const TODAY = "2026-08-06";

beforeEach(() => {
  for (const k of Object.keys(dbTables)) delete dbTables[k];
});
afterEach(() => vi.restoreAllMocks());

describe("Daily Briefing — compliance expiry survives >1000 historical docs (F-1)", () => {
  it("finds the upcoming expiries even behind 1200 already-expired documents", async () => {
    // 1200 long-expired docs (2024) — ordered by expiry ASC they are exactly the
    // rows a pre-fix unbounded, clamped read would have returned first, burying
    // the upcoming ones. The lower date bound now filters them out entirely.
    const historical: Row[] = Array.from({ length: 1200 }, (_, i) => ({
      id: `hist-${String(i).padStart(5, "0")}`,
      org_id: ORG,
      expires_at: `2024-${String((i % 12) + 1).padStart(2, "0")}-15`,
    }));
    // Three genuinely-upcoming expiries inside the 30-day window.
    const upcoming: Row[] = [
      { id: "up-1", org_id: ORG, expires_at: "2026-08-08" }, // +2 days
      { id: "up-2", org_id: ORG, expires_at: "2026-08-11" }, // +5 days
      { id: "up-3", org_id: ORG, expires_at: "2026-08-16" }, // +10 days
    ];
    dbTables.compliance_documents = [...historical, ...upcoming];

    const briefing = await buildDailyBriefing(ORG, USER, NOW);

    const item = briefing.items.find((i) => i.key === "compliance_expiring");
    expect(item, "the compliance-expiring line must be present, not buried").toBeTruthy();
    // All three upcoming docs counted — the tail was NOT crowded out by history.
    expect(item!.count).toBe(3);
    // Soonest is +2 days ⇒ a high-severity line (soonestDays <= 7).
    expect(item!.severity).toBe("high");
  });

  it("today's cutoff is a real floor: a doc that expired yesterday is NOT counted", async () => {
    dbTables.compliance_documents = [
      { id: "y", org_id: ORG, expires_at: "2026-08-05" }, // yesterday — excluded
      { id: "u", org_id: ORG, expires_at: "2026-08-09" }, // upcoming — included
    ];
    const briefing = await buildDailyBriefing(ORG, USER, NOW);
    const item = briefing.items.find((i) => i.key === "compliance_expiring");
    expect(item).toBeTruthy();
    expect(item!.count).toBe(1);
    // sanity: the floor is today.
    expect(TODAY).toBe("2026-08-06");
  });
});

import { describe, it, expect } from "vitest";
import {
  runTelematicsConnectionPass,
  type ConnectionRow,
  type TelematicsConnectionSyncOutcome,
} from "@/server/services/telematics-sync";

/**
 * TELEMATICS SYNC — cron FAIRNESS regression (C71, the C39/C70-D class).
 *
 * The bug: the connected read used a tick-stable `.order("id")` and the pass loop
 * had NO wall-clock budget. At scale Vercel kills the pass mid-loop (maxDuration=
 * 60), and because the order never changed, the SAME low-id head was re-serviced
 * every tick while the high-id TAIL was never reached — those feeds silently never
 * synced.
 *
 * The fix has two halves, proven here against the extracted, budgeted pass loop
 * with an injected clock (no DB, no network):
 *
 *   1. PASS BUDGET — with more connections than the budget allows, the pass stops
 *      EARLY (does not process all of them) and leaves the rest untouched.
 *   2. NO PERMANENT TAIL — driving consecutive passes over a set that is re-ordered
 *      by last_sync_at (nulls-first) between passes — exactly what the real
 *      connected read does — EVERY connection is eventually processed. A tick-stable
 *      order + no budget would starve the tail forever; the fair order + budget
 *      rotates it in.
 */

function makeConn(id: string, lastSyncAt: string | null): ConnectionRow {
  return {
    id,
    org_id: `org-${id}`,
    provider: "samsara",
    external_account_id: `acct-${id}`,
    access_token: "cipher",
    refresh_token: null,
    token_expires_at: null,
    last_sync_at: lastSyncAt,
  };
}

function outcomeFor(conn: ConnectionRow): TelematicsConnectionSyncOutcome {
  return {
    connectionId: conn.id,
    orgId: conn.org_id,
    outcome: "empty",
    written: 0,
    refreshed: false,
    message: "ok",
  };
}

/**
 * A clock that advances by `step` ms on EVERY call. The pass calls it once for
 * `startedAt` then once at the top of each iteration, so with step=20 /
 * perOrgBudgetMs=5 / passBudgetMs=50 the guard `now-startedAt+5 > 50` first trips
 * at the 3rd iteration → exactly 2 connections processed per pass.
 */
function steppingClock(step: number): () => number {
  let calls = 0;
  return () => step * calls++;
}

/**
 * The fair connected-read order the DB performs: last_sync_at ASC, NULLS FIRST,
 * then id. Modelled in memory so the multi-pass rotation is deterministic.
 */
function fairOrder(conns: ConnectionRow[]): ConnectionRow[] {
  return [...conns].sort((a, b) => {
    const av = a.last_sync_at;
    const bv = b.last_sync_at;
    if (av === null && bv === null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    if (av === null) return -1;
    if (bv === null) return 1;
    if (av !== bv) return av < bv ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

describe("telematics pass budget stops the pass early", () => {
  it("processes only what fits the budget, leaving the rest for the next pass", async () => {
    const conns = ["a", "b", "c", "d", "e"].map((id) => makeConn(id, null));
    const seen: string[] = [];

    const { processed } = await runTelematicsConnectionPass(
      conns,
      async (conn) => {
        seen.push(conn.id);
        return outcomeFor(conn);
      },
      { now: steppingClock(20), passBudgetMs: 50, perOrgBudgetMs: 5 },
    );

    // 5 connections offered, only 2 fit the budget — the pass stops cleanly.
    expect(seen).toEqual(["a", "b"]);
    expect(processed).toHaveLength(2);
    // The remaining 3 were NOT touched (not errored, not synced) — left for later.
    expect(seen).not.toContain("c");
  });

  it("with real time and a tiny set the whole set is processed in one pass", async () => {
    const conns = ["a", "b", "c"].map((id) => makeConn(id, null));
    const seen: string[] = [];
    const { processed } = await runTelematicsConnectionPass(conns, async (conn) => {
      seen.push(conn.id);
      return outcomeFor(conn);
    });
    expect(seen).toEqual(["a", "b", "c"]);
    expect(processed).toHaveLength(3);
  });
});

describe("no permanent tail — every connection is eventually processed", () => {
  it("rotates the tail in across consecutive fairly-ordered passes", async () => {
    // 5 never-synced connections, a budget that clears exactly 2 per pass. A tick-
    // stable order would re-service {a,b} forever and STARVE {c,d,e}. The fair
    // last_sync_at order (a synced connection sinks to the back) rotates them in.
    let clockBase = 1_000_000; // ms; monotonic across passes for distinct last_sync_at
    const state: ConnectionRow[] = ["a", "b", "c", "d", "e"].map((id) => makeConn(id, null));
    const everSeen = new Set<string>();

    for (let pass = 0; pass < 4; pass++) {
      const ordered = fairOrder(state);
      const { processed } = await runTelematicsConnectionPass(
        ordered,
        async (conn) => {
          everSeen.add(conn.id);
          // Simulate markSynced: stamp a fresh, strictly-increasing last_sync_at so
          // this connection sinks below the still-unsynced tail next pass.
          const row = state.find((c) => c.id === conn.id)!;
          row.last_sync_at = new Date(clockBase++).toISOString();
          return outcomeFor(conn);
        },
        { now: steppingClock(20), passBudgetMs: 50, perOrgBudgetMs: 5 },
      );
      expect(processed.length).toBeLessThanOrEqual(2); // budget always bites
    }

    // After enough passes EVERY connection has been serviced — no starved tail.
    expect([...everSeen].sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("a tick-stable order with no rotation WOULD starve the tail (counterfactual)", async () => {
    // The delete-the-fix shape: never re-order, always feed the same list, budget of
    // 2 → {a,b} are serviced every pass and {c,d,e} NEVER are.
    const conns = ["a", "b", "c", "d", "e"].map((id) => makeConn(id, null));
    const everSeen = new Set<string>();
    for (let pass = 0; pass < 4; pass++) {
      await runTelematicsConnectionPass(
        conns, // NEVER re-ordered — the pre-fix tick-stable behaviour
        async (conn) => {
          everSeen.add(conn.id);
          return outcomeFor(conn);
        },
        { now: steppingClock(20), passBudgetMs: 50, perOrgBudgetMs: 5 },
      );
    }
    // The tail is permanently starved without the fair-ordering rotation.
    expect([...everSeen].sort()).toEqual(["a", "b"]);
  });
});

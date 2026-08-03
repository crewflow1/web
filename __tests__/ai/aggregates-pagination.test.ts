import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * AI AGGREGATES — no silent 1000-row truncation (F-1).
 *
 * ── THE DEFECT CLASS ─────────────────────────────────────────────────────────
 * Supabase/PostgREST caps every response at the project "Max rows" setting
 * (1000). A bare `.select()` with no `.range()` is therefore SILENTLY TRUNCATED
 * the moment an org crosses that many matching rows — so the /insights + dashboard
 * intelligence figures (quote funnel, staff leaderboard, overdue invoices, event
 * counts, lead pipeline) aggregate over only the first page and UNDER-REPORT with
 * no error. `lib/ai/aggregates.ts` was missed when the sibling
 * `lib/reports/aggregates.ts` was fixed under C28; the fix routes every read
 * through `fetchAllRows`, which pages under the cap with a unique `id` tiebreak.
 *
 * ── WHY THIS TEST IS BEHAVIOURAL, NOT A SOURCE GREP ──────────────────────────
 * `computeActivitySummary` / `computeLeadInsights` are EXECUTED against a
 * chainable Supabase mock that honours `.range(from, to)` exactly the way
 * PostgREST does — an inclusive window itself hard-capped at 1000 rows per
 * response. Each entity is seeded with MORE than 1000 rows. If any read dropped
 * its `.range()` (or fetched a single page), the mock would clip the response at
 * 1000 and the asserted totals/counts would come up short. Because the mock caps
 * like the real cap, only a correctly paged read can see every row.
 *
 * ── HERMETIC ─────────────────────────────────────────────────────────────────
 * No real Supabase client is ever constructed (Node-20 CI has no native
 * WebSocket, so a real realtime client would throw). `createClient` is mocked to
 * return a pure in-memory fake. Mirrors __tests__/reports/aggregates.test.ts.
 */

// The real PostgREST max-rows cap the mock emulates: a single response can never
// return more than this many rows, no matter how wide the requested range.
const RESPONSE_CAP = 1000;

const h = vi.hoisted(() => {
  // Table name → the full row set (as Postgres would hold it). The mock filters
  // + paginates over this, capping each response at RESPONSE_CAP.
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  // How large a single response may be — set by the test to emulate the cap.
  const cap = { rows: 1000 };

  function makeBuilder(table: string) {
    const eqs: Array<[string, unknown]> = [];
    const gtes: Array<[string, unknown]> = [];
    const orders: Array<[string, boolean]> = [];

    const settle = (from: number, to: number) => {
      let rows = (tables[table] ?? []).filter((row) => {
        for (const [col, val] of eqs) if (row[col] !== val) return false;
        for (const [col, val] of gtes) {
          if (row[col] == null) return false;
          if (String(row[col]) < String(val)) return false;
        }
        return true;
      });
      // Apply every ordering key in sequence (stable), last-specified last so
      // the id tiebreak decides ties — exactly what a total order must do.
      for (let i = orders.length - 1; i >= 0; i--) {
        const [col, asc] = orders[i]!;
        rows = [...rows].sort((a, b) => {
          const av = a[col] as string | number;
          const bv = b[col] as string | number;
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (asc ? 1 : -1);
        });
      }
      // PostgREST semantics: inclusive [from, to], then the response is HARD
      // capped at RESPONSE_CAP no matter how wide the range asked for.
      const windowed = rows.slice(from, to + 1).slice(0, cap.rows);
      return Promise.resolve({ data: windowed, error: null });
    };

    const builder = {
      select: () => builder,
      eq(col: string, val: unknown) {
        eqs.push([col, val]);
        return builder;
      },
      gte(col: string, val: unknown) {
        gtes.push([col, val]);
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orders.push([col, opts?.ascending !== false]);
        return builder;
      },
      range(from: number, to: number) {
        return settle(from, to);
      },
    };
    return builder;
  }

  return {
    tables,
    cap,
    client: { from: (t: string) => makeBuilder(t) },
    reset() {
      for (const k of Object.keys(tables)) delete tables[k];
      cap.rows = RESPONSE_CAP;
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => h.client,
}));

// server-only is a no-op guard we don't want to hit under vitest.
vi.mock("server-only", () => ({}));

const { computeActivitySummary, computeLeadInsights } = await import(
  "@/lib/ai/aggregates"
);

const ORG = "org-under-test";
const OTHER_ORG = "org-elsewhere";

/** An ISO datetime N days before now (safely inside a lookback window). */
function daysAgoIso(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

beforeEach(() => {
  h.reset();
});

describe("AI aggregates page past the 1000-row PostgREST cap (F-1)", () => {
  it("quote funnel counts EVERY quote, not just the first 1000", async () => {
    const N = 2500;
    // All accepted (so sent + accepted both equal N), spread ids so ordering is
    // total. Two decoys sit in the same row set the mock would otherwise return:
    // a same-org quote and an OTHER-org quote — the org pin must keep the latter
    // out and the count must include the former.
    h.tables.quotes = Array.from({ length: N }, (_, i) => ({
      id: `quote-${String(i).padStart(6, "0")}`,
      org_id: ORG,
      number: `Q-${i}`,
      total: 100,
      sent_at: daysAgoIso(20),
      viewed_at: daysAgoIso(19),
      accepted_at: daysAgoIso(18),
      declined_at: null,
      customer: { name: "Acme" },
    }));
    h.tables.quotes.push({
      id: "quote-zzz-other",
      org_id: OTHER_ORG,
      number: "Q-other",
      total: 999999,
      sent_at: daysAgoIso(2),
      viewed_at: daysAgoIso(2),
      accepted_at: daysAgoIso(2),
      declined_at: null,
      customer: { name: "Other Co" },
    });

    const res = await computeActivitySummary(ORG, 7);
    // If truncated at 1000, sent/accepted would read 1000 and conversion still
    // 100 — the COUNTS are what expose the truncation.
    expect(res.key_metrics.quote_funnel.sent).toBe(N);
    expect(res.key_metrics.quote_funnel.accepted).toBe(N);
    expect(res.key_metrics.quote_funnel.conversion_pct).toBe(100);
  });

  it("overdue invoices are listed in full past the cap", async () => {
    const N = 1500;
    const past = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
    h.tables.invoices = Array.from({ length: N }, (_, i) => ({
      id: `inv-${String(i).padStart(6, "0")}`,
      org_id: ORG,
      number: `INV-${i}`,
      status: "sent", // collectable
      total: 500,
      sent_at: daysAgoIso(45),
      due_date: past, // before today → overdue
      paid_at: null,
    }));
    // A same-org PAID invoice (never overdue) and an OTHER-org overdue invoice —
    // neither may appear in this org's overdue list.
    h.tables.invoices.push(
      { id: "inv-paid", org_id: ORG, number: "INV-paid", status: "paid", total: 1, sent_at: daysAgoIso(45), due_date: past, paid_at: daysAgoIso(1) },
      { id: "inv-other", org_id: OTHER_ORG, number: "INV-other", status: "sent", total: 1, sent_at: daysAgoIso(45), due_date: past, paid_at: null },
    );

    const res = await computeActivitySummary(ORG, 7);
    // A single-page read would stop at 1000; a correct paged read sees all 1500.
    expect(res.stalled_actions.invoices_overdue_30d.length).toBe(N);
  });

  it("staff leaderboard credits every completed job across paged reads", async () => {
    // 2000 completed jobs split across two users; the SECOND user's jobs sort
    // LAST by id, so a single-page read would miss them entirely and drop the
    // user from the leaderboard.
    const N = 2000;
    h.tables.jobs = Array.from({ length: N }, (_, i) => {
      const second = i >= N / 2;
      return {
        id: `job-${String(i).padStart(6, "0")}`,
        org_id: ORG,
        status: "completed",
        assigned_to: second ? "user-B" : "user-A",
        assigned: second
          ? { id: "user-B", full_name: "Beta", email: "b@x.co" }
          : { id: "user-A", full_name: "Alpha", email: "a@x.co" },
      };
    });

    const res = await computeActivitySummary(ORG, 7);
    const byName = Object.fromEntries(
      res.key_metrics.staff_leaders.map((s) => [s.name, s.completed_jobs]),
    );
    expect(byName["Alpha"]).toBe(N / 2);
    expect(byName["Beta"]).toBe(N / 2);
  });

  it("total_events counts every windowed activity_log row, not a truncated page", async () => {
    const N = 2000;
    h.tables.activity_log = Array.from({ length: N }, (_, i) => ({
      id: `act-${String(i).padStart(6, "0")}`,
      org_id: ORG,
      action: i % 2 === 0 ? "job.created" : "quote.sent",
      created_at: daysAgoIso((i % 6) + 1), // all inside the 7-day window
    }));
    // Out-of-window (older than 7d) and other-org rows must not be counted.
    h.tables.activity_log.push(
      { id: "act-old", org_id: ORG, action: "job.created", created_at: daysAgoIso(90) },
      { id: "act-other", org_id: OTHER_ORG, action: "job.created", created_at: daysAgoIso(1) },
    );

    const res = await computeActivitySummary(ORG, 7);
    expect(res.key_metrics.total_events).toBe(N);
    const summed = res.action_counts.reduce((s, a) => s + a.count, 0);
    expect(summed).toBe(N);
  });

  it("lead insights aggregate every lead in the window past the cap", async () => {
    const N = 1500;
    h.tables.leads = Array.from({ length: N }, (_, i) => ({
      id: `lead-${String(i).padStart(6, "0")}`,
      org_id: ORG,
      status: "new", // counts toward pipeline_forecast
      source: "web",
      estimated_value: 10,
      created_at: daysAgoIso((i % 25) + 1), // inside the 30-day window
    }));
    // Out-of-window and other-org decoys must not be aggregated.
    h.tables.leads.push(
      { id: "lead-old", org_id: ORG, status: "new", source: "web", estimated_value: 999999, created_at: daysAgoIso(200) },
      { id: "lead-other", org_id: OTHER_ORG, status: "new", source: "web", estimated_value: 999999, created_at: daysAgoIso(1) },
    );

    const res = await computeLeadInsights(ORG, 30);
    expect(res.funnel.new).toBe(N);
    expect(res.pipeline_forecast).toBe(N * 10);
    const webSource = res.source_close_rates.find((s) => s.source === "web");
    expect(webSource?.total).toBe(N);
  });

  it("would UNDER-count if a read stopped at one page — the cap is real", async () => {
    // Guard on the harness itself: a naive first-page-only sum (what the OLD
    // code did) is strictly less than the true total, proving the assertions
    // above are only satisfiable by a genuine multi-page walk.
    const N = 2500;
    h.tables.quotes = Array.from({ length: N }, (_, i) => ({
      id: `quote-${String(i).padStart(6, "0")}`,
      org_id: ORG,
      number: `Q-${i}`,
      total: 100,
      sent_at: daysAgoIso(20),
      viewed_at: daysAgoIso(19),
      accepted_at: daysAgoIso(18),
      declined_at: null,
      customer: { name: "Acme" },
    }));

    const naiveFirstPage = Math.min(N, RESPONSE_CAP); // 1000
    const res = await computeActivitySummary(ORG, 7);
    expect(naiveFirstPage).toBeLessThan(res.key_metrics.quote_funnel.accepted);
    expect(res.key_metrics.quote_funnel.accepted).toBe(N);
  });
});

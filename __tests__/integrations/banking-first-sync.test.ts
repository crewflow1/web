import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { TrueLayerAdapter } from "@/lib/integrations/banking/adapters/truelayer";

/**
 * FIRST-SYNC BOUNDS — hermetic proofs (no DB, no network).
 *
 * Two activation-breakers on an account's FIRST sync (no last_sync_at):
 *
 *  1. UNBOUNDED BACKFILL. With no `since`, the TrueLayer adapter defaulted the
 *     `from` window to ~2 years back — an unbounded first pull. It is now capped
 *     to a 90-day backfill (steady-state runs extend forward via the engine's
 *     7-day overlap window, so nothing is missed). Proven by inspecting the
 *     `from=` the adapter puts on the /transactions URL (fetch mocked).
 *
 *  2. UNCHUNKED DEDUPE .in(). The full first-sync candidate list was sent to the
 *     dedupe read in ONE supabase-js `.in()` — a GET whose ids ride in the URL,
 *     overflowing the request-line limit. createAdminGateway().existingProviderTxIds
 *     now chunks the ids into ≤200-per-query batches and unions the results. Proven
 *     here against a MOCKED admin client that records every batch (no real DB).
 */

// ── Chunking: mock the service-role admin client the gateway builds on ────────
// A per-test mutable the vi.mock factory reads, so each test installs its own fake.
let fakeAdmin: unknown = null;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fakeAdmin,
}));

// Imported AFTER the mock is declared (vi.mock is hoisted, so this is safe).
import { createAdminGateway } from "@/server/services/bank-sync";

/**
 * Minimal admin fake matching the exact chain existingProviderTxIds drives:
 *   admin.from(t).select(c).eq(col,val).in(col,vals) → { data, error }.
 * It records the size of every `.in()` batch and answers from a known existing set.
 */
function recordingAdmin(existing: Set<string>) {
  const batches: number[] = [];
  const admin = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                in(_col: string, vals: string[]) {
                  batches.push(vals.length);
                  const data = vals
                    .filter((v) => existing.has(v))
                    .map((v) => ({ provider_tx_id: v }));
                  return Promise.resolve({ data, error: null });
                },
              };
            },
          };
        },
      };
    },
  };
  return { admin, batches };
}

beforeEach(() => {
  fakeAdmin = null;
  vi.restoreAllMocks();
});
afterEach(() => {
  fakeAdmin = null;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. First-sync backfill window is bounded (~90 days), not ~2 years
// ---------------------------------------------------------------------------

describe("TrueLayer first-sync backfill window", () => {
  function enableTrueLayer(): void {
    process.env.NEXT_PUBLIC_FEATURE_BANKING_CONNECT = "true";
    process.env.BANKING_PROVIDER = "truelayer";
    process.env.BANKING_CLIENT_ID = "client-id";
    process.env.BANKING_CLIENT_SECRET = "client-secret";
  }
  const BANKING_ENV = [
    "NEXT_PUBLIC_FEATURE_BANKING_CONNECT",
    "BANKING_PROVIDER",
    "BANKING_CLIENT_ID",
    "BANKING_CLIENT_SECRET",
  ];
  afterEach(() => {
    for (const k of BANKING_ENV) delete process.env[k];
  });

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("defaults `from` to ~90 days back (bounded) when there is no `since` (first sync)", async () => {
    enableTrueLayer();
    const router = vi.fn(async (url: unknown): Promise<Response> => {
      const u = String(url);
      if (u.endsWith("/data/v1/accounts")) {
        return json({ results: [{ account_id: "acc-1", display_name: "A" }] });
      }
      if (u.includes("/transactions")) return json({ results: [] });
      throw new Error(`unexpected ${u}`);
    });
    vi.stubGlobal("fetch", router);

    const before = Date.now();
    const res = await new TrueLayerAdapter().fetchStatements({
      accessToken: "a",
      connectionRef: "conn-1",
      since: null, // ← first sync
    });
    const after = Date.now();
    expect(res.ok).toBe(true);

    const txCall = router.mock.calls.find((c) => String(c[0]).includes("/transactions"));
    const url = String(txCall?.[0]);
    const m = url.match(/from=([^&]+)/);
    expect(m, `no from= in ${url}`).not.toBeNull();
    const fromMs = Date.parse(decodeURIComponent(m![1]!));

    const days = (t: number) => t - 90 * 24 * 60 * 60 * 1000;
    // The window opens ~90 days back — bounded, NOT ~2 years.
    expect(fromMs).toBeGreaterThanOrEqual(days(before) - 60_000);
    expect(fromMs).toBeLessThanOrEqual(days(after) + 60_000);

    // Hard ceiling: comfortably under a year back (the old default was ~2 years).
    const oneYearBack = before - 365 * 24 * 60 * 60 * 1000;
    expect(fromMs).toBeGreaterThan(oneYearBack);
  });
});

// ---------------------------------------------------------------------------
// 2. Dedupe read chunks a large candidate set (no single overflowing .in())
// ---------------------------------------------------------------------------

describe("existingProviderTxIds chunks a large candidate set", () => {
  it("splits > 1000 ids into ≤200-per-query batches and unions the results", async () => {
    const existing = new Set<string>();
    // Half the candidates exist; interleaved so every chunk carries a mix.
    const candidates: string[] = [];
    for (let i = 0; i < 1050; i++) {
      const id = `tx-${String(i).padStart(5, "0")}`;
      candidates.push(id);
      if (i % 2 === 0) existing.add(id);
    }
    const { admin, batches } = recordingAdmin(existing);
    fakeAdmin = admin;

    const gw = createAdminGateway();
    const result = await gw.existingProviderTxIds("org-1", candidates);

    // Chunked: more than one query, none exceeding the 100-id cap.
    expect(batches.length).toBeGreaterThan(1);
    for (const n of batches) expect(n).toBeLessThanOrEqual(100);
    // Every candidate was queried exactly once across the batches.
    expect(batches.reduce((a, b) => a + b, 0)).toBe(candidates.length);

    // Union is exactly the existing subset — no chunk dropped or double-counted.
    expect(result.size).toBe(existing.size);
    for (const id of existing) expect(result.has(id)).toBe(true);
    expect(result.has("tx-00001")).toBe(false); // an odd id that does not exist
  });

  it("short-circuits an empty candidate list with no query", async () => {
    const { admin, batches } = recordingAdmin(new Set());
    fakeAdmin = admin;
    const gw = createAdminGateway();
    const result = await gw.existingProviderTxIds("org-1", []);
    expect(result.size).toBe(0);
    expect(batches).toHaveLength(0);
  });
});

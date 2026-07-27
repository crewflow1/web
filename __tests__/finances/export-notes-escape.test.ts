import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Regression: the finances CSV export must escape each field EXACTLY once.
 *
 * The row builder used to call `csvEscape(r.notes)` and then run the whole
 * row through `.map(csvEscape)` — a second pass that re-quoted the already
 * quoted note. A note containing a comma came out triple-quoted
 * (`"""a, b"""`), which Excel / Google Sheets render as broken CSV. The fix
 * passes the raw `r.notes ?? ""` into the row so the single `.map(csvEscape)`
 * does all the quoting, uniformly with every other column (and matching the
 * invoices export route).
 *
 * This drives the REAL GET handler with a mocked, RLS-scoped Supabase and a
 * note that contains a comma, then asserts the note is wrapped in ONE pair of
 * quotes and is never triple-quoted.
 */

// A single finances row whose `notes` needs quoting (it contains a comma).
const financeRows = [
  {
    created_at: "2026-07-01T09:00:00.000Z",
    job_id: "job-abc",
    category: "materials",
    amount: 100,
    vat_rate: 20,
    vat_total: 20,
    notes: "delivered, on site",
  },
];

// Chainable query-builder stub: every builder method returns the same
// thenable, which resolves to the finances rows when awaited.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: (_table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.order = () => chain;
      chain.limit = () => chain;
      chain.gte = () => chain;
      chain.lte = () => chain;
      chain.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: financeRows, error: null });
      return chain;
    },
  })),
}));

vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => ({ ctx: { org: { id: "org-1" } } })),
}));

// Import under test AFTER the mocks are registered.
const { GET } = await import("@/app/api/finances/export/route");

function makeRequest(): NextRequest {
  // The finances route only reads `request.nextUrl.searchParams`; a URL is a
  // sufficient stand-in (no from/to → no date filtering).
  return {
    nextUrl: new URL("https://crewflow.uk/api/finances/export"),
  } as unknown as NextRequest;
}

describe("GET /api/finances/export — notes are quoted exactly once", () => {
  let text: string;

  beforeEach(async () => {
    const res = await GET(makeRequest());
    text = await res.text();
  });

  it("wraps a comma-bearing note in a single pair of quotes", () => {
    // After the `total` column (120.00) and a comma, the note is quoted once:
    //   ...,120.00,"delivered, on site"
    expect(text).toContain(',"delivered, on site"');
  });

  it("never triple-quotes — the double-escape signature is gone", () => {
    expect(text).not.toContain('"""');
  });

  it("emits exactly one data row under the canonical header", () => {
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe(
      "date,job_id,category,amount,vat_rate,vat_total,total,notes",
    );
    expect(lines).toHaveLength(2);
    // The data row ends with the single-quoted note.
    expect(lines[1]!.endsWith(',"delivered, on site"')).toBe(true);
  });
});

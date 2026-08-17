import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Public API v1 — two S3 defect fixes, executed against mocked deps.
 *
 * (1) GET /api/v1/jobs/[id] must validate the id as a UUID BEFORE it reaches
 *     the org-pinned load. A non-UUID would otherwise become `.eq("id", id)`
 *     → Postgres 22P02 → readFailure → 500 (a malformed-id oracle). It must
 *     404 without ever touching the DB.
 *
 * (2) POST /api/v1/quotes is a two-insert sequence (parent quote, then line
 *     items). A line-items failure must NOT leave an orphan draft quote (which
 *     would also burn the derived quote number): the handler must roll the
 *     parent back with an org-pinned delete and fail loudly.
 */

// ---------------------------------------------------------------------------
// Hoisted, per-test-controllable mock state
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  return {
    // jobs GET
    loadJobForOrg: vi.fn(),
    // quotes POST admin client behaviour
    lineItemsError: null as { message?: string | null } | null,
    quoteInsertRow: { id: "quote-1" } as unknown,
    // recorders
    deleteCalls: [] as Array<{ eqs: Array<[string, unknown]> }>,
    lineItemInserts: [] as unknown[],
  };
});

vi.mock("@/lib/public-api/guard", () => ({
  guardPublicJobsRequest: vi.fn(async () => ({
    ok: true,
    key: { orgId: "org-1" },
  })),
  guardPublicApiRequest: vi.fn(async () => ({
    ok: true,
    key: { orgId: "org-1" },
  })),
}));

vi.mock("@/lib/jobs/load", () => ({
  loadJobForOrg: h.loadJobForOrg,
}));

vi.mock("@/lib/crm/reference-integrity", () => ({
  verifyQuoteReferences: vi.fn(async () => ({ ok: true })),
  verifyCustomerInOrg: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: vi.fn(async () => ({ data: "Q-0001", error: null })),
    from: (table: string) => {
      if (table === "quote_line_items") {
        return {
          insert: (rows: unknown) => {
            h.lineItemInserts.push(rows);
            return Promise.resolve({ error: h.lineItemsError });
          },
        };
      }
      // "quotes" — both the insert (create) and the delete (rollback) paths.
      return {
        insert: () => ({
          select: () => ({
            single: async () => ({ data: h.quoteInsertRow, error: null }),
          }),
        }),
        delete: () => {
          const eqs: Array<[string, unknown]> = [];
          const chain = {
            eq: (c: string, v: unknown) => {
              eqs.push([c, v]);
              if (eqs.length >= 2) {
                h.deleteCalls.push({ eqs });
                return Promise.resolve({ error: null });
              }
              return chain;
            },
          };
          return chain;
        },
      };
    },
  }),
}));

// The DTO mapper is only reached on the success path; keep it trivial so the
// mocked quote row need not carry a full column set.
vi.mock("@/lib/public-api/quotes", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, toPublicQuoteDto: (r: unknown) => r };
});

import { GET as jobsGet } from "@/app/api/v1/jobs/[id]/route";
import { POST as quotesPost } from "@/app/api/v1/quotes/route";

const req = (url = "https://app.crewflow.uk/api/v1/x") => new Request(url);
const jsonReq = (body: unknown) =>
  new Request("https://app.crewflow.uk/api/v1/quotes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  h.loadJobForOrg.mockReset();
  h.loadJobForOrg.mockResolvedValue(null);
  h.lineItemsError = null;
  h.quoteInsertRow = { id: "quote-1" };
  h.deleteCalls.length = 0;
  h.lineItemInserts.length = 0;
});

// ---------------------------------------------------------------------------
// Defect 1 — jobs GET-by-id validates the UUID before the query
// ---------------------------------------------------------------------------

describe("GET /api/v1/jobs/[id] — UUID validation (500→404)", () => {
  it("404s a non-UUID id WITHOUT touching the DB (no 500 oracle)", async () => {
    const res = await jobsGet(req(), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
    // The load must never run for a malformed id — that is the whole point.
    expect(h.loadJobForOrg).not.toHaveBeenCalled();
  });

  it("404s other obviously-malformed ids without a DB read", async () => {
    for (const bad of ["123", "", "'; drop table jobs;--", "abc-def"]) {
      const res = await jobsGet(req(), {
        params: Promise.resolve({ id: bad }),
      });
      expect(res.status).toBe(404);
    }
    expect(h.loadJobForOrg).not.toHaveBeenCalled();
  });

  it("passes a well-formed UUID through to the org-pinned load", async () => {
    const id = crypto.randomUUID();
    const res = await jobsGet(req(), { params: Promise.resolve({ id }) });
    // Row is null in this test → still 404, but the load WAS consulted.
    expect(res.status).toBe(404);
    expect(h.loadJobForOrg).toHaveBeenCalledTimes(1);
    expect(h.loadJobForOrg).toHaveBeenCalledWith(
      expect.anything(),
      id,
      "org-1",
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Defect 2 — quote create rolls the parent back on a line-items failure
// ---------------------------------------------------------------------------

const validQuoteBody = {
  customer_id: crypto.randomUUID(),
  line_items: [
    { description: "Labour", qty: 2, unit_price: 100, vat_rate: 20 },
  ],
};

describe("POST /api/v1/quotes — atomic create (no orphan on line-items failure)", () => {
  it("rolls the parent quote back (org-pinned delete) when line items fail", async () => {
    h.lineItemsError = { message: "boom" };

    const res = await quotesPost(jsonReq(validQuoteBody));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("write_failed");

    // The orphan must have been deleted — exactly once, pinned to id AND org.
    expect(h.deleteCalls).toHaveLength(1);
    expect(h.deleteCalls[0]!.eqs).toEqual([
      ["id", "quote-1"],
      ["org_id", "org-1"],
    ]);
  });

  it("does NOT delete anything on a clean create", async () => {
    h.lineItemsError = null;

    const res = await quotesPost(jsonReq(validQuoteBody));

    expect(res.status).toBe(201);
    expect(h.lineItemInserts).toHaveLength(1);
    expect(h.deleteCalls).toHaveLength(0);
  });
});

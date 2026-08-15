import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SCOPES, SCOPE_LABELS } from "@/lib/api-auth/scopes";

/**
 * Public API v1 WRITE surface — trust-boundary pins (source assertions).
 *
 * The writes reuse the read surface's dark flag + guard (asserted in
 * public-api-jobs / -expansion). These pins freeze the extra properties a WRITE
 * must never lose: the DISTINCT write scope per route (a read key can't write),
 * org-pinning of every insert to the KEY'S org, no cross-org update (id AND
 * org_id on the write predicate), strict body validation (no mass assignment),
 * server-side money on quotes, cross-org reference verification, and the
 * leads-is-write-only / invoices-is-read-only shape. If any erode, a test here
 * goes red rather than the hole shipping.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ---------------------------------------------------------------------------
// 1. Scope registry — the write scopes exist, are labelled, and are distinct
// ---------------------------------------------------------------------------

describe("scope registry — read and write are distinct capabilities", () => {
  it("defines a write scope for each writable resource", () => {
    for (const s of ["write:customers", "write:leads", "write:jobs", "write:quotes"]) {
      expect([...SCOPES]).toContain(s);
      expect(SCOPE_LABELS).toHaveProperty(s);
    }
  });

  it("does NOT define a write scope for invoices (read-only resource)", () => {
    expect([...SCOPES]).not.toContain("write:invoices");
  });

  it("does NOT define read:leads (leads is a write-only capability)", () => {
    expect([...SCOPES]).not.toContain("read:leads");
  });
});

// ---------------------------------------------------------------------------
// 2. Per-route write gates: distinct scope, org-pin, strict body, no '*'
// ---------------------------------------------------------------------------

type WriteRoute = {
  file: string;
  verb: "POST" | "PATCH";
  scope: string;
  /** true ⇒ item route (org-pinned on the write predicate, no cross-org). */
  item: boolean;
};

const WRITE_ROUTES: WriteRoute[] = [
  { file: "app/api/v1/customers/route.ts", verb: "POST", scope: "write:customers", item: false },
  { file: "app/api/v1/customers/[id]/route.ts", verb: "PATCH", scope: "write:customers", item: true },
  { file: "app/api/v1/leads/route.ts", verb: "POST", scope: "write:leads", item: false },
  { file: "app/api/v1/jobs/route.ts", verb: "POST", scope: "write:jobs", item: false },
  { file: "app/api/v1/jobs/[id]/route.ts", verb: "PATCH", scope: "write:jobs", item: true },
  { file: "app/api/v1/quotes/route.ts", verb: "POST", scope: "write:quotes", item: true },
];

describe.each(WRITE_ROUTES)("$verb $file — scoped, org-pinned, strict", (r) => {
  const CODE = codeOf(read(r.file));

  it(`exports the ${r.verb} handler`, () => {
    expect(CODE).toMatch(new RegExp(`export async function ${r.verb}\\b`));
  });

  it(`gates on the DISTINCT ${r.scope} scope through the shared guard`, () => {
    expect(CODE).toMatch(
      new RegExp(`guardPublicApiRequest\\(request, "${r.scope}"\\)`),
    );
  });

  it("validates the body through the strict shared parser (no mass assignment)", () => {
    expect(CODE).toMatch(/parseJsonBody\(request,/);
  });

  it("never selects '*'", () => {
    expect(CODE).not.toMatch(/select\(\s*["'`]\s*\*\s*["'`]\s*\)/);
  });

  it("never reads org from the request (org is the key's, not the body)", () => {
    expect(CODE).not.toMatch(/searchParams\.get\("org/);
    // No schema field named org_id: the strict schema would reject it anyway,
    // but the route must also never map one in.
    expect(CODE).not.toMatch(/org_id:\s*(input|body)\./);
  });
});

describe("inserts pin org_id to the key's org", () => {
  for (const r of WRITE_ROUTES.filter((x) => x.verb === "POST")) {
    it(`${r.file} sets org_id: guard.key.orgId on the insert`, () => {
      expect(codeOf(read(r.file))).toMatch(/org_id: guard\.key\.orgId/);
    });
  }
});

describe("updates are org-pinned on the WRITE predicate (no cross-org write / oracle)", () => {
  for (const r of WRITE_ROUTES.filter((x) => x.verb === "PATCH")) {
    const CODE = codeOf(read(r.file));
    it(`${r.file} scopes the update by id AND key.orgId`, () => {
      expect(CODE).toMatch(/\.eq\("id", id\)/);
      expect(CODE).toMatch(/\.eq\("org_id", guard\.key\.orgId\)/);
    });
    it(`${r.file} 404s on zero rows (missing/other-org indistinguishable)`, () => {
      expect(CODE).toMatch(/if \(!data\) return notFound\(\)/);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Cross-org reference integrity on foreign keys
// ---------------------------------------------------------------------------

describe("foreign references are verified in the key's org BEFORE the write", () => {
  it("leads verifies a linked customer_id in-org", () => {
    const CODE = codeOf(read("app/api/v1/leads/route.ts"));
    expect(CODE).toMatch(/verifyCustomerInOrg\(/);
    expect(CODE).toMatch(/guard\.key\.orgId/);
  });

  it("jobs create + update verify a linked customer_id in-org", () => {
    expect(codeOf(read("app/api/v1/jobs/route.ts"))).toMatch(/verifyCustomerInOrg\(/);
    expect(codeOf(read("app/api/v1/jobs/[id]/route.ts"))).toMatch(/verifyCustomerInOrg\(/);
  });

  it("quotes verify customer/property/lead references in-org", () => {
    expect(codeOf(read("app/api/v1/quotes/route.ts"))).toMatch(/verifyQuoteReferences\(/);
  });
});

// ---------------------------------------------------------------------------
// 4. Quote money is server-side; no cost/secret can be set or returned
// ---------------------------------------------------------------------------

describe("quote create — money computed server-side, no cost/secret injection", () => {
  const CODE = codeOf(read("app/api/v1/quotes/route.ts"));
  const SCHEMA = codeOf(read("lib/public-api/write-schemas.ts"));

  it("computes totals from line items (never trusts client money)", () => {
    // The route normalises input.line_items → lineItems, then computes totals.
    expect(CODE).toMatch(/computeTotals\(lineItems\)/);
    expect(CODE).toMatch(/const lineItems = input\.line_items\.map\(/);
    expect(CODE).toMatch(/subtotal: totals\.subtotal/);
    expect(CODE).toMatch(/vat_total: totals\.vat_total/);
    expect(CODE).toMatch(/total: totals\.total/);
  });

  it("allocates the quote number via the SECURITY DEFINER RPC, not the client", () => {
    expect(CODE).toMatch(/next_quote_number/);
    expect(CODE).toMatch(/target_org: guard\.key\.orgId/);
  });

  it("the create schema never accepts a cost/total/secret field", () => {
    // The strict schema is the gate; assert the dangerous names are simply
    // absent from the quote input object.
    const quoteBlock =
      /createQuoteSchema[\s\S]*?\.strict\(\)/.exec(SCHEMA)?.[0] ?? "";
    expect(quoteBlock).not.toBe("");
    for (const forbidden of [
      "cost_labour",
      "cost_materials",
      "cost_total",
      "subtotal",
      "vat_total",
      "public_token",
      "status",
    ]) {
      expect(quoteBlock, `quote input accepts ${forbidden}`).not.toMatch(
        new RegExp(`\\b${forbidden}\\b\\s*:`),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Every write schema is strict (the anti-mass-assignment guarantee)
// ---------------------------------------------------------------------------

describe("all write input schemas are .strict()", () => {
  const SCHEMA = read("lib/public-api/write-schemas.ts");
  it("declares .strict() on every exported schema", () => {
    for (const name of [
      "createCustomerSchema",
      "updateCustomerSchema",
      "createLeadSchema",
      "createJobSchema",
      "updateJobSchema",
      "createQuoteSchema",
    ]) {
      const block =
        new RegExp(`${name} = [\\s\\S]*?\\n(export|$)`).exec(SCHEMA)?.[0] ?? "";
      expect(block, `${name} not found`).not.toBe("");
      expect(block, `${name} is not .strict()`).toMatch(/\.strict\(\)/);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Leads is write-only; invoices stays read-only
// ---------------------------------------------------------------------------

describe("surface shape — leads write-only, invoices read-only", () => {
  it("leads route exports POST only (no GET/PATCH/PUT/DELETE)", () => {
    const CODE = codeOf(read("app/api/v1/leads/route.ts"));
    expect(CODE).toMatch(/export async function POST\b/);
    for (const verb of ["GET", "PATCH", "PUT", "DELETE"]) {
      expect(CODE).not.toMatch(new RegExp(`export (async )?function ${verb}\\b`));
    }
  });

  it("invoices route exports NO write verb (read-only)", () => {
    const CODE = codeOf(read("app/api/v1/invoices/route.ts"));
    for (const verb of ["POST", "PATCH", "PUT", "DELETE"]) {
      expect(CODE).not.toMatch(new RegExp(`export (async )?function ${verb}\\b`));
    }
    expect(CODE).not.toMatch(/write:/);
  });
});

// ---------------------------------------------------------------------------
// 7. OpenAPI + docs portal reflect the writes and stay dark + leak-free
// ---------------------------------------------------------------------------

describe("openapi document — write operations present, no leaked field", () => {
  it("documents the write operations with their write scopes", async () => {
    const { buildOpenApiDocument } = await import("@/lib/public-api/openapi");
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<string, Record<string, { security?: Array<Record<string, string[]>> }>>;
    };
    const scopeFor = (path: string, verb: string) =>
      Object.values(doc.paths[path]![verb]!.security![0]!)[0]![0];
    expect(scopeFor("/customers", "post")).toBe("write:customers");
    expect(scopeFor("/customers/{id}", "patch")).toBe("write:customers");
    expect(scopeFor("/leads", "post")).toBe("write:leads");
    expect(scopeFor("/jobs", "post")).toBe("write:jobs");
    expect(scopeFor("/jobs/{id}", "patch")).toBe("write:jobs");
    expect(scopeFor("/quotes", "post")).toBe("write:quotes");
  });

  it("still never names a forbidden cost/secret field anywhere", async () => {
    const { buildOpenApiDocument } = await import("@/lib/public-api/openapi");
    const json = JSON.stringify(buildOpenApiDocument());
    for (const forbidden of [
      "cost_labour",
      "cost_total",
      "public_token",
      "accept_signature",
      "key_hash",
    ]) {
      expect(json, `spec mentions ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("docs portal — dark by the same flag", () => {
  it("/developers 404s (notFound) when the shared flag is off", () => {
    const CODE = codeOf(read("app/(marketing)/developers/page.tsx"));
    expect(CODE).toMatch(/if \(!isPublicApiJobsEnabled\(\)\) notFound\(\)/);
    expect(CODE).toMatch(/buildOpenApiDocument\(\)/);
  });
});

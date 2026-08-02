import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Public API v1 — Open-API expansion (customers / invoices / quotes + the
 * OpenAPI spec) — trust-boundary pins.
 *
 * The jobs read (Train K) established the pattern; this expansion reuses the
 * SAME dark flag, the SAME api-key auth, and the SAME generic guard, adding
 * per-resource read scopes. These source-assertions freeze the properties that
 * keep the new surfaces safe: dark-by-flag (404 when off), the per-resource
 * scope gate through the generic guard, org-pinning to the KEY'S org (never
 * client input), the explicit DTO allowlists with no cost/PII/secret/internal
 * fields, the paginated envelope, and the flag-gated, tenant-data-free spec.
 * If any of these erode, a test here goes red rather than the leak shipping.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** Just the shape these assertions read out of the OpenAPI document. */
type OpenApiDocShape = {
  openapi: string;
  servers: Array<{ url: string }>;
  "x-api-versioning": { strategy: string };
  components: {
    securitySchemes: { apiKey: { scheme: string } };
    schemas: Record<string, { properties: Record<string, unknown> }>;
  };
};

const GUARD = codeOf(read("lib/public-api/guard.ts"));

type Resource = {
  name: string;
  route: string;
  dtoFile: string;
  scope: string;
  columnsConst: string;
  toDtoFn: string;
  selectConst: string;
  /** Exact allowlisted columns, in order. */
  columns: string[];
  /** Field names that must NEVER appear in the projection. */
  forbidden: string[];
};

const RESOURCES: Resource[] = [
  {
    name: "customers",
    route: "app/api/v1/customers/route.ts",
    dtoFile: "lib/public-api/customers.ts",
    scope: "read:customers",
    columnsConst: "CUSTOMER_DTO_COLUMNS",
    toDtoFn: "toPublicCustomerDto",
    selectConst: "CUSTOMER_DTO_SELECT",
    columns: ["id", "name", "city", "county", "postcode", "country", "created_at", "updated_at"],
    forbidden: [
      "email",
      "phone",
      "address_line1",
      "address_line2",
      "notes",
      "portal_token",
      "portal_token_expires_at",
      "portal_token_last_used_at",
      "org_id",
    ],
  },
  {
    name: "invoices",
    route: "app/api/v1/invoices/route.ts",
    dtoFile: "lib/public-api/invoices.ts",
    scope: "read:invoices",
    columnsConst: "INVOICE_DTO_COLUMNS",
    toDtoFn: "toPublicInvoiceDto",
    selectConst: "INVOICE_DTO_SELECT",
    columns: [
      "id",
      "number",
      "status",
      "amount",
      "vat_total",
      "total",
      "due_date",
      "sent_at",
      "paid_at",
      "created_at",
      "updated_at",
    ],
    forbidden: ["customer_id", "job_id", "quote_id", "notes", "org_id"],
  },
  {
    name: "quotes",
    route: "app/api/v1/quotes/route.ts",
    dtoFile: "lib/public-api/quotes.ts",
    scope: "read:quotes",
    columnsConst: "QUOTE_DTO_COLUMNS",
    toDtoFn: "toPublicQuoteDto",
    selectConst: "QUOTE_DTO_SELECT",
    columns: [
      "id",
      "number",
      "status",
      "currency",
      "subtotal",
      "vat_total",
      "total",
      "valid_until",
      "sent_at",
      "accepted_at",
      "declined_at",
      "created_at",
      "updated_at",
    ],
    forbidden: [
      // The critical ones — internal cost / margin must NEVER leak.
      "cost_labour",
      "cost_materials",
      "cost_misc",
      "cost_subcontractors",
      "cost_total",
      // Secrets / PII / internal workflow.
      "public_token",
      "accept_signature",
      "approved_by",
      "approval_comment",
      "customer_comment",
      "created_by",
      "notes",
      "terms",
      "customer_id",
      "job_id",
      "lead_id",
      "property_id",
      "org_id",
    ],
  },
];

// ---------------------------------------------------------------------------
// 1. The generic guard — one dark, ordered chokepoint for every resource
// ---------------------------------------------------------------------------

describe("guardPublicApiRequest — the shared, scope-parameterised gate", () => {
  it("checks the flag FIRST and 404s (dark), before auth", () => {
    const gen = /export async function guardPublicApiRequest[\s\S]*?\n}/.exec(GUARD)?.[0] ?? "";
    expect(gen).not.toBe("");
    const flagIdx = gen.indexOf("isPublicApiJobsEnabled()");
    const authIdx = gen.indexOf("resolveApiKey(");
    expect(flagIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeGreaterThan(flagIdx);
    expect(gen).toMatch(/if \(!isPublicApiJobsEnabled\(\)\) return \{ ok: false, response: notFound\(\) \}/);
  });

  it("shares the ONE flag with jobs — no second FEATURE_PUBLIC_API_* env is introduced", () => {
    const env = read("lib/env.ts");
    const flags = [...env.matchAll(/FEATURE_PUBLIC_API\w*/g)].map((m) => m[0]);
    expect([...new Set(flags)]).toEqual(["FEATURE_PUBLIC_API_JOBS"]);
  });

  it("gates on the caller-supplied scope, then rate-limits by KEY ID — auth < scope < limit", () => {
    const gen = /export async function guardPublicApiRequest[\s\S]*?\n}/.exec(GUARD)?.[0] ?? "";
    expect(gen).toMatch(/hasScope\(key\.scopes, requiredScope\)/);
    expect(gen).toMatch(
      /enforceIdentified\(\s*"api_v1",\s*key\.keyId,\s*DEFAULT_LIMITS\.api_v1,?\s*\)/,
    );
    const auth = gen.indexOf("resolveApiKey(");
    const scope = gen.indexOf("hasScope(");
    const limit = gen.indexOf("enforceIdentified(");
    expect(auth).toBeLessThan(scope);
    expect(scope).toBeLessThan(limit);
  });
});

// ---------------------------------------------------------------------------
// 2. Per-resource route + DTO pins
// ---------------------------------------------------------------------------

describe.each(RESOURCES)("public $name read — dark, org-pinned, read-only, allowlisted", (r) => {
  const ROUTE = codeOf(read(r.route));
  const DTO = codeOf(read(r.dtoFile));

  it("routes through the generic guard with EXACTLY its own scope", () => {
    expect(ROUTE).toMatch(
      new RegExp(`guardPublicApiRequest\\(request, "${r.scope}"\\)`),
    );
  });

  it("is a GET-only surface — no write verb is exported", () => {
    for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(ROUTE, `${r.name} exports ${verb}`).not.toMatch(
        new RegExp(`export (async )?function ${verb}\\b`),
      );
    }
  });

  it("pins the read to key.orgId and never selects '*' nor reads org from the query", () => {
    expect(ROUTE).toMatch(/\.eq\("org_id", guard\.key\.orgId\)/);
    expect(ROUTE).toMatch(new RegExp(`\\.select\\(${r.selectConst}\\)`));
    expect(ROUTE).not.toMatch(/select\(\s*["'`]\s*\*\s*["'`]\s*\)/);
    expect(ROUTE).not.toMatch(/searchParams\.get\("org/);
  });

  it("uses a stable, deterministic order (created_at then id)", () => {
    expect(ROUTE).toMatch(/\.order\("created_at", \{ ascending: false \}\)/);
    expect(ROUTE).toMatch(/\.order\("id", \{ ascending: false \}\)/);
  });

  it("reads are LOUD — a failed query throws readFailure, never an empty page", () => {
    expect(ROUTE).toMatch(/if \(error\) throw readFailure\(/);
  });

  it("returns the { data, pagination:{page,per_page,has_more} } envelope", () => {
    expect(ROUTE).toMatch(/data: page/);
    expect(ROUTE).toMatch(/pagination: \{[\s\S]*?page:[\s\S]*?per_page:[\s\S]*?has_more[\s\S]*?\}/);
  });

  it("pins the exact allowlisted column set", () => {
    const arr = new RegExp(`${r.columnsConst} = \\[([\\s\\S]*?)\\] as const`).exec(DTO);
    expect(arr, `${r.columnsConst} not found`).not.toBeNull();
    const cols = [...arr![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(cols).toEqual(r.columns);
  });

  it("the projection is field-by-field — no spread of a raw row", () => {
    expect(DTO).toMatch(new RegExp(`function ${r.toDtoFn}`));
    expect(DTO).not.toMatch(/\.\.\.row/);
    expect(DTO).not.toMatch(/\.\.\.data/);
  });

  it("no forbidden field is emitted by the projection (cost/PII/secret/internal)", () => {
    const projection =
      new RegExp(`function ${r.toDtoFn}[\\s\\S]*?\\n\\}`).exec(DTO)?.[0] ?? DTO;
    for (const forbidden of r.forbidden) {
      expect(projection, `${r.name} projection emits ${forbidden}`).not.toMatch(
        new RegExp(`\\b${forbidden}\\b\\s*:`),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The OpenAPI spec — flag-gated, no tenant data, schema tied to the DTOs
// ---------------------------------------------------------------------------

describe("GET /api/v1/openapi.json — dark, tenant-data-free, in-sync", () => {
  const ROUTE = codeOf(read("app/api/v1/openapi.json/route.ts"));

  it("is flag-gated — 404 when the shared flag is off", () => {
    expect(ROUTE).toMatch(/if \(!isPublicApiJobsEnabled\(\)\) return notFound\(\)/);
    expect(ROUTE).toMatch(/status: 404/);
  });

  it("serves only the static document — it never reads tenant tables", () => {
    expect(ROUTE).toMatch(/buildOpenApiDocument\(\)/);
    expect(ROUTE).not.toMatch(/createAdminClient/);
    expect(ROUTE).not.toMatch(/\.from\(/);
  });

  it("is a GET-only surface", () => {
    for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(ROUTE).not.toMatch(new RegExp(`export (async )?function ${verb}\\b`));
    }
  });

  it("is OpenAPI 3.1, path-versioned, with a bearer api-key security scheme", async () => {
    const { buildOpenApiDocument } = await import("@/lib/public-api/openapi");
    const doc = buildOpenApiDocument() as unknown as OpenApiDocShape;
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0]!.url).toMatch(/\/api\/v1$/);
    expect(doc["x-api-versioning"].strategy).toBe("uri-path");
    expect(doc.components.securitySchemes.apiKey.scheme).toBe("bearer");
  });

  it("its resource schemas match the DTO column allowlists exactly (no drift)", async () => {
    const { buildOpenApiDocument } = await import("@/lib/public-api/openapi");
    const doc = buildOpenApiDocument() as unknown as OpenApiDocShape;
    const schemas = doc.components.schemas;
    const map: Record<string, string[]> = {
      Customer: RESOURCES[0]!.columns,
      Invoice: RESOURCES[1]!.columns,
      Quote: RESOURCES[2]!.columns,
    };
    for (const [name, cols] of Object.entries(map)) {
      expect(Object.keys(schemas[name]!.properties).sort()).toEqual([...cols].sort());
    }
  });

  it("the spec never names a forbidden cost/secret field anywhere", async () => {
    const { buildOpenApiDocument } = await import("@/lib/public-api/openapi");
    const json = JSON.stringify(buildOpenApiDocument());
    for (const forbidden of ["cost_labour", "cost_total", "public_token", "accept_signature", "key_hash"]) {
      expect(json, `spec mentions ${forbidden}`).not.toContain(forbidden);
    }
  });
});

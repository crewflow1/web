import { JOB_DTO_COLUMNS } from "@/lib/public-api/jobs";
import { CUSTOMER_DTO_COLUMNS } from "@/lib/public-api/customers";
import { INVOICE_DTO_COLUMNS } from "@/lib/public-api/invoices";
import { QUOTE_DTO_COLUMNS } from "@/lib/public-api/quotes";

/**
 * The static OpenAPI 3.1 document for CrewFlow's public read API (v1).
 *
 * Served (flag-gated, dark by default) from GET /api/v1/openapi.json. This is
 * DESCRIPTIVE metadata only — it leaks no tenant data — but it lives behind the
 * same FEATURE_PUBLIC_API_JOBS flag as the data routes so the ENTIRE v1 surface
 * is dark until the CEO flips one switch: no point publishing a spec for
 * endpoints that 404.
 *
 * VERSIONING: the version lives in the URL path (`/api/v1`). A breaking change
 * (removing/renaming a field, changing a type, tightening a default) ships as a
 * NEW path prefix (`/api/v2`); v1 continues to answer. Additive changes (a new
 * optional field, a new endpoint) are made in place. This is stated in the
 * document's `info.description` and mirrored in `x-api-versioning` so a client
 * can read the policy programmatically.
 *
 * DRIFT: the resource schemas are built from the SAME *_DTO_COLUMNS arrays the
 * routes select, so the published property list can never silently diverge from
 * what a route actually returns; the security test pins the tie.
 */

type SchemaType = "string" | "integer" | "number" | "boolean";

/**
 * Per-DTO field types. Keys MUST equal the DTO's column array (asserted by the
 * security test), so a column added to a DTO without a type here is caught.
 */
const JOB_FIELD_TYPES: Record<string, SchemaType> = {
  id: "string",
  status: "string",
  scheduled_date: "string",
  site_postcode: "string",
  created_at: "string",
  updated_at: "string",
};

const CUSTOMER_FIELD_TYPES: Record<string, SchemaType> = {
  id: "string",
  name: "string",
  city: "string",
  county: "string",
  postcode: "string",
  country: "string",
  created_at: "string",
  updated_at: "string",
};

const INVOICE_FIELD_TYPES: Record<string, SchemaType> = {
  id: "string",
  number: "string",
  status: "string",
  amount: "number",
  vat_total: "number",
  total: "number",
  due_date: "string",
  sent_at: "string",
  paid_at: "string",
  created_at: "string",
  updated_at: "string",
};

const QUOTE_FIELD_TYPES: Record<string, SchemaType> = {
  id: "string",
  number: "string",
  status: "string",
  currency: "string",
  subtotal: "number",
  vat_total: "number",
  total: "number",
  valid_until: "string",
  sent_at: "string",
  accepted_at: "string",
  declined_at: "string",
  created_at: "string",
  updated_at: "string",
};

/** Build an object schema from an ordered column list + its type map. */
function objectSchema(
  columns: readonly string[],
  types: Record<string, SchemaType>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const col of columns) {
    // Date-ish columns are nullable strings; everything is nullable except id.
    properties[col] = { type: [types[col] ?? "string", "null"] };
  }
  return { type: "object", properties };
}

/** The paginated list envelope, referencing a data item schema by $ref. */
function listEnvelope(itemRef: string): Record<string, unknown> {
  return {
    type: "object",
    required: ["data", "pagination"],
    properties: {
      data: { type: "array", items: { $ref: itemRef } },
      pagination: {
        type: "object",
        required: ["page", "per_page", "has_more"],
        properties: {
          page: { type: "integer" },
          per_page: { type: "integer" },
          has_more: { type: "boolean" },
        },
      },
    },
  };
}

/** A GET list operation description, gated by one scope. */
function listOperation(
  tag: string,
  summary: string,
  scope: string,
  itemRef: string,
): Record<string, unknown> {
  return {
    tags: [tag],
    summary,
    security: [{ apiKey: [scope] }],
    parameters: [
      {
        name: "page",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, default: 1 },
        description: "1-based page number.",
      },
      {
        name: "per_page",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        description: "Page size (clamped to 100).",
      },
    ],
    responses: {
      "200": {
        description: "A page of results.",
        content: { "application/json": { schema: { $ref: `#/components/schemas/${itemRef}List` } } },
      },
      "401": { description: "Missing, malformed, unknown, revoked or expired API key." },
      "403": { description: "The key lacks the required scope." },
      "429": { description: "Rate limit exceeded (120 requests/minute per key)." },
    },
  };
}

/** Build the full OpenAPI 3.1 document. Pure — no env, no I/O. */
export function buildOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "CrewFlow Public API",
      version: "1.0.0",
      description:
        "Read-only, key-authenticated access to your CrewFlow organisation's " +
        "data. Every request is scoped to the organisation that owns the API " +
        "key; there is no cross-organisation access and no write access. " +
        "VERSIONING: the version is in the URL path (/api/v1). Breaking changes " +
        "ship under a new prefix (/api/v2) while /api/v1 keeps working; " +
        "additive changes (new optional fields, new endpoints) are made in place.",
    },
    "x-api-versioning": {
      strategy: "uri-path",
      current: "v1",
      breaking_change_policy:
        "A new major version gets a new path prefix; older versions continue to answer.",
    },
    servers: [{ url: "https://app.crewflow.uk/api/v1", description: "Production" }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "crewflow_sk_...",
          description:
            "Send your API key as `Authorization: Bearer crewflow_sk_...`. Mint " +
            "and scope keys in Settings → API keys. Keys can be revoked at any " +
            "time and take effect on the next request.",
        },
      },
      schemas: {
        Job: objectSchema(JOB_DTO_COLUMNS, JOB_FIELD_TYPES),
        JobList: listEnvelope("#/components/schemas/Job"),
        Customer: objectSchema(CUSTOMER_DTO_COLUMNS, CUSTOMER_FIELD_TYPES),
        CustomerList: listEnvelope("#/components/schemas/Customer"),
        Invoice: objectSchema(INVOICE_DTO_COLUMNS, INVOICE_FIELD_TYPES),
        InvoiceList: listEnvelope("#/components/schemas/Invoice"),
        Quote: objectSchema(QUOTE_DTO_COLUMNS, QUOTE_FIELD_TYPES),
        QuoteList: listEnvelope("#/components/schemas/Quote"),
      },
    },
    paths: {
      "/me": {
        get: {
          tags: ["Identity"],
          summary: "The identity the API key carries.",
          security: [{ apiKey: [] }],
          responses: {
            "200": {
              description: "The key's org, prefix and scopes.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      org_id: { type: "string" },
                      key_prefix: { type: "string" },
                      scopes: { type: "array", items: { type: "string" } },
                    },
                  },
                },
              },
            },
            "401": { description: "Missing, malformed, unknown, revoked or expired API key." },
            "429": { description: "Rate limit exceeded (120 requests/minute per key)." },
          },
        },
      },
      "/jobs": { get: listOperation("Jobs", "List jobs.", "read:jobs", "Job") },
      "/jobs/{id}": {
        get: {
          tags: ["Jobs"],
          summary: "Fetch a single job by id.",
          security: [{ apiKey: ["read:jobs"] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "The job.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { data: { $ref: "#/components/schemas/Job" } },
                  },
                },
              },
            },
            "401": { description: "Missing, malformed, unknown, revoked or expired API key." },
            "403": { description: "The key lacks the read:jobs scope." },
            "404": { description: "No such job in this organisation." },
            "429": { description: "Rate limit exceeded (120 requests/minute per key)." },
          },
        },
      },
      "/customers": {
        get: listOperation("Customers", "List customers.", "read:customers", "Customer"),
      },
      "/invoices": {
        get: listOperation("Invoices", "List invoices.", "read:invoices", "Invoice"),
      },
      "/quotes": {
        get: listOperation("Quotes", "List quotes.", "read:quotes", "Quote"),
      },
    },
  };
}

import { JOB_DTO_COLUMNS } from "@/lib/public-api/jobs";
import { CUSTOMER_DTO_COLUMNS } from "@/lib/public-api/customers";
import { INVOICE_DTO_COLUMNS } from "@/lib/public-api/invoices";
import { QUOTE_DTO_COLUMNS } from "@/lib/public-api/quotes";
import { LEAD_DTO_COLUMNS } from "@/lib/public-api/leads";
import { TIME_DTO_COLUMNS } from "@/lib/public-api/time";
import { STAFF_DTO_COLUMNS } from "@/lib/public-api/staff";
import { EXPENSE_DTO_COLUMNS } from "@/lib/public-api/expenses";
import { MATERIAL_DTO_COLUMNS } from "@/lib/public-api/materials";
import { SCOPE_LABELS } from "@/lib/api-auth/scopes";

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

const LEAD_FIELD_TYPES: Record<string, SchemaType> = {
  id: "string",
  source: "string",
  service: "string",
  status: "string",
  urgency: "string",
  estimated_value: "number",
  postcode: "string",
  created_at: "string",
  updated_at: "string",
};

const TIME_FIELD_TYPES: Record<string, SchemaType> = {
  id: "string",
  started_at: "string",
  ended_at: "string",
  created_at: "string",
  updated_at: "string",
};

const STAFF_FIELD_TYPES: Record<string, SchemaType> = {
  id: "string",
  role: "string",
  created_at: "string",
};

const EXPENSE_FIELD_TYPES: Record<string, SchemaType> = {
  id: "string",
  amount: "number",
  currency: "string",
  vat_rate: "number",
  vat_total: "number",
  category: "string",
  created_at: "string",
  updated_at: "string",
};

const MATERIAL_FIELD_TYPES: Record<string, SchemaType> = {
  id: "string",
  number: "string",
  status: "string",
  priority: "string",
  needed_by: "string",
  submitted_at: "string",
  decided_at: "string",
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

/**
 * A create/update operation description, gated by a write scope with a JSON
 * request body ($ref to an input schema). The shared 4xx responses mirror the
 * write surface's coded envelopes.
 */
function writeOperation(opts: {
  tag: string;
  summary: string;
  scope: string;
  bodyRef: string;
  resultRef: string;
  /** 201 for a create, 200 for an update. */
  successStatus: "200" | "201";
  /** Path-param present ⇒ this is an item operation (adds a 404). */
  hasIdParam?: boolean;
}): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    [opts.successStatus]: {
      description:
        opts.successStatus === "201" ? "Created." : "Updated.",
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: { data: { $ref: opts.resultRef } },
          },
        },
      },
    },
    "400": { description: "Malformed JSON or non-object body." },
    "401": { description: "Missing, malformed, unknown, revoked or expired API key." },
    "403": { description: "The key lacks the required write scope." },
    "413": { description: "Request body exceeds the size limit." },
    "415": { description: "Content-Type must be application/json." },
    "422": { description: "Validation failed (per-field messages in field_errors) or a referenced id is not in your organisation." },
    "429": { description: "Rate limit exceeded (120 requests/minute per key)." },
  };
  if (opts.hasIdParam) {
    responses["404"] = { description: "No such record in this organisation." };
  }
  return {
    tags: [opts.tag],
    summary: opts.summary,
    security: [{ apiKey: [opts.scope] }],
    ...(opts.hasIdParam
      ? {
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
        }
      : {}),
    requestBody: {
      required: true,
      content: { "application/json": { schema: { $ref: opts.bodyRef } } },
    },
    responses,
  };
}

// --- write-input (request body) schemas: descriptive, hand-authored ----------

const CustomerWriteInput: Record<string, unknown> = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", maxLength: 200 },
    email: { type: "string", format: "email", maxLength: 254 },
    phone: { type: "string", maxLength: 50 },
    address_line1: { type: "string", maxLength: 200 },
    address_line2: { type: "string", maxLength: 200 },
    city: { type: "string", maxLength: 120 },
    county: { type: "string", maxLength: 120 },
    postcode: { type: "string", maxLength: 20 },
    country: { type: "string", maxLength: 100 },
    notes: { type: "string", maxLength: 5000 },
  },
};

const CustomerUpdateInput: Record<string, unknown> = {
  ...CustomerWriteInput,
  required: [],
  description: "At least one field must be provided. Omitted fields are left unchanged.",
};

const LeadWriteInput: Record<string, unknown> = {
  type: "object",
  required: ["contact_name", "source"],
  additionalProperties: false,
  description: "At least one of contact_email or contact_phone is required.",
  properties: {
    contact_name: { type: "string", maxLength: 200 },
    contact_email: { type: "string", format: "email", maxLength: 254 },
    contact_phone: { type: "string", maxLength: 50 },
    source: {
      type: "string",
      enum: ["phone", "web", "referral", "walk_in", "social", "repeat", "portal", "other"],
    },
    service: { type: "string", maxLength: 200 },
    urgency: { type: "string", enum: ["low", "normal", "high", "urgent"] },
    postcode: { type: "string", maxLength: 20 },
    estimated_value: { type: "number", minimum: 0 },
    notes: { type: "string", maxLength: 5000 },
    customer_id: { type: "string", format: "uuid" },
  },
};

const JobWriteInput: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["new", "in-progress", "completed", "blocked"] },
    scheduled_date: { type: "string", description: "YYYY-MM-DD" },
    customer_id: { type: "string", format: "uuid" },
    notes: { type: "string", maxLength: 5000 },
    site_address_line1: { type: "string", maxLength: 200 },
    site_address_line2: { type: "string", maxLength: 200 },
    site_city: { type: "string", maxLength: 120 },
    site_county: { type: "string", maxLength: 120 },
    site_postcode: { type: "string", maxLength: 20 },
    site_country: { type: "string", maxLength: 100 },
  },
};

const JobUpdateInput: Record<string, unknown> = {
  ...JobWriteInput,
  description: "At least one field must be provided. Omitted fields are left unchanged.",
};

const QuoteLineItemInput: Record<string, unknown> = {
  type: "object",
  required: ["description", "qty", "unit_price", "vat_rate"],
  additionalProperties: false,
  properties: {
    description: { type: "string", maxLength: 500 },
    qty: { type: "number", exclusiveMinimum: 0 },
    unit: { type: "string", maxLength: 20, default: "ea" },
    unit_price: { type: "number", minimum: 0 },
    vat_rate: { type: "number", enum: [0, 5, 20] },
  },
};

const QuoteWriteInput: Record<string, unknown> = {
  type: "object",
  required: ["customer_id", "line_items"],
  additionalProperties: false,
  description:
    "Totals (subtotal, vat_total, total) are computed server-side from the line items — never send them.",
  properties: {
    customer_id: { type: "string", format: "uuid" },
    property_id: { type: "string", format: "uuid" },
    lead_id: { type: "string", format: "uuid" },
    valid_until: { type: "string", description: "YYYY-MM-DD" },
    notes: { type: "string", maxLength: 5000 },
    terms: { type: "string", maxLength: 20000 },
    line_items: {
      type: "array",
      minItems: 1,
      items: { $ref: "#/components/schemas/QuoteLineItemInput" },
    },
  },
};

const ExpenseWriteInput: Record<string, unknown> = {
  type: "object",
  required: ["amount"],
  additionalProperties: false,
  description:
    "Record a cost. vat_total is computed server-side (amount * vat_rate) and " +
    "can never be sent. Currency is fixed to GBP.",
  properties: {
    amount: { type: "number", minimum: 0 },
    vat_rate: { type: "number", enum: [0, 5, 20], default: 20 },
    category: { type: "string", maxLength: 120 },
    notes: { type: "string", maxLength: 5000 },
    job_id: { type: "string", format: "uuid" },
  },
};

const ExpenseUpdateInput: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  description:
    "At least one field must be provided. Omitted fields are left unchanged. " +
    "job_id and vat_total are not updatable.",
  properties: {
    amount: { type: "number", minimum: 0 },
    vat_rate: { type: "number", enum: [0, 5, 20] },
    category: { type: "string", maxLength: 120 },
    notes: { type: "string", maxLength: 5000 },
  },
};

const InvoiceUpdateInput: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  description:
    "Update invoice status and metadata. Money columns (amount, vat_total, " +
    "total, number) are not writable. 'overdue' is derived, not stored, and is " +
    "rejected. At least one field must be provided.",
  properties: {
    status: {
      type: "string",
      enum: ["draft", "sent", "awaiting_payment", "partially_paid", "paid"],
    },
    due_date: { type: "string", description: "YYYY-MM-DD" },
    notes: { type: "string", maxLength: 5000 },
  },
};

/** Build the full OpenAPI 3.1 document. Pure — no env, no I/O. */
export function buildOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "CrewFlow Public API",
      version: "1.0.0",
      description:
        "Key-authenticated read and write access to your CrewFlow " +
        "organisation's data. Every request is scoped to the organisation that " +
        "owns the API key; there is NO cross-organisation access. Read and " +
        "write are DISTINCT scopes — a key must hold the matching write scope " +
        "(e.g. write:customers) to create or update, even if it can already " +
        "read. Writes validate their body strictly (unknown fields are " +
        "rejected), pin every new row to the key's organisation, compute money " +
        "server-side, and return the created/updated record. Updates via PATCH " +
        "are idempotent (re-sending the same body yields the same state); a " +
        "repeated create (POST) makes a new record. " +
        "VERSIONING: the version is in the URL path (/api/v1). Breaking changes " +
        "ship under a new prefix (/api/v2) while /api/v1 keeps working; " +
        "additive changes (new optional fields, new endpoints) are made in place.",
    },
    "x-scopes": SCOPE_LABELS,
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
        Lead: objectSchema(LEAD_DTO_COLUMNS, LEAD_FIELD_TYPES),
        TimeEntry: objectSchema(TIME_DTO_COLUMNS, TIME_FIELD_TYPES),
        TimeEntryList: listEnvelope("#/components/schemas/TimeEntry"),
        StaffMember: objectSchema(STAFF_DTO_COLUMNS, STAFF_FIELD_TYPES),
        StaffMemberList: listEnvelope("#/components/schemas/StaffMember"),
        Expense: objectSchema(EXPENSE_DTO_COLUMNS, EXPENSE_FIELD_TYPES),
        ExpenseList: listEnvelope("#/components/schemas/Expense"),
        MaterialRequest: objectSchema(MATERIAL_DTO_COLUMNS, MATERIAL_FIELD_TYPES),
        MaterialRequestList: listEnvelope("#/components/schemas/MaterialRequest"),
        // Write-input (request body) schemas.
        CustomerWriteInput,
        CustomerUpdateInput,
        LeadWriteInput,
        JobWriteInput,
        JobUpdateInput,
        QuoteLineItemInput,
        QuoteWriteInput,
        ExpenseWriteInput,
        ExpenseUpdateInput,
        InvoiceUpdateInput,
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
      "/jobs": {
        get: listOperation("Jobs", "List jobs.", "read:jobs", "Job"),
        post: writeOperation({
          tag: "Jobs",
          summary: "Create a job.",
          scope: "write:jobs",
          bodyRef: "#/components/schemas/JobWriteInput",
          resultRef: "#/components/schemas/Job",
          successStatus: "201",
        }),
      },
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
        patch: writeOperation({
          tag: "Jobs",
          summary: "Update a job.",
          scope: "write:jobs",
          bodyRef: "#/components/schemas/JobUpdateInput",
          resultRef: "#/components/schemas/Job",
          successStatus: "200",
          hasIdParam: true,
        }),
      },
      "/customers": {
        get: listOperation("Customers", "List customers.", "read:customers", "Customer"),
        post: writeOperation({
          tag: "Customers",
          summary: "Create a customer.",
          scope: "write:customers",
          bodyRef: "#/components/schemas/CustomerWriteInput",
          resultRef: "#/components/schemas/Customer",
          successStatus: "201",
        }),
      },
      "/customers/{id}": {
        get: {
          tags: ["Customers"],
          summary: "Fetch a single customer by id.",
          security: [{ apiKey: ["read:customers"] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "The customer.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { data: { $ref: "#/components/schemas/Customer" } },
                  },
                },
              },
            },
            "401": { description: "Missing, malformed, unknown, revoked or expired API key." },
            "403": { description: "The key lacks the read:customers scope." },
            "404": { description: "No such customer in this organisation." },
            "429": { description: "Rate limit exceeded (120 requests/minute per key)." },
          },
        },
        patch: writeOperation({
          tag: "Customers",
          summary: "Update a customer.",
          scope: "write:customers",
          bodyRef: "#/components/schemas/CustomerUpdateInput",
          resultRef: "#/components/schemas/Customer",
          successStatus: "200",
          hasIdParam: true,
        }),
      },
      "/leads": {
        post: writeOperation({
          tag: "Leads",
          summary: "Capture a lead.",
          scope: "write:leads",
          bodyRef: "#/components/schemas/LeadWriteInput",
          resultRef: "#/components/schemas/Lead",
          successStatus: "201",
        }),
      },
      "/invoices": {
        get: listOperation("Invoices", "List invoices.", "read:invoices", "Invoice"),
      },
      "/invoices/{id}": {
        get: {
          tags: ["Invoices"],
          summary: "Fetch a single invoice by id.",
          security: [{ apiKey: ["read:invoices"] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "The invoice.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { data: { $ref: "#/components/schemas/Invoice" } },
                  },
                },
              },
            },
            "401": { description: "Missing, malformed, unknown, revoked or expired API key." },
            "403": { description: "The key lacks the read:invoices scope." },
            "404": { description: "No such invoice in this organisation." },
            "429": { description: "Rate limit exceeded (120 requests/minute per key)." },
          },
        },
        patch: writeOperation({
          tag: "Invoices",
          summary: "Update an invoice's status and metadata (never its money).",
          scope: "write:invoices",
          bodyRef: "#/components/schemas/InvoiceUpdateInput",
          resultRef: "#/components/schemas/Invoice",
          successStatus: "200",
          hasIdParam: true,
        }),
      },
      "/quotes": {
        get: listOperation("Quotes", "List quotes.", "read:quotes", "Quote"),
        post: writeOperation({
          tag: "Quotes",
          summary: "Create a draft quote.",
          scope: "write:quotes",
          bodyRef: "#/components/schemas/QuoteWriteInput",
          resultRef: "#/components/schemas/Quote",
          successStatus: "201",
        }),
      },
      "/time": {
        get: listOperation("Time", "List time entries.", "read:time", "TimeEntry"),
      },
      "/staff": {
        get: listOperation(
          "Staff",
          "List staff (role and join date only — no identity).",
          "read:staff",
          "StaffMember",
        ),
      },
      "/expenses": {
        get: listOperation("Expenses", "List expenses.", "read:expenses", "Expense"),
        post: writeOperation({
          tag: "Expenses",
          summary: "Record an expense.",
          scope: "write:expenses",
          bodyRef: "#/components/schemas/ExpenseWriteInput",
          resultRef: "#/components/schemas/Expense",
          successStatus: "201",
        }),
      },
      "/expenses/{id}": {
        get: {
          tags: ["Expenses"],
          summary: "Fetch a single expense by id.",
          security: [{ apiKey: ["read:expenses"] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "The expense.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { data: { $ref: "#/components/schemas/Expense" } },
                  },
                },
              },
            },
            "401": { description: "Missing, malformed, unknown, revoked or expired API key." },
            "403": { description: "The key lacks the read:expenses scope." },
            "404": { description: "No such expense in this organisation." },
            "429": { description: "Rate limit exceeded (120 requests/minute per key)." },
          },
        },
        patch: writeOperation({
          tag: "Expenses",
          summary: "Update an expense.",
          scope: "write:expenses",
          bodyRef: "#/components/schemas/ExpenseUpdateInput",
          resultRef: "#/components/schemas/Expense",
          successStatus: "200",
          hasIdParam: true,
        }),
      },
      "/materials": {
        get: listOperation(
          "Materials",
          "List material requests.",
          "read:materials",
          "MaterialRequest",
        ),
      },
    },
  };
}

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  parseJsonBody,
  pickDefined,
  validationError,
  created,
  okData,
  writeError,
  MAX_WRITE_BODY_BYTES,
} from "@/lib/public-api/write";
import {
  createCustomerSchema,
  updateCustomerSchema,
  createLeadSchema,
  createJobSchema,
  updateJobSchema,
  createQuoteSchema,
  createExpenseSchema,
  updateExpenseSchema,
  updateInvoiceSchema,
} from "@/lib/public-api/write-schemas";
import { toPublicLeadDto, LEAD_DTO_COLUMNS } from "@/lib/public-api/leads";

/**
 * Public API v1 WRITE surface — body parsing, strict validation, and the
 * anti-mass-assignment guarantee (unit tier, no DB).
 *
 * These exercise the REAL parser and the REAL Zod schemas the routes use, so a
 * regression that would let an unknown key (org_id, cost_total, …) through, or
 * that would drop the size/content-type guards, turns a test red.
 */

function jsonRequest(body: unknown, contentType = "application/json"): Request {
  return new Request("https://app.crewflow.uk/api/v1/customers", {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("parseJsonBody — content-type, size, JSON, and strict schema gates", () => {
  const schema = z.object({ name: z.string() }).strict();

  it("415s when the content-type is not application/json", async () => {
    const req = new Request("https://x/api", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ name: "a" }),
    });
    const r = await parseJsonBody(req, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(415);
  });

  it("accepts application/json with a charset suffix", async () => {
    const r = await parseJsonBody(
      jsonRequest({ name: "a" }, "application/json; charset=utf-8"),
      schema,
    );
    expect(r.ok).toBe(true);
  });

  it("413s a body over the byte cap", async () => {
    const huge = "x".repeat(MAX_WRITE_BODY_BYTES + 1);
    const r = await parseJsonBody(
      jsonRequest({ name: huge }),
      schema,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(413);
  });

  it("400s malformed JSON", async () => {
    const r = await parseJsonBody(jsonRequest("{ not json"), schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(400);
  });

  it("400s a non-object body (array or scalar)", async () => {
    for (const body of ["[1,2,3]", "42", '"hello"']) {
      const r = await parseJsonBody(jsonRequest(body), schema);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.response.status).toBe(400);
    }
  });

  it("422s and rejects an UNKNOWN key (mass-assignment defence)", async () => {
    const r = await parseJsonBody(
      jsonRequest({ name: "a", org_id: "attacker-org" }),
      schema,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(422);
      const json = (await r.response.json()) as { error: string };
      expect(json.error).toBe("validation_failed");
    }
  });

  it("passes a valid body through, typed", async () => {
    const r = await parseJsonBody(jsonRequest({ name: "Acme" }), schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe("Acme");
  });
});

describe("strict schemas reject injected privileged fields (mass assignment)", () => {
  const forbiddenByResource: Array<[z.ZodType<unknown>, Record<string, unknown>, string]> = [
    [createCustomerSchema, { name: "A" }, "org_id"],
    [createCustomerSchema, { name: "A" }, "id"],
    [createLeadSchema, { contact_name: "A", contact_email: "a@b.co", source: "web" }, "status"],
    [createLeadSchema, { contact_name: "A", contact_email: "a@b.co", source: "web" }, "org_id"],
    [createJobSchema, {}, "org_id"],
    [createJobSchema, {}, "assigned_to"],
    [createQuoteSchema, { customer_id: crypto.randomUUID(), line_items: [{ description: "x", qty: 1, unit_price: 1, vat_rate: 20 }] }, "cost_total"],
    [createQuoteSchema, { customer_id: crypto.randomUUID(), line_items: [{ description: "x", qty: 1, unit_price: 1, vat_rate: 20 }] }, "public_token"],
    [createQuoteSchema, { customer_id: crypto.randomUUID(), line_items: [{ description: "x", qty: 1, unit_price: 1, vat_rate: 20 }] }, "subtotal"],
    // Open-API breadth wave — expenses + invoices.
    [createExpenseSchema, { amount: 10 }, "org_id"],
    [createExpenseSchema, { amount: 10 }, "vat_total"],
    [createExpenseSchema, { amount: 10 }, "id"],
    [updateExpenseSchema, { category: "fuel" }, "job_id"],
    [updateInvoiceSchema, { status: "sent" }, "amount"],
    [updateInvoiceSchema, { status: "sent" }, "total"],
    [updateInvoiceSchema, { status: "sent" }, "org_id"],
  ];

  it.each(forbiddenByResource)(
    "refuses an unknown/privileged key",
    (schema, base, injected) => {
      const clean = schema.safeParse(base);
      expect(clean.success, `base payload should be valid`).toBe(true);
      const dirty = schema.safeParse({ ...base, [injected]: "x" });
      expect(dirty.success, `injected ${injected} must be rejected`).toBe(false);
    },
  );
});

describe("customer schemas — required + update semantics", () => {
  it("create requires a name", () => {
    expect(createCustomerSchema.safeParse({}).success).toBe(false);
    expect(createCustomerSchema.safeParse({ name: "Acme" }).success).toBe(true);
  });

  it("create rejects a malformed email", () => {
    expect(
      createCustomerSchema.safeParse({ name: "A", email: "not-an-email" }).success,
    ).toBe(false);
  });

  it("update requires at least one field", () => {
    expect(updateCustomerSchema.safeParse({}).success).toBe(false);
    expect(updateCustomerSchema.safeParse({ city: "London" }).success).toBe(true);
  });
});

describe("lead schema — a reachable contact is mandatory", () => {
  it("rejects a lead with neither email nor phone", () => {
    const r = createLeadSchema.safeParse({ contact_name: "A", source: "web" });
    expect(r.success).toBe(false);
  });

  it("accepts email-only or phone-only", () => {
    expect(
      createLeadSchema.safeParse({ contact_name: "A", source: "web", contact_email: "a@b.co" }).success,
    ).toBe(true);
    expect(
      createLeadSchema.safeParse({ contact_name: "A", source: "web", contact_phone: "0700" }).success,
    ).toBe(true);
  });

  it("rejects an unknown source", () => {
    expect(
      createLeadSchema.safeParse({ contact_name: "A", contact_phone: "1", source: "carrier-pigeon" }).success,
    ).toBe(false);
  });
});

describe("job + quote schemas — enums and line items", () => {
  it("job create rejects an unknown status", () => {
    expect(createJobSchema.safeParse({ status: "on-fire" }).success).toBe(false);
    expect(createJobSchema.safeParse({ status: "in-progress" }).success).toBe(true);
  });

  it("job update requires at least one field", () => {
    expect(updateJobSchema.safeParse({}).success).toBe(false);
    expect(updateJobSchema.safeParse({ status: "completed" }).success).toBe(true);
  });

  it("quote create requires a customer and at least one line item", () => {
    expect(createQuoteSchema.safeParse({ customer_id: crypto.randomUUID(), line_items: [] }).success).toBe(false);
    expect(createQuoteSchema.safeParse({ line_items: [{ description: "x", qty: 1, unit_price: 1, vat_rate: 20 }] }).success).toBe(false);
    expect(
      createQuoteSchema.safeParse({
        customer_id: crypto.randomUUID(),
        line_items: [{ description: "Labour", qty: 2, unit_price: 100, vat_rate: 20 }],
      }).success,
    ).toBe(true);
  });

  it("quote line item rejects an off-list VAT rate", () => {
    expect(
      createQuoteSchema.safeParse({
        customer_id: crypto.randomUUID(),
        line_items: [{ description: "x", qty: 1, unit_price: 1, vat_rate: 17.5 }],
      }).success,
    ).toBe(false);
  });
});

describe("expense schemas — money in, generated VAT out", () => {
  it("create requires a non-negative amount", () => {
    expect(createExpenseSchema.safeParse({}).success).toBe(false);
    expect(createExpenseSchema.safeParse({ amount: -1 }).success).toBe(false);
    expect(createExpenseSchema.safeParse({ amount: 250 }).success).toBe(true);
  });

  it("create rejects an off-list VAT rate but accepts 0/5/20", () => {
    expect(createExpenseSchema.safeParse({ amount: 1, vat_rate: 17.5 }).success).toBe(false);
    for (const vat_rate of [0, 5, 20]) {
      expect(createExpenseSchema.safeParse({ amount: 1, vat_rate }).success).toBe(true);
    }
  });

  it("update requires at least one field and never accepts job_id", () => {
    expect(updateExpenseSchema.safeParse({}).success).toBe(false);
    expect(updateExpenseSchema.safeParse({ category: "materials" }).success).toBe(true);
    expect(updateExpenseSchema.safeParse({ job_id: crypto.randomUUID() }).success).toBe(false);
  });
});

describe("invoice update schema — status/metadata only, no money, no derived status", () => {
  it("accepts a writable status but rejects the derived 'overdue'", () => {
    expect(updateInvoiceSchema.safeParse({ status: "paid" }).success).toBe(true);
    expect(updateInvoiceSchema.safeParse({ status: "overdue" }).success).toBe(false);
  });

  it("requires at least one field and rejects a money column", () => {
    expect(updateInvoiceSchema.safeParse({}).success).toBe(false);
    expect(updateInvoiceSchema.safeParse({ amount: 100 }).success).toBe(false);
    expect(updateInvoiceSchema.safeParse({ total: 100 }).success).toBe(false);
    expect(updateInvoiceSchema.safeParse({ due_date: "2026-09-01" }).success).toBe(true);
  });
});

describe("PATCH idempotency — same body, same computed update row", () => {
  // A PATCH is idempotent by construction: the route builds the DB update from
  // pickDefined(body, allowlist), so re-sending an identical body produces an
  // identical update — no accumulation, no drift. These assert that reduction is
  // stable and never carries a field outside the allowlist.
  const EXPENSE_UPDATE_COLUMNS = ["amount", "vat_rate", "category", "notes"] as const;
  const INVOICE_UPDATE_COLUMNS = ["status", "due_date", "notes"] as const;

  it("an expense PATCH reduces to the same allowlisted row twice", () => {
    const body = updateExpenseSchema.parse({ amount: 500, category: "fuel" });
    const first = pickDefined(body as Record<string, unknown>, EXPENSE_UPDATE_COLUMNS);
    const second = pickDefined(body as Record<string, unknown>, EXPENSE_UPDATE_COLUMNS);
    expect(first).toEqual(second);
    expect(first).toEqual({ amount: 500, category: "fuel" });
    expect(first).not.toHaveProperty("vat_total");
    expect(first).not.toHaveProperty("org_id");
  });

  it("an invoice PATCH reduces to the same allowlisted row twice (no money leaks in)", () => {
    const body = updateInvoiceSchema.parse({ status: "sent", due_date: "2026-09-01" });
    const first = pickDefined(body as Record<string, unknown>, INVOICE_UPDATE_COLUMNS);
    const second = pickDefined(body as Record<string, unknown>, INVOICE_UPDATE_COLUMNS);
    expect(first).toEqual(second);
    expect(first).toEqual({ status: "sent", due_date: "2026-09-01" });
    for (const money of ["amount", "vat_total", "total", "number"]) {
      expect(first).not.toHaveProperty(money);
    }
  });
});

describe("pickDefined — true PATCH semantics", () => {
  it("copies only defined keys from the allowlist", () => {
    const body = { name: "A", city: undefined, county: "Kent" } as Record<string, unknown>;
    const out = pickDefined(body, ["name", "city", "county", "postcode"] as const);
    expect(out).toEqual({ name: "A", county: "Kent" });
    expect(out).not.toHaveProperty("city");
    expect(out).not.toHaveProperty("postcode");
  });

  it("never carries a key outside the allowlist", () => {
    const body = { name: "A", org_id: "x" } as Record<string, unknown>;
    const out = pickDefined(body, ["name"] as const);
    expect(out).toEqual({ name: "A" });
    expect(out).not.toHaveProperty("org_id");
  });
});

describe("response helpers", () => {
  it("created is 201, okData is 200, writeError carries the code", async () => {
    expect(created({ id: "1" }).status).toBe(201);
    expect(okData({ id: "1" }).status).toBe(200);
    const err = writeError(422, "invalid_reference", "nope");
    expect(err.status).toBe(422);
    const body = (await err.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_reference");
    expect(body.message).toBe("nope");
  });

  it("validationError surfaces the first message per field", async () => {
    const e = z.object({ a: z.string() }).safeParse({ a: 1 });
    if (e.success) throw new Error("expected a parse failure");
    const res = validationError(e.error);
    expect(res.status).toBe(422);
    const json = (await res.json()) as {
      error: string;
      field_errors: Record<string, string>;
    };
    expect(json.error).toBe("validation_failed");
    expect(json.field_errors).toHaveProperty("a");
  });
});

describe("lead output DTO — allowlist, no contact PII", () => {
  it("projects only the safe fields from an over-wide row", () => {
    const dto = toPublicLeadDto({
      id: "lead-1",
      source: "web",
      service: "roofing",
      status: "new",
      urgency: "normal",
      estimated_value: 5000,
      postcode: "SW1A 1AA",
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
      // must never appear
      contact_name: "Jane",
      contact_email: "jane@example.com",
      contact_phone: "0700",
      notes: "internal",
      org_id: "org-x",
    } as never);
    expect(Object.keys(dto).sort()).toEqual([...LEAD_DTO_COLUMNS].sort());
    for (const forbidden of ["contact_name", "contact_email", "contact_phone", "notes", "org_id"]) {
      expect(dto).not.toHaveProperty(forbidden);
    }
  });
});

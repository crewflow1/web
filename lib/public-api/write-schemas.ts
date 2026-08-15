import { z } from "zod";
import { JOB_STATUSES } from "@/lib/jobs/schema";
import { LEAD_SOURCES, LEAD_URGENCIES } from "@/lib/leads/schema";
import { QUOTE_VAT_RATES } from "@/lib/quotes/schema";

/**
 * Public API v1 — the WRITE input contracts (create/update).
 *
 * Every schema is `.strict()`: an unknown key is a HARD REJECTION, not a
 * silent strip. This is the anti-mass-assignment guarantee — a client can set
 * ONLY the fields named here, so it can never smuggle `org_id`, `id`,
 * `cost_total`, `public_token`, `created_by`, `key_hash`, an arbitrary
 * `status`, or any other column into a row. org_id is pinned by the route to
 * the key's org and is deliberately ABSENT from every schema; a body that
 * includes it is refused (422), never honoured.
 *
 * Enums are imported from the app's existing schema modules (jobs / leads /
 * quotes) so the public API and the in-app forms accept the SAME value sets —
 * one source of truth, no drift. Free-text is length-bounded; money is
 * non-negative and capped; dates are ISO-shape-checked.
 *
 * These are input schemas ONLY. What a write RETURNS is projected through the
 * existing read DTOs (toPublicCustomerDto / toPublicJobDto / toPublicQuoteDto)
 * and the leads DTO, so a created row is exposed under the same allowlist as a
 * read — a write can never leak a field a read would not.
 */

// --- small reusable field builders (blank string ⇒ absent, then validated) ---
//
// These deliberately AVOID z.preprocess: under zod 3.25 a preprocess whose fn
// returns `unknown` infers its output as `{}`, which then poisons every
// downstream `field ?? null`. The union+transform form infers a clean
// `string | undefined` while still mapping a blank string to "absent".

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === "" ? undefined : v));

const optionalEmail = z
  .union([z.literal(""), z.string().trim().max(254).email("Enter a valid email")])
  .optional()
  .transform((v) => (v ? v : undefined));

const optionalUuid = z
  .union([z.literal(""), z.string().uuid("Must be a valid id")])
  .optional()
  .transform((v) => (v ? v : undefined));

const optionalDate = z
  .union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")])
  .optional()
  .transform((v) => (v ? v : undefined));

const optionalMoney = z
  .number()
  .nonnegative("Must be zero or more")
  .max(99_999_999)
  .optional();

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

/** POST /api/v1/customers — `name` required; everything else optional. */
export const createCustomerSchema = z
  .object({
    name: z.string().trim().min(1, "A customer needs a name").max(200),
    email: optionalEmail,
    phone: optionalText(50),
    address_line1: optionalText(200),
    address_line2: optionalText(200),
    city: optionalText(120),
    county: optionalText(120),
    postcode: optionalText(20),
    country: optionalText(100),
    notes: optionalText(5000),
  })
  .strict();

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

/** PATCH /api/v1/customers/{id} — every field optional, at least one present. */
export const updateCustomerSchema = z
  .object({
    name: z.string().trim().min(1, "Name cannot be blank").max(200).optional(),
    email: optionalEmail,
    phone: optionalText(50),
    address_line1: optionalText(200),
    address_line2: optionalText(200),
    city: optionalText(120),
    county: optionalText(120),
    postcode: optionalText(20),
    country: optionalText(100),
    notes: optionalText(5000),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Provide at least one field to update.",
  });

export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

// ---------------------------------------------------------------------------
// Leads (create only — the classic website lead-capture surface)
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/leads. Mirrors the in-app create-lead contract: a name plus at
 * least one way to reach the person (email OR phone), a known source, and
 * optional pipeline metadata. `status` is NOT accepted — a captured lead is
 * always "new"; a client cannot inject a downstream stage.
 */
export const createLeadSchema = z
  .object({
    contact_name: z.string().trim().min(1, "Enter the lead's name").max(200),
    contact_email: optionalEmail,
    contact_phone: optionalText(50),
    source: z.enum(LEAD_SOURCES),
    service: optionalText(200),
    urgency: z.enum(LEAD_URGENCIES).optional(),
    postcode: optionalText(20),
    estimated_value: optionalMoney,
    notes: optionalText(5000),
    customer_id: optionalUuid,
  })
  .strict()
  .refine((v) => Boolean(v.contact_email) || Boolean(v.contact_phone), {
    message: "Enter at least an email or a phone — we need a way to reach them.",
    path: ["contact_phone"],
  });

export type CreateLeadInput = z.infer<typeof createLeadSchema>;

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/jobs. All fields optional (a job can be a stub the integration
 * fills in later); `status` is constrained to the known set and defaults to
 * "new". `assigned_to` is deliberately NOT accepted — staff assignment via a
 * public key is out of scope.
 */
export const createJobSchema = z
  .object({
    status: z.enum(JOB_STATUSES).optional(),
    scheduled_date: optionalDate,
    customer_id: optionalUuid,
    notes: optionalText(5000),
    site_address_line1: optionalText(200),
    site_address_line2: optionalText(200),
    site_city: optionalText(120),
    site_county: optionalText(120),
    site_postcode: optionalText(20),
    site_country: optionalText(100),
  })
  .strict();

export type CreateJobInput = z.infer<typeof createJobSchema>;

/** PATCH /api/v1/jobs/{id} — every field optional, at least one present. */
export const updateJobSchema = z
  .object({
    status: z.enum(JOB_STATUSES).optional(),
    scheduled_date: optionalDate,
    customer_id: optionalUuid,
    notes: optionalText(5000),
    site_address_line1: optionalText(200),
    site_address_line2: optionalText(200),
    site_city: optionalText(120),
    site_county: optionalText(120),
    site_postcode: optionalText(20),
    site_country: optionalText(100),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Provide at least one field to update.",
  });

export type UpdateJobInput = z.infer<typeof updateJobSchema>;

// ---------------------------------------------------------------------------
// Quotes (create only)
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/quotes. A customer plus at least one line item; totals are
 * computed SERVER-SIDE from the line items (a client never sets subtotal / vat
 * / total, and CANNOT set any cost_* field — those are refused by `.strict()`).
 * The quote is created as a `draft` with a fresh public token; the per-org
 * quote number is allocated by the same SECURITY DEFINER RPC the app uses.
 */
/**
 * A strict quote line item. Deliberately NOT the app's `lineItemSchema` (whose
 * preprocess `unit` field infers as `unknown` once nested) — this clean form
 * infers a concrete shape and feeds computeTotals directly. Money and quantity
 * are real JSON numbers (no string coercion); the VAT rate must be on-list.
 */
const quoteLineItemSchema = z
  .object({
    description: z.string().trim().min(1, "Line item needs a description").max(500),
    qty: z.number().positive("Quantity must be positive").max(999999),
    // Optional at the schema; the route normalises a missing/blank unit to
    // "ea" before persistence.
    unit: z.string().trim().max(20).optional(),
    unit_price: z.number().nonnegative("Price must be zero or more").max(99_999_999),
    vat_rate: z
      .number()
      .refine(
        (v) => (QUOTE_VAT_RATES as readonly number[]).includes(v),
        "VAT rate must be 0, 5, or 20",
      ),
  })
  .strict();

export const createQuoteSchema = z
  .object({
    customer_id: z.string().uuid("Pick a customer"),
    property_id: optionalUuid,
    lead_id: optionalUuid,
    valid_until: optionalDate,
    notes: optionalText(5000),
    terms: optionalText(20000),
    line_items: z.array(quoteLineItemSchema).min(1, "Add at least one line item"),
  })
  .strict();

export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;

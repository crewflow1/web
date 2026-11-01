/**
 * FEATURE 2 — the STRICT per-form extraction schemas.
 *
 * The model proposes a JSON object; these zod schemas are what turn that
 * untrusted blob into something that can safely touch a form. Three properties
 * matter and all three are enforced here, not hoped for:
 *
 *   1. NEVER INVENT. Every field is independently cleaned and, on ANY doubt,
 *      resolves to `null` (`.catch(null)` per field). A value the model made up
 *      in the wrong shape — a postcode that isn't one, a date that isn't a date,
 *      a VAT number that fails the pattern — becomes `null`, i.e. "not found",
 *      rather than a plausible-looking lie prefilled into a form.
 *   2. NO MASS-ASSIGNMENT. zod strips unknown keys, so a model that returns an
 *      extra `role`, `org_id`, `is_admin`, or `hourly_pay` key (whether confused
 *      or steered by a malicious document) cannot smuggle it into the draft —
 *      only the keys declared here survive. This is the field-level half of the
 *      security contract: the schema is the allowlist.
 *   3. STRING-SHAPED. Every output is a string (or null) matching the create
 *      form's input value, so prefill is a direct assignment with no coercion.
 *
 * The schemas are a SUBSET of each create form's own schema (lib/<domain>/
 * schema.ts), deliberately excluding anything that is sensitive, relational, or
 * not reliably on a document — see the per-schema notes. The create form's own
 * validation still runs on save; this is the first, conservative pass.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Field cleaners. Each takes the model's raw value and yields a clean string or
// null. `.catch(null)` on every one guarantees a field NEVER throws — a bad
// value degrades to "not found", it never fails the whole extraction.
// ---------------------------------------------------------------------------

const asString = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
};

/** Trimmed text, capped at `max`; over-length is truncated (never rejected). */
const text = (max: number) =>
  z
    .unknown()
    .transform((v) => {
      const s = asString(v);
      return s === null ? null : s.slice(0, max);
    })
    .catch(null);

/** A lower-cased, shape-valid email, else null. */
const email = () =>
  z
    .unknown()
    .transform((v) => {
      const s = asString(v);
      if (s === null || s.length > 254) return null;
      const lower = s.toLowerCase();
      return z.string().email().safeParse(lower).success ? lower : null;
    })
    .catch(null);

/** A phone number: keep digits, +, spaces, (), -. Reject if no digits. */
const phone = (max = 50) =>
  z
    .unknown()
    .transform((v) => {
      const s = asString(v);
      if (s === null) return null;
      const cleaned = s.replace(/[^0-9+()\-\s]/g, "").trim();
      return /\d/.test(cleaned) ? cleaned.slice(0, max) : null;
    })
    .catch(null);

/** A UK postcode, upper-cased and single-spaced, else null. */
const postcode = () =>
  z
    .unknown()
    .transform((v) => {
      const s = asString(v);
      if (s === null) return null;
      const up = s.toUpperCase().replace(/\s+/g, " ").trim();
      // Deliberately permissive UK format; the form re-validates on save.
      return /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/.test(up) ? up : null;
    })
    .catch(null);

/** An ISO date `YYYY-MM-DD`, else null. Accepts a full ISO timestamp's date. */
const isoDate = () =>
  z
    .unknown()
    .transform((v) => {
      const s = asString(v);
      if (s === null) return null;
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
      if (!m) return null;
      const d = m[1];
      const parsed = new Date(`${d}T00:00:00Z`);
      return Number.isNaN(parsed.getTime()) ? null : d;
    })
    .catch(null);

/** One of a fixed set (case-insensitive match), echoed in canonical casing. */
const oneOf = (values: readonly string[]) =>
  z
    .unknown()
    .transform((v) => {
      const s = asString(v);
      if (s === null) return null;
      const hit = values.find((val) => val.toLowerCase() === s.toLowerCase());
      return hit ?? null;
    })
    .catch(null);

/** A UK VAT number: 9 or 12 digits, optional GB prefix. Mirrors the DB CHECK. */
const vatNumber = () =>
  z
    .unknown()
    .transform((v) => {
      const s = asString(v);
      if (s === null) return null;
      const up = s.toUpperCase().replace(/\s+/g, "");
      return /^(GB)?([0-9]{9}|[0-9]{12})$/.test(up) ? up : null;
    })
    .catch(null);

/** A Companies House number: 1-20 alphanumerics. */
const companyNumber = () =>
  z
    .unknown()
    .transform((v) => {
      const s = asString(v);
      if (s === null) return null;
      const bare = s.replace(/\s+/g, "");
      return /^[A-Za-z0-9]{1,20}$/.test(bare) ? bare : null;
    })
    .catch(null);

/** A non-negative whole number as a string (e.g. payment terms in days). */
const wholeNumber = (max: number) =>
  z
    .unknown()
    .transform((v) => {
      const s = asString(typeof v === "number" ? String(v) : v);
      if (s === null) return null;
      const n = Number.parseInt(s.replace(/[^0-9]/g, ""), 10);
      if (!Number.isFinite(n) || n < 0 || n > max) return null;
      return String(n);
    })
    .catch(null);

/** A non-negative decimal (money / weight) as a 2dp string. Strips currency. */
const decimal = (max: number) =>
  z
    .unknown()
    .transform((v) => {
      const s = asString(typeof v === "number" ? String(v) : v);
      if (s === null) return null;
      // Keep digits, one dot, strip £/$/commas/spaces.
      const cleaned = s.replace(/[^0-9.]/g, "");
      const n = Number.parseFloat(cleaned);
      if (!Number.isFinite(n) || n < 0 || n > max) return null;
      return String(Math.round(n * 100) / 100);
    })
    .catch(null);

/**
 * A LINE-ITEM array cleaner. Validates each row against `row`, DROPS any row the
 * model invented without a description (the identity of a line) or that fails to
 * parse, caps the count, and emits a clean string map per row. Never throws — a
 * non-array or a fully-malformed array yields `[]`, the honest "no lines found".
 * The builder re-validates on save; this is the conservative first pass.
 */
function lineItemArray(row: z.ZodTypeAny, max = 200) {
  return z
    .unknown()
    .transform((v): Record<string, string>[] => {
      if (!Array.isArray(v)) return [];
      const out: Record<string, string>[] = [];
      for (const raw of v.slice(0, max)) {
        const parsed = row.safeParse(raw);
        if (!parsed.success) continue;
        const data = parsed.data as Record<string, string | null>;
        if (!data.description) continue; // a line with no description is not a line
        const clean: Record<string, string> = {};
        for (const [k, val] of Object.entries(data)) if (val !== null) clean[k] = val;
        out.push(clean);
      }
      return out;
    })
    .catch([]);
}

/** Materials — the request's repeatable rows (no money: a request, not a PO). */
export const materialRequestLineSchema = lineItemArray(
  z.object({
    description: text(500),
    qty: decimal(999_999),
    unit: text(40),
  }),
);

/** Materials — a material request header, from a take-off / materials list. */
export const materialRequestExtractionSchema = z.object({
  needed_by: isoDate(),
  notes: text(2000),
});

// ---------------------------------------------------------------------------
// The five extraction schemas. Keys MUST match the create form input `name`s —
// that equality is the prefill contract, pinned by the registry test.
// ---------------------------------------------------------------------------

/** Sales — a customer, from a letterhead / business card / company printout. */
export const customerExtractionSchema = z.object({
  name: text(200),
  email: email(),
  phone: phone(50),
  customer_type: oneOf(["individual", "business"]),
  company_number: companyNumber(),
  vat_number: vatNumber(),
  address_line1: text(200),
  address_line2: text(200),
  city: text(100),
  county: text(100),
  postcode: postcode(),
  country: text(100),
});

/** Money — a supplier, from an invoice header / letterhead / statement. */
export const supplierExtractionSchema = z.object({
  name: text(200),
  email: email(),
  phone: phone(50),
  category: text(80),
  payment_terms_days: wholeNumber(365),
  notes: text(2000),
});

/**
 * Projects — a job's SITE ADDRESS + notes, from a work order / instruction.
 * Relational fields (customer_id, assigned_to, template_id) and operational
 * dates are deliberately EXCLUDED: a document cannot name a CrewFlow UUID, and
 * guessing an assignee or schedule from prose is exactly the kind of invented
 * value this feature must not produce.
 */
export const jobExtractionSchema = z.object({
  notes: text(5000),
  site_address_line1: text(200),
  site_address_line2: text(200),
  site_city: text(100),
  site_county: text(100),
  site_postcode: postcode(),
  site_country: text(100),
});

/**
 * Site & Safety — a RAMS header, from an existing method statement / RAMS PDF.
 * Hazards, scores and sign-off are NOT auto-extracted: they are safety-critical
 * and are entered deliberately after the draft is created (the create form only
 * captures the header anyway).
 */
export const riskAssessmentExtractionSchema = z.object({
  title: text(200),
  activity: text(500),
  location: text(200),
  assessmentDate: isoDate(),
  reviewDate: isoDate(),
  methodStatement: text(20000),
});

/**
 * People — a staff member to INVITE, from a CV / worker details sheet.
 *
 * SECURITY-CRITICAL OMISSION. The invite form (lib/staff/schema.ts) also carries
 * `hourly_pay`, `emergency_contact_name/phone/relationship`, and `role`. Those
 * are NOT in this schema and never will be: pay and emergency contacts are
 * column-ACL-restricted staff data (staff_compensation RLS, migration
 * 20261218000000), and `role` is a privilege. Autofill extracts only the
 * identity fields a person's own CV plainly states; it can never propose a
 * salary, an emergency contact, or an admin role from an uploaded document.
 * __tests__/security/document-autofill-field-scoping.test.ts pins this.
 */
export const staffInviteExtractionSchema = z.object({
  full_name: text(200),
  email: email(),
  phone: phone(40),
  employment_type: oneOf(["employee", "self_employed", "contractor", "apprentice"]),
});

export type CustomerExtraction = z.infer<typeof customerExtractionSchema>;
export type SupplierExtraction = z.infer<typeof supplierExtractionSchema>;
export type JobExtraction = z.infer<typeof jobExtractionSchema>;
export type RiskAssessmentExtraction = z.infer<typeof riskAssessmentExtractionSchema>;
export type StaffInviteExtraction = z.infer<typeof staffInviteExtractionSchema>;

// ---------------------------------------------------------------------------
// Coverage wave — the remaining document-populatable create forms. Each is a
// subset of its create form's own schema (field names verified against the
// live form), excluding relational UUIDs, file uploads, controlled builders,
// and enum selects whose value set isn't safely inferable from a document.
// ---------------------------------------------------------------------------

/** Sales — a lead, from an enquiry email / letter / web form. */
export const leadExtractionSchema = z.object({
  contact_name: text(200),
  contact_email: email(),
  contact_phone: phone(40),
  service: text(200),
  postcode: postcode(),
  estimated_value: decimal(99_999_999),
  notes: text(5000),
});

/** Projects — a site/depot address, from a site brief / letterhead. */
export const siteExtractionSchema = z.object({
  name: text(200),
  address_line1: text(200),
  address_line2: text(200),
  city: text(100),
  county: text(100),
  postcode: postcode(),
  country: text(100),
  notes: text(2000),
});

/** Site & Safety — a permit to work header, from an existing permit document. */
export const permitExtractionSchema = z.object({
  title: text(200),
  scope: text(2000),
  location: text(200),
  responsiblePerson: text(200),
  isolationDetails: text(4000),
  emergencyArrangements: text(4000),
});

/** Site & Safety — a toolbox talk record / attendance sheet. */
export const toolboxTalkExtractionSchema = z.object({
  topic: text(200),
  talk_date: isoDate(),
  location: text(200),
  key_points: text(8000),
  presenter: text(200),
  ppe: text(500),
  attendee_count: wholeNumber(9999),
  attendees: text(8000),
  notes: text(5000),
});

/** Site & Safety — a snag / defect, from a defect report or notice. */
export const snagExtractionSchema = z.object({
  title: text(200),
  description: text(8000),
  location: text(200),
  trade: text(120),
  due_date: isoDate(),
});

/** Site & Safety — a site diary entry, from a daily record sheet. */
export const diaryExtractionSchema = z.object({
  entry_date: isoDate(),
  weather: text(200),
  labour_count: wholeNumber(9999),
  work_summary: text(8000),
  delays: text(8000),
  notes: text(5000),
});

/** Site & Safety — a compliance document's metadata (the uploaded file IS the record). */
export const complianceDocumentExtractionSchema = z.object({
  kind: oneOf(["insurance", "certificate", "permit", "contract", "other"]),
  title: text(200),
  expires_at: isoDate(),
  notes: text(5000),
});

/** Quality — an inspection & test plan header, from an ITP document. */
export const itpExtractionSchema = z.object({
  workPackage: text(200),
  title: text(200),
  specificationRef: text(200),
  location: text(200),
  planDate: isoDate(),
  notes: text(20000),
});

/** Stock — a stock item, from a product label / supplier catalogue line. */
export const stockItemExtractionSchema = z.object({
  name: text(200),
  unit: text(40),
  sku: text(120),
  barcode: text(120),
  supplier_reference: text(120),
  description: text(2000),
});

/** Fleet — a vehicle, from a V5C logbook / purchase invoice. */
export const vehicleExtractionSchema = z.object({
  name: text(200),
  registration: text(40),
  manufacturer: text(120),
  model: text(120),
  variant: text(120),
  vin: text(40),
  year_of_manufacture: wholeNumber(2100),
  first_registered_on: isoDate(),
  gross_weight_kg: wholeNumber(100_000),
  purchase_date: isoDate(),
  purchase_price: decimal(99_999_999),
});

/**
 * Site & Safety — a delay / EOT event, from a notice / instruction / letter.
 * Keys match the create form inputs (lib app/(app)/delays/_form-fields.tsx):
 * `startedOn`/`endedOn` are camelCase there, so they are here too. `category`
 * is a fixed set. `workingDaysLost` is DELIBERATELY excluded — the form labels
 * it a manual claim the operator must make, never a figure read off a document.
 */
export const delayExtractionSchema = z.object({
  category: oneOf([
    "weather",
    "client_instruction",
    "access_restriction",
    "third_party_dependency",
    "design_change",
    "other",
  ]),
  startedOn: isoDate(),
  endedOn: isoDate(),
  description: text(8000),
});

/** Site & Safety — a progress / site report header, from a report document.
 *  The create form captures title + the reporting period; progress % and photos
 *  are added on the report itself after it exists, so they are not extracted. */
export const siteReportExtractionSchema = z.object({
  title: text(200),
  period_start: isoDate(),
  period_end: isoDate(),
});

/**
 * Projects — a warranty / guarantee, from a warranty certificate. Header fields
 * only; the job it attaches to is chosen on the page (a UUID a document cannot
 * name). `kind` is a fixed set; `period_months` a whole number of months.
 */
export const warrantyExtractionSchema = z.object({
  title: text(200),
  provider: text(200),
  kind: oneOf(["workmanship", "product", "structural", "defects_liability", "other"]),
  period_months: wholeNumber(600),
  reference: text(120),
  cover: text(8000),
  exclusions: text(8000),
});

/**
 * People — a staff QUALIFICATION, from a CSCS card / certificate / ticket.
 * Identity of the qualification only (type, title, reference, issue/expiry) —
 * the staff member it belongs to is the page's `[id]`, never extracted; pay,
 * role and emergency contacts are categorically out of scope (as for invites).
 */
export const qualificationExtractionSchema = z.object({
  qualification_type: text(120),
  title: text(200),
  reference_no: text(120),
  issued_on: isoDate(),
  expires_on: isoDate(),
  notes: text(2000),
});

/**
 * Projects — a variation / VO header, from a client instruction or quote. Only
 * the title + description are extracted; the line items, cost and margin are
 * priced deliberately in the form's calculator, never read off a document.
 */
export const variationExtractionSchema = z.object({
  title: text(200),
  description: text(8000),
});

/** Assets — equipment, from a purchase invoice / spec sheet / hire agreement. */
export const assetExtractionSchema = z.object({
  name: text(200),
  category: text(120),
  manufacturer: text(120),
  model: text(120),
  serial_number: text(120),
  registration: text(40),
  asset_ref: text(120),
  purchase_date: isoDate(),
  purchase_price: decimal(99_999_999),
  warranty_expires_at: isoDate(),
  hire_start: isoDate(),
  hire_end: isoDate(),
  hire_rate: decimal(999_999),
});

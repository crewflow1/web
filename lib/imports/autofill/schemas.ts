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

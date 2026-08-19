import { z } from "zod";

/**
 * Customer contacts — pure layer (P3 portal completeness).
 *
 * A customer (household or business) can have several named people. This module
 * is the pure layer: input validation, the role vocabulary, and the
 * customer-safe read-back projection.
 *
 * PROJECTION: the portal read-back exposes the reachable-person fields
 * (name/email/phone/role) and whether that contact has portal access — but NEVER
 * the raw portal_token itself (the credential). A token is a login secret; it is
 * pinned OUT of the view so a page render can never leak it, and it is redacted
 * from the GDPR export by the token-name rule as well.
 */

export const CONTACT_ROLES = [
  "primary",
  "billing",
  "site",
  "partner",
  "tenant",
  "other",
] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];

export const CONTACT_ROLE_LABELS: Record<ContactRole, string> = {
  primary: "Primary contact",
  billing: "Billing / accounts",
  site: "Site contact",
  partner: "Partner",
  tenant: "Tenant",
  other: "Other",
};

/**
 * Shared field shape for a customer contact. Both the portal add-form and the
 * staff CRUD surface build on this so the two can never disagree on what a valid
 * contact is. At least one of email/phone is required — a contact with no way to
 * reach them is a data-entry slip, not a contact — enforced by the `.refine` on
 * each derived schema (a bare object can't carry a cross-field refinement).
 */
const customerContactBase = z.object({
  name: z.string().trim().min(2, "Enter the contact's name").max(200),
  email: z
    .string()
    .trim()
    .max(320)
    .email("Enter a valid email")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  phone: z
    .string()
    .trim()
    .max(50)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  role: z.enum(CONTACT_ROLES).default("other"),
});

const REACHABLE_MESSAGE = "Add an email or a phone number so we can reach them";

/**
 * Portal add-contact input. Empty strings are normalised to undefined so the
 * "at least one" rule is meaningful. Deliberately has NO notes field — the
 * customer-facing form never writes the staff-only note.
 */
export const customerContactSchema = customerContactBase.refine(
  (v) => Boolean(v.email) || Boolean(v.phone),
  { message: REACHABLE_MESSAGE, path: ["email"] },
);
export type CustomerContactInput = z.infer<typeof customerContactSchema>;

/**
 * Staff CRUD input. Same reachable-person rule as the portal form, plus the
 * staff-only free-form `notes` field (who they are, when to call). Used by both
 * the add and edit staff actions; the edit action carries the contact id
 * separately.
 */
export const staffCustomerContactSchema = customerContactBase
  .extend({
    notes: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .or(z.literal("").transform(() => undefined)),
  })
  .refine((v) => Boolean(v.email) || Boolean(v.phone), {
    message: REACHABLE_MESSAGE,
    path: ["email"],
  });
export type StaffCustomerContactInput = z.infer<typeof staffCustomerContactSchema>;

/** Declared, exhaustive read-back shape — note: NO portal_token field. */
export const CONTACT_PORTAL_KEYS = [
  "id",
  "name",
  "email",
  "phone",
  "role",
  "role_label",
  "has_portal_access",
] as const;

export type PortalContactView = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: ContactRole;
  role_label: string;
  /** Whether this contact has their OWN scoped portal login — never the token. */
  has_portal_access: boolean;
};

export function buildPortalContactView(row: {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string;
  portal_access_enabled: boolean;
}): PortalContactView {
  const role = (CONTACT_ROLES as readonly string[]).includes(row.role)
    ? (row.role as ContactRole)
    : "other";
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? null,
    phone: row.phone ?? null,
    role,
    role_label: CONTACT_ROLE_LABELS[role],
    has_portal_access: Boolean(row.portal_access_enabled),
  };
}

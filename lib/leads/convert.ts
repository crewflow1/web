/**
 * Lead → customer conversion — pure layer.
 *
 * Server/client-safe: no Supabase, no server-only imports, so the derivation and
 * the idempotency decision are unit-testable without a database. The action
 * (app/(app)/leads/actions.ts → convertLeadToCustomer) supplies the org context,
 * the reads/writes and the concurrency guard; this module owns only the shape of
 * the customer we create from a lead and the "should we convert at all" rule.
 */

/** The lead fields conversion reads. contact_* landed in 20260601000100. */
export type ConvertibleLead = {
  id: string;
  customer_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
};

/** The customer columns conversion writes. Mirrors the customers insert shape. */
export type CustomerFromLead = {
  org_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  country: string;
};

/**
 * The idempotency decision. A lead already carrying a customer_id has been
 * converted — conversion is a NO-OP that returns the existing customer, never a
 * second customer record. A lead with no reachable identity (no name, email or
 * phone) cannot become a customer (customers.name is NOT NULL).
 */
export type ConvertDecision =
  | { kind: "already"; customerId: string }
  | { kind: "convert"; name: string }
  | { kind: "no_contact" };

/**
 * Derive the customer's display name from a lead. A customer MUST have a name
 * (NOT NULL in the schema), so we fall back through the reachable identifiers
 * rather than ever writing an empty name: contact_name → email → phone.
 * Returns null only when the lead has none of the three.
 */
export function deriveCustomerName(lead: ConvertibleLead): string | null {
  const name = (lead.contact_name ?? "").trim();
  if (name) return name;
  const email = (lead.contact_email ?? "").trim();
  if (email) return email;
  const phone = (lead.contact_phone ?? "").trim();
  if (phone) return phone;
  return null;
}

/**
 * Decide what conversion should do for this lead — the single source of truth for
 * the idempotency guard. Pure and total.
 */
export function decideConversion(lead: ConvertibleLead): ConvertDecision {
  if (lead.customer_id) return { kind: "already", customerId: lead.customer_id };
  const name = deriveCustomerName(lead);
  if (!name) return { kind: "no_contact" };
  return { kind: "convert", name };
}

/**
 * Build the customers insert payload from a lead + the ACTIVE org. Email/phone
 * are normalised to null when blank so we never write empty strings. `name` is
 * passed in (already derived + validated by decideConversion) so the caller
 * cannot accidentally build a payload for a no-contact lead.
 */
export function buildCustomerFromLead(
  orgId: string,
  name: string,
  lead: ConvertibleLead,
): CustomerFromLead {
  const email = (lead.contact_email ?? "").trim();
  const phone = (lead.contact_phone ?? "").trim();
  return {
    org_id: orgId,
    name,
    email: email || null,
    phone: phone || null,
    country: "United Kingdom",
  };
}

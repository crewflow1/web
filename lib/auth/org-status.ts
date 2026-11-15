/**
 * Held-company status (D-17). Pure — no server-only, no Next imports — so the capability
 * guards, the staff actions and the session helper all share ONE definition.
 *
 * "Held" = anything other than active / trial that the database knows. An unknown or
 * missing status is NOT treated as held here: the organisations.status CHECK constraint
 * admits only the six known values, and session.ts defaults a null status to "active".
 */
export const HELD_ORG_STATUSES = ["pending", "suspended", "rejected", "cancelled"] as const;

export function isHeldStatus(status: string | null | undefined): boolean {
  return (HELD_ORG_STATUSES as readonly string[]).includes(status ?? "");
}

/**
 * The statuses the DATABASE treats as read-only (public.org_is_writable, 20261346): everything
 * except active / trial. Identical to HELD_ORG_STATUSES — pending is held at BOTH layers, so a
 * pending company cannot bypass the /access-pending lock with a direct Data API request.
 */
export const READ_ONLY_DB_STATUSES = HELD_ORG_STATUSES;

/**
 * PUBLIC (unauthenticated / token / API-key) writes into a company — D-17.
 *
 * A public link must not get round the company lifecycle: a customer, a lead form, an inbound
 * call or an API key must not create jobs, invoices, bookings, requests or any other operational
 * record in a company that is not active. Three kinds, most to least restricted:
 *
 *   operational — anything that creates or changes operational records (accept a quote, book,
 *                 request, message, upload, lead capture, inbound enquiry, public API, SCIM).
 *                 active / trial ONLY.
 *   payment     — paying (or evidencing payment of) an invoice that ALREADY exists. Allowed while
 *                 suspended / cancelled too: the debt is real and settling it creates no new
 *                 commitment. Refused for pending / rejected (such a company has never traded).
 *   consent     — the data subject's own rights: marketing / contact preferences, unsubscribe,
 *                 correcting their own contact details. ALWAYS allowed (legally required).
 *
 * An unknown / missing status fails CLOSED for operational and payment.
 */
export type PublicWriteKind = "operational" | "payment" | "consent";

export function publicWriteAllowed(status: string | null | undefined, kind: PublicWriteKind): boolean {
  if (kind === "consent") return true;
  if (status === "active" || status === "trial") return true;
  if (kind === "payment") return status === "suspended" || status === "cancelled";
  return false;
}

/** What a member of the public is told. Deliberately says nothing about WHY. */
export const PUBLIC_WRITE_REFUSED_MESSAGE =
  "This company isn't taking online requests at the moment. Please contact them directly.";

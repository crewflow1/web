import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { readFailure } from "@/lib/supabase/read-failure";
import { loadCustomerFinancials } from "@/lib/customers/financials";
import { buildCustomerStatement, type CustomerStatement } from "@/lib/customers/statement";
import { resolveOrgLogoSrc } from "@/server/services/company-logo";
import type { StatementPdfInput } from "@/lib/pdf/statement-pdf";

/**
 * Customer statement-of-account read layer — READ-ONLY by construction.
 *
 * Assembles everything the branded statement PDF + delivery paths need for ONE
 * customer over an (optional) date range, from the authorities that already own
 * each fact:
 *   - the invoice + payment ledger via `loadCustomerFinancials` (anchored on the
 *     durable `invoices.customer_id`, PAGED (F-1), LOUD on error);
 *   - the running-balance maths via the pure `buildCustomerStatement`;
 *   - the org letterhead + resolved logo via `resolveOrgLogoSrc`.
 *
 * No `insert`/`update`/`delete`/`rpc` here and none may be added.
 *
 * ── ACTIVE-ORG + CUSTOMER SCOPE ──────────────────────────────────────────────
 * The customer read is pinned `.eq("org_id", orgId).eq("id", customerId)`: RLS's
 * `current_org_ids()` admits every org the viewer belongs to, so a by-id read
 * must pin the ACTIVE org in-statement or a dual-org member could statement
 * another of their orgs' customers. A foreign / missing customer returns null
 * (the caller 404s). The financials read keys off the same customer_id, whose
 * composite FK guarantees only that customer's own-org invoices match.
 *
 * The org row is likewise pinned to `orgId` so the letterhead, VAT number and
 * logo can never be another org's.
 *
 * The Supabase client is passed in (the `lib/jobs/load.ts` / financials idiom):
 * the internal path hands the user-JWT client, the portal path the service-role
 * admin client with the token-resolved org + customer — the scoping predicates
 * hold either way.
 */

export type StatementRange = { from?: string | null; to?: string | null };

type StatementCustomer = {
  id: string;
  name: string;
  email: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  country: string | null;
};

export interface CustomerStatementView {
  customer: StatementCustomer;
  statement: CustomerStatement;
  /** Ready-to-render PDF input (logo already resolved to a signed URL / null). */
  pdfInput: StatementPdfInput;
  /** Convenience filename stem, e.g. `statement-acme-2026-08-16`. */
  filename: string;
}

type StatementClient = SupabaseClient<Database>;

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "customer"
  );
}

/**
 * Load + compose a customer's statement of account. Returns null when the
 * customer does not exist in the active org (indistinguishable from missing).
 */
export async function loadCustomerStatement(
  supabase: StatementClient,
  orgId: string,
  customerId: string,
  range: StatementRange = {},
  now: Date = new Date(),
): Promise<CustomerStatementView | null> {
  const { data: customer, error: custErr } = await supabase
    .from("customers")
    .select(
      "id, name, email, address_line1, address_line2, city, county, postcode, country",
    )
    .eq("id", customerId)
    // Active-org pin — RLS admits every org the viewer belongs to.
    .eq("org_id", orgId)
    .maybeSingle();
  if (custErr) throw readFailure("customer statement: customer", custErr);
  if (!customer) return null;

  // Letterhead — pinned to the active org so a dual-org user can't print another
  // org's identity, VAT number or bank-adjacent details.
  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .select("name, phone, vat_number, logo_path, logo_url, address")
    .eq("id", orgId)
    .maybeSingle();
  if (orgErr) throw readFailure("customer statement: organization", orgErr);

  // The ledger — paged + loud (F-1 safe), anchored on invoices.customer_id.
  const { invoiceRows, paymentRows } = await loadCustomerFinancials(
    supabase,
    customerId,
  );

  const statement = buildCustomerStatement(
    invoiceRows.map((i) => ({
      id: i.id,
      number: i.number,
      status: i.status,
      total: i.total,
      created_at: i.created_at,
      due_date: i.due_date,
    })),
    paymentRows.map((p) => ({
      id: p.id,
      invoice_id: p.invoice_id,
      amount: p.amount,
      paid_at: p.paid_at,
      reference: p.reference,
    })),
    range,
  );

  const orgLogoUrl = await resolveOrgLogoSrc(
    org ? { logo_path: org.logo_path, logo_url: org.logo_url } : null,
  );

  const pdfInput: StatementPdfInput = {
    org_name: org?.name ?? "CrewFlow",
    org_phone: org?.phone ?? null,
    org_vat_number: (org as { vat_number?: string | null } | null)?.vat_number ?? null,
    org_logo_url: orgLogoUrl,
    org_address: (org?.address as StatementPdfInput["org_address"]) ?? null,
    customer_name: customer.name,
    customer_email: customer.email,
    customer_address: {
      line1: customer.address_line1,
      line2: customer.address_line2,
      city: customer.city,
      county: customer.county,
      postcode: customer.postcode,
      country: customer.country,
    },
    from: statement.from,
    to: statement.to,
    generated_at: now.toISOString(),
    openingBalance: statement.openingBalance,
    closingBalance: statement.closingBalance,
    totalCharged: statement.totalCharged,
    totalCredited: statement.totalCredited,
    entries: statement.entries.map((e) => ({
      date: e.date,
      description: e.description,
      charge: e.charge,
      credit: e.credit,
      balance: e.balance,
    })),
  };

  const filename = `statement-${slug(customer.name)}-${(statement.to ?? now.toISOString()).slice(0, 10)}`;

  return {
    customer: {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      address_line1: customer.address_line1,
      address_line2: customer.address_line2,
      city: customer.city,
      county: customer.county,
      postcode: customer.postcode,
      country: customer.country,
    },
    statement,
    pdfInput,
    filename,
  };
}

/**
 * Migration OS — direct-API connector normalisation.
 *
 * A connector (Xero / QuickBooks direct-API sync) pulls a connected book's
 * contacts and invoices as {@link PulledContact} / {@link PulledInvoice}. This
 * module turns each one into the SAME `mapped` shape a parsed spreadsheet row
 * produces, so a connector pull feeds the EXISTING import pipeline unchanged:
 * the rows are staged as `import_rows`, deduped by lib/imports/duplicates.ts, and
 * committed by the same commit path (insertOne / buildInvoiceImportPlan). Nothing
 * here writes to a live table — the operator still previews and commits.
 *
 * PURE. No I/O, no clock, no server-only. The same pulled row always produces the
 * same mapped row, so the mapping is exhaustively unit-testable.
 *
 * CONFIDENCE. Structured provider data is high-trust, so a complete row is
 * confidence 100 (imports on commit). A row missing the field the commit path
 * REQUIRES (a customer with no name, an invoice with no number or no positive
 * total) is dropped to a low confidence so the pipeline parks it as
 * `needs_review` instead of silently skipping it at commit — the guided-migration
 * contract. The threshold that decides review lives with the pipeline
 * (REVIEW_THRESHOLD in app/(app)/imports/actions.ts); this module only scores.
 */

import type { PulledContact, PulledInvoice } from "@/lib/integrations/accounting/adapters";

/**
 * A connector row in the shape the import pipeline stages. Mirrors the detector's
 * MappedRow (entity_type + confidence + mapped + warnings), plus the provider
 * provenance so the raw record records where the row came from.
 */
export type NormalisedConnectorRow = {
  entity_type: "customer" | "invoice";
  confidence: number;
  mapped: Record<string, unknown>;
  warnings: string[];
  /** Provider provenance, e.g. "xero:contact:<id>" — stored in import_rows.raw. */
  source_ref: string;
};

/** Confidence below the pipeline's review threshold — parks the row for review. */
const REVIEW_CONFIDENCE = 40;

/** Map ONE pulled contact onto a `customer` import row. */
export function normaliseContact(
  provider: "xero" | "quickbooks",
  c: PulledContact,
): NormalisedConnectorRow {
  const name = (c.name ?? "").trim();
  const warnings: string[] = [];
  if (!name) warnings.push("contact has no name — will not import until named");

  const mapped: Record<string, unknown> = {
    name,
    email: c.email ?? null,
    phone: c.phone ?? null,
    address_line1: c.addressLine1 ?? null,
    city: c.city ?? null,
    postcode: c.postcode ?? null,
    notes: null,
  };

  return {
    entity_type: "customer",
    // A named contact from a structured API is fully trusted; a nameless one
    // parks for review (the commit path would otherwise skip it silently).
    confidence: name ? 100 : REVIEW_CONFIDENCE,
    mapped,
    warnings,
    source_ref: `${provider}:contact:${c.sourceId}`,
  };
}

/** Map ONE pulled invoice onto an `invoice` import row. */
export function normaliseInvoice(
  provider: "xero" | "quickbooks",
  inv: PulledInvoice,
): NormalisedConnectorRow {
  const number = (inv.number ?? "").trim();
  const amount = Number(inv.net);
  const vat = Number(inv.vat);
  const total = Number(inv.gross);
  const warnings: string[] = [];
  if (!number) warnings.push("invoice has no number — will not import until numbered");
  if (!(total > 0)) warnings.push("invoice has no positive total — will not import");

  const mapped: Record<string, unknown> = {
    number,
    customer_name: (inv.customerName ?? "").trim(),
    // buildInvoiceImportPlan reads amount (net), vat_total, total; it derives the
    // stored generated `total` from amount + vat_total, so all three are supplied.
    amount: Number.isFinite(amount) ? amount : 0,
    vat_total: Number.isFinite(vat) ? vat : 0,
    total: Number.isFinite(total) ? total : 0,
    status: inv.status,
    created_at: inv.date ?? null,
    due_date: null,
    paid_at: null,
    notes: null,
  };

  return {
    entity_type: "invoice",
    confidence: number && total > 0 ? 100 : REVIEW_CONFIDENCE,
    mapped,
    warnings,
    source_ref: `${provider}:invoice:${inv.sourceId}`,
  };
}

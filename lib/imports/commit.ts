import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { buildInvoiceImportPlan } from "@/lib/imports/invoice-row";
import { buildFinanceImportPlan } from "@/lib/imports/vat";
import type { EntityType } from "@/lib/imports/detect";

/**
 * Migration OS — commit primitives, shared by the customer wizard
 * (`app/(app)/imports/actions.ts`, scoped to the caller's active org) and the
 * operator surface (`lib/admin/operator-imports.ts`, scoped to an explicit
 * target org). Extracted verbatim so there is ONE insert implementation and the
 * two paths can never drift.
 *
 * Every function is already parameterised by `orgId` + the service-role `admin`
 * client (it stamps `orgId` on every insert and pins every parent-record
 * resolver to it). It bypasses RLS, so the CALLER is responsible for having
 * authorised `orgId` and for passing the SAME `orgId` it authorised — this
 * module trusts its `orgId` argument.
 */

/**
 * Human-readable reason a row was skipped during commit (insertOne returned
 * null). insertOne returns null for several distinct reasons, so a blanket
 * message would mislead — this names the likely cause per entity.
 */
export function skipReason(entity: EntityType): string {
  switch (entity) {
    case "staff":
      return 'staff aren’t created on import — use “Send staff invites” to email them a sign-in link';
    case "job":
      return "couldn’t match a customer for this job — check the customer name";
    case "quote":
      return "couldn’t match a customer for this quote — check the customer name";
    case "payment":
      return "couldn’t match an invoice for this payment — check the invoice number";
    default:
      return "missing required fields";
  }
}

export function tableFor(entity: EntityType): string {
  switch (entity) {
    case "customer":
      return "customers";
    case "invoice":
      return "invoices";
    case "lead":
      return "leads";
    case "staff":
      return "memberships";
    case "cost":
      return "finances";
    case "supplier":
      return "customers"; // v1: suppliers live alongside customers
    case "job":
      return "jobs";
    case "quote":
      return "quotes";
    case "payment":
      return "invoice_payments";
  }
}

export async function insertOne(
  entity: EntityType,
  mapped: Record<string, unknown>,
  orgId: string,
  admin: ReturnType<typeof createAdminClient>,
): Promise<string | null> {
  switch (entity) {
    case "customer":
    case "supplier": {
      const name = String(mapped.name ?? "").trim();
      if (!name) return null;
      const { data, error } = await admin
        .from("customers")
        .insert({
          org_id: orgId,
          name,
          email: (mapped.email as string) ?? null,
          phone: (mapped.phone as string) ?? null,
          notes: (mapped.notes as string) ?? null,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return data?.id ?? null;
    }
    case "invoice": {
      // Link the invoice to its customer when the file named one we can resolve
      // in THIS org. Mirrors the jobs/quotes path (same org-scoped resolver),
      // but — unlike those — an unresolved name does NOT skip the row: an
      // unlinked invoice is valid (historical AR, customer_name is not a
      // required field), so it imports with customer_id left NULL.
      const customerName = String(mapped.customer_name ?? "").trim();
      const customerId = customerName
        ? await resolveCustomerByName(admin, orgId, customerName)
        : null;
      // `invoices.total` is a STORED GENERATED column (amount + vat_total), so
      // it must NOT be written — Postgres rejects the whole INSERT with
      // SQLSTATE 428C9. buildInvoiceImportPlan owns the payload shape (and the
      // back-dating); see lib/imports/invoice-row.ts.
      const plan = buildInvoiceImportPlan(
        mapped,
        orgId,
        normaliseInvoiceStatus(mapped.status),
        customerId,
      );
      if (plan.status === "skip") return null;
      // A date the file gave but we can't read is the operator's to fix, not
      // ours to paper over. Throwing marks THIS row `error` with the reason
      // attached and leaves the rest of the import running.
      if (plan.status === "reject") throw new Error(plan.reason);
      const { data, error } = await admin
        .from("invoices")
        .insert(plan.row)
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return data?.id ?? null;
    }
    case "lead": {
      const name = String(mapped.name ?? "").trim();
      if (!name) return null;
      // Leads need a customer; create one inline if not supplied.
      const { data: cust } = await admin
        .from("customers")
        .insert({
          org_id: orgId,
          name,
          email: (mapped.email as string) ?? null,
          phone: (mapped.phone as string) ?? null,
        })
        .select("id")
        .single();
      const { data, error } = await admin
        .from("leads")
        .insert({
          org_id: orgId,
          customer_id: cust?.id ?? null,
          source: ((mapped.source as string) ?? "import"),
          service: (mapped.service as string) ?? null,
          urgency: (mapped.urgency as string) ?? null,
          postcode: (mapped.postcode as string) ?? null,
          estimated_value: (mapped.estimated_value as number) ?? null,
          notes: (mapped.notes as string) ?? null,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return data?.id ?? null;
    }
    case "cost": {
      // `finances.vat_total` is a STORED GENERATED column
      // (round(amount * vat_rate / 100, 2)) — Postgres rejects an INSERT that
      // supplies it with SQLSTATE 428C9, which failed EVERY cost row. The
      // writable input is `vat_rate`, so the imported VAT figure is resolved to
      // one of the three permitted rates and the database computes the total.
      const plan = buildFinanceImportPlan(mapped, orgId);
      if (plan.status === "skip") return null;
      // A VAT figure that can't land on 0/5/20, or a date we can't read, is an
      // arithmetic problem in the operator's file — not something to round away
      // or stamp with now(). Throwing marks THIS row `error` with the reason
      // attached and leaves the rest of the import running.
      if (plan.status === "reject") throw new Error(plan.reason);
      const { data, error } = await admin
        .from("finances")
        .insert(plan.row)
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return data?.id ?? null;
    }
    case "staff": {
      // Importing staff with full auth-user provisioning is a deeper
      // workflow than v1 covers (email invite + magic-link). v1 records
      // the row in import_rows + a stub customer row so the wizard still
      // surfaces them as imported — but does NOT create auth users.
      // Skip insertion; surface as 'skipped' with a note.
      return null;
    }
    case "job": {
      // Jobs need a customer to be useful. Resolve customer_name to
      // an existing org customer (case-insensitive). If we can't,
      // skip rather than blocking the rest of the migration.
      const customerName = String(mapped.customer_name ?? "").trim();
      if (!customerName) return null;
      const customerId = await resolveCustomerByName(
        admin,
        orgId,
        customerName,
      );
      if (!customerId) return null;
      // Compose a notes field that preserves details the jobs table
      // doesn't have first-class columns for (title / address /
      // value), so nothing the migration extracted is lost.
      const noteParts: string[] = [];
      if (mapped.title) noteParts.push(`Title: ${mapped.title}`);
      if (mapped.address) noteParts.push(`Address: ${mapped.address}`);
      if (mapped.value != null && mapped.value !== "") {
        noteParts.push(`Value: ${mapped.value}`);
      }
      if (mapped.notes) noteParts.push(String(mapped.notes));
      const composedNotes = noteParts.join("\n") || null;
      const { data, error } = await admin
        .from("jobs")
        .insert({
          org_id: orgId,
          customer_id: customerId,
          status: (mapped.status as string) ?? "new",
          scheduled_date: (mapped.scheduled_date as string) ?? null,
          notes: composedNotes,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return data?.id ?? null;
    }
    case "quote": {
      // Quotes need both a number AND a resolvable customer.
      const number = String(mapped.number ?? "").trim();
      if (!number) return null;
      const customerName = String(mapped.customer_name ?? "").trim();
      if (!customerName) return null;
      const customerId = await resolveCustomerByName(
        admin,
        orgId,
        customerName,
      );
      if (!customerId) return null;
      const total = Number(mapped.total ?? 0);
      const { data, error } = await admin
        .from("quotes")
        .insert({
          org_id: orgId,
          customer_id: customerId,
          number,
          status: (mapped.status as string) ?? "draft",
          // v1: we don't split subtotal/vat from imported totals —
          // the operator can re-issue the quote in-app to recompute.
          subtotal: total,
          vat_total: 0,
          total,
          valid_until: (mapped.valid_until as string) ?? null,
          notes: (mapped.notes as string) ?? null,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return data?.id ?? null;
    }
    case "payment": {
      // Payments need a positive amount + a resolvable invoice.
      const amount = Number(mapped.amount ?? 0);
      if (!(amount > 0)) return null;
      const invoiceNumber = String(mapped.invoice_number ?? "").trim();
      if (!invoiceNumber) return null;
      const invoiceId = await resolveInvoiceByNumber(
        admin,
        orgId,
        invoiceNumber,
      );
      if (!invoiceId) return null;
      const paidAt =
        (mapped.paid_at as string) ?? new Date().toISOString().slice(0, 10);
      const noteParts: string[] = [];
      if (mapped.payment_method) {
        noteParts.push(`Method: ${mapped.payment_method}`);
      }
      if (mapped.notes) noteParts.push(String(mapped.notes));
      const { data, error } = await admin
        .from("invoice_payments")
        .insert({
          org_id: orgId,
          invoice_id: invoiceId,
          amount,
          paid_at: paidAt,
          reference: (mapped.reference as string) ?? null,
          notes: noteParts.join(" · ") || null,
          source: "manual",
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return data?.id ?? null;
    }
  }
}

// ---------------------------------------------------------------------
// Parent-record resolvers — needed by jobs / quotes / payments / invoices.
// Service-role; the caller authorises `orgId` and every resolver pins it.
// ---------------------------------------------------------------------

async function resolveCustomerByName(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  name: string,
): Promise<string | null> {
  const { data } = await admin
    .from("customers")
    .select("id")
    .eq("org_id", orgId)
    .ilike("name", name)
    .limit(1)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

async function resolveInvoiceByNumber(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  number: string,
): Promise<string | null> {
  const { data } = await admin
    .from("invoices")
    .select("id")
    .eq("org_id", orgId)
    .ilike("number", number)
    .limit(1)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

type InvoiceStatusEnum =
  | "draft"
  | "sent"
  | "awaiting_payment"
  | "partially_paid"
  | "paid";

/**
 * Map an imported status cell onto a WRITABLE invoice status.
 *
 * `overdue` is deliberately not accepted. It is derived from `due_date` plus
 * the trigger-owned payment status (lib/invoices/overdue.ts), so importing it
 * would store a value nothing keeps current — the row would read "overdue"
 * forever, including after payment.
 *
 * A legacy CSV column saying "overdue" is not discarded information: such an
 * invoice is unpaid and past its date, which is exactly what `sent` + its
 * `due_date` already expresses. It will be shown as overdue by the derived
 * authority, on the same terms as every other invoice — so the import lands on
 * `sent` (the existing fallback) and the truth is recovered from the facts.
 */
function normaliseInvoiceStatus(raw: unknown): InvoiceStatusEnum {
  if (typeof raw !== "string") return "sent";
  const allowed: InvoiceStatusEnum[] = [
    "draft",
    "sent",
    "awaiting_payment",
    "partially_paid",
    "paid",
  ];
  const v = raw.toLowerCase().trim() as InvoiceStatusEnum;
  return allowed.includes(v) ? v : "sent";
}

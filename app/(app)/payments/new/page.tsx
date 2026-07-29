import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { computeInvoiceBalance } from "@/lib/payments/allocation";
import { AllocatePaymentForm, type OutstandingInvoice } from "./_allocate-form";

/**
 * Record one payment and allocate it across outstanding invoices.
 *
 * Loads every not-fully-paid invoice for the org with its DERIVED outstanding
 * balance (total − payments so far), then hands them to the allocation form.
 * The actual write + all money invariants are enforced by the DB via the
 * `allocate_payment` RPC (see `allocate-actions.ts`).
 */
export default async function NewPaymentPage() {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const { data: invoices, error: invoicesError } = await supabase
    .from("invoices")
    .select("id, number, total, due_date, status, customer:customers ( name )")
    // ACTIVE-org pin — recording a payment against the other org's invoice is a
    // money defect; the picker must only offer this org's outstanding invoices.
    .eq("org_id", ctx.org.id)
    .in("status", ["sent", "awaiting_payment", "partially_paid", "overdue"])
    .order("due_date", { ascending: true });
  if (invoicesError) throw readFailure("payments new: invoices", invoicesError);

  const rows = invoices ?? [];
  const invIds = rows.map((i) => i.id);

  // Payments already recorded against these invoices → outstanding balances.
  const { data: paid, error: paidError } = invIds.length
    ? await supabase
        .from("invoice_payments")
        .select("invoice_id, amount")
        .eq("org_id", ctx.org.id)
        .in("invoice_id", invIds)
    : { data: [] as Array<{ invoice_id: string; amount: number | string }>, error: null };
  // A failed read here would show every invoice as fully outstanding and
  // invite double-allocation — fail loud.
  if (paidError) throw readFailure("payments new: recorded payments", paidError);

  const paidByInvoice = new Map<string, Array<{ amount: number | string }>>();
  for (const p of paid ?? []) {
    const arr = paidByInvoice.get(p.invoice_id) ?? [];
    arr.push({ amount: p.amount });
    paidByInvoice.set(p.invoice_id, arr);
  }

  const outstanding: OutstandingInvoice[] = rows
    .map((i) => {
      const bal = computeInvoiceBalance({
        invoiceTotal: i.total,
        payments: paidByInvoice.get(i.id) ?? [],
      });
      const customer = i.customer as unknown as { name: string } | null;
      return {
        id: i.id,
        number: i.number,
        customerName: customer?.name ?? null,
        total: Number(i.total ?? 0),
        outstanding: bal.outstanding,
        dueDate: i.due_date ?? null,
      };
    })
    .filter((r) => r.outstanding > 0.005);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/payments" className="hover:text-slate-900">
          Payments
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Record payment</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">Record a payment</h1>
        <p className="mt-1 text-sm text-slate-500">
          Enter the money received, then split it across the invoices it settles.
          One bank transfer can clear several invoices at once.
        </p>
      </header>

      {outstanding.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500 shadow-sm">
          No outstanding invoices to allocate against. Once an invoice is sent it
          will appear here.
        </div>
      ) : (
        <AllocatePaymentForm invoices={outstanding} />
      )}
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { ConfirmForm } from "@/components/forms/ConfirmForm";
import { PurchaseOrderBuilder } from "../_builder";
import { listPoFormOptions } from "../_data";
import {
  setPurchaseOrderStatus,
  deletePurchaseOrder,
  updatePurchaseOrder,
} from "../actions";
import {
  PO_TRANSITIONS,
  poStatusLabel,
  type PurchaseOrderStatus,
} from "@/lib/purchase-orders/schema";
import {
  computePoBilling,
  PO_BILL_STATUS_LABEL,
  PO_BILL_STATUS_CLASS,
} from "@/lib/purchase-orders/billing";
import { RecordBillForm } from "./_bill-form";

const GBP = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2 });

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  sent: "bg-blue-100 text-blue-700",
  received: "bg-emerald-100 text-emerald-700",
  cancelled: "bg-slate-100 text-slate-400",
};

const ERROR_COPY: Record<string, string> = {
  bad_transition: "That status change isn't allowed from the current state.",
  bad_status: "Unknown status.",
  status_failed: "Couldn't update the status. Try again.",
  delete_denied: "Only admins/owners can delete a purchase order.",
  not_found: "Purchase order not found.",
};

type LineRow = {
  description: string;
  qty: number;
  unit: string | null;
  unit_price: number;
  vat_rate: number;
  line_total: number | string | null;
};
type Po = {
  id: string;
  number: string;
  status: string;
  supplier_id: string | null;
  job_id: string | null;
  supplier_reference: string | null;
  expected_date: string | null;
  notes: string | null;
  subtotal: number | string | null;
  vat_total: number | string | null;
  total: number | string | null;
  supplier: { name: string } | null;
  line_items: LineRow[];
};

export default async function PurchaseOrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { id } = await params;
  const { saved, error } = await searchParams;

  const { ctx } = await requireOrgContext();
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  const supabase = await createClient();

  const { data: po } = await (
    supabase.from("purchase_orders" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: Po | null }> };
        };
      };
    }
  )
    .select(
      "id, number, status, supplier_id, job_id, supplier_reference, expected_date, notes, subtotal, vat_total, total, supplier:suppliers ( name ), line_items:purchase_order_line_items ( description, qty, unit, unit_price, vat_rate, line_total, sort_order )",
    )
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();

  if (!po) notFound();

  // Supplier bills recorded against this PO (finances entries) — the ACTUAL cost
  // that closes the committed → actual loop.
  type BillRow = {
    id: string;
    amount: number | string | null;
    vat_total: number | string | null;
    reference: string | null;
    bill_date: string | null;
    category: string | null;
    created_at: string;
  };
  const { data: billRows } = await (
    supabase.from("finances" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          order: (k: string, o: { ascending: boolean }) => Promise<{ data: BillRow[] | null }>;
        };
      };
    }
  )
    .select("id, amount, vat_total, reference, bill_date, category, created_at")
    .eq("purchase_order_id", id)
    .order("created_at", { ascending: false });
  const bills = billRows ?? [];
  const billing = computePoBilling({ poTotal: po.total, bills });

  const status = po.status as PurchaseOrderStatus;
  const nextStates = PO_TRANSITIONS[status] ?? [];
  const editable = status === "draft" || status === "sent";
  const lines = [...(po.line_items ?? [])].sort(
    (a, b) => (a as unknown as { sort_order: number }).sort_order - (b as unknown as { sort_order: number }).sort_order,
  );

  const { suppliers, jobs: jobOptions } = editable
    ? await listPoFormOptions(supabase, ctx.org.id)
    : { suppliers: [] as Array<{ id: string; name: string }>, jobs: [] as Array<{ id: string; name: string }> };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/purchase-orders" className="hover:text-slate-900">
          Purchase orders
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">{po.number}</span>
      </div>

      {error ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {ERROR_COPY[error] ?? "Something went wrong."}
        </div>
      ) : null}
      {saved ? (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {saved === "status" ? "Status updated." : "Purchase order saved."}
        </div>
      ) : null}

      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{po.number}</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {po.supplier?.name ?? "No supplier"}
            {po.expected_date ? ` · expected ${po.expected_date}` : ""}
          </p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLE[status] ?? "bg-slate-100 text-slate-600"}`}>
          {poStatusLabel(status)}
        </span>
      </header>

      {/* Status transitions */}
      {nextStates.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {nextStates.map((to) => (
            <form key={to} action={setPurchaseOrderStatus.bind(null, po.id)}>
              <input type="hidden" name="status" value={to} />
              <button
                type="submit"
                className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
                  to === "cancelled"
                    ? "border border-slate-300 text-slate-600 hover:bg-slate-50"
                    : "bg-slate-900 text-white hover:bg-slate-800"
                }`}
              >
                Mark {poStatusLabel(to).toLowerCase()}
              </button>
            </form>
          ))}
        </div>
      ) : null}

      {/* Read-only summary */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="pb-2">Description</th>
              <th className="pb-2 text-right">Qty</th>
              <th className="pb-2 text-right">Unit price</th>
              <th className="pb-2 text-right">VAT</th>
              <th className="pb-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {lines.map((li, i) => (
              <tr key={i}>
                <td className="py-2 text-slate-800">{li.description}</td>
                <td className="py-2 text-right text-slate-600">
                  {li.qty} {li.unit ?? ""}
                </td>
                <td className="py-2 text-right text-slate-600">{GBP.format(li.unit_price)}</td>
                <td className="py-2 text-right text-slate-600">{li.vat_rate}%</td>
                <td className="py-2 text-right font-medium text-slate-900">{GBP.format(Number(li.line_total ?? 0))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="mt-4 space-y-1 border-t border-slate-100 pt-3 text-sm">
          <div className="flex justify-end gap-8">
            <dt className="text-slate-500">Subtotal</dt>
            <dd className="w-24 text-right text-slate-900">{GBP.format(Number(po.subtotal ?? 0))}</dd>
          </div>
          <div className="flex justify-end gap-8">
            <dt className="text-slate-500">VAT</dt>
            <dd className="w-24 text-right text-slate-900">{GBP.format(Number(po.vat_total ?? 0))}</dd>
          </div>
          <div className="flex justify-end gap-8 text-base font-semibold">
            <dt className="text-slate-900">Total</dt>
            <dd className="w-24 text-right text-slate-900">{GBP.format(Number(po.total ?? 0))}</dd>
          </div>
        </dl>
        {po.notes ? <p className="mt-4 whitespace-pre-wrap border-t border-slate-100 pt-3 text-sm text-slate-600">{po.notes}</p> : null}
      </section>

      {/* Supplier bills — committed vs actual */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">Supplier bills</h2>
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${PO_BILL_STATUS_CLASS[billing.status]}`}
          >
            {PO_BILL_STATUS_LABEL[billing.status]}
          </span>
        </div>
        <p className="mt-1 text-sm text-slate-500">
          Record the supplier&apos;s invoice — it posts the actual cost to this job and closes it
          against the order.
        </p>

        <dl className="mt-4 grid grid-cols-3 gap-4">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Committed</dt>
            <dd className="mt-0.5 text-lg font-semibold text-slate-900">{GBP.format(billing.poTotal)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Billed</dt>
            <dd className="mt-0.5 text-lg font-semibold text-slate-900">{GBP.format(billing.billedGross)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Remaining</dt>
            <dd
              className={`mt-0.5 text-lg font-semibold ${billing.remaining < 0 ? "text-red-700" : "text-slate-900"}`}
            >
              {GBP.format(billing.remaining)}
            </dd>
          </div>
        </dl>

        {bills.length > 0 ? (
          <ul className="mt-4 divide-y divide-slate-100 border-t border-slate-100">
            {bills.map((b) => (
              <li key={b.id} className="flex items-center justify-between py-2 text-sm">
                <span className="text-slate-700">
                  {b.reference ?? b.category ?? "Bill"}
                  {b.bill_date ? ` · ${b.bill_date}` : ""}
                </span>
                <span className="font-medium text-slate-900">
                  {GBP.format(Number(b.amount ?? 0) + Number(b.vat_total ?? 0))}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 border-t border-slate-100 pt-3 text-sm text-slate-500">
            No bills recorded yet.
          </p>
        )}

        <RecordBillForm poId={po.id} />
      </section>

      {/* Edit (draft/sent only) */}
      {editable ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-base font-semibold text-slate-900">Edit purchase order</h2>
          <PurchaseOrderBuilder
            action={updatePurchaseOrder.bind(null, po.id)}
            suppliers={suppliers}
            jobs={jobOptions}
            initial={{
              supplier_id: po.supplier_id,
              job_id: po.job_id,
              supplier_reference: po.supplier_reference,
              expected_date: po.expected_date,
              notes: po.notes,
              line_items: lines.map((li) => ({
                description: li.description,
                qty: li.qty,
                unit: li.unit,
                unit_price: li.unit_price,
                vat_rate: li.vat_rate,
              })),
            }}
            submitLabel="Save changes"
          />
        </section>
      ) : null}

      {isAdmin ? (
        <ConfirmForm action={deletePurchaseOrder.bind(null, po.id)} confirm="Delete this purchase order? This can't be undone.">
          <button
            type="submit"
            className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50"
          >
            Delete purchase order
          </button>
        </ConfirmForm>
      ) : null}
    </div>
  );
}

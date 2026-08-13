import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { requireOrgContext } from "@/server/auth/session";
import { poStatusLabel } from "@/lib/purchase-orders/schema";
import { countPostedReceipts } from "./_receiving-data";

const GBP = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2 });

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  sent: "bg-blue-100 text-blue-700",
  partially_received: "bg-amber-100 text-amber-800",
  received: "bg-emerald-100 text-emerald-700",
  cancelled: "bg-slate-100 text-slate-600 line-through", // slate-600, not 400: AA contrast on slate-100
};

type PoRow = {
  id: string;
  number: string;
  status: string;
  total: number | string | null;
  expected_date: string | null;
  supplier: { name: string } | null;
};

// The register's "where is this order up to" line, shared by the desktop table
// cell and the mobile card so the two never drift: a posted-receipt count once
// deliveries exist, otherwise "Awaiting" for a sent order and "—" for the rest.
function deliveriesLabel(po: PoRow, receiptCount: number): string {
  if (receiptCount > 0) return `${receiptCount} received`;
  return po.status === "sent" ? "Awaiting" : "—";
}

export default async function PurchaseOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const { saved } = await searchParams;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  // PAGED (F-1): the register must show EVERY committed order (and its ids feed
  // the delivery-badge count below), so a `.limit(500)` cap silently dropped
  // orders past 500 from the register and from receipt counting. This cast-form
  // read was invisible to the clamp guard until the C66 `;`-windowing de-vacuum.
  // Page on a stable, unique order (created_at desc + id desc).
  type PoQuery = PromiseLike<{ data: PoRow[] | null; error: SupabaseReadError | null }> & {
    select: (c: string) => PoQuery;
    eq: (k: string, v: unknown) => PoQuery;
    order: (k: string, o: { ascending: boolean }) => PoQuery;
    range: (from: number, to: number) => PoQuery;
  };
  const { data, error } = await fetchAllRows<PoRow>((from, to) =>
    (supabase.from("purchase_orders" as never) as unknown as { select: (c: string) => PoQuery })
      .select("id, number, status, total, expected_date, supplier:suppliers ( name )")
      // ACTIVE-org pin — the PO register must show one company's orders. The
      // builder behind /purchase-orders/new was pinned in #463; the register
      // itself was not.
      .eq("org_id", ctx.org.id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to),
  );
  if (error) throw readFailure("purchase orders: register", error);

  const rows = data ?? [];

  // Receipt badges (Warehouse M1). ONE extra query for the whole page — the
  // register's job is "where is each order up to", and "sent" alone no longer
  // answers that once part deliveries exist.
  const receiptCounts = await countPostedReceipts(
    supabase,
    ctx.org.id,
    rows.map((r) => r.id),
  );

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Purchase orders</h1>
          <p className="mt-0.5 text-sm text-slate-500">Committed spend with your suppliers.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* The register says where each order is up to; matching says where the
              order, the deliveries and the supplier's invoices disagree. No count
              badge here on purpose: the badge would cost this page the whole
              matching read, and a count that failed to load would be worse than
              no count — the dashboard briefing carries the proactive number. */}
          <Link
            href="/purchase-orders/matching"
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Bill matching
          </Link>
          <Link
            href="/purchase-orders/new"
            className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            + New PO
          </Link>
        </div>
      </div>

      {saved === "deleted" ? (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Purchase order deleted.
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="text-sm text-slate-500">No purchase orders yet.</p>
          <Link href="/purchase-orders/new" className="mt-2 inline-block text-sm font-semibold text-slate-900 underline">
            Raise your first PO
          </Link>
        </div>
      ) : (
        <>
          {/* Desktop table. `overflow-x-auto` (not `overflow-hidden`) so a wide
              row scrolls sideways within its own box rather than clipping the
              right-aligned Total — mirrors jobs/quotes/invoices. */}
          <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm md:block">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2.5">Number</th>
                  <th className="px-4 py-2.5">Supplier</th>
                  <th className="px-4 py-2.5">Expected</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Deliveries</th>
                  <th className="px-4 py-2.5 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((po) => (
                  <tr key={po.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5">
                      <Link href={`/purchase-orders/${po.id}`} className="font-medium text-slate-900 hover:underline">
                        {po.number}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">{po.supplier?.name ?? "—"}</td>
                    <td className="px-4 py-2.5 text-slate-600">{po.expected_date ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[po.status] ?? "bg-slate-100 text-slate-600"}`}>
                        {poStatusLabel(po.status)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">{deliveriesLabel(po, receiptCounts.get(po.id) ?? 0)}</td>
                    <td className="px-4 py-2.5 text-right font-medium text-slate-900">{GBP.format(Number(po.total ?? 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards — the register on a phone. Same data, links and
              formatting as the table; nothing clips because the Total lives on
              its own line, not in a right-aligned column. */}
          <ul className="space-y-2 md:hidden">
            {rows.map((po) => (
              <li key={po.id}>
                <Link
                  href={`/purchase-orders/${po.id}`}
                  className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition active:bg-slate-50"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-slate-900">{po.number}</div>
                      <div className="mt-0.5 truncate text-xs text-slate-500">
                        {po.supplier?.name ?? "—"}
                        {po.expected_date ? ` · expected ${po.expected_date}` : ""}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">{deliveriesLabel(po, receiptCounts.get(po.id) ?? 0)}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm font-semibold text-slate-900">{GBP.format(Number(po.total ?? 0))}</div>
                      <span
                        className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[po.status] ?? "bg-slate-100 text-slate-600"}`}
                      >
                        {poStatusLabel(po.status)}
                      </span>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

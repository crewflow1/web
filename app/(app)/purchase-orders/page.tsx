import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
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

export default async function PurchaseOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const { saved } = await searchParams;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const { data } = await (
    supabase.from("purchase_orders" as never) as unknown as {
      select: (c: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          order: (
            k: string,
            o: { ascending: boolean },
          ) => { limit: (n: number) => Promise<{ data: PoRow[] | null }> };
        };
      };
    }
  )
    .select("id, number, status, total, expected_date, supplier:suppliers ( name )")
    // ACTIVE-org pin — the PO register must show one company's orders. The
    // builder behind /purchase-orders/new was pinned in #463; the register
    // itself was not.
    .eq("org_id", ctx.org.id)
    .order("created_at", { ascending: false })
    .limit(500); // bound the list like /assets (1000) and /site-reports (500)

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
        <Link
          href="/purchase-orders/new"
          className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          + New PO
        </Link>
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
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
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
                  <td className="px-4 py-2.5 text-xs text-slate-500">
                    {(() => {
                      const n = receiptCounts.get(po.id) ?? 0;
                      if (n > 0) return `${n} received`;
                      return po.status === "sent" ? "Awaiting" : "—";
                    })()}
                  </td>
                  <td className="px-4 py-2.5 text-right font-medium text-slate-900">{GBP.format(Number(po.total ?? 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

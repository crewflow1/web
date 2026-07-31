import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { formatGbp } from "@/lib/money";
import { loadPoMatchingQueue, type PoMatchingClient } from "@/server/services/po-matching";
import {
  describeFinding,
  MATCH_STATE_CLASS,
  MATCH_STATE_LABEL,
} from "@/lib/purchase-orders/matching";
// Same quantity formatter the order page uses, so 12.5 m³ reads identically on both.
import { formatQty } from "@/lib/purchase-orders/receiving";
import { poStatusLabel } from "@/lib/purchase-orders/schema";
import { EmptyState } from "../../_components/empty-state";

export const dynamic = "force-dynamic";

export const metadata = { title: "Bill matching · CrewFlow" };

/**
 * /purchase-orders/matching — the supplier-bill discrepancy queue.
 *
 * Sits INSIDE the purchase-orders area and reuses the register's layout (the
 * same bordered card, the same table treatment, the same status pills) because
 * it answers the register's next question: the register says where each order is
 * up to, this says where the paperwork disagrees with itself.
 *
 * ORG-PINNED: every read goes through server/services/po-matching.ts, which
 * carries `.eq("org_id", ctx.org.id)` on top of RLS. `current_org_ids()` admits
 * every org the viewer belongs to, so without the pin a dual-org member would
 * get one queue blending two companies' orders, deliveries and supplier bills —
 * and one company's delivery matched against the other's invoice would invent a
 * variance that does not exist while hiding one that does.
 *
 * LOUD: `loadPoMatchingQueue` throws on any read failure, so a rejected query
 * renders the route-group error boundary. "No discrepancies" must never be what
 * a broken query looks like — on this page that sentence is the whole product.
 *
 * READ-ONLY: there is no form, no action and no button that writes. The queue
 * tells a human; a human rings the supplier. Nothing is posted, credited or
 * adjusted, because the actual cost lands exactly once — when the supplier's
 * bill is recorded.
 *
 * NO TOLERANCE: every variance is listed with its exact size, including a penny.
 * What counts as worth chasing is a CEO decision that has not been taken, and
 * this page will not take it by hiding rows.
 */

export default async function PurchaseOrderMatchingPage() {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const queue = await loadPoMatchingQueue(supabase as unknown as PoMatchingClient, ctx.org.id);
  const { discrepancies, totals } = queue;

  // THREE FIGURES UNDER THREE LABELS, never a total. `overBilled` and
  // `billedNotReceived` are frequently the same pounds seen from two angles (an
  // order invoiced £120 above a fully delivered order reads £120 under both), so
  // a "total variance" tile here would be a number that does not exist. The
  // double-count-free exposure is `totals.moneyOutAtRisk`, stated once in its own
  // sentence below — and it is what the dashboard briefing line reports.
  const tiles: Array<{ label: string; value: string; hint: string; tone: string }> = [
    {
      label: "Over-billed",
      value: formatGbp(totals.overBilled),
      hint: "Invoiced above what the order commits",
      tone: totals.overBilled > 0 ? "text-red-700" : "text-slate-900",
    },
    {
      label: "Billed, not received",
      value: formatGbp(totals.billedNotReceived),
      hint: "Invoiced for goods with no delivery recorded",
      tone: totals.billedNotReceived > 0 ? "text-orange-700" : "text-slate-900",
    },
    {
      label: "Received, not billed",
      value: formatGbp(totals.receivedNotBilled),
      hint: "Goods on site with no bill — cost missing from the job",
      tone: totals.receivedNotBilled > 0 ? "text-amber-700" : "text-slate-900",
    },
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Link href="/purchase-orders" className="hover:text-slate-900">
              Purchase orders
            </Link>
            <span aria-hidden>/</span>
            <span className="text-slate-900">Bill matching</span>
          </div>
          <h1 className="mt-1 text-2xl font-bold text-slate-900">Bill matching</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Ordered vs delivered vs invoiced, on every order. {queue.examined}{" "}
            {queue.examined === 1 ? "order" : "orders"} checked.
          </p>
        </div>
        <Link
          href="/purchase-orders"
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          All orders
        </Link>
      </div>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <dt className="text-xs uppercase tracking-wide text-slate-500">{t.label}</dt>
            <dd className={`mt-1 text-xl font-semibold tabular-nums ${t.tone}`}>{t.value}</dd>
            <p className="mt-1 text-xs text-slate-500">{t.hint}</p>
          </div>
        ))}
      </dl>

      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
        {totals.moneyOutAtRisk > 0 ? (
          <p className="mb-1.5 font-semibold text-slate-900">
            {formatGbp(totals.moneyOutAtRisk)} has been invoiced that these orders don&rsquo;t
            justify.
          </p>
        ) : null}
        <p>
          Every difference is listed with its exact size, down to the penny — nothing is filtered
          out as &ldquo;close enough&rdquo;. Voided deliveries do not count as received. The first
          two figures above often describe the same pounds from two angles, so don&rsquo;t add them
          up. Nothing on this page changes a bill, an order or a cost: it is here so you can ring
          the supplier.
        </p>
      </div>

      {discrepancies.length === 0 ? (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="✓"
            title="Ordered, delivered and invoiced all agree"
            body={
              queue.examined === 0
                ? "There are no purchase orders to check yet. Raise one and record the delivery and the supplier's bill against it."
                : `All ${queue.examined} ${queue.examined === 1 ? "order" : "orders"} match: nothing invoiced above the order, nothing invoiced without a delivery, and no delivery sitting unbilled.`
            }
            primary={{ href: "/purchase-orders", label: "Purchase orders" }}
          />
        </div>
      ) : (
        <ul className="space-y-3">
          {discrepancies.map((row) => {
            const m = row.match;
            return (
              <li
                key={row.id}
                className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-4 py-3">
                  <div className="min-w-0">
                    <Link
                      href={`/purchase-orders/${row.id}`}
                      className="font-semibold text-slate-900 hover:underline"
                    >
                      {row.number}
                    </Link>
                    <p className="mt-0.5 truncate text-xs text-slate-500">
                      {row.supplierName ?? "No supplier"} · {poStatusLabel(row.status)}
                      {row.expectedDate ? ` · expected ${row.expectedDate}` : ""}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${MATCH_STATE_CLASS[m.state]}`}
                  >
                    {MATCH_STATE_LABEL[m.state]}
                  </span>
                </div>

                {/* The three legs — the comparison this page exists for.
                    ONE COLUMN AT 375px, three from sm:. Three money columns on a
                    phone would be ~98px each, which a six-figure variance
                    overflows; stacked label-left/value-right the rows sit
                    directly under one another and still read as a comparison,
                    and no figure can push the page sideways. */}
                <dl className="grid grid-cols-1 gap-1.5 px-4 py-3 sm:grid-cols-3 sm:gap-4 sm:text-center">
                  <div className="flex items-baseline justify-between gap-2 sm:block">
                    <dt className="text-[11px] uppercase tracking-wide text-slate-500">Ordered</dt>
                    <dd className="font-semibold tabular-nums text-slate-900 sm:mt-0.5 sm:text-sm">
                      {formatGbp(m.ordered.gross)}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-2 sm:block">
                    <dt className="text-[11px] uppercase tracking-wide text-slate-500">
                      Delivered
                      <span className="ml-1 normal-case tracking-normal sm:hidden">
                        ({m.postedGrnCount} posted
                        {m.voidedGrnCount > 0 ? `, ${m.voidedGrnCount} voided` : ""})
                      </span>
                    </dt>
                    <dd className="font-semibold tabular-nums text-slate-900 sm:mt-0.5 sm:text-sm">
                      {formatGbp(m.received.gross)}
                    </dd>
                    <p className="hidden text-[11px] text-slate-500 sm:block">
                      {m.postedGrnCount} posted
                      {m.voidedGrnCount > 0 ? `, ${m.voidedGrnCount} voided` : ""}
                    </p>
                  </div>
                  <div className="flex items-baseline justify-between gap-2 sm:block">
                    <dt className="text-[11px] uppercase tracking-wide text-slate-500">
                      Invoiced
                      <span className="ml-1 normal-case tracking-normal sm:hidden">
                        ({m.billCount} {m.billCount === 1 ? "bill" : "bills"})
                      </span>
                    </dt>
                    <dd className="font-semibold tabular-nums text-slate-900 sm:mt-0.5 sm:text-sm">
                      {formatGbp(m.billed.gross)}
                    </dd>
                    <p className="hidden text-[11px] text-slate-500 sm:block">
                      {m.billCount} {m.billCount === 1 ? "bill" : "bills"}
                    </p>
                  </div>
                  {/* A `dl` may only contain dt/dd/div, so the note is wrapped. */}
                  {row.status === "cancelled" ? (
                    <div className="text-[11px] text-slate-500 sm:col-span-3 sm:text-center">
                      This order was cancelled, so it commits nothing — anything invoiced against it
                      is over-billed by its whole value.
                    </div>
                  ) : null}
                </dl>

                <ul className="space-y-2 border-t border-slate-100 px-4 py-3">
                  {m.findings.map((f) => (
                    <li key={f.kind} className="text-sm">
                      <p className="font-medium text-slate-900">
                        {MATCH_STATE_LABEL[f.kind]} · {formatGbp(f.gross)}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-600">
                        {describeFinding(f, formatGbp)}
                        {f.qty != null ? ` ${formatQty(f.qty)} units.` : ""}
                        {f.kind === "received_not_billed" && m.earliestPostedReceiptDate
                          ? ` Earliest delivery ${m.earliestPostedReceiptDate}.`
                          : ""}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        Net of VAT {formatGbp(f.net)}.
                      </p>
                    </li>
                  ))}
                </ul>

                {/* Links to the evidence: the order, each delivery note, each bill. */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-slate-100 bg-slate-50 px-4 py-2.5 text-xs">
                  <Link
                    href={`/purchase-orders/${row.id}`}
                    className="font-semibold text-slate-700 underline hover:text-slate-900"
                  >
                    Open order
                  </Link>
                  {row.jobId ? (
                    <Link href={`/jobs/${row.jobId}`} className="text-slate-600 underline hover:text-slate-900">
                      Job
                    </Link>
                  ) : null}
                  {row.grns.length > 0 ? (
                    <span className="text-slate-500">
                      Deliveries:{" "}
                      {row.grns.map((g, i) => (
                        <span key={g.id}>
                          {i > 0 ? ", " : ""}
                          <Link
                            href={`/purchase-orders/${row.id}?grn=${g.id}#grn-${g.id}`}
                            className={`underline hover:text-slate-900 ${
                              g.status === "posted" ? "text-slate-700" : "text-slate-400 line-through"
                            }`}
                          >
                            {g.number}
                          </Link>
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="text-slate-500">No deliveries recorded</span>
                  )}
                  {row.bills.length > 0 ? (
                    <span className="text-slate-500">
                      Bills:{" "}
                      {row.bills.map((b, i) => (
                        <span key={b.id} className="text-slate-700">
                          {i > 0 ? ", " : ""}
                          {b.reference ?? "no ref"} {formatGbp(b.gross)}
                          {b.billDate ? ` (${b.billDate})` : ""}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="text-slate-500">No bill recorded</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Supplier bills that reference no order at all — unmatchable by construction. */}
      {queue.unlinkedBillCount > 0 ? (
        <section
          aria-labelledby="unlinked-heading"
          className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
        >
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 id="unlinked-heading" className="text-base font-semibold text-slate-900">
              {queue.unlinkedBillCount} supplier{" "}
              {queue.unlinkedBillCount === 1 ? "bill isn't" : "bills aren't"} linked to an order
            </h2>
            <p className="mt-0.5 text-xs text-slate-600">
              {formatGbp(queue.unlinkedBillTotal)} of supplier cost with no purchase order behind it,
              so there is nothing to match it against. Not necessarily wrong — an ad-hoc buy is
              legitimate — but nobody agreed a price for it up front.
            </p>
          </div>
          <ul className="divide-y divide-slate-100">
            {queue.unlinkedBills.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <span className="min-w-0 truncate text-slate-700">
                  {b.reference ?? "No reference"}
                  {b.billDate ? ` · ${b.billDate}` : ""}
                </span>
                <span className="shrink-0 font-medium tabular-nums text-slate-900">
                  {formatGbp(b.gross)}
                </span>
              </li>
            ))}
          </ul>
          {queue.unlinkedBillCount > queue.unlinkedBills.length ? (
            <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
              Showing the {queue.unlinkedBills.length} largest of {queue.unlinkedBillCount}.{" "}
              <Link href="/finances" className="underline hover:text-slate-900">
                See all costs
              </Link>
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { loadSupplierForOrg, type SuppliersClient } from "@/server/services/suppliers";
import {
  getSupplierPerformance,
  type PerformanceClient,
} from "@/server/services/supplier-performance";
import { getCisProfile } from "@/server/services/cis";
import { listDeliveryRecords } from "@/lib/suppliers/performance";
import { CIS_STATUS_LABELS } from "@/lib/cis/types";
import { verificationFreshness } from "@/lib/cis/verification";
import { Badge } from "@/components/ui";
import {
  DeliveryEvidence,
  DeliverySection,
  HowMeasured,
  NotMeasuredSection,
  PriceSection,
  SettlementSection,
} from "../../_performance-sections";

export const dynamic = "force-dynamic";

export const metadata = { title: "Supplier performance · CrewFlow" };

/**
 * /suppliers/[id]/performance — one supplier's MEASURED record.
 *
 * docs/roadmap/STATUS.md Phase 9 requires this to ship as deterministic metrics
 * and never as prediction, so there is no score, no grade and no forecast on
 * this page — only counts of things that happened, each with the sample it was
 * counted over, and a table of the individual records underneath so any figure
 * can be checked against the paperwork.
 *
 * READ-ONLY. No form, no action, no mutation: measuring a supplier must not be
 * able to change the supplier.
 *
 * ORG-PINNED via loadSupplierForOrg + getSupplierPerformance. Both matter and
 * for different reasons. The first makes another company's supplier
 * indistinguishable from a missing one (RLS alone would happily render it inside
 * this org's shell). The second is what stops the FIGURES blending: merchants
 * are shared between an owner's two companies, so an unpinned read would
 * compute one delivery record out of two companies' trading history and the
 * operator would buy for company A on company B's evidence.
 *
 * The settlement block is admin-only because `supplier_payments` is admin-only
 * at the RLS layer — a non-admin reads an empty payment set without an error, so
 * the section is gated on the ROLE rather than on whether rows came back, or it
 * would render "we always pay instantly" to a foreman.
 */

type SupplierRow = { id: string; name: string; category: string | null };

export default async function SupplierPerformancePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const supplier = await loadSupplierForOrg<SupplierRow>(
    supabase as unknown as SuppliersClient,
    ctx.org.id,
    id,
    "id, name, category",
  );
  if (!supplier) notFound();

  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";

  const [{ performance, sources }, cis] = await Promise.all([
    getSupplierPerformance(
      supabase as unknown as PerformanceClient,
      ctx.org.id,
      id,
      supplier.name,
    ),
    isAdmin ? getCisProfile(ctx.org.id, id) : Promise.resolve(null),
  ]);

  const records = listDeliveryRecords({
    purchaseOrders: sources.purchaseOrders,
    grns: sources.grns,
  });

  const freshness = cis
    ? verificationFreshness(
        {
          cis_status: cis.cis_status,
          verified_at: cis.verified_at,
          verification_expires_at: cis.verification_expires_at,
        },
        new Date().toISOString().slice(0, 10),
      )
    : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
        <Link href="/suppliers" className="hover:text-slate-900">
          Suppliers
        </Link>
        <span aria-hidden>/</span>
        <Link href={`/suppliers/${id}`} className="hover:text-slate-900">
          {supplier.name}
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Performance</span>
      </div>

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-900">Performance</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            What {supplier.name} has actually done on your orders &mdash; counted, not scored. Every
            figure is a count of records you can open, and no percentage is shown until there are
            enough of them to mean anything.
          </p>
        </div>
        <Link
          href="/suppliers/compare"
          className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Compare suppliers
        </Link>
      </header>

      <HowMeasured />

      {performance.empty ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">No trading record yet</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-600">
            There are no posted deliveries and no bills recorded against{" "}
            {supplier.name} in this company, so there is nothing to measure. This is not a clean
            record &mdash; it is an empty one.
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/purchase-orders/new"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Raise a purchase order
            </Link>
            <Link
              href={`/suppliers/${id}`}
              className="text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              Back to supplier
            </Link>
          </div>
        </section>
      ) : (
        <>
          {cis ? (
            <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-slate-900">
                    Subcontractor standing
                  </h2>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <Badge
                      tone={
                        freshness === "current"
                          ? "emerald"
                          : freshness === "expiring_soon"
                            ? "amber"
                            : "red"
                      }
                    >
                      {CIS_STATUS_LABELS[cis.cis_status]}
                    </Badge>
                    <span>
                      {cis.deduction_rate != null
                        ? `${Number(cis.deduction_rate)}% CIS deduction`
                        : "No lawful deduction rate until verified"}
                    </span>
                  </p>
                </div>
                <Link
                  href={`/suppliers/${id}/cis`}
                  className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Manage CIS
                </Link>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Verification status is the HMRC record, not a performance judgement &mdash; it is
                shown here because it gates whether you may pay them at all.
              </p>
            </section>
          ) : null}

          <DeliverySection d={performance.delivery} ordersHref="/purchase-orders" />

          <PriceSection p={performance.price} billsHref="/expenses" />

          {isAdmin ? <SettlementSection s={performance.settlement} /> : null}

          <DeliveryEvidence records={records} />

          <NotMeasuredSection />
        </>
      )}
    </div>
  );
}

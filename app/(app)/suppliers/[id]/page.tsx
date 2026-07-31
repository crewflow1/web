import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { SupplierForm } from "../_form";
import { updateSupplier, deleteSupplier } from "../actions";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { getCisProfile } from "@/server/services/cis";
import { CIS_STATUS_LABELS } from "@/lib/cis/types";
import { verificationFreshness } from "@/lib/cis/verification";
import { getSupplierLedger } from "@/server/services/supplier-payments";
import { loadSupplierForOrg, type SuppliersClient } from "@/server/services/suppliers";
import {
  getSupplierPerformance,
  type PerformanceClient,
} from "@/server/services/supplier-performance";
import { formatRate, isRated } from "@/lib/suppliers/performance";
import { formatGbp } from "@/lib/money";
import {
  BILL_SETTLEMENT_STATUS_CLASS,
  BILL_SETTLEMENT_STATUS_LABEL,
} from "@/lib/suppliers/payments";

type SupplierRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  category: string | null;
  notes: string | null;
};

const ERROR_MAP: Record<string, string> = {
  // A supplier you have PAID can no longer be deleted: supplier_payments holds a
  // NO ACTION FK to it (20261047000000), because a cash/tax record must outlive
  // the address-book entry it points at.
  delete_failed:
    "Couldn't delete the supplier. If you've recorded payments to them, the payment " +
    "history has to keep pointing somewhere — void the payments' purpose in your notes " +
    "rather than removing the supplier.",
  bad_id: "Invalid supplier id.",
  // The DELETE matched no row. In practice that means the caller is not an
  // owner/admin of this org — `suppliers_delete` is `is_org_admin(org_id)`.
  // (A supplier belonging to another org never reaches this page at all: the
  // load above is active-org scoped and notFound()s first.)
  delete_denied: "Only an owner or admin can delete a supplier.",
};

type SP = Promise<{ error?: string }>;

export default async function SupplierDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SP;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  // Active-org scoped. A supplier belonging to another org the viewer also
  // belongs to must be indistinguishable from one that does not exist — RLS
  // would happily return it, and the edit/delete forms below would then be
  // bound to a row this org has no business writing.
  const supplier = await loadSupplierForOrg<SupplierRow>(
    supabase as unknown as SuppliersClient,
    ctx.org.id,
    id,
    "id, name, email, phone, category, notes",
  );

  if (!supplier) notFound();

  // Bills + (for admins) the money-out ledger, in one composed read. This
  // REPLACES a direct `finances` select that asked for a `description` column
  // this schema has never had — PostgREST rejected it, so the section silently
  // rendered "no expenses linked yet" for every supplier that had some.
  //
  // The ledger half is admin-only at the RLS layer: a non-admin gets the bills
  // and an EMPTY payment set, which is why the money tiles below are gated on
  // the role rather than on whether any payments came back.
  // The money ledger and the MEASURED record are independent reads, so they go
  // in parallel — the performance record is six queries and running it after the
  // ledger would double this page's time to first byte for no reason.
  const [ledger, { performance }] = await Promise.all([
    getSupplierLedger(ctx.org.id, id),
    getSupplierPerformance(
      supabase as unknown as PerformanceClient,
      ctx.org.id,
      id,
      supplier.name,
    ),
  ]);

  const errorMessage = sp.error ? ERROR_MAP[sp.error] ?? null : null;

  // CIS lives behind admin-only RLS, so only owners/admins get the panel at all
  // — a non-admin's read would return null and the link would lead to a refusal.
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  const cis = isAdmin ? await getCisProfile(ctx.org.id, id) : null;
  const cisStale =
    cis != null &&
    ["none", "expired"].includes(
      verificationFreshness(
        {
          cis_status: cis.cis_status,
          verified_at: cis.verified_at,
          verification_expires_at: cis.verification_expires_at,
        },
        new Date().toISOString().slice(0, 10),
      ),
    );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/suppliers" className="hover:text-slate-900">
          Suppliers
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">{supplier.name}</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">{supplier.name}</h1>
        {supplier.category ? (
          <p className="mt-1 text-sm text-slate-600">{supplier.category}</p>
        ) : null}
      </header>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}

      <section>
        <h2 className="mb-3 text-base font-semibold text-slate-900">Edit supplier</h2>
        <SupplierForm
          action={updateSupplier.bind(null, id)}
          submitLabel="Save changes"
          cancelHref="/suppliers"
          defaults={{
            name: supplier.name,
            email: supplier.email ?? "",
            phone: supplier.phone ?? "",
            category: supplier.category ?? "",
            notes: supplier.notes ?? "",
          }}
        />
      </section>

      {isAdmin ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                CIS subcontractor
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                {cis
                  ? `${CIS_STATUS_LABELS[cis.cis_status]}${
                      cis.deduction_rate != null
                        ? ` — ${Number(cis.deduction_rate)}% deduction`
                        : ""
                    }`
                  : "Not set up. Add CIS details if you pay this supplier for construction work."}
              </p>
              {cisStale ? (
                <p className="mt-1 text-xs font-medium text-red-700">
                  Verification needed before the next payment.
                </p>
              ) : null}
            </div>
            <Link
              href={`/suppliers/${id}/cis`}
              className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              {cis ? "Manage CIS" : "Set up CIS"}
            </Link>
          </div>
        </section>
      ) : null}

      {isAdmin ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900">Money out</h2>
            <Link
              href={`/suppliers/${id}/payments`}
              className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Record payment
            </Link>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            {[
              { k: "Billed", v: formatGbp(ledger.position.billedGross), h: "inc VAT" },
              { k: "Paid", v: formatGbp(ledger.position.grossPaid), h: "settled" },
              { k: "Outstanding", v: formatGbp(ledger.position.outstanding), h: "still owed" },
              {
                k: "CIS withheld",
                v: formatGbp(ledger.position.cisWithheld),
                h: "held for HMRC",
              },
              { k: "Net cash paid", v: formatGbp(ledger.position.netCash), h: "left the bank" },
              {
                k: "Cost (ex VAT)",
                v: formatGbp(ledger.position.billedNet),
                h: "unchanged by CIS",
              },
            ].map((t) => (
              <div key={t.k}>
                <dt className="text-xs font-medium text-slate-500">{t.k}</dt>
                <dd className="text-base font-semibold tabular-nums text-slate-900">{t.v}</dd>
                <dd className="text-[11px] leading-tight text-slate-500">{t.h}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {/*
        MEASURED record — counts of what actually happened, never a score.
        Deliberately no tone/colour on any figure: a red "late" number would need
        a threshold at which lateness becomes bad, and inventing that threshold is
        the grading docs/roadmap/STATUS.md Phase 9 rules out. `formatRate`
        degrades to "1 of 2 — too few to rate" on its own, so this panel cannot
        print a percentage the sample has not earned.
      */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-900">Performance</h2>
            <p className="mt-1 max-w-md text-xs text-slate-500">
              Counted from your own orders, deliveries and bills. No score, no forecast.
            </p>
          </div>
          <Link
            href={`/suppliers/${id}/performance`}
            className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Full record
          </Link>
        </div>

        {performance.empty ? (
          <p className="mt-3 text-sm text-slate-500">
            No posted deliveries and no bills recorded against this supplier yet. That is an empty
            record, not a clean one.
          </p>
        ) : (
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            {[
              {
                k: "Deliveries",
                v: String(performance.delivery.deliveries),
                h: "posted notes",
              },
              {
                k: "Late",
                v: isRated(performance.delivery.punctuality)
                  ? `${performance.delivery.punctuality.pct}%`
                  : formatRate(performance.delivery.punctuality),
                h: `of ${performance.delivery.punctuality.n} with an expected date`,
              },
              {
                k: "Invoiced over order",
                v: isRated(performance.price.overBilled)
                  ? `${performance.price.overBilled.pct}%`
                  : formatRate(performance.price.overBilled),
                h: `of ${performance.price.overBilled.n} billed orders`,
              },
            ].map((t) => (
              <div key={t.k}>
                <dt className="text-xs font-medium text-slate-500">{t.k}</dt>
                <dd className="text-base font-semibold tabular-nums text-slate-900">{t.v}</dd>
                <dd className="text-[11px] leading-tight text-slate-500">{t.h}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">
          Bills ({ledger.bills.length})
        </h2>
        {ledger.bills.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">
            No bills linked yet. Approve a draft on{" "}
            <Link href="/expenses" className="font-medium text-slate-900 underline">
              Expenses
            </Link>{" "}
            to attach one.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100">
            {ledger.settlements.slice(0, 20).map((s) => {
              const bill = ledger.bills.find((b) => b.id === s.billId);
              return (
                <li key={s.billId} className="flex items-center gap-2 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-slate-700">
                    {bill?.reference?.trim() || bill?.category?.trim() || "Bill"}
                  </span>
                  {isAdmin ? (
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${BILL_SETTLEMENT_STATUS_CLASS[s.status]}`}
                    >
                      {BILL_SETTLEMENT_STATUS_LABEL[s.status]}
                    </span>
                  ) : null}
                  <span className="shrink-0 tabular-nums text-slate-500">
                    {formatGbp(s.gross)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <AttachmentsPanel targetTable="suppliers" targetId={id} />

      <form
        action={deleteSupplier.bind(null, id)}
        className="rounded-xl border border-red-200 bg-red-50/50 p-4"
      >
        <p className="text-sm font-medium text-red-900">Delete this supplier</p>
        <p className="mt-1 text-xs text-red-700">
          Linked expenses lose their supplier reference but otherwise stay put. A supplier you
          have recorded payments to can&apos;t be deleted — the cash and CIS record has to keep
          pointing at them.
        </p>
        <button
          type="submit"
          className="mt-3 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
        >
          Delete supplier
        </button>
      </form>
    </div>
  );
}

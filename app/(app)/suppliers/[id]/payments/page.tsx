import Link from "next/link";
import { notFound } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { getSupplierLedger } from "@/server/services/supplier-payments";
import { getCisProfile } from "@/server/services/cis";
import { loadSupplierForOrg, type SuppliersClient } from "@/server/services/suppliers";
import { formatGbp } from "@/lib/money";
import {
  BILL_SETTLEMENT_STATUS_CLASS,
  BILL_SETTLEMENT_STATUS_LABEL,
  SUPPLIER_PAYMENT_METHOD_LABEL,
  isSupplierPaymentMethod,
} from "@/lib/suppliers/payments";
import { NO_PRIOR, resolveCisRate } from "@/lib/cis/deduction";
import { cisTaxMonthLabel } from "@/lib/cis/tax-month";
import {
  billBasisMap,
  getBillCisDetails,
  getCisAllocations,
  getCisPaymentSnapshots,
  priorSettlementByBill,
} from "@/server/services/cis-deduction";
import {
  BillCisDetailsForm,
  RecordCisPaymentForm,
  RecordSupplierPaymentForm,
  VoidPaymentForm,
  type BillCisRow,
  type PayableBill,
} from "./_forms";
import { recordCisPaymentAction, recordPayment, saveBillDetails, voidPayment } from "./actions";

/**
 * Supplier payments — the money-OUT surface (H2-CIS M2).
 *
 * ADMIN ONLY. Non-admins get a plain refusal rather than an empty ledger:
 * `supplier_payments` RLS returns them nothing, so rendering the form would
 * silently fail on submit. Same treatment as the CIS page.
 *
 * THE THING THIS PAGE MUST NOT IMPLY: that withholding CIS saved you money. The
 * summary therefore shows cost (ex-VAT) as its own figure, separate from cash,
 * and says in plain English that the deduction is HMRC's. A screen that showed
 * only "cash out" would quietly teach an owner to under-price their next job.
 */

type SupplierRow = { id: string; name: string };

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "amber" | "default";
}) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-200 bg-white p-3">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p
        className={`mt-0.5 truncate text-lg font-bold tabular-nums ${
          tone === "amber" ? "text-amber-800" : "text-slate-900"
        }`}
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-[11px] leading-tight text-slate-500">{hint}</p> : null}
    </div>
  );
}

export default async function SupplierPaymentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  // Active-org scoped. Everything below (the ledger, the CIS profile, the
  // record-payment forms) is already read and written with ctx.org.id; an
  // unscoped supplier read was the one seam that let another org's supplier
  // name head this org's money-out page.
  const supplier = await loadSupplierForOrg<SupplierRow>(
    supabase as unknown as SuppliersClient,
    ctx.org.id,
    id,
    "id, name",
  );

  if (!supplier) notFound();

  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";

  const crumb = (
    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
      <Link href="/suppliers" className="hover:text-slate-900">
        Suppliers
      </Link>
      <span aria-hidden>/</span>
      <Link href={`/suppliers/${id}`} className="hover:text-slate-900">
        {supplier.name}
      </Link>
      <span aria-hidden>/</span>
      <span className="text-slate-900">Payments</span>
    </div>
  );

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        {crumb}
        <h1 className="text-2xl font-bold text-slate-900">Supplier payments</h1>
        <div
          role="alert"
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          Only an owner or admin can see or record supplier payments. They set what left the
          bank and what tax was withheld, so they are kept off the general supplier record.
        </div>
      </div>
    );
  }

  const [ledger, cis] = await Promise.all([
    getSupplierLedger(ctx.org.id, id),
    getCisProfile(ctx.org.id, id),
  ]);
  const { position, settlements, payments } = ledger;

  const billById = new Map(ledger.bills.map((b) => [b.id, b]));
  const payableBills: PayableBill[] = settlements
    .filter((s) => s.outstanding > 0)
    .map((s) => {
      const bill = billById.get(s.billId);
      return {
        id: s.billId,
        label: bill?.reference?.trim()
          ? bill.reference.trim()
          : `${bill?.category?.trim() || "Bill"} · ${formatGbp(s.gross)}`,
        gross: s.gross,
        outstanding: s.outstanding,
        billDate: bill?.bill_date ?? null,
      };
    });

  const allocByPayment = new Map<string, number>();
  for (const a of ledger.allocations) {
    allocByPayment.set(a.payment_id, (allocByPayment.get(a.payment_id) ?? 0) + Number(a.amount ?? 0));
  }

  // ── H2-CIS M3 ────────────────────────────────────────────────────────────
  // The deduction surface only appears for an actual CIS subcontractor with a
  // usable rate. `resolveCisRate` refuses a pre-outcome status outright rather
  // than defaulting to 20% or 30% — guessing files a wrong return, so the page
  // shows the reason instead of a form. Non-CIS suppliers keep the M2 form.
  const rateAuthority = resolveCisRate(
    cis
      ? {
          cis_status: cis.cis_status,
          deduction_rate: cis.deduction_rate,
          verified_at: cis.verified_at,
          verification_expires_at: cis.verification_expires_at,
        }
      : null,
    // As of today: a lapsed HMRC verification is refused up front (the form is
    // replaced by the re-verify reason) rather than posted at a stale rate. The
    // database gate in 20261175000000 is the backstop.
    todayIso(),
  );

  const livePaymentIds = payments.filter((p) => !p.voided_at).map((p) => p.id);
  const [cisDetails, cisSnapshots, cisAllocations] = cis
    ? await Promise.all([
        getBillCisDetails(ctx.org.id, id),
        getCisPaymentSnapshots(ctx.org.id, id),
        getCisAllocations(ctx.org.id, livePaymentIds),
      ])
    : [new Map(), new Map(), []];

  // A bill is LOCKED once a live CIS allocation names it — matching the database
  // freeze exactly, so the UI never offers an edit the DB will refuse.
  const lockedBills = new Set(
    cisAllocations.filter((a) => a.cis_deduction != null).map((a) => a.finance_id),
  );

  const basisByBill = billBasisMap(ledger.bills, cisDetails);
  const settlementById = new Map(settlements.map((s) => [s.billId, s]));
  // Live-only: a voided payment settles nothing and deducted nothing, so it must
  // not appear in the priors the cumulative method works from. `cisAllocations`
  // was already fetched for live payment ids only.
  const priorByBill = priorSettlementByBill(cisAllocations);

  const cisBills: BillCisRow[] = ledger.bills.map((bill) => {
    const basis = basisByBill.get(bill.id)!;
    const settlement = settlementById.get(bill.id);
    return {
      id: bill.id,
      label: bill.reference?.trim()
        ? bill.reference.trim()
        : `${bill.category?.trim() || "Bill"} · ${formatGbp(basis.gross)}`,
      net: basis.net,
      gross: basis.gross,
      outstanding: settlement?.outstanding ?? 0,
      materials: basis.materials,
      citbLevy: basis.citbLevy,
      vatTreatment: basis.vatTreatment,
      reverseChargeRate: basis.reverseChargeRate,
      locked: lockedBills.has(bill.id),
      prior: priorByBill.get(bill.id) ?? NO_PRIOR,
    };
  });
  const payableCisBills = cisBills.filter((b) => b.outstanding > 0);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {crumb}

      <header>
        <h1 className="text-2xl font-bold text-slate-900">Supplier payments</h1>
        <p className="mt-1 text-sm text-slate-600">{supplier.name}</p>
      </header>

      {/* ── Position ────────────────────────────────────────────────────── */}
      <section>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Tile
            label="Billed"
            value={formatGbp(position.billedGross)}
            hint="inc VAT — what they've invoiced"
          />
          <Tile
            label="Paid"
            value={formatGbp(position.grossPaid)}
            hint="settled against their account"
          />
          <Tile
            label="Outstanding"
            value={formatGbp(position.outstanding)}
            hint="still owed to them"
          />
          <Tile
            label="CIS withheld"
            value={formatGbp(position.cisWithheld)}
            hint="held for HMRC — not a saving"
            tone="amber"
          />
          <Tile
            label="Net cash paid"
            value={formatGbp(position.netCash)}
            hint="what actually left the bank"
          />
          <Tile
            label="Job cost (ex VAT)"
            value={formatGbp(position.billedNet)}
            hint="unchanged by any CIS deduction"
          />
        </div>

        {position.cisWithheld > 0 ? (
          <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            You have withheld {formatGbp(position.cisWithheld)} of CIS from {supplier.name}. That
            money is HMRC&apos;s and is due on your next monthly return — it is not profit, and
            the work still cost the full {formatGbp(position.billedNet)} ex VAT.
          </p>
        ) : null}

        {position.unallocated > 0 ? (
          <p className="mt-2 text-xs text-slate-500">
            {formatGbp(position.unallocated)} paid on account, not yet matched to a bill.
          </p>
        ) : null}
      </section>

      {/* ── Record a payment ────────────────────────────────────────────── */}
      {/* A CIS subcontractor with a verified rate gets the DEDUCTION ENGINE:
          the withholding is worked out from the labour element rather than
          typed in. Everyone else keeps the plain M2 form, which is still the
          right tool for a builders' merchant or an on-account payment. */}
      {cis && rateAuthority.ok ? (
        <>
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">
              What part of each bill is labour?
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              CIS comes off the labour element only — never materials, plant hire, the CITB levy or
              VAT. Set the split before you pay, or CrewFlow treats the whole bill as labour and
              deducts more than it should.
            </p>
            {cisBills.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">No bills recorded yet.</p>
            ) : (
              <ul className="mt-3 space-y-4">
                {cisBills.map((bill) => (
                  <li key={bill.id}>
                    <p className="mb-1.5 text-sm font-medium text-slate-900">{bill.label}</p>
                    <BillCisDetailsForm
                      action={saveBillDetails.bind(null, id, bill.id)}
                      bill={bill}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2 className="mb-1 text-base font-semibold text-slate-900">Record a CIS payment</h2>
            <p className="mb-3 text-sm text-slate-600">
              Verified at {rateAuthority.rate}%. CrewFlow works the deduction out — you don&apos;t
              type it in, and it can&apos;t be overridden.
            </p>
            <RecordCisPaymentForm
              action={recordCisPaymentAction.bind(null, id)}
              bills={payableCisBills}
              defaultDate={todayIso()}
              rate={rateAuthority.rate}
              rateLabel={`${rateAuthority.rate}%`}
            />
          </section>
        </>
      ) : (
        <section>
          <h2 className="mb-3 text-base font-semibold text-slate-900">Record a payment</h2>
          {cis && !rateAuthority.ok ? (
            <div
              role="alert"
              className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            >
              {rateAuthority.reason}{" "}
              <Link href={`/suppliers/${id}/cis`} className="font-medium underline">
                Manage CIS details
              </Link>
            </div>
          ) : null}
          <RecordSupplierPaymentForm
            action={recordPayment.bind(null, id)}
            bills={payableBills}
            defaultDate={todayIso()}
            cisRate={cis?.deduction_rate != null ? Number(cis.deduction_rate) : null}
            hasCisProfile={Boolean(cis)}
          />
        </section>
      )}

      {/* ── Open bills ──────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">
          Bills ({settlements.length})
        </h2>
        {settlements.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">
            No bills recorded against this supplier yet.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100">
            {settlements.map((s) => {
              const bill = billById.get(s.billId);
              return (
                <li key={s.billId} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-slate-900">
                      {bill?.reference?.trim() || bill?.category?.trim() || "Bill"}
                      <span className="ml-2 text-xs text-slate-500">
                        {fmtDate(bill?.bill_date ?? null)}
                      </span>
                    </p>
                    <p className="text-xs text-slate-500 tabular-nums">
                      {formatGbp(s.settled)} of {formatGbp(s.gross)} paid
                      {s.net !== s.gross ? ` · ${formatGbp(s.net)} ex VAT` : ""}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${BILL_SETTLEMENT_STATUS_CLASS[s.status]}`}
                  >
                    {BILL_SETTLEMENT_STATUS_LABEL[s.status]}
                  </span>
                  <span className="w-20 shrink-0 text-right text-sm tabular-nums text-slate-900">
                    {formatGbp(s.outstanding)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── History ─────────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">
          Payment history ({payments.length})
        </h2>
        {payments.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No payments recorded yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100">
            {payments.map((p) => {
              const voided = Boolean(p.voided_at);
              const method = isSupplierPaymentMethod(p.method)
                ? SUPPLIER_PAYMENT_METHOD_LABEL[p.method]
                : p.method;
              return (
                <li key={p.id} className="flex flex-wrap items-start gap-2 py-3 text-sm">
                  <div className={`min-w-0 flex-1 ${voided ? "opacity-60" : ""}`}>
                    <p className="text-slate-900">
                      <span className="font-medium tabular-nums">
                        {formatGbp(p.net_paid)}
                      </span>{" "}
                      <span className="text-xs text-slate-500">
                        cash · {fmtDate(p.paid_at)} · {method}
                        {p.reference ? ` · ${p.reference}` : ""}
                      </span>
                    </p>
                    <p className="text-xs text-slate-500 tabular-nums">
                      Settled {formatGbp(p.gross_amount)}
                      {Number(p.cis_withheld ?? 0) > 0
                        ? ` · CIS withheld ${formatGbp(p.cis_withheld)}`
                        : ""}
                      {` · allocated ${formatGbp(allocByPayment.get(p.id) ?? 0)}`}
                    </p>
                    {/* The FROZEN tax facts, as they were at posting. These are
                        copies, not a live join — re-verifying the subcontractor
                        or editing the bill cannot change what is shown here, and
                        that is the whole point of the snapshot. */}
                    {(() => {
                      const snap = cisSnapshots.get(p.id);
                      if (!snap) return null;
                      const month = cisTaxMonthLabel(p.paid_at);
                      return (
                        <p className="mt-1 text-xs leading-tight text-slate-500 tabular-nums">
                          Labour {formatGbp(snap.cis_basis)} · materials{" "}
                          {formatGbp(snap.materials_total)} · {Number(snap.deduction_rate ?? 0)}%
                          {snap.verification_reference ? ` · ${snap.verification_reference}` : ""}
                          {month ? ` · tax month ${month}` : ""}
                        </p>
                      );
                    })()}
                    {voided ? (
                      <p className="mt-1 text-xs font-medium text-red-700">
                        Voided — {p.void_reason}
                      </p>
                    ) : null}
                  </div>
                  {voided ? null : (
                    <VoidPaymentForm action={voidPayment.bind(null, id)} paymentId={p.id} />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

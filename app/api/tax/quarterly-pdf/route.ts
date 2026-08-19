import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import {
  TaxQuarterPdf,
  type TaxQuarterPdfInput,
  type QuarterRow,
} from "@/lib/pdf/tax-quarter-pdf";
import {
  computeVatQuarter,
  startOfVatPeriodIso,
  endOfVatPeriodExclusiveIso,
  resolveFlatRateForPeriod,
} from "@/lib/tax/compute";
import { readOrgSettings } from "@/lib/org-config/service";
import {
  gatherVatQuarterInputs,
  type VatInputsDb,
} from "@/server/services/vat-quarter-inputs";

// PDF rendering is Node.js only.
export const runtime = "nodejs";

/**
 * Quarterly VAT PDF — totals + the underlying rows so an accountant can
 * tie the numbers back. Accepts ?quarterStart=YYYY-MM-DD (defaults to the
 * current VAT period for the org's HMRC stagger).
 */

/** Inclusive last day of a period: the day before its EXCLUSIVE upper bound. */
function inclusiveEndIso(endExclusiveIso: string): string {
  const d = new Date(endExclusiveIso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1))
    .toISOString()
    .slice(0, 10);
}

export async function GET(request: NextRequest) {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  // The org's HMRC VAT stagger fixes the period LENGTH (quarter vs month) and
  // phase. LOUD read (throws on a real error); absence degrades to the default
  // calendar quarter, so an org that never set a stagger is unchanged. The tax
  // page links here with the matching quarterStart, so the two surfaces agree.
  const orgSettings = await readOrgSettings(supabase, ctx.org.id);
  const stagger = orgSettings.vat_stagger;

  const url = new URL(request.url);
  const qStartParam = url.searchParams.get("quarterStart");
  const qStart =
    qStartParam && /^\d{4}-\d{2}-\d{2}$/.test(qStartParam)
      ? qStartParam
      : startOfVatPeriodIso(stagger);
  // The EXCLUSIVE upper bound = start of the next period, so a future-dated
  // payment/cost cannot leak in. Used for BOTH the finances read and the ledger.
  const qEndExclusiveIso = endOfVatPeriodExclusiveIso(qStart, stagger);
  const qEnd = inclusiveEndIso(qEndExclusiveIso);

  const [
    inputs,
    { data: financesRaw, error: financesError },
    { data: org },
  ] = await Promise.all([
      // ACTIVE-org pins — this PDF is an HMRC VAT-return working paper. Output VAT
      // is CASH: it comes from the invoice_payments LEDGER (every payment received
      // in the window, partial payments included), plus domestic reverse-charge
      // VAT self-accounted into boxes 1 & 4. The ledger + reverse-charge reads are
      // PAGED under the 1000-row cap (see gatherVatQuarterInputs), on the SAME
      // window the tile and the frozen 9-box return use — so this working paper
      // can never drift from them.
      gatherVatQuarterInputs(
        supabase as unknown as VatInputsDb,
        ctx.org.id,
        qStart,
        qEndExclusiveIso,
        orgSettings.vat_scheme,
      ),
      // PAGED (F-1). The finance rows ARE the input-VAT audit trail and
      // `computeVatQuarter` sums over every one: a bare `.select()` truncates at
      // the 1000-row cap and would under-state box 4.
      fetchAllRows((from, to) =>
        supabase
          .from("finances")
          .select("id, category, amount, vat_total, created_at")
          .eq("org_id", ctx.org.id)
          .gte("created_at", qStart)
          .lt("created_at", qEndExclusiveIso)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      ),
      supabase
        .from("organizations")
        .select("name, vat_number")
        .eq("id", ctx.org.id)
        .maybeSingle(),
    ]);
  // Loud fail: an errored read must never silently render a working paper with
  // missing (or zero) rows — that is a mis-stated HMRC figure.
  if (financesError) throw readFailure("tax pdf: finances", financesError);

  // "Payments received" audit rows — one per invoice_payments row in the window,
  // each showing the CASH received and its proportional net/VAT share (the same
  // apportionment computeVatQuarter sums into box 1). A partial payment appears
  // as itself, so the rows tie back to the Output VAT card.
  const paidInvoices: QuarterRow[] = inputs.invoicePayments.map((p) => {
    const cash = Number(p.amount ?? 0);
    const total = Number(p.invoice_total ?? 0);
    const ratioVat = total > 0 ? Number(p.invoice_vat_total ?? 0) / total : 0;
    const ratioNet = total > 0 ? Number(p.invoice_amount ?? 0) / total : 0;
    return {
      date: (p.paid_at as string | null)?.slice(0, 10) ?? "—",
      ref: p.invoiceRef ?? "—",
      net: Math.round(cash * ratioNet * 100) / 100,
      vat: Math.round(cash * ratioVat * 100) / 100,
      total: cash,
    };
  });
  const financeRows: QuarterRow[] = (financesRaw ?? []).map((r) => {
    const net = Number(r.amount ?? 0);
    const vat = Number(r.vat_total ?? 0);
    return {
      date: (r.created_at as string).slice(0, 10),
      ref: (r.category as string | null) ?? "expense",
      net,
      vat,
      total: net + vat,
    };
  });
  // SINGLE VAT AUTHORITY — the totals come from `computeVatQuarter`, exactly as
  // the dashboard tile and the HMRC 9-box composer do, so this working paper can
  // never drift from them. Reverse-charge VAT enters boxes 1 & 4 (net-neutral).
  const finances = (financesRaw ?? []).map((r) => ({
    vat_total: r.vat_total,
    amount: r.amount,
    created_at: r.created_at as string,
  }));
  // Scheme + FRS branch the SAME authority (cash + disabled FRS ⇒ inert ⇒ unchanged
  // working paper). Limited-cost status is the org's explicit declaration; undeclared
  // ⇒ conservative 16.5%.
  const flatRate = resolveFlatRateForPeriod(orgSettings.flat_rate_config, qStart);
  const vat = computeVatQuarter(
    inputs.invoicePayments,
    finances,
    qStart,
    qEndExclusiveIso,
    inputs.reverseCharge.vat,
    {
      scheme: orgSettings.vat_scheme,
      accrualInvoices: inputs.accrualInvoices,
      flatRate,
    },
  );

  const input: TaxQuarterPdfInput = {
    org_name: org?.name ?? ctx.org.name,
    org_vat_number: org?.vat_number ?? null,
    quarter_start: qStart,
    quarter_end: qEnd,
    output_vat: vat.output_vat,
    input_vat: vat.input_vat,
    net_payable: vat.net_payable,
    reverse_charge_vat: inputs.reverseCharge.vat,
    paid_invoices: paidInvoices,
    finance_rows: financeRows,
  };

  const buffer = await renderToBuffer(TaxQuarterPdf({ data: input }));
  const ab = new ArrayBuffer(buffer.length);
  new Uint8Array(ab).set(buffer);
  return new NextResponse(ab, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="vat-quarter-${qStart}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}

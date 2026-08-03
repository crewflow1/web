import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  TaxQuarterPdf,
  type TaxQuarterPdfInput,
  type QuarterRow,
} from "@/lib/pdf/tax-quarter-pdf";
import {
  computeVatQuarter,
  startOfQuarterIso,
  endOfQuarterExclusiveIso,
} from "@/lib/tax/compute";

// PDF rendering is Node.js only.
export const runtime = "nodejs";

/**
 * Quarterly VAT PDF — totals + the underlying rows so an accountant can
 * tie the numbers back. Accepts ?quarterStart=YYYY-MM-DD (defaults to
 * the current calendar quarter).
 */

function quarterEndIso(startIso: string): string {
  const d = new Date(startIso);
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 0));
  return end.toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const url = new URL(request.url);
  const qStartParam = url.searchParams.get("quarterStart");
  const qStart =
    qStartParam && /^\d{4}-\d{2}-\d{2}$/.test(qStartParam)
      ? qStartParam
      : startOfQuarterIso();
  const qEnd = quarterEndIso(qStart);
  // Use end-of-day to include rows posted on the final day.
  const qEndExclusive = `${qEnd}T23:59:59.999Z`;

  const [{ data: invoicesRaw }, { data: financesRaw }, { data: org }] =
    await Promise.all([
      // ACTIVE-org pins — this PDF is an HMRC VAT-return working paper. The org
      // header below is already read by `ctx.org.id`, so an unpinned figure set
      // would put BOTH companies' VAT under ONE company's letterhead.
      supabase
        .from("invoices")
        .select("number, status, amount, vat_total, total, paid_at, created_at")
        .eq("org_id", ctx.org.id)
        .eq("status", "paid")
        .gte("paid_at", qStart)
        .lte("paid_at", qEndExclusive)
        .order("paid_at", { ascending: true }),
      supabase
        .from("finances")
        .select("category, amount, vat_total, created_at")
        .eq("org_id", ctx.org.id)
        .gte("created_at", qStart)
        .lte("created_at", qEndExclusive)
        .order("created_at", { ascending: true }),
      supabase
        .from("organizations")
        .select("name, vat_number")
        .eq("id", ctx.org.id)
        .maybeSingle(),
    ]);

  const paidInvoices: QuarterRow[] = (invoicesRaw ?? []).map((r) => ({
    date: (r.paid_at as string | null)?.slice(0, 10) ?? "—",
    ref: r.number as string,
    net: Number(r.amount ?? 0),
    vat: Number(r.vat_total ?? 0),
    total: Number(r.total ?? 0),
  }));
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
  // never drift from them. The row lists above are the audit trail behind the
  // same figures. The EXCLUSIVE upper bound belts-and-braces the DB's paid_at
  // filter so a future-dated payment cannot inflate output VAT.
  const vat = computeVatQuarter(
    (invoicesRaw ?? []).map((r) => ({
      status: r.status as string,
      vat_total: r.vat_total,
      total: r.total,
      amount: r.amount,
      paid_at: r.paid_at as string | null,
      created_at: r.created_at as string,
    })),
    (financesRaw ?? []).map((r) => ({
      vat_total: r.vat_total,
      amount: r.amount,
      created_at: r.created_at as string,
    })),
    qStart,
    endOfQuarterExclusiveIso(qStart),
  );

  const input: TaxQuarterPdfInput = {
    org_name: org?.name ?? ctx.org.name,
    org_vat_number: org?.vat_number ?? null,
    quarter_start: qStart,
    quarter_end: qEnd,
    output_vat: vat.output_vat,
    input_vat: vat.input_vat,
    net_payable: vat.net_payable,
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

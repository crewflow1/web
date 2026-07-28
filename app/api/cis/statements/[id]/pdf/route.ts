import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { requireOrgContext } from "@/server/auth/session";
import { getCisProfile } from "@/server/services/cis";
import { getStatement, listStatementPayments } from "@/server/services/cis-statements";
import { describeVerificationNumber } from "@/lib/cis/statements";
import { cisTaxMonthLabel } from "@/lib/cis/tax-month";
import { CisStatementPdf, type CisStatementPdfInput } from "@/lib/pdf/cis-statement-pdf";
import { formatGbp, round2, toPounds } from "@/lib/money";

/**
 * CIS payment and deduction statement PDF.
 *
 * RLS-scoped: `cis_statements` is admin-only, so a non-admin member of the same
 * org reads nothing here and gets a 404 — the same answer a stranger gets. The
 * role is not re-checked in app code because there is nothing this route can do
 * that RLS has not already decided.
 *
 * The document body is the FROZEN statement row. Nothing is recomputed from the
 * live ledger: that is the entire point of freezing it, and a statement whose
 * figures moved because a supplier was renamed would not be evidence of anything.
 *
 * ── THE ONE LIVE READ, AND WHY ──────────────────────────────────────────────
 * HMRC requires the subcontractor's UTR ON the statement, but M3 deliberately
 * stores only a MASK (`utr_masked`) so the domain has exactly one unmasked home
 * for its most sensitive field — the admin-only `cis_subcontractors` row. So the
 * full UTR is read live at render time and printed only when it is provably the
 * same one the statement was issued against: we re-derive the mask from the live
 * UTR and compare it to the frozen mask. If they differ, the UTR on file has
 * changed since issue, and the document falls back to the frozen mask rather
 * than printing a number that was not the one used. Neither branch invents
 * anything.
 */

type Ctx = { params: Promise<{ id: string }> };

/**
 * The mask exactly as `record_cis_supplier_payment` computes it in SQL
 * (20261051000000): bullets for all but the last four digits. Deliberately NOT
 * `lib/cis/verification.ts maskUtr`, which is a DIFFERENT display mask — this
 * function exists to compare against a stored value, so it must mirror the
 * producer of that value, not a lookalike.
 */
function snapshotUtrMask(utr: string): string {
  return "•".repeat(Math.max(utr.length - 4, 0)) + utr.slice(-4);
}

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { ctx } = await requireOrgContext();
  const { id } = await params;

  const statement = await getStatement(ctx.org.id, id);
  if (!statement) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const payments = await listStatementPayments(ctx.org.id, id);

  // ── the single live read: the full UTR, only if it is still the same one ──
  // Deliberately through `getCisProfile` rather than a direct query: M1's
  // security tier pins `cis_subcontractors` to exactly one reader
  // (server/services/cis.ts) so the admin-gated, masking-aware discipline has a
  // single door. A second door here would be the beginning of not having one.
  const profile = await getCisProfile(ctx.org.id, statement.supplier_id);
  const liveUtr = profile?.utr ?? null;
  const frozenMask = statement.subcontractor_utr_masked;
  let utr: CisStatementPdfInput["utr"];
  if (liveUtr && frozenMask && snapshotUtrMask(liveUtr) === frozenMask) {
    utr = { kind: "full", value: liveUtr };
  } else if (frozenMask) {
    utr = { kind: "masked", value: frozenMask };
  } else {
    utr = { kind: "absent", value: null };
  }

  const gross = round2(toPounds(statement.gross_amount));
  const materials = round2(toPounds(statement.materials_amount));
  const deduction = round2(toPounds(statement.deduction_amount));

  const input: CisStatementPdfInput = {
    statementNumber: statement.statement_number,
    status: statement.status,
    contractorName: statement.contractor_name,
    contractorPaye: statement.contractor_paye_reference,
    contractorBlockLines: [`Employer PAYE reference ${statement.contractor_paye_reference}`],
    taxMonthEnd: statement.tax_month_end,
    taxMonthLabel: cisTaxMonthLabel(statement.tax_month_end) ?? statement.tax_month_end,
    statementDueOn: statement.statement_due_on,
    subcontractorName: statement.subcontractor_name,
    utr,
    verification: describeVerificationNumber({
      required: statement.verification_number_required,
      number: statement.verification_number,
    }),
    grossAmount: formatGbp(gross),
    materialsAmount: formatGbp(materials),
    netPaid: formatGbp(round2(gross - materials)),
    deductionAmount: formatGbp(deduction),
    rateLabel: statement.rate_is_uniform
      ? `${round2(toPounds(statement.deduction_rate))}% deduction rate`
      : "rate varied within the month",
    isStatutory: statement.is_statutory,
    issuedOn: statement.issued_on,
    payments: payments.map((p) => ({
      paidOn: p.paid_on,
      gross: formatGbp(p.cis_gross_payment),
      materials: formatGbp(p.materials_total),
      deduction: formatGbp(p.cis_deduction),
    })),
    supersededNote:
      statement.status === "superseded"
        ? "This statement has been replaced by a later one for the same tax month. Use the replacement."
        : null,
    withdrawnNote:
      statement.status === "withdrawn"
        ? `This statement has been withdrawn and should not be relied on.${
            statement.withdraw_reason ? ` Reason: ${statement.withdraw_reason}` : ""
          }`
        : null,
    contentHash: statement.content_hash,
    generatedAt: new Date().toISOString(),
  };

  const buffer = await renderToBuffer(CisStatementPdf({ s: input }));
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${statement.statement_number}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}

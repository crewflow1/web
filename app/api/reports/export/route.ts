import { NextResponse } from "next/server";
import { requireManagementApi } from "@/server/auth/session";
import { csvEscape } from "@/lib/csv";
import {
  jobsPerWeek,
  revenuePerMonth,
  vatPerQuarter,
  topCustomersByRevenue,
} from "@/lib/reports/aggregates";

/**
 * CSV export of the /reports dashboard.
 *
 *   GET /api/reports/export
 *
 * One download, four labelled sections — the SAME four deterministic
 * aggregates the /reports page renders, in the same order and with the
 * same look-backs:
 *
 *   1. Jobs per week      (last 8 weeks)
 *   2. Revenue per month  (last 12 months, paid invoices)
 *   3. VAT per quarter    (last 4 quarters; output − input)
 *   4. Top customers      (all-time, top 10 by paid-invoice revenue)
 *
 * The aggregates are REUSED verbatim from `@/lib/reports/aggregates`;
 * this route computes nothing and queries no table itself, so the CSV
 * can never drift from the on-screen figures. Each aggregate runs under
 * the caller's JWT, so RLS scopes every row to the caller's org —
 * identical isolation to the page (behind the same `requireOrgContext`
 * gate). Money is emitted as raw two-dp numbers (no currency symbol, no
 * thousands separators) so the columns stay machine-readable in a
 * spreadsheet, exactly like the finances and invoices exports. All
 * quoting goes through the one shared `csvEscape`.
 */

type Cell = string | number;

export async function GET() {
  // Management-only: this CSV carries revenue / VAT / top-customers. A staff
  // member must not be able to export it (nav marks Money ADMIN_ROLES).
  const guard = await requireManagementApi();
  if (guard instanceof Response) return guard;
  const { ctx } = guard;

  try {
    const [jobs, revenue, vat, top] = await Promise.all([
      jobsPerWeek(ctx.org.id, 8),
      revenuePerMonth(ctx.org.id, 12),
      vatPerQuarter(ctx.org.id, 4),
      topCustomersByRevenue(ctx.org.id, 10),
    ]);

    const lines: string[] = [];
    const section = (title: string, header: string[], rows: Cell[][]) => {
      if (lines.length > 0) lines.push(""); // one blank line between sections
      lines.push(csvEscape(title));
      lines.push(header.map(csvEscape).join(","));
      for (const row of rows) lines.push(row.map(csvEscape).join(","));
    };

    section(
      "Jobs per week (last 8 weeks)",
      ["week_start", "total", "completed"],
      jobs.map((r) => [r.week_start, r.total, r.completed]),
    );
    section(
      "Revenue per month in GBP (last 12 months; paid invoices only)",
      ["month", "revenue"],
      revenue.map((r) => [r.month, r.revenue.toFixed(2)]),
    );
    section(
      "VAT per quarter in GBP (last 4 quarters; output minus input)",
      ["quarter", "output_vat", "input_vat", "net_vat"],
      vat.map((r) => [
        r.quarter,
        r.output_vat.toFixed(2),
        r.input_vat.toFixed(2),
        r.net_vat.toFixed(2),
      ]),
    );
    section(
      "Top customers by revenue in GBP (all-time; top 10)",
      ["rank", "customer", "revenue", "invoice_count"],
      top.map((c, i) => [i + 1, c.name, c.revenue.toFixed(2), c.invoice_count]),
    );

    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(lines.join("\n"), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="crewflow-reports-${stamp}.csv"`,
      },
    });
  } catch (e) {
    console.error("[reports] export failed", e);
    return NextResponse.json(
      { error: "Failed to export reports" },
      { status: 500 },
    );
  }
}

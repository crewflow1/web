import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { csvEscape } from "@/lib/csv";
import { fetchAllRows } from "@/lib/supabase/paginate";

/**
 * CSV export of an org's finances.
 *
 *   GET /api/finances/export?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Columns: date, job_id, category, amount, vat_rate, vat_total, total, notes.
 * Joining jobs/customers names would require more selects — left out of
 * this MVP so the export stays fast for large orgs. The job_id UUID is
 * sufficient for downstream pivoting in Excel.
 *
 * RLS scopes rows to caller's org automatically.
 */

export async function GET(request: NextRequest) {
  const { ctx } = await requireOrgContext();
  const url = request.nextUrl;
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const supabase = await createClient();
  // F-1: a bookkeeping export must be COMPLETE. A single `.limit(N)` is silently
  // clamped to PostgREST max_rows (1000), so page the full ledger with a unique
  // (created_at, id) total order. ACTIVE-org pin — RLS alone merged both of a
  // dual-org user's companies into one CSV.
  const { data, error } = await fetchAllRows<{
    created_at: string;
    job_id: string | null;
    category: string | null;
    amount: number | null;
    vat_rate: number | null;
    vat_total: number | null;
    notes: string | null;
  }>((rangeFrom, rangeTo) => {
    let q = supabase
      .from("finances")
      .select("id, created_at, job_id, category, amount, vat_rate, vat_total, notes")
      .eq("org_id", ctx.org.id)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(rangeFrom, rangeTo);
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
      q = q.gte("created_at", `${from}T00:00:00Z`);
    }
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
      q = q.lte("created_at", `${to}T23:59:59Z`);
    }
    return q;
  });
  if (error) {
    console.error("[finances] export failed", error);
    return NextResponse.json({ error: "Failed to export" }, { status: 500 });
  }

  const header = ["date", "job_id", "category", "amount", "vat_rate", "vat_total", "total", "notes"];
  const lines = [header.join(",")];
  for (const r of data ?? []) {
    const amt = Number(r.amount ?? 0);
    const vat = Number(r.vat_total ?? 0);
    lines.push(
      [
        r.created_at,
        r.job_id ?? "",
        r.category ?? "",
        amt.toFixed(2),
        r.vat_rate ?? "",
        vat.toFixed(2),
        (amt + vat).toFixed(2),
        r.notes ?? "",
      ]
        .map(csvEscape)
        .join(","),
    );
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(lines.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="crewflow-finances-${stamp}.csv"`,
    },
  });
}

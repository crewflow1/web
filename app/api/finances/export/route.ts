import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { csvEscape } from "@/lib/csv";

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

const MAX_ROWS = 50_000;

export async function GET(request: NextRequest) {
  const { ctx } = await requireOrgContext();
  const url = request.nextUrl;
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const supabase = await createClient();
  let q = supabase
    .from("finances")
    .select("created_at, job_id, category, amount, vat_rate, vat_total, notes")
    // ACTIVE-org pin — a bookkeeping export must contain exactly one company's
    // ledger; RLS alone merged both into a single CSV.
    .eq("org_id", ctx.org.id)
    .order("created_at", { ascending: true })
    .limit(MAX_ROWS);

  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
    q = q.gte("created_at", `${from}T00:00:00Z`);
  }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    q = q.lte("created_at", `${to}T23:59:59Z`);
  }

  const { data, error } = await q;
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

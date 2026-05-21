import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { payrollCsv } from "@/lib/payroll/compute";
import { fetchNiNumbersForOrg } from "@/lib/staff/secrets";

export const runtime = "nodejs";

/**
 * Payroll run as a CSV — admin-only. Columns match the order an accountant
 * or payroll bureau is most likely to want.
 */

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { ctx } = await requireOrgContext();
  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: run }, { data: lines }, niByUser] = await Promise.all([
    supabase
      .from("payroll_runs")
      .select("cycle, period_start, period_end, org_id")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("payroll_lines")
      .select(
        `
          user_id, hours, hourly_pay, gross_pay, paye_estimate, ni_estimate, net_pay,
          user:users ( full_name )
        `,
      )
      .eq("payroll_run_id", id)
      .order("gross_pay", { ascending: false }),
    fetchNiNumbersForOrg(ctx.org.id),
  ]);

  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });

  const csv = payrollCsv(
    (lines ?? []).map((l) => ({
      full_name: l.user?.full_name ?? "—",
      ni_number: niByUser.get(l.user_id) ?? null,
      hours: Number(l.hours ?? 0),
      hourly_pay: Number(l.hourly_pay ?? 0),
      gross_pay: Number(l.gross_pay ?? 0),
      paye_estimate: Number(l.paye_estimate ?? 0),
      ni_estimate: Number(l.ni_estimate ?? 0),
      net_pay: Number(l.net_pay ?? 0),
    })),
    { period_start: run.period_start, period_end: run.period_end, cycle: run.cycle },
  );

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="payroll-${run.cycle}-${run.period_start}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}

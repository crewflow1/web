import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { PayslipPdf, type PayslipInput } from "@/lib/pdf/payslip-pdf";

export const runtime = "nodejs";

/**
 * Payslip PDF for a single payroll_line.
 *
 * Access:
 *   - the line's own user_id (staff downloading their own)
 *   - owner/admin (downloading anyone in their org)
 * RLS on payroll_lines enforces this already; we double-check at the app
 * layer for a friendlier 403.
 */

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { user, ctx } = await requireOrgContext();
  const { id } = await params;
  const supabase = await createClient();

  const { data: line } = await supabase
    .from("payroll_lines")
    .select(
      `
        id, user_id, hours, hourly_pay, gross_pay, paye_estimate, ni_estimate, net_pay,
        user:users ( full_name ),
        run:payroll_runs ( cycle, period_start, period_end )
      `,
    )
    .eq("id", id)
    .maybeSingle();

  if (!line) return NextResponse.json({ error: "not found" }, { status: 404 });

  const isOwn = line.user_id === user.id;
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  if (!isOwn && !isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Read the NI number from staff_secrets (admin-only RLS). A staff
  // user downloading their own payslip won't see the full number;
  // the masked form is rendered instead.
  const [{ data: org }, { data: secret }] = await Promise.all([
    supabase
      .from("organizations")
      .select("name, phone")
      .eq("id", ctx.org.id)
      .maybeSingle(),
    supabase
      .from("staff_secrets")
      .select("ni_number")
      .eq("org_id", ctx.org.id)
      .eq("user_id", line.user_id)
      .maybeSingle(),
  ]);

  const { maskNiNumber } = await import("@/lib/staff/secrets");
  const niForPayslip = isAdmin ? secret?.ni_number ?? null : maskNiNumber(secret?.ni_number ?? null);

  const input: PayslipInput = {
    org_name: org?.name ?? ctx.org.name,
    org_phone: org?.phone ?? null,
    full_name: line.user?.full_name ?? "—",
    ni_number: niForPayslip === "—" ? null : niForPayslip,
    cycle: line.run?.cycle ?? "weekly",
    period_start: line.run?.period_start ?? "",
    period_end: line.run?.period_end ?? "",
    hours: Number(line.hours ?? 0),
    hourly_pay: Number(line.hourly_pay ?? 0),
    gross_pay: Number(line.gross_pay ?? 0),
    paye_estimate: Number(line.paye_estimate ?? 0),
    ni_estimate: Number(line.ni_estimate ?? 0),
    net_pay: Number(line.net_pay ?? 0),
  };

  const buffer = await renderToBuffer(PayslipPdf({ data: input }));
  const ab = new ArrayBuffer(buffer.length);
  new Uint8Array(ab).set(buffer);
  return new NextResponse(ab, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="payslip-${input.full_name.replace(/\s+/g, "_")}-${input.period_start}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}

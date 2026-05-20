import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { sendInvoiceEmail } from "@/lib/email/send-invoice";

export const runtime = "nodejs";

/**
 * POST /api/invoices/[id]/remind
 *
 * Operator-triggered "Send reminder now". Stage is always "manual"
 * (multiple manuals allowed per invoice). Auto-stages day_3..day_21
 * remain owned by the cron — this endpoint does not impersonate them.
 *
 * Body (optional JSON): { to?: string, message?: string }
 *
 * Stop-on-paid guard: returns 409 if invoice is already paid. The
 * operator gets a clear message rather than silently sending a
 * reminder for an already-settled invoice.
 */

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  const { ctx } = await requireOrgContext();
  const { id } = await params;

  let body: { to?: string; message?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const supabase = await createClient();

  // Stop-on-paid check.
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, status, org_id")
    .eq("id", id)
    .maybeSingle();
  if (!inv) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (inv.status === "paid") {
    return NextResponse.json(
      { error: "already_paid", detail: "This invoice is marked paid. No reminder sent." },
      { status: 409 },
    );
  }

  const result = await sendInvoiceEmail(supabase, id, {
    to: body.to,
    message: body.message,
    kind: "reminder",
    reminder_stage: "manual",
  });

  if (!result.sent) {
    switch (result.reason) {
      case "no_resend_key":
        return NextResponse.json(
          {
            error: "email_not_configured",
            detail:
              "RESEND_API_KEY is not set. Add it in Vercel and verify the sender domain in Resend.",
          },
          { status: 503 },
        );
      case "not_found":
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      case "no_recipient":
        return NextResponse.json(
          { error: "no_recipient", detail: "No customer email on file." },
          { status: 400 },
        );
      case "invalid_recipient":
        return NextResponse.json({ error: "invalid_recipient" }, { status: 400 });
      case "load_failed":
        return NextResponse.json({ error: "load_failed", detail: result.detail }, { status: 500 });
      case "send_failed":
        return NextResponse.json({ error: "send_failed", detail: result.detail }, { status: 502 });
    }
  }

  // Insert the reminder row (trigger emits invoice.reminder_sent).
  const { error: insErr } = await supabase
    .from("invoice_reminders")
    .insert({
      invoice_id: id,
      org_id: inv.org_id,
      stage: "manual",
      recipient: result.to,
      email_id: result.emailId,
    });
  if (insErr) {
    console.error("[invoice-remind] reminder insert failed", insErr);
    return NextResponse.json({
      sent: true,
      email_id: result.emailId,
      to: result.to,
      warning: "email_sent_but_audit_row_failed",
    });
  }

  void ctx;
  return NextResponse.json({ sent: true, email_id: result.emailId, to: result.to });
}

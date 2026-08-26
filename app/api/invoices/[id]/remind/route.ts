import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireManagementApi } from "@/server/auth/session";
import { sendInvoiceEmail } from "@/lib/email/send-invoice";
import { readFailure } from "@/lib/supabase/read-failure";
import * as Sentry from "@sentry/nextjs";

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
  // Management-only (first-customer fix 1): this surface carries money.
  const guard = await requireManagementApi();
  if (guard instanceof Response) return guard;
  const { ctx } = guard;
  const { id } = await params;

  let body: { to?: string; message?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const supabase = await createClient();

  // Stop-on-paid check.
  const { data: inv, error: invErr } = await supabase
    .from("invoices")
    .select("id, status, org_id")
    .eq("id", id)
    .maybeSingle();
  if (invErr) {
    Sentry.captureException(readFailure("invoice remind: invoice", invErr), {
      tags: { route: "invoices/remind" },
    });
    console.error("[invoice-remind] invoice load failed", invErr);
    return NextResponse.json(
      { error: "load_failed", detail: "Couldn't load the invoice." },
      { status: 500 },
    );
  }
  if (!inv) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Defence in depth: the read above is RLS-scoped, but assert org ownership
  // explicitly so a reminder can never be triggered for another org's invoice
  // even if the invoices SELECT policy is ever loosened. 404 (not 403) avoids
  // leaking whether the id exists in another tenant.
  if (inv.org_id !== ctx.org.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (inv.status === "void") {
    // A void invoice (20261219) is retracted — reminding a customer to pay it
    // would be a customer-facing lie.
    return NextResponse.json(
      { error: "voided", detail: "This invoice was voided. No reminder sent." },
      { status: 409 },
    );
  }
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
    // The org check above is the gate; this re-states the scope inside the
    // helper's own load and writes so the two cannot drift apart.
    orgId: ctx.org.id,
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
      case "voided":
        return NextResponse.json(
          { error: "voided", detail: "This invoice was voided. Nothing was sent." },
          { status: 409 },
        );
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

  return NextResponse.json({ sent: true, email_id: result.emailId, to: result.to });
}

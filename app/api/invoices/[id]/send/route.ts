import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { sendInvoiceEmail } from "@/lib/email/send-invoice";

// PDF rendering inside the helper is Node only.
export const runtime = "nodejs";

/**
 * POST /api/invoices/[id]/send
 *
 * Renders the invoice PDF, emails it (attachment + bank-details CTA),
 * stamps invoices.sent_at, flips draft→sent. Delegates the heavy lifting
 * to lib/email/send-invoice.ts so the same code path runs on auto-email
 * after quote acceptance.
 *
 * Body (optional JSON): { to?: string, message?: string }
 */

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  await requireOrgContext();
  const { id } = await params;

  let body: { to?: string; message?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const supabase = await createClient();
  const result = await sendInvoiceEmail(supabase, id, {
    to: body.to,
    message: body.message,
  });

  if (!result.sent) {
    switch (result.reason) {
      case "no_resend_key":
        return NextResponse.json(
          {
            error: "email_not_configured",
            detail:
              "RESEND_API_KEY is not set in this environment. Add it in Vercel and verify the sender domain in Resend.",
          },
          { status: 503 },
        );
      case "not_found":
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      case "no_recipient":
        return NextResponse.json(
          {
            error: "no_recipient",
            detail:
              "This invoice's customer has no email on file. Add a 'to' override in the request body, or set the customer's email under /customers.",
          },
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

  return NextResponse.json({
    sent: true,
    email_id: result.emailId,
    to: result.to,
    sent_at: result.sent_at,
    new_status: result.new_status,
  });
}

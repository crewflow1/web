import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { sendQuoteEmail } from "@/lib/email/send-quote";

// PDF rendering inside the helper is Node only.
export const runtime = "nodejs";

/**
 * POST /api/quotes/[id]/send
 *
 * Renders the quote PDF, emails it with a portal link (view + approve/reject),
 * ensures a public_token, stamps quotes.sent_at and flips status to "sent".
 *
 * Body (optional JSON): { to?: string, message?: string }
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

  // ACTIVE-ORG GATE — refuse BEFORE anything is rendered or sent. See the
  // equivalent note in app/api/invoices/[id]/send/route.ts. Sending is the
  // worst case of the active-org defect: it leaves the product. For a quote it
  // also mints a `public_token` — a live approve/reject credential for another
  // org's commercial document.
  const { data: q } = await supabase
    .from("quotes")
    .select("id, org_id")
    .eq("id", id)
    .maybeSingle();
  if (!q || q.org_id !== ctx.org.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const result = await sendQuoteEmail(supabase, id, {
    to: body.to,
    message: body.message,
    orgId: ctx.org.id,
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
              "This quote's customer has no email on file. Add a 'to' override, or set the customer's email under /customers.",
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
    portal_url: result.portal_url,
  });
}

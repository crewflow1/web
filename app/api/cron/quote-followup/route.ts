import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { buildQuoteFollowup } from "@/lib/email/templates/reminders";
import { isCronAuthorised } from "@/lib/cron/auth";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phase 8.2d — Daily cron: quote follow-up.
 *
 * Selects quotes with:
 *   - sent_at is not null
 *   - viewed_at is null
 *   - accepted_at is null
 *   - declined_at is null
 *   - followup_sent_at is null
 *   - sent_at <= today - FOLLOWUP_DAYS
 *
 * Sends a "just checking in" email. No PDF attachment — the customer
 * presumably has the original send; we don't want to drown them in
 * duplicate attachments.
 */

const FOLLOWUP_DAYS = 5;

type Row = {
  id: string;
  org_id: string;
  number: string;
  total: number | string | null;
  sent_at: string;
  viewed_at: string | null;
  accepted_at: string | null;
  declined_at: string | null;
  customer: { name: string | null; email: string | null } | null;
  org: { name: string | null } | null;
};

export async function GET(request: Request) {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!env.RESEND_API_KEY) {
    return NextResponse.json({ skipped: true, reason: "no_resend_key" });
  }

  const admin = createAdminClient();
  const horizon = new Date();
  horizon.setUTCDate(horizon.getUTCDate() - FOLLOWUP_DAYS);
  const horizonIso = horizon.toISOString();

  const { data: rowsRaw, error } = await admin
    .from("quotes")
    .select(
      `
        id, org_id, number, total, sent_at, viewed_at, accepted_at, declined_at,
        customer:customers ( name, email ),
        org:organizations ( name )
      `,
    )
    .is("viewed_at", null)
    .is("accepted_at", null)
    .is("declined_at", null)
    .is("followup_sent_at", null)
    .not("sent_at", "is", null)
    .lte("sent_at", horizonIso)
    .limit(500);
  const rows = rowsRaw as unknown as Row[] | null;

  if (error) {
    console.error("[cron/quote-followup] query failed", error);
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }

  const stats = { scanned: rows?.length ?? 0, sent: 0, skipped_no_email: 0, failed: 0 };
  const nowMs = Date.now();

  for (const q of rows ?? []) {
    const to = q.customer?.email;
    if (!to) {
      stats.skipped_no_email++;
      continue;
    }

    const daysSinceSent = Math.max(
      1,
      Math.round((nowMs - new Date(q.sent_at).getTime()) / 86_400_000),
    );

    const { subject, html, text } = buildQuoteFollowup({
      org_name: q.org?.name ?? "CrewFlow",
      customer_name: q.customer?.name ?? null,
      quote_number: q.number,
      total: Number(q.total ?? 0),
      days_since_sent: daysSinceSent,
    });

    const res = await sendEmail({ to, subject, html, text });

    if (!res.sent) {
      stats.failed++;
      console.error("[cron/quote-followup] send failed", { id: q.id, reason: res });
      continue;
    }

    // Cast: followup_sent_at is in the 20260518150000 migration but not yet
    // in the generated Supabase types. Safe at runtime post-deploy.
    const { error: updErr } = await admin
      .from("quotes")
      .update({ followup_sent_at: new Date().toISOString() } as never)
      .eq("id", q.id);
    if (updErr) {
      stats.failed++;
      console.error("[cron/quote-followup] stamp failed", { id: q.id, updErr });
      continue;
    }

    stats.sent++;
  }

  return NextResponse.json({ ok: true, ...stats });
}

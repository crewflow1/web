import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { buildPaymentReminder } from "@/lib/email/templates/reminders";
import { renderInvoicePdf } from "@/lib/email/render-invoice-pdf";
import { isCronAuthorised } from "@/lib/cron/auth";
import { env } from "@/lib/env";

export const runtime = "nodejs";
// Avoid Next's data cache for cron routes; we always want a fresh DB scan.
export const dynamic = "force-dynamic";

/**
 * Phase 8.2b — Daily cron: payment reminder.
 *
 * Selects invoices with:
 *   - status in ('sent', 'draft')   (draft included so you can warn an
 *     unsent invoice's customer before its due_date sneaks past)
 *   - paid_at is null
 *   - payment_reminder_sent_at is null
 *   - due_date <= today + REMINDER_DAYS
 *   - due_date >= today  (don't double-send with the overdue cron)
 *
 * For each, renders the PDF, sends "due in N days" email, stamps
 * payment_reminder_sent_at. Service-role client because this fans out
 * across tenants; org_id stays in every SELECT so we never leak.
 */

const REMINDER_DAYS = 3; // send when due_date is within 3 days

type Row = {
  id: string;
  org_id: string;
  number: string;
  status: string;
  amount: number | string | null;
  vat_total: number | string | null;
  total: number | string | null;
  due_date: string;
  paid_at: string | null;
  notes: string | null;
  quote_id: string | null;
  quote: {
    customer: { name: string | null; email: string | null } | null;
  } | null;
  org: {
    name: string | null;
    phone: string | null;
    vat_number: string | null;
    logo_url: string | null;
    address: unknown;
    bank_details: unknown;
  } | null;
};

export async function GET(request: Request) {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!env.RESEND_API_KEY) {
    return NextResponse.json({ skipped: true, reason: "no_resend_key" });
  }

  const admin = createAdminClient();
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const horizon = new Date(today);
  horizon.setUTCDate(horizon.getUTCDate() + REMINDER_DAYS);
  const horizonIso = horizon.toISOString().slice(0, 10);

  const { data: rowsRaw, error } = await admin
    .from("invoices")
    .select(
      `
        id, org_id, number, status, amount, vat_total, total, due_date, paid_at, notes, quote_id,
        quote:quotes ( customer:customers ( name, email ) ),
        org:organizations ( name, phone, vat_number, logo_url, address, bank_details )
      `,
    )
    .is("paid_at", null)
    .is("payment_reminder_sent_at", null)
    .in("status", ["sent", "draft"])
    .not("due_date", "is", null)
    .gte("due_date", todayIso)
    .lte("due_date", horizonIso)
    .limit(500);
  const rows = rowsRaw as unknown as Row[] | null;

  if (error) {
    console.error("[cron/payment-reminder] query failed", error);
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }

  const stats = { scanned: rows?.length ?? 0, sent: 0, skipped_no_email: 0, failed: 0 };

  for (const inv of rows ?? []) {
    const to = inv.quote?.customer?.email;
    if (!to) {
      stats.skipped_no_email++;
      continue;
    }
    const { data: lines } = inv.quote_id
      ? await admin
          .from("quote_line_items")
          .select("description, qty, unit_price, vat_rate, line_total, sort_order")
          .eq("quote_id", inv.quote_id)
          .order("sort_order", { ascending: true })
      : { data: [] };

    const pdf = await renderInvoicePdf(inv, lines ?? []);

    const dueMs = new Date(`${inv.due_date}T00:00:00Z`).getTime();
    const todayMs = new Date(`${todayIso}T00:00:00Z`).getTime();
    const daysUntilDue = Math.max(0, Math.round((dueMs - todayMs) / 86_400_000));

    const { subject, html, text } = buildPaymentReminder({
      org_name: inv.org?.name ?? "CrewFlow",
      customer_name: inv.quote?.customer?.name ?? null,
      invoice_number: inv.number,
      total: Number(inv.total ?? 0),
      due_date: inv.due_date,
      days_until_due: daysUntilDue,
    });

    const res = await sendEmail({
      to,
      subject,
      html,
      text,
      attachments: [{ filename: `${inv.number}.pdf`, content: pdf }],
    });

    if (!res.sent) {
      stats.failed++;
      console.error("[cron/payment-reminder] send failed", { id: inv.id, reason: res });
      continue;
    }

    // Cast: payment_reminder_sent_at is in the 20260518150000 migration but
    // not yet in the generated Supabase types. Safe at runtime post-deploy.
    const { error: updErr } = await admin
      .from("invoices")
      .update({ payment_reminder_sent_at: new Date().toISOString() } as never)
      .eq("id", inv.id);
    if (updErr) {
      stats.failed++;
      console.error("[cron/payment-reminder] stamp failed", { id: inv.id, updErr });
      continue;
    }

    stats.sent++;
  }

  return NextResponse.json({ ok: true, ...stats });
}

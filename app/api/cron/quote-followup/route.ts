import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { sendEmail } from "@/lib/email/send";
import { buildQuoteFollowup } from "@/lib/email/templates/reminders";
import { isCronAuthorised } from "@/lib/cron/auth";
import { env } from "@/lib/env";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";
import { mapWithConcurrency } from "@/lib/async/concurrent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Full Vercel Pro budget — a busy day can queue hundreds of follow-ups,
// and the short default timeout would kill the run mid-list.
export const maxDuration = 300;

// In-flight sends. Bounded to overlap network latency without tripping
// Resend's rate limit; a rate-limited send fails soft and the quote
// (still followup_sent_at IS NULL) is simply retried next run.
const SEND_CONCURRENCY = 3;

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
    const skipResult = await withCronTelemetry("quote-followup", async () => ({
      ok: true,
      skipped: true,
      reason: "no_resend_key",
    }));
    return NextResponse.json(skipResult.payload, { status: skipResult.status });
  }

  const { status, payload } = await withCronTelemetry(
    "quote-followup",
    async () => runFollowup(),
  );
  return NextResponse.json(payload, { status });
}

async function runFollowup() {
  const admin = createAdminClient();
  const horizon = new Date();
  horizon.setUTCDate(horizon.getUTCDate() - FOLLOWUP_DAYS);
  const horizonIso = horizon.toISOString();

  // COMPLETE read (F-1). The old `.limit(500)` silently STARVED follow-ups once
  // the standing candidate backlog crossed 500 across all orgs (this is a
  // cross-org admin scan). Page the whole candidate set; `followup_sent_at` +
  // the per-row re-check make re-runs idempotent, so no quote is double-chased.
  const { data: rowsRaw, error } = await fetchAllRows((from, to) =>
    admin
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
      .order("id", { ascending: true })
      .range(from, to),
  );
  const rows = rowsRaw as unknown as Row[] | null;

  if (error) {
    console.error("[cron/quote-followup] query failed", error);
    // Throwing surfaces the failure to the telemetry wrapper which
    // marks the run failed + writes the error message into cron_runs.
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "object" && error !== null && "message" in error
          ? String((error as { message?: unknown }).message)
          : "unknown";
    throw new Error(`query_failed: ${message}`);
  }

  const stats = { scanned: rows?.length ?? 0, sent: 0, skipped_no_email: 0, failed: 0 };
  const nowMs = Date.now();

  // Drop the no-email rows synchronously so the counter stays deterministic;
  // the send + stamp run concurrently below.
  const pending = (rows ?? []).filter((q) => {
    if (!q.customer?.email) {
      stats.skipped_no_email++;
      return false;
    }
    return true;
  });

  await mapWithConcurrency(pending, SEND_CONCURRENCY, async (q) => {
    const to = q.customer?.email;
    if (!to) return; // already filtered, but keeps the type narrow

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
      return;
    }

    // Stamp only AFTER a confirmed send — the followup_sent_at IS NULL
    // filter is the idempotency guard, so stamping a quote whose email
    // never sent would silently drop its follow-up forever.
    const { error: updErr } = await admin
      .from("quotes")
      .update({ followup_sent_at: new Date().toISOString() })
      .eq("id", q.id);
    if (updErr) {
      stats.failed++;
      console.error("[cron/quote-followup] stamp failed", { id: q.id, updErr });
      return;
    }

    stats.sent++;
  });

  return { ok: true, ...stats };
}

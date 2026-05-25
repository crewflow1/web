import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { emitNotifications } from "@/server/services/notifications-service";
import { notifyOnDemoRequested } from "@/lib/notifications/events";
import {
  demoRequestSchema,
  TURNOVER_LABELS,
  type DemoRequestInput,
} from "@/lib/demo/schema";
import { DEFAULT_LIMITS, enforce } from "@/lib/security/rate-limit";
import { onDemoCreated } from "@/server/services/demo-lifecycle";

/**
 * Public demo-request endpoint. Replaces the previous Server Action
 * approach (which was returning HTTP 500 in production for reasons we
 * couldn't isolate via indirect testing). A plain API route has
 * predictable HTTP semantics, is easy to test from curl, and removes
 * an entire layer of complexity from the critical CTA funnel.
 *
 * Contract:
 *   POST /api/demo
 *   Content-Type: application/json
 *   Body: matches demoRequestSchema
 *
 * Response: always JSON.
 *   200 { ok: true, deduped?: true }
 *   400 { ok: false, error, fieldErrors? }   (validation)
 *   500 { ok: false, error }                  (catch-all; never propagates exception)
 *
 * NEVER throws — every secondary step (internal-org CRM, Resend email,
 * audit columns) has its own try/catch and is best-effort. The only
 * thing that fails the request is a failed insert into demo_requests.
 *
 * Idempotency: same email within 5 minutes returns ok=true, deduped=true.
 */

export const runtime = "nodejs";

const FIVE_MIN_MS = 5 * 60 * 1000;

function logStep(step: string, info?: Record<string, unknown>) {
  console.log(
    JSON.stringify({ event: "demo.submit", step, ...(info ?? {}) }),
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  logStep("invoked");

  // Phase 7 — rate limit: 5 demo requests per IP per 10 minutes.
  const rl = enforce(request, "demo_booking", DEFAULT_LIMITS.demo_booking);
  if (rl) return rl as unknown as NextResponse;

  try {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "Request body must be valid JSON." },
        { status: 400 },
      );
    }

    const parsed = demoRequestSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const k = issue.path[0];
        if (typeof k === "string" && !fieldErrors[k]) fieldErrors[k] = issue.message;
      }
      logStep("validation_failed", { fields: Object.keys(fieldErrors) });
      return NextResponse.json(
        { ok: false, error: "Please fix the highlighted fields.", fieldErrors },
        { status: 400 },
      );
    }
    const data = parsed.data;
    logStep("validation_ok");

    let admin: ReturnType<typeof createAdminClient>;
    try {
      admin = createAdminClient();
    } catch (e) {
      console.error("[demo] admin client init failed", e);
      return NextResponse.json(
        {
          ok: false,
          error:
            "The demo intake service is temporarily unavailable. Please email hello@crewflow.uk while we fix it.",
        },
        { status: 503 },
      );
    }

    // Idempotency.
    try {
      const since = new Date(Date.now() - FIVE_MIN_MS).toISOString();
      const { data: recent } = await admin
        .from("demo_requests")
        .select("id")
        .eq("email", data.email)
        .gte("created_at", since)
        .limit(1)
        .maybeSingle();
      if (recent) {
        logStep("dedup_hit", { request_id: recent.id });
        return NextResponse.json({ ok: true, deduped: true });
      }
    } catch (e) {
      console.error("[demo] dedup check failed (proceeding anyway)", e);
    }

    // SoT write.
    const { data: requestRow, error: insertErr } = await admin
      .from("demo_requests")
      .insert({
        name: data.name,
        company: data.company,
        email: data.email,
        phone: data.phone ?? null,
        employees: data.employees,
        turnover_range: data.turnover_range ?? null,
        current_systems: data.current_systems ?? null,
        preferred_demo_time: data.preferred_demo_time ?? null,
      })
      .select("id")
      .single();
    if (insertErr || !requestRow) {
      console.error("[demo] insert failed", insertErr);
      return NextResponse.json(
        { ok: false, error: "We couldn't save your request. Try again in a moment." },
        { status: 500 },
      );
    }
    logStep("demo_request_inserted", { request_id: requestRow.id });

    // -----------------------------------------------------------------
    // Best-effort side effects, ALL IN PARALLEL.
    //
    // Previously these ran serially: HQ notify → internal lead → HQ
    // email. On a cold lambda the cumulative latency was hitting the
    // browser fetch timeout — first click looked like a network error
    // even though the row was saved, and the user retried, which hit
    // the 5-minute dedup and "succeeded" instantly.
    //
    // Promise.allSettled fans them out so the route returns as soon
    // as the slowest step finishes (typically <2s warm, <4s cold).
    // Every step has its own error handling and audit, so a failure
    // in one doesn't drag down the others.
    // -----------------------------------------------------------------
    const internalOrgId = process.env.CREWFLOW_INTERNAL_ORG_ID;
    let internalLeadId: string | null = null;

    const demoRow = {
      id: requestRow.id,
      name: data.name,
      email: data.email,
      company: data.company,
      phone: data.phone ?? null,
      status: "pending_demo",
      linked_org_id: null,
    };

    await Promise.allSettled([
      // (a) Customer confirmation email + demo.created audit + email_sent
      // /email_failed audit. Best-effort inside onDemoCreated.
      onDemoCreated({ demo: demoRow }).catch((e) => {
        console.error("[demo] onDemoCreated threw", e);
      }),

      // (b) HQ notification fan-out.
      (async () => {
        if (!internalOrgId) {
          logStep("internal_org_unconfigured");
          return;
        }
        try {
          await emitNotifications(
            notifyOnDemoRequested({
              org_id: internalOrgId,
              demo_id: requestRow.id,
              company: data.company,
              contact_name: data.name,
            }),
          );
        } catch (e) {
          console.error("[demo] HQ notification fan-out failed", e);
        }
      })(),

      // (c) Internal CrewFlow org lead (Customer + Lead row).
      (async () => {
        if (!internalOrgId) return;
        try {
          const { data: customer, error: custErr } = await admin
            .from("customers")
            .insert({
              org_id: internalOrgId,
              name: `${data.name} — ${data.company}`,
              email: data.email,
              phone: data.phone ?? null,
              notes: buildLeadNotes(data),
            })
            .select("id")
            .single();
          if (custErr || !customer) {
            console.error("[demo] internal customer insert failed", custErr);
            return;
          }
          const { data: lead, error: leadErr } = await admin
            .from("leads")
            .insert({
              org_id: internalOrgId,
              customer_id: customer.id,
              source: "demo_request",
              service: "CrewFlow demo",
              estimated_value: null,
              notes: data.current_systems ?? null,
            })
            .select("id")
            .single();
          if (leadErr || !lead) {
            console.error("[demo] internal lead insert failed", leadErr);
            return;
          }
          internalLeadId = lead.id;
          await admin
            .from("demo_requests")
            .update({ internal_lead_id: lead.id })
            .eq("id", requestRow.id);
          logStep("internal_lead_created", { lead_id: lead.id });
        } catch (e) {
          console.error("[demo] internal-org wiring failed", e);
        }
      })(),

      // (d) HQ inbox email — "new demo request". Distinct from the
      //     prospect's confirmation email which onDemoCreated handles.
      (async () => {
        try {
          const notifyTo = process.env.DEMO_NOTIFY_EMAIL || "hello@crewflow.uk";
          const notifyFrom =
            process.env.RESEND_NOTIFICATIONS_FROM ||
            "CrewFlow Notifications <notify@crewflow.uk>";
          const emailResult = await sendEmail({
            to: notifyTo,
            from: notifyFrom,
            subject: `New demo request — ${data.company}`,
            html: renderEmail(data, internalLeadId),
            text: renderTextEmail(data, internalLeadId),
            replyTo: data.email,
          });
          if (emailResult.sent) {
            await admin
              .from("demo_requests")
              .update({
                notification_email_id: emailResult.id,
                notification_sent_at: new Date().toISOString(),
              })
              .eq("id", requestRow.id);
            logStep("hq_email_sent", { resend_id: emailResult.id });
          } else {
            const reason =
              emailResult.reason === "error"
                ? `error: ${emailResult.error}`
                : emailResult.reason === "self_loop"
                  ? `self_loop: from=${emailResult.from} to=${emailResult.to}`
                  : emailResult.reason;
            await admin
              .from("demo_requests")
              .update({ notification_error: reason })
              .eq("id", requestRow.id);
            logStep("hq_email_skipped", { reason });
          }
        } catch (e) {
          const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          console.error("[demo] HQ email step failed", e);
          try {
            await admin
              .from("demo_requests")
              .update({ notification_error: `exception: ${msg}` })
              .eq("id", requestRow.id);
          } catch (innerErr) {
            console.error("[demo] notification_error update failed", innerErr);
          }
          logStep("hq_email_exception", { msg });
        }
      })(),
    ]);

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[demo] unexpected failure", e);
    return NextResponse.json(
      {
        ok: false,
        error:
          "Something went wrong on our side. Email hello@crewflow.uk and we will book you in directly.",
      },
      { status: 500 },
    );
  }
}

function buildLeadNotes(d: DemoRequestInput): string {
  const parts = [
    "Demo request from the landing page.",
    `Employees: ${d.employees}.`,
    d.turnover_range ? `Turnover: ${TURNOVER_LABELS[d.turnover_range]}.` : null,
    d.current_systems ? `Current systems: ${d.current_systems}.` : null,
    d.preferred_demo_time ? `Preferred time: ${d.preferred_demo_time}.` : null,
  ].filter(Boolean);
  return parts.join(" ");
}

function renderEmail(d: DemoRequestInput, leadId: string | null): string {
  const turnover = d.turnover_range ? TURNOVER_LABELS[d.turnover_range] : "—";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://crewflow.uk";
  // CEO-directive routing fix: the link must take the recipient to the
  // approval panel, not into some randomly-picked customer workspace's
  // CRM lead view. Previous /leads/<id> link bounced super-admins to
  // /access-pending or /onboarding depending on cookie state.
  const adminLink = `<p style="margin-top: 16px;">Review &amp; approve in CrewFlow HQ: <a href="${appUrl}/admin/organizations" style="color:#0f172a;font-weight:600">${appUrl}/admin/organizations</a></p>`;
  // Internal CRM lead remains tracked in the audit — link it for ops
  // visibility but DON'T make it the headline CTA.
  const leadLink = leadId
    ? `<p style="margin-top: 8px;color:#64748b;font-size:12px">Internal CRM lead: <a href="${appUrl}/leads/${leadId}" style="color:#64748b">/leads/${leadId.slice(0, 8)}…</a> (admin only)</p>`
    : "";
  return `
<div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto;">
  <h1 style="font-size: 20px; margin: 0 0 12px;">New demo request</h1>
  <p style="color: #475569; margin: 0 0 20px;">Someone booked through the landing page.</p>
  <table style="width: 100%; border-collapse: collapse;">
    <tr><td style="padding: 6px 0; color: #64748b; width: 160px;">Name</td><td style="padding: 6px 0; font-weight: 600;">${esc(d.name)}</td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">Company</td><td style="padding: 6px 0; font-weight: 600;">${esc(d.company)}</td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">Email</td><td style="padding: 6px 0;"><a href="mailto:${esc(d.email)}">${esc(d.email)}</a></td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">Phone</td><td style="padding: 6px 0;">${esc(d.phone ?? "—")}</td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">Employees</td><td style="padding: 6px 0;">${esc(d.employees)}</td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">Turnover</td><td style="padding: 6px 0;">${esc(turnover)}</td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">Current systems</td><td style="padding: 6px 0;">${esc(d.current_systems ?? "—")}</td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">Preferred time</td><td style="padding: 6px 0;">${esc(d.preferred_demo_time ?? "—")}</td></tr>
  </table>
  <p style="margin: 24px 0 8px;">
    <a href="${appUrl}/admin/organizations" style="background:#0f172a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600">Review &amp; approve in CrewFlow HQ</a>
  </p>
  ${adminLink}
  ${leadLink}
</div>`;
}

function renderTextEmail(d: DemoRequestInput, leadId: string | null): string {
  const turnover = d.turnover_range ? TURNOVER_LABELS[d.turnover_range] : "—";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://crewflow.uk";
  return [
    "New demo request",
    "",
    `Name:     ${d.name}`,
    `Company:  ${d.company}`,
    `Email:    ${d.email}`,
    `Phone:    ${d.phone ?? "—"}`,
    `Employees: ${d.employees}`,
    `Turnover: ${turnover}`,
    `Current:  ${d.current_systems ?? "—"}`,
    `Time:     ${d.preferred_demo_time ?? "—"}`,
    "",
    `Review & approve: ${appUrl}/admin/organizations`,
    leadId ? `Internal CRM lead: ${appUrl}/leads/${leadId}` : "",
  ].join("\n");
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

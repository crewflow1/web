import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import {
  demoRequestSchema,
  TURNOVER_LABELS,
  type DemoRequestInput,
} from "@/lib/demo/schema";

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

    // Best-effort: internal CrewFlow org lead.
    const internalOrgId = process.env.CREWFLOW_INTERNAL_ORG_ID;
    let internalLeadId: string | null = null;
    if (internalOrgId) {
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
        } else {
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
          } else {
            internalLeadId = lead.id;
            await admin
              .from("demo_requests")
              .update({ internal_lead_id: lead.id })
              .eq("id", requestRow.id);
            logStep("internal_lead_created", { lead_id: lead.id });
          }
        }
      } catch (e) {
        console.error("[demo] internal-org wiring failed", e);
      }
    } else {
      logStep("internal_org_unconfigured");
    }

    // Best-effort: Resend email + audit columns.
    try {
      const notifyTo = process.env.DEMO_NOTIFY_EMAIL || "hello@crewflow.uk";
      const emailResult = await sendEmail({
        to: notifyTo,
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
        logStep("email_sent", { resend_id: emailResult.id });
      } else {
        const reason =
          "reason" in emailResult
            ? "error" in emailResult
              ? `${emailResult.reason}: ${emailResult.error}`
              : emailResult.reason
            : "unknown";
        await admin
          .from("demo_requests")
          .update({ notification_error: reason })
          .eq("id", requestRow.id);
        logStep("email_skipped", { reason });
      }
    } catch (e) {
      console.error("[demo] email step failed", e);
    }

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
  const leadLink = leadId
    ? `<p style="margin-top: 16px;">View in dashboard: <a href="${appUrl}/leads/${leadId}">${appUrl}/leads/${leadId.slice(0, 8)}…</a></p>`
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
    leadId ? `\nDashboard: ${appUrl}/leads/${leadId}` : "",
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

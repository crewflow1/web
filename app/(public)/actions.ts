"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { demoRequestSchema, TURNOVER_LABELS } from "@/lib/demo/schema";

/**
 * Public demo-request submission. Called from the landing-page modal.
 *
 * Bulletproof contract: NEVER throws. Always returns a structured
 * DemoSubmitResult so the client modal renders a friendly error instead
 * of triggering Next.js's generic "Something went wrong" boundary. The
 * only path that returns `{ ok: true }` is one where the
 * demo_requests row was written successfully — every secondary step
 * (internal-org CRM, Resend email, audit columns) is best-effort and
 * its failure is logged + recorded but doesn't block success.
 *
 * Idempotency: if the same email submitted in the last 5 minutes, we
 * return ok=true without writing a duplicate row.
 */

export type DemoSubmitResult =
  | { ok: true; deduped?: boolean }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

const FIVE_MIN_MS = 5 * 60 * 1000;

function logStep(step: string, info?: Record<string, unknown>) {
  // Structured logs so Vercel runtime traces are readable. Always JSON so
  // log queries can grep on a field name. Never log full email + company
  // together to avoid PII spray; just shape + length.
  console.log(
    JSON.stringify({ event: "demo.submit", step, ...(info ?? {}) }),
  );
}

export async function submitDemoRequest(formData: FormData): Promise<DemoSubmitResult> {
  // Smoke-log at the absolute first line so we can tell from `vercel logs`
  // whether the action body ever executes. If you don't see this in logs,
  // the failure is in middleware / module load / RSC dispatch — NOT here.
  console.log("[demo] submitDemoRequest invoked");
  try {
    // 1. Validate -----------------------------------------------------------
    const raw = {
      name: formData.get("name"),
      company: formData.get("company"),
      email: formData.get("email"),
      phone: formData.get("phone"),
      employees: formData.get("employees"),
      turnover_range: formData.get("turnover_range") || undefined,
      current_systems: formData.get("current_systems"),
      preferred_demo_time: formData.get("preferred_demo_time"),
    };
    const parsed = demoRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const k = issue.path[0];
        if (typeof k === "string" && !fieldErrors[k]) fieldErrors[k] = issue.message;
      }
      logStep("validation_failed", { fields: Object.keys(fieldErrors) });
      return { ok: false, error: "Please fix the highlighted fields.", fieldErrors };
    }
    const data = parsed.data;
    logStep("validation_ok");

    // 2. Build the admin client. If env is missing, surface a clean error
    //    instead of throwing — the modal needs to show a real message.
    let admin: ReturnType<typeof createAdminClient>;
    try {
      admin = createAdminClient();
    } catch (e) {
      console.error("[demo] admin client init failed", e);
      return {
        ok: false,
        error: "The demo intake service is temporarily unavailable. Please email hello@crewflow.uk while we fix it.",
      };
    }
    logStep("admin_client_ok");

    // 3. Idempotency: if same email submitted in the last 5 minutes, no-op.
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
        return { ok: true, deduped: true };
      }
    } catch (e) {
      // Don't block — proceed to insert. The unique-by-(email+5min) check is
      // best-effort; a transient SELECT failure shouldn't break submission.
      console.error("[demo] dedup check failed (proceeding anyway)", e);
    }

    // 4. INSERT the source-of-truth row.
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
      return {
        ok: false,
        error: "We couldn't save your request. Try again in a moment.",
      };
    }
    logStep("demo_request_inserted", { request_id: requestRow.id });

    // 5. Best-effort: write into the internal CrewFlow org as a lead.
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

    // 6. Best-effort: notify owner via Resend + record the message ID.
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
          .eq("id", requestRow.id)
          .then(
            () => {},
            (e) => console.error("[demo] audit update (sent) failed", e),
          );
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
          .eq("id", requestRow.id)
          .then(
            () => {},
            (e) => console.error("[demo] audit update (error) failed", e),
          );
        logStep("email_skipped", { reason });
      }
    } catch (e) {
      console.error("[demo] email step failed", e);
    }

    return { ok: true };
  } catch (e) {
    // Catch-all: anything that escapes the inner try/catches lands here
    // so the modal never sees a thrown rejection. Logged + reported to
    // the user as a generic-but-civil message.
    console.error("[demo] unexpected failure", e);
    return {
      ok: false,
      error: "Something went wrong on our side. Email hello@crewflow.uk and we will book you in directly.",
    };
  }
}

// -------------------------------------------------------------------------

function buildLeadNotes(d: import("@/lib/demo/schema").DemoRequestInput): string {
  const parts = [
    "Demo request from the landing page.",
    `Employees: ${d.employees}.`,
    d.turnover_range ? `Turnover: ${TURNOVER_LABELS[d.turnover_range]}.` : null,
    d.current_systems ? `Current systems: ${d.current_systems}.` : null,
    d.preferred_demo_time ? `Preferred time: ${d.preferred_demo_time}.` : null,
  ].filter(Boolean);
  return parts.join(" ");
}

function renderEmail(d: import("@/lib/demo/schema").DemoRequestInput, leadId: string | null): string {
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
    <tr><td style="padding: 6px 0; color: #64748b; width: 160px;">Name</td><td style="padding: 6px 0; font-weight: 600;">${escapeHtml(d.name)}</td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">Company</td><td style="padding: 6px 0; font-weight: 600;">${escapeHtml(d.company)}</td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">Email</td><td style="padding: 6px 0;"><a href="mailto:${escapeHtml(d.email)}">${escapeHtml(d.email)}</a></td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">Phone</td><td style="padding: 6px 0;">${escapeHtml(d.phone ?? "—")}</td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">Employees</td><td style="padding: 6px 0;">${escapeHtml(d.employees)}</td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">Turnover</td><td style="padding: 6px 0;">${escapeHtml(turnover)}</td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">Current systems</td><td style="padding: 6px 0;">${escapeHtml(d.current_systems ?? "—")}</td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">Preferred time</td><td style="padding: 6px 0;">${escapeHtml(d.preferred_demo_time ?? "—")}</td></tr>
  </table>
  ${leadLink}
</div>`;
}

function renderTextEmail(d: import("@/lib/demo/schema").DemoRequestInput, leadId: string | null): string {
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

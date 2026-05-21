"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { demoRequestSchema, TURNOVER_LABELS } from "@/lib/demo/schema";

/**
 * Public demo-request submission. Called from the landing page modal.
 *
 *   1. Validate via Zod.
 *   2. Insert into demo_requests (RLS allows anon insert).
 *   3. If CREWFLOW_INTERNAL_ORG_ID is set, also create a customer + lead
 *      inside the internal org so the CEO sees it on their dashboard.
 *   4. Email hello@crewflow.uk via Resend (best-effort — soft-fails).
 *
 * Returns a structured result so the client modal can show success / error
 * inline instead of doing the redirect-with-querystring dance.
 */

export type DemoSubmitResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export async function submitDemoRequest(formData: FormData): Promise<DemoSubmitResult> {
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
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors };
  }

  const data = parsed.data;
  const admin = createAdminClient();

  // 1. Record the demo request (source of truth).
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
  if (insertErr) {
    console.error("[demo] insert failed", insertErr);
    return { ok: false, error: "We couldn't save your request. Try again." };
  }

  // 2. Optional: write into the internal CrewFlow org as a lead.
  const internalOrgId = process.env.CREWFLOW_INTERNAL_ORG_ID;
  let internalLeadId: string | null = null;
  if (internalOrgId) {
    try {
      const { data: customer } = await admin
        .from("customers")
        .insert({
          org_id: internalOrgId,
          name: `${data.name} — ${data.company}`,
          email: data.email,
          phone: data.phone ?? null,
          notes: `Demo request. Employees: ${data.employees}. ${
            data.turnover_range ? `Turnover: ${TURNOVER_LABELS[data.turnover_range]}. ` : ""
          }${data.current_systems ? `Current systems: ${data.current_systems}. ` : ""}${
            data.preferred_demo_time ? `Preferred: ${data.preferred_demo_time}.` : ""
          }`,
        })
        .select("id")
        .single();

      if (customer) {
        const { data: lead } = await admin
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
        if (lead) {
          internalLeadId = lead.id;
          await admin
            .from("demo_requests")
            .update({ internal_lead_id: lead.id })
            .eq("id", requestRow.id);
        }
      }
    } catch (e) {
      console.error("[demo] internal-org wiring failed", e);
      // Don't fail the whole submit — the demo_requests row is the SOT.
    }
  }

  // 3. Notify the owner via Resend. Record the message ID + outcome on
  //    the demo_requests row so we have a verifiable audit trail (no
  //    "did the email actually send?" mystery on future submissions).
  const notifyTo = process.env.DEMO_NOTIFY_EMAIL || "hello@crewflow.uk";
  const emailResult = await sendEmail({
    to: notifyTo,
    subject: `New demo request — ${data.company}`,
    html: renderEmail(data, internalLeadId),
    text: renderTextEmail(data, internalLeadId),
    replyTo: data.email,
  }).catch((e) => {
    console.error("[demo] email failed", e);
    return { sent: false as const, reason: "error" as const, error: (e as Error).message };
  });
  if (emailResult.sent) {
    await admin
      .from("demo_requests")
      .update({
        notification_email_id: emailResult.id,
        notification_sent_at: new Date().toISOString(),
      })
      .eq("id", requestRow.id);
  } else {
    await admin
      .from("demo_requests")
      .update({
        notification_error:
          "reason" in emailResult
            ? `${emailResult.reason}${"error" in emailResult ? `: ${emailResult.error}` : ""}`
            : "unknown",
      })
      .eq("id", requestRow.id);
  }

  return { ok: true };
}

function renderEmail(d: import("@/lib/demo/schema").DemoRequestInput, leadId: string | null): string {
  const turnover = d.turnover_range ? TURNOVER_LABELS[d.turnover_range] : "—";
  const leadLink = leadId
    ? `<p>View in dashboard: <a href="${process.env.NEXT_PUBLIC_APP_URL}/leads/${leadId}">/leads/${leadId.slice(0, 8)}</a></p>`
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
    leadId ? `\nDashboard: ${process.env.NEXT_PUBLIC_APP_URL}/leads/${leadId}` : "",
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

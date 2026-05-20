"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { demoRequestSchema, type DemoRequestInput } from "@/lib/demo/schema";

/**
 * Public demo-request submission. Called from the landing page modal.
 *
 *   1. Validate via Zod (inline field errors back to the client).
 *   2. Insert into demo_requests (RLS allows anon insert).
 *   3. If CREWFLOW_INTERNAL_ORG_ID is set, also create a customer + lead
 *      inside the internal org so the CEO sees it on /dashboard.
 *      The leads.created trigger writes activity_log + notifications.
 *   4. Email the owner via Resend (best-effort — soft-fails).
 *
 * Returns a structured result so the modal can show success / error
 * inline instead of redirecting with a querystring.
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
    staff_count: formData.get("staff_count"),
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

  // 1. Source-of-truth row.
  const { data: requestRow, error: insertErr } = await admin
    .from("demo_requests")
    .insert({
      name: data.name,
      company: data.company,
      email: data.email,
      phone: data.phone,
      employees: data.staff_count,
      current_systems: data.current_systems ?? null,
      preferred_demo_time: data.preferred_demo_time ?? null,
    })
    .select("id")
    .single();
  if (insertErr) {
    console.error("[demo] insert failed", insertErr);
    return { ok: false, error: "We couldn't save your request. Try again." };
  }

  // 2. Optional: write into the internal CrewFlow org as a lead so it
  //    appears on the owner's dashboard + fires bell notifications.
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
          phone: data.phone,
          notes: buildLeadNotes(data),
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
      // Don't fail the whole submit — the demo_requests row is the SoT.
    }
  }

  // 3. Notify the owner via Resend (best-effort).
  const notifyTo = process.env.DEMO_NOTIFY_EMAIL || "hello@crewflow.uk";
  await sendEmail({
    to: notifyTo,
    subject: `New demo request — ${data.company}`,
    html: renderHtml(data, internalLeadId),
    text: renderText(data, internalLeadId),
    replyTo: data.email,
  }).catch((e) => {
    console.error("[demo] email failed", e);
    return null;
  });

  return { ok: true };
}

function buildLeadNotes(d: DemoRequestInput): string {
  const parts = [
    `Demo request from the landing page.`,
    `Staff: ${d.staff_count}.`,
    d.current_systems ? `Current systems: ${d.current_systems}.` : null,
    d.preferred_demo_time ? `Preferred time: ${d.preferred_demo_time}.` : null,
  ].filter(Boolean);
  return parts.join(" ");
}

function renderHtml(d: DemoRequestInput, leadId: string | null): string {
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
    <tr><td style="padding: 6px 0; color: #64748b;">Phone</td><td style="padding: 6px 0;">${esc(d.phone)}</td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">Staff</td><td style="padding: 6px 0;">${esc(d.staff_count)}</td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">Current systems</td><td style="padding: 6px 0;">${esc(d.current_systems ?? "—")}</td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">Preferred time</td><td style="padding: 6px 0;">${esc(d.preferred_demo_time ?? "—")}</td></tr>
  </table>
  ${leadLink}
</div>`;
}

function renderText(d: DemoRequestInput, leadId: string | null): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://crewflow.uk";
  return [
    "New demo request",
    "",
    `Name:     ${d.name}`,
    `Company:  ${d.company}`,
    `Email:    ${d.email}`,
    `Phone:    ${d.phone}`,
    `Staff:    ${d.staff_count}`,
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

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { formatDateUK } from "@/lib/time/format";

/**
 * Leave-request notification emails.
 *
 * In-app notifications are already fanned out by DB triggers; these add the
 * email channel the workflow was missing. Recipient lookups use the service-
 * role admin client because a staff member can't read other members' emails
 * under RLS, and an owner emailing a different staff member is cross-user.
 * Never throws — failures are logged so they can't break the action.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrap(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;background:#f8fafc;margin:0;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:32px;">
    <h1 style="margin:0 0 16px;font-size:18px;">${escapeHtml(title)}</h1>
    ${bodyHtml}
    <hr style="margin:24px 0 12px;border:none;border-top:1px solid #e2e8f0;"/>
    <p style="margin:0;color:#94a3b8;font-size:11px;">Sent via CrewFlow.</p>
  </div></body></html>`;
}

type LeaveInfo = {
  type: string;
  starts_at: string;
  ends_at: string;
  reason?: string | null;
};

/** Email all owners/admins of an org that a staff member requested leave. */
export async function notifyOwnersOfLeaveRequest(params: {
  orgId: string;
  orgName: string;
  requesterId: string;
  leave: LeaveInfo;
}): Promise<void> {
  try {
    const admin = createAdminClient();

    const { data: requester } = await admin
      .from("users")
      .select("full_name, email")
      .eq("id", params.requesterId)
      .maybeSingle();
    const requesterName = requester?.full_name ?? requester?.email ?? "A team member";

    const { data: members } = await admin
      .from("memberships")
      .select("user_id, role, users(email, full_name)")
      .eq("org_id", params.orgId)
      .in("role", ["owner", "admin"]);

    const recipients = (members ?? [])
      .map((m) => (m.users as { email: string | null } | null)?.email)
      .filter((e): e is string => Boolean(e));
    if (recipients.length === 0) return;

    const range = `${formatDateUK(params.leave.starts_at)} – ${formatDateUK(params.leave.ends_at)}`;
    const subject = `Leave request: ${requesterName} (${params.leave.type})`;
    const html = wrap("New leave request", `
      <p style="margin:0 0 12px;"><strong>${escapeHtml(requesterName)}</strong> requested <strong>${escapeHtml(params.leave.type)}</strong> leave.</p>
      <p style="margin:0 0 12px;color:#475569;">Dates: <strong>${escapeHtml(range)}</strong></p>
      ${params.leave.reason ? `<p style="margin:0 0 12px;color:#475569;white-space:pre-wrap;">Reason: ${escapeHtml(params.leave.reason)}</p>` : ""}
      <p style="margin:16px 0 0;"><a href="${escapeHtml(process.env.NEXT_PUBLIC_APP_URL ?? "")}/staff/leave" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600;">Open approval queue</a></p>
    `);
    const text = `${requesterName} requested ${params.leave.type} leave (${range}).${params.leave.reason ? `\nReason: ${params.leave.reason}` : ""}\n\nApprove or reject: ${process.env.NEXT_PUBLIC_APP_URL ?? ""}/staff/leave`;

    await sendEmail({ to: recipients, subject, html, text });
  } catch (e) {
    console.error("[leave] owner notification email failed", e);
  }
}

/** Email the staff member that their leave was approved or rejected. */
export async function notifyStaffOfLeaveDecision(params: {
  requesterId: string;
  orgName: string;
  decision: "approved" | "rejected";
  leave: LeaveInfo;
  note?: string | null;
}): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: requester } = await admin
      .from("users")
      .select("full_name, email")
      .eq("id", params.requesterId)
      .maybeSingle();
    const to = requester?.email;
    if (!to) return;

    const range = `${formatDateUK(params.leave.starts_at)} – ${formatDateUK(params.leave.ends_at)}`;
    const verb = params.decision === "approved" ? "approved" : "rejected";
    const subject = `Your leave request was ${verb}`;
    const html = wrap(`Leave ${verb}`, `
      <p style="margin:0 0 12px;">Your <strong>${escapeHtml(params.leave.type)}</strong> leave for <strong>${escapeHtml(range)}</strong> was <strong>${verb}</strong>${params.orgName ? ` by ${escapeHtml(params.orgName)}` : ""}.</p>
      ${params.note ? `<p style="margin:0 0 12px;color:#475569;white-space:pre-wrap;">Note: ${escapeHtml(params.note)}</p>` : ""}
      <p style="margin:16px 0 0;"><a href="${escapeHtml(process.env.NEXT_PUBLIC_APP_URL ?? "")}/staff/leave" style="color:#0f172a;">View your leave</a></p>
    `);
    const text = `Your ${params.leave.type} leave for ${range} was ${verb}.${params.note ? `\nNote: ${params.note}` : ""}`;

    await sendEmail({ to, subject, html, text });
  } catch (e) {
    console.error("[leave] staff decision email failed", e);
  }
}

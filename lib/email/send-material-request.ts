import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { formatDateUK } from "@/lib/time/format";

/**
 * Material-request notification emails.
 *
 * THIS IS NOT A NEW CHANNEL. It is the SAME internal-approval email pattern
 * lib/email/send-leave.ts already ships for leave requests — the closest
 * analogue in the product (a member raises, an admin decides, the raiser may
 * withdraw while pending). Two emails, both of which a human is already
 * waiting on:
 *
 *   · submit  → the owners/admins who have to decide
 *   · decide  → the one person whose request it was
 *
 * Nothing else emails. No digests, no "your request is still pending"
 * reminders, no CC to the whole office — a materials request happens several
 * times a day on a live site, and an email per event is how a team learns to
 * filter the sender.
 *
 * Recipient lookups use the service-role admin client because a staff member
 * cannot read other members' emails under RLS, and an admin emailing the
 * requester is cross-user. Every read is org-pinned regardless.
 *
 * NEVER THROWS — failures are logged so they can't break the action. The
 * in-app notification is the reliable channel; email is the nudge.
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

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "";
}

export type MaterialRequestEmailInfo = {
  number: string;
  jobTitle: string | null;
  neededBy: string | null;
  priority: string;
  lineCount: number;
  /** A couple of lines, for the "what are they asking for" preview. */
  preview: string[];
};

function detailHtml(info: MaterialRequestEmailInfo): string {
  const bits: string[] = [];
  if (info.jobTitle) {
    bits.push(`<p style="margin:0 0 8px;color:#475569;">Job: <strong>${escapeHtml(info.jobTitle)}</strong></p>`);
  }
  if (info.neededBy) {
    bits.push(
      `<p style="margin:0 0 8px;color:#475569;">Needed by: <strong>${escapeHtml(formatDateUK(info.neededBy))}</strong></p>`,
    );
  }
  if (info.preview.length > 0) {
    const items = info.preview.map((p) => `<li>${escapeHtml(p)}</li>`).join("");
    const more =
      info.lineCount > info.preview.length
        ? `<li>…and ${info.lineCount - info.preview.length} more</li>`
        : "";
    bits.push(`<ul style="margin:0 0 12px;padding-left:18px;color:#475569;">${items}${more}</ul>`);
  }
  return bits.join("");
}

/** Email the owners/admins that a material request needs a decision. */
export async function notifyAdminsOfMaterialRequest(params: {
  orgId: string;
  requesterId: string | null;
  request: MaterialRequestEmailInfo;
}): Promise<void> {
  try {
    const admin = createAdminClient();

    let requesterName = "A team member";
    if (params.requesterId) {
      // Best-effort: a failed name lookup degrades to "A team member", which
      // is honest. Bound and logged rather than discarded so it is visible.
      const { data: requester, error: requesterError } = await admin
        .from("users")
        .select("full_name, email")
        .eq("id", params.requesterId)
        .maybeSingle();
      if (requesterError) {
        console.error("[material-request] requester name lookup failed", requesterError);
      }
      requesterName = requester?.full_name ?? requester?.email ?? requesterName;
    }

    const { data: members, error: membersError } = await admin
      .from("memberships")
      .select("user_id, role, users(email, full_name)")
      .eq("org_id", params.orgId) // ORG PIN
      .in("role", ["owner", "admin"]);
    if (membersError) {
      // PostgREST errors RETURN — without this the catch below never fires and
      // the approvers silently never hear about the request (the exact bug the
      // leave-request version had to fix).
      console.error("[material-request] approver recipients load failed", membersError);
      return;
    }

    const recipients = (members ?? [])
      .map((m) => (m.users as { email: string | null } | null)?.email)
      .filter((e): e is string => Boolean(e));
    if (recipients.length === 0) return;

    const urgent = params.request.priority === "urgent";
    const subject = `${urgent ? "URGENT — " : ""}Materials requested: ${params.request.number}${
      params.request.jobTitle ? ` (${params.request.jobTitle})` : ""
    }`;
    const html = wrap(
      "Materials need approving",
      `<p style="margin:0 0 12px;"><strong>${escapeHtml(requesterName)}</strong> requested materials${
        urgent ? ` and marked it <strong style="color:#b91c1c;">urgent</strong>` : ""
      }.</p>
      ${detailHtml(params.request)}
      <p style="margin:16px 0 0;"><a href="${escapeHtml(appUrl())}/materials/requests" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600;">Open the request queue</a></p>`,
    );
    const text =
      `${requesterName} requested materials (${params.request.number})` +
      `${params.request.jobTitle ? ` for ${params.request.jobTitle}` : ""}` +
      `${params.request.neededBy ? `, needed by ${formatDateUK(params.request.neededBy)}` : ""}.` +
      `${params.request.preview.length ? `\n\n${params.request.preview.join("\n")}` : ""}` +
      `\n\nApprove or reject: ${appUrl()}/materials/requests`;

    await sendEmail({ to: recipients, subject, html, text });
  } catch (e) {
    console.error("[material-request] approver notification email failed", e);
  }
}

/** Email the requester that their material request was approved or rejected. */
export async function notifyRequesterOfMaterialDecision(params: {
  requesterId: string | null;
  decision: "approved" | "rejected";
  request: MaterialRequestEmailInfo;
  reason?: string | null;
}): Promise<void> {
  try {
    if (!params.requesterId) return;
    const admin = createAdminClient();
    const { data: requester, error: requesterError } = await admin
      .from("users")
      .select("full_name, email")
      .eq("id", params.requesterId)
      .maybeSingle();
    if (requesterError) {
      console.error("[material-request] decision recipient load failed", requesterError);
      return;
    }
    const to = requester?.email;
    if (!to) return;

    const verb = params.decision === "approved" ? "approved" : "rejected";
    const subject = `Materials ${verb}: ${params.request.number}`;
    const html = wrap(
      `Materials ${verb}`,
      `<p style="margin:0 0 12px;">Your materials request <strong>${escapeHtml(params.request.number)}</strong> was <strong>${verb}</strong>.</p>
      ${detailHtml(params.request)}
      ${
        params.reason
          ? `<p style="margin:0 0 12px;color:#475569;white-space:pre-wrap;">Reason: ${escapeHtml(params.reason)}</p>`
          : ""
      }
      <p style="margin:16px 0 0;"><a href="${escapeHtml(appUrl())}/materials/requests" style="color:#0f172a;">View the request</a></p>`,
    );
    const text =
      `Your materials request ${params.request.number} was ${verb}.` +
      `${params.reason ? `\nReason: ${params.reason}` : ""}` +
      `\n\n${appUrl()}/materials/requests`;

    await sendEmail({ to, subject, html, text });
  } catch (e) {
    console.error("[material-request] requester decision email failed", e);
  }
}

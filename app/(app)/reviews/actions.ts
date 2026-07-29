"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { sendEmail } from "@/lib/email/send";

/**
 * Phase H — Review request actions.
 *
 *   createReviewRequestAction → operator schedules a review for a
 *     completed job (or a customer directly).
 *
 *   markReviewCompletedAction / cancelReviewRequestAction →
 *     lifecycle transitions.
 *
 *   emailReviewRequestNow → owner clicks "Send email now". Uses Resend
 *     when configured; falls back to opening a mailto: URL via the UI
 *     if we can't actually send.
 */

const PLATFORMS = ["google", "facebook", "trustpilot", "other"] as const;
const DELAY = z.coerce.number().refine((v) => v === 0 || v === 3 || v === 7, {
  message: "Delay must be 0, 3, or 7 days",
});

const createSchema = z.object({
  customer_id: z.string().uuid(),
  job_id: z
    .string()
    .uuid()
    .optional()
    .or(z.literal("").transform(() => undefined)),
  platform: z.enum(PLATFORMS),
  delay_days: DELAY,
  notes: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

const idSchema = z.string().uuid();

/**
 * A chainable UPDATE filter for `review_requests` (not in the generated
 * Supabase types, hence the cast style this file already uses).
 *
 * Every by-id write below carries `.eq("org_id", ctx.org.id)` on top of
 * `.eq("id", id)`. `review_requests`' RLS is `org_id in current_org_ids()`,
 * which admits EVERY org the caller belongs to — so a dual-org member working
 * in org A could complete, cancel or SEND org B's review requests from A's
 * shell. The email path is the serious one: it resolved the request from org
 * B but composed the message from `ctx.org.id`, so org B's customer received
 * an email under org A's name. Same wrong-letterhead class as the job
 * certificates in #456.
 */
type ReviewUpd = PromiseLike<{ error: { message: string } | null }> & {
  eq: (k: string, v: unknown) => ReviewUpd;
};

export async function createReviewRequestAction(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const parsed = createSchema.safeParse({
    customer_id: formData.get("customer_id") ?? "",
    job_id: formData.get("job_id") ?? "",
    platform: formData.get("platform") ?? "google",
    delay_days: formData.get("delay_days") ?? "0",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "validation";
    redirect(`/reviews/new?error=${encodeURIComponent(msg)}`);
  }

  const data = parsed.success ? parsed.data : null;
  if (!data) redirect("/reviews/new?error=validation");

  const sendAt = new Date(Date.now() + data.delay_days * 86_400_000).toISOString();

  const tenant = await createClient();
  const { data: row, error } = await (
    tenant.from("review_requests" as never) as unknown as {
      insert: (r: unknown) => {
        select: (cols: string) => {
          single: () => Promise<{
            data: { id: string } | null;
            error: { message: string } | null;
          }>;
        };
      };
    }
  )
    .insert({
      org_id: ctx.org.id,
      customer_id: data.customer_id,
      job_id: data.job_id ?? null,
      platform: data.platform,
      delay_days: data.delay_days,
      send_at: sendAt,
      status: "scheduled",
      requested_by: user.id,
      notes: data.notes ?? null,
    })
    .select("id")
    .single();

  if (error || !row) {
    console.error("[reviews] create failed", error);
    redirect("/reviews/new?error=insert_failed");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "review_request.created",
    targetTable: "review_requests",
    targetId: row?.id ?? "",
    metadata: {
      platform: data.platform,
      delay_days: data.delay_days,
      customer_id: data.customer_id,
    },
  });

  revalidatePath("/reviews");
  redirect(`/reviews?saved=created`);
}

export async function markReviewCompletedAction(id: string): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/reviews?error=bad_id");
  const tenant = await createClient();
  const { error } = await (
    tenant.from("review_requests" as never) as unknown as {
      update: (r: unknown) => ReviewUpd;
    }
  )
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", id)
    // Active-org pin — see the note above ReviewUpd.
    .eq("org_id", ctx.org.id);
  if (error) redirect(`/reviews?error=update_failed`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "review_request.completed",
    targetTable: "review_requests",
    targetId: id,
    metadata: null,
  });

  revalidatePath("/reviews");
  redirect(`/reviews?saved=completed`);
}

export async function cancelReviewRequestAction(id: string): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/reviews?error=bad_id");
  const tenant = await createClient();
  const { error } = await (
    tenant.from("review_requests" as never) as unknown as {
      update: (r: unknown) => ReviewUpd;
    }
  )
    .update({ status: "cancelled" })
    .eq("id", id)
    // Active-org pin — see the note above ReviewUpd.
    .eq("org_id", ctx.org.id);
  if (error) redirect(`/reviews?error=update_failed`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "review_request.cancelled",
    targetTable: "review_requests",
    targetId: id,
    metadata: null,
  });

  revalidatePath("/reviews");
  redirect(`/reviews?saved=cancelled`);
}

/**
 * Send the review-request email to the customer NOW (regardless of
 * scheduled send_at). Uses Resend when configured.
 */
export async function emailReviewRequestNow(id: string): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/reviews?error=bad_id");

  const tenant = await createClient();
  const admin = createAdminClient();

  type ReviewRow = {
    id: string;
    customer_id: string | null;
    job_id: string | null;
    platform: string;
    status: string;
    customer: { name: string | null; email: string | null } | null;
  };
  type ReviewSel = {
    eq: (k: string, v: unknown) => ReviewSel;
    maybeSingle: () => Promise<{ data: ReviewRow | null }>;
  };
  // ACTIVE-org pin. This action SENDS AN EMAIL to the customer on the request,
  // signed with the name of `ctx.org.id`. Unpinned, a dual-org member working
  // in org A could load org B's review request and mail B's customer under A's
  // company name — a real outbound message asserting the wrong identity, plus
  // B's customer email address used from A's shell.
  const { data: review } = await (
    tenant.from("review_requests" as never) as unknown as {
      select: (cols: string) => ReviewSel;
    }
  )
    .select(
      "id, customer_id, job_id, platform, status, customer:customers ( name, email )",
    )
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();

  if (!review) redirect(`/reviews?error=not_found`);
  if (review!.status === "completed" || review!.status === "cancelled") {
    redirect(`/reviews?error=already_resolved`);
  }
  const recipientEmail = review!.customer?.email;
  if (!recipientEmail) {
    redirect(`/reviews/${id}?error=no_email`);
  }

  // Look up org name + a friendly review URL.
  const { data: orgRow } = await admin
    .from("organizations")
    .select("name")
    .eq("id", ctx.org.id)
    .maybeSingle();
  const orgName = orgRow?.name ?? "your contractor";

  const url =
    review!.platform === "google"
      ? "https://www.google.com/search?q=" + encodeURIComponent(`${orgName} reviews`)
      : review!.platform === "facebook"
        ? "https://facebook.com/"
        : review!.platform === "trustpilot"
          ? "https://uk.trustpilot.com/"
          : "";

  const subject = `Quick favour — would you mind leaving us a review?`;
  const html = `
    <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 560px; color: #0f172a;">
      <p>Hi ${escapeHtml(review!.customer?.name ?? "there")},</p>
      <p>Thanks again for choosing ${escapeHtml(orgName)}. If you have a couple of minutes, we&rsquo;d be hugely grateful if you could leave us a short review.</p>
      ${url ? `<p><a href="${escapeHtml(url)}" style="display: inline-block; background:#0f172a; color:#fff; padding:10px 16px; border-radius:6px; text-decoration:none;">Leave a ${escapeHtml(review!.platform)} review</a></p>` : `<p>Reply to this email if you&rsquo;re happy to leave a quick ${escapeHtml(review!.platform)} review and we&rsquo;ll send you the link.</p>`}
      <p style="margin-top: 24px;">Thanks,<br/>${escapeHtml(orgName)}</p>
    </div>
  `;
  const text = `Hi ${review!.customer?.name ?? "there"},\n\nThanks again for choosing ${orgName}. If you have a couple of minutes, we'd be hugely grateful if you could leave us a short review.\n\n${url || `Reply to this email if you're happy to leave a ${review!.platform} review and we'll send you the link.`}\n\nThanks,\n${orgName}`;

  const result = await sendEmail({
    to: recipientEmail!,
    subject,
    html,
    text,
  });

  if (!result.sent) {
    console.error("[reviews] email send failed", result);
    redirect(`/reviews/${id}?error=email_${result.reason}`);
  }

  // Stamp sent_at + status='sent' so the cron skips this row.
  await (
    tenant.from("review_requests" as never) as unknown as {
      update: (r: unknown) => ReviewUpd;
    }
  )
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
    })
    .eq("id", id)
    // Active-org pin — see the note above ReviewUpd. The read above is pinned
    // too, so this can only ever match the row we just mailed.
    .eq("org_id", ctx.org.id);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "review_request.emailed",
    targetTable: "review_requests",
    targetId: id,
    metadata: {
      to: recipientEmail!,
      platform: review!.platform,
      message_id: result.sent ? result.id : null,
    },
  });

  revalidatePath("/reviews");
  redirect(`/reviews?saved=emailed`);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

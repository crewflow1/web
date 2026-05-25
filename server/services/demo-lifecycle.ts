import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail, type SendEmailResult } from "@/lib/email/send";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  demoApprovedEmail,
  demoConfirmationEmail,
  demoContactedEmail,
  onboardingWelcomeEmail,
  paymentReceivedEmail,
  setupPaymentEmail,
} from "@/lib/email/demo-templates";
import { env } from "@/lib/env";

/**
 * Demo → customer lifecycle service.
 *
 * One function per lifecycle event. Each:
 *   1. Performs the business operation (create org, send email, etc).
 *   2. Audits success/failure to admin_activity_log (so the timeline
 *      shows the actual work, not just the status flip).
 *   3. Returns a structured result the caller can surface in the UI.
 *
 * The status flip itself is the caller's responsibility — these
 * helpers are about the *side effects*. That keeps the caller's
 * action handler thin and lets us reuse the helpers from elsewhere
 * (e.g. a future webhook-driven payment flow).
 */

export type DemoRow = {
  id: string;
  name: string | null;
  email: string;
  company: string;
  phone: string | null;
  status: string;
  linked_org_id: string | null;
};

export type LifecycleResult<Extra = Record<string, unknown>> = {
  ok: boolean;
  /** Steps that completed successfully — surfaced in the UI banner. */
  done: string[];
  /** Steps that errored — surfaced in the UI banner. */
  failed: { step: string; reason: string }[];
  /** Extra side-effect data (e.g. created org_id). */
  meta?: Extra;
};

// ===========================================================================
// Helpers
// ===========================================================================

/** Compose sendEmail's tri-state result + audit it. */
async function sendDemoEmail(args: {
  demo: DemoRow;
  subject: string;
  html: string;
  text: string;
  /** Audit event suffix — e.g. "confirmation", "approved", "setup_payment". */
  step: string;
  actor: { id: string | null; email: string | null };
}): Promise<{ ok: boolean; reason: string | null; messageId: string | null }> {
  const result: SendEmailResult = await sendEmail({
    to: args.demo.email,
    subject: args.subject,
    html: args.html,
    text: args.text,
    replyTo: env.RESEND_REPLY_TO,
  });
  if (result.sent) {
    await recordAdminActivity({
      actorId: args.actor.id,
      actorEmail: args.actor.email,
      action: `demo.email_sent`,
      targetTable: "demo_requests",
      targetId: args.demo.id,
      metadata: {
        step: args.step,
        to: args.demo.email,
        subject: args.subject,
        message_id: result.id,
      },
    });
    return { ok: true, reason: null, messageId: result.id };
  }
  const reason =
    result.reason === "error"
      ? `error: ${result.error}`
      : result.reason === "self_loop"
        ? `self_loop: from=${result.from} to=${result.to}`
        : result.reason; // "no_key"
  await recordAdminActivity({
    actorId: args.actor.id,
    actorEmail: args.actor.email,
    action: `demo.email_failed`,
    targetTable: "demo_requests",
    targetId: args.demo.id,
    metadata: {
      step: args.step,
      to: args.demo.email,
      subject: args.subject,
      reason,
    },
  });
  return { ok: false, reason, messageId: null };
}

/** Slugify org name for the slug column (must be globally unique). */
function makeSlug(company: string): string {
  const base = company
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const rand = Math.random().toString(36).slice(2, 7);
  return `${base || "company"}-${rand}`;
}

// ===========================================================================
// 1. Demo created — public form submitted
// ===========================================================================

/**
 * Send the prospect a confirmation email AND audit the demo creation.
 * Called from the public /api/demo route after the demo_requests insert.
 * Best-effort: never throws.
 */
export async function onDemoCreated(args: {
  demo: DemoRow;
}): Promise<LifecycleResult> {
  const done: string[] = [];
  const failed: { step: string; reason: string }[] = [];

  // Audit the creation itself (so the timeline starts with something).
  try {
    await recordAdminActivity({
      actorId: null,
      actorEmail: null,
      action: "demo.created",
      targetTable: "demo_requests",
      targetId: args.demo.id,
      metadata: {
        company: args.demo.company,
        email: args.demo.email,
        source: "public_form",
      },
    });
    done.push("audit_created");
  } catch (e) {
    failed.push({
      step: "audit_created",
      reason: e instanceof Error ? e.message : String(e),
    });
  }

  // Customer confirmation email.
  const email = demoConfirmationEmail({
    name: args.demo.name,
    company: args.demo.company,
  });
  const r = await sendDemoEmail({
    demo: args.demo,
    subject: email.subject,
    html: email.html,
    text: email.text,
    step: "confirmation",
    actor: { id: null, email: null },
  });
  if (r.ok) done.push("email_confirmation");
  else failed.push({ step: "email_confirmation", reason: r.reason ?? "unknown" });

  return { ok: failed.length === 0, done, failed };
}

// ===========================================================================
// 2. Demo contacted — operator clicks "Mark contacted"
// ===========================================================================

export async function onDemoContacted(args: {
  demo: DemoRow;
  actor: { id: string; email: string };
}): Promise<LifecycleResult> {
  const done: string[] = [];
  const failed: { step: string; reason: string }[] = [];

  const email = demoContactedEmail({
    name: args.demo.name,
    company: args.demo.company,
  });
  const r = await sendDemoEmail({
    demo: args.demo,
    subject: email.subject,
    html: email.html,
    text: email.text,
    step: "contacted_ack",
    actor: args.actor,
  });
  if (r.ok) done.push("email_contacted");
  else failed.push({ step: "email_contacted", reason: r.reason ?? "unknown" });

  return { ok: failed.length === 0, done, failed };
}

// ===========================================================================
// 3. Demo won/approved — operator clicks "Approve" / "Mark won"
// ===========================================================================

export async function onDemoApproved(args: {
  demo: DemoRow;
  actor: { id: string; email: string };
}): Promise<LifecycleResult> {
  const done: string[] = [];
  const failed: { step: string; reason: string }[] = [];

  const email = demoApprovedEmail({
    name: args.demo.name,
    company: args.demo.company,
  });
  const r = await sendDemoEmail({
    demo: args.demo,
    subject: email.subject,
    html: email.html,
    text: email.text,
    step: "approved",
    actor: args.actor,
  });
  if (r.ok) done.push("email_approved");
  else failed.push({ step: "email_approved", reason: r.reason ?? "unknown" });

  return { ok: failed.length === 0, done, failed };
}

// ===========================================================================
// 4. Setup payment sent — operator clicks "Send setup payment"
// ===========================================================================

const SETUP_FEE_GBP = 1000;

export async function onSetupPaymentSent(args: {
  demo: DemoRow;
  actor: { id: string; email: string };
}): Promise<LifecycleResult<{ payment_link?: string | null }>> {
  const done: string[] = [];
  const failed: { step: string; reason: string }[] = [];

  // Future: integrate Stripe payment_links here. For now (white-glove model)
  // the email simply explains the setup fee and asks them to reply for
  // instructions. This is consistent with the AI-receptionist white-glove
  // pattern and avoids fake-success when Stripe isn't fully configured.
  const paymentLinkUrl: string | null = null;

  const email = setupPaymentEmail({
    name: args.demo.name,
    company: args.demo.company,
    paymentLinkUrl,
    amountGbp: SETUP_FEE_GBP,
  });
  const r = await sendDemoEmail({
    demo: args.demo,
    subject: email.subject,
    html: email.html,
    text: email.text,
    step: "setup_payment",
    actor: args.actor,
  });
  if (r.ok) done.push("email_setup_payment");
  else failed.push({ step: "email_setup_payment", reason: r.reason ?? "unknown" });

  return {
    ok: failed.length === 0,
    done,
    failed,
    meta: { payment_link: paymentLinkUrl },
  };
}

// ===========================================================================
// 5. Payment received — operator clicks "Mark payment received"
// ===========================================================================

export async function onPaymentReceived(args: {
  demo: DemoRow;
  actor: { id: string; email: string };
}): Promise<LifecycleResult> {
  const done: string[] = [];
  const failed: { step: string; reason: string }[] = [];

  const email = paymentReceivedEmail({
    name: args.demo.name,
    company: args.demo.company,
    amountGbp: SETUP_FEE_GBP,
  });
  const r = await sendDemoEmail({
    demo: args.demo,
    subject: email.subject,
    html: email.html,
    text: email.text,
    step: "payment_received",
    actor: args.actor,
  });
  if (r.ok) done.push("email_payment_received");
  else failed.push({ step: "email_payment_received", reason: r.reason ?? "unknown" });

  return { ok: failed.length === 0, done, failed };
}

// ===========================================================================
// 6. Move to onboarding — provision the customer's tenant
//
// This is the BIG one. Creates everything required for the customer to
// sign in and start using CrewFlow:
//   - public.organizations (status='trial', 14-day trial window)
//   - auth.users via inviteUserByEmail (sends Supabase magic link)
//   - public.users mirror row
//   - public.memberships (owner role)
//   - demo_requests.linked_org_id stamped (for idempotency on retry)
//   - "Welcome — workspace live" email
//   - timeline events for every step
// ===========================================================================

export async function promoteDemoToCustomer(args: {
  demo: DemoRow;
  actor: { id: string; email: string };
}): Promise<
  LifecycleResult<{
    org_id?: string;
    auth_user_id?: string;
    membership_id?: string;
  }>
> {
  const done: string[] = [];
  const failed: { step: string; reason: string }[] = [];
  const meta: {
    org_id?: string;
    auth_user_id?: string;
    membership_id?: string;
  } = {};

  // Idempotency: if this demo already has a linked org, return early.
  if (args.demo.linked_org_id) {
    return {
      ok: true,
      done: ["already_provisioned"],
      failed: [],
      meta: { org_id: args.demo.linked_org_id },
    };
  }

  const admin = createAdminClient();

  // -------------------------------------------------------------------
  // Step 1: create the auth user (sends magic-link automatically).
  //
  // inviteUserByEmail is idempotent at the auth layer — if a user with
  // that email already exists, the call returns the existing user. We
  // attach metadata so /onboarding/join (or /auth/callback) can hydrate
  // their profile.
  // -------------------------------------------------------------------
  let authUserId: string | null = null;
  try {
    const appUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
    const { data: inviteData, error: inviteErr } =
      await admin.auth.admin.inviteUserByEmail(args.demo.email, {
        data: {
          source: "demo_lifecycle",
          demo_id: args.demo.id,
          company: args.demo.company,
          invited_full_name: args.demo.name ?? null,
          invited_phone: args.demo.phone ?? null,
        },
        redirectTo: `${appUrl}/auth/callback`,
      });

    if (inviteErr) {
      // If the user already exists, fetch them instead. Supabase returns a
      // specific 422 with message "User already registered" or similar.
      const msg = inviteErr.message ?? "";
      if (/already (registered|exists|signed)/i.test(msg) || inviteErr.status === 422) {
        const { data: list } = await admin.auth.admin.listUsers();
        const existing = list?.users.find(
          (u) => u.email?.toLowerCase() === args.demo.email.toLowerCase(),
        );
        if (existing) {
          authUserId = existing.id;
          done.push("auth_user_already_existed");
          await recordAdminActivity({
            actorId: args.actor.id,
            actorEmail: args.actor.email,
            action: "demo.invite_skipped",
            targetTable: "demo_requests",
            targetId: args.demo.id,
            metadata: {
              reason: "auth user already exists",
              auth_user_id: existing.id,
            },
          });
        }
      }
      if (!authUserId) {
        failed.push({ step: "auth_invite", reason: msg });
        await recordAdminActivity({
          actorId: args.actor.id,
          actorEmail: args.actor.email,
          action: "demo.invite_failed",
          targetTable: "demo_requests",
          targetId: args.demo.id,
          metadata: { reason: msg },
        });
        return { ok: false, done, failed, meta };
      }
    } else if (inviteData?.user) {
      authUserId = inviteData.user.id;
      done.push("invite_sent");
      await recordAdminActivity({
        actorId: args.actor.id,
        actorEmail: args.actor.email,
        action: "demo.invite_sent",
        targetTable: "demo_requests",
        targetId: args.demo.id,
        metadata: {
          to: args.demo.email,
          auth_user_id: authUserId,
        },
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failed.push({ step: "auth_invite", reason: msg });
    await recordAdminActivity({
      actorId: args.actor.id,
      actorEmail: args.actor.email,
      action: "demo.invite_failed",
      targetTable: "demo_requests",
      targetId: args.demo.id,
      metadata: { reason: msg },
    });
    return { ok: false, done, failed, meta };
  }

  if (!authUserId) {
    failed.push({ step: "auth_invite", reason: "no_user_id" });
    return { ok: false, done, failed, meta };
  }
  meta.auth_user_id = authUserId;

  // -------------------------------------------------------------------
  // Step 2: public.users mirror row.
  // -------------------------------------------------------------------
  try {
    const { error: uErr } = await admin.from("users").upsert(
      {
        id: authUserId,
        email: args.demo.email,
        full_name: args.demo.name ?? null,
        phone: args.demo.phone ?? null,
      },
      { onConflict: "id" },
    );
    if (uErr) throw new Error(uErr.message);
    done.push("public_user_created");
    await recordAdminActivity({
      actorId: args.actor.id,
      actorEmail: args.actor.email,
      action: "demo.customer_created",
      targetTable: "demo_requests",
      targetId: args.demo.id,
      metadata: { auth_user_id: authUserId, email: args.demo.email },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failed.push({ step: "public_user_create", reason: msg });
    return { ok: false, done, failed, meta };
  }

  // -------------------------------------------------------------------
  // Step 3: organizations row (status='trial', 14-day window).
  // -------------------------------------------------------------------
  let orgId: string | null = null;
  try {
    const trialEnds = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data: orgRow, error: orgErr } = await admin
      .from("organizations")
      .insert({
        name: args.demo.company,
        slug: makeSlug(args.demo.company),
        phone: args.demo.phone ?? null,
        status: "trial",
        plan: "starter",
        trial_ends_at: trialEnds,
        onboarding_state: { started_at: new Date().toISOString() },
      } as never)
      .select("id")
      .single();
    if (orgErr || !orgRow) throw new Error(orgErr?.message ?? "no_org");
    orgId = (orgRow as { id: string }).id;
    meta.org_id = orgId;
    done.push("org_created");
    await recordAdminActivity({
      actorId: args.actor.id,
      actorEmail: args.actor.email,
      action: "demo.org_created",
      targetTable: "demo_requests",
      targetId: args.demo.id,
      metadata: { org_id: orgId, company: args.demo.company },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failed.push({ step: "org_create", reason: msg });
    return { ok: false, done, failed, meta };
  }

  // -------------------------------------------------------------------
  // Step 4: memberships (owner role).
  // -------------------------------------------------------------------
  try {
    const { data: memRow, error: memErr } = await admin
      .from("memberships")
      .insert({
        org_id: orgId,
        user_id: authUserId,
        role: "owner",
      } as never)
      .select("id")
      .single();
    if (memErr) throw new Error(memErr.message);
    meta.membership_id = (memRow as { id: string } | null)?.id;
    done.push("membership_created");
    await recordAdminActivity({
      actorId: args.actor.id,
      actorEmail: args.actor.email,
      action: "demo.membership_created",
      targetTable: "demo_requests",
      targetId: args.demo.id,
      metadata: {
        org_id: orgId,
        user_id: authUserId,
        role: "owner",
        membership_id: meta.membership_id ?? null,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failed.push({ step: "membership_create", reason: msg });
    // Best-effort rollback of the org so we don't leave an orphan.
    if (orgId) {
      await admin.from("organizations").delete().eq("id", orgId);
    }
    return { ok: false, done, failed, meta };
  }

  // -------------------------------------------------------------------
  // Step 5: stamp linked_org_id on the demo for idempotency.
  // -------------------------------------------------------------------
  try {
    const { error: linkErr } = await admin
      .from("demo_requests")
      .update({ linked_org_id: orgId } as never)
      .eq("id", args.demo.id);
    if (linkErr) throw new Error(linkErr.message);
    done.push("demo_linked");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failed.push({ step: "demo_link", reason: msg });
    // Non-fatal — the org + user are real, just the link doesn't stick.
  }

  // -------------------------------------------------------------------
  // Step 6: welcome email.
  // -------------------------------------------------------------------
  const welcome = onboardingWelcomeEmail({
    name: args.demo.name,
    company: args.demo.company,
  });
  const r = await sendDemoEmail({
    demo: args.demo,
    subject: welcome.subject,
    html: welcome.html,
    text: welcome.text,
    step: "onboarding_welcome",
    actor: args.actor,
  });
  if (r.ok) done.push("email_welcome");
  else failed.push({ step: "email_welcome", reason: r.reason ?? "unknown" });

  await recordAdminActivity({
    actorId: args.actor.id,
    actorEmail: args.actor.email,
    action: "demo.onboarding_created",
    targetTable: "demo_requests",
    targetId: args.demo.id,
    metadata: { org_id: orgId, auth_user_id: authUserId },
  });

  return { ok: true, done, failed, meta };
}

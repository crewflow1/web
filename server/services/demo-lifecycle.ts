import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { findAuthUserByEmail } from "@/lib/supabase/auth-user-lookup";
import { sendEmail, type SendEmailResult } from "@/lib/email/send";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  customerOnboardingEmail,
  demoApprovedEmail,
  demoConfirmationEmail,
  demoContactedEmail,
  paymentReceivedEmail,
  setupPaymentEmail,
} from "@/lib/email/demo-templates";
import { createOrReuseDemoSetupCheckout } from "@/lib/stripe/demo-checkout";
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

  // -------------------------------------------------------------------
  // 1. Generate (or reuse) a real Stripe Checkout link for the £1,000
  //    one-off setup fee. The customer pays immediately — no manual
  //    intervention — and the webhook flips the demo to payment_received.
  //
  //    Graceful degradation: if Stripe is unconfigured or the price
  //    can't be resolved, we fall back to the white-glove "reply for
  //    instructions" email (paymentLinkUrl = null) and record the Stripe
  //    failure as a non-fatal step so HQ sees it in the banner/timeline.
  // -------------------------------------------------------------------
  let paymentLinkUrl: string | null = null;
  const checkout = await createOrReuseDemoSetupCheckout({ demoId: args.demo.id });
  if (checkout.ok && checkout.url) {
    paymentLinkUrl = checkout.url;
    done.push("stripe_checkout_created");
    await recordAdminActivity({
      actorId: args.actor.id,
      actorEmail: args.actor.email,
      action: "demo.payment_link_created",
      targetTable: "demo_requests",
      targetId: args.demo.id,
      metadata: {
        session_id: checkout.sessionId,
        reused: checkout.reused,
        amount_gbp: checkout.amountGbp,
      },
    });
  } else if (checkout.ok && !checkout.url) {
    // Already paid — surface it but still let the (idempotent) email send
    // act as a gentle reminder/receipt path. No link to include.
    done.push("stripe_already_paid");
  } else {
    const reason = checkout.ok ? "no_url" : checkout.reason;
    failed.push({ step: "stripe_checkout", reason });
    await recordAdminActivity({
      actorId: args.actor.id,
      actorEmail: args.actor.email,
      action: "demo.payment_link_failed",
      targetTable: "demo_requests",
      targetId: args.demo.id,
      metadata: { reason, fallback: "white_glove_reply_instructions" },
    });
  }

  // 2. Send the payment email (with the Stripe CTA when we have a link,
  //    otherwise the manual fallback the template already renders).
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

  // The Stripe link failing back to white-glove is non-fatal: the email
  // still went out. Only a failed EMAIL marks the step as failed-overall.
  return {
    ok: !failed.some((f) => f.step === "email_setup_payment"),
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
// 5b. Stripe payment confirmed — fired from the webhook, NOT an operator.
//
// When checkout.session.completed lands for a demo setup-fee session
// (metadata.demo_id present), this runs automatically:
//   - flips demo.stripe_payment_status -> 'paid' + stamps setup_fee_paid_at
//   - advances demo.status -> 'payment_received' (unless already further
//     along the pipeline — never downgrades active/onboarding rows)
//   - audits demo.payment_confirmed (the money actually arriving)
//   - emails the customer their receipt ("workspace coming")
//
// Idempotent: a duplicate webhook (or a manual "mark payment received"
// race) is a no-op once stripe_payment_status === 'paid'. The billing_events
// unique index is the first line of defence; this is the second.
// ===========================================================================

/** Statuses that sit BEFORE payment in the pipeline — safe to advance. */
const PRE_PAYMENT_STATUSES = new Set([
  "pending_demo",
  "contacted",
  "demo_booked",
  "demo_done",
  "won",
  "payment_sent",
  // legacy aliases that still map "before payment"
  "new",
  "qualified",
  "approved",
  "closed_won",
]);

export async function onDemoStripePaymentConfirmed(args: {
  demoId: string;
  /** From the Stripe session, in major units (£). Falls back to default. */
  amountGbp?: number | null;
  stripeSessionId?: string | null;
}): Promise<LifecycleResult & { alreadyHandled?: boolean }> {
  const done: string[] = [];
  const failed: { step: string; reason: string }[] = [];
  const admin = createAdminClient();

  const { data: rowRaw, error: loadErr } = await admin
    .from("demo_requests")
    .select(
      "id, name, email, company, phone, status, linked_org_id, stripe_payment_status" as never,
    )
    .eq("id", args.demoId)
    .maybeSingle();
  if (loadErr) {
    return { ok: false, done, failed: [{ step: "load_demo", reason: loadErr.message }] };
  }
  const demo = rowRaw as unknown as (DemoRow & { stripe_payment_status: string | null }) | null;
  if (!demo) {
    return { ok: false, done, failed: [{ step: "load_demo", reason: "not_found" }] };
  }

  // Idempotency guard — already recorded as paid.
  if (demo.stripe_payment_status === "paid") {
    return { ok: true, done: ["already_paid"], failed: [], alreadyHandled: true };
  }

  // Build the update: always stamp paid; advance status only if behind.
  const update: Record<string, unknown> = {
    stripe_payment_status: "paid",
    setup_fee_paid_at: new Date().toISOString(),
  };
  if (PRE_PAYMENT_STATUSES.has(demo.status)) {
    update.status = "payment_received";
  }

  const { error: updErr } = await admin
    .from("demo_requests")
    .update(update as never)
    .eq("id", demo.id);
  if (updErr) {
    return { ok: false, done, failed: [{ step: "mark_paid", reason: updErr.message }] };
  }
  done.push("payment_marked_paid");

  await recordAdminActivity({
    actorId: null,
    actorEmail: null,
    action: "demo.payment_confirmed",
    targetTable: "demo_requests",
    targetId: demo.id,
    metadata: {
      source: "stripe_webhook",
      session_id: args.stripeSessionId ?? null,
      amount_gbp: args.amountGbp ?? SETUP_FEE_GBP,
      advanced_to: update.status ?? demo.status,
    },
  });

  // Receipt email — system-sent (no operator actor).
  const email = paymentReceivedEmail({
    name: demo.name,
    company: demo.company,
    amountGbp: args.amountGbp ?? SETUP_FEE_GBP,
  });
  const r = await sendDemoEmail({
    demo,
    subject: email.subject,
    html: email.html,
    text: email.text,
    step: "payment_received_stripe",
    actor: { id: null, email: null },
  });
  if (r.ok) done.push("email_payment_received");
  else failed.push({ step: "email_payment_received", reason: r.reason ?? "unknown" });

  return { ok: true, done, failed };
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
  // Step 1: create the auth user with email pre-confirmed.
  //
  // Why createUser instead of inviteUserByEmail:
  //   - inviteUserByEmail sends Supabase's branded invite email, whose
  //     verification link uses Supabase's PKCE flow. The PKCE code
  //     exchange in /auth/callback requires a `code_verifier` cookie
  //     that ONLY exists in the browser that initiated the request.
  //     Since this invite is generated server-side from HQ, no
  //     verifier cookie ever lands in the customer's browser →
  //     clicking the link from desktop / incognito / cross-device
  //     fails with "invalid code", which our login page surfaces as
  //     "Sign-in link was invalid or already used." This is the
  //     CEO-blocking bug.
  //
  // The new flow:
  //   1. createUser({ email_confirm: true }) — verifies the email
  //      without sending Supabase's email. The user can sign in via
  //      Google immediately (provided their Google email matches).
  //   2. generateLink({ type: "magiclink" }) — returns an action_link
  //      URL we embed in our own branded Resend email. The URL is a
  //      Supabase verify endpoint that redirects to /auth/callback
  //      with `token_hash` + `type` query params, which we exchange
  //      via verifyOtp — no PKCE verifier required.
  //   3. We email the link from hello@crewflow.uk via Resend.
  // -------------------------------------------------------------------
  let authUserId: string | null = null;
  const appUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");

  try {
    const { data: createData, error: createErr } = await admin.auth.admin.createUser({
      email: args.demo.email,
      email_confirm: true, // pre-verify → user can sign in immediately via Google or magic link
      user_metadata: {
        source: "demo_lifecycle",
        demo_id: args.demo.id,
        company: args.demo.company,
        invited_full_name: args.demo.name ?? null,
        invited_phone: args.demo.phone ?? null,
      },
    });

    if (createErr) {
      const msg = createErr.message ?? "";
      // If the user already exists, fetch them instead (idempotent).
      if (
        /already (registered|exists|signed|been)/i.test(msg) ||
        createErr.status === 422
      ) {
        // Paginated lookup — a bare listUsers() only returns the first
        // page (~50 users), so recovery used to fail for real accounts
        // once the auth base outgrew one page.
        const lookup = await findAuthUserByEmail(admin, args.demo.email);
        if (!lookup.ok) {
          // The account exists (createUser said so) but we couldn't
          // recover its id — surface the lookup failure distinctly
          // instead of misreporting it as a create failure.
          failed.push({ step: "auth_user_lookup", reason: lookup.reason });
        } else if (lookup.user) {
          authUserId = lookup.user.id;
          done.push("auth_user_already_existed");
          await recordAdminActivity({
            actorId: args.actor.id,
            actorEmail: args.actor.email,
            action: "demo.invite_skipped",
            targetTable: "demo_requests",
            targetId: args.demo.id,
            metadata: {
              reason: "auth user already exists",
              auth_user_id: lookup.user.id,
            },
          });
        }
      }
      if (!authUserId) {
        failed.push({ step: "auth_create_user", reason: msg });
        await recordAdminActivity({
          actorId: args.actor.id,
          actorEmail: args.actor.email,
          action: "demo.invite_failed",
          targetTable: "demo_requests",
          targetId: args.demo.id,
          metadata: { reason: msg, step: "createUser" },
        });
        return { ok: false, done, failed, meta };
      }
    } else if (createData?.user) {
      authUserId = createData.user.id;
      done.push("auth_user_created");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failed.push({ step: "auth_create_user", reason: msg });
    await recordAdminActivity({
      actorId: args.actor.id,
      actorEmail: args.actor.email,
      action: "demo.invite_failed",
      targetTable: "demo_requests",
      targetId: args.demo.id,
      metadata: { reason: msg, step: "createUser" },
    });
    return { ok: false, done, failed, meta };
  }

  if (!authUserId) {
    failed.push({ step: "auth_create_user", reason: "no_user_id" });
    return { ok: false, done, failed, meta };
  }
  meta.auth_user_id = authUserId;

  // -------------------------------------------------------------------
  // Step 1b: generate the magic-link URL we'll embed in our email.
  // -------------------------------------------------------------------
  let magicLinkUrl: string | null = null;
  try {
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: args.demo.email,
      options: {
        redirectTo: `${appUrl}/auth/callback`,
      },
    });
    if (linkErr) {
      // Non-fatal — user can still sign in via Google or via /login
      // request-new-link. We log it for visibility.
      const msg = linkErr.message ?? "";
      failed.push({ step: "magic_link_generate", reason: msg });
      await recordAdminActivity({
        actorId: args.actor.id,
        actorEmail: args.actor.email,
        action: "demo.invite_failed",
        targetTable: "demo_requests",
        targetId: args.demo.id,
        metadata: { reason: msg, step: "generateLink" },
      });
    } else if (linkData?.properties?.action_link) {
      magicLinkUrl = linkData.properties.action_link;
      done.push("magic_link_generated");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failed.push({ step: "magic_link_generate", reason: msg });
    await recordAdminActivity({
      actorId: args.actor.id,
      actorEmail: args.actor.email,
      action: "demo.invite_failed",
      targetTable: "demo_requests",
      targetId: args.demo.id,
      metadata: { reason: msg, step: "generateLink" },
    });
  }

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
  // Step 6: branded onboarding email FROM hello@crewflow.uk WITH the
  // magic link we generated above. Reliable cross-browser sign-in via
  // verifyOtp (no PKCE verifier required).
  //
  // If generateLink failed earlier (rare), magicLinkUrl is null and we
  // fall back to instructing the user to sign in via /login. They can
  // still sign in with Google (email is pre-confirmed) or request a
  // fresh magic link from the form.
  // -------------------------------------------------------------------
  const welcome = customerOnboardingEmail({
    name: args.demo.name,
    company: args.demo.company,
    magicLinkUrl,
  });
  const r = await sendDemoEmail({
    demo: args.demo,
    subject: welcome.subject,
    html: welcome.html,
    text: welcome.text,
    step: "onboarding_welcome",
    actor: args.actor,
  });
  if (r.ok) {
    done.push("email_welcome");
    // Record explicit "invite_sent" so the timeline says "magic-link
    // sent" even though we're sending via Resend rather than Supabase.
    await recordAdminActivity({
      actorId: args.actor.id,
      actorEmail: args.actor.email,
      action: "demo.invite_sent",
      targetTable: "demo_requests",
      targetId: args.demo.id,
      metadata: {
        to: args.demo.email,
        auth_user_id: authUserId,
        has_magic_link: magicLinkUrl != null,
        sent_via: "resend",
      },
    });
  } else {
    failed.push({ step: "email_welcome", reason: r.reason ?? "unknown" });
  }

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

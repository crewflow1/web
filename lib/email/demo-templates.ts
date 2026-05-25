import "server-only";
import { env } from "@/lib/env";

/**
 * Demo lifecycle email templates.
 *
 * One function per lifecycle event. Each returns
 * `{ subject, html, text }` — caller composes the sendEmail() call.
 *
 * Plain HTML, system-font, no external assets — Resend renders these
 * cleanly across every major client. The `text` field is the
 * fallback for clients that don't render HTML.
 */

const APP_URL = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
const APP_NAME = env.NEXT_PUBLIC_APP_NAME || "CrewFlow";

function shell({
  heading,
  body,
  cta,
}: {
  heading: string;
  body: string;
  cta?: { href: string; label: string } | null;
}): string {
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#0f172a;line-height:1.55;max-width:560px">
  <h1 style="margin:0 0 16px;font-size:22px">${heading}</h1>
  ${body}
  ${cta
    ? `<p style="margin:24px 0"><a href="${escapeAttr(cta.href)}" style="background:#0f172a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">${escapeText(cta.label)}</a></p>`
    : ""}
  <p style="color:#475569;font-size:12px;margin-top:32px">Reply to this email if you need anything — we read every one.</p>
  <p style="color:#94a3b8;font-size:11px">${escapeText(APP_NAME)} · UK construction operating system</p>
</div>`;
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}
function firstName(name: string | null | undefined): string {
  return (name?.split(" ")[0] ?? "there").trim() || "there";
}

// ---------------------------------------------------------------------------
// 1. Customer confirmation after public demo form submit
// ---------------------------------------------------------------------------

export function demoConfirmationEmail(input: {
  name: string | null;
  company: string;
}) {
  const first = firstName(input.name);
  const body = `
<p>Hi ${escapeText(first)},</p>
<p>Thanks for booking a demo of ${escapeText(APP_NAME)} for <strong>${escapeText(input.company)}</strong>. We&rsquo;ve got your request — a member of our team will be in touch within one working day to confirm a time.</p>
<p>In the meantime, if you&rsquo;d like to share anything ahead of the call (current systems, urgent pain points, scale of operation), just reply to this email.</p>`;
  return {
    subject: `We got your ${APP_NAME} demo request — ${input.company}`,
    html: shell({
      heading: `We got your demo request.`,
      body,
      cta: null,
    }),
    text: `Hi ${first},

Thanks for booking a demo of ${APP_NAME} for ${input.company}. We've got your request — a member of our team will be in touch within one working day to confirm a time.

If you'd like to share anything ahead of the call (current systems, pain points, scale), just reply to this email.

— The ${APP_NAME} team`,
  };
}

// ---------------------------------------------------------------------------
// 2. Demo "contacted" — light acknowledgement
// ---------------------------------------------------------------------------

export function demoContactedEmail(input: {
  name: string | null;
  company: string;
}) {
  const first = firstName(input.name);
  const body = `
<p>Hi ${escapeText(first)},</p>
<p>Just a quick note to say a member of our team is now actively working on your ${escapeText(APP_NAME)} demo for <strong>${escapeText(input.company)}</strong>. You&rsquo;ll hear from us shortly with a time that works.</p>`;
  return {
    subject: `Following up on your ${APP_NAME} demo — ${input.company}`,
    html: shell({
      heading: `We're on it.`,
      body,
      cta: null,
    }),
    text: `Hi ${first},

Just a quick note to say a member of our team is now actively working on your ${APP_NAME} demo for ${input.company}. You'll hear from us shortly with a time that works.

— The ${APP_NAME} team`,
  };
}

// ---------------------------------------------------------------------------
// 3. Demo won / approved
// ---------------------------------------------------------------------------

export function demoApprovedEmail(input: {
  name: string | null;
  company: string;
}) {
  const first = firstName(input.name);
  const body = `
<p>Hi ${escapeText(first)},</p>
<p>Brilliant — your ${escapeText(APP_NAME)} demo went well and we&rsquo;d love to onboard <strong>${escapeText(input.company)}</strong>.</p>
<p>Next step: we&rsquo;ll send you the one-off setup payment in a follow-up email. Once that&rsquo;s done we&rsquo;ll provision your workspace and email you a link to log in.</p>`;
  return {
    subject: `Welcome to ${APP_NAME} — let's get you set up`,
    html: shell({
      heading: `You're approved.`,
      body,
      cta: null,
    }),
    text: `Hi ${first},

Brilliant — your ${APP_NAME} demo went well and we'd love to onboard ${input.company}.

Next step: we'll send you the one-off setup payment in a follow-up email. Once that's done we'll provision your workspace and email you a link to log in.

— The ${APP_NAME} team`,
  };
}

// ---------------------------------------------------------------------------
// 4. Setup payment request (white-glove — manual payment instructions)
// ---------------------------------------------------------------------------

export function setupPaymentEmail(input: {
  name: string | null;
  company: string;
  paymentLinkUrl: string | null;
  amountGbp: number;
}) {
  const first = firstName(input.name);
  const amount = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: 0,
  }).format(input.amountGbp);

  const body = input.paymentLinkUrl
    ? `
<p>Hi ${escapeText(first)},</p>
<p>Time to get <strong>${escapeText(input.company)}</strong> set up on ${escapeText(APP_NAME)}. Please complete the one-off setup payment of <strong>${escapeText(amount)}</strong> below — once it lands we&rsquo;ll provision your workspace immediately and email you a sign-in link.</p>`
    : `
<p>Hi ${escapeText(first)},</p>
<p>Time to get <strong>${escapeText(input.company)}</strong> set up on ${escapeText(APP_NAME)}. The one-off setup fee is <strong>${escapeText(amount)}</strong>.</p>
<p>Reply to this email and we&rsquo;ll send you payment instructions (bank transfer or card link, your choice). As soon as payment lands we&rsquo;ll provision your workspace and email you a sign-in link.</p>`;

  return {
    subject: `Setup payment for ${APP_NAME} — ${input.company}`,
    html: shell({
      heading: `One-off setup payment.`,
      body,
      cta: input.paymentLinkUrl
        ? { href: input.paymentLinkUrl, label: `Pay setup fee (${amount})` }
        : null,
    }),
    text: `Hi ${first},

Time to get ${input.company} set up on ${APP_NAME}. The one-off setup fee is ${amount}.

${input.paymentLinkUrl
  ? `Pay here: ${input.paymentLinkUrl}\n\nAs soon as it lands we'll provision your workspace and email you a sign-in link.`
  : `Reply to this email and we'll send you payment instructions (bank transfer or card link, your choice). As soon as payment lands we'll provision your workspace and email you a sign-in link.`}

— The ${APP_NAME} team`,
  };
}

// ---------------------------------------------------------------------------
// 5. Payment received — receipt + "your workspace is coming"
// ---------------------------------------------------------------------------

export function paymentReceivedEmail(input: {
  name: string | null;
  company: string;
  amountGbp: number;
}) {
  const first = firstName(input.name);
  const amount = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: 0,
  }).format(input.amountGbp);
  const body = `
<p>Hi ${escapeText(first)},</p>
<p>Payment of <strong>${escapeText(amount)}</strong> received — thank you. We&rsquo;re now setting up your <strong>${escapeText(input.company)}</strong> workspace.</p>
<p>Watch your inbox: as soon as it&rsquo;s ready you&rsquo;ll get a separate email with a magic-link to sign in. Usually within an hour during UK business hours.</p>`;
  return {
    subject: `Payment received — your ${APP_NAME} workspace is on the way`,
    html: shell({
      heading: `Payment received.`,
      body,
      cta: null,
    }),
    text: `Hi ${first},

Payment of ${amount} received — thank you. We're now setting up your ${input.company} workspace.

You'll get a separate email with a magic-link to sign in shortly.

— The ${APP_NAME} team`,
  };
}

// ---------------------------------------------------------------------------
// 6. Onboarding welcome — sent AFTER the magic-link invite goes out via
//    Supabase. This is a friendly heads-up that the magic link is coming.
// ---------------------------------------------------------------------------

export function onboardingWelcomeEmail(input: {
  name: string | null;
  company: string;
}) {
  const first = firstName(input.name);
  const body = `
<p>Hi ${escapeText(first)},</p>
<p>Your <strong>${escapeText(input.company)}</strong> workspace on ${escapeText(APP_NAME)} is now live.</p>
<p>We&rsquo;ve emailed you a separate magic-link (subject line starts &ldquo;${escapeText(APP_NAME)}&rdquo; or &ldquo;Supabase&rdquo;) — click that to sign in. Once you&rsquo;re in, the onboarding checklist will walk you through adding your team, customers and first quote.</p>
<p>If the magic-link doesn&rsquo;t arrive in 5 minutes, check spam, or reply here and we&rsquo;ll resend.</p>`;
  return {
    subject: `Welcome to ${APP_NAME} — your workspace is live`,
    html: shell({
      heading: `Workspace live.`,
      body,
      cta: { href: `${APP_URL}/login`, label: `Sign in to ${APP_NAME}` },
    }),
    text: `Hi ${first},

Your ${input.company} workspace on ${APP_NAME} is now live.

We've emailed you a separate magic-link — click that to sign in. Once you're in, the onboarding checklist will walk you through adding your team, customers and first quote.

If the magic-link doesn't arrive in 5 minutes, check spam, or reply here and we'll resend.

Sign in: ${APP_URL}/login

— The ${APP_NAME} team`,
  };
}

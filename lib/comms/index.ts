import "server-only";

/**
 * CrewFlow HQ — Communication Layer: the email provider factory (the plug-in seam).
 *
 * CEO Directive 010, Phase 4. This is the ONE place that knows which email vendor is
 * active. The service asks `getEmailProvider()` for "a provider" and gets `null` when
 * nothing is configured. That null is the whole graceful-degradation contract,
 * identical to the text/embedding seams:
 *
 *   - provider present → `deliverDraft` hands the message to it and records `sent`.
 *   - provider null    → `deliverDraft` records a terminal `failed`/no_provider
 *     attempt and SENDS NOTHING. The application cannot tell the difference, and no
 *     application code changes either way. CI sets no provider key, so THIS is the
 *     path the integration suite exercises end-to-end.
 *
 * Selecting a provider is CONFIGURATION ONLY: `COMMS_EMAIL_PROVIDER` names the vendor
 * (default "auto" — use Resend when its key is set); the vendor's own key gates it.
 * Adding a second provider is a branch here plus a sibling file in ./providers —
 * never a change to the service.
 */

import { env } from "@/lib/env";
import type {
  EmailProvider,
  SmsProvider,
  WhatsAppProvider,
  MessagingProvider,
} from "./types";
import { createResendEmailProvider } from "./providers/resend";
import { createTwilioSmsProvider } from "./providers/twilio";
import { createMetaWhatsAppProvider } from "./providers/meta-whatsapp-sender";

export type {
  EmailProvider,
  EmailMessage,
  EmailAcceptance,
  CommProviderInfo,
  CommChannel,
  SmsProvider,
  SmsMessage,
  SmsAcceptance,
  SmsProviderInfo,
  SmsDeliveryStatus,
  TerminalSmsDeliveryStatus,
  SmsDeliveryReceipt,
  DeliveryStatus,
  WhatsAppProvider,
  WhatsAppMessage,
  WhatsAppAcceptance,
  WhatsAppProviderInfo,
  MessagingProvider,
} from "./types";
export {
  SMS_DELIVERY_STATUSES,
  TERMINAL_SMS_DELIVERY_STATUSES,
  DELIVERY_STATUSES,
  isSmsDeliveryStatus,
  isTerminalSmsDeliveryStatus,
  isDeliveryStatus,
} from "./types";
export { emailCostUsd, smsCostUsd } from "./cost";

/**
 * Resolve the configured email provider, or `null` when none is usable.
 *
 * Never throws: an unknown provider name or a missing key degrades to `null`
 * (outbound email off) rather than crashing the caller. Construction is cheap and
 * network-free.
 */
export function getEmailProvider(): EmailProvider | null {
  const name = (env.COMMS_EMAIL_PROVIDER ?? "auto").trim().toLowerCase();

  switch (name) {
    case "auto": {
      if (env.RESEND_API_KEY) return createResendEmailProvider();
      return null;
    }

    case "resend": {
      if (!env.RESEND_API_KEY) return null;
      return createResendEmailProvider();
    }

    // Future providers slot in here — configuration only:
    //   case "ses":      ...
    //   case "postmark": ...

    case "":
    case "none":
    case "off":
    case "disabled":
      return null;

    default:
      // Unknown name → degrade, don't crash. Outbound email stays off until the
      // configuration is corrected.
      console.warn(`[comms] unknown COMMS_EMAIL_PROVIDER="${name}" — outbound email disabled`);
      return null;
  }
}

/** Cheap presence check, mirroring `isTextConfigured()`. True iff a provider is configured. */
export function isEmailConfigured(): boolean {
  return getEmailProvider() !== null;
}

/**
 * Resolve the configured SMS provider, or `null` when none is usable.
 *
 * The receptionist's first outbound transport (Directive #018 R5). Same seam
 * doctrine as `getEmailProvider`: an unknown provider name or missing credentials
 * degrade to `null` (outbound SMS off) rather than crashing — the transport then
 * records a terminal `failed`/no_provider attempt and SENDS NOTHING, the path CI
 * exercises (CI sets no Twilio credentials). Construction is cheap and network-free.
 * Twilio is "configured" only when the account SID, auth token AND the sender
 * (TWILIO_SMS_FROM) are all present.
 */
export function getSmsProvider(): SmsProvider | null {
  const name = (env.COMMS_SMS_PROVIDER ?? "auto").trim().toLowerCase();

  const twilioConfigured = Boolean(
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_SMS_FROM,
  );

  switch (name) {
    case "auto": {
      if (twilioConfigured) return createTwilioSmsProvider();
      return null;
    }

    case "twilio": {
      if (!twilioConfigured) return null;
      return createTwilioSmsProvider();
    }

    // Future SMS providers slot in here — configuration only:
    //   case "messagebird": ...
    //   case "vonage":      ...

    case "":
    case "none":
    case "off":
    case "disabled":
      return null;

    default:
      // Unknown name → degrade, don't crash. Outbound SMS stays off until the
      // configuration is corrected.
      console.warn(`[comms] unknown COMMS_SMS_PROVIDER="${name}" — outbound SMS disabled`);
      return null;
  }
}

/** Cheap presence check, mirroring `isEmailConfigured()`. True iff an SMS provider is configured. */
export function isSmsConfigured(): boolean {
  return getSmsProvider() !== null;
}

/**
 * The SMS provider for the NOTIFICATION channel (lib/notifications/sms.ts), or
 * `null` when Twilio is unconfigured.
 *
 * A DELIBERATELY SEPARATE door from the receptionist's `getTransportProvider`:
 * the notification channel is SMS-only, so it resolves a concrete
 * `SmsProvider` here rather than the receptionist's `sms | whatsapp` transport
 * registry — there is no WhatsApp branch to fall back to, which is the whole
 * point. The raw vendor factory (`getSmsProvider`) stays captive to THIS registry
 * module (its "no module outside lib/comms reaches a raw provider" invariant is
 * intact); the notification channel depends only on this named accessor, so it
 * can never accidentally acquire a WhatsApp provider. Same two-switch DARK
 * contract as `getSmsProvider`: null until Twilio is fully configured.
 */
export function getNotificationSmsProvider(): SmsProvider | null {
  return getSmsProvider();
}

/**
 * Resolve the configured WhatsApp provider, or `null` when none is usable.
 *
 * The receptionist's SECOND outbound transport (Directive #018 R6). Same seam
 * doctrine as `getSmsProvider`: an unknown provider name or missing credentials
 * degrade to `null` (outbound WhatsApp off) rather than crashing — the transport then
 * records a terminal `failed`/no_provider attempt on `channel='whatsapp'` and SENDS
 * NOTHING.
 *
 * The Meta Cloud API sender (a Graph API `POST /{phone_number_id}/messages` adapter) IS
 * wired (`createMetaWhatsAppProvider`), but it is returned ONLY when ALL THREE of
 * NEXT_PUBLIC_FEATURE_WHATSAPP="true", WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID
 * are set — the CI/dev/production default has none of them, so `auto`/`meta` resolve to
 * `null` and outbound is dark. Outbound is thus FLAG- and CREDENTIAL-gated, not structurally
 * impossible: the draft-first safety posture holds because (a) the flag defaults to "false"
 * and creds are unset, (b) the flag is checked here so it kills the human-approval path too,
 * and (c) even fully enabled, a substantive reply is only ever sent after a human approves it
 * in the review inbox — nothing auto-sends.
 */
export function getWhatsAppProvider(): WhatsAppProvider | null {
  const name = (env.COMMS_WHATSAPP_PROVIDER ?? "auto").trim().toLowerCase();

  // KILL SWITCH — checked FIRST, before credentials, so it cannot be bypassed.
  //
  // NEXT_PUBLIC_FEATURE_WHATSAPP gates the whole channel, not just its inbound half. Without
  // this check the flag would only gate CONVERSATION ORIGINATION (the webhook 404s and
  // canRunReceptionistChannel returns false), while the human-approval path in
  // `deliverHumanReviewedReply` reaches the transport seam directly — so a WhatsApp draft
  // created while the flag was on could still be approved and SENT after the flag was turned
  // off, provided credentials were present. That would make the flag a gate on new
  // conversations rather than a kill switch, and would contradict `/api/health`, which now
  // reports `whatsapp: false` whenever the flag is off.
  //
  // Placing the check HERE — the single seam every send path resolves through
  // (`getTransportProvider` → autonomous AND human-approved alike) — makes the flag a genuine
  // channel-wide kill switch: flip it to anything but "true" and every WhatsApp send stops
  // immediately and degrades to the recorded `no_provider` disposition. This can only ever
  // turn sending OFF; it can never enable a send that credentials alone would not have allowed.
  if (process.env.NEXT_PUBLIC_FEATURE_WHATSAPP !== "true") return null;

  // Meta Cloud API is "configured" only when BOTH the access token AND the business
  // phone-number id are present. Absent (the CI/dev default) ⇒ null ⇒ the transport
  // records no_provider and SENDS NOTHING. Same gate shape as getSmsProvider's twilioConfigured.
  const metaConfigured = Boolean(
    env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID,
  );

  switch (name) {
    case "auto":
      return metaConfigured ? createMetaWhatsAppProvider() : null;

    case "meta":
      return metaConfigured ? createMetaWhatsAppProvider() : null;

    case "":
    case "none":
    case "off":
    case "disabled":
      return null;

    default:
      // Unknown name → degrade, don't crash. Outbound WhatsApp stays off.
      console.warn(
        `[comms] unknown COMMS_WHATSAPP_PROVIDER="${name}" — outbound WhatsApp disabled`,
      );
      return null;
  }
}

/** Cheap presence check, mirroring `isSmsConfigured()`. True iff a WhatsApp provider is configured. */
export function isWhatsAppConfigured(): boolean {
  return getWhatsAppProvider() !== null;
}

/**
 * The SINGLE channel → provider map for the receptionist's outbound transport.
 *
 * This is the only place a transport channel is resolved to a provider, and it has NO
 * fallback branch: `whatsapp` resolves ONLY to `getWhatsAppProvider()` (null today),
 * `sms` ONLY to `getSmsProvider()`. A WhatsApp transport can therefore NEVER borrow the
 * SMS provider — the "WhatsApp never falls back to SMS" guarantee is structural, not a
 * runtime check. A dark channel returns `null`, and the transport records
 * `failed`/no_provider and sends nothing.
 */
export function getTransportProvider(
  channel: "sms" | "whatsapp",
): MessagingProvider | null {
  return channel === "whatsapp" ? getWhatsAppProvider() : getSmsProvider();
}

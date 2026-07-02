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
import type { EmailProvider, SmsProvider } from "./types";
import { createResendEmailProvider } from "./providers/resend";
import { createTwilioSmsProvider } from "./providers/twilio";

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

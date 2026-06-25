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
import type { EmailProvider } from "./types";
import { createResendEmailProvider } from "./providers/resend";

export type {
  EmailProvider,
  EmailMessage,
  EmailAcceptance,
  CommProviderInfo,
  CommChannel,
} from "./types";
export { emailCostUsd } from "./cost";

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

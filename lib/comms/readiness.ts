/**
 * Communications readiness (First Impression Experience milestone — P2 + P3).
 *
 * The problem: a customer-facing email/SMS silently does nothing when its provider isn't configured
 * (`sendEmail` returns `{sent:false, reason:"no_key"}` with no key). On a misconfigured deploy a firm's
 * quotes and invoices would never reach their customers, and nobody would know. This module makes
 * missing configuration LOUD and observable — surfaced in `/api/health` so a deploy smoke-test and
 * monitoring catch it immediately, and reusable anywhere the app wants to warn an owner.
 *
 * It also reports whether missed-call SMS text-back is READY to activate (P3) — the pipeline ships
 * built-but-dark; this tells operations exactly what remains (the flag + the SMS sender) so it can be
 * switched on the moment Twilio provisioning completes, without guesswork.
 *
 * Deliberately reads `process.env` DIRECTLY (not the validated `env` object) and imports no provider
 * SDK, so it is edge-safe, dependency-free, and CAN NEVER THROW — a readiness probe must always answer.
 */

export type ProviderReadiness = {
  /** True when everything this channel needs to actually send is present. */
  configured: boolean;
  /** The provider that would be used, or null when unconfigured. */
  provider: string | null;
  /** The env vars still missing (empty when configured). */
  missing: string[];
};

const present = (v: string | undefined | null): boolean => typeof v === "string" && v.trim().length > 0;

/** Customer-facing EMAIL (Resend). Absent key ⇒ quotes/invoices silently don't send. */
export function getEmailReadiness(): ProviderReadiness {
  const configured = present(process.env.RESEND_API_KEY);
  return {
    configured,
    provider: configured ? "resend" : null,
    missing: configured ? [] : ["RESEND_API_KEY"],
  };
}

/** Outbound SMS (Twilio). Needs the account creds AND a sender number. */
export function getSmsReadiness(): ProviderReadiness {
  const missing: string[] = [];
  if (!present(process.env.TWILIO_ACCOUNT_SID)) missing.push("TWILIO_ACCOUNT_SID");
  if (!present(process.env.TWILIO_AUTH_TOKEN)) missing.push("TWILIO_AUTH_TOKEN");
  if (!present(process.env.TWILIO_SMS_FROM)) missing.push("TWILIO_SMS_FROM");
  return { configured: missing.length === 0, provider: missing.length === 0 ? "twilio" : null, missing };
}

/** Outbound WhatsApp (Meta). Needs the access token AND the business phone-number id. */
export function getWhatsAppReadiness(): ProviderReadiness {
  const missing: string[] = [];
  if (!present(process.env.WHATSAPP_ACCESS_TOKEN)) missing.push("WHATSAPP_ACCESS_TOKEN");
  if (!present(process.env.WHATSAPP_PHONE_NUMBER_ID)) missing.push("WHATSAPP_PHONE_NUMBER_ID");
  return { configured: missing.length === 0, provider: missing.length === 0 ? "meta" : null, missing };
}

export type MissedCallTextbackReadiness = {
  /** True when the feature can send: the flag is on AND the SMS sender is configured. */
  ready: boolean;
  /** Whether the customer-facing behaviour is switched on (`NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK`). */
  flagEnabled: boolean;
  /** Whether the SMS transport it rides is configured. */
  smsConfigured: boolean;
  /** What is still needed to activate (empty when ready). */
  missing: string[];
};

/**
 * Missed-call SMS text-back readiness (P3). The pipeline is BUILT and dark. `ready` means both the
 * feature flag is enabled and the Twilio SMS sender is configured — the two switches that turn it on.
 * `flagEnabled=false` with `smsConfigured=true` means "one env flip from live"; the reverse means
 * "Twilio provisioning outstanding". Reported for operations, never auto-flips anything.
 */
export function getMissedCallTextbackReadiness(): MissedCallTextbackReadiness {
  const flagEnabled = process.env.NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK === "true";
  const sms = getSmsReadiness();
  const smsConfigured = sms.configured;
  const missing: string[] = [];
  if (!flagEnabled) missing.push("NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK=true");
  if (!smsConfigured) missing.push(...sms.missing);
  return { ready: flagEnabled && smsConfigured, flagEnabled, smsConfigured, missing };
}

export type CommsReadiness = {
  /** The headline: can the platform deliver customer-facing EMAIL right now? The silent-failure guard. */
  customerEmailReady: boolean;
  email: ProviderReadiness;
  sms: ProviderReadiness;
  whatsapp: ProviderReadiness;
  missedCallTextback: MissedCallTextbackReadiness;
};

/** One call for a full communications-readiness snapshot (health checks, admin surfaces, monitoring). */
export function getCommsReadiness(): CommsReadiness {
  const email = getEmailReadiness();
  return {
    customerEmailReady: email.configured,
    email,
    sms: getSmsReadiness(),
    whatsapp: getWhatsAppReadiness(),
    missedCallTextback: getMissedCallTextbackReadiness(),
  };
}

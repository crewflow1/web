/**
 * Voice Telephony (Wave 8) — the activation predicates.
 *
 * DARK BY DEFAULT, TWO SWITCHES. Inbound voice is live only when BOTH the flag
 * (NEXT_PUBLIC_FEATURE_VOICE_INBOUND) AND a credential-resolvable provider are
 * present — the exact two-switch posture the SMS/WhatsApp seams use. Either off
 * ⇒ the webhooks 503 and nothing is processed. This is the posture in prod, CI
 * and dev, which set neither.
 *
 * Every predicate here reads `process.env` AT CALL TIME (never the frozen `env`
 * singleton), imports no SDK, and CANNOT THROW — a readiness/gate probe must
 * always answer. Mirrors lib/comms/readiness.ts and lib/ai/governor/readiness.ts.
 */

import type { VoiceProviderId } from "./types";

const present = (v: string | undefined | null): boolean =>
  typeof v === "string" && v.trim().length > 0;

/** SWITCH ONE — the feature flag. False unless explicitly "true". */
export function voiceInboundFeatureEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FEATURE_VOICE_INBOUND === "true";
}

/**
 * Is a specific provider's credential set? Twilio needs an account SID + auth
 * token (the token also verifies its inbound signatures); Vapi needs its webhook
 * secret (the value inbound events are HMAC-signed with). A credential alone is
 * NOT activation — the flag must also be on (see `isVoiceConfigured`).
 */
export function isVoiceProviderConfigured(provider: VoiceProviderId): boolean {
  switch (provider) {
    case "twilio":
      return present(process.env.TWILIO_ACCOUNT_SID) && present(process.env.TWILIO_AUTH_TOKEN);
    case "vapi":
      return present(process.env.VAPI_WEBHOOK_SECRET);
    default:
      return false;
  }
}

/**
 * The provider COMMS_VOICE_PROVIDER selects, or null. Default "auto": prefer
 * Twilio when configured, else Vapi. "none"/"off"/"disabled" is a second kill
 * switch. An unknown name degrades to null (never throws).
 */
export function selectedVoiceProvider(): VoiceProviderId | null {
  const name = (process.env.COMMS_VOICE_PROVIDER ?? "auto").trim().toLowerCase();
  switch (name) {
    case "auto":
      if (isVoiceProviderConfigured("twilio")) return "twilio";
      if (isVoiceProviderConfigured("vapi")) return "vapi";
      return null;
    case "twilio":
      return isVoiceProviderConfigured("twilio") ? "twilio" : null;
    case "vapi":
      return isVoiceProviderConfigured("vapi") ? "vapi" : null;
    case "":
    case "none":
    case "off":
    case "disabled":
      return null;
    default:
      console.warn(`[telephony] unknown COMMS_VOICE_PROVIDER="${name}" — inbound voice disabled`);
      return null;
  }
}

/** Is any voice provider credential-resolvable (independent of the flag)? */
export function isVoiceProviderResolvable(): boolean {
  return selectedVoiceProvider() !== null;
}

/**
 * THE headline gate: is inbound voice live? Flag ON **and** a provider
 * resolvable. The webhook routes 503 before any work when this is false — a
 * credential without the flag, or the flag without a credential, is dark.
 */
export function isVoiceConfigured(): boolean {
  return voiceInboundFeatureEnabled() && isVoiceProviderResolvable();
}

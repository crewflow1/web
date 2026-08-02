import "server-only";

/**
 * Voice Telephony (Wave 8) — the provider factory.
 *
 * The ONE place that turns "which provider is active" into a `VoiceProvider`.
 * Everything upstream (the webhook routes) asks `getVoiceProvider()` and gets
 * `null` when inbound voice is not live — the whole graceful-degradation
 * contract, identical to `getSmsProvider` / `getWhatsAppProvider`.
 *
 * TWO SWITCHES, checked here as ONE gate: `isVoiceConfigured()` is
 * flag(NEXT_PUBLIC_FEATURE_VOICE_INBOUND) AND a credential-resolvable provider.
 * The flag check is deliberately FIRST and cheapest — a stray credential cannot
 * satisfy it, and putting it after the vendor branch would mean a provider
 * object briefly exists for a webhook that must never be processed.
 */

import {
  isVoiceConfigured,
  selectedVoiceProvider,
  voiceInboundFeatureEnabled,
} from "./config";
import { createTwilioVoiceProvider } from "./providers/twilio";
import { createVapiVoiceProvider } from "./providers/vapi";
import type { VoiceProvider } from "./types";

/**
 * Resolve the active voice provider, or `null` when inbound voice is dark.
 *
 * Never throws; construction is cheap and network-free (no SDK), so a route may
 * call this per request. Returns null when the flag is off, when no provider
 * credential is resolvable, or when the resolved provider name is unknown.
 */
export function getVoiceProvider(): VoiceProvider | null {
  // SWITCH ONE — the flag. Nothing below is reached without it.
  if (!voiceInboundFeatureEnabled()) return null;
  // SWITCH TWO — a credential-resolvable provider (and the combined gate).
  if (!isVoiceConfigured()) return null;

  switch (selectedVoiceProvider()) {
    case "twilio":
      return createTwilioVoiceProvider();
    case "vapi":
      return createVapiVoiceProvider();
    default:
      return null;
  }
}

export * from "./config";
export * from "./types";

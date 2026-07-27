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
 * `/api/health` runs on the edge runtime, so this module MUST NOT import `@/lib/comms` (that module is
 * `server-only` and pulls in provider SDKs). See SENDER_IMPLEMENTED below for how that is handled.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS MODULE SPLITS "READY" INTO SEVERAL FIELDS (the false-readiness fix)
 * ---------------------------------------------------------------------------------------------
 * A single `configured` boolean derived from env vars is a LIE whenever the runtime cannot actually
 * perform the capability. The concrete incident this guards against: WhatsApp readiness reported
 * `configured: true` from `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` alone, at a time when
 * the codebase contained NO WhatsApp sender at all. An operator who set those two vars would have
 * flipped `/api/health` to `whatsapp: true` while sending remained structurally impossible — the
 * worst kind of monitoring signal, a green light over a dead path.
 *
 * So readiness is now decomposed into the things that are independently, verifiably true:
 *
 *   credentialsPresent  — the vendor secrets are set.                        (configuration)
 *   senderImplemented   — a real sender EXISTS in this build.                (build-time fact)
 *   selectionUsable     — COMMS_*_PROVIDER names a provider we can build.    (configuration)
 *   providerResolvable  — all three above ⇒ `getXProvider() !== null`.       (the transport seam)
 *   enabled             — the channel's feature flag is on.                  (product switch)
 *   outboundReady       — providerResolvable AND enabled ⇒ CAN ACTUALLY SEND.
 *
 * The load-bearing rule: **`outboundReady` can NEVER be true without `senderImplemented`.** No
 * amount of env-var configuration can make a capability with no implementation report ready.
 */

// ---------------------------------------------------------------------------------------------
// Build-time capability registry.
// ---------------------------------------------------------------------------------------------

/**
 * Does a REAL outbound sender exist in this build for each channel?
 *
 * This is a BUILD-TIME fact, not configuration — it answers "is there code that can put a message
 * on the wire", which no env var can change. It is a hand-maintained mirror of the provider
 * factories in `@/lib/comms` (`getEmailProvider` / `getSmsProvider` / `getWhatsAppProvider`),
 * because this module is edge-safe and must not import that `server-only` module.
 *
 * `__tests__/comms/readiness.test.ts` guards the mirror against drift by asserting that every
 * channel marked `true` here has its sender module wired into `lib/comms/index.ts`. If you add or
 * remove a sender, update this map and that test will hold you to it.
 *
 * Historical note: on `main` before the WhatsApp consolidation, `whatsapp` here would have been
 * `false` — and that alone would have kept `/api/health` honest.
 */
const SENDER_IMPLEMENTED: Readonly<Record<CommsChannelKey, boolean>> = {
  // lib/comms/providers/resend.ts → createResendEmailProvider
  email: true,
  // lib/comms/providers/twilio.ts → createTwilioSmsProvider
  sms: true,
  // lib/comms/providers/meta-whatsapp-sender.ts → createMetaWhatsAppProvider
  whatsapp: true,
};

export type CommsChannelKey = "email" | "sms" | "whatsapp";

/**
 * Does this build contain a real sender for `channel`? A build-time fact — no env var can change
 * it, and `outboundReady` is impossible without it. Exposed so operator surfaces (and the
 * drift-guard test) can distinguish "not configured yet" from "not built yet".
 */
export function hasSenderImplementation(channel: CommsChannelKey): boolean {
  return SENDER_IMPLEMENTED[channel];
}

/**
 * The `COMMS_*_PROVIDER` values that resolve to a usable provider, per channel — an exact mirror of
 * the `switch` arms in `@/lib/comms`. Anything else ("", "none", "off", "disabled", or an unknown
 * vendor name) degrades to `null` there, so it must count as NOT ready here. Unset ⇒ "auto".
 */
const USABLE_PROVIDER_SELECTIONS: Readonly<Record<CommsChannelKey, readonly string[]>> = {
  email: ["auto", "resend"],
  sms: ["auto", "twilio"],
  whatsapp: ["auto", "meta"],
};

// ---------------------------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------------------------

export type ProviderReadiness = {
  /**
   * The vendor credentials are all present.
   *
   * NOT a readiness signal on its own — credentials say nothing about whether a sender exists or
   * whether the channel is switched on. Use `outboundReady` to decide whether anything can send.
   */
  credentialsPresent: boolean;

  /**
   * A real sender implementation exists in this build for this channel (see SENDER_IMPLEMENTED).
   * Build-time fact; no env var can flip it.
   */
  senderImplemented: boolean;

  /** `COMMS_*_PROVIDER` names a provider this build can construct (unset ⇒ "auto" ⇒ true). */
  selectionUsable: boolean;

  /**
   * The transport seam would hand back a provider — i.e. `getXProvider() !== null`.
   * Exactly `senderImplemented && credentialsPresent && selectionUsable`.
   */
  providerResolvable: boolean;

  /** The channel's product feature flag is on. Channels without a flag are always `true`. */
  enabled: boolean;

  /**
   * THE honest headline: this runtime CAN ACTUALLY SEND on this channel right now.
   * `providerResolvable && enabled`. Never true without `senderImplemented`.
   */
  outboundReady: boolean;

  /**
   * Back-compat alias of `credentialsPresent`, retained so existing callers keep compiling.
   *
   * @deprecated Ambiguous — this is the field whose "configured ⇒ ready" reading caused the
   * false-readiness incident. Read `credentialsPresent` if you mean secrets, `outboundReady` if
   * you mean "can send".
   */
  configured: boolean;

  /** The provider that would be used, or null when the seam would resolve to null. */
  provider: string | null;

  /** The vendor env vars still missing (empty when all credentials are present). */
  missing: string[];

  /**
   * EVERYTHING standing between this channel and `outboundReady` — missing credentials, a disabled
   * provider selection, an off feature flag, or a missing implementation. Empty ⇒ ready.
   * This is the operator-facing activation checklist; `missing` is credentials only.
   */
  blockers: string[];
};

const present = (v: string | undefined | null): boolean => typeof v === "string" && v.trim().length > 0;

const isSelectionUsable = (channel: CommsChannelKey, raw: string | undefined): boolean =>
  USABLE_PROVIDER_SELECTIONS[channel].includes((raw ?? "auto").trim().toLowerCase());

/**
 * The ONE place readiness is composed, so every channel obeys the same rule and the
 * "no implementation ⇒ never ready" invariant cannot be forgotten at a call site.
 *
 * Exported for testing: a test can pass `senderImplemented: false` with everything else satisfied
 * and assert that `outboundReady` is still false — the invariant, proven directly rather than
 * inferred from whichever channels happen to exist today.
 */
export function composeProviderReadiness(input: {
  channel: CommsChannelKey;
  vendor: string;
  /** Vendor credential env vars that are absent/blank. */
  missing: string[];
  /** Raw `COMMS_*_PROVIDER` value (undefined ⇒ "auto"). */
  providerSelection: string | undefined;
  /** The channel's feature flag state. Channels without a flag pass `true`. */
  enabled: boolean;
  /** What to name the flag in `blockers` when `enabled` is false. */
  enableBlocker?: string;
  /** Override the build-time registry. Testing only. */
  senderImplemented?: boolean;
}): ProviderReadiness {
  const senderImplemented = input.senderImplemented ?? SENDER_IMPLEMENTED[input.channel];
  const credentialsPresent = input.missing.length === 0;
  const selectionUsable = isSelectionUsable(input.channel, input.providerSelection);

  // Mirrors `getXProvider() !== null` in @/lib/comms.
  const providerResolvable = senderImplemented && credentialsPresent && selectionUsable;

  // The invariant: no implementation ⇒ NEVER ready, whatever the environment says.
  const outboundReady = providerResolvable && input.enabled;

  const blockers: string[] = [...input.missing];
  if (!senderImplemented) blockers.push(`no ${input.channel} sender implementation in this build`);
  if (!selectionUsable) {
    blockers.push(
      `COMMS_${input.channel.toUpperCase()}_PROVIDER must name a usable provider ` +
        `(${USABLE_PROVIDER_SELECTIONS[input.channel].join(" | ")})`,
    );
  }
  if (!input.enabled && input.enableBlocker) blockers.push(input.enableBlocker);

  return {
    credentialsPresent,
    senderImplemented,
    selectionUsable,
    providerResolvable,
    enabled: input.enabled,
    outboundReady,
    configured: credentialsPresent,
    provider: providerResolvable ? input.vendor : null,
    missing: input.missing,
    blockers,
  };
}

// ---------------------------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------------------------

/** Customer-facing EMAIL (Resend). Absent key ⇒ quotes/invoices silently don't send. */
export function getEmailReadiness(): ProviderReadiness {
  const missing: string[] = [];
  if (!present(process.env.RESEND_API_KEY)) missing.push("RESEND_API_KEY");
  return composeProviderReadiness({
    channel: "email",
    vendor: "resend",
    missing,
    providerSelection: process.env.COMMS_EMAIL_PROVIDER,
    enabled: true, // no feature flag — email is a core capability, always switched on
  });
}

/** Outbound SMS (Twilio). Needs the account creds AND a sender number. */
export function getSmsReadiness(): ProviderReadiness {
  const missing: string[] = [];
  if (!present(process.env.TWILIO_ACCOUNT_SID)) missing.push("TWILIO_ACCOUNT_SID");
  if (!present(process.env.TWILIO_AUTH_TOKEN)) missing.push("TWILIO_AUTH_TOKEN");
  if (!present(process.env.TWILIO_SMS_FROM)) missing.push("TWILIO_SMS_FROM");
  return composeProviderReadiness({
    channel: "sms",
    vendor: "twilio",
    missing,
    providerSelection: process.env.COMMS_SMS_PROVIDER,
    enabled: true, // the SMS transport itself has no flag; per-feature flags gate its callers
  });
}

export type WhatsAppReadiness = ProviderReadiness & {
  /**
   * The inbound webhook can accept and verify traffic: the feature flag is on AND both the HMAC
   * app secret and the verify token are set. With the flag off the webhook 404s; without the app
   * secret every POST fails signature verification (401); without the verify token Meta's GET
   * subscription handshake 403s. Inbound and outbound are reported SEPARATELY because they are
   * genuinely independent — inbound has been live-capable on `main` since the #359 foundation,
   * outbound only arrived with the sender.
   */
  inboundReady: boolean;
  /** Everything still needed for `inboundReady` (empty when ready). */
  inboundBlockers: string[];
};

/**
 * Outbound + inbound WhatsApp (Meta Cloud API).
 *
 * Outbound needs the access token AND the business phone-number id AND a sender implementation
 * AND the feature flag. The flag is part of `outboundReady` deliberately: a WhatsApp reply can
 * only ever originate from an ingested WhatsApp conversation, and with `NEXT_PUBLIC_FEATURE_WHATSAPP`
 * off the webhook 404s and `canRunReceptionistChannel('whatsapp_msg')` returns false, so no
 * WhatsApp turn — and therefore no WhatsApp send — can come into existence. Reporting
 * `outboundReady: true` with the flag off would be the same false-green this module exists to stop.
 */
export function getWhatsAppReadiness(): WhatsAppReadiness {
  const missing: string[] = [];
  if (!present(process.env.WHATSAPP_ACCESS_TOKEN)) missing.push("WHATSAPP_ACCESS_TOKEN");
  if (!present(process.env.WHATSAPP_PHONE_NUMBER_ID)) missing.push("WHATSAPP_PHONE_NUMBER_ID");

  const flagEnabled = process.env.NEXT_PUBLIC_FEATURE_WHATSAPP === "true";

  const base = composeProviderReadiness({
    channel: "whatsapp",
    vendor: "meta",
    missing,
    providerSelection: process.env.COMMS_WHATSAPP_PROVIDER,
    enabled: flagEnabled,
    enableBlocker: "NEXT_PUBLIC_FEATURE_WHATSAPP=true",
  });

  const inboundBlockers: string[] = [];
  if (!flagEnabled) inboundBlockers.push("NEXT_PUBLIC_FEATURE_WHATSAPP=true");
  if (!present(process.env.WHATSAPP_APP_SECRET)) inboundBlockers.push("WHATSAPP_APP_SECRET");
  if (!present(process.env.WHATSAPP_VERIFY_TOKEN)) inboundBlockers.push("WHATSAPP_VERIFY_TOKEN");

  return { ...base, inboundReady: inboundBlockers.length === 0, inboundBlockers };
}

export type MissedCallTextbackReadiness = {
  /** True when the feature can send: the flag is on AND the SMS sender is configured. */
  ready: boolean;
  /** Whether the customer-facing behaviour is switched on (`NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK`). */
  flagEnabled: boolean;
  /** Whether the SMS transport it rides can actually send. */
  smsConfigured: boolean;
  /** What is still needed to activate (empty when ready). */
  missing: string[];
};

/**
 * Missed-call SMS text-back readiness (P3). The pipeline is BUILT and dark. `ready` means both the
 * feature flag is enabled and the Twilio SMS sender can actually send — the two switches that turn
 * it on. `flagEnabled=false` with `smsConfigured=true` means "one env flip from live"; the reverse
 * means "Twilio provisioning outstanding". Reported for operations, never auto-flips anything.
 */
export function getMissedCallTextbackReadiness(): MissedCallTextbackReadiness {
  const flagEnabled = process.env.NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK === "true";
  const sms = getSmsReadiness();
  // `outboundReady`, not `configured`: this feature can only text back if SMS can genuinely send.
  const smsConfigured = sms.outboundReady;
  const missing: string[] = [];
  if (!flagEnabled) missing.push("NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK=true");
  if (!smsConfigured) missing.push(...sms.blockers);
  return { ready: flagEnabled && smsConfigured, flagEnabled, smsConfigured, missing };
}

export type CommsReadiness = {
  /** The headline: can the platform deliver customer-facing EMAIL right now? The silent-failure guard. */
  customerEmailReady: boolean;
  email: ProviderReadiness;
  sms: ProviderReadiness;
  whatsapp: WhatsAppReadiness;
  missedCallTextback: MissedCallTextbackReadiness;
};

/** One call for a full communications-readiness snapshot (health checks, admin surfaces, monitoring). */
export function getCommsReadiness(): CommsReadiness {
  const email = getEmailReadiness();
  return {
    // "Ready" means CAN SEND, not "a key is set".
    customerEmailReady: email.outboundReady,
    email,
    sms: getSmsReadiness(),
    whatsapp: getWhatsAppReadiness(),
    missedCallTextback: getMissedCallTextbackReadiness(),
  };
}

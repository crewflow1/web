import "server-only";

/**
 * P3 Inbox — the dark-safe outbound send for the tenant reply composer.
 *
 * ONE function, {@link sendInboxReply}, that carries an operator-composed reply out over
 * the appropriate already-dark comms seam (Resend email / Twilio SMS / Meta WhatsApp) and
 * reports a durable OUTCOME the caller records on the message row. It is the tenant-facing
 * twin of the receptionist's `transportReply`, and it obeys the same graceful-degradation
 * contract:
 *
 *   - No wired transport for the channel (voice / chat)      → QUEUED, `no_transport_channel`.
 *   - A wired transport whose PROVIDER is unset (the default
 *     in CI / dev / prod today — no RESEND/TWILIO/WHATSAPP
 *     credentials)                                           → QUEUED, `provider_not_configured`.
 *   - A missing/blank destination                            → FAILED, `invalid_destination`.
 *   - The provider ACCEPTED the message                      → SENT, with its message id.
 *   - The provider THREW                                     → FAILED, `provider_error`.
 *
 * "Dark-safe" means: when nothing can send, the reply is QUEUED (recorded, visible, never
 * lost) and this function NEVER THROWS and NEVER calls a provider. Because the email
 * provider getter returns `null` without credentials — and CI/dev/prod set none — the
 * queued path is the one exercised everywhere today. Providers are resolved through an
 * INJECTABLE resolver set (defaulting to the real getters) so a test can prove the sent
 * path with a FAKE provider and can NEVER reach a real vendor.
 *
 * ── WHY ONLY EMAIL RESOLVES A REAL PROVIDER HERE ────────────────────────────
 * The SMS and WhatsApp seams are CAPTIVE to the AI-receptionist transport by a hard
 * source-level invariant (receptionist-transport-invariants.test.ts): `getSmsProvider` /
 * `getWhatsAppProvider` / `getTransportProvider` may be reached ONLY inside
 * `lib/comms/index.ts` and `server/services/receptionist.ts`, so that no path can put a
 * message on the SMS/WhatsApp wire without first passing the mandatory enforce+audit gate
 * (and so a WhatsApp reply can never leak onto the SMS wire). The tenant composer MUST NOT
 * bypass that gate, so it does NOT resolve those raw providers: sms/whatsapp replies are
 * recorded and QUEUED dark-safe by default (their live delivery rides the governed
 * receptionist transport, a deliberate follow-up). `getEmailProvider` is NOT captive — it
 * is the customer-facing email seam the app already uses — so email is wired to genuinely
 * send the moment Resend is configured. The sms/whatsapp resolvers remain INJECTABLE so
 * tests exercise the messaging send shape without ever importing the captive getters.
 */

import { getEmailProvider } from "@/lib/comms";
import type { EmailProvider, SmsProvider, WhatsAppProvider } from "@/lib/comms";
import { plaintextToHtml, normalizeAddress, isValidEmail } from "@/lib/comms/policy";
import { toE164 } from "@/lib/phone";
import { transportForInboxChannel, type InboxChannel } from "@/lib/inbox/channels";

/** The disposition of one outbound send attempt. Recorded onto the message row. */
export type InboxSendStatus = "sent" | "queued" | "failed";

export type InboxSendResult = {
  status: InboxSendStatus;
  /** The provider's message id on a clean send, else null. */
  providerMessageId: string | null;
  /** The vendor id that carried (or would have carried) the message, when known. */
  provider: string | null;
  /** Why a queued/failed send ended where it did, else null. */
  failureReason:
    | "no_transport_channel"
    | "provider_not_configured"
    | "invalid_destination"
    | "provider_error"
    | null;
  /** The normalised destination the send targeted (E.164 for sms/whatsapp, address for email). */
  destination: string | null;
};

/**
 * The provider resolvers. Defaults to the real config-driven getters (all `null` without
 * credentials). A test injects fakes/nulls — it never touches a real vendor.
 */
export type ProviderResolvers = {
  email: () => EmailProvider | null;
  sms: () => SmsProvider | null;
  whatsapp: () => WhatsAppProvider | null;
};

// Email resolves the real (non-captive) provider. SMS/WhatsApp default to null — the
// tenant composer never reaches their captive seam — so they QUEUE dark-safe. The nulls
// are the injection seam a test overrides to exercise the messaging send shape.
const DEFAULT_RESOLVERS: ProviderResolvers = {
  email: getEmailProvider,
  sms: () => null,
  whatsapp: () => null,
};

export type SendInboxReplyArgs = {
  channel: InboxChannel;
  /** The recipient: an email address, or a phone number for sms/whatsapp. */
  destination: string | null;
  /** The reply body (plaintext; email is lifted to HTML deterministically). */
  body: string;
  /** Optional subject for email; defaults to a generic reply subject. */
  subject?: string | null;
};

/**
 * Carry one composed reply out over its channel's seam, or QUEUE it dark-safe. Never
 * throws for a missing provider/transport; only a genuine programming error would.
 */
export async function sendInboxReply(
  args: SendInboxReplyArgs,
  resolvers: ProviderResolvers = DEFAULT_RESOLVERS,
): Promise<InboxSendResult> {
  const transport = transportForInboxChannel(args.channel);

  // (a) No wired transport for this channel — compose + queue, never send.
  if (transport === null) {
    return {
      status: "queued",
      providerMessageId: null,
      provider: null,
      failureReason: "no_transport_channel",
      destination: args.destination,
    };
  }

  if (transport === "email") {
    return sendEmailReply(args, resolvers);
  }
  return sendMessagingReply(transport, args, resolvers);
}

async function sendEmailReply(
  args: SendInboxReplyArgs,
  resolvers: ProviderResolvers,
): Promise<InboxSendResult> {
  const to = (args.destination ?? "").trim();

  // Undeliverable address — a real attempt that never reaches a provider.
  if (!to || !isValidEmail(to)) {
    return {
      status: "failed",
      providerMessageId: null,
      provider: null,
      failureReason: "invalid_destination",
      destination: to || null,
    };
  }
  const normalized = normalizeAddress(to);

  // Dark-safe: no provider configured → QUEUE, send nothing, don't throw.
  const provider = resolvers.email();
  if (!provider) {
    return {
      status: "queued",
      providerMessageId: null,
      provider: null,
      failureReason: "provider_not_configured",
      destination: normalized,
    };
  }

  try {
    const acceptance = await provider.send({
      to: normalized,
      subject: (args.subject ?? "").trim() || "Reply from your CrewFlow inbox",
      html: plaintextToHtml(args.body),
      text: args.body,
    });
    return {
      status: "sent",
      providerMessageId: acceptance.providerMessageId,
      provider: provider.info.provider,
      failureReason: null,
      destination: normalized,
    };
  } catch {
    return {
      status: "failed",
      providerMessageId: null,
      provider: provider.info.provider,
      failureReason: "provider_error",
      destination: normalized,
    };
  }
}

async function sendMessagingReply(
  transport: "sms" | "whatsapp",
  args: SendInboxReplyArgs,
  resolvers: ProviderResolvers,
): Promise<InboxSendResult> {
  const e164 = toE164(args.destination);

  // Undialable destination — a real attempt that never reaches a provider.
  if (!e164) {
    return {
      status: "failed",
      providerMessageId: null,
      provider: null,
      failureReason: "invalid_destination",
      destination: args.destination,
    };
  }

  // Resolve ONLY this channel's provider — no cross-channel fallback (whatsapp can never
  // borrow sms). Dark-safe: null → QUEUE, send nothing, don't throw.
  const provider = transport === "whatsapp" ? resolvers.whatsapp() : resolvers.sms();
  if (!provider) {
    return {
      status: "queued",
      providerMessageId: null,
      provider: null,
      failureReason: "provider_not_configured",
      destination: e164,
    };
  }

  try {
    const acceptance = await provider.send({ to: e164, body: args.body });
    return {
      status: "sent",
      providerMessageId: acceptance.providerMessageId,
      provider: provider.info.provider,
      failureReason: null,
      destination: e164,
    };
  } catch {
    return {
      status: "failed",
      providerMessageId: null,
      provider: provider.info.provider,
      failureReason: "provider_error",
      destination: e164,
    };
  }
}

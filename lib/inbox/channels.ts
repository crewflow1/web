/**
 * P3 Inbox — the unified channel vocabulary (pure).
 *
 * The five channels the tenant-facing unified inbox speaks, and the deterministic
 * rules that map an AI-receptionist INBOUND channel onto them and decide which of
 * them carry an OUTBOUND reply. NO `server-only`, NO I/O — the migration's CHECK
 * constraints, the send service, the UI and the tests all share ONE vocabulary and
 * one set of rules, so they can never drift.
 *
 * Kept as a SEPARATE, coarser vocabulary from `InboundChannel`
 * (lib/receptionist/types.ts, eight values) on purpose: the inbox groups a customer's
 * contact by the medium a human recognises (voice / SMS / WhatsApp / email / chat),
 * folding phone + whatsapp_call into "voice" and the DM channels into "chat". The
 * `inbox_channel_for_enquiry` SQL function mirrors {@link inboxChannelForEnquiry}.
 */

/** The five canonical inbox channels. Mirrors the migration channel CHECK. */
export const INBOX_CHANNELS = ["email", "sms", "whatsapp", "voice", "chat"] as const;
export type InboxChannel = (typeof INBOX_CHANNELS)[number];

/** Narrow an arbitrary value to a known {@link InboxChannel}. */
export function isInboxChannel(value: unknown): value is InboxChannel {
  return typeof value === "string" && (INBOX_CHANNELS as readonly string[]).includes(value);
}

/** Human labels for the channel pills. */
export const INBOX_CHANNEL_LABELS: Record<InboxChannel, string> = {
  email: "Email",
  sms: "SMS",
  whatsapp: "WhatsApp",
  voice: "Voice",
  chat: "Chat",
};

/**
 * Map an AI-receptionist inbound channel to the inbox's canonical channel. TOTAL — an
 * unknown value falls to "chat". The TypeScript mirror of the SQL
 * `inbox_channel_for_enquiry`; the two MUST agree (a test pins the mapping).
 */
export function inboxChannelForEnquiry(channel: string): InboxChannel {
  switch (channel) {
    case "phone":
    case "whatsapp_call":
      return "voice";
    case "sms":
      return "sms";
    case "whatsapp_msg":
      return "whatsapp";
    case "email":
      return "email";
    default:
      return "chat";
  }
}

/**
 * The outbound TRANSPORT a reply on this channel rides, or `null` when the channel has
 * no wired outbound sender. email → the Resend seam; sms/whatsapp → the messaging seam;
 * voice/chat → null (a reply can be composed and QUEUED but there is no provider to send
 * it, so it degrades to the dark-safe "provider not configured" state). This is the ONE
 * place the inbox decides "can this channel send at all", mirroring
 * `transportChannelForInbound` for the receptionist.
 */
export function transportForInboxChannel(
  channel: InboxChannel,
): "email" | "sms" | "whatsapp" | null {
  switch (channel) {
    case "email":
      return "email";
    case "sms":
      return "sms";
    case "whatsapp":
      return "whatsapp";
    case "voice":
    case "chat":
      return null;
  }
}

/** True when a channel has a wired outbound transport (email/sms/whatsapp). */
export function canSendOnChannel(channel: InboxChannel): boolean {
  return transportForInboxChannel(channel) !== null;
}

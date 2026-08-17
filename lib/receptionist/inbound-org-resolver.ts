import "server-only";
import { resolveOrgForDialedNumber } from "@/lib/telephony/router";
import { resolveOrgForNumber as resolveOrgForWhatsAppNumber } from "@/server/services/whatsapp-webhook-handler";
import { resolveOrgForAddress as resolveOrgForEmailAddress } from "@/server/services/email-webhook-handler";
import type { InboundChannel } from "@/lib/receptionist/types";

/**
 * Org attribution for the shared normalised inbound endpoint
 * (`app/api/receptionist/inbound`).
 *
 * A single shared secret (`CHANNEL_INBOUND_SECRET`) gates the endpoint, and
 * EVERY tenant configures the same secret — so the secret proves "a channel
 * adapter is calling", NEVER "which org this is for". Per the codebase's inbound
 * invariant (see supabase/migrations/20261126000000_inbound_email_ingestion.sql
 * and 20260918000000_whatsapp_number_routes.sql): "with a shared secret, org
 * attribution is a LOOKUP on the verified infra identity the sender reached —
 * never a per-org credential and never a guess."
 *
 * So the org is resolved HERE, from the DESTINATION the sender reached, using the
 * EXACT same per-channel provisioned-route tables (and resolver functions) the
 * dedicated provider webhooks use:
 *   - phone / sms          → `phone_numbers`         (dialed E.164)
 *   - whatsapp_msg / _call → `whatsapp_number_routes` (Meta phone_number_id)
 *   - email                → `email_inbound_routes`  (inbound address)
 *
 * Channels with NO provisioned-route table (instagram_dm, facebook_dm, manual)
 * cannot be attributed from a reached infra identity, so they resolve to null →
 * the caller ACK-DROPS with no tenant write. A body-claimed org is NEVER trusted
 * for attribution; the endpoint only cross-checks it against this result.
 *
 * `destination` is the infra identity the inbound event reached:
 *   the dialed E.164 (phone/sms), the Meta phone_number_id (whatsapp), or the
 *   inbound email address (email). It is caller-supplied but not trusted for
 *   attribution — it is a KEY into an admin-provisioned route table, and a value
 *   that matches no active route resolves to null.
 */
export async function resolveInboundOrg(
  channel: InboundChannel,
  destination: string | null,
): Promise<string | null> {
  const to = destination?.trim() ? destination.trim() : null;
  if (!to) return null;

  switch (channel) {
    case "phone":
    case "sms":
      return resolveOrgForDialedNumber(to);
    case "whatsapp_msg":
    case "whatsapp_call":
      return resolveOrgForWhatsAppNumber(to);
    case "email":
      return resolveOrgForEmailAddress(to);
    // No provisioned-route table exists for these channels, so an inbound event
    // cannot be attributed to an org from the reached infra identity. Resolve to
    // null → ack-drop, never a guessed org.
    case "instagram_dm":
    case "facebook_dm":
    case "manual":
      return null;
    default: {
      // Exhaustiveness guard: a newly added channel must declare its route table
      // here rather than silently falling through to a guessed attribution.
      const _exhaustive: never = channel;
      return _exhaustive;
    }
  }
}

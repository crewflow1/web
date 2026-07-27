import "server-only";
import { env } from "@/lib/env";
import type {
  WhatsAppMessage,
  WhatsAppAcceptance,
  WhatsAppProvider,
  WhatsAppProviderInfo,
} from "../types";

/**
 * Meta WhatsApp Business Cloud API — the OUTBOUND sender (Directive #018 R6, PR3).
 *
 * The mirror of the Twilio SMS adapter, obeying the SAME provider contract: resolve with
 * the provider's acceptance ({@link WhatsAppAcceptance}, carrying Meta's `wamid`), or THROW
 * on ANY failure so the canonical transport records a `failed`/provider_error attempt and
 * owns retry — never a silent no-op, never a half-send.
 *
 * Meta has no official Node SDK for Cloud API messaging, so the vendor call is a plain
 * Graph API POST via built-in `fetch` (no dynamic import to keep out of the bundle). This
 * file holds ONLY the sender; inbound verify/parse/normalize live in `meta-whatsapp.ts`.
 *
 * DARK by default: this provider is constructed ONLY when getWhatsAppProvider() sees both
 * WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID (unset in CI) — so nothing here runs
 * in CI or dev. The 24-hour customer-care window is enforced by Meta: an out-of-window
 * free-form send returns a non-2xx, which THROWS here → a recorded `failed` transport,
 * never an un-templated leak.
 */

const INFO: WhatsAppProviderInfo = { provider: "meta", channel: "whatsapp" };
const DEFAULT_GRAPH_VERSION = "v21.0";

export function createMetaWhatsAppProvider(): WhatsAppProvider {
  return {
    info: INFO,
    async send(message: WhatsAppMessage): Promise<WhatsAppAcceptance> {
      const token = env.WHATSAPP_ACCESS_TOKEN;
      // A per-send `from` override wins (a future multi-number routing), else the configured id.
      const phoneNumberId = message.from ?? env.WHATSAPP_PHONE_NUMBER_ID;
      const version = env.WHATSAPP_GRAPH_VERSION?.trim() || DEFAULT_GRAPH_VERSION;

      // The factory only returns this provider when creds are present, but the contract is
      // THROW-on-failure — a missing credential becomes a recorded failed/provider_error
      // attempt, never a silent send (mirrors the Twilio adapter's defensive guard).
      if (!token || !phoneNumberId) {
        throw new Error(
          "meta-whatsapp: missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID",
        );
      }

      const res = await fetch(
        `https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: message.to,
            type: "text",
            text: { body: message.body },
          }),
        },
      );

      if (!res.ok) {
        // Truncate the body so a provider error can never balloon into a log/DB payload, and
        // never surface a token (the request carried it in the header, not the response body).
        const detail = await res.text().catch(() => "");
        throw new Error(
          `meta-whatsapp: send failed (${res.status}) ${detail.slice(0, 500)}`,
        );
      }

      const json = (await res.json().catch(() => null)) as {
        messages?: { id?: string; message_status?: string }[];
      } | null;
      const wamid = json?.messages?.[0]?.id;
      if (!wamid) {
        throw new Error("meta-whatsapp: send accepted but returned no wamid");
      }
      return {
        providerMessageId: wamid,
        status: json?.messages?.[0]?.message_status ?? null,
      };
    },
  };
}

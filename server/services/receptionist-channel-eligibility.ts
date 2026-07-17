import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { InboundChannel } from "@/lib/receptionist/types";

/**
 * THE single authority on whether an inbound channel may reach the reasoning engine
 * (`runConversationTurn`). One decision point, so feature-flag logic is NOT scattered
 * across the ingestion, runtime, and transport layers.
 *
 * Fail-closed by construction: every channel not explicitly cleared returns `false`,
 * and every WhatsApp error/absent-config path returns `false`. Opening a channel here
 * is the ONLY thing that lets its inbound reach the AI — so the default-deny switch is
 * the safety boundary.
 *
 * Posture per channel:
 *   - `phone`        → unchanged from the R6 missed-call text-back gate: the env flag
 *                      ONLY, no per-org read, no new I/O, no new failure mode. Phone
 *                      behaviour is not weakened.
 *   - `whatsapp_msg` → the global dark switch (NEXT_PUBLIC_FEATURE_WHATSAPP) AND per-org
 *                      enablement: the org's `ai_receptionist_setups` row must be
 *                      `enabled = true` AND fully provisioned (`status = 'live'`). An
 *                      org still in `in_progress`/`testing`, or with no row, is dark.
 *   - everything else (sms, whatsapp_call, instagram_dm, facebook_dm, manual) → closed.
 *
 * NOTE: eligibility only decides whether the AI *drafts* a turn. It does NOT authorise
 * an outbound send — that is a separate, still-dark gate in the transport seam
 * (`getWhatsAppProvider()` is null, so a WhatsApp reply records no_provider and sends
 * nothing, and never falls back to SMS).
 */
export async function canRunReceptionistChannel(input: {
  org_id: string;
  channel: InboundChannel;
}): Promise<boolean> {
  switch (input.channel) {
    case "phone":
      // Byte-for-byte the pre-existing gate: env flag only, no per-org read.
      return process.env.NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK === "true";

    case "whatsapp_msg":
      // Global dark switch first (cheap), then the per-org enablement read.
      if (process.env.NEXT_PUBLIC_FEATURE_WHATSAPP !== "true") return false;
      return await isWhatsAppEnabledForOrg(input.org_id);

    default:
      // Fail closed: no other channel reaches the reasoning engine yet.
      return false;
  }
}

/**
 * Per-org WhatsApp enablement, read from `ai_receptionist_setups`. Fail-closed on any
 * error or missing row — an eligibility read must NEVER throw into the ingestion turn,
 * and an org that is not explicitly provisioned-and-live is dark.
 */
async function isWhatsAppEnabledForOrg(orgId: string): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const table = admin.from("ai_receptionist_setups" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          maybeSingle: () => Promise<{
            data: { enabled: boolean | null; status: string | null } | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
    const { data, error } = await table
      .select("enabled, status")
      .eq("org_id", orgId)
      .maybeSingle();
    if (error) {
      console.error("[receptionist] whatsapp org-eligibility read failed", {
        org_id: orgId,
        message: error.message,
      });
      return false;
    }
    if (!data) return false;
    return data.enabled === true && data.status === "live";
  } catch (e) {
    console.error("[receptionist] whatsapp org-eligibility threw", {
      org_id: orgId,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Voice Telephony (Wave 8) — org routing by DIALED number.
 *
 * A single Twilio/Vapi account signs every tenant's inbound webhook, so org
 * attribution is a DATABASE lookup on the number the caller DIALED (the infra
 * identity they reached), never a per-org credential — the exact posture of
 * whatsapp-webhook-handler's `resolveOrgForNumber`. The mapping lives in
 * `phone_numbers` and must be admin-provisioned; it cannot be derived.
 *
 * A dialed number with no ACTIVE route resolves to null → the caller is
 * ack-dropped, never processed against a guessed org. An unattributable call
 * must not touch tenant data.
 */

/** Resolve the org that owns an active route for a dialed E.164 number, or null. */
export async function resolveOrgForDialedNumber(e164: string | null): Promise<string | null> {
  if (!e164 || !e164.trim()) return null;
  const admin = createAdminClient();
  const res = await (
    admin.from("phone_numbers" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{
              data: { org_id: string } | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    }
  )
    .select("org_id")
    .eq("e164", e164.trim())
    .eq("active", true)
    .maybeSingle();

  if (res.error) {
    console.error("[telephony] dialed-number route lookup failed", {
      e164: e164.trim(),
      message: res.error.message,
    });
    return null;
  }
  return res.data?.org_id ?? null;
}

/**
 * Resolve the org for a call from its PROVIDER CALL ID (Twilio CallSid), or null.
 *
 * Some provider callbacks — notably the recording-status callback — do NOT carry
 * the dialed number, only the CallSid. The call was already attributed (the
 * origination/status edge wrote the `calls` row org-pinned), so we resolve the org
 * from that existing row. Null when no such call exists (an unattributable
 * callback is ignored, never processed against a guessed org).
 */
export async function resolveOrgForProviderCall(
  provider: string,
  providerCallId: string | null,
): Promise<string | null> {
  if (!providerCallId || !providerCallId.trim()) return null;
  const admin = createAdminClient();
  const res = await (
    admin.from("calls" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{
              data: { org_id: string } | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    }
  )
    .select("org_id")
    .eq("provider", provider)
    .eq("provider_call_id", providerCallId.trim())
    .maybeSingle();

  if (res.error) {
    console.error("[telephony] provider-call org lookup failed", {
      providerCallId: providerCallId.trim(),
      message: res.error.message,
    });
    return null;
  }
  return res.data?.org_id ?? null;
}

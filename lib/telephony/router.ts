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

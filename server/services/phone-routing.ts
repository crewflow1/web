import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Phone-number → organisation routing for inbound telephony.
 *
 * The single source of truth for "which org owns this number" is the
 * phone_numbers table. A call's org_id is ALWAYS derived here from the
 * DIALLED number — never trusted from a webhook body — so one tenant can
 * never receive another tenant's calls.
 */

export type NumberRoute = {
  org_id: string;
  phone_number_id: string;
  vapi_assistant_id: string | null;
};

/**
 * Normalise a phone number to a bare E.164 string ("+" + digits).
 *
 * Vapi delivers E.164 already (e.g. "+447911123456"); this strips any
 * spaces/punctuation and canonicalises common UK formats so a number
 * stored as "07911 123456" or "+44 7911 123456" still matches the same
 * row. The product is UK-only, so UK canonicalisation is safe.
 */
export function normalizeE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const hadPlus = trimmed.startsWith("+");
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  // An explicit international prefix wins as-is.
  if (hadPlus) return `+${digits}`;
  if (digits.startsWith("00")) digits = digits.slice(2); // 0044… → 44…
  if (digits.startsWith("44")) return `+${digits}`; // 44… → +44…
  if (digits.startsWith("0")) return `+44${digits.slice(1)}`; // 07… → +447…
  return `+${digits}`;
}

// phone_numbers isn't in the generated Database types yet (added by
// migration 20260630000000), so we narrow the admin client locally.
type PhoneLookup = {
  select: (cols: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        maybeSingle: () => Promise<{
          data: {
            id: string;
            org_id: string;
            vapi_assistant_id: string | null;
          } | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
};

/**
 * Resolve the organisation that owns a dialled number. Returns null when
 * the number is unknown or inactive — the caller (the Vapi webhook) then
 * declines to serve an assistant, so calls to unprovisioned numbers are
 * never silently attached to the wrong tenant.
 */
export async function resolveOrgByNumber(
  rawNumber: string | null | undefined,
): Promise<NumberRoute | null> {
  const e164 = normalizeE164(rawNumber);
  if (!e164) return null;

  const admin = createAdminClient();
  const { data, error } = await (
    admin.from("phone_numbers" as never) as unknown as PhoneLookup
  )
    .select("id, org_id, vapi_assistant_id")
    .eq("e164", e164)
    .eq("status", "active")
    .maybeSingle();

  if (error) {
    console.error("[phone-routing] lookup failed", error.message);
    return null;
  }
  if (!data) return null;
  return {
    org_id: data.org_id,
    phone_number_id: data.id,
    vapi_assistant_id: data.vapi_assistant_id ?? null,
  };
}

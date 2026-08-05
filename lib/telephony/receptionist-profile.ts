import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Voice Telephony (Wave 8, C35) — the PER-ORG receptionist identity the voice
 * runtime speaks AS.
 *
 * A per-org configuration row already exists (`ai_receptionist_setups`:
 * preferred_voice, business_hours, trade_type) alongside `organizations.name`,
 * but before this the voice runtime never READ it — every tenant got the same
 * anonymous greeting/assistant/voice. This module is the read + the pure
 * builders that turn that row into a business name, a spoken greeting, an
 * injection-safe AI context string and a Vapi voiceId.
 *
 * DARK-SAFE + BEST-EFFORT: the load runs on the SERVICE-ROLE admin client (the
 * webhook has no signed-in user), org-pinned, AFTER the dark + signature gates in
 * every route. It NEVER throws — any failure (unconfigured admin client, DB
 * error, no row) degrades to `null`, and the callers then fall back to the
 * existing GENERIC behaviour (the safe default). It reads only scalar columns,
 * embeds nothing, and pins `org_id` explicitly (defence in depth on the
 * RLS-bypassing client).
 */

/** The per-org receptionist identity, or nulls where the org has configured none. */
export type ReceptionistProfile = {
  /** `organizations.name` — the business the call is answered on behalf of. */
  businessName: string | null;
  /** `ai_receptionist_setups.preferred_voice` — free text, mapped to a voiceId. */
  preferredVoice: string | null;
  /** `ai_receptionist_setups.business_hours` — free text, AI CONTEXT only. */
  businessHours: string | null;
  /** `ai_receptionist_setups.trade_type` — free text, AI CONTEXT only. */
  tradeType: string | null;
};

/** The generic anonymous greeting used when no per-org profile exists (unchanged). */
export const DEFAULT_GREETING = "Thank you for calling. How can I help you today?";

/** The default Vapi voiceId — the current, generic receptionist voice. */
export const DEFAULT_VAPI_VOICE_ID = "Elliot";

/**
 * Vapi's built-in voice ids. A `preferred_voice` that names one of these
 * (case-insensitively) is used verbatim; anything else is mapped by gender hint
 * or degrades to the default. Kept as a small, explicit allow-list so a caller-
 * or admin-supplied free-text value can never inject an arbitrary provider knob.
 */
const VAPI_VOICE_IDS = [
  "Elliot",
  "Kylie",
  "Rohan",
  "Lily",
  "Savannah",
  "Hana",
  "Neha",
  "Cole",
  "Harry",
  "Paige",
  "Spencer",
] as const;

/**
 * Load the org's business identity + receptionist preferences. Org-pinned,
 * admin client, best-effort. Returns `null` when nothing is configured OR on any
 * failure — the caller then uses the generic fallback. Never throws.
 */
export async function loadReceptionistProfile(
  orgId: string | null | undefined,
): Promise<ReceptionistProfile | null> {
  if (!orgId || !orgId.trim()) return null;
  const id = orgId.trim();

  try {
    const admin = createAdminClient();

    // Business name — organizations.name, org-pinned by primary key.
    let businessName: string | null = null;
    {
      const { data, error } = await (
        admin.from("organizations" as never) as unknown as {
          select: (cols: string) => {
            eq: (k: string, v: unknown) => {
              maybeSingle: () => Promise<{
                data: { name: string | null } | null;
                error: { message: string } | null;
              }>;
            };
          };
        }
      )
        .select("name")
        .eq("id", id)
        .maybeSingle();
      if (error) {
        console.error("[telephony] receptionist profile: org name read failed", {
          orgId: id,
          message: error.message,
        });
      } else {
        businessName = data?.name?.trim() || null;
      }
    }

    // Receptionist preferences — the per-org setup row, org-pinned. Absent ⇒ the
    // generic fallback (this is the safe default the whole seam degrades to).
    let preferredVoice: string | null = null;
    let businessHours: string | null = null;
    let tradeType: string | null = null;
    {
      const { data, error } = await (
        admin.from("ai_receptionist_setups" as never) as unknown as {
          select: (cols: string) => {
            eq: (k: string, v: unknown) => {
              maybeSingle: () => Promise<{
                data: {
                  preferred_voice: string | null;
                  business_hours: string | null;
                  trade_type: string | null;
                } | null;
                error: { message: string } | null;
              }>;
            };
          };
        }
      )
        .select("preferred_voice, business_hours, trade_type")
        .eq("org_id", id)
        .maybeSingle();
      if (error) {
        console.error("[telephony] receptionist profile: setup read failed", {
          orgId: id,
          message: error.message,
        });
      } else if (data) {
        preferredVoice = data.preferred_voice?.trim() || null;
        businessHours = data.business_hours?.trim() || null;
        tradeType = data.trade_type?.trim() || null;
      }
    }

    if (!businessName && !preferredVoice && !businessHours && !tradeType) return null;
    return { businessName, preferredVoice, businessHours, tradeType };
  } catch (e) {
    // Unconfigured admin client / unexpected error ⇒ generic fallback. Best-effort.
    console.error("[telephony] receptionist profile load failed", {
      orgId: id,
      message: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * The org's spoken greeting / Vapi firstMessage. Falls back to the generic
 * anonymous greeting when no business name is known, so the pre-fix behaviour is
 * exactly preserved for an unconfigured org.
 */
export function buildReceptionistGreeting(profile?: ReceptionistProfile | null): string {
  const name = profile?.businessName?.trim();
  if (!name) return DEFAULT_GREETING;
  return `Thank you for calling ${name}. How can I help you today?`;
}

/**
 * Build the org's business identity as INJECTION-SAFE CONTEXT for the AI turn —
 * DATA the receptionist may reference, never instructions that can rewrite its
 * rules. The caller-facing prompt frames it explicitly as information, and this
 * returns `null` when there is nothing to add (so the prompt is unchanged for an
 * unconfigured org).
 */
export function buildReceptionistContext(profile?: ReceptionistProfile | null): string | null {
  if (!profile) return null;
  const parts: string[] = [];
  if (profile.businessName) parts.push(`Business name: ${profile.businessName}`);
  if (profile.tradeType) parts.push(`Trade: ${profile.tradeType}`);
  if (profile.businessHours) parts.push(`Business hours: ${profile.businessHours}`);
  if (parts.length === 0) return null;
  return parts.join(". ");
}

/**
 * Map the org's free-text `preferred_voice` onto a Vapi voiceId. An exact
 * (case-insensitive) match to a known Vapi voice wins; else a gender hint maps to
 * a sensible default; else the generic default. Never returns arbitrary caller/
 * admin text — only a value from the closed allow-list.
 */
export function mapPreferredVoiceToVapiVoiceId(preferred?: string | null): string {
  const v = (preferred ?? "").trim();
  if (!v) return DEFAULT_VAPI_VOICE_ID;
  const exact = VAPI_VOICE_IDS.find((id) => id.toLowerCase() === v.toLowerCase());
  if (exact) return exact;
  const lower = v.toLowerCase();
  if (/\b(female|woman|womens|lady|f)\b/.test(lower)) return "Paige";
  if (/\b(male|man|mens|gent|m)\b/.test(lower)) return "Elliot";
  return DEFAULT_VAPI_VOICE_ID;
}

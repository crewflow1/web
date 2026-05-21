/**
 * staff_secrets — admin-only read/write of payroll-sensitive fields.
 *
 * The data lives in its own table behind a stricter RLS gate than
 * `public.users`. Server-side helpers here use the user JWT, so any
 * caller of these functions still has to be an org admin (RLS enforces
 * it; the helper just returns null on read for non-admins).
 */

import "server-only";
import { createClient } from "@/lib/supabase/server";

const UK_NI_REGEX = /^[A-CEGHJ-PR-TW-Z]{2}[0-9]{6}[A-D]$/;

/**
 * Validate a UK National Insurance number. Returns the canonical form
 * (upper-cased, no spaces) or null if it doesn't match the standard
 * 2-letter + 6-digit + 1-letter pattern with the legal prefix letters.
 */
export function canonicaliseNiNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s+/g, "").toUpperCase();
  return UK_NI_REGEX.test(cleaned) ? cleaned : null;
}

export type SecretsRow = {
  user_id: string;
  ni_number: string | null;
};

/**
 * Bulk-fetch NI numbers for an org. Returns a Map<user_id, ni_number>.
 * RLS-gated — staff users get an empty map.
 */
export async function fetchNiNumbersForOrg(
  orgId: string,
): Promise<Map<string, string>> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("staff_secrets")
    .select("user_id, ni_number")
    .eq("org_id", orgId);
  const out = new Map<string, string>();
  for (const row of (data ?? []) as SecretsRow[]) {
    if (row.ni_number) out.set(row.user_id, row.ni_number);
  }
  return out;
}

/**
 * Mask an NI number for read-only display. "AB123456C" → "AB****56C".
 * Used in payroll PDFs + tables so an over-the-shoulder glance never
 * exposes the full number.
 */
export function maskNiNumber(ni: string | null | undefined): string {
  if (!ni) return "—";
  if (ni.length < 7) return "***";
  return `${ni.slice(0, 2)}****${ni.slice(-3)}`;
}

/**
 * Upsert a staff member's NI number. Admin-only via RLS. Returns the
 * stored value or null if validation failed.
 */
export async function upsertStaffNiNumber(
  orgId: string,
  userId: string,
  rawNumber: string | null | undefined,
  actorId: string,
): Promise<{ ok: true; ni: string | null } | { ok: false; error: string }> {
  const supabase = await createClient();
  if (rawNumber === null || rawNumber === undefined || rawNumber === "") {
    // Clear it.
    const { error } = await supabase
      .from("staff_secrets")
      .upsert({ org_id: orgId, user_id: userId, ni_number: null, updated_by: actorId });
    if (error) return { ok: false, error: error.message };
    return { ok: true, ni: null };
  }
  const ni = canonicaliseNiNumber(rawNumber);
  if (!ni) {
    return {
      ok: false,
      error: "NI number must be 2 letters, 6 digits, then 1 letter (e.g. AB123456C).",
    };
  }
  const { error } = await supabase
    .from("staff_secrets")
    .upsert({ org_id: orgId, user_id: userId, ni_number: ni, updated_by: actorId });
  if (error) return { ok: false, error: error.message };
  return { ok: true, ni };
}

import "server-only";
import { env } from "@/lib/env";

/**
 * Super-admin allowlist check.
 *
 * Super-admin === a member of the CrewFlow team. Distinct from org
 * owner/admin (which is per-tenant). Powers /admin/organizations,
 * which gates new-signup approval.
 *
 * Source of truth: comma-separated CREWFLOW_SUPERADMIN_EMAILS env var.
 * Empty/unset → nobody is a super-admin and the /admin route 404s for
 * everyone (including CrewFlow team — set the env var to enable).
 *
 * Matching is case-insensitive and trims whitespace.
 */
export function isSuperAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const raw = env.CREWFLOW_SUPERADMIN_EMAILS ?? "";
  if (!raw.trim()) return false;
  const needle = email.trim().toLowerCase();
  const haystack = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return haystack.includes(needle);
}

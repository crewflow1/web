import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client — BYPASSES Row-Level Security.
 *
 * Only call this from server-only modules, and only for operations that
 * legitimately need elevated privilege:
 *   - Mirroring auth.users into public.users on first signup
 *   - Creating an organisation + membership atomically during onboarding
 *   - Internal cron / webhook handlers writing to multiple tenants
 *
 * NEVER expose this client to user input without strict validation. A bug
 * here can leak data across tenants.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Supabase admin client not configured. Set SUPABASE_SERVICE_ROLE_KEY in Vercel env vars.",
    );
  }

  return createSupabaseClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

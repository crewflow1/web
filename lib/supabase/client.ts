import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser Supabase client.
 *
 * Use this from Client Components for client-side queries and realtime
 * subscriptions. Never use this for sensitive operations — the anon key
 * is public and RLS is the only thing protecting tenant data.
 *
 * Both env vars are read into constants and asserted explicitly so a
 * misconfigured deploy fails loudly with a useful message — instead of
 * Supabase's confusing "No API key found in request" error that surfaces
 * downstream when an undefined anon key is passed in.
 */
export function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  }
  if (!supabaseAnonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  return createBrowserClient(supabaseUrl, supabaseAnonKey);
}

import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser Supabase client.
 *
 * Use this from Client Components for client-side queries and realtime
 * subscriptions. Never use this for sensitive operations — the anon key
 * is public and RLS is the only thing protecting tenant data.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

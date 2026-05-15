import "server-only";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "./types";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

/**
 * Server-side Supabase client (user JWT context).
 *
 * Use this from Server Components, Server Actions, and Route Handlers
 * when you want queries to respect Row-Level Security and run as the
 * currently signed-in user.
 *
 * For privileged operations that need to bypass RLS (e.g., creating a
 * user's mirror row before they have any memberships), use the admin
 * client from ./admin instead.
 *
 * Env vars are read into constants and asserted explicitly so a missing
 * anon key fails loudly here instead of producing Supabase's downstream
 * "No API key found in request" error during signInWithOAuth /
 * exchangeCodeForSession.
 */
export async function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  }
  if (!supabaseAnonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  const cookieStore = await cookies();

  return createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Setting cookies from a Server Component throws.
          // The middleware refreshes sessions on every request, so this
          // is safe to ignore here.
        }
      },
    },
  });
}

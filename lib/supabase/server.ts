import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

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
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
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
    },
  );
}

import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Top-level middleware — delegates to the Supabase session helper.
 *
 * Block 2: session refresh + auth redirects.
 * Block 3+ may add: request-id headers, rate limiting, A/B flag injection.
 */
export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // Skip Next internals, static files, and the health check (always public).
  // Crons are gated by CRON_SECRET (lib/cron/auth.ts), not by the Supabase
  // session middleware; exclude them so Vercel's scheduler can reach them.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health|api/cron|api/demo).*)"],
};

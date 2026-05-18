import { NextResponse } from "next/server";

/**
 * TEMPORARY diagnostic — reports env-var PRESENCE only (no values).
 *
 * Same Node runtime as /api/ai/* so the answer is faithful to what those
 * routes see at runtime. Anonymous, but the middleware matcher must
 * allow it; we add /api/_diag to the exclusion list alongside /api/health.
 *
 * REMOVE THIS FILE in the follow-up cleanup PR.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const reveal = (v: string | undefined) => ({
    present: !!v,
    length: v ? v.length : 0,
  });

  return NextResponse.json(
    {
      ok: true,
      runtime: "node",
      node_env: process.env.NODE_ENV ?? null,
      vercel_env: process.env.VERCEL_ENV ?? null,
      sha: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
      env_presence: {
        ANTHROPIC_API_KEY:           reveal(process.env.ANTHROPIC_API_KEY),
        OPENAI_API_KEY:              reveal(process.env.OPENAI_API_KEY),
        KV_REST_API_URL:             reveal(process.env.KV_REST_API_URL),
        KV_REST_API_TOKEN:           reveal(process.env.KV_REST_API_TOKEN),
        SUPABASE_SERVICE_ROLE_KEY:   reveal(process.env.SUPABASE_SERVICE_ROLE_KEY),
        NEXT_PUBLIC_SUPABASE_URL:    reveal(process.env.NEXT_PUBLIC_SUPABASE_URL),
        NEXT_PUBLIC_SUPABASE_ANON_KEY: reveal(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      },
    },
    { headers: { "cache-control": "no-store, max-age=0" } },
  );
}

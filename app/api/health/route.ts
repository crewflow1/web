import { NextResponse } from "next/server";

/**
 * Health check endpoint.
 *
 * Hit by:
 *  - BetterStack uptime monitor (Block 2 wires this up)
 *  - Manual sanity check after every deploy
 *  - Block 1 acceptance test: returns 200 with build SHA
 */
export const dynamic = "force-dynamic";
export const runtime = "edge";

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      service: "crewflow-web",
      env: process.env.APP_ENV ?? process.env.VERCEL_ENV ?? "development",
      sha: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
      branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
      timestamp: new Date().toISOString(),
    },
    {
      headers: {
        "cache-control": "no-store, max-age=0",
      },
    },
  );
}

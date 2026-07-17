import { NextResponse } from "next/server";
import { getCommsReadiness } from "@/lib/comms/readiness";

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
  // Communications readiness — booleans only (no env-var names) since this endpoint is public.
  // Makes a misconfigured deploy that would SILENTLY drop customer emails visible to the smoke
  // test + uptime monitor. `comms.email=false` in production is an alert, not a mystery.
  const comms = getCommsReadiness();
  return NextResponse.json(
    {
      ok: true,
      service: "crewflow-web",
      env: process.env.APP_ENV ?? process.env.VERCEL_ENV ?? "development",
      sha: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
      branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
      comms: {
        email: comms.email.configured,
        sms: comms.sms.configured,
        whatsapp: comms.whatsapp.configured,
        missedCallTextbackReady: comms.missedCallTextback.ready,
      },
      timestamp: new Date().toISOString(),
    },
    {
      headers: {
        "cache-control": "no-store, max-age=0",
      },
    },
  );
}

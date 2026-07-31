import { NextResponse } from "next/server";
import { getCommsReadiness } from "@/lib/comms/readiness";
import { getWeatherReadiness } from "@/lib/weather/readiness";

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
  //
  // Every boolean below is `outboundReady` — "this runtime CAN ACTUALLY SEND on this channel" —
  // never the weaker "credentials are set". They previously reported `configured`, which read
  // only the env vars: WhatsApp would have gone green the moment an operator set the Meta token
  // and phone-number id, even though no WhatsApp sender existed in the build at all. A health
  // endpoint that goes green over a dead path is worse than no endpoint. The response SHAPE is
  // unchanged (same keys, same booleans) — only the honesty of the values improved, and each can
  // now only be true when the sender exists, the credentials are present, the provider selection
  // is usable, and the channel's feature flag is on.
  const comms = getCommsReadiness();

  // Weather intelligence readiness (20261074). `available` — "this runtime can
  // actually obtain weather for a site" — never the weaker "a key is set". It is
  // `false` in every environment today because no provider adapter exists in the
  // build, and it can never go true on a credential alone. Reported here for the
  // same reason comms is: so a deploy that BELIEVES it has weather but cannot
  // fetch any is visible to the smoke test rather than being discovered by a site
  // manager who saw no warning and assumed there was nothing to warn about.
  // Boolean only — this endpoint is public and must not name env vars.
  const weather = getWeatherReadiness();

  return NextResponse.json(
    {
      ok: true,
      service: "crewflow-web",
      env: process.env.APP_ENV ?? process.env.VERCEL_ENV ?? "development",
      sha: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
      branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
      comms: {
        email: comms.email.outboundReady,
        sms: comms.sms.outboundReady,
        whatsapp: comms.whatsapp.outboundReady,
        missedCallTextbackReady: comms.missedCallTextback.ready,
      },
      weather: {
        available: weather.available,
        // The build-time half, so a false `available` is diagnosable without
        // shell access: "no adapter" and "no key" need different actions.
        providerImplemented: weather.providerImplemented,
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

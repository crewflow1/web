import { NextResponse } from "next/server";
import { getCommsReadiness } from "@/lib/comms/readiness";
import { getIntegrationsReadiness } from "@/lib/integrations/readiness";
import { getWeatherReadiness } from "@/lib/weather/readiness";
import { probeDatabase } from "@/lib/health/db-probe";

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

  // API-key substrate readiness (Train 9). Build-time facts only — the
  // substrate needs no credentials and has no flag, so unlike comms there is
  // no configured/ready split to get wrong. Booleans (+ a count) only; this
  // endpoint is public and must not name env vars. `endpoints: 1` is the
  // /api/v1/me probe — the substrate's living proof, not a product surface.
  const integrations = getIntegrationsReadiness();

  // Live database reachability. This is the ONLY signal that gates `ok`/`status`: an unreachable
  // Postgres means the app cannot serve requests, so the endpoint must go non-green. The comms,
  // weather and integrations booleans above are READINESS signals (can-this-channel-send, etc.)
  // and deliberately do NOT gate `ok` — a dark-but-healthy provider is not an outage. The probe
  // never throws and the endpoint always returns HTTP 200 so the JSON body is the source of truth.
  const db = await probeDatabase();

  return NextResponse.json(
    {
      ok: db.ok,
      status: db.ok ? "healthy" : "degraded",
      db: db.ok ? "ok" : "degraded",
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
      integrations: {
        apiKeys: {
          implemented: integrations.apiKeys.implemented,
          endpoints: integrations.apiKeys.endpoints,
        },
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

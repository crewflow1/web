import { NextResponse, type NextRequest } from "next/server";

import { isMaintenanceMode } from "@/lib/maintenance";
import {
  isCalendarProviderConnectable,
  CALENDAR_PROVIDERS,
  type CalendarProvider,
} from "@/lib/integrations/calendar/oauth";
import { bestEffortHandleInbound } from "@/server/services/calendar-pull";

/**
 * Calendar PULL — provider webhook receiver. DARK.
 *
 *   POST /api/integrations/calendar/{google|microsoft}/webhook
 *
 * The inbound door for a provider push notification (Google events.watch /
 * Microsoft subscription). It is UNAUTHENTICATED in the CrewFlow sense (the
 * provider, not a logged-in user, calls it) — so the trust boundary is the
 * per-channel VERIFICATION SECRET the notification echoes, checked constant-time
 * against the stored secret by the service. There is no user session here.
 *
 * The order, dark-safe:
 *   1. MAINTENANCE gate → retry-safe 503 (provider re-delivers after the window).
 *   2. VALIDATE the provider path segment (404 otherwise).
 *   3. MICROSOFT VALIDATION HANDSHAKE — a subscription-creation probe arrives with
 *      `?validationToken=`; echo it back as text/plain 200 (required, harmless).
 *   4. DARK GUARD — if the provider is not connectable, return a 200 no-op WITHOUT
 *      any provider fetch (refuse-before-fetch). No watch channel can exist dark,
 *      so this is the structural guarantee that a notification does nothing dark.
 *   5. EXTRACT the channel id + echoed token (Google: headers; Microsoft: body),
 *      then delegate to the service, which resolves the org by channel id,
 *      CONSTANT-TIME verifies the token, and triggers an incremental pull. An
 *      unverified notification is a silent 2xx no-op (never leaks whether a channel
 *      exists, never retries-storms the provider).
 *
 * No secret is ever logged.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID: readonly CalendarProvider[] = CALENDAR_PROVIDERS;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  // 1. Maintenance-window gate — retry-safe 503 so the provider re-delivers.
  if (isMaintenanceMode()) {
    return NextResponse.json(
      { ok: false, maintenance: true },
      { status: 503, headers: { "retry-after": "120", "cache-control": "no-store" } },
    );
  }

  // 2. Validate the provider segment.
  const { provider: providerRaw } = await params;
  if (!VALID.includes(providerRaw as CalendarProvider)) {
    return NextResponse.json({ ok: false, error: "unknown_provider" }, { status: 404 });
  }
  const provider = providerRaw as CalendarProvider;

  // 3. Microsoft subscription-creation validation handshake: echo the token.
  const validationToken = new URL(request.url).searchParams.get("validationToken");
  if (validationToken) {
    return new NextResponse(validationToken, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  // 4. DARK GUARD. Not connectable → no provider work at all (refuse-before-fetch).
  if (!isCalendarProviderConnectable(provider)) {
    return NextResponse.json(
      { ok: false, status: "not_configured" },
      { status: 200 },
    );
  }

  // 5. Extract the channel id + echoed verification token per provider.
  let channelId: string | null = null;
  let providedToken: string | null = null;

  if (provider === "google") {
    channelId = request.headers.get("x-goog-channel-id");
    providedToken = request.headers.get("x-goog-channel-token");
    // The first message after a watch() is a "sync" handshake — nothing changed
    // yet, so ack it without pulling.
    if (request.headers.get("x-goog-resource-state") === "sync") {
      return NextResponse.json({ ok: true, status: "sync_ack" }, { status: 200 });
    }
  } else {
    // Microsoft delivers a JSON body: { value: [{ subscriptionId, clientState, ... }] }.
    let body: unknown = null;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    const value = (body as { value?: unknown } | null)?.value;
    const first = Array.isArray(value) ? (value[0] as Record<string, unknown> | undefined) : undefined;
    channelId = typeof first?.subscriptionId === "string" ? first.subscriptionId : null;
    providedToken = typeof first?.clientState === "string" ? first.clientState : null;
  }

  if (!channelId) {
    return NextResponse.json({ ok: false, error: "missing_channel" }, { status: 400 });
  }

  // Delegate: resolve org by channel id, verify the token constant-time, pull.
  // Failures are swallowed to a 2xx so the provider does not retry-storm; an
  // unverified notification is a silent no-op that leaks nothing.
  const result = await bestEffortHandleInbound({ provider, channelId, providedToken });

  // Microsoft expects 202 Accepted; Google expects any 2xx.
  const status = provider === "microsoft" ? 202 : 200;
  return NextResponse.json({ ok: true, verified: result.verified }, { status });
}

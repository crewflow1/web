import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";
import { calendarConnectFeatureEnabled } from "@/lib/integrations/calendar/oauth";
import { runCalendarSyncTick } from "@/server/services/calendar-pull";

/**
 * Calendar two-way sync — the cron seam that keeps the INBOUND direction alive:
 * it renews each connected org's provider watch channel (provider watches are
 * short-lived by design — Microsoft caps event subscriptions at ~3 days — so
 * without renewal the push-notification path silently dies days after connect)
 * and runs a bounded periodic pull reconciliation, which both drains anything a
 * lost notification skipped and advances the incremental sync cursor.
 *
 *   GET /api/cron/calendar-sync
 *
 * DARK ⇒ 204 NO-OP WITH ZERO DATABASE ACCESS. The feature-flag gate sits BEFORE
 * `withCronTelemetry` on purpose (the bank-sync idiom): telemetry writes a
 * `cron_runs` row, and a dark tick that wrote telemetry would burn a row every
 * few hours to record that nothing can happen. While dark (always today) every
 * tick is an empty 204 that touches neither a provider nor the database — which
 * is why the route is SAFE to keep scheduled in vercel.json before activation:
 * scheduling is not an activation step, so activation stays "credentials + flag
 * only". Zero connected calendars with the flag on is likewise a cheap no-op
 * (one bounded SELECT, zero provider calls).
 *
 * When live, one tick = `runCalendarSyncTick`: enumerate the `connected`
 * connections (bounded, oldest-synced first), renew each expiring/missing watch
 * channel against the provider, and pull each org's event window idempotently
 * (upsert on connection + external event id). The engine never throws per org;
 * outcomes are summarised into the telemetry payload.
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). Returns 401 otherwise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A pass may refresh tokens, re-register watches and page events for several
// orgs; give it room.
export const maxDuration = 60;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // The dark no-op: BEFORE telemetry, before any client — zero DB access.
  if (!calendarConnectFeatureEnabled()) {
    return new NextResponse(null, { status: 204 });
  }

  // The watch callback URL is derived from the canonical app origin — never the
  // inbound request's host (a cron invocation's Host header is not a trusted
  // basis for a URL we hand to a third party).
  const appOrigin = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  if (!appOrigin) {
    return NextResponse.json(
      { ok: false, error: "NEXT_PUBLIC_APP_URL is not configured; cannot derive the watch callback URL." },
      { status: 500 },
    );
  }

  const { status, payload } = await withCronTelemetry("calendar-sync", async () => {
    const summary = await runCalendarSyncTick(appOrigin);
    const watchCounts: Record<string, number> = {};
    const pullCounts: Record<string, number> = {};
    for (const o of summary.outcomes) {
      watchCounts[o.watch] = (watchCounts[o.watch] ?? 0) + 1;
      pullCounts[o.pull] = (pullCounts[o.pull] ?? 0) + 1;
    }
    return {
      ok: summary.outcomes.every((o) => o.ok),
      ran: summary.ran,
      connections: summary.connections,
      watch: watchCounts,
      pull: pullCounts,
    };
  });
  return NextResponse.json(payload, { status });
}

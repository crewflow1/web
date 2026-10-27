import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireHqApi } from "@/server/auth/hq";
import { consume } from "@/lib/security/rate-limit";
import { getMonitoringReadiness } from "@/lib/monitoring/readiness";
import { recordAdminActivity } from "@/server/services/hq-audit";

/**
 * Monitoring self-test — emit ONE harmless synthetic Sentry event so an operator
 * can confirm the production pipeline end-to-end (SDK → Sentry project) WITHOUT
 * crashing anything.
 *
 *   POST /api/admin/monitoring/selftest   (super-admin only)
 *
 * Safety:
 *  - Super-admin gated via requireHqApi() → 404 for anyone else (no info leak),
 *    the API-safe sibling of requireHqPage(). SameSite session cookies already
 *    block a cross-site POST; a same-origin check is layered on top.
 *  - POST only (no GET side-effect), rate-limited (5/min per operator) so it
 *    cannot be used to spam the Sentry quota.
 *  - The event carries ONLY a static marker + two static tags — never a request
 *    body, cookies, tokens, headers or any customer data. `environment` +
 *    `release` come from the SDK's own init config (sentry.*.config.ts), and
 *    `beforeSend: scrubEvent` + `sendDefaultPii:false` still apply.
 *  - Dark/failure-safe: when monitoring has no DSN, `captureMessage` is a safe
 *    SDK no-op; a transport error is caught and returned as `captured:false`,
 *    never thrown. The response never contains the DSN or any credential.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// NB: not exported — a Next.js route module may only export HTTP handlers +
// known route config. The test asserts against the literal.
const MONITORING_SELFTEST_MARKER = "crewflow-monitoring-selftest";

export async function POST(req: Request): Promise<NextResponse> {
  // 1. Authorisation — super-admin only; 404 for everyone else.
  const gate = await requireHqApi();
  if (!gate.ok) return gate.response as NextResponse;
  const user = gate.user;

  // 2. Same-origin defence in depth (SameSite cookies already block cross-site POST).
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(req.url).host) {
        return NextResponse.json({ error: "bad_origin" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "bad_origin" }, { status: 403 });
    }
  }

  // 3. Rate-limit per operator so the endpoint can't spam the Sentry quota.
  //    `consume` uses the durable (cross-instance) store in production, so the
  //    5/min cap holds across serverless cold starts — not just per-instance.
  const rl = await consume("monitoring_selftest", user.id, { limit: 5, windowSeconds: 60 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate_limited", reset_at_epoch_sec: rl.reset_at_epoch_sec },
      { status: 429 },
    );
  }

  const readiness = getMonitoringReadiness();

  // 4. Emit the synthetic event — static marker + static tags only.
  let eventId: string | undefined;
  try {
    eventId = Sentry.captureMessage(MONITORING_SELFTEST_MARKER, {
      level: "info",
      tags: { kind: MONITORING_SELFTEST_MARKER, surface: "admin-selftest" },
    });
    // Flush so the event leaves before a serverless function freezes.
    await Sentry.flush(2000).catch(() => {});
  } catch (e) {
    // A Sentry/transport failure must never fail loudly or leak detail.
    console.error("[monitoring-selftest] capture failed", e);
    return NextResponse.json({ ok: false, monitoringEnabled: readiness.enabled, captured: false });
  }

  // Audit who ran the self-test (no secret, no customer data).
  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "monitoring.selftest",
    targetTable: "organizations",
    targetId: "monitoring",
    metadata: {
      monitoringEnabled: readiness.enabled,
      environment: readiness.environment,
      eventEmitted: Boolean(eventId),
    },
  });

  // 7. Safe response — marker + whether the SDK accepted it + the event id (not a
  //    secret; it helps locate the event in the dashboard). Never the DSN.
  return NextResponse.json({
    ok: true,
    marker: MONITORING_SELFTEST_MARKER,
    monitoringEnabled: readiness.enabled,
    environment: readiness.environment,
    captured: Boolean(eventId),
    eventId: eventId ?? null,
  });
}

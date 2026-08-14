import { NextResponse } from "next/server";
import { isMaintenanceMode } from "@/lib/maintenance";
import { DEFAULT_LIMITS, enforce } from "@/lib/security/rate-limit";
import * as Sentry from "@sentry/nextjs";
import { verifyInboundEmailSignature } from "@/lib/comms/providers/inbound-email";
import {
  processInboundEmailPayload,
  isInboundEmailLive,
} from "@/server/services/email-webhook-handler";

/**
 * Provider-agnostic INBOUND EMAIL webhook — the inbound edge (P2 Communications).
 *
 * POST — a mail delivery. The ONLY authentication is an HMAC-SHA256 over the RAW
 *        body (the provider — or a thin per-provider adapter — signs the exact
 *        bytes with the shared INBOUND_EMAIL_WEBHOOK_SECRET), so we:
 *          1. rate-limit before any work (cheap abuse cutoff),
 *          2. REFUSE BEFORE PROCESS: 404 unless the feature is live (two-switch:
 *             the flag AND the secret) — no body is even read while dark,
 *          3. read the raw body with request.text() — NEVER JSON-parse first,
 *             or the signature can't be verified,
 *          4. verifyInboundEmailSignature (fail-closed) BEFORE parsing,
 *          5. parse + hand to processInboundEmailPayload, which normalises,
 *             claims (idempotent/replay-safe), routes by destination address and
 *             hands each message to the UNCHANGED processInboundEnquiry core.
 *
 *        Always 200 on a *verified* delivery, even when the item fails — providers
 *        retry on non-2xx, and the per-item claim ledger already makes a redelivery
 *        safe, so we must not ask the provider to replay a delivery we durably
 *        claimed. A verification failure is 401; that IS a signal the provider
 *        should not retry with the same (forged/misconfigured) request.
 *
 * DARK by default: the whole integration is gated behind the two-switch
 * isInboundEmailLive() (NEXT_PUBLIC_FEATURE_INBOUND_EMAIL + INBOUND_EMAIL_WEBHOOK_SECRET).
 * With either unset every path 404s and touches no tenant data.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST — a signed inbound-email delivery. */
export async function POST(request: Request): Promise<NextResponse> {
  // Maintenance-window gate: during a cutover, return a retry-safe 503 so the
  // provider re-delivers after the window instead of treating the event as
  // handled. Inert unless MAINTENANCE_MODE=on.
  if (isMaintenanceMode()) {
    return NextResponse.json(
      { ok: false, maintenance: true, message: "Scheduled maintenance — retry shortly." },
      { status: 503, headers: { "retry-after": "120", "cache-control": "no-store" } },
    );
  }
  // Rate limit before auth — abusive senders are cut off cheaply.
  const rl = enforce(request, "email_webhook", DEFAULT_LIMITS.api);
  if (rl) return rl as unknown as NextResponse;

  // REFUSE BEFORE PROCESS: while dark (flag off OR secret unset) the surface does
  // not exist — 404 before the body is even read, no tenant data touched.
  if (!isInboundEmailLive()) {
    return NextResponse.json({ ok: false, error: "not_enabled" }, { status: 404 });
  }

  // Raw body FIRST — the signature is over the exact bytes; JSON-parsing first breaks it.
  const rawBody = await request.text();
  const signature = request.headers.get("x-crewflow-email-signature");

  // THE auth boundary — fail-closed HMAC before we parse or act.
  if (!verifyInboundEmailSignature({ signature, rawBody })) {
    return NextResponse.json(
      { ok: false, error: "invalid_signature" },
      { status: 401 },
    );
  }

  try {
    const result = await processInboundEmailPayload(rawBody);
    if (!result) {
      // Signed but unparseable → 200 (do not make the provider retry a malformed
      // body we will never accept), but log for telemetry.
      console.warn("[email-webhook] verified but unparseable payload");
      return NextResponse.json({ ok: true, messages: 0 });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // A whole-delivery failure (not a per-item one) → 500 so the provider retries;
    // the claim ledger makes the retry idempotent.
    Sentry.captureException(e, { tags: { route: "webhooks/email" } });
    console.error("[email-webhook] processing failed", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "unknown_error" },
      { status: 500 },
    );
  }
}

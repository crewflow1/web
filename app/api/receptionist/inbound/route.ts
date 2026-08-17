import { NextResponse } from "next/server";
import { isMaintenanceMode } from "@/lib/maintenance";
import { z } from "zod";
import { processInboundEnquiry } from "@/server/services/receptionist";
import { INBOUND_CHANNELS } from "@/lib/receptionist/types";
import { resolveInboundOrg } from "@/lib/receptionist/inbound-org-resolver";
import { DEFAULT_LIMITS, enforce } from "@/lib/security/rate-limit";
import * as Sentry from "@sentry/nextjs";

/**
 * POST /api/receptionist/inbound
 *
 * Normalized inbound endpoint for every channel adapter.
 * Authentication: bearer token via `x-crewflow-channel-secret` header
 * matching `CHANNEL_INBOUND_SECRET`. Customers configure their
 * Twilio / WhatsApp / Meta webhooks to call this URL with the shared
 * secret. Per-channel adapters (Twilio voice, SMS, WhatsApp Business
 * API, Instagram Graph) translate provider-specific payloads to the
 * normalised shape this route accepts.
 *
 * SECURITY — org attribution (cross-tenant isolation):
 *   The shared secret is a COARSE gate: every tenant configures the SAME secret,
 *   so it proves "a channel adapter is calling", never "which org this is for".
 *   The org is therefore NEVER taken from the request body — it is RESOLVED from
 *   the `to` destination (the infra identity the sender reached) via the same
 *   per-channel provisioned-route tables the dedicated webhooks use
 *   (`phone_numbers` / `whatsapp_number_routes` / `email_inbound_routes`). This
 *   is the codebase's inbound invariant (see migrations 20261126000000 and
 *   20260918000000). A body `org_id`, if present, is only cross-checked against
 *   the resolved org (defense-in-depth) — it can NEVER select the target. A
 *   destination that resolves to no org is ACK-DROPPED (200, no tenant write) so
 *   providers don't infinitely retry.
 *
 *   Dark-by-data: the per-channel route tables are admin-provisioned and empty
 *   in prod, so every destination currently ack-drops and no tenant row is
 *   written until a route is deliberately provisioned. (There is no single
 *   feature flag governing this multi-channel endpoint — the route tables ARE
 *   the activation surface — so the shared-secret gate is retained as the coarse
 *   auth boundary and attribution is data-gated instead.)
 *
 * Body schema:
 *   { to, channel, org_id?, raw_text?, caller?, dedup_key? }
 *   `to` is the destination the inbound event reached: the dialed E.164
 *   (phone/sms), the Meta phone_number_id (whatsapp_msg/whatsapp_call), or the
 *   inbound email address (email). It is the KEY used to resolve the org.
 *
 * Returns:
 *   200 { ok:true, enquiry_id, lead_id, conversation_id, textback }
 *   200 { ok:true, dropped:true }   (destination resolves to no org — ack-drop)
 *   401 { ok:false, error:"unauthorized" }
 *   422 { ok:false, error:string }  (invalid body, or body org_id ≠ resolved org)
 *   500 { ok:false, error:string }
 *
 * Side effects (always):
 *   - inbound_enquiries row inserted (status received → qualified)
 *   - receptionist_conversations row resolved/created + linked; an inbound
 *     receptionist_messages entry threaded (Directive #018 R10, best-effort)
 *   - leads row created (status='new')
 *   - notifications row (customer audience, priority by urgency)
 *   - admin_activity_log row
 *   - automation dispatch
 *
 * Side effect (Directive #018 R6, GATED — default OFF):
 *   - when NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK="true" AND this is a MISSED
 *     CALL (channel='phone') with a caller to answer, the caller is texted back
 *     through the ONE canonical outbound pipeline (Compose → Enforce → Audit →
 *     Transport). The `textback` field reports whether that path ran. With the flag
 *     OFF the response and every side effect above are byte-for-byte their pre-R6
 *     selves.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  // The destination the inbound event reached (dialed E.164 / Meta
  // phone_number_id / inbound email address). REQUIRED — this is the infra
  // identity the org is resolved FROM. It is caller-supplied but not trusted for
  // attribution: it is a key into an admin-provisioned route table.
  to: z.string().min(1).max(500),
  // Optional and NEVER used to select the target org. If present it must EQUAL
  // the org resolved from `to`, or the request is rejected (defense-in-depth).
  org_id: z.string().uuid().optional().nullable(),
  channel: z.enum(INBOUND_CHANNELS),
  raw_text: z.string().max(20_000).optional().nullable(),
  caller: z.string().max(500).optional().nullable(),
  // A STABLE per-inbound-event id from the channel adapter (e.g. Twilio's CallSid).
  // Optional. Threaded to the missed-call text-back idempotency key so repeated
  // webhook deliveries of one missed call cannot send a second SMS (Directive #018 R6).
  dedup_key: z.string().max(200).optional().nullable(),
});

export async function POST(request: Request): Promise<NextResponse> {
  // Maintenance-window gate: during a cutover, return a retry-safe 503 so the
  // provider (Stripe/Meta/Twilio) re-delivers after the window instead of
  // treating the event as handled. Inert unless MAINTENANCE_MODE=on.
  if (isMaintenanceMode()) {
    return NextResponse.json(
      { ok: false, maintenance: true, message: "Scheduled maintenance — retry shortly." },
      { status: 503, headers: { "retry-after": "120", "cache-control": "no-store" } },
    );
  }
  // Rate limit before auth — abusive bots get cut off cheaply.
  const rl = enforce(request, "receptionist_inbound", DEFAULT_LIMITS.api);
  if (rl) return rl as unknown as NextResponse;

  const expected = process.env.CHANNEL_INBOUND_SECRET;
  const supplied = request.headers.get("x-crewflow-channel-secret");
  if (!expected || !supplied || supplied !== expected) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch (e) {
    // Reachable only past the shared-secret check above, so this is OUR channel
    // adapter posting something unparseable — a real integration defect, not
    // internet noise. Console alone pages nobody.
    Sentry.captureException(e, { tags: { route: "receptionist/inbound", stage: "parse" } });
    return NextResponse.json(
      { ok: false, error: "Bad request body" },
      { status: 400 },
    );
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 422 },
    );
  }

  // Attribute the org from the DESTINATION the sender reached — NEVER the
  // body-claimed org_id. The shared secret only proved a channel adapter is
  // calling; it says nothing about which tenant. Resolution is a lookup in the
  // same per-channel provisioned-route tables the dedicated webhooks use.
  let resolvedOrgId: string | null;
  try {
    resolvedOrgId = await resolveInboundOrg(parsed.data.channel, parsed.data.to);
  } catch (e) {
    Sentry.captureException(e, { tags: { route: "receptionist/inbound", stage: "resolve" } });
    console.error("[api/receptionist/inbound] org resolution failed", e);
    return NextResponse.json({ ok: false, error: "resolution_failed" }, { status: 500 });
  }

  // Unattributable destination → ack-drop: 200 so the provider does not retry
  // forever, but NO tenant row is written. Mirrors the sibling webhook handlers.
  if (!resolvedOrgId) {
    return NextResponse.json({ ok: true, dropped: true });
  }

  // Defense-in-depth: a body org_id may only CONFIRM the resolved org, never
  // select it. A mismatch is a misconfigured adapter or a forged attribution
  // attempt — reject without writing, rather than silently ignore.
  if (parsed.data.org_id && parsed.data.org_id !== resolvedOrgId) {
    return NextResponse.json(
      { ok: false, error: "org_mismatch" },
      { status: 422 },
    );
  }

  try {
    const result = await processInboundEnquiry({
      org_id: resolvedOrgId,
      channel: parsed.data.channel,
      raw_text: parsed.data.raw_text ?? null,
      caller: parsed.data.caller ?? null,
      dedup_key: parsed.data.dedup_key ?? null,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // Fail CLOSED and page someone. Silently 500ing an inbound enquiry means a
    // customer's call/message is dropped with nobody the wiser.
    Sentry.captureException(e, { tags: { route: "receptionist/inbound", stage: "process" } });
    console.error("[api/receptionist/inbound] failed", e);
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "unknown_error",
      },
      { status: 500 },
    );
  }
}

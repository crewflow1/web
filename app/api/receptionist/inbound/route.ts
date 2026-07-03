import { NextResponse } from "next/server";
import { z } from "zod";
import { processInboundEnquiry } from "@/server/services/receptionist";
import { INBOUND_CHANNELS } from "@/lib/receptionist/types";
import { DEFAULT_LIMITS, enforce } from "@/lib/security/rate-limit";

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
 * Body schema:
 *   { org_id, channel, raw_text?, caller?, dedup_key? }
 *
 * Returns:
 *   200 { ok:true, enquiry_id, lead_id, conversation_id, textback }
 *   401 { ok:false, error:"unauthorized" }
 *   422 { ok:false, error:string }
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
  org_id: z.string().uuid(),
  channel: z.enum(INBOUND_CHANNELS),
  raw_text: z.string().max(20_000).optional().nullable(),
  caller: z.string().max(500).optional().nullable(),
  // A STABLE per-inbound-event id from the channel adapter (e.g. Twilio's CallSid).
  // Optional. Threaded to the missed-call text-back idempotency key so repeated
  // webhook deliveries of one missed call cannot send a second SMS (Directive #018 R6).
  dedup_key: z.string().max(200).optional().nullable(),
});

export async function POST(request: Request): Promise<NextResponse> {
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
  } catch {
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

  try {
    const result = await processInboundEnquiry({
      org_id: parsed.data.org_id,
      channel: parsed.data.channel,
      raw_text: parsed.data.raw_text ?? null,
      caller: parsed.data.caller ?? null,
      dedup_key: parsed.data.dedup_key ?? null,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
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

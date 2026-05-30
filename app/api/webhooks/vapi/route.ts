import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { handleVapiEvent } from "@/server/services/vapi-webhook-handler";

/**
 * CrewFlow — Vapi webhook receiver.
 *
 *   POST /api/webhooks/vapi
 *
 * Verifies the shared secret Vapi sends in the `x-vapi-secret` header
 * (configured as the Server URL secret on the Vapi side), then delegates
 * to the handler service. Mirrors the Stripe webhook posture:
 *   - secret not configured        → 503
 *   - missing / wrong secret       → 401
 *   - handler throws (DB down etc.)→ 500 so Vapi retries
 *
 * For an `assistant-request` we return the per-org assistant so Vapi runs
 * the right receptionist; every other event returns { ok: true }.
 *
 * This route is excluded from auth middleware (see middleware.ts matcher,
 * `api/webhooks`) — the secret header IS the auth.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "lhr1";

// Length-safe constant-time string compare (avoids leaking length via a
// throw, and avoids early-exit timing on content).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function POST(request: Request): Promise<NextResponse> {
  const secret = env.VAPI_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "vapi_webhook_secret_not_configured" },
      { status: 503 },
    );
  }

  const provided = request.headers.get("x-vapi-secret");
  if (!provided || !safeEqual(provided, secret)) {
    return NextResponse.json(
      { error: "invalid_vapi_signature" },
      { status: 401 },
    );
  }

  let payload: { message?: unknown };
  try {
    payload = (await request.json()) as { message?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const message = payload?.message;
  if (!message || typeof message !== "object") {
    return NextResponse.json({ error: "missing_message" }, { status: 400 });
  }

  try {
    const result = await handleVapiEvent(message as Record<string, unknown>);
    if (result.kind === "assistant") {
      // Vapi expects the assistant object back for an assistant-request.
      return NextResponse.json({ assistant: result.assistant });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error(
      "[vapi-webhook] handler failed",
      e instanceof Error ? e.message : String(e),
    );
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "unknown" },
      { status: 500 },
    );
  }
}

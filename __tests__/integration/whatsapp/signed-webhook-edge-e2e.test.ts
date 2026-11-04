import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import {
  verifyMetaSignature,
  parseMetaWebhookPayload,
} from "@/lib/comms/providers/meta-whatsapp";
import { processMetaWhatsAppPayload } from "@/server/services/whatsapp-webhook-handler";
import { listReviewQueue } from "@/server/services/receptionist-review";

/**
 * WhatsApp channel — SANDBOX VERIFIED end-to-end over the SIGNED webhook edge.
 *
 * WHAT THIS PROVES (and what the existing suites do NOT):
 *   - the existing `inbound-webhook.test.ts` drives `processMetaWhatsAppPayload`
 *     but SKIPS the HMAC edge; `draft-first-engine.test.ts` drives
 *     `processInboundEnquiry` directly, skipping BOTH signature AND routing.
 *   - this test reproduces the REAL route sequence end to end on real Postgres:
 *       raw body → verifyMetaSignature (fail-closed HMAC) → parseMetaWebhookPayload
 *       → processMetaWhatsAppPayload → org resolved from `whatsapp_number_routes`
 *       → the UNCHANGED engine turn → the CRM/record effects.
 *     The one thing the route itself adds that is not reproduced here is the
 *     outer HTTP wrapper (rate-limit + NextResponse status codes); the handler
 *     seam that owns every tenant effect IS exercised.
 *
 * SANDBOX, NOT LIVE: the signature is a locally-computed HMAC over the raw body
 * keyed by a TEST app secret — faithful to Meta's X-Hub-Signature-256 scheme but
 * NOT a signature Meta produced. No Meta Graph call is made; outbound is dark.
 * A real Meta inbound/outbound round-trip stays LIVE-only.
 */

const APP_SECRET = "test_whatsapp_app_secret_sandbox_only";
const WA_CALLER = "447700900123";
const TOKEN = `it-wa-signed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type Res<T> = { data: T | null; error: { message: string } | null };
type Db = {
  from: (t: string) => {
    insert: (v: unknown) => PromiseLike<Res<null>> & {
      select: (c: string) => { single: () => PromiseLike<Res<Record<string, unknown>>> };
    };
    select: (c: string) => {
      eq: (k: string, v: unknown) => PromiseLike<Res<Record<string, unknown>[]>> & {
        eq: (k: string, v: unknown) => PromiseLike<Res<Record<string, unknown>[]>>;
      };
    };
    delete: () => { eq: (k: string, v: unknown) => PromiseLike<Res<null>> };
  };
};
const db = (): Db => serviceClient() as unknown as Db;

/** The exact JSON body Meta would POST for a single inbound text message. */
function rawEnvelope(pnid: string, wamid: string, body: string): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: `waba_${TOKEN}`,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "+441234567", phone_number_id: pnid },
              contacts: [{ wa_id: WA_CALLER, profile: { name: "Jane Sandbox" } }],
              messages: [
                { id: wamid, from: WA_CALLER, type: "text", timestamp: "1700000000", text: { body } },
              ],
            },
          },
        ],
      },
    ],
  });
}

/** Sign a raw body exactly as Meta would: sha256= HMAC keyed by the app secret. */
function sign(rawBody: string, secret = APP_SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

async function enquiriesFor(org: string): Promise<Record<string, unknown>[]> {
  const res = await db()
    .from("inbound_enquiries")
    .select("id, channel, provider_message_id")
    .eq("org_id", org)
    .eq("channel", "whatsapp_msg");
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}
async function auditsFor(org: string): Promise<Record<string, unknown>[]> {
  const res = await db().from("ai_reply_audits").select("id, channel, verdict").eq("org_id", org);
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}
async function transportsFor(org: string): Promise<Record<string, unknown>[]> {
  const res = await db().from("ai_reply_transports").select("id, channel, status").eq("org_id", org);
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

describeIntegration("whatsapp · SANDBOX VERIFIED signed webhook edge → engine → CRM", () => {
  let orgA = "";
  const PNID_A = `PNID_SIGNED_${TOKEN}`;

  beforeAll(async () => {
    const svc = db();
    const o = await svc.from("organizations").insert({ name: "WA Signed", slug: `${TOKEN}-a` }).select("id").single();
    expect(o.error, o.error?.message).toBeNull();
    orgA = String((o.data as { id: string }).id);

    const r = await svc.from("whatsapp_number_routes").insert({ phone_number_id: PNID_A, org_id: orgA, active: true });
    expect(r.error, r.error?.message).toBeNull();

    // Per-org enablement — enabled + live — is the SECOND gate on top of routing.
    const s = await svc.from("ai_receptionist_setups").insert({ org_id: orgA, enabled: true, status: "live" });
    expect(s.error, s.error?.message).toBeNull();
  });

  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    if (orgA) await db().from("organizations").delete().eq("id", orgA);
  });

  it("REJECTS a bad/missing/tampered signature (fail-closed HMAC)", () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", APP_SECRET);
    const raw = rawEnvelope(PNID_A, `wamid.${TOKEN}.sig`, "hello");

    // Correct HMAC over the exact bytes → accepted.
    expect(verifyMetaSignature({ signature: sign(raw), rawBody: raw })).toBe(true);
    // No signature → refused.
    expect(verifyMetaSignature({ signature: null, rawBody: raw })).toBe(false);
    // Structurally-valid hex but wrong digest → refused.
    expect(verifyMetaSignature({ signature: "sha256=deadbeef", rawBody: raw })).toBe(false);
    // Right signature but body tampered after signing → refused (bytes differ).
    expect(verifyMetaSignature({ signature: sign(raw), rawBody: raw + " " })).toBe(false);
    // Signed with the WRONG secret → refused.
    expect(verifyMetaSignature({ signature: sign(raw, "attacker-secret"), rawBody: raw })).toBe(false);
  });

  it("a SIGNED inbound message is verified, routed, and drives the engine turn → enquiry + whatsapp_msg audit + review, nothing sent", async () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", APP_SECRET);
    vi.stubEnv("NEXT_PUBLIC_FEATURE_WHATSAPP", "true");

    const wamid = `wamid.${TOKEN}.1`;
    const raw = rawEnvelope(PNID_A, wamid, "Hi, do you cover my postcode?");

    // 1. THE auth boundary — exactly what the route does before any work.
    expect(verifyMetaSignature({ signature: sign(raw), rawBody: raw })).toBe(true);
    // 2. Parse the verified bytes.
    const env = parseMetaWebhookPayload(raw);
    expect(env, "a signed, well-formed body parses").not.toBeNull();

    const beforeEnq = (await enquiriesFor(orgA)).length;

    // 3. Dispatch through the real handler (claim → route → engine).
    const res = await processMetaWhatsAppPayload(env!);
    expect(res.dispatched).toBe(1);
    expect(res.unrouted).toBe(0);

    // CRM effect: exactly one enquiry, attributed to orgA via the number route.
    const enq = await enquiriesFor(orgA);
    expect(enq.length).toBe(beforeEnq + 1);
    expect(enq.some((e) => e.provider_message_id === wamid)).toBe(true);

    // Engine turn effect: a whatsapp_msg audit was written (SAME engine, not a fork).
    const audits = await auditsFor(orgA);
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits.every((a) => a.channel === "whatsapp_msg")).toBe(true);

    // DARK OUTBOUND / draft-first: the reply is HELD for review — nothing is sent.
    // (WHATSAPP_AUTO_SEND is off by default → even a clean ack is downgraded to review.)
    expect(await transportsFor(orgA)).toHaveLength(0);
    const queue = (await listReviewQueue({ org_id: orgA })).filter((q) => q.org_id === orgA);
    expect(queue.length).toBeGreaterThanOrEqual(1);
    expect(queue.every((q) => q.channel === "whatsapp_msg")).toBe(true);
  });

  it("REDELIVERY of the same signed wamid is idempotent — no second enquiry", async () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", APP_SECRET);
    vi.stubEnv("NEXT_PUBLIC_FEATURE_WHATSAPP", "true");

    const wamid = `wamid.${TOKEN}.dup`;
    const raw = rawEnvelope(PNID_A, wamid, "same message twice");
    expect(verifyMetaSignature({ signature: sign(raw), rawBody: raw })).toBe(true);
    const env = parseMetaWebhookPayload(raw)!;

    const first = await processMetaWhatsAppPayload(env);
    expect(first.dispatched).toBe(1);
    const afterFirst = (await enquiriesFor(orgA)).length;

    // Meta re-delivers at-least-once; the claim + enquiry partial-unique fold it.
    const second = await processMetaWhatsAppPayload(env);
    expect(second.duplicates).toBe(1);
    expect(second.dispatched).toBe(0);
    expect((await enquiriesFor(orgA)).length).toBe(afterFirst);
  });
});

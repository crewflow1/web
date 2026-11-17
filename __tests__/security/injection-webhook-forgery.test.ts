import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * INJ-08 — WEBHOOK FORGERY MATRIX (behavioural, real verifiers).
 *
 * Every inbound webhook is driven here through its real route handler and its
 * REAL signature verifier; only the downstream processing service is replaced
 * by a spy, so "no side effect" is an observation (the spy was never called),
 * not a reading of the source. For each door:
 *
 *   • FORGED     — no signature / wrong signature / signature over a different
 *                  body / signed with the wrong secret  → refused, spy untouched.
 *   • REPLAY     — where the provider signs a timestamp (Stripe, Resend/Svix),
 *                  a correctly-signed but STALE delivery → refused.
 *   • FAIL-CLOSED— the secret env var unset (flag still on) → refused, spy
 *                  untouched. An unset secret must never mean "accept".
 *   • CONTROL    — a correctly-signed fresh delivery IS accepted and reaches the
 *                  spy exactly once, so none of the refusals above is vacuous.
 *
 * Twilio voice / SMS-status and Vapi have dedicated route suites
 * (__tests__/telephony/*, __tests__/receptionist/twilio-sms-status-route.test.ts,
 * __tests__/integration/telephony/*); the calendar door is in
 * __tests__/security/calendar-pull.test.ts. The companion matrix document is
 * docs/programme/security-injection/webhook-verification-matrix.md.
 */

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
// The limiter is a separate control with its own suite; never let it mask a verdict here.
vi.mock("@/lib/security/rate-limit", () => ({
  DEFAULT_LIMITS: { api: { limit: 1_000_000, windowSeconds: 60 } },
  enforce: () => null,
}));

const processStripeEvent = vi.fn(async () => ({ handled: true }));
vi.mock("@/server/services/stripe-webhook-handler", () => ({ processStripeEvent }));

const processMetaWhatsAppPayload = vi.fn(async () => ({ messages: 1, statuses: 0 }));
vi.mock("@/server/services/whatsapp-webhook-handler", () => ({
  processMetaWhatsAppPayload,
  // Verbatim copy of the real gate (flag only) so the dark/live switch is honest.
  isWhatsAppInboundLive: () => process.env.NEXT_PUBLIC_FEATURE_WHATSAPP === "true",
}));

const processInboundEmailPayload = vi.fn(async () => ({ messages: 1 }));
vi.mock("@/server/services/email-webhook-handler", () => ({
  processInboundEmailPayload,
  isInboundEmailLive: () =>
    process.env.NEXT_PUBLIC_FEATURE_INBOUND_EMAIL === "true" &&
    typeof process.env.INBOUND_EMAIL_WEBHOOK_SECRET === "string" &&
    process.env.INBOUND_EMAIL_WEBHOOK_SECRET !== "",
}));

const processResendEvent = vi.fn(async () => ({ recorded: true }));
vi.mock("@/server/services/resend-events-handler", () => ({
  processResendEvent,
  isResendEventsLive: () =>
    process.env.NEXT_PUBLIC_FEATURE_RESEND_EVENTS === "true" &&
    typeof process.env.RESEND_WEBHOOK_SECRET === "string" &&
    process.env.RESEND_WEBHOOK_SECRET !== "",
}));

const processInboundEnquiry = vi.fn(async () => ({ ok: true }));
vi.mock("@/server/services/receptionist", () => ({ processInboundEnquiry }));
const resolveInboundOrg = vi.fn(async () => null);
vi.mock("@/lib/receptionist/inbound-org-resolver", () => ({ resolveInboundOrg }));

// Synthetic, test-only secrets — assembled at runtime so no secret-shaped
// literal exists in the repository.
const fake = (...parts: string[]) => parts.join("_");
const STRIPE_KEY = fake("sk", "test", "x".repeat(24));
const STRIPE_WHSEC = fake("whsec", "a".repeat(32));
const OTHER_SECRET = fake("whsec", "b".repeat(32));
const HMAC_SECRET = "unit-test-hmac-" + "s".repeat(24);
const SVIX_SECRET = "whsec_" + Buffer.from("svix-test-key-".padEnd(32, "k")).toString("base64");
const CHANNEL_SECRET = "unit-test-channel-" + "c".repeat(24);

const post = (url: string, body: string, headers: Record<string, string> = {}) =>
  new Request(url, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

const nowSec = () => Math.floor(Date.now() / 1000);
const stripeSig = (secret: string, body: string, t = nowSec()) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex")}`;
const hexSig = (secret: string, body: string) =>
  `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
const svixSig = (secret: string, id: string, t: number, body: string) => {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${t}.${body}`, "utf8").digest("base64")}`;
};

beforeEach(() => {
  vi.resetModules();
  for (const spy of [
    processStripeEvent,
    processMetaWhatsAppPayload,
    processInboundEmailPayload,
    processResendEvent,
    processInboundEnquiry,
    resolveInboundOrg,
  ]) spy.mockClear();
  for (const k of [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "NEXT_PUBLIC_FEATURE_WHATSAPP",
    "WHATSAPP_APP_SECRET",
    "WHATSAPP_VERIFY_TOKEN",
    "NEXT_PUBLIC_FEATURE_INBOUND_EMAIL",
    "INBOUND_EMAIL_WEBHOOK_SECRET",
    "NEXT_PUBLIC_FEATURE_RESEND_EVENTS",
    "RESEND_WEBHOOK_SECRET",
    "CHANNEL_INBOUND_SECRET",
    "CRON_SECRET",
    "MAINTENANCE_MODE",
  ]) delete process.env[k];
});

// ───────────────────────────────────────────────────────────────── Stripe ──
describe("POST /api/webhooks/stripe", () => {
  const URL_ = "https://crewflow.test/api/webhooks/stripe";
  const body = JSON.stringify({ id: "evt_forged", object: "event", type: "customer.subscription.updated", data: { object: {} } });
  const load = async () => (await import("@/app/api/webhooks/stripe/route")).POST;

  it("FORGED: missing / malformed / wrong-secret / body-swapped signatures are refused with no side effect", async () => {
    process.env.STRIPE_SECRET_KEY = STRIPE_KEY;
    process.env.STRIPE_WEBHOOK_SECRET = STRIPE_WHSEC;
    const POST = await load();
    const cases: Array<Record<string, string>> = [
      {},
      { "stripe-signature": "" },
      { "stripe-signature": "t=1,v1=deadbeef" },
      { "stripe-signature": stripeSig(OTHER_SECRET, body) },
      { "stripe-signature": stripeSig(STRIPE_WHSEC, body + " ") }, // signed a different body
      { "stripe-signature": `t=${nowSec()},v0=${"0".repeat(64)}` }, // wrong scheme only
    ];
    for (const headers of cases) {
      const res = await POST(post(URL_, body, headers));
      expect(res.status, JSON.stringify(headers)).toBe(401);
    }
    expect(processStripeEvent).not.toHaveBeenCalled();
  });

  it("REPLAY: a correctly-signed delivery older than the tolerance window is refused", async () => {
    process.env.STRIPE_SECRET_KEY = STRIPE_KEY;
    process.env.STRIPE_WEBHOOK_SECRET = STRIPE_WHSEC;
    const POST = await load();
    const res = await POST(post(URL_, body, { "stripe-signature": stripeSig(STRIPE_WHSEC, body, nowSec() - 3600) }));
    expect(res.status).toBe(401);
    expect(processStripeEvent).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: with the webhook secret unset, even a 'validly signed' delivery is refused", async () => {
    process.env.STRIPE_SECRET_KEY = STRIPE_KEY;
    const POST = await load();
    for (const secret of ["", "undefined", "null", STRIPE_WHSEC]) {
      const res = await POST(post(URL_, body, { "stripe-signature": stripeSig(secret, body) }));
      expect(res.status).toBe(503);
    }
    expect(processStripeEvent).not.toHaveBeenCalled();
  });

  it("CONTROL: a fresh, correctly-signed delivery is accepted and processed exactly once", async () => {
    process.env.STRIPE_SECRET_KEY = STRIPE_KEY;
    process.env.STRIPE_WEBHOOK_SECRET = STRIPE_WHSEC;
    const POST = await load();
    const res = await POST(post(URL_, body, { "stripe-signature": stripeSig(STRIPE_WHSEC, body) }));
    expect(res.status).toBe(200);
    expect(processStripeEvent).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────── WhatsApp ──
describe("/api/webhooks/whatsapp", () => {
  const URL_ = "https://crewflow.test/api/webhooks/whatsapp";
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  const load = async () => await import("@/app/api/webhooks/whatsapp/route");

  it("FORGED POST: missing / wrong-prefix / non-hex / wrong-secret / body-swapped → 401, nothing processed", async () => {
    process.env.NEXT_PUBLIC_FEATURE_WHATSAPP = "true";
    process.env.WHATSAPP_APP_SECRET = HMAC_SECRET;
    const { POST } = await load();
    for (const sig of [
      undefined,
      "",
      "sha1=" + "a".repeat(40),
      "sha256=zzzz",
      "sha256=",
      hexSig("some-other-secret", body),
      hexSig(HMAC_SECRET, body + " "),
      hexSig(HMAC_SECRET, body).slice(0, -2),
    ]) {
      const res = await POST(post(URL_, body, sig === undefined ? {} : { "x-hub-signature-256": sig }));
      expect(res.status, String(sig)).toBe(401);
    }
    expect(processMetaWhatsAppPayload).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED POST: flag on but WHATSAPP_APP_SECRET unset → 401 for every signature", async () => {
    process.env.NEXT_PUBLIC_FEATURE_WHATSAPP = "true";
    const { POST } = await load();
    for (const secret of ["", "undefined", HMAC_SECRET]) {
      const res = await POST(post(URL_, body, { "x-hub-signature-256": hexSig(secret || "x", body) }));
      expect(res.status).toBe(401);
    }
    expect(processMetaWhatsAppPayload).not.toHaveBeenCalled();
  });

  it("DARK: flag off → 404 before the body is read, even with a valid signature", async () => {
    process.env.WHATSAPP_APP_SECRET = HMAC_SECRET;
    const { POST } = await load();
    const res = await POST(post(URL_, body, { "x-hub-signature-256": hexSig(HMAC_SECRET, body) }));
    expect(res.status).toBe(404);
    expect(processMetaWhatsAppPayload).not.toHaveBeenCalled();
  });

  it("CONTROL POST: a correctly-signed delivery is accepted", async () => {
    process.env.NEXT_PUBLIC_FEATURE_WHATSAPP = "true";
    process.env.WHATSAPP_APP_SECRET = HMAC_SECRET;
    const { POST } = await load();
    const res = await POST(post(URL_, body, { "x-hub-signature-256": hexSig(HMAC_SECRET, body) }));
    expect(res.status).toBe(200);
    expect(processMetaWhatsAppPayload).toHaveBeenCalledTimes(1);
  });

  it("GET handshake: the challenge is echoed ONLY for the exact verify token; an unset token never matches", async () => {
    process.env.NEXT_PUBLIC_FEATURE_WHATSAPP = "true";
    const q = (token: string | null) =>
      new Request(
        `${URL_}?hub.mode=subscribe&hub.challenge=CHALLENGE-123${token === null ? "" : `&hub.verify_token=${encodeURIComponent(token)}`}`,
      );
    // unset env token → every probe refused (incl. empty / literal "undefined")
    {
      const { GET } = await load();
      for (const t of [null, "", "undefined", "null"]) {
        const res = await GET(q(t));
        expect(res.status, String(t)).toBe(403);
        expect(await res.text()).not.toContain("CHALLENGE-123");
      }
    }
    vi.resetModules();
    process.env.WHATSAPP_VERIFY_TOKEN = "verify-" + "t".repeat(20);
    const { GET } = await load();
    for (const t of [null, "", "verify-", "verify-" + "t".repeat(19), "verify-" + "t".repeat(21), "VERIFY-" + "T".repeat(20)]) {
      const res = await GET(q(t));
      expect(res.status, String(t)).toBe(403);
    }
    const ok = await GET(q(process.env.WHATSAPP_VERIFY_TOKEN));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("CHALLENGE-123");
    expect(ok.headers.get("content-type")).toMatch(/^text\/plain/);
  });
});

// ────────────────────────────────────────────────────────── Inbound email ──
describe("POST /api/webhooks/email", () => {
  const URL_ = "https://crewflow.test/api/webhooks/email";
  const body = JSON.stringify({ from: "a@example.test", to: "b@example.test", subject: "hi", text: "hello" });
  const load = async () => (await import("@/app/api/webhooks/email/route")).POST;

  it("FORGED: every bad signature → 401, nothing processed", async () => {
    process.env.NEXT_PUBLIC_FEATURE_INBOUND_EMAIL = "true";
    process.env.INBOUND_EMAIL_WEBHOOK_SECRET = HMAC_SECRET;
    const POST = await load();
    for (const sig of [undefined, "", "sha256=", "sha256=nothex", hexSig("wrong", body), hexSig(HMAC_SECRET, body + "x")]) {
      const res = await POST(post(URL_, body, sig === undefined ? {} : { "x-crewflow-email-signature": sig }));
      expect(res.status, String(sig)).toBe(401);
    }
    expect(processInboundEmailPayload).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: flag on but secret unset → the door does not exist (404)", async () => {
    process.env.NEXT_PUBLIC_FEATURE_INBOUND_EMAIL = "true";
    const POST = await load();
    const res = await POST(post(URL_, body, { "x-crewflow-email-signature": hexSig("", body) }));
    expect(res.status).toBe(404);
    expect(processInboundEmailPayload).not.toHaveBeenCalled();
  });

  it("CONTROL: a correctly-signed delivery is accepted", async () => {
    process.env.NEXT_PUBLIC_FEATURE_INBOUND_EMAIL = "true";
    process.env.INBOUND_EMAIL_WEBHOOK_SECRET = HMAC_SECRET;
    const POST = await load();
    const res = await POST(post(URL_, body, { "x-crewflow-email-signature": hexSig(HMAC_SECRET, body) }));
    expect(res.status).toBe(200);
    expect(processInboundEmailPayload).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────── Resend (Svix) ──
describe("POST /api/webhooks/resend", () => {
  const URL_ = "https://crewflow.test/api/webhooks/resend";
  const body = JSON.stringify({ type: "email.delivered", data: { email_id: "e_1" } });
  const load = async () => (await import("@/app/api/webhooks/resend/route")).POST;
  const headers = (id: string, t: number, sig: string) => ({
    "svix-id": id,
    "svix-timestamp": String(t),
    "svix-signature": sig,
  });

  it("FORGED: missing headers / wrong key / body-swapped / id-swapped → 401, nothing processed", async () => {
    process.env.NEXT_PUBLIC_FEATURE_RESEND_EVENTS = "true";
    process.env.RESEND_WEBHOOK_SECRET = SVIX_SECRET;
    const POST = await load();
    const t = nowSec();
    const good = svixSig(SVIX_SECRET, "msg_1", t, body);
    const cases: Array<Record<string, string>> = [
      {},
      headers("msg_1", t, ""),
      headers("msg_1", t, "v1,AAAA"),
      headers("msg_1", t, svixSig("whsec_" + Buffer.from("x".repeat(32)).toString("base64"), "msg_1", t, body)),
      headers("msg_1", t, svixSig(SVIX_SECRET, "msg_1", t, body + " ")),
      headers("msg_2", t, good), // signature bound to a different message id
      headers("msg_1", t + 1, good), // signature bound to a different timestamp
      headers("msg_1", t, good.replace(/^v1,/, "v2,")),
    ];
    for (const h of cases) {
      const res = await POST(post(URL_, body, h));
      expect(res.status, JSON.stringify(h)).toBe(401);
    }
    expect(processResendEvent).not.toHaveBeenCalled();
  });

  it("REPLAY: a correctly-signed but stale (or far-future) delivery is refused", async () => {
    process.env.NEXT_PUBLIC_FEATURE_RESEND_EVENTS = "true";
    process.env.RESEND_WEBHOOK_SECRET = SVIX_SECRET;
    const POST = await load();
    for (const t of [nowSec() - 3600, nowSec() + 3600]) {
      const res = await POST(post(URL_, body, headers("msg_1", t, svixSig(SVIX_SECRET, "msg_1", t, body))));
      expect(res.status).toBe(401);
    }
    expect(processResendEvent).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: flag on but secret unset → 404", async () => {
    process.env.NEXT_PUBLIC_FEATURE_RESEND_EVENTS = "true";
    const POST = await load();
    const t = nowSec();
    const res = await POST(post(URL_, body, headers("msg_1", t, svixSig("whsec_", "msg_1", t, body))));
    expect(res.status).toBe(404);
    expect(processResendEvent).not.toHaveBeenCalled();
  });

  it("CONTROL: a fresh, correctly-signed delivery is accepted", async () => {
    process.env.NEXT_PUBLIC_FEATURE_RESEND_EVENTS = "true";
    process.env.RESEND_WEBHOOK_SECRET = SVIX_SECRET;
    const POST = await load();
    const t = nowSec();
    const res = await POST(post(URL_, body, headers("msg_1", t, svixSig(SVIX_SECRET, "msg_1", t, body))));
    expect(res.status).toBe(200);
    expect(processResendEvent).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────── Receptionist channel door ──
describe("POST /api/receptionist/inbound", () => {
  const URL_ = "https://crewflow.test/api/receptionist/inbound";
  const body = JSON.stringify({ channel: "sms", from: "+447700900001", to: "+447700900002", text: "hi", org_id: "x" });
  const load = async () => (await import("@/app/api/receptionist/inbound/route")).POST;

  it("FORGED: missing / wrong / prefix / longer secret → 401 before the body is parsed", async () => {
    process.env.CHANNEL_INBOUND_SECRET = CHANNEL_SECRET;
    const POST = await load();
    for (const s of [undefined, "", CHANNEL_SECRET.slice(0, -1), CHANNEL_SECRET + "x", CHANNEL_SECRET.toUpperCase()]) {
      const res = await POST(post(URL_, body, s === undefined ? {} : { "x-crewflow-channel-secret": s }));
      expect(res.status, String(s)).toBe(401);
    }
    expect(resolveInboundOrg).not.toHaveBeenCalled();
    expect(processInboundEnquiry).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: with CHANNEL_INBOUND_SECRET unset, nothing is accepted (incl. empty / 'undefined')", async () => {
    const POST = await load();
    for (const s of [undefined, "", "undefined", "null"]) {
      const res = await POST(post(URL_, body, s === undefined ? {} : { "x-crewflow-channel-secret": s }));
      expect(res.status, String(s)).toBe(401);
    }
    expect(resolveInboundOrg).not.toHaveBeenCalled();
    expect(processInboundEnquiry).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────── Cron ──
describe("cron routes — one shared bearer gate, constant-time, fail-closed", () => {
  const req = (auth?: string) =>
    new Request("https://crewflow.test/api/cron/x", { headers: auth === undefined ? {} : { authorization: auth } });

  it("FAIL-CLOSED: CRON_SECRET unset → nothing is authorised (incl. 'Bearer ' / 'Bearer undefined')", async () => {
    const { isCronAuthorised } = await import("@/lib/cron/auth");
    for (const a of [undefined, "", "Bearer ", "Bearer undefined", "Bearer null"]) {
      expect(isCronAuthorised(req(a)), String(a)).toBe(false);
    }
  });

  it("FORGED: only the exact `Bearer <secret>` header is authorised", async () => {
    const secret = "cron-" + "z".repeat(40);
    process.env.CRON_SECRET = secret;
    const { isCronAuthorised } = await import("@/lib/cron/auth");
    for (const a of [undefined, "", secret, `bearer ${secret}`, `Bearer  ${secret}`, `Bearer ${secret.slice(0, -1)}`, `Bearer ${secret}x`, `Basic ${secret}`]) {
      expect(isCronAuthorised(req(a)), String(a)).toBe(false);
    }
    expect(isCronAuthorised(req(`Bearer ${secret}`))).toBe(true);
  });

  it("the comparison is constant-time (no `===` on the secret)", () => {
    const src = readFileSync(resolve(__dirname, "..", "..", "lib/cron/auth.ts"), "utf8");
    expect(src).toMatch(/constantTimeEqual\(header, `Bearer \$\{secret\}`\)/);
    expect(src).not.toMatch(/header\s*===/);
  });

  it("EVERY /api/cron route checks the gate before doing anything else", () => {
    const ROOT = resolve(__dirname, "..", "..");
    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name === "route.ts") routes.push(p);
      }
    };
    walk(join(ROOT, "app/api/cron"));
    expect(routes.length).toBeGreaterThanOrEqual(48);
    const offenders: string[] = [];
    for (const r of routes) {
      const src = readFileSync(r, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      const gate = src.search(/isCronAuthorised\(\s*(request|req)\s*\)/);
      // The first admin-client / telemetry / provider touch must come AFTER the gate.
      const firstEffect = src.search(/createAdminClient\(\)|withCronTelemetry\(|\bfetch\(|\.from\(/);
      const handler = src.search(/export async function (GET|POST)/);
      if (gate === -1 || gate < handler) offenders.push(`${r.replace(ROOT + "/", "")}: no gate inside the handler`);
      else if (firstEffect !== -1 && firstEffect > handler && firstEffect < gate) {
        offenders.push(`${r.replace(ROOT + "/", "")}: side effect before the gate`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("constantTimeEqual", () => {
  it("is exact, and null / empty on either side is never a match", async () => {
    const { constantTimeEqual } = await import("@/lib/security/constant-time");
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(false);
    expect(constantTimeEqual(null, null)).toBe(false);
    expect(constantTimeEqual(undefined, "x")).toBe(false);
    expect(constantTimeEqual("x", undefined)).toBe(false);
  });
});

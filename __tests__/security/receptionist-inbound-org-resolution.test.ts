import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * /api/receptionist/inbound — cross-tenant org-attribution pins (SEC-2).
 *
 * The endpoint is gated by a SINGLE shared secret (CHANNEL_INBOUND_SECRET) that
 * EVERY tenant configures, so the secret proves "a channel adapter is calling",
 * never "which org this is for". Historically the route trusted `org_id` straight
 * from the request body, letting any secret holder inject enquiries / leads /
 * conversations / notifications — and trigger missed-call SMS — into ANY org.
 *
 * What is pinned, and why each pin is load-bearing:
 *   1. SOURCE — the route no longer feeds a body org_id into processInboundEnquiry;
 *      `to` is required; attribution goes through resolveInboundOrg.
 *   2. TENANT ISOLATION (behavioural, route end-to-end) — the org handed to the
 *      ingestion core is the one RESOLVED from the destination, never the body:
 *        a) a valid destination attributes to the resolved org;
 *        b) a body org_id that mismatches the resolved org is REJECTED (422) with
 *           NO tenant write (no cross-tenant injection);
 *        c) a body org_id that matches is accepted;
 *        d) an unresolvable destination ACK-DROPS (200) with NO tenant write;
 *        e) a missing `to` is a 422 validation error (no resolution, no write);
 *        f) a bad/absent shared secret is still 401 before any work.
 *   3. PER-CHANNEL DISPATCH — resolveInboundOrg routes each channel to the SAME
 *      provisioned-route resolver the dedicated webhooks use, and channels with no
 *      route table (instagram/facebook/manual) resolve to null (→ ack-drop).
 *
 * Hermetic: only the leaf resolvers (the DB lookups) and the ingestion core are
 * mocked; the REAL route and the REAL resolveInboundOrg dispatcher run.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const ROUTE = "app/api/receptionist/inbound/route.ts";

const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ---- Mocks: leaf resolvers (DB lookups) + ingestion core --------------------
const h = vi.hoisted(() => ({
  resolveOrgForDialedNumber: vi.fn(async (): Promise<string | null> => null),
  resolveOrgForNumber: vi.fn(async (): Promise<string | null> => null),
  resolveOrgForAddress: vi.fn(async (): Promise<string | null> => null),
  processInboundEnquiry: vi.fn(async () => ({
    enquiry_id: "e", lead_id: "l", conversation_id: "c",
    textback: { attempted: false as const, reason: "unsupported_channel" as const },
  })),
}));

vi.mock("@/lib/telephony/router", () => ({ resolveOrgForDialedNumber: h.resolveOrgForDialedNumber }));
vi.mock("@/server/services/whatsapp-webhook-handler", () => ({ resolveOrgForNumber: h.resolveOrgForNumber }));
vi.mock("@/server/services/email-webhook-handler", () => ({ resolveOrgForAddress: h.resolveOrgForAddress }));
vi.mock("@/server/services/receptionist", () => ({ processInboundEnquiry: h.processInboundEnquiry }));

const SECRET = "sec_inbound_test";

function post(body: unknown, secret: string | null = SECRET): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["x-crewflow-channel-secret"] = secret;
  return new Request("http://localhost/api/receptionist/inbound", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function callRoute(req: Request) {
  const { POST } = await import("@/app/api/receptionist/inbound/route");
  return POST(req);
}

// ---------------------------------------------------------------------------
// 1. SOURCE — the vulnerable pattern is gone
// ---------------------------------------------------------------------------
describe("route source — org is never taken from the body", () => {
  const src = codeOf(read(ROUTE));

  it("does NOT pass a body org_id into processInboundEnquiry", () => {
    expect(src).not.toMatch(/org_id:\s*parsed\.data\.org_id/);
  });

  it("resolves the org from the destination and feeds the RESOLVED org to the core", () => {
    expect(src).toMatch(/resolveInboundOrg\(\s*parsed\.data\.channel\s*,\s*parsed\.data\.to\s*\)/);
    expect(src).toMatch(/org_id:\s*resolvedOrgId/);
  });

  it("requires a `to` destination and treats body org_id as optional", () => {
    expect(src).toMatch(/to:\s*z\.string\(\)\.min\(1\)/);
    expect(src).toMatch(/org_id:\s*z\.string\(\)\.uuid\(\)\.optional\(\)/);
  });
});

// ---------------------------------------------------------------------------
// 2. TENANT ISOLATION — route end-to-end
// ---------------------------------------------------------------------------
describe("tenant isolation — org resolved from destination, never from the body", () => {
  beforeEach(() => {
    vi.stubEnv("CHANNEL_INBOUND_SECRET", SECRET);
    h.resolveOrgForDialedNumber.mockReset().mockResolvedValue(null);
    h.resolveOrgForNumber.mockReset().mockResolvedValue(null);
    h.resolveOrgForAddress.mockReset().mockResolvedValue(null);
    h.processInboundEnquiry.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("(a) a valid destination attributes to the RESOLVED org", async () => {
    h.resolveOrgForDialedNumber.mockResolvedValue("org-REAL");
    const res = await callRoute(post({ to: "+441234567890", channel: "phone", raw_text: "hi" }));
    expect(res.status).toBe(200);
    expect(h.processInboundEnquiry).toHaveBeenCalledTimes(1);
    const arg = (h.processInboundEnquiry.mock.calls[0] as unknown as [{ org_id: string }])[0];
    expect(arg.org_id).toBe("org-REAL");
  });

  it("(b) a body org_id that MISMATCHES the resolved org is REJECTED with no write", async () => {
    h.resolveOrgForDialedNumber.mockResolvedValue("org-REAL");
    const res = await callRoute(
      post({
        to: "+441234567890",
        channel: "phone",
        // A valid-looking UUID for a DIFFERENT org — the cross-tenant attack.
        org_id: "11111111-1111-1111-1111-111111111111",
        raw_text: "hi",
      }),
    );
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: "org_mismatch" });
    expect(h.processInboundEnquiry).not.toHaveBeenCalled();
  });

  it("(c) a body org_id that MATCHES the resolved org is accepted", async () => {
    const ORG = "22222222-2222-2222-2222-222222222222";
    h.resolveOrgForDialedNumber.mockResolvedValue(ORG);
    const res = await callRoute(post({ to: "+441234567890", channel: "phone", org_id: ORG, raw_text: "hi" }));
    expect(res.status).toBe(200);
    expect(h.processInboundEnquiry).toHaveBeenCalledTimes(1);
    const arg = (h.processInboundEnquiry.mock.calls[0] as unknown as [{ org_id: string }])[0];
    expect(arg.org_id).toBe(ORG);
  });

  it("(d) an unresolvable destination ACK-DROPS (200) with no tenant write", async () => {
    h.resolveOrgForDialedNumber.mockResolvedValue(null);
    const res = await callRoute(
      post({
        to: "+449999999999",
        channel: "phone",
        // Even a forged org_id must not cause a write when nothing resolves.
        org_id: "33333333-3333-3333-3333-333333333333",
        raw_text: "hi",
      }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, dropped: true });
    expect(h.processInboundEnquiry).not.toHaveBeenCalled();
  });

  it("(e) a missing `to` is a 422 validation error — no resolution, no write", async () => {
    const res = await callRoute(post({ channel: "phone", org_id: "44444444-4444-4444-4444-444444444444", raw_text: "hi" }));
    expect(res.status).toBe(422);
    expect(h.resolveOrgForDialedNumber).not.toHaveBeenCalled();
    expect(h.processInboundEnquiry).not.toHaveBeenCalled();
  });

  it("(f) a bad/absent shared secret is 401 before any work", async () => {
    const bad = await callRoute(post({ to: "+441234567890", channel: "phone" }, "wrong"));
    expect(bad.status).toBe(401);
    const none = await callRoute(post({ to: "+441234567890", channel: "phone" }, null));
    expect(none.status).toBe(401);
    expect(h.resolveOrgForDialedNumber).not.toHaveBeenCalled();
    expect(h.processInboundEnquiry).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. PER-CHANNEL DISPATCH — each channel resolves via its own route table
// ---------------------------------------------------------------------------
describe("resolveInboundOrg — per-channel dispatch to the provisioned-route resolver", () => {
  beforeEach(() => {
    h.resolveOrgForDialedNumber.mockReset().mockResolvedValue(null);
    h.resolveOrgForNumber.mockReset().mockResolvedValue(null);
    h.resolveOrgForAddress.mockReset().mockResolvedValue(null);
  });

  it("phone / sms → phone_numbers (resolveOrgForDialedNumber)", async () => {
    const { resolveInboundOrg } = await import("@/lib/receptionist/inbound-org-resolver");
    h.resolveOrgForDialedNumber.mockResolvedValue("org-phone");
    await expect(resolveInboundOrg("phone", "+441111111111")).resolves.toBe("org-phone");
    await expect(resolveInboundOrg("sms", "+441111111111")).resolves.toBe("org-phone");
    expect(h.resolveOrgForDialedNumber).toHaveBeenCalledWith("+441111111111");
    expect(h.resolveOrgForNumber).not.toHaveBeenCalled();
    expect(h.resolveOrgForAddress).not.toHaveBeenCalled();
  });

  it("whatsapp_msg / whatsapp_call → whatsapp_number_routes (resolveOrgForNumber)", async () => {
    const { resolveInboundOrg } = await import("@/lib/receptionist/inbound-org-resolver");
    h.resolveOrgForNumber.mockResolvedValue("org-wa");
    await expect(resolveInboundOrg("whatsapp_msg", "PN123")).resolves.toBe("org-wa");
    await expect(resolveInboundOrg("whatsapp_call", "PN123")).resolves.toBe("org-wa");
    expect(h.resolveOrgForNumber).toHaveBeenCalledWith("PN123");
    expect(h.resolveOrgForDialedNumber).not.toHaveBeenCalled();
  });

  it("email → email_inbound_routes (resolveOrgForAddress)", async () => {
    const { resolveInboundOrg } = await import("@/lib/receptionist/inbound-org-resolver");
    h.resolveOrgForAddress.mockResolvedValue("org-email");
    await expect(resolveInboundOrg("email", "leads@real.com")).resolves.toBe("org-email");
    expect(h.resolveOrgForAddress).toHaveBeenCalledWith("leads@real.com");
  });

  it("channels with no provisioned-route table resolve to null (→ ack-drop)", async () => {
    const { resolveInboundOrg } = await import("@/lib/receptionist/inbound-org-resolver");
    for (const ch of ["instagram_dm", "facebook_dm", "manual"] as const) {
      await expect(resolveInboundOrg(ch, "anything")).resolves.toBeNull();
    }
    expect(h.resolveOrgForDialedNumber).not.toHaveBeenCalled();
    expect(h.resolveOrgForNumber).not.toHaveBeenCalled();
    expect(h.resolveOrgForAddress).not.toHaveBeenCalled();
  });

  it("a blank destination resolves to null without any lookup", async () => {
    const { resolveInboundOrg } = await import("@/lib/receptionist/inbound-org-resolver");
    await expect(resolveInboundOrg("phone", "   ")).resolves.toBeNull();
    await expect(resolveInboundOrg("phone", null)).resolves.toBeNull();
    expect(h.resolveOrgForDialedNumber).not.toHaveBeenCalled();
  });
});

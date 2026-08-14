import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Inbound email ingestion (P2 Comms) — trust-boundary pins.
 *
 * Hermetic: filesystem scans + pure functions + a mocked Supabase client. What is
 * pinned, and why each pin is load-bearing:
 *   1. MIGRATION — both tables RLS-enabled; the webhook_events ledger has ZERO
 *      policies (service-role only, like whatsapp_webhook_events); the routes table
 *      is member-read / admin-write; the channel CHECK is widened to admit 'email'
 *      on ALL THREE receptionist tables (else an email enquiry is rejected by the DB).
 *   2. TWO-SWITCH DARK — isInboundEmailLive requires BOTH the flag AND the secret,
 *      and the route REFUSES (404) BEFORE it reads the request body.
 *   3. SIGNATURE — the shared-secret HMAC is the auth boundary; every unhappy path
 *      fails CLOSED, and a missing secret can never pass.
 *   4. TENANT ISOLATION — the org is resolved ONLY by the DB route lookup on the
 *      DESTINATION address; a payload-supplied org_id is NEVER trusted, and an
 *      unrouted address NEVER reaches the ingestion core.
 *   5. ENV — the secret is declared .optional() so an unconfigured deploy boots.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const MIGRATION = "supabase/migrations/20261126000000_inbound_email_ingestion.sql";
const ROUTE = "app/api/webhooks/email/route.ts";

const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ---- File-wide mocks for the tenant-isolation behavioural proof (#4) --------
// Only the handler's own dependencies are mocked; the pure adapter (imported
// dynamically in the signature tests) is untouched.
const iso = vi.hoisted(() => ({
  routeResult: { data: null as unknown, error: null as { message: string } | null },
  processInboundEnquiry: vi.fn(async () => ({
    enquiry_id: "e", lead_id: "l", conversation_id: "c",
    textback: { attempted: false, reason: "unsupported_channel" as const },
  })),
  recordAdminActivity: vi.fn(async () => undefined),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "email_webhook_events") {
        return {
          insert: async () => ({ error: null }),
          update: () => {
            const p = Promise.resolve({ error: null }) as Promise<{ error: null }> & Record<string, unknown>;
            p.is = () => ({ or: () => ({ select: async () => ({ data: [{ id: "x" }], error: null }) }) });
            return { eq: () => p };
          },
        };
      }
      if (table === "email_inbound_routes") {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => iso.routeResult }) }) }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));
vi.mock("@/server/services/receptionist", () => ({ processInboundEnquiry: iso.processInboundEnquiry }));
vi.mock("@/server/services/hq-audit", () => ({ recordAdminActivity: iso.recordAdminActivity }));

// ---------------------------------------------------------------------------
// 1. MIGRATION — RLS posture + channel widening
// ---------------------------------------------------------------------------
describe("migration — RLS posture and channel widening", () => {
  const mig = read(MIGRATION);

  it("both new tables enable RLS", () => {
    expect(mig).toMatch(/alter table public\.email_inbound_routes enable row level security/);
    expect(mig).toMatch(/alter table public\.email_webhook_events enable row level security/);
  });

  it("email_webhook_events has ZERO policies (service-role only)", () => {
    // No policy DECLARATION targets the ledger (the table name follows `on public.`
    // directly in a `create policy "..." on public.<table>` statement).
    expect(mig).not.toMatch(/create policy\s+"[^"]*"\s+on public\.email_webhook_events/);
  });

  it("email_inbound_routes is member-read, admin-write", () => {
    expect(mig).toMatch(/email_inbound_routes: members can select[\s\S]*?current_org_ids\(\)/);
    expect(mig).toMatch(/email_inbound_routes: admins can insert[\s\S]*?is_org_admin/);
    expect(mig).toMatch(/email_inbound_routes: admins can update[\s\S]*?is_org_admin/);
  });

  it("widens the channel CHECK to admit 'email' on all three receptionist tables", () => {
    for (const table of [
      "inbound_enquiries",
      "receptionist_conversations",
      "receptionist_messages",
    ]) {
      const re = new RegExp(
        `add constraint ${table}_channel_check[\\s\\S]*?check \\(channel in \\([^)]*'email'[^)]*\\)`,
      );
      expect(mig, `${table} widened`).toMatch(re);
    }
  });

  it("the webhook_events ledger keeps processed_at as the sole proof of completion", () => {
    expect(mig).toMatch(/event_key\s+text not null unique/);
    expect(mig).toMatch(/processed_at/);
  });
});

// ---------------------------------------------------------------------------
// 2. TWO-SWITCH DARK — refuse before process
// ---------------------------------------------------------------------------
describe("route — dark by default, refuse before process", () => {
  const src = codeOf(read(ROUTE));

  it("gates on isInboundEmailLive BEFORE reading the request body", () => {
    const gate = src.indexOf("isInboundEmailLive");
    const bodyRead = src.indexOf("request.text()");
    expect(gate).toBeGreaterThan(-1);
    expect(bodyRead).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(bodyRead);
  });

  it("verifies the signature BEFORE parsing/acting on the body", () => {
    const verify = src.indexOf("verifyInboundEmailSignature");
    const process = src.indexOf("processInboundEmailPayload");
    expect(verify).toBeGreaterThan(-1);
    expect(verify).toBeLessThan(process);
  });
});

// ---------------------------------------------------------------------------
// 3. SIGNATURE — the auth boundary, fail-closed
// ---------------------------------------------------------------------------
describe("verifyInboundEmailSignature — auth boundary", () => {
  const SECRET = "sec_isolation_test";
  const sign = (raw: string, s = SECRET) => "sha256=" + createHmac("sha256", s).update(raw, "utf8").digest("hex");

  beforeEach(() => vi.stubEnv("INBOUND_EMAIL_WEBHOOK_SECRET", SECRET));
  afterEach(() => vi.unstubAllEnvs());

  it("accepts only a signature over the exact bytes with the configured secret", async () => {
    const { verifyInboundEmailSignature } = await import("@/lib/comms/providers/inbound-email");
    const raw = '{"message_id":"<x@y>"}';
    expect(verifyInboundEmailSignature({ signature: sign(raw), rawBody: raw })).toBe(true);
    expect(verifyInboundEmailSignature({ signature: sign(raw), rawBody: raw + "x" })).toBe(false);
    expect(verifyInboundEmailSignature({ signature: sign(raw, "other"), rawBody: raw })).toBe(false);
  });

  it("fails CLOSED when the secret is unset (dark)", async () => {
    const { verifyInboundEmailSignature } = await import("@/lib/comms/providers/inbound-email");
    vi.stubEnv("INBOUND_EMAIL_WEBHOOK_SECRET", "");
    expect(verifyInboundEmailSignature({ signature: sign("{}"), rawBody: "{}" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. TENANT ISOLATION — org from the DB route lookup ONLY, never the payload
// ---------------------------------------------------------------------------
describe("tenant isolation — org resolved by destination route, never trusted from the body", () => {
  beforeEach(() => {
    iso.processInboundEnquiry.mockClear();
    iso.recordAdminActivity.mockClear();
    iso.routeResult = { data: null, error: null };
  });

  it("dispatches under the ROUTE's org, ignoring a forged org_id in the payload", async () => {
    iso.routeResult = { data: { org_id: "org-REAL" }, error: null };
    const { processInboundEmailPayload } = await import("@/server/services/email-webhook-handler");
    await processInboundEmailPayload(
      JSON.stringify({
        org_id: "org-ATTACKER", // forged — must be ignored
        from: "a@b.com",
        to: "leads@real.com",
        message_id: "<iso-1@b.com>",
        text: "hi",
      }),
    );
    expect(iso.processInboundEnquiry).toHaveBeenCalledTimes(1);
    const arg = (iso.processInboundEnquiry.mock.calls[0] as unknown as [{ org_id: string }])[0];
    expect(arg.org_id).toBe("org-REAL");
    expect(arg.org_id).not.toBe("org-ATTACKER");
  });

  it("an unrouted destination NEVER reaches the ingestion core (ack-drop only)", async () => {
    iso.routeResult = { data: null, error: null };
    const { processInboundEmailPayload } = await import("@/server/services/email-webhook-handler");
    const res = await processInboundEmailPayload(
      JSON.stringify({ org_id: "org-ATTACKER", from: "a@b.com", to: "nobody@x.com", message_id: "<iso-2@b.com>", text: "hi" }),
    );
    expect(res).toMatchObject({ unrouted: 1, dispatched: 0 });
    expect(iso.processInboundEnquiry).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. ENV — optional secret
// ---------------------------------------------------------------------------
describe("env — inbound secret is optional (unconfigured deploy still boots)", () => {
  const envSrc = read("lib/env.ts");
  it("INBOUND_EMAIL_WEBHOOK_SECRET is .optional()", () => {
    expect(envSrc).toMatch(/INBOUND_EMAIL_WEBHOOK_SECRET:\s*z\.string\(\)\.optional\(\)/);
  });
  it("NEXT_PUBLIC_FEATURE_INBOUND_EMAIL defaults to 'false'", () => {
    expect(envSrc).toMatch(/NEXT_PUBLIC_FEATURE_INBOUND_EMAIL:\s*z\.enum\(\["true", "false"\]\)\.default\("false"\)/);
  });
});

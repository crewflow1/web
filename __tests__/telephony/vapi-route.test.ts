import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Vapi webhook end-to-end (route + handler), with a mock Supabase.
 *
 * Proves the Phase 5A spine:
 *   number → organisation → AI conversation → stored call record.
 *
 * And the guarantees around it:
 *   - the shared-secret gate (503 unconfigured, 401 missing/wrong);
 *   - org_id is derived from the DIALLED number, never the payload, so
 *     tenants are isolated and a spoofed org_id in the body is ignored;
 *   - unknown numbers get no assistant and store nothing;
 *   - replayed webhooks upsert the same call row (no duplicate).
 */

const h = vi.hoisted(() => {
  const store = {
    phoneNumbers: [] as Array<{
      id: string;
      org_id: string;
      e164: string;
      status: string;
      vapi_assistant_id: string | null;
    }>,
    orgs: {} as Record<string, { name: string }>,
    setups: {} as Record<
      string,
      {
        trade_type: string | null;
        business_hours: string | null;
        preferred_voice: string | null;
      }
    >,
    calls: [] as Array<Record<string, unknown>>,
    inserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
    updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  };
  const env = { VAPI_WEBHOOK_SECRET: "test-secret" as string | undefined };
  return { store, env };
});

vi.mock("@/lib/env", () => ({ env: h.env }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (k: string, v: unknown) => {
          filters[k] = v;
          return chain;
        },
        maybeSingle: async () => {
          if (table === "phone_numbers") {
            const row = h.store.phoneNumbers.find(
              (r) =>
                r.e164 === filters.e164 &&
                (filters.status === undefined || r.status === filters.status),
            );
            return { data: row ?? null, error: null };
          }
          if (table === "organizations") {
            const o = h.store.orgs[String(filters.id)];
            return { data: o ? { name: o.name } : null, error: null };
          }
          if (table === "ai_receptionist_setups") {
            return { data: h.store.setups[String(filters.org_id)] ?? null, error: null };
          }
          if (table === "calls") {
            const c = h.store.calls.find(
              (r) =>
                r.provider === filters.provider &&
                r.provider_call_id === filters.provider_call_id,
            );
            return { data: c ? { id: c.id, org_id: c.org_id } : null, error: null };
          }
          return { data: null, error: null };
        },
        insert: (payload: Record<string, unknown>) => {
          h.store.inserts.push({ table, payload });
          if (table === "calls") {
            h.store.calls.push({ id: `call-${h.store.calls.length + 1}`, ...payload });
          }
          return Promise.resolve({ error: null });
        },
        update: (payload: Record<string, unknown>) => ({
          eq: (k: string, v: unknown) => {
            h.store.updates.push({ table, payload });
            if (table === "calls") {
              const c = h.store.calls.find((r) => r.id === v);
              if (c) Object.assign(c, payload);
            }
            return Promise.resolve({ error: null });
          },
        }),
      };
      return chain;
    },
  }),
}));

import { POST } from "@/app/api/webhooks/vapi/route";

function post(body: unknown, secret: string | null = "test-secret") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["x-vapi-secret"] = secret;
  return POST(
    new Request("https://crewflow.uk/api/webhooks/vapi", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  h.env.VAPI_WEBHOOK_SECRET = "test-secret";
  h.store.phoneNumbers = [
    { id: "pn-A", org_id: "org-A", e164: "+447900000001", status: "active", vapi_assistant_id: null },
    { id: "pn-B", org_id: "org-B", e164: "+447900000002", status: "active", vapi_assistant_id: null },
  ];
  h.store.orgs = {
    "org-A": { name: "Alpha Builders" },
    "org-B": { name: "Bravo Plumbing" },
  };
  h.store.setups = {
    "org-A": { trade_type: "building", business_hours: "Mon–Fri 8–6", preferred_voice: "Paige" },
  };
  h.store.calls = [];
  h.store.inserts = [];
  h.store.updates = [];
});

describe("auth gate", () => {
  it("503 when the webhook secret is not configured", async () => {
    h.env.VAPI_WEBHOOK_SECRET = undefined;
    const res = await post({ message: { type: "status-update" } });
    expect(res.status).toBe(503);
  });

  it("401 when the x-vapi-secret header is missing", async () => {
    const res = await post({ message: { type: "status-update" } }, null);
    expect(res.status).toBe(401);
  });

  it("401 when the x-vapi-secret header is wrong", async () => {
    const res = await post({ message: { type: "status-update" } }, "wrong");
    expect(res.status).toBe(401);
  });
});

describe("assistant-request → number resolves to org + assistant", () => {
  it("returns the dialled org's assistant and opens an in_progress call", async () => {
    const res = await post({
      message: {
        type: "assistant-request",
        phoneNumber: { number: "+447900000001" },
        customer: { number: "+447911111111" },
        call: { id: "vapi-call-1" },
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { assistant?: { name: string; firstMessage: string; model: { model: string } } };
    expect(body.assistant).toBeTruthy();
    expect(body.assistant?.name).toContain("Alpha Builders");
    expect(body.assistant?.firstMessage).toContain("Alpha Builders");
    expect(body.assistant?.model.model).toBe("claude-haiku-4-5");

    // A call row was opened, tenant-scoped from the number.
    expect(h.store.calls).toHaveLength(1);
    const call = h.store.calls[0];
    expect(call).toMatchObject({
      org_id: "org-A",
      phone_number_id: "pn-A",
      provider: "vapi",
      provider_call_id: "vapi-call-1",
      direction: "inbound",
      status: "in_progress",
      caller_number: "+447911111111",
      receiver_number: "+447900000001",
    });
  });

  it("routes a different number to a DIFFERENT org (cross-tenant isolation)", async () => {
    const res = await post({
      message: {
        type: "assistant-request",
        phoneNumber: { number: "+447900000002" },
        call: { id: "vapi-call-2" },
      },
    });
    const body = (await res.json()) as { assistant?: { name: string } };
    expect(body.assistant?.name).toContain("Bravo Plumbing");
    expect(body.assistant?.name).not.toContain("Alpha");
    expect(h.store.calls[0]).toMatchObject({ org_id: "org-B" });
  });

  it("serves NO assistant and stores nothing for an unprovisioned number", async () => {
    const res = await post({
      message: {
        type: "assistant-request",
        phoneNumber: { number: "+447999999999" },
        call: { id: "vapi-call-3" },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assistant?: unknown; ok?: boolean };
    expect(body.assistant).toBeUndefined();
    expect(body.ok).toBe(true);
    expect(h.store.calls).toHaveLength(0);
  });
});

describe("end-of-call-report → stored call record", () => {
  it("persists transcript + summary + status, deriving org from the NUMBER (ignoring a spoofed body org_id)", async () => {
    const res = await post({
      message: {
        type: "end-of-call-report",
        // A malicious/incorrect org_id in the body must be ignored.
        org_id: "org-EVIL",
        phoneNumber: { number: "+447900000001" },
        customer: { number: "+447922222222" },
        call: { id: "vapi-call-9" },
        endedReason: "customer-ended-call",
        durationSeconds: 42,
        artifact: {
          transcript: "AI: Hello… Caller: My flat roof is leaking in SW1A 1AA.",
          messages: [{ role: "assistant", content: "Hello" }],
        },
        analysis: { summary: "Roof leak reported in SW1A. Wants a callback." },
      },
    });

    expect(res.status).toBe(200);
    expect(h.store.calls).toHaveLength(1);
    const call = h.store.calls[0];
    expect(call?.org_id).toBe("org-A"); // from the number, NOT org-EVIL
    expect(call?.org_id).not.toBe("org-EVIL");
    expect(call).toMatchObject({
      provider: "vapi",
      provider_call_id: "vapi-call-9",
      status: "completed",
      duration_sec: 42,
      phone_number_id: "pn-A",
    });
    expect(String(call?.transcript)).toContain("leaking");
    expect(String(call?.ai_summary)).toContain("Roof leak");
    expect(call?.transcript_json).toBeTruthy();
  });

  it("updates the SAME row opened by assistant-request (idempotent, no duplicate)", async () => {
    const open = {
      message: {
        type: "assistant-request",
        phoneNumber: { number: "+447900000001" },
        call: { id: "vapi-call-7" },
      },
    };
    await post(open);
    expect(h.store.calls).toHaveLength(1);

    await post({
      message: {
        type: "end-of-call-report",
        phoneNumber: { number: "+447900000001" },
        call: { id: "vapi-call-7" },
        endedReason: "assistant-ended-call",
        artifact: { transcript: "…done." },
        analysis: { summary: "Handled." },
      },
    });

    // Still ONE row — updated, not duplicated.
    expect(h.store.calls).toHaveLength(1);
    expect(h.store.calls[0]).toMatchObject({
      provider_call_id: "vapi-call-7",
      status: "completed",
    });
    expect(String(h.store.calls[0]?.transcript)).toContain("done");
  });

  it("maps a no-answer ended reason to status no_answer", async () => {
    await post({
      message: {
        type: "end-of-call-report",
        phoneNumber: { number: "+447900000001" },
        call: { id: "vapi-call-na" },
        endedReason: "customer-did-not-answer",
      },
    });
    expect(h.store.calls[0]).toMatchObject({ status: "no_answer" });
  });
});

describe("unhandled events", () => {
  it("acknowledges but does not write", async () => {
    const res = await post({ message: { type: "speech-update" } });
    expect(res.status).toBe(200);
    expect((await res.json())).toEqual({ ok: true });
    expect(h.store.inserts).toHaveLength(0);
    expect(h.store.updates).toHaveLength(0);
  });
});

import { describe, it, expect } from "vitest";
import { scrubEvent, redactPathTokens, REDACTED, type MinimalEvent } from "@/lib/monitoring/scrub";

/**
 * Error-monitoring event scrubbing. The one thing that MUST run before any
 * captured event leaves the process. Tested behaviourally: every place a
 * CrewFlow request can carry a secret (headers, cookies, query params, request
 * bodies, user PII) is redacted, deterministically, without dropping the error
 * itself.
 */

describe("scrubEvent — secret/PII redaction on captured events", () => {
  it("redacts Authorization + api-key headers (case-insensitive), keeps benign ones", () => {
    const event: MinimalEvent = {
      request: {
        headers: {
          Authorization: "Bearer super-secret-token",
          "X-Api-Key": "sk_live_abc123",
          "Content-Type": "application/json",
        },
      },
    };
    const out = scrubEvent(event)!;
    expect(out.request!.headers!.Authorization).toBe(REDACTED);
    expect(out.request!.headers!["X-Api-Key"]).toBe(REDACTED);
    expect(out.request!.headers!["Content-Type"]).toBe("application/json");
  });

  it("redacts a raw cookie string entirely and cookie-object values", () => {
    expect(scrubEvent({ request: { cookies: "sb-access-token=abc; other=1" } })!.request!.cookies).toBe(
      REDACTED,
    );
    const obj = scrubEvent({ request: { cookies: { session: "xyz", theme: "dark" } } })!;
    expect((obj.request!.cookies as Record<string, unknown>).session).toBe(REDACTED);
    expect((obj.request!.cookies as Record<string, unknown>).theme).toBe("dark");
  });

  it("redacts sensitive query params in url + query_string, keeps benign ones", () => {
    const out = scrubEvent({
      request: {
        url: "https://crewflow.uk/api/webhooks/x?api_key=SECRET&job=42",
        query_string: "token=SECRET&page=2",
      },
    })!;
    expect(out.request!.url).toBe("https://crewflow.uk/api/webhooks/x?api_key=[redacted]&job=42");
    expect(out.request!.query_string).toBe("token=[redacted]&page=2");
  });

  it("redacts secrets nested in request body / extra / contexts at depth", () => {
    const out = scrubEvent({
      request: { data: { user: { email: "a@b.com" }, payload: { access_token: "T", note: "ok" } } },
      extra: { config: { password: "hunter2", retries: 3 } },
      contexts: { auth: { refresh_token: "R" } },
    })!;
    const data = out.request!.data as { payload: Record<string, unknown> };
    expect(data.payload.access_token).toBe(REDACTED);
    expect(data.payload.note).toBe("ok");
    expect((out.extra!.config as Record<string, unknown>).password).toBe(REDACTED);
    expect((out.extra!.config as Record<string, unknown>).retries).toBe(3);
    expect((out.contexts!.auth as Record<string, unknown>).refresh_token).toBe(REDACTED);
  });

  it("strips user PII down to a stable id only", () => {
    const out = scrubEvent({ user: { id: "u_1", email: "a@b.com", ip_address: "1.2.3.4" } })!;
    expect(out.user).toEqual({ id: "u_1" });
  });

  it("never drops a genuine error event (returns the event, not null) and is deterministic", () => {
    const build = (): MinimalEvent => ({
      request: { headers: { Authorization: "Bearer x" } },
      message: "boom",
    });
    const a = scrubEvent(build());
    const b = scrubEvent(build());
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
  });

  it("handles a cyclic object without infinite-looping", () => {
    const cyclic: Record<string, unknown> = { token: "secret" };
    cyclic.self = cyclic;
    const out = scrubEvent({ extra: { cyclic } })!;
    expect(((out.extra!.cyclic as Record<string, unknown>).token)).toBe(REDACTED);
  });

  it("an event with nothing sensitive passes through unchanged", () => {
    const event: MinimalEvent = { message: "plain", request: { url: "https://crewflow.uk/jobs?page=1" } };
    expect(scrubEvent(event)).toEqual({ message: "plain", request: { url: "https://crewflow.uk/jobs?page=1" } });
  });

  it("redacts secret-keyed values and URL query params inside transaction spans", () => {
    const out = scrubEvent({
      spans: [
        { data: { "http.url": "https://crewflow.uk/api/x?token=SECRET&id=7", "http.method": "GET" } },
        { data: { access_token: "T", "db.system": "postgresql" } },
      ],
    } as MinimalEvent)!;
    const spans = (out as unknown as { spans: Array<{ data: Record<string, unknown> }> }).spans;
    expect(spans[0]!.data["http.url"]).toBe("https://crewflow.uk/api/x?token=[redacted]&id=7");
    expect(spans[0]!.data["http.method"]).toBe("GET");
    expect(spans[1]!.data.access_token).toBe(REDACTED);
    expect(spans[1]!.data["db.system"]).toBe("postgresql");
  });
  // ── Secrets/AI-spend audit: the gaps the exact-name list left open ──────────

  it("redacts provider webhook-signature and shared-secret headers by SHAPE", () => {
    const out = scrubEvent({
      request: {
        headers: {
          "stripe-signature": "t=1,v1=abc",
          "X-Twilio-Signature": "sig",
          "x-hub-signature-256": "sha256=abc",
          "svix-signature": "v1,abc",
          "x-webhook-secret": "s",
          "x-channel-secret": "s",
          "x-csrf-token": "c",
          "user-agent": "curl/8",
          "content-length": "12",
        },
      },
    } as MinimalEvent)!;
    const h = out.request!.headers!;
    for (const k of [
      "stripe-signature",
      "X-Twilio-Signature",
      "x-hub-signature-256",
      "svix-signature",
      "x-webhook-secret",
      "x-channel-secret",
      "x-csrf-token",
    ]) {
      expect(h[k], k).toBe(REDACTED);
    }
    expect(h["user-agent"]).toBe("curl/8");
    expect(h["content-length"]).toBe("12");
  });

  it("redacts credential-shaped keys in bodies but KEEPS token COUNTS and benign ids", () => {
    const out = scrubEvent({
      extra: {
        service_role_key: "k",
        client_secret: "s",
        stripe_api_key: "k",
        private_key: "k",
        encryption_key: "k",
        input_tokens: 1200,
        output_tokens: 300,
        max_tokens: 4000,
        idempotency_key: "idem-1",
        job_id: "j1",
      },
    } as MinimalEvent)!;
    const x = out.extra!;
    for (const k of ["service_role_key", "client_secret", "stripe_api_key", "private_key", "encryption_key"]) {
      expect(x[k], k).toBe(REDACTED);
    }
    // Counts and identifiers are triage data, not secrets — a bare substring
    // match on "token"/"key" would have destroyed them.
    expect(x.input_tokens).toBe(1200);
    expect(x.output_tokens).toBe(300);
    expect(x.max_tokens).toBe(4000);
    expect(x.idempotency_key).toBe("idem-1");
    expect(x.job_id).toBe("j1");
  });

  it("redacts capability tokens carried as PATH segments (portal / quote / worker / asset)", () => {
    expect(redactPathTokens("https://crewflow.uk/customer-portal/TOK3N-abc/invoices/9/pdf")).toBe(
      "https://crewflow.uk/customer-portal/[redacted]/invoices/9/pdf",
    );
    expect(redactPathTokens("/worker-portal/w0rk-er_T0ken")).toBe("/worker-portal/[redacted]");
    expect(redactPathTokens("https://crewflow.uk/q/0b6f8a1e-2d3c-4e5f-8a9b-0c1d2e3f4a5b/pdf?x=1")).toBe(
      "https://crewflow.uk/q/[redacted]/pdf?x=1",
    );
    expect(redactPathTokens("/a/asset-token")).toBe("/a/[redacted]");
    // Not a token route: untouched. Neither is a filesystem path or a deeper route.
    expect(redactPathTokens("https://crewflow.uk/jobs/123")).toBe("https://crewflow.uk/jobs/123");
    expect(redactPathTokens("ENOENT /Users/a/b/c.ts")).toBe("ENOENT /Users/a/b/c.ts");
    expect(redactPathTokens("https://crewflow.uk/api/v1/q/x")).toBe("https://crewflow.uk/api/v1/q/x");
  });

  it("a portal error ships NO working portal link: url, transaction, breadcrumbs, exception text, spans", () => {
    const TOKEN = "s3cr3t-portal-token";
    const out = scrubEvent({
      transaction: `GET /customer-portal/${TOKEN}/invoices`,
      request: { url: `https://crewflow.uk/customer-portal/${TOKEN}/invoices?token=abc&page=2` },
      breadcrumbs: [
        { category: "navigation", data: { from: `/customer-portal/${TOKEN}`, to: `/customer-portal/${TOKEN}/chat` } },
        { category: "fetch", data: { url: `https://crewflow.uk/customer-portal/${TOKEN}/chat/poll`, authorization: "Bearer x" } },
        { category: "console", message: `failed GET /q/${TOKEN}/pdf` },
      ],
      exception: { values: [{ type: "Error", value: `GET /worker-portal/${TOKEN} 500` }] },
      spans: [{ description: `GET https://crewflow.uk/customer-portal/${TOKEN}/photos`, data: {} }],
      tags: { url: `https://crewflow.uk/customer-portal/${TOKEN}` },
    } as unknown as MinimalEvent)!;
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain(TOKEN);
    expect(serialised).not.toContain("Bearer x");
    // …while the triage-relevant shape survives.
    expect(out.request!.url).toBe("https://crewflow.uk/customer-portal/[redacted]/invoices?token=[redacted]&page=2");
    expect((out as { transaction?: string }).transaction).toBe("GET /customer-portal/[redacted]/invoices");
  });

  it("handles the { values: [...] } breadcrumb envelope too", () => {
    const out = scrubEvent({
      breadcrumbs: { values: [{ data: { url: "https://crewflow.uk/q/tok/pdf" } }] },
    } as unknown as MinimalEvent)!;
    expect(JSON.stringify(out)).not.toContain("/q/tok");
  });
});

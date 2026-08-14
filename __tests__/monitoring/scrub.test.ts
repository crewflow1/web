import { describe, it, expect } from "vitest";
import { scrubEvent, REDACTED, type MinimalEvent } from "@/lib/monitoring/scrub";

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
});

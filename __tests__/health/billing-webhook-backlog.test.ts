import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { capStuckCount, probeBillingWebhookBacklog, STUCK_CAP } from "@/lib/health/billing-webhook-backlog";

/**
 * Stuck Stripe webhook events — the independent "a payment / cancellation was not applied"
 * signal. A capped count, a probe that can never throw, and the monitor job that alerts on it.
 */
function fetchReturning(rows: unknown, status = 200) {
  return vi.fn().mockResolvedValue({ status, json: () => Promise.resolve(rows) });
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("capStuckCount — the only value that may be published", () => {
  it("caps at 5 and never goes negative or NaN", () => {
    expect(capStuckCount(0)).toBe(0);
    expect(capStuckCount(3)).toBe(3);
    expect(capStuckCount(STUCK_CAP + 1)).toBe(STUCK_CAP);
    expect(capStuckCount(-2)).toBe(0);
    expect(capStuckCount(Number.NaN)).toBe(0);
  });
});

describe("probeBillingWebhookBacklog — never throws, unknown is null", () => {
  it("missing config → null (local / preview)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(await probeBillingWebhookBacklog()).toEqual({ stuck: null });
  });
  it("counts only UNPROCESSED events older than 30 minutes and selects ids only", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
    const f = fetchReturning([{ id: "a" }, { id: "b" }]);
    vi.stubGlobal("fetch", f);
    expect(await probeBillingWebhookBacklog()).toEqual({ stuck: 2 });
    const url = decodeURIComponent(String(f.mock.calls[0]![0]));
    expect(url).toContain("billing_events?select=id&processed_at=is.null&created_at=lt.2026-11-17T11:30:00.000Z&limit=6");
  });
  it("nothing stuck → 0 (healthy, closes an open alert)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubGlobal("fetch", fetchReturning([]));
    expect(await probeBillingWebhookBacklog()).toEqual({ stuck: 0 });
  });
  it("a large backlog is published as the cap, not the real number", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubGlobal("fetch", fetchReturning(Array.from({ length: 6 }, (_, i) => ({ id: String(i) }))));
    expect(await probeBillingWebhookBacklog()).toEqual({ stuck: 5 });
  });
  it.each([
    ["non-200", fetchReturning([], 500)],
    ["malformed body", fetchReturning({ message: "nope" })],
    ["network error", vi.fn().mockRejectedValue(new Error("boom"))],
  ])("%s → null, never a rejection", async (_label, f) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubGlobal("fetch", f);
    await expect(probeBillingWebhookBacklog()).resolves.toEqual({ stuck: null });
  });
});

describe("the monitor alerts on stuck Stripe events with no new provider", () => {
  const yml = readFileSync(resolve(__dirname, "../../.github/workflows/outage-monitor.yml"), "utf8");
  const job = yml.slice(yml.indexOf("  billing-webhooks:"));
  it("has its own job reading the published field", () => {
    expect(yml).toContain("  billing-webhooks:");
    expect(job).toContain(".billingWebhooks.stuckEvents");
  });
  it("unknown warns but never alerts", () => {
    expect(job).toMatch(/stuckEvents is unknown[^\n]*exit 0/);
  });
  it("raises ONE deduped issue, fails the run (GitHub emails it) and closes the issue on recovery", () => {
    expect(job).toContain("--label billing-webhook-stuck");
    expect(job).toContain("gh issue close");
    expect(job).toMatch(/STRIPE WEBHOOK STUCK[\s\S]*exit 1/);
  });
  it("uses only the workflow's own token and never interpolates response text into a script", () => {
    expect(job).not.toMatch(/secrets\.(?!GITHUB_TOKEN)/);
    expect(job).not.toMatch(/run:[^\n]*\$\{\{/);
  });
  it("the health route publishes the capped integer only", () => {
    const route = readFileSync(resolve(__dirname, "../../app/api/health/route.ts"), "utf8");
    expect(route).toContain("stuckEvents: webhookBacklog.stuck");
  });
});

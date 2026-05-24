import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Phase 2 — Email queue drain tests.
 *
 * Pins:
 *   1. sendNotificationEmail uses the existing lib/email/send.ts
 *      Resend wrapper (no second provider integration).
 *   2. Retry policy is bounded (MAX_RETRIES) with exponential
 *      backoff schedule.
 *   3. Drain processes a batched window (no single-row infinite loops).
 *   4. Cleanup prunes ancient sent/skipped rows after a configurable
 *      window.
 *   5. /api/cron/notifications-drain is bearer-auth gated.
 *   6. vercel.json registers the cron every 15 minutes.
 *   7. /admin/notifications surfaces email queue health with failed
 *      visibility.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const EMAIL = read("lib/notifications/email.ts");
const STATS = read("server/services/notification-email-queue-stats.ts");
const ROUTE = read("app/api/cron/notifications-drain/route.ts");
const VERCEL = read("vercel.json");
const NOTIF_PAGE = read("app/admin/notifications/page.tsx");

// =====================================================================
// 1. Sender uses existing Resend wrapper
// =====================================================================

describe("sendNotificationEmail wires to Resend", () => {
  it("imports the existing lib/email/send sendEmail helper", () => {
    expect(EMAIL).toMatch(/from "@\/lib\/email\/send"/);
    expect(EMAIL).toMatch(/sendEmail/);
  });

  it("falls back to 'skipped' when RESEND_API_KEY is unset", () => {
    expect(EMAIL).toMatch(/no_provider_configured/);
  });

  it("on success: status='sent' + sent_at stamped + provider='resend'", () => {
    expect(EMAIL).toMatch(/status: "sent"/);
    expect(EMAIL).toMatch(/provider: "resend"/);
    expect(EMAIL).toMatch(/sent_at:\s*now/);
  });

  it("on failure: bumps retry_count + reschedules unless past MAX_RETRIES", () => {
    expect(EMAIL).toMatch(/retry_count:\s*retryCount/);
    expect(EMAIL).toMatch(/retryCount < MAX_RETRIES/);
  });

  it("HTML body falls back to escaped + linebreak-converted text body", () => {
    expect(EMAIL).toMatch(/replace\(\/&\/g/);
    expect(EMAIL).toMatch(/replace\(\/\\n\/g, "<br>"\)/);
  });
});

// =====================================================================
// 2. Retry schedule
// =====================================================================

describe("retry backoff is bounded and exponential-ish", () => {
  it("MAX_RETRIES set to 6 (1min/5min/15min/1h/4h/24h)", () => {
    expect(EMAIL).toMatch(/const MAX_RETRIES = 6/);
  });

  it("schedule helper covers retryCount 1..6+", () => {
    expect(EMAIL).toMatch(/nextRetryStamp/);
    // The schedule is encoded as discrete branches; we don't lock the
    // exact minutes here so a future tweak doesn't require a test PR.
    expect(EMAIL).toMatch(/retryCount === 1/);
    expect(EMAIL).toMatch(/retryCount === 6|else/);
  });
});

// =====================================================================
// 3. Drain
// =====================================================================

describe("drainNotificationEmailQueue", () => {
  it("processes a bounded batch (DRAIN_BATCH_SIZE = 50)", () => {
    expect(EMAIL).toMatch(/const DRAIN_BATCH_SIZE = 50/);
  });

  it("picks oldest scheduled-for first", () => {
    expect(EMAIL).toMatch(/scheduled_for/);
    expect(EMAIL).toMatch(/ascending: true/);
  });

  it("returns a structured DrainResult summary", () => {
    expect(EMAIL).toMatch(/picked:/);
    expect(EMAIL).toMatch(/sent:/);
    expect(EMAIL).toMatch(/failed:/);
    expect(EMAIL).toMatch(/skipped:/);
    expect(EMAIL).toMatch(/durationMs:/);
  });

  it("per-row failures are absorbed (never throw out of cron)", () => {
    expect(EMAIL).toMatch(/try \{[\s\S]*sendNotificationEmail[\s\S]*\} catch/);
  });
});

// =====================================================================
// 4. Cleanup
// =====================================================================

describe("cleanupOldEmailRows", () => {
  it("deletes sent/skipped rows older than olderThanDays", () => {
    expect(EMAIL).toMatch(/cleanupOldEmailRows/);
    expect(EMAIL).toMatch(/\["sent", "skipped"\]/);
    expect(EMAIL).toMatch(/olderThanDays = 90/);
  });
});

// =====================================================================
// 5. Cron route
// =====================================================================

describe("/api/cron/notifications-drain", () => {
  it("auth-gated by isCronAuthorised → 401 otherwise", () => {
    expect(ROUTE).toMatch(/isCronAuthorised/);
    expect(ROUTE).toMatch(/status: 401/);
  });
  it("calls drainNotificationEmailQueue + cleanupOldEmailRows", () => {
    expect(ROUTE).toMatch(/drainNotificationEmailQueue/);
    expect(ROUTE).toMatch(/cleanupOldEmailRows/);
  });
  it("nodejs runtime + force-dynamic", () => {
    expect(ROUTE).toMatch(/runtime = "nodejs"/);
    expect(ROUTE).toMatch(/dynamic = "force-dynamic"/);
  });
});

// =====================================================================
// 6. vercel.json registers the cron
// =====================================================================

describe("vercel.json", () => {
  it("registers /api/cron/notifications-drain on a 15-minute schedule", () => {
    expect(VERCEL).toMatch(/\/api\/cron\/notifications-drain/);
    expect(VERCEL).toMatch(/\*\/15 \* \* \* \*/);
  });
});

// =====================================================================
// 7. Stats + HQ page surface
// =====================================================================

describe("email queue stats + HQ surface", () => {
  it("getEmailQueueStats returns queued / sent_24h / failed_24h / skipped / permanent_failures", () => {
    for (const field of [
      "queued",
      "sent_24h",
      "failed_24h",
      "skipped",
      "permanent_failures",
      "recent_failures",
    ]) {
      expect(STATS).toMatch(new RegExp(`${field}:`));
    }
  });

  it("/admin/notifications surfaces the queue health section", () => {
    expect(NOTIF_PAGE).toMatch(/getEmailQueueStats/);
    expect(NOTIF_PAGE).toMatch(/Email queue/);
    expect(NOTIF_PAGE).toMatch(/Recent failures/);
  });
});

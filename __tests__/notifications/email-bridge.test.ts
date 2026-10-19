import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MAX_HQ_RECIPIENTS,
  parseHqRecipients,
  resolveEmailRecipient,
  resolveHqQuietHours,
} from "@/lib/notifications/email-routing";
import { notifyOnFailedPayment, notifyOnUrgentHqAlert } from "@/lib/notifications/events";

/**
 * AC-1 — the notification→email bridge (Vision 2030, Programme AC).
 *
 * Before this increment `queueNotificationEmail` had zero production callers
 * and the /api/cron/notifications-drain cron drained an empty queue. This
 * wires the in-app notification bus to that queue through a deliberate,
 * per-notification opt-in — never a firehose.
 *
 * Pinned:
 *   1. resolveEmailRecipient (pure) — deny-by-default routing.
 *   2. notifyOnFailedPayment opts the CUSTOMER entry into email and leaves
 *      the HQ entry in-app only.
 *   3. Wiring: NotificationCreate carries an optional `email` directive;
 *      emitNotifications funnels only opted-in rows to queueNotificationEmail
 *      via an org-scoped `organizations.email` read.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const TYPES = read("lib/notifications/types.ts");
const ROUTING = read("lib/notifications/email-routing.ts");
const SVC = read("server/services/notifications-service.ts");
const EVENTS = read("lib/notifications/events.ts");

// =====================================================================
// 1. Pure resolver — deny-by-default
// =====================================================================

describe("resolveEmailRecipient — deny-by-default routing", () => {
  it("no directive → null (in-app only; the historical default)", () => {
    expect(
      resolveEmailRecipient({ audience: "customer", orgEmail: "a@b.com" }),
    ).toBeNull();
  });

  it("explicit `to` wins over audience resolution", () => {
    expect(
      resolveEmailRecipient({
        directive: { to: "boss@site.com" },
        audience: "customer",
        orgEmail: "org@site.com",
      }),
    ).toEqual({ to: "boss@site.com", replyTo: null });
  });

  it("customer audience → the org email", () => {
    expect(
      resolveEmailRecipient({
        directive: {},
        audience: "customer",
        orgEmail: "org@site.com",
      }),
    ).toEqual({ to: "org@site.com", replyTo: null });
  });

  it("both audience → the org email", () => {
    expect(
      resolveEmailRecipient({
        directive: {},
        audience: "both",
        orgEmail: "org@site.com",
      }),
    ).toEqual({ to: "org@site.com", replyTo: null });
  });

  it("hq audience with no explicit `to` → null (the bridge resolves HQ separately via parseHqRecipients)", () => {
    expect(
      resolveEmailRecipient({
        directive: {},
        audience: "hq",
        orgEmail: "org@site.com",
      }),
    ).toBeNull();
  });

  it("customer audience but org email missing → null (never guesses)", () => {
    expect(
      resolveEmailRecipient({
        directive: {},
        audience: "customer",
        orgEmail: null,
      }),
    ).toBeNull();
  });

  it("whitespace-only org email is treated as absent → null", () => {
    expect(
      resolveEmailRecipient({
        directive: {},
        audience: "customer",
        orgEmail: "   ",
      }),
    ).toBeNull();
  });

  it("carries replyTo through and trims the explicit address", () => {
    expect(
      resolveEmailRecipient({
        directive: { to: "  boss@site.com  ", replyTo: "reply@site.com" },
        audience: "customer",
      }),
    ).toEqual({ to: "boss@site.com", replyTo: "reply@site.com" });
  });
});

// =====================================================================
// 2. Opt-in placement — one deliberate consumer, no firehose
// =====================================================================

describe("notifyOnFailedPayment email opt-in", () => {
  it("customer entry opts into email; HQ entry stays in-app only", () => {
    const out = notifyOnFailedPayment({
      org_id: "o1",
      amount_gbp: 500,
      reason: "Card declined",
    });
    // out[0] = customer (urgent), out[1] = hq (high) — existing contract.
    expect(out[0]?.audience).toBe("customer");
    expect(out[0]?.email).toBeDefined();
    expect(out[1]?.audience).toBe("hq");
    expect(out[1]?.email).toBeUndefined();
  });
});

// =====================================================================
// 3. Wiring pins
// =====================================================================

describe("bridge wiring", () => {
  it("NotificationCreate carries an optional email directive", () => {
    expect(TYPES).toMatch(/export type NotificationEmailDirective/);
    expect(TYPES).toMatch(/email\?:\s*NotificationEmailDirective/);
  });

  it("the routing module is pure (imports neither server-only nor supabase)", () => {
    expect(ROUTING).not.toMatch(/import "server-only"/);
    expect(ROUTING).not.toMatch(/from "@\/lib\/supabase/);
    expect(ROUTING).toMatch(/export function resolveEmailRecipient/);
  });

  it("emitNotifications funnels opted-in rows to the email queue", () => {
    expect(SVC).toMatch(/from "@\/lib\/notifications\/email"/);
    expect(SVC).toMatch(/resolveEmailRecipient/);
    expect(SVC).toMatch(/queueNotificationEmail\(/);
    // recipient roster read is org-scoped through the typed table
    expect(SVC).toMatch(/\.from\("organizations"\)/);
  });

  it("email fan-out only runs for inputs that opted in (no firehose)", () => {
    expect(SVC).toMatch(/\.filter\(\(p\) => p\.input\.email != null\)/);
  });

  it("failed-payment customer notification opts into email", () => {
    expect(EVENTS).toMatch(/email: \{\}/);
  });
});

// =====================================================================
// 4. HQ-audience routing (settings-truth remediation, 2026-10-19)
// =====================================================================
//
// The /admin/settings "HQ email recipients" + quiet-hours controls were
// phantom (persisted, read by nothing). They are now the REAL routing for
// hq-audience email: the critical-alert fire opts in, the bridge fans out
// to the configured list, and quiet hours defer via scheduled_for.

describe("parseHqRecipients — the configured HQ list", () => {
  it("splits, trims, dedupes (case-insensitively) and drops junk", () => {
    expect(
      parseHqRecipients(" ops@crewflow.uk, Ops@crewflow.uk , not-an-email, a@b.co ,,"),
    ).toEqual(["ops@crewflow.uk", "a@b.co"]);
  });

  it("empty / null / undefined → [] (HQ email stays dark until configured)", () => {
    expect(parseHqRecipients("")).toEqual([]);
    expect(parseHqRecipients(null)).toEqual([]);
    expect(parseHqRecipients(undefined)).toEqual([]);
  });

  it("caps the fan-out at MAX_HQ_RECIPIENTS", () => {
    const raw = Array.from({ length: 30 }, (_, i) => `op${i}@x.co`).join(",");
    expect(parseHqRecipients(raw)).toHaveLength(MAX_HQ_RECIPIENTS);
  });
});

describe("resolveHqQuietHours — defer non-urgent HQ email in the quiet window", () => {
  // 23:30 UTC = inside a 22:00→07:00 London window (winter: UTC == London).
  const NIGHT = new Date("2026-01-10T23:30:00.000Z");
  // 12:00 UTC = well outside it.
  const NOON = new Date("2026-01-10T12:00:00.000Z");
  const base = {
    timezone: "Europe/London",
    quietStart: "22:00",
    quietEnd: "07:00",
    urgentBypass: true,
  };

  it("outside the window → send now", () => {
    expect(
      resolveHqQuietHours({ ...base, now: NOON, urgent: false }),
    ).toEqual({ send: "now" });
  });

  it("inside the (midnight-wrapping) window, non-urgent → deferred to the window end", () => {
    const d = resolveHqQuietHours({ ...base, now: NIGHT, urgent: false });
    expect(d.send).toBe("deferred");
    if (d.send === "deferred") {
      // 23:30 → 07:00 is 7.5 hours.
      expect(d.scheduledFor.getTime() - NIGHT.getTime()).toBe(7.5 * 3600_000);
    }
  });

  it("urgent + bypass ON → sends during quiet hours", () => {
    expect(
      resolveHqQuietHours({ ...base, now: NIGHT, urgent: true }),
    ).toEqual({ send: "now" });
  });

  it("urgent + bypass OFF → deferred like everything else", () => {
    const d = resolveHqQuietHours({
      ...base,
      urgentBypass: false,
      now: NIGHT,
      urgent: true,
    });
    expect(d.send).toBe("deferred");
  });

  it("start === end disables quiet hours; malformed input fails open to sending", () => {
    expect(
      resolveHqQuietHours({ ...base, quietStart: "07:00", quietEnd: "07:00", now: NIGHT, urgent: false }),
    ).toEqual({ send: "now" });
    expect(
      resolveHqQuietHours({ ...base, quietStart: "junk", now: NIGHT, urgent: false }),
    ).toEqual({ send: "now" });
    expect(
      resolveHqQuietHours({ ...base, timezone: "Not/AZone", now: NIGHT, urgent: false }),
    ).toEqual({ send: "now" });
  });

  it("honours the configured timezone (same instant, different wall clock)", () => {
    // 23:30 UTC is 10:30 next morning in Auckland (UTC+13 in January) —
    // outside a 22:00→07:00 window there.
    expect(
      resolveHqQuietHours({ ...base, timezone: "Pacific/Auckland", now: NIGHT, urgent: false }),
    ).toEqual({ send: "now" });
  });
});

describe("HQ wiring — the critical-alert fire is the consumer", () => {
  it("notifyOnUrgentHqAlert opts into email with NO explicit `to` (the configured list routes it)", () => {
    const n = notifyOnUrgentHqAlert({
      org_id: "o1",
      alert_label: "Payment failed streak",
    });
    expect(n.audience).toBe("hq");
    expect(n.priority).toBe("urgent");
    expect(n.email).toBeDefined();
    expect(n.email?.to ?? null).toBeNull();
  });

  it("the bridge resolves HQ recipients + quiet hours from the settings singleton", () => {
    expect(SVC).toMatch(/parseHqRecipients/);
    expect(SVC).toMatch(/resolveHqQuietHours/);
    expect(SVC).toMatch(/from "@\/server\/services\/hq-settings"/);
    expect(SVC).toMatch(/critical_cc_email/);
    expect(SVC).toMatch(/scheduled_for: scheduledFor/);
  });

  it("the routing additions stay pure (no server-only / supabase imports)", () => {
    expect(ROUTING).not.toMatch(/import "server-only"/);
    expect(ROUTING).not.toMatch(/from "@\/lib\/supabase/);
    expect(ROUTING).toMatch(/export function parseHqRecipients/);
    expect(ROUTING).toMatch(/export function resolveHqQuietHours/);
  });
});

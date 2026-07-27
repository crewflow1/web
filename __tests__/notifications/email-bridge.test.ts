import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveEmailRecipient } from "@/lib/notifications/email-routing";
import { notifyOnFailedPayment } from "@/lib/notifications/events";

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

  it("hq audience with no explicit `to` → null (no wired recipient yet)", () => {
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

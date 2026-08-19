import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isSmsConfigured,
  enqueueSmsForNotifications,
  resolveSmsRecipients,
  normaliseSmsPhone,
  buildSmsText,
  SMS_MAX_BODY_LENGTH,
  type SmsRecipient,
} from "@/lib/notifications/sms";
import { getNotificationSmsProvider } from "@/lib/comms";
import type { NotificationRow } from "@/lib/notifications/types";
import type { NotificationPreference } from "@/lib/notifications/preferences";

/**
 * MP Wave W4 — the SMS notification channel (transport wiring).
 *
 * Before this the channel had an eligibility pipeline but NO transport: emit
 * resolved WHO would receive an SMS and sent nothing (darkReason "no_transport").
 * This suite pins the completed seam:
 *   1. DARK by default (refuse-before-send) — no Twilio ⇒ nothing enqueued/sent.
 *   2. per-member fan-out of org-wide rows + preference/opt-out respect + tenant
 *      isolation + phone-gating (the pure `resolveSmsRecipients` decision).
 *   3. phone normalisation + SMS body composition (pure).
 *   4. idempotency + the wiring/DARK guarantees, pinned on SOURCE (the house bar —
 *      the real send/record behaviour is DB-bound and exercised by the drain cron).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const SMS_SRC = read("lib/notifications/sms.ts");
const SVC_SRC = read("server/services/notifications-service.ts");
const MIG_SRC = read(
  "supabase/migrations/20261187000000_sms_notification_deliveries.sql",
);
const CRON_SRC = read("app/api/cron/sms-drain/route.ts");

// ── fixtures ──────────────────────────────────────────────────────────────

let seq = 0;
function mkRow(partial: Partial<NotificationRow> & { org_id: string }): NotificationRow {
  return {
    id: `n${++seq}`,
    user_id: partial.user_id ?? null,
    audience: partial.audience ?? "customer",
    type: partial.type ?? "job.updated",
    category: partial.category ?? "system",
    title: partial.title ?? "Title",
    body: partial.body ?? null,
    priority: partial.priority ?? "medium",
    source_module: null,
    source_id: null,
    action_url: partial.action_url ?? null,
    read_at: null,
    dismissed_at: null,
    metadata: {},
    created_at: "2026-08-19T00:00:00Z",
    updated_at: "2026-08-19T00:00:00Z",
    ...partial,
  };
}

function pref(
  over: Partial<NotificationPreference> & { org_id: string; user_id: string; category: string },
): NotificationPreference {
  return {
    in_app_enabled: true,
    email_enabled: true,
    email_cadence: "immediate",
    push_enabled: true,
    sms_enabled: false,
    ...over,
  };
}

const prefMap = (rows: NotificationPreference[]): Map<string, NotificationPreference> =>
  new Map(rows.map((p) => [`${p.org_id}::${p.user_id}::${p.category}`, p]));

const idsOf = (rs: SmsRecipient[]) => rs.map((r) => `${r.row.org_id}:${r.userId}`).sort();

// =====================================================================
// 1. DARK by default — refuse-before-send
// =====================================================================

describe("SMS channel — DARK by default (two-switch, refuse-before-send)", () => {
  it("the comms notification-SMS accessor is null with no Twilio creds (the CI path)", () => {
    expect(getNotificationSmsProvider()).toBeNull();
    expect(isSmsConfigured()).toBe(false);
  });

  it("enqueue sends/queues NOTHING when unconfigured — even with eligible rows", async () => {
    // A critical, urgent, user-directed row (maximally eligible) still enqueues 0:
    // SWITCH 1 short-circuits before any DB access, so this needs no database.
    const enqueued = await enqueueSmsForNotifications([
      mkRow({ org_id: "orgA", user_id: "u1", category: "billing", priority: "urgent" }),
    ]);
    expect(enqueued).toBe(0);
  });

  it("enqueue is a no-op on an empty batch", async () => {
    expect(await enqueueSmsForNotifications([])).toBe(0);
  });

  it("the enqueue short-circuits on the DARK switch BEFORE touching the DB", () => {
    // `if (!isSmsConfigured()) return 0;` precedes the first createAdminClient().
    const darkIdx = SMS_SRC.indexOf("if (!isSmsConfigured()) return 0;");
    const adminIdx = SMS_SRC.indexOf("createAdminClient()");
    expect(darkIdx).toBeGreaterThan(-1);
    expect(adminIdx).toBeGreaterThan(-1);
    expect(darkIdx).toBeLessThan(adminIdx);
  });

  it("the drain double-checks DARK and settles 'skipped'/no_provider (never sends)", () => {
    expect(SMS_SRC).toMatch(/const provider = getNotificationSmsProvider\(\);/);
    expect(SMS_SRC).toMatch(/if \(!provider\) \{/);
    expect(SMS_SRC).toMatch(/"skipped",\s*d\.retry_count,\s*"no_provider"/);
  });
});

// =====================================================================
// 2. Fan-out × preference/opt-out × tenant isolation × phone-gating (pure)
// =====================================================================

describe("resolveSmsRecipients — org-wide fan-out to each eligible member", () => {
  it("fans an org-wide row out to EVERY member with a phone + SMS opt-in", () => {
    const row = mkRow({ org_id: "orgA", user_id: null, category: "system" });
    const out = resolveSmsRecipients({
      rows: [row],
      membersByOrg: new Map([["orgA", new Set(["u1", "u2", "u3"])]]),
      phonedKeys: new Set(["orgA::u1", "orgA::u2", "orgA::u3"]),
      prefIndex: prefMap([
        pref({ org_id: "orgA", user_id: "u1", category: "system", sms_enabled: true }),
        pref({ org_id: "orgA", user_id: "u2", category: "system", sms_enabled: true }),
        pref({ org_id: "orgA", user_id: "u3", category: "system", sms_enabled: true }),
      ]),
    });
    expect(idsOf(out)).toEqual(["orgA:u1", "orgA:u2", "orgA:u3"]);
  });

  it("a user-directed row targets only that user", () => {
    const row = mkRow({ org_id: "orgA", user_id: "u1", category: "system" });
    const out = resolveSmsRecipients({
      rows: [row],
      membersByOrg: new Map(),
      phonedKeys: new Set(["orgA::u1"]),
      prefIndex: prefMap([
        pref({ org_id: "orgA", user_id: "u1", category: "system", sms_enabled: true }),
      ]),
    });
    expect(idsOf(out)).toEqual(["orgA:u1"]);
  });
});

describe("resolveSmsRecipients — per-member preference / opt-out (DEFAULT OFF)", () => {
  const orgWide = () => mkRow({ org_id: "orgA", user_id: null, category: "system" });
  const members = new Map([["orgA", new Set(["optIn", "optOut", "noPref"])]]);
  const phoned = new Set(["orgA::optIn", "orgA::optOut", "orgA::noPref"]);

  it("includes opt-in, excludes explicit opt-out AND the default (no-pref) member", () => {
    const out = resolveSmsRecipients({
      rows: [orgWide()],
      membersByOrg: members,
      phonedKeys: phoned,
      prefIndex: prefMap([
        pref({ org_id: "orgA", user_id: "optIn", category: "system", sms_enabled: true }),
        pref({ org_id: "orgA", user_id: "optOut", category: "system", sms_enabled: false }),
        // noPref: no row at all → default OFF (opt-in channel)
      ]),
    });
    expect(idsOf(out)).toEqual(["orgA:optIn"]);
  });

  it("the CRITICAL floor overrides opt-out and the default for a billing/urgent row", () => {
    const critical = mkRow({
      org_id: "orgA",
      user_id: null,
      category: "billing", // a critical category
      priority: "high",
    });
    const out = resolveSmsRecipients({
      rows: [critical],
      membersByOrg: members,
      phonedKeys: phoned,
      prefIndex: prefMap([
        pref({ org_id: "orgA", user_id: "optOut", category: "billing", sms_enabled: false }),
      ]),
    });
    // Everyone with a phone is reached despite opt-out / no-pref — the safety floor.
    expect(idsOf(out)).toEqual(["orgA:noPref", "orgA:optIn", "orgA:optOut"]);
  });
});

describe("resolveSmsRecipients — tenant isolation", () => {
  it("an org-wide row for orgA NEVER reaches another tenant's members", () => {
    const rowA = mkRow({ org_id: "orgA", user_id: null, category: "system" });
    const out = resolveSmsRecipients({
      rows: [rowA],
      membersByOrg: new Map([
        ["orgA", new Set(["a1", "a2"])],
        ["orgB", new Set(["b1"])],
      ]),
      // Even if orgB's member somehow had a phone key + opt-in, the fan-out is
      // keyed by the row's own org, so b1 is structurally unreachable.
      phonedKeys: new Set(["orgA::a1", "orgA::a2", "orgB::b1"]),
      prefIndex: prefMap([
        pref({ org_id: "orgA", user_id: "a1", category: "system", sms_enabled: true }),
        pref({ org_id: "orgA", user_id: "a2", category: "system", sms_enabled: true }),
        pref({ org_id: "orgB", user_id: "b1", category: "system", sms_enabled: true }),
      ]),
    });
    expect(idsOf(out)).toEqual(["orgA:a1", "orgA:a2"]);
  });
});

describe("resolveSmsRecipients — phone-gating and dedup", () => {
  it("excludes an eligible member who has no usable phone", () => {
    const out = resolveSmsRecipients({
      rows: [mkRow({ org_id: "orgA", user_id: null, category: "system" })],
      membersByOrg: new Map([["orgA", new Set(["hasPhone", "noPhone"])]]),
      phonedKeys: new Set(["orgA::hasPhone"]), // noPhone absent
      prefIndex: prefMap([
        pref({ org_id: "orgA", user_id: "hasPhone", category: "system", sms_enabled: true }),
        pref({ org_id: "orgA", user_id: "noPhone", category: "system", sms_enabled: true }),
      ]),
    });
    expect(idsOf(out)).toEqual(["orgA:hasPhone"]);
  });

  it("emits each (notification, user) at most once", () => {
    const row = mkRow({ org_id: "orgA", user_id: "u1", category: "billing", priority: "urgent" });
    // Same row appears twice in the batch; the recipient must not be duplicated.
    const out = resolveSmsRecipients({
      rows: [row, row],
      membersByOrg: new Map(),
      phonedKeys: new Set(["orgA::u1"]),
      prefIndex: new Map(),
    });
    expect(out).toHaveLength(1);
  });
});

// =====================================================================
// 3. Phone normalisation + SMS body composition (pure)
// =====================================================================

describe("normaliseSmsPhone — E.164 gate", () => {
  it("accepts and cleans a spaced/hyphenated E.164 number", () => {
    expect(normaliseSmsPhone("+44 7700-900 123")).toBe("+447700900123");
    expect(normaliseSmsPhone(" +447700900123 ")).toBe("+447700900123");
  });

  it("rejects non-E.164 / junk / empty input", () => {
    for (const bad of ["07700900123", "hello", "", "+", "+12", null, undefined, "441234567890"]) {
      expect(normaliseSmsPhone(bad as string)).toBeNull();
    }
  });
});

describe("buildSmsText — composition, link safety, truncation", () => {
  it("joins title and body", () => {
    expect(buildSmsText({ title: "Invoice paid", body: "£500 from Acme" })).toBe(
      "Invoice paid — £500 from Acme",
    );
  });

  it("appends a same-origin deep link but DROPS an absolute/off-origin action_url", () => {
    expect(buildSmsText({ title: "Job", action_url: "/jobs/1" })).toBe(
      "Job https://crewflow.uk/jobs/1",
    );
    expect(buildSmsText({ title: "Job", action_url: "https://evil.example/x" })).toBe("Job");
    expect(buildSmsText({ title: "Job", action_url: "//evil.example/x" })).toBe("Job");
  });

  it("truncates an over-long message to the max length with an ellipsis", () => {
    const out = buildSmsText({ title: "T", body: "x".repeat(500) });
    expect(out.length).toBeLessThanOrEqual(SMS_MAX_BODY_LENGTH);
    expect(out.endsWith("…")).toBe(true);
  });
});

// =====================================================================
// 4. Idempotency + wiring + storage, pinned on SOURCE
// =====================================================================

describe("SMS channel — idempotency + wiring (source)", () => {
  it("enqueue upserts idempotently on (notification_id, user_id)", () => {
    expect(SMS_SRC).toMatch(/onConflict:\s*"notification_id,user_id"/);
    expect(SMS_SRC).toMatch(/ignoreDuplicates:\s*true/);
  });

  it("the delivery ledger enforces one row per (notification, recipient)", () => {
    expect(MIG_SRC).toMatch(
      /constraint sms_deliveries_notification_user_uniq unique \(notification_id, user_id\)/,
    );
  });

  it("the ledger is service-role only (RLS on, default-deny)", () => {
    expect(MIG_SRC).toMatch(/alter table public\.sms_deliveries enable row level security/);
    expect(MIG_SRC).toMatch(/revoke all on table public\.sms_deliveries from anon, authenticated/);
  });

  it("emit enqueues SMS off the persisted rows (org-wide fan-out included)", () => {
    expect(SVC_SRC).toMatch(
      /import \{ enqueueSmsForNotifications \} from "@\/lib\/notifications\/sms"/,
    );
    expect(SVC_SRC).toMatch(/enqueueSmsForNotifications\(rows\)/);
    // the retired dark seam name is gone
    expect(SVC_SRC).not.toMatch(/deliverSmsForNotifications/);
  });

  it("the drain cron is Bearer-auth gated and telemetered", () => {
    expect(CRON_SRC).toMatch(/isCronAuthorised\(request\)/);
    expect(CRON_SRC).toMatch(/withCronTelemetry\("sms-drain"/);
    expect(CRON_SRC).toMatch(/drainSmsQueue\(\)/);
  });

  it("the drain records the provider correlation id on a successful send", () => {
    expect(SMS_SRC).toMatch(/await provider\.send\(\{ to: phone, body \}\)/);
    expect(SMS_SRC).toMatch(/acceptance\.providerMessageId/);
  });
});

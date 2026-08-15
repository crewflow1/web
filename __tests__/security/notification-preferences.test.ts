import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  KNOWN_ORG_SCOPED_TABLES,
  EXCLUDED_FROM_EXPORT,
  ORG_EXPORT_TABLES,
} from "@/lib/gdpr/export-tables";

/**
 * P3 Notification preferences — trust-boundary + wiring pins (hermetic).
 *
 * The properties that keep per-user preferences safe and non-regressive:
 *   1. notification_preferences is STRICTLY user-scoped for WRITES — every
 *      insert/update/delete policy requires `user_id = auth.uid()`, so one user
 *      can never write another's preferences (admins may READ, not write).
 *   2. notification_digest_cursors is service-role only — RLS on, grants revoked
 *      from anon/authenticated, no authenticated policy => default-deny.
 *   3. The immediate email bridge HONORS preferences for user-directed
 *      notifications but leaves ORG-WIDE (user_id null) behaviour byte-identical,
 *      and the critical floor is never bypassed.
 *   4. The digest cron is NETWORK-FREE — it enqueues onto the shared queue and
 *      never calls the email provider directly.
 *   5. Both new org-scoped tables are classified for GDPR export.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const MIGRATION = read(
  "supabase/migrations/20261136000000_notification_preferences.sql",
);
const SVC = read("server/services/notifications-service.ts");
const PREF_SVC = read("server/services/notification-preferences-service.ts");
const CRON = read("app/api/cron/notifications-digest/route.ts");

// =====================================================================
// 1. notification_preferences — strict user-scoped writes
// =====================================================================

describe("notification_preferences RLS — user-scoped writes", () => {
  it("enables RLS on the table", () => {
    expect(MIGRATION).toMatch(
      /alter table public\.notification_preferences enable row level security/,
    );
  });

  it("every WRITE policy requires user_id = auth.uid() (own rows only)", () => {
    // Isolate the insert/update/delete policy bodies and assert each pins the
    // caller as the row owner — no admin-write escape hatch.
    for (const verb of ["insert", "update", "delete"]) {
      const re = new RegExp(
        `for ${verb} to authenticated[\\s\\S]*?(?=drop policy|create policy|$)`,
        "i",
      );
      const block = MIGRATION.match(
        new RegExp(
          `create policy[^;]*for ${verb} to authenticated[\\s\\S]*?;`,
          "i",
        ),
      );
      expect(block, `missing ${verb} policy`).not.toBeNull();
      expect(
        /user_id = auth\.uid\(\)/.test(block![0]),
        `${verb} policy must pin user_id = auth.uid()`,
      ).toBe(true);
      // The admin helper must NOT appear in a write policy (admins read only).
      expect(
        /is_org_admin/.test(block![0]),
        `${verb} policy must NOT grant is_org_admin write`,
      ).toBe(false);
      void re;
    }
  });

  it("SELECT policy allows own rows OR org admins (read audit), org-pinned", () => {
    const sel = MIGRATION.match(
      /create policy[^;]*for select to authenticated[\s\S]*?;/i,
    );
    expect(sel).not.toBeNull();
    expect(/user_id = auth\.uid\(\)/.test(sel![0])).toBe(true);
    expect(/is_org_admin\(org_id\)/.test(sel![0])).toBe(true);
    expect(/current_org_ids\(\)/.test(sel![0])).toBe(true);
  });
});

// =====================================================================
// 2. notification_digest_cursors — service-role only
// =====================================================================

describe("notification_digest_cursors — service-role only", () => {
  it("enables RLS and revokes anon/authenticated grants", () => {
    expect(MIGRATION).toMatch(
      /alter table public\.notification_digest_cursors enable row level security/,
    );
    expect(MIGRATION).toMatch(
      /revoke all on table public\.notification_digest_cursors from anon, authenticated/,
    );
  });

  it("grants NO policy to authenticated on the cursor table (default-deny)", () => {
    // No `create policy ... on public.notification_digest_cursors`.
    expect(MIGRATION).not.toMatch(
      /create policy[^;]*on public\.notification_digest_cursors/i,
    );
  });

  it("cursor is per-cadence keyed (daily/weekly high-water-marks independent)", () => {
    expect(MIGRATION).toMatch(/primary key \(org_id, user_id, cadence\)/);
    expect(MIGRATION).toMatch(/cadence in \('daily', 'weekly'\)/);
  });
});

// =====================================================================
// 3. Immediate email bridge honors prefs; org-wide unchanged
// =====================================================================

describe("email bridge preference honoring (no regression)", () => {
  const code = codeOf(SVC);

  it("consults the pref resolver + bulk pref read for user-directed rows", () => {
    expect(code).toMatch(/resolveNotificationDelivery/);
    expect(code).toMatch(/getPreferencesForUserKeys/);
  });

  it("org-wide notifications (user_id null) keep today's behaviour", () => {
    // The gate returns true (queue) for null user_id BEFORE consulting prefs.
    expect(code).toMatch(/row\.user_id == null\)\s*return true/);
  });

  it("only an IMMEDIATE decision queues in the immediate path", () => {
    expect(code).toMatch(/decision\.email === "immediate"/);
  });

  it("preserves the opt-in-only firehose guard (existing contract)", () => {
    expect(SVC).toMatch(/\.filter\(\(p\) => p\.input\.email != null\)/);
  });

  it("still resolves the org recipient via the org-scoped read + pure resolver", () => {
    expect(SVC).toMatch(/\.from\("organizations"\)/);
    expect(SVC).toMatch(/resolveEmailRecipient/);
    expect(SVC).toMatch(/queueNotificationEmail\(/);
  });

  it("the cross-(org,user) bulk read guards against the cartesian product", () => {
    // Two .in() filters can return unrequested (org,user) combos — the service
    // must drop rows for a pair it did not ask for.
    expect(PREF_SVC).toMatch(/wanted\.has\(/);
  });
});

// =====================================================================
// 4. Digest cron is network-free
// =====================================================================

describe("digest cron — network-free (enqueues, never sends)", () => {
  it("route is cron-auth gated and drives runNotificationDigest", () => {
    expect(CRON).toMatch(/isCronAuthorised/);
    expect(CRON).toMatch(/runNotificationDigest/);
  });

  it("the digest service enqueues via queueDigestEmail, not a direct send", () => {
    expect(PREF_SVC).toMatch(/queueDigestEmail/);
    // No direct provider call in the digest path.
    expect(PREF_SVC).not.toMatch(/from "@\/lib\/email\/send"/);
    expect(PREF_SVC).not.toMatch(/\bsendEmail\(/);
  });

  it("processes users stalest-cursor-first and bounds the pass (fairness)", () => {
    expect(PREF_SVC).toMatch(/MAX_USERS_PER_PASS/);
    expect(PREF_SVC).toMatch(/users\.sort\(/);
  });
});

// =====================================================================
// 5. GDPR classification
// =====================================================================

describe("GDPR export registration", () => {
  it("notification_preferences is a known org-scoped table AND exported", () => {
    expect(KNOWN_ORG_SCOPED_TABLES).toContain("notification_preferences");
    expect(ORG_EXPORT_TABLES).toContain("notification_preferences");
    expect(EXCLUDED_FROM_EXPORT.notification_preferences).toBeUndefined();
  });

  it("notification_digest_cursors is known but EXCLUDED (transient runtime state)", () => {
    expect(KNOWN_ORG_SCOPED_TABLES).toContain("notification_digest_cursors");
    expect(ORG_EXPORT_TABLES).not.toContain("notification_digest_cursors");
    expect(EXCLUDED_FROM_EXPORT.notification_digest_cursors).toMatch(
      /transient|runtime/i,
    );
  });
});

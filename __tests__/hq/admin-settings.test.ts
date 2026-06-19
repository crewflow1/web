import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_SETTINGS,
  SECTION_IDS,
  SECTION_LABEL,
  SECTION_SCHEMAS,
  mergeSettings,
  diffSection,
  settingsSchema,
} from "@/lib/hq/settings";

/**
 * Phase 4 — /admin/settings tests.
 *
 * Pins:
 *   1. Migration creates the singleton hq_settings table + RLS +
 *      trigger, and is idempotent.
 *   2. Section ID list is exhaustive — eight categories the CEO
 *      directive named.
 *   3. Every section has a zod schema with sensible defaults so
 *      first-paint never blows up on a fresh row.
 *   4. mergeSettings tolerates missing / extra / corrupted keys.
 *   5. diffSection returns only the keys that actually changed.
 *   6. updateSection writes admin_activity_log with before/after
 *      diff payload.
 *   7. Server action re-checks isSuperAdminEmail.
 *   8. Page replaces the old stub and renders every section.
 *   9. Layout no longer brands /admin/settings as "Ships in HQ-6".
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = read("supabase/migrations/20260616000000_hq_settings.sql");
const SERVICE = read("server/services/hq-settings.ts");
const ACTIONS = read("app/admin/settings/actions.ts");
const PAGE = read("app/admin/settings/page.tsx");
const LAYOUT = read("app/admin/layout.tsx");

// =====================================================================
// 1. Migration
// =====================================================================

describe("Phase 4 — migration: hq_settings", () => {
  it("creates the singleton table", () => {
    expect(MIGRATION).toMatch(/create table if not exists public\.hq_settings/);
  });
  it("enforces single-row via id check", () => {
    expect(MIGRATION).toMatch(/check \(id = 'singleton'\)/);
  });
  it("stores sections in JSONB data column", () => {
    expect(MIGRATION).toMatch(/data jsonb not null default '\{\}'::jsonb/);
  });
  it("RLS enabled (service-role only — no policies created)", () => {
    expect(MIGRATION).toMatch(/enable row level security/);
    expect(MIGRATION).not.toMatch(/create policy/i);
  });
  it("trigger bumps updated_at on every UPDATE", () => {
    expect(MIGRATION).toMatch(/hq_settings_touch_updated_at/);
    expect(MIGRATION).toMatch(/before update on public\.hq_settings/);
  });
  it("seeds the singleton row idempotently", () => {
    expect(MIGRATION).toMatch(
      /insert into public\.hq_settings[\s\S]*on conflict \(id\) do nothing/,
    );
  });
});

// =====================================================================
// 2. Section catalogue
// =====================================================================

describe("settings section catalogue", () => {
  it("covers the eight CEO-directive sections", () => {
    expect([...SECTION_IDS].sort()).toEqual(
      [
        "alerts",
        "billing",
        "branding",
        "feature_flags",
        "general",
        "integrations",
        "notifications",
        "support",
      ].sort(),
    );
  });

  it("every section has a label", () => {
    for (const id of SECTION_IDS) {
      expect(SECTION_LABEL[id]).toBeTruthy();
    }
  });

  it("every section has a zod schema", () => {
    for (const id of SECTION_IDS) {
      expect(SECTION_SCHEMAS[id]).toBeTruthy();
    }
  });
});

// =====================================================================
// 3. Defaults — parsable, complete
// =====================================================================

describe("DEFAULT_SETTINGS", () => {
  it("parses cleanly through the combined schema", () => {
    const parsed = settingsSchema.safeParse(DEFAULT_SETTINGS);
    expect(parsed.success).toBe(true);
  });

  it("general.platform_name defaults to CrewFlow", () => {
    expect(DEFAULT_SETTINGS.general.platform_name).toBe("CrewFlow");
  });

  it("notifications.quiet_hours_start matches HH:MM regex", () => {
    expect(DEFAULT_SETTINGS.notifications.quiet_hours_start).toMatch(
      /^\d{2}:\d{2}$/,
    );
  });

  it("billing.default_invoice_due_days is sane (0..180)", () => {
    const v = DEFAULT_SETTINGS.billing.default_invoice_due_days;
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(180);
  });

  it("branding.primary_color is a 6-digit hex", () => {
    expect(DEFAULT_SETTINGS.branding.primary_color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

// =====================================================================
// 4. mergeSettings — robust to partial / corrupt input
// =====================================================================

describe("mergeSettings", () => {
  it("returns defaults when given null / undefined", () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("returns defaults when given a non-object", () => {
    expect(mergeSettings("nope")).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it("merges per section — unknown sections are ignored", () => {
    const merged = mergeSettings({
      general: { platform_name: "Custom" },
      junk: { x: 1 },
    });
    expect(merged.general.platform_name).toBe("Custom");
    expect(merged.general.support_email).toBe(
      DEFAULT_SETTINGS.general.support_email,
    );
    expect((merged as unknown as { junk?: unknown }).junk).toBeUndefined();
  });

  it("falls back to a section's defaults if a corrupt value fails the schema", () => {
    const merged = mergeSettings({
      general: { platform_name: 123 },
    });
    expect(merged.general.platform_name).toBe(
      DEFAULT_SETTINGS.general.platform_name,
    );
  });

  it("validates email format strictly", () => {
    const merged = mergeSettings({
      general: { support_email: "not-an-email" },
    });
    expect(merged.general.support_email).toBe(
      DEFAULT_SETTINGS.general.support_email,
    );
  });
});

// =====================================================================
// 5. diffSection
// =====================================================================

describe("diffSection", () => {
  it("returns an empty diff when nothing changed", () => {
    const r = diffSection({ a: 1, b: 2 }, { a: 1, b: 2 });
    expect(r.keys).toEqual([]);
  });

  it("flags only the changed keys", () => {
    const r = diffSection({ a: 1, b: 2 }, { a: 1, b: 3 });
    expect(r.keys).toEqual(["b"]);
    expect(r.after.b).toBe(3);
    expect(r.before.b).toBe(2);
  });

  it("treats added / removed keys as changes", () => {
    const r = diffSection<Record<string, unknown>>({ a: 1 }, { a: 1, c: 9 });
    expect(r.keys).toEqual(["c"]);
  });
});

// =====================================================================
// 6. Service writes audit + uses zod schemas
// =====================================================================

describe("server/services/hq-settings.ts", () => {
  it("calls recordAdminActivity with the changed-keys payload", () => {
    expect(SERVICE).toMatch(/recordAdminActivity/);
    expect(SERVICE).toMatch(/action: `hq_settings\.\$\{section\}\.updated`/);
    expect(SERVICE).toMatch(/before: beforeDiff/);
    expect(SERVICE).toMatch(/after: afterDiff/);
  });

  it("validates the patch with the matching section schema", () => {
    expect(SERVICE).toMatch(/SECTION_SCHEMAS\[section\]/);
    expect(SERVICE).toMatch(/schema\.safeParse/);
  });

  it("returns early with changedKeys=[] when nothing actually changed", () => {
    expect(SERVICE).toMatch(/if \(keys\.length === 0\)/);
    expect(SERVICE).toMatch(/changedKeys: \[\]/);
  });

  it("UPSERTs by id='singleton' with onConflict='id'", () => {
    expect(SERVICE).toMatch(/id: "singleton"/);
    expect(SERVICE).toMatch(/onConflict:\s*"id"/);
  });

  it("is server-only", () => {
    expect(SERVICE).toMatch(/^import "server-only";/);
  });
});

// =====================================================================
// 7. Server actions are auth-gated
// =====================================================================

describe("app/admin/settings/actions.ts", () => {
  it("uses 'use server'", () => {
    expect(ACTIONS).toMatch(/^"use server";/);
  });
  it("gates on HQ access via requireHq() (defence in depth)", () => {
    expect(ACTIONS).toMatch(/import \{ requireHq \} from "@\/server\/auth\/hq"/);
    expect(ACTIONS).toMatch(/requireHq\(\)/);
  });
  it("rejects unknown section ids", () => {
    expect(ACTIONS).toMatch(/isSectionId/);
    expect(ACTIONS).toMatch(/unknown_section/);
  });
  it("redirects to /admin/settings with section anchor on success", () => {
    expect(ACTIONS).toMatch(/\/admin\/settings\?section=\$\{section\}&saved/);
  });
  it("treats unchecked boolean inputs as false (not silently kept)", () => {
    expect(ACTIONS).toMatch(/BOOLEAN_KEYS/);
    // The unchecked-fallback to false is the key invariant.
    expect(ACTIONS).toMatch(/patch\[k\] = false/);
  });
});

// =====================================================================
// 8. Page renders all sections + replaces the stub
// =====================================================================

describe("app/admin/settings/page.tsx", () => {
  it("no longer uses the ComingSoonStub", () => {
    expect(PAGE).not.toMatch(/ComingSoonStub/);
  });
  it("re-checks isSuperAdminEmail", () => {
    expect(PAGE).toMatch(/isSuperAdminEmail/);
    expect(PAGE).toMatch(/notFound\(\)/);
  });
  it("renders a form for every section", () => {
    for (const id of SECTION_IDS) {
      expect(PAGE).toMatch(new RegExp(`id="${id}"`));
    }
  });
  it("binds saveSection per section", () => {
    expect(PAGE).toMatch(/saveSection\.bind\(null, id\)/);
  });
  it("surfaces save / error banners from query params", () => {
    expect(PAGE).toMatch(/sp\.saved/);
    expect(PAGE).toMatch(/sp\.error/);
  });
});

// =====================================================================
// 9. Layout — Settings is no longer "Ships in HQ-6"
// =====================================================================

describe("admin layout", () => {
  it("Settings nav entry has no shipsIn badge", () => {
    expect(LAYOUT).toMatch(
      /\{ href: "\/admin\/settings", label: "Settings" \}/,
    );
  });
});

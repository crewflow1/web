import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AI_RECEPTIONIST_STATUSES,
  AI_RECEPTIONIST_STATUS_LABELS,
  AI_RECEPTIONIST_VOICES,
  TEST_CHECKLIST_ITEMS,
  TRADE_TYPES,
  aiReceptionistChecklistSchema,
  aiReceptionistNotesSchema,
  aiReceptionistSetupSchema,
  aiReceptionistStatusSchema,
} from "@/lib/ai-receptionist/schema";

/**
 * AI Receptionist white-glove onboarding tests.
 *
 * Pin every part of the contract:
 *   - schema: zod validation (customer + HQ)
 *   - migration: table + RLS shape
 *   - customer UI: settings page + dedicated /settings/ai-receptionist
 *   - HQ UI: list + detail pages + actions + nav
 *   - audit: every action calls recordAdminActivity
 */

const root = resolve(__dirname, "../..");
const exists = (rel: string) => existsSync(resolve(root, rel));
const read = (rel: string) => readFileSync(resolve(root, rel), "utf-8");

describe("AI Receptionist — schema invariants", () => {
  it("statuses match the directive's 4-state lifecycle", () => {
    expect([...AI_RECEPTIONIST_STATUSES]).toEqual([
      "not_started",
      "in_progress",
      "testing",
      "live",
    ]);
  });

  it("status labels are operator-friendly", () => {
    expect(AI_RECEPTIONIST_STATUS_LABELS.not_started).toBe("Not started");
    expect(AI_RECEPTIONIST_STATUS_LABELS.in_progress).toBe("In progress");
    expect(AI_RECEPTIONIST_STATUS_LABELS.testing).toBe("Testing");
    expect(AI_RECEPTIONIST_STATUS_LABELS.live).toBe("Live");
  });

  it("test checklist covers the 6 items the directive demands", () => {
    const keys = TEST_CHECKLIST_ITEMS.map((i) => i.key);
    expect(keys).toContain("test_call_at");
    expect(keys).toContain("test_sms_at");
    expect(keys).toContain("test_whatsapp_at");
    expect(keys).toContain("test_meta_at");
    expect(keys).toContain("test_voice_at");
    expect(keys).toContain("test_lead_at");
    expect(keys).toHaveLength(6);
  });

  it("UK voice list includes regional accents", () => {
    expect(AI_RECEPTIONIST_VOICES).toContain("scottish_female");
    expect(AI_RECEPTIONIST_VOICES).toContain("welsh_male");
    expect(AI_RECEPTIONIST_VOICES).toContain("irish_female");
    expect(AI_RECEPTIONIST_VOICES).toContain("british_female_warm");
  });

  it("trade types include common UK construction trades", () => {
    expect(TRADE_TYPES).toContain("general_builder");
    expect(TRADE_TYPES).toContain("plumber");
    expect(TRADE_TYPES).toContain("electrician");
    expect(TRADE_TYPES).toContain("roofer");
    expect(TRADE_TYPES).toContain("other");
  });
});

describe("AI Receptionist — customer form schema", () => {
  it("requires business_phone when enabled=true", () => {
    const result = aiReceptionistSetupSchema.safeParse({
      enabled: "on",
      business_phone: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const phoneIssue = result.error.issues.find(
        (i) => i.path.join(".") === "business_phone",
      );
      expect(phoneIssue?.message).toMatch(/business number/i);
    }
  });

  it("accepts enabled=true with business_phone present", () => {
    const result = aiReceptionistSetupSchema.safeParse({
      enabled: "on",
      business_phone: "+44 7700 900000",
      trade_type: "general_builder",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.business_phone).toBe("+44 7700 900000");
    }
  });

  it("accepts enabled=false with every other field blank", () => {
    const result = aiReceptionistSetupSchema.safeParse({
      enabled: "",
      business_phone: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.business_phone).toBeUndefined();
    }
  });

  it("empty strings collapse to undefined (not '')", () => {
    const result = aiReceptionistSetupSchema.safeParse({
      enabled: "on",
      business_phone: "+44",
      whatsapp_number: "",
      facebook_page: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.whatsapp_number).toBeUndefined();
      expect(result.data.facebook_page).toBeUndefined();
    }
  });
});

describe("AI Receptionist — HQ schemas", () => {
  it("status schema only accepts the 4 lifecycle values", () => {
    const id = "12345678-1234-1234-1234-1234567890ab";
    expect(
      aiReceptionistStatusSchema.safeParse({ id, status: "live" }).success,
    ).toBe(true);
    expect(
      aiReceptionistStatusSchema.safeParse({ id, status: "garbage" }).success,
    ).toBe(false);
  });

  it("checklist schema gates the 6 keys + on/off toggle", () => {
    const id = "12345678-1234-1234-1234-1234567890ab";
    expect(
      aiReceptionistChecklistSchema.safeParse({
        id,
        key: "test_meta_at",
        toggle: "true",
      }).success,
    ).toBe(true);
    expect(
      aiReceptionistChecklistSchema.safeParse({
        id,
        key: "test_xyz",
        toggle: "true",
      }).success,
    ).toBe(false);
    expect(
      aiReceptionistChecklistSchema.safeParse({
        id,
        key: "test_call_at",
        toggle: "maybe",
      }).success,
    ).toBe(false);
  });

  it("notes schema caps at 4000 chars + empty collapses", () => {
    const id = "12345678-1234-1234-1234-1234567890ab";
    expect(
      aiReceptionistNotesSchema.safeParse({ id, hq_notes: "" }).success,
    ).toBe(true);
    expect(
      aiReceptionistNotesSchema.safeParse({ id, hq_notes: "x".repeat(4001) })
        .success,
    ).toBe(false);
  });
});

describe("AI Receptionist — migration shape", () => {
  const mig = read("supabase/migrations/20260625000000_ai_receptionist_setups.sql");

  it("creates the ai_receptionist_setups table", () => {
    expect(mig).toMatch(/create table if not exists public\.ai_receptionist_setups/);
  });

  it("has the 4-state status CHECK", () => {
    expect(mig).toMatch(/check \(status in \('not_started', 'in_progress', 'testing', 'live'\)\)/);
  });

  it("has all 6 test_*_at columns", () => {
    for (const item of TEST_CHECKLIST_ITEMS) {
      expect(mig).toMatch(new RegExp(`${item.key}\\s+timestamp`));
    }
  });

  it("has configured_at + configured_by", () => {
    expect(mig).toMatch(/configured_at\s+timestamp with time zone/);
    expect(mig).toMatch(/configured_by\s+uuid references public\.users/);
  });

  it("enables RLS + has org_members select + admin insert/update policies", () => {
    expect(mig).toMatch(/enable row level security/);
    expect(mig).toMatch(/policy ai_receptionist_setups_select.*for select/s);
    expect(mig).toMatch(/policy ai_receptionist_setups_insert.*is_org_admin/s);
    expect(mig).toMatch(/policy ai_receptionist_setups_update.*is_org_admin/s);
  });

  it("unique-indexes by org_id (one setup row per org)", () => {
    expect(mig).toMatch(/create unique index if not exists ai_receptionist_setups_org_unique/);
  });
});

describe("AI Receptionist — customer UI", () => {
  it("/settings/ai-receptionist page + actions + form exist", () => {
    expect(exists("app/(app)/settings/ai-receptionist/page.tsx")).toBe(true);
    expect(exists("app/(app)/settings/ai-receptionist/actions.ts")).toBe(true);
    expect(exists("app/(app)/settings/ai-receptionist/_form.tsx")).toBe(true);
  });

  it("settings page shows AI Receptionist section with badge + link", () => {
    const src = read("app/(app)/settings/page.tsx");
    expect(src).toMatch(/AI Receptionist/);
    expect(src).toMatch(/\/settings\/ai-receptionist/);
    expect(src).toMatch(/aiBadge/);
  });

  it("customer page renders Pending / Live derived badge", () => {
    const src = read("app/(app)/settings/ai-receptionist/page.tsx");
    expect(src).toMatch(/Pending/);
    expect(src).toMatch(/Live/);
    // No raw HQ-only statuses leak through.
    expect(src).toMatch(/customerBadge/);
  });

  it("customer page shows the 6-item test checklist (without timestamps)", () => {
    const src = read("app/(app)/settings/ai-receptionist/page.tsx");
    expect(src).toMatch(/TEST_CHECKLIST_ITEMS/);
  });

  it("save action audits via recordAdminActivity + revalidates", () => {
    const src = read("app/(app)/settings/ai-receptionist/actions.ts");
    expect(src).toMatch(/recordAdminActivity/);
    expect(src).toMatch(/revalidatePath\("\/settings"\)/);
    expect(src).toMatch(/ai_receptionist\.enabled/);
    expect(src).toMatch(/ai_receptionist\.disabled/);
    expect(src).toMatch(/ai_receptionist\.updated/);
  });

  it("customer action gates on owner/admin role", () => {
    const src = read("app/(app)/settings/ai-receptionist/actions.ts");
    expect(src).toMatch(/membership\.role !== "owner"/);
  });
});

describe("AI Receptionist — HQ UI", () => {
  it("HQ list + detail + actions exist", () => {
    expect(exists("app/admin/ai-receptionist/page.tsx")).toBe(true);
    expect(exists("app/admin/ai-receptionist/[id]/page.tsx")).toBe(true);
    expect(exists("app/admin/ai-receptionist/actions.ts")).toBe(true);
  });

  it("HQ nav lists AI Receptionist setups", () => {
    // Nav moved to the grouped model; AI Receptionist lives under Growth.
    const layout = read("app/admin/_nav/hq-nav-model.ts");
    expect(layout).toMatch(/\/admin\/ai-receptionist/);
    expect(layout).toMatch(/AI Receptionist/);
  });

  it("HQ list page shows company / phone / channels / status / checklist columns", () => {
    const src = read("app/admin/ai-receptionist/page.tsx");
    expect(src).toMatch(/Company/);
    expect(src).toMatch(/Phone/);
    expect(src).toMatch(/Channels/);
    expect(src).toMatch(/Status/);
    expect(src).toMatch(/Checklist/);
  });

  it("HQ list page filters by status via ?status param", () => {
    const src = read("app/admin/ai-receptionist/page.tsx");
    expect(src).toMatch(/AI_RECEPTIONIST_STATUSES/);
    expect(src).toMatch(/FilterPill/);
  });

  it("HQ detail renders 4 status buttons + 6 checklist items + mark configured shortcut", () => {
    const src = read("app/admin/ai-receptionist/[id]/page.tsx");
    expect(src).toMatch(/setAiReceptionistStatus/);
    expect(src).toMatch(/toggleAiReceptionistChecklist/);
    expect(src).toMatch(/markAiReceptionistConfigured/);
    expect(src).toMatch(/Mark AI receptionist configured/);
    expect(src).toMatch(/TEST_CHECKLIST_ITEMS\.map/);
  });

  it("HQ actions gate on isSuperAdminEmail (404 not 403)", () => {
    const src = read("app/admin/ai-receptionist/actions.ts");
    expect(src).toMatch(/isSuperAdminEmail/);
    expect(src).toMatch(/redirect\("\/dashboard"\)/);
  });

  it("HQ actions audit every transition", () => {
    const src = read("app/admin/ai-receptionist/actions.ts");
    expect(src).toMatch(/ai_receptionist\.status_/);
    expect(src).toMatch(/"checked"|"unchecked"/);
    expect(src).toMatch(/ai_receptionist\.notes_updated/);
    expect(src).toMatch(/ai_receptionist\.marked_configured/);
    // recordAdminActivity import + call.
    expect(src).toMatch(/recordAdminActivity/);
  });

  it("HQ status move to 'live' stamps configured_at + configured_by", () => {
    const src = read("app/admin/ai-receptionist/actions.ts");
    expect(src).toMatch(/configured_at\s*=\s*now/);
    expect(src).toMatch(/configured_by\s*=\s*admin\.id/);
  });

  it("HQ status move AWAY from live clears configured_at/by (verified flag)", () => {
    const src = read("app/admin/ai-receptionist/actions.ts");
    expect(src).toMatch(/update\.configured_at\s*=\s*null/);
    expect(src).toMatch(/update\.configured_by\s*=\s*null/);
  });
});

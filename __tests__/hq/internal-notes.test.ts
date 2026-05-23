import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INTERNAL_NOTE_CATEGORIES,
  INTERNAL_NOTE_PRIORITIES,
  INTERNAL_NOTE_PRIORITY_RANK,
  INTERNAL_NOTE_SORTS,
  sortNotes,
  filterNotes,
  isValidCategory,
  isValidPriority,
  type InternalNoteRow,
} from "@/lib/hq/internal-notes";

/**
 * HQ-9 Internal Notes contract tests.
 *
 * Pinned:
 *   1. Vocab: 8 categories + 4 priorities, validators reject anything
 *      outside the canonical set.
 *   2. Pure compute: sortNotes default (pinned first) + priority +
 *      newest/oldest; filterNotes hides archived by default, pinned-
 *      only narrows correctly.
 *   3. Migration: table created, RLS enabled with NO policies
 *      (service-role only), CHECK constraints on category/priority,
 *      every directive index present, touch trigger.
 *   4. Service: every directive function exported.
 *   5. HQ actions: super-admin gated, urgent → HQ notification only
 *      (never customer), each action writes admin_activity_log.
 *   6. /admin/notes page: list + filters + create form + KPIs.
 *   7. Customer-detail panel: imports actions, renders form +
 *      latest notes.
 *   8. RLS guarantee pinned: tenant SELECT impossible (no policy).
 *   9. HQ_NAV: /admin/notes no longer marked Coming soon.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = read("supabase/migrations/20260612000000_internal_notes.sql");
const LIB = read("lib/hq/internal-notes.ts");
const SVC = read("server/services/hq-internal-notes.ts");
const HQ_PAGE = read("app/admin/notes/page.tsx");
const HQ_ACTIONS = read("app/admin/notes/actions.ts");
const PANEL = read("app/admin/customers/[id]/_internal-notes-panel.tsx");
const CUSTOMER_DETAIL = read("app/admin/customers/[id]/page.tsx");
const HQ_LAYOUT = read("app/admin/layout.tsx");

// =====================================================================
// 1. Vocab
// =====================================================================

describe("internal-notes vocab", () => {
  it("8 categories match the directive verbatim", () => {
    expect(INTERNAL_NOTE_CATEGORIES).toEqual([
      "general",
      "sales",
      "onboarding",
      "billing",
      "support",
      "risk",
      "technical",
      "success",
    ]);
  });

  it("4 priorities match the directive verbatim", () => {
    expect(INTERNAL_NOTE_PRIORITIES).toEqual(["low", "normal", "high", "urgent"]);
  });

  it("priority rank: urgent < high < normal < low", () => {
    expect(INTERNAL_NOTE_PRIORITY_RANK.urgent).toBeLessThan(
      INTERNAL_NOTE_PRIORITY_RANK.high,
    );
    expect(INTERNAL_NOTE_PRIORITY_RANK.high).toBeLessThan(
      INTERNAL_NOTE_PRIORITY_RANK.normal,
    );
    expect(INTERNAL_NOTE_PRIORITY_RANK.normal).toBeLessThan(
      INTERNAL_NOTE_PRIORITY_RANK.low,
    );
  });

  it("validators reject anything outside the canonical set", () => {
    expect(isValidCategory("sales")).toBe(true);
    expect(isValidCategory("misc")).toBe(false);
    expect(isValidPriority("urgent")).toBe(true);
    expect(isValidPriority("p0")).toBe(false);
  });

  it("sort options include the directive list", () => {
    for (const s of ["default", "priority", "newest", "oldest", "category"]) {
      expect(INTERNAL_NOTE_SORTS).toContain(s);
    }
  });
});

// =====================================================================
// 2. Pure compute
// =====================================================================

function note(over: Partial<InternalNoteRow> = {}): InternalNoteRow {
  return {
    id: "n1",
    org_id: "o1",
    org_name: "Org 1",
    author_user_id: "u1",
    author_email: "operator@crewflow.uk",
    title: null,
    body: "body",
    category: "general",
    priority: "normal",
    pinned: false,
    archived_at: null,
    created_at: "2026-05-23T12:00:00Z",
    updated_at: "2026-05-23T12:00:00Z",
    ...over,
  };
}

describe("sortNotes", () => {
  it("default: pinned first then newest", () => {
    const rows = [
      note({ id: "a", pinned: false, created_at: "2026-05-23T12:00:00Z" }),
      note({ id: "b", pinned: true, created_at: "2026-05-20T12:00:00Z" }),
      note({ id: "c", pinned: false, created_at: "2026-05-22T12:00:00Z" }),
    ];
    expect(sortNotes(rows, "default").map((n) => n.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("priority: urgent first then newest", () => {
    const rows = [
      note({ id: "low", priority: "low" }),
      note({ id: "urg", priority: "urgent" }),
      note({ id: "hi", priority: "high" }),
    ];
    expect(sortNotes(rows, "priority").map((n) => n.id)).toEqual([
      "urg",
      "hi",
      "low",
    ]);
  });
});

describe("filterNotes", () => {
  const rows = [
    note({ id: "1", category: "sales", priority: "high" }),
    note({
      id: "2",
      category: "risk",
      priority: "urgent",
      pinned: true,
    }),
    note({
      id: "3",
      category: "general",
      archived_at: "2026-05-23",
    }),
  ];

  it("hides archived by default", () => {
    expect(filterNotes(rows, {}).map((n) => n.id)).toEqual(["1", "2"]);
  });

  it("show_archived flips back on", () => {
    expect(
      filterNotes(rows, { show_archived: true }).map((n) => n.id),
    ).toEqual(["1", "2", "3"]);
  });

  it("pinned_only narrows correctly", () => {
    expect(filterNotes(rows, { pinned_only: true }).map((n) => n.id)).toEqual(
      ["2"],
    );
  });

  it("category narrows correctly", () => {
    expect(filterNotes(rows, { category: "risk" }).map((n) => n.id)).toEqual([
      "2",
    ]);
  });

  it("q matches body / title / author / org_name", () => {
    expect(
      filterNotes([note({ id: "x", body: "ACME stuff" })], { q: "acme" })
        .length,
    ).toBe(1);
    expect(
      filterNotes([note({ id: "y", title: "Renewal call" })], { q: "renewal" })
        .length,
    ).toBe(1);
  });
});

// =====================================================================
// 3. Migration shape
// =====================================================================

describe("migration 20260612000000 — internal_notes", () => {
  it("creates the table", () => {
    expect(MIGRATION).toMatch(/create table if not exists public\.internal_notes/);
  });

  it("CHECKs every directive category + priority", () => {
    for (const c of INTERNAL_NOTE_CATEGORIES) {
      expect(MIGRATION).toMatch(new RegExp(`'${c}'`));
    }
    for (const p of INTERNAL_NOTE_PRIORITIES) {
      expect(MIGRATION).toMatch(new RegExp(`'${p}'`));
    }
  });

  it("RLS enabled with NO policies (service-role only — customers can never see)", () => {
    expect(MIGRATION).toMatch(/alter table public\.internal_notes enable row level security/);
    expect(MIGRATION).not.toMatch(/create policy/i);
  });

  it("FK on org_id cascades on org delete", () => {
    expect(MIGRATION).toMatch(/org_id\s+uuid not null references public\.organizations\(id\)\s+on delete cascade/);
  });

  it("author keeps both id + email (HQ-audit pattern)", () => {
    expect(MIGRATION).toMatch(/author_user_id\s+uuid references public\.users\(id\)/);
    expect(MIGRATION).toMatch(/author_email\s+text not null/);
  });

  it("indexes cover org+recent, pinned+recent, category, priority", () => {
    expect(MIGRATION).toMatch(/internal_notes_org_recent_idx/);
    expect(MIGRATION).toMatch(/internal_notes_pinned_idx/);
    expect(MIGRATION).toMatch(/internal_notes_category_idx/);
    expect(MIGRATION).toMatch(/internal_notes_priority_idx/);
  });

  it("touch trigger keeps updated_at fresh", () => {
    expect(MIGRATION).toMatch(/_internal_notes_touch/);
    expect(MIGRATION).toMatch(/before update on public\.internal_notes/);
  });
});

// =====================================================================
// 4. Service
// =====================================================================

describe("internal-notes service", () => {
  it("exports every directive function", () => {
    for (const fn of [
      "createInternalNote",
      "updateInternalNote",
      "archiveInternalNote",
      "unarchiveInternalNote",
      "pinInternalNote",
      "listInternalNotesForOrg",
      "listAllInternalNotesForHQ",
      "countPinnedNotes",
      "loadInternalNoteById",
    ]) {
      expect(SVC).toMatch(new RegExp(`export async function ${fn}`));
    }
  });

  it("uses service-role admin client throughout", () => {
    expect(SVC).toMatch(/createAdminClient/);
  });
});

// =====================================================================
// 5. HQ server actions
// =====================================================================

describe("HQ notes actions", () => {
  it("every action gates on isSuperAdminEmail via requireAdmin()", () => {
    expect(HQ_ACTIONS).toMatch(/async function requireAdmin/);
    expect(HQ_ACTIONS).toMatch(/isSuperAdminEmail\(user\.email\)/);
  });

  it("exports createNoteAction / updateNoteAction / archive / unarchive / togglePin", () => {
    for (const fn of [
      "createNoteAction",
      "updateNoteAction",
      "archiveNoteAction",
      "unarchiveNoteAction",
      "togglePinNoteAction",
    ]) {
      expect(HQ_ACTIONS).toMatch(new RegExp(`export async function ${fn}`));
    }
  });

  it("every action writes admin_activity_log", () => {
    const calls = (HQ_ACTIONS.match(/recordAdminActivity\(/g) ?? []).length;
    // 5 actions × 1 audit = 5+ writes.
    expect(calls).toBeGreaterThanOrEqual(5);
  });

  it("urgent priority creates an HQ notification (and NEVER a customer one)", () => {
    expect(HQ_ACTIONS).toMatch(/parsed\.data\.priority === "urgent"/);
    expect(HQ_ACTIONS).toMatch(/notifyOnUrgentHqAlert/);
  });

  it("redirect_to is validated (no open-redirect)", () => {
    expect(HQ_ACTIONS).toMatch(/safeRedirect/);
    expect(HQ_ACTIONS).toMatch(/startsWith\("\/"\)/);
    expect(HQ_ACTIONS).toMatch(/!.*startsWith\("\/\/"\)/);
  });

  it("Zod enums match the canonical lists", () => {
    expect(HQ_ACTIONS).toMatch(/z\.enum\(INTERNAL_NOTE_CATEGORIES\)/);
    expect(HQ_ACTIONS).toMatch(/z\.enum\(INTERNAL_NOTE_PRIORITIES\)/);
  });
});

// =====================================================================
// 6. /admin/notes page wiring
// =====================================================================

describe("/admin/notes page", () => {
  it("loads via listAllInternalNotesForHQ", () => {
    expect(HQ_PAGE).toMatch(/listAllInternalNotesForHQ/);
  });

  it("renders create form (action=createNoteAction)", () => {
    expect(HQ_PAGE).toMatch(/action=\{createNoteAction\}/);
  });

  it("renders filter inputs for q / customer / category / priority / sort", () => {
    expect(HQ_PAGE).toMatch(/name="q"/);
    expect(HQ_PAGE).toMatch(/name="org_id"/);
    expect(HQ_PAGE).toMatch(/name="category"/);
    expect(HQ_PAGE).toMatch(/name="priority"/);
    expect(HQ_PAGE).toMatch(/name="sort"/);
    expect(HQ_PAGE).toMatch(/name="pinned_only"/);
    expect(HQ_PAGE).toMatch(/name="show_archived"/);
  });

  it("renders pin/archive/unarchive controls per row", () => {
    expect(HQ_PAGE).toMatch(/action=\{togglePinNoteAction\}/);
    expect(HQ_PAGE).toMatch(/action=\{archiveNoteAction\}/);
    expect(HQ_PAGE).toMatch(/action=\{unarchiveNoteAction\}/);
  });

  it("4 KPI tiles (active / urgent / pinned / 24h)", () => {
    expect(HQ_PAGE).toMatch(/Active notes/);
    expect(HQ_PAGE).toMatch(/Urgent/);
    expect(HQ_PAGE).toMatch(/Pinned/);
    expect(HQ_PAGE).toMatch(/Last 24h/);
  });
});

// =====================================================================
// 7. Customer detail panel
// =====================================================================

describe("customer-detail internal-notes panel", () => {
  it("imports actions + service and renders inline create form", () => {
    expect(PANEL).toMatch(/listInternalNotesForOrg/);
    expect(PANEL).toMatch(/createNoteAction/);
    expect(PANEL).toMatch(/togglePinNoteAction/);
    expect(PANEL).toMatch(/archiveNoteAction/);
  });

  it("sets redirect_to back to the customer page", () => {
    // The panel's hidden input is fed by a const that interpolates
    // orgId — match both the constant assignment AND the hidden
    // input field.
    expect(PANEL).toMatch(/redirectBack\s*=\s*`\/admin\/customers\/\$\{orgId\}`/);
    expect(PANEL).toMatch(/name="redirect_to"\s+value=\{redirectBack\}/);
  });

  it("customer detail page wires the panel", () => {
    expect(CUSTOMER_DETAIL).toMatch(/InternalNotesPanel/);
    expect(CUSTOMER_DETAIL).toMatch(/\/_internal-notes-panel/);
  });
});

// =====================================================================
// 8. HQ_NAV — internal notes shipped
// =====================================================================

describe("HQ_NAV — internal notes is ready", () => {
  it("/admin/notes has no shipsIn flag", () => {
    expect(HQ_LAYOUT).toMatch(/href: "\/admin\/notes", label: "Internal notes" \}/);
    expect(HQ_LAYOUT).not.toMatch(/href: "\/admin\/notes"[^}]*shipsIn:/);
  });
});

// =====================================================================
// 9. RLS guarantee — tenant clients can never read these rows
// =====================================================================

describe("RLS guarantee (verified via migration text)", () => {
  it("internal_notes table has RLS enabled but NO policies — tenants can never SELECT", () => {
    expect(MIGRATION).toMatch(/alter table public\.internal_notes enable row level security/);
    // The migration must not create any policy for internal_notes
    // (we verify by ensuring there's no `create policy` anywhere
    // in the file referring to internal_notes).
    const internalSection = MIGRATION;
    expect(internalSection).not.toMatch(
      /create policy[^;]*internal_notes/i,
    );
  });
});

// Sanity import-touched
void LIB;

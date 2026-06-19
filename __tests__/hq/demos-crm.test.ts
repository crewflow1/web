import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEMO_LIFECYCLE_STATUSES,
  DEMO_STATUS_LABELS,
  toLifecycleStatus,
  isValidLifecycleStatus,
} from "@/lib/hq/demo-lifecycle";

/**
 * HQ-2 Demos CRM contract tests.
 *
 * Pins:
 *   1. Lifecycle constants match the CEO directive's 10 columns,
 *      in the correct kanban order.
 *   2. Legacy + unknown status values map sensibly to a kanban column.
 *   3. Migration 20260605000000 creates `admin_activity_log` with no
 *      RLS policies (service-role only).
 *   4. Server actions in app/admin/demos/actions.ts:
 *      - re-check isSuperAdminEmail
 *      - write to demo_requests
 *      - write to admin_activity_log via recordAdminActivity
 *   5. Page wires the search/filter/sort params through to the DB.
 *   6. Layout marks Demos CRM as ready (no longer "Coming soon").
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = read("supabase/migrations/20260605000000_admin_activity_log.sql");
const DEMO_ACTIONS = read("app/admin/demos/actions.ts");
const DEMO_PAGE = read("app/admin/demos/page.tsx");
const KANBAN = read("app/admin/demos/_kanban.tsx");
const DETAIL = read("app/admin/demos/_detail-panel.tsx");
const LAYOUT = read("app/admin/layout.tsx");
const AUDIT = read("server/services/hq-audit.ts");

describe("DEMO_LIFECYCLE_STATUSES — matches the CEO's 10 kanban columns", () => {
  it("has exactly the 10 columns the directive lists, in order", () => {
    expect(DEMO_LIFECYCLE_STATUSES).toEqual([
      "pending_demo",
      "contacted",
      "demo_booked",
      "demo_done",
      "won",
      "lost",
      "payment_sent",
      "payment_received",
      "active_onboarding",
      "active",
    ]);
  });

  it("every status has a label", () => {
    for (const s of DEMO_LIFECYCLE_STATUSES) {
      expect(DEMO_STATUS_LABELS[s]).toBeTruthy();
    }
  });
});

describe("toLifecycleStatus — legacy values map sensibly", () => {
  it("recognises every canonical value as itself", () => {
    for (const s of DEMO_LIFECYCLE_STATUSES) {
      expect(toLifecycleStatus(s)).toBe(s);
    }
  });

  it("maps legacy strings into the new columns", () => {
    expect(toLifecycleStatus("new")).toBe("pending_demo");
    expect(toLifecycleStatus("qualified")).toBe("demo_done");
    expect(toLifecycleStatus("closed_won")).toBe("won");
    expect(toLifecycleStatus("closed_lost")).toBe("lost");
    expect(toLifecycleStatus("approved")).toBe("won");
    expect(toLifecycleStatus("rejected")).toBe("lost");
    expect(toLifecycleStatus("cancelled")).toBe("lost");
  });

  it("unknown values fall through to pending_demo so nothing disappears", () => {
    expect(toLifecycleStatus("nonsense")).toBe("pending_demo");
    expect(toLifecycleStatus(null)).toBe("pending_demo");
    expect(toLifecycleStatus("")).toBe("pending_demo");
  });
});

describe("isValidLifecycleStatus — guards against bad input", () => {
  it("accepts the 10 canonical values", () => {
    for (const s of DEMO_LIFECYCLE_STATUSES) {
      expect(isValidLifecycleStatus(s)).toBe(true);
    }
  });
  it("rejects anything else", () => {
    expect(isValidLifecycleStatus("approved")).toBe(false);
    expect(isValidLifecycleStatus("")).toBe(false);
    expect(isValidLifecycleStatus("nonsense")).toBe(false);
  });
});

describe("migration 20260605000000 — admin_activity_log", () => {
  it("creates the table", () => {
    expect(MIGRATION).toMatch(/create table if not exists public\.admin_activity_log/);
  });
  it("references public.users on the actor FK with set null", () => {
    expect(MIGRATION).toMatch(/actor_id\s+uuid references public\.users\(id\)\s+on delete set null/);
  });
  it("enables RLS but installs no policies (service-role only)", () => {
    expect(MIGRATION).toMatch(/alter table public\.admin_activity_log enable row level security/);
    expect(MIGRATION).not.toMatch(/create policy/i);
  });
  it("indexes target + actor + recency for the panel queries we'll run", () => {
    expect(MIGRATION).toMatch(/admin_activity_log_target_idx/);
    expect(MIGRATION).toMatch(/admin_activity_log_actor_idx/);
    expect(MIGRATION).toMatch(/admin_activity_log_recent_idx/);
  });
});

describe("server actions — auth + dual-write", () => {
  it("every action gates on HQ access (requireHq + inline allowlist)", () => {
    // The redirect-style actions (moveDemoToStatus, addDemoNote, scheduleDemo)
    // funnel through the single requireHq() gate; the optimistic-UI JSON
    // actions (moveDemoToStatusJson, logDemoContact) keep a bespoke inline
    // isSuperAdminEmail(user.email) check so they can return { ok: false }
    // instead of redirecting. Both gate styles must be present.
    expect(DEMO_ACTIONS).toMatch(/requireHq\(\)/);
    expect(DEMO_ACTIONS).toMatch(/isSuperAdminEmail\(user\.email\)/);
    for (const action of [
      "moveDemoToStatus",
      "moveDemoToStatusJson",
      "addDemoNote",
      "scheduleDemo",
      "logDemoContact",
    ]) {
      expect(DEMO_ACTIONS).toMatch(new RegExp(`export async function ${action}`));
    }
  });

  it("writes to admin_activity_log via recordAdminActivity for every action", () => {
    const occurrences = (DEMO_ACTIONS.match(/recordAdminActivity\(/g) ?? []).length;
    // 5 actions × 1 audit write each.
    expect(occurrences).toBeGreaterThanOrEqual(5);
  });

  it("hq-audit helper exports both record + list functions", () => {
    expect(AUDIT).toMatch(/export async function recordAdminActivity/);
    expect(AUDIT).toMatch(/export async function listAdminActivity/);
  });

  it("hq-audit swallows failures (never breaks the primary action)", () => {
    expect(AUDIT).toMatch(/recordAdminActivity failed/);
    expect(AUDIT).toMatch(/try \{/);
    expect(AUDIT).toMatch(/catch \(e\)/);
  });

  it("Zod schemas reject non-lifecycle statuses on the form path", () => {
    expect(DEMO_ACTIONS).toMatch(/z\.enum\(DEMO_LIFECYCLE_STATUSES\)/);
  });
});

describe("kanban + page wiring", () => {
  it("kanban uses @dnd-kit/core (DndContext + useDraggable + useDroppable)", () => {
    expect(KANBAN).toMatch(/from "@dnd-kit\/core"/);
    expect(KANBAN).toMatch(/DndContext/);
    expect(KANBAN).toMatch(/useDraggable/);
    expect(KANBAN).toMatch(/useDroppable/);
  });

  it("kanban renders one column per lifecycle status", () => {
    expect(KANBAN).toMatch(/DEMO_LIFECYCLE_STATUSES\.map/);
  });

  it("optimistic update on drag end, rollback on failure", () => {
    expect(KANBAN).toMatch(/setOverrides/);
    expect(KANBAN).toMatch(/Roll back optimistic/);
  });

  it("page applies q + status + sort from URL before handing data to the board", () => {
    expect(DEMO_PAGE).toMatch(/sp\.q/);
    expect(DEMO_PAGE).toMatch(/sp\.status/);
    expect(DEMO_PAGE).toMatch(/sp\.sort/);
  });

  it("page issues at most ONE activity-timeline query, only for the open demo", () => {
    expect(DEMO_PAGE).toMatch(/listAdminActivity\("demo_requests"/);
    // The activity fetch must be conditional on an open demo — otherwise
    // we'd do an N+1 across the whole board on every page load.
    expect(DEMO_PAGE).toMatch(/openActivity = openDemo/);
    const calls = (DEMO_PAGE.match(/listAdminActivity\(/g) ?? []).length;
    expect(calls).toBe(1);
  });

  it("detail panel renders Call / Email / WhatsApp + every CEO action", () => {
    for (const label of [
      "Call",
      "Email",
      "WhatsApp",
      "Mark contacted",
      "Approve",
      "Reject",
      "Mark won",
      "Mark lost",
      "Send setup payment",
    ]) {
      expect(DETAIL).toContain(label);
    }
  });

  it("WhatsApp link is built via the shared whatsAppHref helper", () => {
    expect(DETAIL).toMatch(/whatsAppHref/);
    expect(DETAIL).toMatch(/from "@\/lib\/phone"/);
  });
});

describe("HQ_NAV — Demos CRM is no longer Coming soon", () => {
  it("HQ_NAV entry for /admin/demos has no shipsIn flag", () => {
    // The line should now read:  { href: "/admin/demos", label: "Demos CRM" },
    expect(LAYOUT).toMatch(/href: "\/admin\/demos", label: "Demos CRM" \}/);
    expect(LAYOUT).not.toMatch(
      /href: "\/admin\/demos"[^}]*shipsIn: "HQ-2"/,
    );
  });
});

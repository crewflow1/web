import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CAP_ACTIONS, CAP_MODULES } from "@/lib/auth/capability-rules";
import {
  ACTION_HINTS,
  ACTION_LABELS,
  MODULE_GROUPS,
  MODULE_LABELS,
} from "@/lib/auth/capability-labels";
import { normalize } from "@/app/(app)/staff/[id]/_permission-editor";

const K = (m: string, a: string) => `${m}:${a}`;
const arr = (s: Set<string>) => [...s].sort();

/**
 * R3 UI — owner-facing admin permission editor.
 *
 * The editor presents the FULL capability taxonomy as plain-English labels. This
 * guards two invariants a customer-facing editor must keep:
 *  (1) every module/action has a human label (no raw code ever leaks to owners),
 *  (2) every module appears in exactly one presentation group (none hidden, none
 *      double-listed) — so a newly-added CAP_MODULE can't silently fall out of
 *      the editor.
 * Plus the wiring pins: the editor saves via the owner-only setAdminPermissions,
 * and the staff detail page renders it ONLY for an owner viewing an admin.
 */

describe("capability labels cover the whole taxonomy", () => {
  it("every module has a label", () => {
    for (const m of CAP_MODULES) {
      expect(MODULE_LABELS[m], `label for ${m}`).toBeTruthy();
    }
  });

  it("every action has a label and a hint", () => {
    for (const a of CAP_ACTIONS) {
      expect(ACTION_LABELS[a], `label for ${a}`).toBeTruthy();
      expect(ACTION_HINTS[a], `hint for ${a}`).toBeTruthy();
    }
  });

  it("every module appears in exactly one group", () => {
    const seen = new Map<string, number>();
    for (const g of MODULE_GROUPS) {
      for (const m of g.modules) seen.set(m, (seen.get(m) ?? 0) + 1);
    }
    for (const m of CAP_MODULES) {
      expect(seen.get(m), `${m} must be in exactly one group`).toBe(1);
    }
    // No stray module in a group that isn't in the taxonomy.
    for (const [m] of seen) {
      expect(CAP_MODULES, `group lists unknown module ${m}`).toContain(m);
    }
  });
});

describe("normalize — minimal saved set, non-destructive granular picks", () => {
  it("a module with manage collapses to manage-only", () => {
    const got = normalize(new Set([K("jobs", "view"), K("jobs", "create"), K("jobs", "manage")]));
    expect(arr(got)).toEqual([K("jobs", "manage")]);
  });

  it("a module without manage keeps its explicit per-action grants", () => {
    const got = normalize(new Set([K("jobs", "view"), K("jobs", "create")]));
    expect(arr(got)).toEqual([K("jobs", "create"), K("jobs", "view")]);
  });

  it("normalizes each module independently", () => {
    const got = normalize(
      new Set([K("jobs", "manage"), K("jobs", "view"), K("quotes", "view"), K("quotes", "edit")]),
    );
    expect(arr(got)).toEqual([K("jobs", "manage"), K("quotes", "edit"), K("quotes", "view")]);
  });

  it("empty stays empty", () => {
    expect(arr(normalize(new Set()))).toEqual([]);
  });

  it("THE FIX: toggling manage on then off restores the granular selection", () => {
    // Owner picks view+create, then ticks manage (non-destructive: the set keeps
    // the granular keys and merely ADDS manage), then unticks manage.
    let set = new Set([K("jobs", "view"), K("jobs", "create")]);
    set = new Set([...set, K("jobs", "manage")]); // tick manage (toggle adds only)
    expect(arr(normalize(set))).toEqual([K("jobs", "manage")]); // saved = manage-only
    set.delete(K("jobs", "manage")); // untick manage
    // The granular picks are back — NOT wiped (the bug this fixes).
    expect(arr(normalize(set))).toEqual([K("jobs", "create"), K("jobs", "view")]);
  });
});

describe("editor + page wiring", () => {
  const ROOT = resolve(__dirname, "..", "..");
  const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

  it("the editor saves via the owner-only setAdminPermissions action", () => {
    const editor = read("app/(app)/staff/[id]/_permission-editor.tsx");
    expect(editor).toMatch(/setAdminPermissions\(\s*targetUserId/);
    // manage supersedes per-action grants at SAVE time — a minimal, honest saved
    // set — via normalize(), NOT by destroying the in-progress granular picks
    // (so toggling manage off restores them). The save payload is normalized.
    expect(editor).toMatch(/function normalize\(/);
    expect(editor).toMatch(/const effective = normalize\(grants\)/);
    // The old destructive behaviour must be gone: toggling manage must not delete
    // the other per-action grants.
    expect(editor).not.toMatch(/if \(a === "manage" && next\.has\(k\)\)/);
  });

  it("the staff page renders the editor ONLY for an owner viewing an admin", () => {
    const page = read("app/(app)/staff/[id]/page.tsx");
    expect(page).toMatch(/const viewerIsOwner = ctx\.membership\.role === "owner"/);
    expect(page).toMatch(
      /viewerIsOwner && row\.role === "admin" \? \(\s*<PermissionEditor/,
    );
    // Grants loaded on the service-role client (membership_permissions is never
    // client-readable) and gated behind the owner+admin branch.
    expect(page).toMatch(/if \(viewerIsOwner && row\.role === "admin"\) \{/);
    expect(page).toMatch(/from\("membership_permissions"\)/);
  });
});

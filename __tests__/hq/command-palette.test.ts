import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildHqCommands, matchHqCommand } from "@/app/admin/_nav/hq-commands";
import { HQ_AREAS } from "@/app/admin/_nav/hq-nav-model";

/**
 * HQ command palette — contracts for the role-gated HQ Cmd+K (product UX
 * rebuild, HQ phase).
 *
 * Two invariants matter most:
 *   1. HQ commands are role-gated BY CONSTRUCTION — the palette + its builder are
 *      imported only from app/admin/* (behind requireHqPage), never from the
 *      product shell. A customer can never receive an HQ command.
 *   2. Navigation commands are generated from the one HQ nav model, so they can
 *      never drift from the sidebar/mobile drawer; every "view" verb points at a
 *      real destination and none is an autonomous-execution shortcut.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("HQ commands — built from the nav model (no drift)", () => {
  const cmds = buildHqCommands();

  it("emits a navigate command for every HQ area and child href", () => {
    const hrefs = new Set(cmds.filter((c) => c.kind === "navigate").map((c) => c.href));
    for (const area of HQ_AREAS) {
      expect(hrefs.has(area.href)).toBe(true);
      for (const child of area.children) {
        expect(hrefs.has(child.href)).toBe(true);
      }
    }
  });

  it("labels every navigate command as a 'Go to …' destination", () => {
    for (const c of cmds.filter((c) => c.kind === "navigate")) {
      expect(c.label.startsWith("Go to ")).toBe(true);
    }
  });

  it("exposes the contextual 'Show …' verbs the directive named", () => {
    const views = cmds.filter((c) => c.kind === "view");
    const labels = views.map((v) => v.label.toLowerCase());
    for (const needle of ["pending approvals", "blocked work", "recent outcomes", "failed runs"]) {
      expect(labels.some((l) => l.includes(needle))).toBe(true);
    }
  });

  it("every command href is a real /admin destination (or an /admin anchor) — never an execution shortcut", () => {
    for (const c of cmds) {
      expect(c.href.startsWith("/admin")).toBe(true);
      // No verb that would trigger an action route (no apply/execute/run mutation).
      expect(c.href).not.toMatch(/\/(apply|execute|run|approve|reject)(\/|\?|$)/);
    }
  });

  it("matchHqCommand is a case-insensitive substring over label + keywords", () => {
    const approvals = cmds.find((c) => c.id === "view-pending-approvals")!;
    expect(matchHqCommand(approvals, "APPROV")).toBe(true);
    expect(matchHqCommand(approvals, "sign off")).toBe(true); // keyword
    expect(matchHqCommand(approvals, "zzz")).toBe(false);
    expect(matchHqCommand(approvals, "")).toBe(false);
  });
});

describe("HQ palette — role-gated by construction", () => {
  it("the palette and its command builder are imported only from app/admin (never the product shell)", () => {
    // The product shell must not reference the HQ palette/commands.
    const productSidebar = read("app/(app)/_components/sidebar.tsx");
    const productPalette = read("app/(app)/_components/search-palette.tsx");
    const productCommands = read("app/(app)/_nav/commands.ts");
    for (const src of [productSidebar, productPalette, productCommands]) {
      expect(src).not.toMatch(/hq-command|hq-commands|HqCommandPalette/);
    }
  });

  it("the HQ palette is mounted in the HQ layout, which gates on requireHqPage", () => {
    const layout = read("app/admin/layout.tsx");
    expect(layout).toMatch(/HqCommandPalette/);
    expect(layout).toMatch(/requireHqPage\(\)/);
  });
});

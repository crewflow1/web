import { describe, it, expect } from "vitest";
import { iconTileClass } from "@/components/ui/icon-tile";
import { pill } from "@/components/ui/tokens";

/**
 * Directive 007.6 — Phase 6. The icon tile is now a single primitive whose
 * colour is the canonical chip token (`pill()`), with layout (size + rounding)
 * layered on. These tests prove the builder emits exactly `layout ⊕ chip` — so
 * routing the ~22 hand-spelled header tiles through it cannot move a pixel — and
 * that `className` overrides rounding via tailwind-merge without disturbing the
 * colour token.
 */

const asSet = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const LAYOUT = ["flex", "items-center", "justify-center"] as const;

describe("iconTileClass() — layout ⊕ the chip token", () => {
  it("lg indigo = h-11 w-11 rounded-xl + pill('indigo')", () => {
    expect(asSet(iconTileClass("indigo", "lg"))).toEqual(
      new Set([...LAYOUT, "rounded-xl", "h-11", "w-11", ...asSet(pill("indigo"))]),
    );
  });

  it("md indigo = h-10 w-10 rounded-xl + pill('indigo')", () => {
    expect(asSet(iconTileClass("indigo", "md"))).toEqual(
      new Set([...LAYOUT, "rounded-xl", "h-10", "w-10", ...asSet(pill("indigo"))]),
    );
  });

  it("sm indigo = h-9 w-9 rounded-xl + pill('indigo')", () => {
    expect(asSet(iconTileClass("indigo", "sm"))).toEqual(
      new Set([...LAYOUT, "rounded-xl", "h-9", "w-9", ...asSet(pill("indigo"))]),
    );
  });

  it("xs amber = h-8 w-8 rounded-xl + pill('amber')", () => {
    expect(asSet(iconTileClass("amber", "xs"))).toEqual(
      new Set([...LAYOUT, "rounded-xl", "h-8", "w-8", ...asSet(pill("amber"))]),
    );
  });

  it("defaults to lg indigo", () => {
    expect(iconTileClass()).toBe(iconTileClass("indigo", "lg"));
  });

  it("className overrides rounding (rounded-lg wins) without touching colour", () => {
    const got = asSet(iconTileClass("fuchsia", "sm", "rounded-lg shrink-0"));
    expect(got).toEqual(
      new Set([
        "flex",
        "items-center",
        "justify-center",
        "rounded-lg",
        "shrink-0",
        "h-9",
        "w-9",
        ...asSet(pill("fuchsia")),
      ]),
    );
    expect(got.has("rounded-xl")).toBe(false);
  });
});

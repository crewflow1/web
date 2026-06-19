import { describe, it, expect } from "vitest";
import {
  ACCENT,
  ACCENTS,
  accent,
  pill,
  pillSoft,
  statusDot,
  type Accent,
} from "@/components/ui/tokens";

/**
 * Directive 007.6 — pixel-perfect guarantee for the unified token system.
 *
 * HQ is rooted in `.dark` (app/admin/layout.tsx), darkMode is "class"
 * (tailwind.config.ts). Every token is theme-aware (a light default + a `dark:`
 * override). These tests prove that, *under `.dark`*, each token renders
 * byte-identical to the legacy hand-spelled recipe the AI-platform surfaces
 * shipped with — so routing those surfaces through tokens cannot shift a pixel.
 *
 * `renderUnderDark` models the cascade: a `dark:`-prefixed colour utility wins
 * over its plain (light) counterpart because `.dark .x` out-specifies `.x`. A
 * light colour utility with NO dark counterpart would *leak* (paint in dark
 * mode); the test fails if any token leaks.
 */

const SHADE = /-(?:50|100|200|300|400|500|600|700|800|900|950)(?:\/\d{1,3})?$/;

function renderUnderDark(cls: string): { painted: string[]; leaks: string[] } {
  const toks = cls.split(/\s+/).filter(Boolean);
  const darkUtils = toks
    .filter((t) => t.startsWith("dark:"))
    .map((t) => t.slice("dark:".length));
  const darkProps = new Set(darkUtils.map((t) => t.replace(SHADE, "")));
  const painted = new Set<string>(darkUtils);
  const leaks: string[] = [];
  for (const t of toks) {
    if (t.startsWith("dark:")) continue;
    if (SHADE.test(t)) {
      // a light colour utility — overridden iff a dark util shares its property
      if (!darkProps.has(t.replace(SHADE, ""))) leaks.push(t);
    } else {
      painted.add(t); // structural util (ring-1, ring-inset, rounded, …)
    }
  }
  return { painted: [...painted].sort(), leaks };
}

function expectDarkRender(cls: string, oracle: string) {
  const { painted, leaks } = renderUnderDark(cls);
  expect(leaks).toEqual([]);
  expect(painted).toEqual(oracle.split(/\s+/).filter(Boolean).sort());
}

const solid = (c: string) =>
  `bg-${c}-500/15 text-${c}-300 ring-1 ring-inset ring-${c}-400/30`;
const soft = (c: string) =>
  `bg-${c}-500/10 text-${c}-300 ring-1 ring-inset ring-${c}-400/20`;

const HUES = [
  "indigo",
  "emerald",
  "amber",
  "orange",
  "sky",
  "violet",
  "cyan",
  "fuchsia",
  "rose",
  "red",
] as const satisfies readonly Accent[];

describe("design tokens — palette completeness", () => {
  it("ACCENTS lists every key in ACCENT, with no duplicates", () => {
    expect([...ACCENTS].sort()).toEqual(Object.keys(ACCENT).sort());
    expect(new Set(ACCENTS).size).toBe(ACCENTS.length);
  });

  it("carries the two hues the AI-platform surfaces need (red, orange)", () => {
    expect(ACCENTS).toContain("red");
    expect(ACCENTS).toContain("orange");
  });

  it("carries two distinct neutral states (Directive 007.6, Option A)", () => {
    expect(ACCENTS).toContain("neutral");
    expect(ACCENTS).toContain("muted");
    // They must NOT be the same swatch — that is the whole point of Option A.
    expect(accent("neutral").chip).not.toBe(accent("muted").chip);
  });

  it("accent() falls back to slate for null/undefined", () => {
    expect(accent(null)).toBe(ACCENT.slate);
    expect(accent(undefined)).toBe(ACCENT.slate);
  });
});

describe("pill() — solid status pill is pixel-identical under .dark", () => {
  for (const c of HUES) {
    it(`${c} → ${solid(c)}`, () => {
      expectDarkRender(pill(c), solid(c));
    });
  }

  it("neutral (active) → bg-slate-500/15 text-slate-300 ring-slate-400/30", () => {
    expectDarkRender(
      pill("neutral"),
      "bg-slate-500/15 text-slate-300 ring-1 ring-inset ring-slate-400/30",
    );
  });

  it("muted (disabled) → bg-slate-700/40 text-slate-400 ring-slate-600/40", () => {
    expectDarkRender(
      pill("muted"),
      "bg-slate-700/40 text-slate-400 ring-1 ring-inset ring-slate-600/40",
    );
  });
});

describe("pillSoft() — /10 fill /20 ring variant under .dark", () => {
  for (const c of HUES) {
    it(`${c} soft`, () => {
      expectDarkRender(pillSoft(c), soft(c));
    });
  }
});

describe("statusDot() — dot swatch under .dark matches legacy dots", () => {
  const cases: Array<[Accent, string]> = [
    ["emerald", "bg-emerald-400"], // working
    ["amber", "bg-amber-400"], // waiting_approval
    ["orange", "bg-orange-400"], // blocked
    ["red", "bg-red-400"], // error
    ["neutral", "bg-slate-400"], // idle
    ["muted", "bg-slate-600"], // disabled
  ];
  for (const [tone, oracle] of cases) {
    it(`${tone} → ${oracle}`, () => {
      expectDarkRender(statusDot(tone), oracle);
    });
  }
});

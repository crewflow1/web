import { describe, it, expect } from "vitest";
import colorsModule from "tailwindcss/colors";
import {
  TONE,
  TONES,
  tone,
  toneClass,
  type ToneVariant,
} from "@/components/ui/tokens";
import { badgeClass } from "@/components/ui/badge";

/**
 * Design-system tone tokens — the accessibility gate, not a snapshot.
 *
 * The point of this file is the contrast block below. Every tone/variant pair in
 * the token map is parsed back into the Tailwind hex values it names, and its
 * WCAG 2.1 contrast ratio is recomputed from those hexes on every run. A tone
 * that is retuned below AA fails the unit gate here rather than reaching a
 * browser, which is what makes ./tokens.ts safe to edit.
 *
 * This encodes a rule the codebase learned the hard way. Two idioms already had
 * to be swept out of the product for being sub-AA (`bg-slate-100
 * text-slate-500` at 4.34:1 and `text-slate-400` body text at 2.56:1 — see
 * e2e/contrast-sweep-a11y.spec.ts), and fleet's ui.tsx carries the note "Solid
 * tones, never opacity-*: the blended count fell below WCAG AA 4.5:1". The
 * `no opacity-blended fills` test below makes that rule mechanical: a blended
 * fill's real contrast depends on whatever is painted behind it, so it cannot be
 * verified from the class string alone — and anything this file cannot verify,
 * it rejects.
 */

// tailwindcss/colors ships CJS; interop hands back either shape depending on loader.
const colors = (colorsModule as unknown as { default?: Record<string, Record<string, string>> })
  .default ?? (colorsModule as unknown as Record<string, Record<string, string>>);

const WHITE = "#ffffff";
const AA_NORMAL_TEXT = 4.5;

/** sRGB → linear, per WCAG 2.1 relative-luminance. */
function channel(v8: number): number {
  const v = v8 / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = channel(Number.parseInt(h.slice(0, 2), 16));
  const g = channel(Number.parseInt(h.slice(2, 4), 16));
  const b = channel(Number.parseInt(h.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Resolve a Tailwind colour utility to its hex. Fails loudly rather than
 * defaulting — a token naming a colour this cannot resolve is a token whose
 * contrast was never actually checked, which is the failure mode being guarded.
 */
function hexFor(util: string): string {
  if (util === "text-white" || util === "bg-white") return WHITE;
  const m = /^(?:bg|text)-([a-z]+)-(\d{2,3})$/.exec(util);
  if (!m) throw new Error(`unresolvable colour utility: "${util}"`);
  const [, family, shade] = m;
  const hex = colors[family!]?.[shade!];
  if (typeof hex !== "string") {
    throw new Error(`"${util}" is not in the Tailwind palette`);
  }
  return hex;
}

/** Split a recipe like "bg-red-100 text-red-800" into its fill and its text. */
function parts(recipe: string): { bg: string; fg: string } {
  const utils = recipe.split(/\s+/).filter(Boolean);
  const bg = utils.find((u) => u.startsWith("bg-"));
  const fg = utils.find((u) => u.startsWith("text-"));
  if (!fg) throw new Error(`recipe has no text colour: "${recipe}"`);
  // A `value` recipe is text-only; it is painted on the white card.
  return { bg: bg ? hexFor(bg) : WHITE, fg: hexFor(fg) };
}

const FILLED_VARIANTS: ToneVariant[] = ["pill", "soft", "solid"];
const ALL_VARIANTS: ToneVariant[] = ["pill", "soft", "solid", "value"];

describe("tone tokens — WCAG AA contrast", () => {
  for (const t of TONES) {
    for (const variant of ALL_VARIANTS) {
      it(`${t}/${variant} meets AA (4.5:1) for normal text`, () => {
        const { bg, fg } = parts(TONE[t][variant]);
        const ratio = contrast(bg, fg);
        expect(
          ratio,
          `${t}/${variant} = "${TONE[t][variant]}" is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    }
  }

  it("resolves every colour it claims to check (no silently skipped token)", () => {
    // Guards the guard: if hexFor() ever soft-failed, the loop above would pass
    // vacuously. Prove the parser rejects a colour that is not in the palette.
    expect(() => hexFor("bg-notacolour-100")).toThrow();
    expect(() => hexFor("bg-red-1234")).toThrow();
    expect(hexFor("text-white")).toBe(WHITE);
    expect(hexFor("bg-red-100")).toBe(colors.red!["100"]);
  });

  it("computes the same ratio the contrast-sweep spec documents", () => {
    // e2e/contrast-sweep-a11y.spec.ts states bg-slate-100 + text-slate-500 is
    // 4.34:1. Reproducing that number proves this maths, and therefore every
    // assertion above, is calibrated against the project's own figures.
    const ratio = contrast(hexFor("bg-slate-100"), hexFor("text-slate-500"));
    expect(ratio).toBeCloseTo(4.34, 2);
    expect(ratio).toBeLessThan(AA_NORMAL_TEXT); // and it is correctly a failure
  });
});

describe("tone tokens — the rules the palette must obey", () => {
  it("uses solid fills only — no opacity-blended colour", () => {
    // A `/40` fill's contrast depends on its parent's background, so it cannot
    // be verified from the class string. Blended tones already caused a live AA
    // regression in fleet; the token layer is not allowed to reintroduce them.
    for (const t of TONES) {
      for (const variant of ALL_VARIANTS) {
        expect(TONE[t][variant], `${t}/${variant}`).not.toMatch(/\/\d/);
      }
    }
  });

  it("carries no dark: variant — the product renders light only", () => {
    // app/layout.tsx roots bg-white/text-slate-900 and `.dark` is applied
    // nowhere in app/. A dark half here could never activate.
    for (const t of TONES) {
      for (const variant of ALL_VARIANTS) {
        expect(TONE[t][variant], `${t}/${variant}`).not.toContain("dark:");
      }
    }
  });

  it("spells whole literal class strings so Tailwind's scanner sees them", () => {
    for (const t of TONES) {
      for (const variant of ALL_VARIANTS) {
        const recipe = TONE[t][variant];
        expect(recipe).not.toContain("${");
        expect(recipe.trim()).toBe(recipe);
      }
    }
  });

  it("gives every filled variant both a fill and a text colour", () => {
    for (const t of TONES) {
      for (const variant of FILLED_VARIANTS) {
        const utils = TONE[t][variant].split(/\s+/);
        expect(utils.some((u) => u.startsWith("bg-")), `${t}/${variant} fill`).toBe(true);
        expect(utils.some((u) => u.startsWith("text-")), `${t}/${variant} text`).toBe(true);
      }
    }
  });

  it("keeps `value` text-only — it is painted on the white card", () => {
    for (const t of TONES) {
      expect(TONE[t].value).not.toContain("bg-");
      expect(TONE[t].value.startsWith("text-")).toBe(true);
    }
  });

  it("exports TONES and TONE with identical key sets", () => {
    expect([...TONES].sort()).toEqual(Object.keys(TONE).sort());
  });

  it("keeps the slate neutral on the shipped -700/-900 pairing", () => {
    // 51 shipped pills use `bg-slate-100 text-slate-700`; the neutral must not
    // drift to -800 and make the most common pill in the product a shade darker.
    expect(TONE.slate.pill).toBe("bg-slate-100 text-slate-700");
    expect(TONE.slate.value).toBe("text-slate-900");
  });

  it("uses -700 for solid fills, where white text is AA for every tone", () => {
    // -600 would be prettier and would fail: emerald-600/white is 3.77:1 and
    // amber-600/white is 3.19:1. One safe rule, no per-tone exceptions.
    for (const t of TONES) {
      expect(TONE[t].solid, t).toMatch(/^bg-[a-z]+-700 text-white$/);
    }
  });
});

describe("tone() / toneClass()", () => {
  it("falls back to the inert neutral for null and undefined", () => {
    expect(tone(null)).toBe(TONE.slate);
    expect(tone(undefined)).toBe(TONE.slate);
    expect(toneClass(null)).toBe(TONE.slate.pill);
    expect(toneClass(undefined)).toBe(TONE.slate.pill);
  });

  it("defaults to the pill variant", () => {
    for (const t of TONES) {
      expect(toneClass(t)).toBe(TONE[t].pill);
    }
  });

  it("selects the requested variant", () => {
    expect(toneClass("blue", "soft")).toBe("bg-blue-50 text-blue-700");
    expect(toneClass("red", "solid")).toBe("bg-red-700 text-white");
    expect(toneClass("amber", "value")).toBe("text-amber-700");
  });

  it("returns the shipped recipes the product already renders", () => {
    // These four strings are what app/(app) hand-spells today (24, 43, 39 and
    // 16 times respectively). The tokens must reproduce them exactly, or
    // adopting the design system becomes a visual change.
    expect(toneClass("red")).toBe("bg-red-100 text-red-800");
    expect(toneClass("amber")).toBe("bg-amber-100 text-amber-800");
    expect(toneClass("emerald")).toBe("bg-emerald-100 text-emerald-800");
    expect(toneClass("blue", "soft")).toBe("bg-blue-50 text-blue-700");
  });
});

describe("badgeClass", () => {
  it("carries the dominant shipped pill geometry verbatim", () => {
    // 29 hand-rolled pills in app/(app) use exactly this geometry. A Badge that
    // rendered anything else would make every adoption a restyle.
    const cls = badgeClass("red");
    for (const util of ["rounded-full", "px-2", "py-0.5", "text-xs", "font-medium"]) {
      expect(cls).toContain(util);
    }
  });

  it("composes geometry with the tone recipe", () => {
    expect(badgeClass("red")).toContain("bg-red-100");
    expect(badgeClass("red")).toContain("text-red-800");
    expect(badgeClass("blue", "soft")).toContain("bg-blue-50");
    expect(badgeClass("red", "solid")).toContain("bg-red-700");
    expect(badgeClass("red", "solid")).toContain("text-white");
  });

  it("defaults to the neutral pill", () => {
    expect(badgeClass()).toContain("bg-slate-100");
    expect(badgeClass()).toContain("text-slate-700");
  });

  it("lets a caller override geometry via tailwind-merge, not the tone", () => {
    // cn() is tailwind-merge: a later `font-semibold` must REPLACE
    // `font-medium` rather than sit beside it and lose to source order.
    const cls = badgeClass("red", "pill", "font-semibold tabular-nums");
    expect(cls).toContain("font-semibold");
    expect(cls).not.toContain("font-medium");
    expect(cls).toContain("tabular-nums");
    // The tone survives the override.
    expect(cls).toContain("bg-red-100");
    expect(cls).toContain("text-red-800");
  });

  it("returns a trimmed single-line string", () => {
    const cls = badgeClass("amber", "pill");
    expect(cls).toBe(cls.trim());
    expect(cls.split("\n")).toHaveLength(1);
  });
});

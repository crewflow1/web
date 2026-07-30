import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Source pin — the recovered design-system primitives must stay ADOPTED.
 *
 * These primitives were recovered from a stranded branch. The failure mode that
 * justifies a test is specific: a primitive that nothing renders still has to be
 * reviewed, typechecked, kept AA-correct and kept in step with the shipped
 * idiom, while delivering nothing. That is worse than not having it. If the last
 * consumer of one of these is refactored away, this test fails and the primitive
 * gets deleted rather than quietly becoming decoration in components/ui.
 *
 * This is a SOURCE pin, not a render test — it greps the tree rather than
 * mounting anything, so it stays in the fast unit tier (node env, no DOM).
 */

const ROOT = resolve(__dirname, "../..");

/** Every .ts/.tsx file under app/ and components/, excluding the design system itself. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  walk(join(ROOT, "app"));
  walk(join(ROOT, "components"));
  // The primitives importing each other must not count as adoption.
  return out.filter((f) => !f.includes(join("components", "ui")));
}

const FILES = sourceFiles();

/**
 * A file's source with comment lines removed. These pins assert things about
 * CODE; the doc comments deliberately quote the very idioms being banned (the
 * `accent="text-amber-700"` this replaced, the `bg-x-500/15` it rejects), so
 * scanning raw source would fail on its own explanation.
 */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");
}

/** Files that import the named export from the design system, by any path form. */
function consumersOf(exportName: string): string[] {
  const pattern = new RegExp(
    // `import { …, Badge, … } from "@/components/ui"` — or from the module file,
    // or via a relative path (the app/(app) surfaces use the "@/" alias).
    `import\\s*\\{[^}]*\\b${exportName}\\b[^}]*\\}\\s*from\\s*["'][^"']*components/ui`,
  );
  return FILES.filter((f) => pattern.test(readFileSync(f, "utf8")));
}

/**
 * The recovered COMPONENTS. Each must be rendered by at least one surface
 * outside components/ui. The token module is deliberately NOT in this list:
 * nothing outside the design system imports `toneClass` directly, and nothing
 * should have to — tokens are reached transitively through these components,
 * which `tokens.ts is reached by the adopted components` below proves instead.
 */
const RECOVERED = ["Badge", "StatTile"] as const;

describe("recovered design-system primitives are adopted", () => {
  it("finds source files to scan (guards the guard)", () => {
    // If the walk silently returned nothing, every assertion below would pass
    // vacuously and the pin would be worthless.
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.some((f) => f.includes("operations"))).toBe(true);
  });

  for (const name of RECOVERED) {
    it(`${name} is imported by at least one real surface`, () => {
      const consumers = consumersOf(name);
      expect(
        consumers.length,
        `${name} has no consumer outside components/ui — either adopt it or delete it`,
      ).toBeGreaterThan(0);
    });
  }

  it("tokens.ts is reached by the adopted components", () => {
    // tokens.ts earns its place transitively: it has no surface consumer, so if
    // neither adopted component resolved its colour through it, the token map
    // would be dead weight however many tests it has.
    for (const f of ["badge.tsx", "stat-tile.tsx"]) {
      const code = codeOf(join(ROOT, "components", "ui", f));
      expect(code, `${f} does not resolve colour through ./tokens`).toMatch(
        /from "\.\/tokens"/,
      );
      // …and does not smuggle a TONE colour past it. Slate is excluded on
      // purpose: a component's own chrome is legitimately slate and identical
      // for every tone (`border-slate-200` on the card, `text-slate-500` on the
      // label). What must never appear is a tone-varying family spelled by
      // hand — that is a colour decision escaping the token map.
      expect(code, `${f} hand-spells a tone colour instead of using a tone`).not.toMatch(
        /\b(?:bg|text|ring|border)-(?:blue|emerald|amber|red|indigo)-\d{2,3}\b/,
      );
    }
  });

  it("keeps badge.tsx entirely free of colour literals", () => {
    // Badge is pure geometry + a resolved tone. Any colour literal at all would
    // mean one of its variants is no longer coming from the verified map.
    const code = codeOf(join(ROOT, "components", "ui", "badge.tsx"));
    expect(code).not.toMatch(/\b(?:bg|text|ring|border)-[a-z]+-\d{2,3}\b/);
  });

  it("leaves no hand-rolled pill in a surface that imports Badge", () => {
    // The whole point of Badge is that the pill is built once. A surface that
    // imports it and STILL spells the pill geometry by hand has half-adopted,
    // which is the state that lets the two drift apart. Matching the geometry
    // rather than the colour makes this order-independent: `bg-red-100 px-2 …
    // text-red-800` splits the fill and the text across the class list and
    // would slip past any adjacent-colour regex.
    for (const file of consumersOf("Badge")) {
      const src = readFileSync(file, "utf8");
      const handRolled = src.match(/rounded-full[^"'`]*px-2 py-0\.5/g);
      expect(
        handRolled,
        `${file} imports Badge but still hand-rolls a pill: ${handRolled?.join(", ")}`,
      ).toBeNull();
    }
  });

  it("leaves no raw value-accent string in a surface that imports StatTile", () => {
    // StatTile exists because fleet's `Stat` took `accent="text-amber-700"` — a
    // colour decision as an opaque string, unverifiable by any check. A consumer
    // must pass a `tone`, never a class.
    for (const file of consumersOf("StatTile")) {
      const src = readFileSync(file, "utf8");
      const raw = src.match(/accent=\{?["']text-/g);
      expect(raw, `${file} still passes a raw accent class`).toBeNull();
    }
  });
});

describe("the design system stays light-only and server-safe", () => {
  const UI_DIR = join(ROOT, "components", "ui");
  const uiFiles = readdirSync(UI_DIR).filter((f) => /\.tsx?$/.test(f));

  it("ships no dark: class (the product roots light; `.dark` is never applied)", () => {
    for (const f of uiFiles) {
      const src = readFileSync(join(UI_DIR, f), "utf8");
      // Prose may discuss the rule; only real class strings are the concern.
      const offending = src
        .split("\n")
        .filter((l) => l.includes("dark:") && !l.trimStart().startsWith("*"));
      expect(offending, `${f} contains dark: classes`).toEqual([]);
    }
  });

  it("keeps the recovered primitives free of client boundaries", () => {
    // Badge/StatTile/tokens are pure server components. A stray "use client"
    // would drag every consuming page's subtree into the client bundle.
    for (const f of ["tokens.ts", "badge.tsx", "stat-tile.tsx", "index.ts"]) {
      const src = readFileSync(join(UI_DIR, f), "utf8");
      expect(src, `${f} became a client component`).not.toContain('"use client"');
    }
  });

  it("does not depend on framer-motion", () => {
    // The stranded branch's primitives were motion-heavy. Nothing recovered
    // here animates, and a server component cannot import framer-motion.
    for (const f of uiFiles) {
      const src = readFileSync(join(UI_DIR, f), "utf8");
      expect(src, `${f} imports framer-motion`).not.toContain("framer-motion");
    }
  });
});

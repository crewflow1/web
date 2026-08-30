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
 *
 * `Table` and `Modal` were the two primitives the first recovery pass left on the
 * stranded branch, for exactly the reason this list exists: /operations had
 * neither a table nor a dialog, and an unadopted primitive is debt. They are here
 * now because they have real consumers — /sites and /staff respectively.
 * `THead`/`TBody`/`TR`/`TH`/`TD` are not listed separately: they are unusable
 * without `Table`, so pinning the entry point pins the set.
 */
const RECOVERED = ["Badge", "StatTile", "Table", "Modal"] as const;

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

  /**
   * modal.tsx and data-table.tsx are the TWO client modules here, and both
   * have to be: a focus trap / scroll lock / Escape handling, and the
   * DataTable's sorting, filtering, selection, roving row focus and column
   * resizing, are browser behaviours. (data-table-core.ts deliberately stays a
   * pure server-safe module so the logic ships no client boundary.) Everything
   * else must stay server-side — a stray "use client" would drag every
   * consuming page's subtree into the client bundle. Neither client module is
   * re-exported from the barrel; DataTable's own test
   * (__tests__/ui/data-table.test.ts) pins that, mirroring the Modal pin below.
   */
  const CLIENT_MODULES = ["modal.tsx", "data-table.tsx"];

  it("keeps every primitive except Modal free of client boundaries", () => {
    for (const f of uiFiles.filter((f) => !CLIENT_MODULES.includes(f))) {
      const src = readFileSync(join(UI_DIR, f), "utf8");
      expect(src, `${f} became a client component`).not.toContain('"use client"');
    }
  });

  it("keeps Modal out of the barrel, because the barrel is imported by server pages", () => {
    // MEASURED, not precautionary. With `export { Modal } from "./modal"` in
    // index.ts, `next build` put /operations — a page that renders no dialog and
    // imports only { Badge, StatTile } — at 1.52 kB / 179 kB first load, against
    // 498 B / 171 kB on origin/main. Barrel-tracing pulled the client boundary
    // into every consumer. Removing the re-export returned it to 498 B / 171 kB.
    // Modal is imported from "@/components/ui/modal" instead.
    const barrel = codeOf(join(UI_DIR, "index.ts"));
    expect(barrel, "index.ts re-exports the client Modal").not.toMatch(
      /export\s*\{[^}]*\bModal\b[^}]*\}\s*from/,
    );
    expect(barrel, "index.ts re-exports from ./modal").not.toMatch(/from\s*["']\.\/modal["']/);
    // …and the surfaces that use it reach it directly.
    for (const file of consumersOf("Modal")) {
      const src = readFileSync(file, "utf8");
      expect(src, `${file} should import Modal from its own module`).toMatch(
        /from ["']@\/components\/ui\/modal["']/,
      );
    }
  });

  it("does not depend on framer-motion", () => {
    /**
     * framer-motion IS a dependency (^12.40.0) and the stranded branch's modal
     * was built on it, but it has zero consumers in app/(app) — all six live in
     * app/_marketing and app/admin. Eight of the nine hand-rolled dialogs ship no
     * entrance animation at all, so the primitive's 150ms scale-and-fade comes
     * from tailwindcss-animate (already installed, already registered) for zero
     * client JS. Comment lines are stripped because the modules deliberately
     * explain the decision in prose.
     */
    for (const f of uiFiles) {
      expect(codeOf(join(UI_DIR, f)), `${f} imports framer-motion`).not.toContain(
        "framer-motion",
      );
    }
  });

  it("keeps tailwind-merge out of the client primitive", () => {
    // `cn` is tailwind-merge. In a SERVER primitive it is free — it runs at render
    // time and ships nothing. In a CLIENT one it is 8 kB of first-load JS: with
    // `import { cn } from "@/lib/utils"` in modal.tsx, `next build` put /staff at
    // 196 kB against 188 kB on origin/main, and the extra chunk was
    // tailwind-merge's conflict tables. Modal has two constant class strings and
    // no `className` prop, so there is nothing to merge and nothing to buy.
    for (const f of CLIENT_MODULES) {
      const code = codeOf(join(UI_DIR, f));
      expect(code, `${f} pulls tailwind-merge into the client bundle`).not.toMatch(
        /from ["']@\/lib\/utils["']/,
      );
      expect(code, `${f} calls cn()`).not.toMatch(/\bcn\(/);
    }
  });

  it("keeps the modal entrance finite and unfilled, so axe gates cannot hang", () => {
    // e2e/_settle.ts gates every axe scan on `document.getAnimations().length === 0`.
    // `animate-in` sets only `animation-name`, so a finished animation stops being
    // in-effect and drains from that list. `fill-mode-*` (or an infinite
    // `animate-pulse`/`animate-spin`) would keep it in effect and hang every
    // scanned route, forever.
    const code = codeOf(join(UI_DIR, "modal.tsx"));
    expect(code, "modal.tsx fills its entrance animation").not.toMatch(/fill-mode-/);
    expect(code, "modal.tsx uses an infinite animation").not.toMatch(
      /animate-(?:pulse|spin|ping|bounce)/,
    );
    // The reduced-motion escape hatch is CSS, not a framer-motion hook.
    expect(code, "modal.tsx does not honour prefers-reduced-motion").toContain(
      "motion-reduce:animate-none",
    );
  });
});

describe("the table and modal primitives own only slate chrome", () => {
  const UI_DIR = join(ROOT, "components", "ui");

  it("spells no tone-varying colour by hand", () => {
    // Neither takes a `tone`, and neither should: a table cell's and a dialog
    // shell's colour is slate chrome, identical whatever the row or dialog means.
    // A cell or dialog that must carry status renders a <Badge> inside it, where
    // the tone is AA-verified by tokens.test.ts. A blue/emerald/amber/red/indigo
    // literal appearing here is a colour decision escaping the token map.
    for (const f of ["table.tsx", "modal.tsx"]) {
      expect(codeOf(join(UI_DIR, f)), `${f} hand-spells a tone colour`).not.toMatch(
        /\b(?:bg|text|ring|border|divide)-(?:blue|emerald|amber|red|indigo)-\d{2,3}\b/,
      );
    }
  });

  it("leaves no hand-rolled table chrome in a surface that imports Table", () => {
    // Half-adoption is the state that lets the primitive and the surface drift.
    // A surface using <Table> must not also spell a <table>/<thead>/<tbody> class
    // list of its own.
    for (const file of consumersOf("Table")) {
      const handRolled = codeOf(file).match(/<(?:table|thead|tbody)\s+className=/g);
      expect(
        handRolled,
        `${file} imports Table but still hand-rolls table chrome: ${handRolled?.join(", ")}`,
      ).toBeNull();
    }
  });

  it("leaves no hand-rolled dialog in a surface that imports Modal", () => {
    // The whole point of Modal is that role="dialog" + aria-modal + the focus
    // trap exist once. A surface that imports it and still writes its own
    // role="dialog" has kept a second, untrapped dialog alive.
    for (const file of consumersOf("Modal")) {
      // Comment-stripped: _invite-modal.tsx's header explains the very defect it
      // no longer has ("role=\"dialog\" sat on the full-viewport backdrop").
      const handRolled = codeOf(file).match(/role="dialog"|aria-modal=/g);
      expect(
        handRolled,
        `${file} imports Modal but still hand-rolls a dialog: ${handRolled?.join(", ")}`,
      ).toBeNull();
    }
  });

  it("requires an accessible name on every Modal call site", () => {
    // `labelledBy` is a required prop precisely so a dialog cannot ship nameless,
    // but a required prop can still be passed an id that does not exist. This
    // catches the omission; e2e/staff-invite-dialog-a11y.spec.ts resolves the id
    // in a real browser and fails if it dangles.
    for (const file of consumersOf("Modal")) {
      const src = readFileSync(file, "utf8");
      expect(src, `${file} renders a Modal without labelledBy`).toMatch(/labelledBy=/);
    }
  });
});

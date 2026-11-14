import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every static "computed from" link an intelligence module hands the UI must
 * point at a page that exists.
 *
 * Found by the UI control inventory (docs/programme/ui-coverage/): the labour
 * forecast on /insights linked its sources to `/rota` and `/team` — neither is
 * a route (the pages live at /staff/rota and /staff), so both links 404'd.
 * These hrefs are plain string literals in lib/intelligence, invisible to the
 * type checker, so this test resolves each one against the app directory.
 */
const ROOT = process.cwd();
const DIR = join(ROOT, "lib", "intelligence");

function pageExists(href: string): boolean {
  const path = href.split(/[?#]/)[0]!.replace(/^\//, "");
  return [join(ROOT, "app", "(app)", path, "page.tsx"), join(ROOT, "app", path, "page.tsx")].some(existsSync);
}

describe("intelligence provenance links resolve to real pages", () => {
  const links: { file: string; href: string }[] = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(DIR, file), "utf8");
    for (const m of src.matchAll(/href:\s*"(\/[^"$]*)"/g)) links.push({ file, href: m[1]! });
  }

  it("finds the static links it is meant to guard", () => {
    expect(links.length).toBeGreaterThan(0);
    expect(links.map((l) => l.href)).toContain("/staff/rota");
  });

  it("has no link to a route that does not exist", () => {
    expect(links.filter((l) => !pageExists(l.href)).map((l) => `${l.file}: ${l.href}`)).toEqual([]);
  });
});

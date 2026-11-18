import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Every HQ page enforces the superadmin gate ITSELF.
 *
 * A layout's gate is not a substitute for a page-level check (layouts and pages
 * render independently in the App Router). The boundary is the page, so each
 * app/admin page must call requireHqPage() before any data-loading await
 * (awaiting its own params/searchParams first is fine — that loads nothing).
 */

const ADMIN = join(__dirname, "..", "..", "app", "admin");

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? pages(p) : e === "page.tsx" ? [p] : [];
  });
}

function defaultExportBody(src: string): string | null {
  const m = /export default (?:async )?function \w*\s*\(/.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  for (let depth = 1; depth > 0; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") depth--;
  }
  return src.slice(src.indexOf("{", i));
}

const ALLOWED_BEFORE_GATE = /^await\s+(?:props\.)?(?:params|searchParams)\b/;

describe("HQ pages enforce the superadmin gate at page level", () => {
  const all = pages(ADMIN);

  it("finds the HQ pages (sanity)", () => {
    expect(all.length).toBeGreaterThan(70);
  });

  it("every app/admin page calls requireHqPage() before loading any data", () => {
    const offenders: string[] = [];
    for (const file of all) {
      const rel = relative(ADMIN, file);
      const body = defaultExportBody(readFileSync(file, "utf8"));
      if (!body) {
        offenders.push(`${rel} (no default export function)`);
        continue;
      }
      const gate = body.indexOf("requireHqPage(");
      if (gate < 0) {
        offenders.push(`${rel} (no requireHqPage)`);
        continue;
      }
      const before = [...body.slice(0, gate).matchAll(/await\s+[\w.]+/g)].map((a) => a[0]);
      const early = before.filter((a) => !ALLOWED_BEFORE_GATE.test(a));
      if (early.length) offenders.push(`${rel} (awaits ${early.join(", ")} before the gate)`);
    }
    expect(offenders).toEqual([]);
  });
});

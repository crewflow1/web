import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";

/**
 * Segment gates are enforced by every page, not only by the layout.
 *
 * A layout's gate is not a substitute for a page-level check (layouts and pages
 * render independently in the App Router). So every page under a gated (app)
 * layout must itself call each ancestor layout's gate, before any data-loading
 * await.
 */

const APP = join(__dirname, "..", "..", "app", "(app)");
const GATE = /await ((?:requireCapability|requireAnyCapability|requireManagementContext)\([^;]*\))/g;
// Awaits that load no company data: route params, the locale, and the guards themselves.
const ALLOWED_BEFORE_GATE = /^await\s+((?:props\.)?(?:params|searchParams)\b|getRequestI18n\b|require(?:Capability|AnyCapability|ManagementContext|OrgContext)\b)/;

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? pages(p) : e === "page.tsx" ? [p] : [];
  });
}

function ancestorGates(pageDir: string): string[] {
  const out: string[] = [];
  for (let d = pageDir; d.startsWith(APP); d = dirname(d)) {
    const layout = join(d, "layout.tsx");
    if (existsSync(layout)) out.unshift(...[...readFileSync(layout, "utf8").matchAll(GATE)].map((m) => m[1]!));
    if (d === APP) break;
  }
  return out;
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

describe("(app) pages enforce their segment gates themselves", () => {
  const gated = pages(APP)
    .map((f) => ({ f, gates: ancestorGates(dirname(f)) }))
    .filter((p) => p.gates.length > 0);

  it("finds the gated pages (sanity)", () => {
    expect(gated.length).toBeGreaterThan(100);
  });

  it("every page under a gated layout calls each ancestor gate before loading data", () => {
    const offenders: string[] = [];
    for (const { f, gates } of gated) {
      const rel = relative(APP, f);
      const body = defaultExportBody(readFileSync(f, "utf8"));
      if (!body) {
        offenders.push(`${rel} (no default export function)`);
        continue;
      }
      for (const g of gates) {
        const at = body.indexOf(g);
        if (at < 0) {
          offenders.push(`${rel} (missing ${g})`);
          continue;
        }
        const early = [...body.slice(0, at).matchAll(/await\s+[\w.]+/g)].map((a) => a[0]).filter((a) => !ALLOWED_BEFORE_GATE.test(a));
        if (early.length) offenders.push(`${rel} (awaits ${early.join(", ")} before ${g})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

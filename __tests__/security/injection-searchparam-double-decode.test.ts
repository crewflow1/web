import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * INJ-10 — reflected-input crash: double-decoding a search param.
 *
 * Next.js hands a page its `searchParams` ALREADY percent-decoded. 53 pages then
 * ran `decodeURIComponent(sp.error)` on the decoded value. That second decode is
 * a no-op for most text and a `URIError: URI malformed` for any value containing
 * a literal `%` — so:
 *   • `/login?error=%25` (an attacker-supplied link) rendered a 500 instead of
 *     the login page, and
 *   • any LEGITIMATE server message containing a percent sign ("VAT must be
 *     ≤ 100%") crashed the page that was meant to display it.
 * The value is rendered as React text (escaped), so there was never an XSS —
 * the defect is the crash. The redundant decode is removed everywhere.
 */

/** Files that decode a dynamic PATH segment (not a search param). */
const PATH_SEGMENT_DECODERS = new Set([
  "app/admin/imports/[id]/page.tsx",
  "app/api/jobs/[id]/photos/[path]/route.ts",
]);

describe("search params are never decoded a second time", () => {
  it("the platform fact: a decoded value containing % cannot be decoded again", () => {
    const decodedOnce = new URLSearchParams("error=VAT%20must%20be%20%E2%89%A4%20100%25").get("error");
    expect(decodedOnce).toBe("VAT must be ≤ 100%");
    expect(() => decodeURIComponent(decodedOnce!)).toThrow(URIError);
    expect(() => decodeURIComponent(new URLSearchParams("error=%25").get("error")!)).toThrow(URIError);
  });

  it("no page/component under app/ calls decodeURIComponent on a searchParams value", () => {
    const ROOT = resolve(__dirname, "..", "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name)) {
          const src = readFileSync(p, "utf8");
          src.split("\n").forEach((line, i) => {
            // ANY decodeURIComponent in a page/component is suspect: the value
            // is a search param however it was destructured (`error`, `saved`,
            // `raw`…). The two allow-listed files decode a PATH segment.
            if (/decodeURIComponent\(/.test(line) && !PATH_SEGMENT_DECODERS.has(p.replace(ROOT + "/", ""))) {
              offenders.push(`${p.replace(ROOT + "/", "")}:${i + 1}`);
            }
          });
        }
      }
    };
    walk(join(ROOT, "app"));
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

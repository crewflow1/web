/**
 * PD-4 source guard: every server path that writes user-supplied bytes to
 * Supabase Storage must route them through lib/uploads/strip-image-metadata
 * (or be explicitly exempt with a reason). A NEW `.upload(` call site fails this
 * test until it is either wired to the helper or added to EXEMPT below.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SCAN = ["app", "lib", "server", "components"];
const HELPER = "strip-image-metadata";

/** Files that call storage `.upload(` but never store user-supplied image bytes. */
const EXEMPT: Record<string, string> = {};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e === "__tests__") continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\./.test(e)) out.push(p);
  }
  return out;
}

const uploaders = SCAN.flatMap((d) => walk(join(ROOT, d)))
  .filter((f) => /\.upload\(/.test(readFileSync(f, "utf8")))
  .map((f) => relative(ROOT, f))
  .sort();

describe("image uploads strip metadata (PD-4)", () => {
  it("finds the known upload paths", () => {
    expect(uploaders.length).toBeGreaterThanOrEqual(15);
  });

  it.each(uploaders)("%s uses the stripping helper", (file) => {
    if (EXEMPT[file]) return;
    const src = readFileSync(join(ROOT, file), "utf8");
    expect(src).toContain(HELPER);
    // helper must run BEFORE the first storage upload in the file
    const iHelper = src.indexOf("cleanUploadBytes(");
    const iUpload = src.search(/\.upload\(/);
    expect(iHelper).toBeGreaterThan(-1);
    expect(iHelper).toBeLessThan(iUpload);
  });

  it("every stripped path also reads the stripped value, not the raw File bytes", () => {
    for (const f of uploaders) {
      const src = readFileSync(join(ROOT, f), "utf8");
      // raw `.arrayBuffer()` handed straight to an upload is the bug being prevented
      expect(src).not.toMatch(/\.upload\([^)]*await \w+\.arrayBuffer\(\)/s);
    }
  });
});

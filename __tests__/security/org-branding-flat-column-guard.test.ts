import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * ORG-BRANDING FLAT-ADDRESS-COLUMN GUARD (repo-wide).
 *
 * WHY: `organizations` has ONE jsonb `address` blob ({ line1?, city?, postcode? })
 * and NO flat address columns (see lib/supabase/types.ts — the Row has `address:
 * Json`, `logo_path`, `logo_url`, `name`, `phone`, `vat_number`, but no
 * address_line1/address_line2/city/county/postcode). A select of those flat names
 * FROM organizations therefore asks PostgREST for columns that do not exist:
 * `SELECT address_line1 FROM organizations` → 42703 → HTTP 400. When the read
 * error is unbound the row degrades to `{}` and the letterhead renders with a
 * BLANK contractor address and NO logo — on a live, customer-facing, contractual
 * completion/warranty certificate PDF.
 *
 * This is exactly the defect both completion-certificate PDF routes shipped:
 *   - app/customer-portal/[token]/certificates/[id]/pdf/route.tsx
 *   - app/api/completion-certificates/[id]/pdf/route.tsx
 * The correct pattern is the sibling bulk render (lib/customers/portal-bulk-download.ts
 * renderCertificate): derive the address lines from the jsonb blob.
 *
 * RULE: a `.from("organizations")` select MUST NOT name any flat address column.
 * The scan is scoped to the organizations select ONLY — jobs/customers genuinely
 * DO have flat address columns (site_address_line1…, address_line1…), so their
 * selects are never inspected; this keeps the guard from false-positiving the
 * legitimate flat-column reads elsewhere in these very routes.
 */

const ROOT = resolve(__dirname, "..", "..");
const SCAN_DIRS = ["app", "server", "lib"];

// Flat address columns that exist on jobs/customers but NOT on organizations.
const FLAT_ORG_ADDRESS_COLS = [
  "address_line1",
  "address_line2",
  "city",
  "county",
  "postcode",
];

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !p.includes("__tests__")) {
      out.push(p);
    }
  }
}

function stripComments(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
  return out;
}

/**
 * Every organizations-select that names a flat address column in one file's
 * source. Covers the plain `.from("organizations")` form and the
 * `.from("organizations" as never|any)` cast idiom. For each match we look at the
 * region up to the first `.select("…")` and inspect ONLY that select's string
 * argument — so a flat column read from jobs/customers in the same file is never
 * flagged.
 */
function orgFlatColumnOffenders(rel: string, raw: string): string[] {
  if (!raw.includes("organizations")) return [];
  const src = stripComments(raw);
  const offenders: string[] = [];
  const fromRe = /\.from\(\s*["'`]organizations["'`]\s*(?:as\s+(?:never|any)\s*)?\)/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(src))) {
    // Window wide enough to clear an inline type-cast between .from and .select.
    const region = src.slice(m.index, m.index + 600);
    const sel = /\.select\(\s*(["'`])([\s\S]*?)\1/.exec(region);
    if (!sel || !sel[2]) continue;
    const selectArg = sel[2];
    const hit = FLAT_ORG_ADDRESS_COLS.filter((c) => new RegExp(`\\b${c}\\b`).test(selectArg));
    if (hit.length) {
      const line = src.slice(0, m.index).split("\n").length;
      offenders.push(
        `${rel}:${line} → organizations select reads flat address column(s) that do not ` +
          `exist on the table (jsonb 'address' only): ${hit.join(", ")}`,
      );
    }
  }
  return offenders;
}

describe("org-branding flat-address-column guard — organizations has jsonb address only", () => {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(resolve(ROOT, d), files);

  it("scans a non-trivial number of source files", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("no source selects flat address columns FROM organizations (jsonb address only)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1);
      offenders.push(...orgFlatColumnOffenders(rel, readFileSync(file, "utf8")));
    }
    expect(
      offenders,
      `organizations has NO flat address columns — a select of address_line1/` +
        `address_line2/city/county/postcode FROM organizations errors 42703 (HTTP 400) ` +
        `and renders a blank letterhead. Derive the address from the jsonb 'address' ` +
        `blob instead (see lib/customers/portal-bulk-download.ts renderCertificate):\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("has TEETH: flags the pre-fix cert-PDF org selects (both routes)", () => {
    // The exact flat-column select both PDF routes shipped, in both the cast form
    // (customer-portal route) and the plain typed form (operator api route).
    const castForm = [
      `const { data: org } = await (`,
      `  admin.from("organizations") as unknown as {`,
      `    select: (c: string) => { eq: (k, v) => { maybeSingle: () => Promise<{ data: Record<string, string | null> | null }> } };`,
      `  }`,
      `)`,
      `  .select("name, logo_url, address_line1, address_line2, city, county, postcode")`,
      `  .eq("id", loaded.org.id)`,
      `  .maybeSingle();`,
    ].join("\n");
    const castFlagged = orgFlatColumnOffenders(
      "app/customer-portal/[token]/certificates/[id]/pdf/route.tsx",
      castForm,
    );
    expect(castFlagged.length).toBeGreaterThan(0);
    expect(castFlagged.some((o) => o.includes("address_line1"))).toBe(true);

    const plainForm = [
      `const { data: org } = await supabase`,
      `  .from("organizations")`,
      `  .select("name, logo_url, address_line1, address_line2, city, county, postcode")`,
      `  .eq("id", ctx.org.id)`,
      `  .maybeSingle();`,
    ].join("\n");
    const plainFlagged = orgFlatColumnOffenders(
      "app/api/completion-certificates/[id]/pdf/route.tsx",
      plainForm,
    );
    expect(plainFlagged.length).toBeGreaterThan(0);
    expect(plainFlagged.some((o) => o.includes("postcode"))).toBe(true);
  });

  it("does not flag the jsonb-address fix (name, logo_url, logo_path, address)", () => {
    const fixed = [
      `const { data: org, error: orgError } = await supabase`,
      `  .from("organizations")`,
      `  .select("name, logo_url, logo_path, address")`,
      `  .eq("id", ctx.org.id)`,
      `  .maybeSingle();`,
    ].join("\n");
    expect(
      orgFlatColumnOffenders("app/api/completion-certificates/[id]/pdf/route.tsx", fixed),
    ).toEqual([]);
  });

  it("does not flag legitimate flat-column reads on jobs / customers", () => {
    // These tables DO have flat address columns; only organizations selects are
    // in scope, so a jobs/customers select must never be flagged.
    const jobsAndCustomers = [
      `const { data: job } = await supabase`,
      `  .from("jobs")`,
      `  .select("id, site_address_line1, site_address_line2, site_city, site_county, site_postcode, customer:customers ( name, address_line1, address_line2, city, county, postcode )")`,
      `  .eq("id", cert.job_id)`,
      `  .maybeSingle();`,
    ].join("\n");
    expect(
      orgFlatColumnOffenders("app/api/completion-certificates/[id]/pdf/route.tsx", jobsAndCustomers),
    ).toEqual([]);
  });
});

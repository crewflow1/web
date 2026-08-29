import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PRIMARY_NAV,
  UTILITY_NAV,
  navForRole,
} from "@/app/(app)/_nav/nav-model";

/**
 * SECURITY — the global search role boundary for the "everything searchable"
 * completion families.
 *
 * The Cmd/K route (app/api/search/route.ts) must never surface a
 * Sales/Money/Operations/People-admin entity to a `staff` member — the same
 * boundary the nav model + page/API guards enforce. These are source-contract
 * proofs (CI has no database): the MANAGEMENT_ONLY_SEARCH_TYPES set contents,
 * the per-family org pin + row bound, the money-safety of the Costs family,
 * the sanitize-before-ilike pipeline, and — crucially — that the search role
 * classification MATCHES the nav model, imported live, so nav drift breaks
 * this test rather than silently forking the boundary.
 */

const ROOT = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf-8");
/** Strip block+line comments so prose can't satisfy a code assertion. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const src = codeOf(read("app/api/search/route.ts"));

/** Entries of the MANAGEMENT_ONLY_SEARCH_TYPES set literal. */
function managementOnlySet(code: string): Set<string> {
  const m = /MANAGEMENT_ONLY_SEARCH_TYPES\s*=\s*new Set<[^>]+>\(\[([\s\S]*?)\]\)/.exec(
    code,
  );
  expect(m, "MANAGEMENT_ONLY_SEARCH_TYPES set literal present").toBeTruthy();
  return new Set([...m![1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!));
}

/** Every `type: "..."` literal pushed onto the hits array (incl. ternaries). */
function emittedTypes(code: string): Set<string> {
  const out = new Set<string>();
  for (const m of code.matchAll(/\btype:\s*"([a-z_]+)"/g)) out.add(m[1]!);
  for (const m of code.matchAll(/\btype:\s*\w+\s*\?\s*"([a-z_]+)"\s*:\s*"([a-z_]+)"/g)) {
    out.add(m[1]!);
    out.add(m[2]!);
  }
  return out;
}

const MGMT = managementOnlySet(src);

// ── (b) The role boundary set — exact contents ──────────────────────────────

describe("MANAGEMENT_ONLY_SEARCH_TYPES — exact contents", () => {
  it("gates every financial/sales/operations family (new ones included)", () => {
    for (const t of [
      // pre-existing Sales/Money set
      "customer",
      "quote",
      "invoice",
      "lead",
      "purchase_order",
      // completion families that are admin-only in the nav model
      "supplier", // Operations → Suppliers (ADMIN_ROLES)
      "finance", // Money → Costs (ADMIN_ROLES)
      "asset", // Operations → Assets (ADMIN_ROLES)
      "vehicle", // Operations → Fleet (ADMIN_ROLES)
      "staff_qualification", // People → Staff /staff/[id] (ADMIN_ROLES)
    ]) {
      expect(MGMT.has(t), `${t} must be management-only`).toBe(true);
    }
  });

  it("keeps the member-visible field families OUT of the gate", () => {
    for (const t of [
      "job",
      "staff",
      "risk_assessment",
      "permit",
      "job_document",
      "snag",
      "site_report",
      "blueprint", // Site & safety → Drawings (ALL_ROLES)
      "toolbox_talk", // Site & safety → Toolbox talks (ALL_ROLES)
      "diary_entry", // Site & safety → Site diary (ALL_ROLES)
      "support_ticket", // Help → Support (ALL_ROLES)
      "attachment", // job-targeted files; jobs are ALL_ROLES
    ]) {
      expect(MGMT.has(t), `${t} must stay member-visible`).toBe(false);
    }
  });

  it("every gated type is one the route actually emits (no dead entries)", () => {
    const emitted = emittedTypes(src);
    for (const t of MGMT) {
      expect(emitted.has(t), `gated type ${t} is emitted`).toBe(true);
    }
  });

  it("the role filter is applied at every return of merged hits", () => {
    expect(src).toMatch(/roleVisible\s*=/);
    // Every respond.json({ hits: ... }) that carries accumulated hits goes
    // through roleVisible (the two early empty-term returns carry a fresh
    // empty literal, which is fine).
    const merged = [...src.matchAll(/respond\.json\(\{ hits: ([^}]+) \}\)/g)].map(
      (m) => m[1]!,
    );
    for (const expr of merged) {
      if (expr.includes("satisfies Hit[]")) continue; // empty-term literals
      expect(expr, `merged return "${expr}" must be role-filtered`).toContain(
        "roleVisible(",
      );
    }
  });
});

// ── The search classification MATCHES the nav model (imported live) ─────────

describe("search role boundary matches the nav model exactly", () => {
  /** hrefs a staff member can reach, per the live nav model. An area HEADER
   * lands on its first role-visible child (areaLandingHref), never on the
   * area's own href — e.g. People's "/staff" roster stays admin-only even
   * though a staff member sees the People area — so only child hrefs count,
   * plus the area href itself for childless areas (Home / My day). */
  const staffHrefs = new Set<string>();
  // navForRole(role, flags, nav) — flags stay [] here: none of the searched
  // families is flag-gated (only Marketplace is), so [] keeps this role-pure.
  for (const area of [
    ...navForRole("staff", [], PRIMARY_NAV),
    ...navForRole("staff", [], UTILITY_NAV),
  ]) {
    if (area.children.length === 0) staffHrefs.add(area.href);
    for (const c of area.children) staffHrefs.add(c.href);
  }

  /** Search family → the nav destination its hits open under. */
  const FAMILY_NAV_HOME: Record<string, string> = {
    supplier: "/suppliers",
    finance: "/finances",
    asset: "/assets",
    vehicle: "/fleet",
    staff_qualification: "/staff",
    purchase_order: "/purchase-orders",
    blueprint: "/blueprints",
    toolbox_talk: "/toolbox",
    diary_entry: "/diary",
    support_ticket: "/support",
    snag: "/snags",
  };

  for (const [family, href] of Object.entries(FAMILY_NAV_HOME)) {
    it(`${family} (${href}): staff nav visibility ⇔ staff search visibility`, () => {
      const staffCanNavigate = staffHrefs.has(href);
      const staffCanSearch = !MGMT.has(family);
      expect(
        staffCanSearch,
        `${family}: nav says staff ${staffCanNavigate ? "CAN" : "CANNOT"} reach ${href}, search must agree`,
      ).toBe(staffCanNavigate);
    });
  }
});

// ── (a) Each new family is read + linked correctly ──────────────────────────

describe("completion families — tables read, org-pinned, bounded, hrefs correct", () => {
  const NEW_TABLES = [
    "suppliers",
    "assets",
    "fleet_vehicles",
    "support_tickets",
    "staff_qualifications",
    "tenant_attachments",
    "finances",
    "blueprints",
    "toolbox_talks",
    "site_diary_entries",
  ];

  for (const t of NEW_TABLES) {
    it(`${t}: pinned to the active org AND bounded in the same read`, () => {
      const re = new RegExp(
        `\\.from\\("${t}"\\)[\\s\\S]{0,400}?\\.eq\\(\\s*"org_id",\\s*ctx\\.org\\.id\\s*\\)[\\s\\S]{0,300}?\\.limit\\((PER_TYPE|CHAIN_LIMIT)\\)`,
      );
      expect(re.test(src), `${t} read is org-pinned + bounded`).toBe(true);
    });
  }

  it("attachments are pinned to JOB targets only (no management-surface leak)", () => {
    expect(src).toMatch(
      /\.from\("tenant_attachments"\)[\s\S]{0,300}?\.eq\("target_table", "jobs"\)/,
    );
  });

  it("each family links to its correct destination", () => {
    expect(src).toContain("href: `/suppliers/${s.id}`");
    expect(src).toContain('href: "/finances"'); // register — no detail route
    expect(src).toContain("href: `/jobs/${b.job_id}/blueprints`");
    expect(src).toContain("`/assets/${a.id}`");
    expect(src).toContain("`/fleet/vehicles/${a.id}`");
    expect(src).toContain("href: `/toolbox/${tt.id}`");
    expect(src).toContain("href: `/diary/${de.id}`");
    expect(src).toContain("href: `/support/${t.id}`");
    expect(src).toContain("href: `/staff/${ql.user_id}`");
    expect(src).toContain("href: `/jobs/${a.target_id}`"); // attachment → parent job
  });

  it("a failed read in ANY wave is LOUD (500), never a silent empty domain", () => {
    for (const res of [
      "suppliersRes",
      "assetsRes",
      "ticketsRes",
      "qualificationsRes",
      "attachmentsRes",
      "vehicleProfilesRes",
      "financesRes",
      "blueprintsRes",
      "toolboxRes",
      "diaryRes",
    ]) {
      expect(src, `${res}.error feeds a wave error check`).toContain(`${res}.error`);
    }
    expect(src).toMatch(/query_failed/);
  });
});

// ── Money-safety: the Costs family carries no amounts ────────────────────────

describe("finance hits — money-safety", () => {
  it("the finances SELECT never touches a money column", () => {
    const m = /\.from\("finances"\)\s*\.select\("([^"]+)"\)/.exec(src);
    expect(m, "finances select present").toBeTruthy();
    const cols = m![1]!.split(",").map((c) => c.trim());
    for (const banned of ["amount", "vat_total", "vat_rate", "total", "currency"]) {
      expect(cols, `finances select must not include ${banned}`).not.toContain(
        banned,
      );
    }
    expect(cols).toEqual(
      expect.arrayContaining(["id", "category", "notes", "created_at"]),
    );
  });

  it("no £-formatting anywhere near the finance hit emission", () => {
    const emit = /type: "finance",[\s\S]{0,600}?href: "\/finances"/.exec(src);
    expect(emit, "finance hit emission present").toBeTruthy();
    expect(emit![0]).not.toMatch(/£|toFixed|amount|total/);
  });
});

// ── Injection safety still pinned across the widened surface ────────────────

describe("sanitize / ilike injection-safety (still pinned)", () => {
  it("the raw term is neutralised ONCE before any pattern is built", () => {
    expect(src).toContain("sanitizeSearchTerm(q)");
    expect(src).toMatch(/const like = `%\$\{safe\}%`/);
  });

  it("no ilike pattern is ever built from the raw q (only safe/ilikeOrFilter)", () => {
    // Every inline ilike interpolation must use the sanitized `like`.
    for (const m of src.matchAll(/ilike\.\$\{(\w+)\}/g)) {
      expect(m[1], `inline ilike uses sanitized term, got \${${m[1]}}`).toBe(
        "like",
      );
    }
    // And the column-set branches go through the shared sanitizing builder.
    expect(src).toContain("ilikeOrFilter(q, SUPPLIER_SEARCH_COLUMNS)");
    expect(src).toContain("ilikeOrFilter(q, ASSET_SEARCH_COLUMNS)");
    expect(src).toContain("ilikeOrFilter(q, FINANCE_SEARCH_COLUMNS)");
    expect(src).toContain("ilikeOrFilter(q, BLUEPRINT_SEARCH_COLUMNS)");
    expect(src).toContain("ilikeOrFilter(q, TOOLBOX_SEARCH_COLUMNS)");
    expect(src).toContain("ilikeOrFilter(q, DIARY_SEARCH_COLUMNS)");
    expect(src).toContain("ilikeOrFilter(q, QUALIFICATION_SEARCH_COLUMNS)");
  });

  it("id chains go through the UUID-validating builder (inIdsBranch)", () => {
    expect(src).toMatch(/inIdsBranch\(\s*"asset_id"/);
  });

  it("no unbounded / boundary (.limit(1000)+) read was introduced", () => {
    expect(src).not.toMatch(/\.limit\(\s*1000\s*\)/);
  });
});

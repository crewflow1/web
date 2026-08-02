import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DELAY_CATEGORIES } from "@/lib/eot/lifecycle";

/**
 * EOT DELAY EVENTS — TRUST-BOUNDARY PROOFS OVER THE SHIPPED SOURCE.
 *
 * The delay-events lane is EVIDENCE infrastructure for a future extension-of-
 * time claim, which makes its invariants adversarial by nature: a figure that
 * was computed instead of claimed, an event another tenant could link to, or
 * a "recorded" row that could be quietly rewritten would each poison the
 * evidence the pack exists to assemble. These are STRUCTURAL assertions, not
 * code-review notes:
 *
 *   1. Org pinning on every read the lane performs.
 *   2. The transition graph + immutability-after-recorded live in the DB.
 *   3. The category list cannot drift between TS and the DB CHECK.
 *   4. The weather seam stays a SEAM: same district CHECK as the dark cache,
 *      no FK to it, and NO RUNTIME READ of any weather table.
 *   5. No AI import anywhere on the lane; no money table anywhere near it.
 *   6. working_days_lost is claimed, never computed.
 *   7. The PDF is recorded-only, private and no-store — and says it is not
 *      a claim letter.
 */

const ROOT = resolve(__dirname, "..", "..");
const MIGRATION = "20261084000000_eot_delay_events.sql";
const WEATHER_MIGRATION = "20261074000000_weather_intelligence.sql";

/** Every file the delays/EOT feature owns. */
const EOT_SOURCES = [
  "lib/eot/lifecycle.ts",
  "lib/eot/pack.ts",
  "lib/eot/schema.ts",
  "server/services/eot-pack.ts",
  "app/(app)/delays/_data.ts",
  "app/(app)/delays/actions.ts",
  "app/(app)/delays/page.tsx",
  "app/(app)/delays/new/page.tsx",
  "app/(app)/delays/[id]/page.tsx",
  "app/(app)/delays/_form-fields.tsx",
  "app/(app)/jobs/[id]/_job-delays.tsx",
  "lib/pdf/eot-pack-pdf.tsx",
  "app/api/jobs/[id]/eot-pack/pdf/route.ts",
  "lib/eot/letter.ts",
  "server/services/eot-notice.ts",
  "lib/pdf/eot-notice-pdf.tsx",
  "app/api/delays/[id]/notice/pdf/route.ts",
];

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

/** Source with comments removed — prose about a hazard must never trip a scan. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*--.*$/gm, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

const migrationSrc = read(`supabase/migrations/${MIGRATION}`);
const migrationCode = stripComments(migrationSrc);

describe("eot · migration shape", () => {
  it("the migration exists, creates delay_events, and enables RLS after the table", () => {
    const files = readdirSync(resolve(ROOT, "supabase", "migrations"));
    expect(files).toContain(MIGRATION);
    const createAt = migrationCode.indexOf("create table if not exists public.delay_events");
    const rlsAt = migrationCode.indexOf(
      "alter table public.delay_events enable row level security",
    );
    expect(createAt).toBeGreaterThan(-1);
    expect(rlsAt).toBeGreaterThan(createAt);
  });

  it("contains no raw NUL bytes and no RESTRICT (the 20261052 teardown lesson)", () => {
    expect(migrationSrc.includes("\u0000")).toBe(false);
    expect(migrationCode.toLowerCase()).not.toContain("on delete restrict");
  });

  it("every RLS policy scopes through current_org_ids()/is_org_admin, and delete is draft-only + admin", () => {
    for (const p of ["select", "insert", "update"] as const) {
      const policy = migrationCode.match(
        new RegExp(`create policy delay_events_${p}[\\s\\S]*?;`),
      )?.[0];
      expect(policy, `policy delay_events_${p} missing`).toBeTruthy();
      expect(policy!).toContain("org_id in (select public.current_org_ids())");
    }
    const del = migrationCode.match(/create policy delay_events_delete[\s\S]*?;/)?.[0];
    expect(del).toBeTruthy();
    expect(del!).toContain("public.is_org_admin(org_id)");
    expect(del!).toContain("status = 'draft'");
  });
});

describe("eot · category drift (TS list == DB CHECK)", () => {
  it("the migration's category CHECK is exactly DELAY_CATEGORIES, in order", () => {
    const check = migrationCode.match(
      /category\s+text not null\s*check \(category in \(([\s\S]*?)\)\)/,
    )?.[1];
    expect(check, "category CHECK not found").toBeTruthy();
    const dbList = [...check!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(dbList).toEqual([...DELAY_CATEGORIES]);
  });
});

describe("eot · cross-tenant linkage is unrepresentable (composite FKs)", () => {
  it("job, diary and variation links are all (col, org_id) composite FKs", () => {
    expect(migrationCode).toMatch(
      /foreign key \(job_id, org_id\) references public\.jobs \(id, org_id\) on delete cascade/,
    );
    expect(migrationCode).toMatch(
      /foreign key \(diary_entry_id, org_id\) references public\.site_diary_entries \(id, org_id\)\s*on delete set null \(diary_entry_id\)/,
    );
    expect(migrationCode).toMatch(
      /foreign key \(variation_quote_id, org_id\) references public\.quotes \(id, org_id\)\s*on delete set null \(variation_quote_id\)/,
    );
  });

  it("adds the (id, org_id) candidate keys those FKs target, introspection-guarded", () => {
    expect(migrationCode).toContain("site_diary_entries_id_org_key unique (id, org_id)");
    expect(migrationCode).toContain("quotes_id_org_key unique (id, org_id)");
    expect(migrationCode).toContain("delay_events_id_org_key unique (id, org_id)");
  });
});

describe("eot · lifecycle lives in the database", () => {
  const transition = migrationCode.match(
    /create or replace function public\.tg_delay_event_transition[\s\S]*?\$\$;/,
  )?.[0];

  it("the transition trigger exists and is bound BEFORE UPDATE", () => {
    expect(transition).toBeTruthy();
    expect(migrationCode).toMatch(
      /create trigger delay_events_transition\s*before update on public\.delay_events/,
    );
  });

  it("permits exactly two edges and pins provenance to auth.uid() on the JWT path", () => {
    expect(transition!).toContain("old.status = 'draft' and new.status = 'recorded'");
    expect(transition!).toContain("old.status = 'recorded' and new.status = 'withdrawn'");
    expect(transition!).toMatch(/new\.recorded_by := auth\.uid\(\)/);
    expect(transition!).toMatch(/new\.withdrawn_by := auth\.uid\(\)/);
    // No third legal edge: draft→withdrawn is only ever mentioned as refused.
    expect(transition!).not.toContain("old.status = 'draft' and new.status = 'withdrawn'");
  });

  it("freezes a recorded event (immutability clause) and permits ONLY NULL→value completion", () => {
    expect(transition!).toMatch(/a recorded event is immutable/);
    expect(transition!).toMatch(
      /old\.ended_on is not null and new\.ended_on is distinct from old\.ended_on/,
    );
    expect(transition!).toMatch(
      /old\.working_days_lost is not null\s*and new\.working_days_lost is distinct from old\.working_days_lost/,
    );
    expect(transition!).toMatch(/a withdrawn event is frozen/);
  });

  it("events are born drafts, unconditionally", () => {
    const guard = migrationCode.match(
      /create or replace function public\.tg_delay_event_guard[\s\S]*?\$\$;/,
    )?.[0];
    expect(guard).toBeTruthy();
    expect(guard!).toContain("tg_op = 'INSERT' and new.status <> 'draft'");
  });
});

describe("eot · the weather seam is wired through the governed accessor, dark-safe", () => {
  // DELIBERATE PIN UPDATE (weather consumer wiring). The previous truth was
  // "the seam stays dormant — no weather read, flag HARD FALSE". The new truth,
  // updated in the SAME diff that wired the consumer (exactly as the codebase's
  // activation discipline requires): the EOT service now reads observed weather
  // for a delay window THROUGH THE GOVERNED ACCESSOR (server/services/weather.ts),
  // and derives `weatherEvidenceAvailable` from what it finds. The dark-safety is
  // preserved and STRENGTHENED into pins: no file touches a weather TABLE
  // directly, only the SERVICE may reach the accessor, and the flag is derived —
  // never a hard-coded `true`. The runtime proof that the dark path stays
  // byte-identical (flag false, zero client construction) lives in
  // __tests__/eot/pack-weather.test.ts and __tests__/weather/eot-evidence-dark.test.ts.
  const ACCESSOR_ALLOWED = new Set(["server/services/eot-pack.ts"]);

  it("weather_district carries the SAME district CHECK as the dark cache", () => {
    const weatherMigration = stripComments(read(`supabase/migrations/${WEATHER_MIGRATION}`));
    const cacheRegex = weatherMigration.match(/postcode_district ~ '([^']+)'/)?.[1];
    const seamRegex = migrationCode.match(/weather_district ~ '([^']+)'/)?.[1];
    expect(cacheRegex, "weather_readings CHECK regex not found").toBeTruthy();
    expect(seamRegex, "delay_events CHECK regex not found").toBeTruthy();
    expect(seamRegex).toBe(cacheRegex);
    // Both accept the GIR special case.
    expect(migrationCode).toContain("weather_district = 'GIR'");
  });

  it("the migration takes NO dependency on the weather tables (no FK, no read)", () => {
    // The column COMMENT may name the cache as documentation; the CODE must
    // never reference, join or point an FK at it.
    const withoutComments = migrationCode.replace(/comment on [\s\S]*?';/g, " ");
    expect(withoutComments).not.toMatch(
      /references public\.weather|from public\.weather|join public\.weather|weather_readings|weather_watches/,
    );
  });

  it("NO raw weather-TABLE read anywhere on the lane — the cache is only reached through the accessor", () => {
    // The trust property that survives activation: no EOT file names a weather
    // table in a query. The accessor owns the watch-gated, org-scoped RLS read;
    // the lane never hand-rolls one.
    for (const rel of EOT_SOURCES) {
      const code = stripComments(read(rel));
      expect(code, `${rel} must not query a weather table directly`).not.toMatch(
        /weather_readings|weather_watches/,
      );
    }
  });

  it("ONLY the EOT service may reach the weather domain — never the pure lib, PDF, pages or actions", () => {
    // The accessor is a server read; it belongs behind the service, not scattered
    // across the pure lib or the surfaces. A future edit that imports it anywhere
    // else must trip here.
    for (const rel of EOT_SOURCES) {
      if (ACCESSOR_ALLOWED.has(rel)) continue;
      const code = stripComments(read(rel));
      expect(code, `${rel} must not import the weather domain`).not.toMatch(
        /from ["']@\/(server\/services|lib)\/weather/,
      );
    }
    // And the one file that may, does — via the governed accessor, not a table.
    const service = stripComments(read("server/services/eot-pack.ts"));
    expect(service).toMatch(/from ["']@\/server\/services\/weather["']/);
    expect(service).toMatch(/buildWeatherSnapshot/);
  });

  it("the pack's weatherEvidenceAvailable is DERIVED, gated on readiness — never hard-coded true", () => {
    // DELIBERATE PIN UPDATE: successor to "HARD FALSE". What is pinned now is
    // that the flag is computed from the accessor's result behind the readiness
    // short-circuit, so a dark build resolves it to false with zero weather work,
    // and it can never be forced true by a literal.
    const service = stripComments(read("server/services/eot-pack.ts"));
    // Gated on the dark short-circuit.
    expect(service).toMatch(/isWeatherAvailable\s*\(/);
    // Derived from real evidence, not a literal.
    expect(service).toMatch(/weatherEvidenceAvailable:\s*weatherEvidenceByEvent\.size\s*>\s*0/);
    expect(service).not.toMatch(/weatherEvidenceAvailable:\s*true/);
    // An empty window yields no evidence — the readings-length guard that keeps a
    // dark cache from ever manufacturing a corroboration.
    expect(service).toMatch(/readings\.length === 0/);
  });
});

describe("eot · org pinning per read", () => {
  it("every delay_events query in the service and data layer carries .eq(\"org_id\", …)", () => {
    // Matches both builder idioms: db.from("delay_events") in the service and
    // tbl(supabase)("delay_events") in the data layer.
    for (const rel of ["server/services/eot-pack.ts", "app/(app)/delays/_data.ts"]) {
      const code = stripComments(read(rel));
      const chains = code.split(/\(["']delay_events["']\)/).slice(1);
      expect(chains.length, `${rel} should query delay_events`).toBeGreaterThan(0);
      for (const chain of chains) {
        const head = chain.slice(0, 400);
        expect(head, `${rel}: a delay_events chain is missing its org pin`).toMatch(
          /\.eq\(["']org_id["'],/,
        );
      }
    }
  });

  it("the sibling evidence reads (diary, variations, jobs) are org-pinned too", () => {
    for (const rel of ["server/services/eot-pack.ts", "app/(app)/delays/_data.ts"]) {
      const code = stripComments(read(rel));
      for (const table of ["site_diary_entries", "quotes", "jobs"]) {
        for (const chain of code.split(new RegExp(`\\(["']${table}["']\\)`)).slice(1)) {
          expect(
            chain.slice(0, 400),
            `${rel}: a ${table} chain is missing its org pin`,
          ).toMatch(/\.eq\(["']org_id["'],/);
        }
      }
    }
  });

  it("every write in actions.ts is org-pinned (insert carries org_id; updates .eq it)", () => {
    const code = stripComments(read("app/(app)/delays/actions.ts"));
    expect(code).toMatch(/insert\(\{[\s\S]*?org_id: ctx\.org\.id/);
    const updates = (code.match(/\.update\(/g) ?? []).length;
    const pins = (code.match(/\.eq\("org_id", ctx\.org\.id\)/g) ?? []).length;
    expect(updates).toBeGreaterThan(0);
    expect(pins).toBeGreaterThanOrEqual(updates);
  });
});

describe("eot · no AI, no money, no automatic anything", () => {
  it("no AI import or invocation anywhere on the lane", () => {
    for (const rel of EOT_SOURCES) {
      const code = stripComments(read(rel));
      expect(code, `${rel} must not touch AI`).not.toMatch(
        /@\/lib\/ai|@\/server\/services\/ai-|ai_invocations|openai|anthropic|generateText|invokeModel/i,
      );
    }
  });

  it("the migration references NO money table or money function", () => {
    for (const table of [
      "finances",
      "invoices",
      "invoice_payments",
      "payments",
      "job_billing_plans",
      "job_billing_stages",
      "supplier_bills",
      "expenses",
    ]) {
      expect(migrationCode).not.toMatch(new RegExp(`\\bpublic\\.${table}\\b`));
    }
    expect(migrationCode).not.toContain("generate_stage_invoice");
  });

  it("the lane imports nothing from the money domains and selects no money column off quotes", () => {
    for (const rel of EOT_SOURCES) {
      const code = stripComments(read(rel));
      expect(code, `${rel} must not import a money domain`).not.toMatch(
        /@\/lib\/(finances|invoices|billing|commercial|money)/,
      );
    }
    // The variation evidence read takes dates and identity — never amounts.
    const service = stripComments(read("server/services/eot-pack.ts"));
    const varCols = service.match(/const VARIATION_COLS =([\s\S]*?);/)?.[1] ?? "";
    expect(varCols).not.toMatch(/\b(subtotal|vat_total|total|cost_)/);
  });

  it("no outbound transport: nothing on the lane sends email or hits a webhook", () => {
    for (const rel of EOT_SOURCES) {
      const code = stripComments(read(rel));
      expect(code, `${rel} must not send anything`).not.toMatch(
        /@\/lib\/email|sendEmail|resend|fetch\(\s*["']https?:/i,
      );
    }
  });
});

describe("eot · working_days_lost is claimed, never computed", () => {
  it("the column is a plain integer — not GENERATED, no trigger writes it", () => {
    const body = migrationCode.match(
      /create table if not exists public\.delay_events\s*\(([\s\S]*?)\n\);/,
    )?.[1];
    expect(body).toBeTruthy();
    expect(body!).toMatch(/working_days_lost\s+integer\b/);
    expect(body!).not.toMatch(/working_days_lost[\s\S]{0,120}generated always/);
    // No function in the migration assigns it.
    expect(migrationCode).not.toMatch(/new\.working_days_lost\s*:=/);
  });

  it("no source derives the claim from the date range", () => {
    for (const rel of EOT_SOURCES) {
      const code = stripComments(read(rel));
      // The claim is never the target of date arithmetic.
      expect(code, `${rel} must not compute working days from dates`).not.toMatch(
        /working_?days_?lost['"]?\s*[:=][^,;\n]*daysBetween/i,
      );
    }
    // daysBetween appears in the pure lib ONLY for the two calendar facts.
    const pack = stripComments(read("lib/eot/pack.ts"));
    const uses = [...pack.matchAll(/^.*daysBetween\(.*$/gm)].map((m) => m[0]);
    for (const line of uses.filter((l) => !l.includes("import"))) {
      expect(line).toMatch(/calendarDaysSpanned|agreedVsRequestedDays/);
    }
  });
});

describe("eot · the PDF is recorded-only, private, and not a claim letter", () => {
  const route = read("app/api/jobs/[id]/eot-pack/pdf/route.ts");
  const routeCode = stripComments(route);
  const template = read("lib/pdf/eot-pack-pdf.tsx");

  it("renders from the pack shape (recorded-only by construction), never raw event rows", () => {
    const templateCode = stripComments(template);
    expect(templateCode).toContain("pack.categories");
    // The template cannot re-admit drafts: it has no status filter to get wrong.
    expect(templateCode).not.toMatch(/status\s*===?\s*["']draft["']/);
    expect(routeCode).toMatch(/recordedEventCount === 0/);
    expect(routeCode).toMatch(/409/);
  });

  it("is org-pinned, private and no-store", () => {
    expect(routeCode).toMatch(/\.eq\("org_id", ctx\.org\.id\)/);
    expect(routeCode).toContain('"Cache-Control": "private, no-store"');
  });

  it("a failed evidence read refuses the document rather than printing a thinner one", () => {
    expect(routeCode).toMatch(/if \(failed\)/);
  });

  it("the document itself says a contractual claim letter is deliberately not generated", () => {
    expect(template).toMatch(/not\s+a contractual claim and no claim letter is generated/i);
  });
});

describe("eot · the notice is a NOTICE, not a claim — and invents nothing", () => {
  const composer = read("lib/eot/letter.ts");
  const composerCode = stripComments(composer);
  const service = read("server/services/eot-notice.ts");
  const serviceCode = stripComments(service);
  const template = read("lib/pdf/eot-notice-pdf.tsx");
  const route = read("app/api/delays/[id]/notice/pdf/route.ts");
  const routeCode = stripComments(route);

  it("the service hands the composer contract terms as literal null — never a fabricated value", () => {
    expect(serviceCode).toMatch(/contractReference:\s*null/);
    expect(serviceCode).toMatch(/contractClause:\s*null/);
    expect(serviceCode).toMatch(/contractCompletionDate:\s*null/);
  });

  it("the composer fills fields only from its input and marks absent ones [not specified]", () => {
    expect(composerCode).toContain('NOT_SPECIFIED = "[not specified]"');
    // The absent-value helper is the ONLY thing that produces a value from a
    // possibly-null source; it collapses null to the placeholder, never a guess.
    expect(composerCode).toMatch(/const specified = trimmed\.length > 0/);
    expect(composerCode).toMatch(/unspecified/);
  });

  it("every scoped read in the notice service is org-pinned (delay_events, jobs, diary, quotes)", () => {
    for (const table of ["delay_events", "site_diary_entries", "quotes", "jobs"]) {
      for (const chain of serviceCode.split(new RegExp(`\\(["']${table}["']\\)`)).slice(1)) {
        expect(
          chain.slice(0, 400),
          `eot-notice service: a ${table} chain is missing its org pin`,
        ).toMatch(/\.eq\(["']org_id["'],/);
      }
    }
    // organizations IS the tenant — scoped by its own primary key = the org id.
    for (const chain of serviceCode.split(/\(["']organizations["']\)/).slice(1)) {
      expect(chain.slice(0, 400), "organizations read must be pinned to the active org id").toMatch(
        /\.eq\(["']id["'],\s*orgId\)/,
      );
    }
  });

  it("the notice is recorded-only (409 otherwise) and foreign/missing is 404", () => {
    expect(serviceCode).toMatch(/status !== "recorded"/);
    expect(serviceCode).toMatch(/not_recorded/);
    expect(serviceCode).toMatch(/not_found/);
    expect(routeCode).toMatch(/404/);
    expect(routeCode).toMatch(/409/);
  });

  it("the route is org-scoped, private and no-store", () => {
    expect(routeCode).toMatch(/requireOrgContext/);
    expect(routeCode).toMatch(/loadEotNotice\(ctx\.org\.id,/);
    expect(routeCode).toContain('"Cache-Control": "private, no-store"');
  });

  it("the document says on its face it is not a determination of entitlement", () => {
    expect(composer).toMatch(/does not itself assert contractual entitlement/i);
    expect(template).toMatch(/not a determination of entitlement/i);
  });
});

describe("eot · navigation pattern", () => {
  it("actions use plain redirect() at depth ≤2 — no useActionState on the lane", () => {
    const actions = read("app/(app)/delays/actions.ts");
    expect(actions).toMatch(/redirect\(/);
    for (const rel of EOT_SOURCES) {
      // Comments may DISCUSS the banned pattern; code must not import or call it.
      expect(
        stripComments(read(rel)),
        `${rel} must not use useActionState`,
      ).not.toContain("useActionState");
    }
  });
});

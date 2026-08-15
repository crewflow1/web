import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * P3 Jobs & Scheduling — hermetic migration + wiring guards.
 *
 * Proves the DB-level tenant safety and the app wiring for the five capabilities:
 * job templates, per-job checklists, milestone dependencies + critical path,
 * multi-day spans, and the gantt/resource views. Hermetic (SQL + source text),
 * so it runs in the security tier with no Postgres. The pure logic (CPM, spans)
 * is proven separately in __tests__/jobs/*.
 */

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS = join(ROOT, "supabase/migrations");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const migration = (name: string) => readFileSync(join(MIGRATIONS, name), "utf8");

const CHECKLISTS = "20261132000000_job_checklists.sql";
const TEMPLATES = "20261132000001_job_templates.sql";
const DEPS = "20261132000002_job_milestone_dependencies.sql";
const SPAN = "20261132000003_jobs_multiday_span.sql";

describe("migration files exist on the mandated prefix", () => {
  for (const f of [CHECKLISTS, TEMPLATES, DEPS, SPAN]) {
    it(f, () => {
      expect(migration(f).length).toBeGreaterThan(0);
    });
  }
});

describe("composite-FK tenancy (a forged parent id cannot cross tenants)", () => {
  it("job_checklists binds job by (job_id, org_id) → jobs(id, org_id)", () => {
    const sql = migration(CHECKLISTS);
    expect(sql).toMatch(
      /foreign key \(job_id, org_id\)\s*references public\.jobs \(id, org_id\)/,
    );
    // Own composite key for future children.
    expect(sql).toMatch(/unique \(id, org_id\)/);
  });

  it("template children bind by (template_id, org_id) → job_templates(id, org_id)", () => {
    const sql = migration(TEMPLATES);
    const matches = sql.match(
      /foreign key \(template_id, org_id\)\s*references public\.job_templates \(id, org_id\)/g,
    );
    // milestones + checklist_items.
    expect((matches ?? []).length).toBeGreaterThanOrEqual(2);
    expect(sql).toMatch(/constraint job_templates_id_org_key unique \(id, org_id\)/);
  });

  it("milestone deps bind baseline + BOTH endpoints by composite FK", () => {
    const sql = migration(DEPS);
    // job_milestones gains the composite key the endpoints reference.
    expect(sql).toMatch(/alter table public\.job_milestones\s*add constraint job_milestones_id_org_key unique \(id, org_id\)/);
    expect(sql).toMatch(
      /foreign key \(baseline_id, org_id\)\s*references public\.job_programme_baselines \(id, org_id\)/,
    );
    const endpointFks = sql.match(
      /foreign key \((?:milestone_id|depends_on_milestone_id), org_id\)\s*references public\.job_milestones \(id, org_id\)/g,
    );
    expect((endpointFks ?? []).length).toBe(2);
    // No self-dependency, one edge per pair.
    expect(sql).toMatch(/check \(milestone_id <> depends_on_milestone_id\)/);
    expect(sql).toMatch(/unique \(milestone_id, depends_on_milestone_id\)/);
  });
});

describe("RLS is enabled and correctly-postured on every new table", () => {
  it("all five new tables enable RLS", () => {
    const pairs: Array<[string, string]> = [
      [CHECKLISTS, "job_checklists"],
      [TEMPLATES, "job_templates"],
      [TEMPLATES, "job_template_milestones"],
      [TEMPLATES, "job_template_checklist_items"],
      [DEPS, "job_milestone_dependencies"],
    ];
    for (const [file, table] of pairs) {
      expect(
        migration(file),
        `${table} must enable RLS`,
      ).toMatch(new RegExp(`alter table public\\.${table} enable row level security`));
    }
  });

  it("templates + dependencies are ADMIN-write (planning config)", () => {
    for (const sql of [migration(TEMPLATES), migration(DEPS)]) {
      expect(sql).toMatch(/for insert to authenticated with check \(public\.is_org_admin\(org_id\)\)/);
    }
  });

  it("checklists are MEMBER-write (the crew's working list)", () => {
    const sql = migration(CHECKLISTS);
    expect(sql).toMatch(
      /for insert to authenticated\s*with check \(org_id in \(select public\.current_org_ids\(\)\)\)/,
    );
    expect(sql).toMatch(/for update to authenticated/);
    expect(sql).toMatch(/for delete to authenticated using \(org_id in \(select public\.current_org_ids\(\)\)\)/);
  });
});

describe("the write-path RPCs are safe by construction", () => {
  it("all three RPCs are SECURITY INVOKER, granted to authenticated, revoked from public/anon", () => {
    const rpcs: Array<[string, string]> = [
      [TEMPLATES, "save_job_template"],
      [TEMPLATES, "clone_job_template"],
      [DEPS, "set_milestone_dependencies"],
    ];
    for (const [file, fn] of rpcs) {
      const sql = migration(file);
      expect(sql, `${fn} must be SECURITY INVOKER`).toMatch(
        new RegExp(`function public\\.${fn}[\\s\\S]*?security invoker`),
      );
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${fn}[\\s\\S]*?from public, anon`));
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${fn}[\\s\\S]*?to authenticated`));
    }
  });

  it("clone_job_template GATES the programme baseline behind is_org_admin", () => {
    const sql = migration(TEMPLATES);
    // The baseline/milestone clone is inside an is_org_admin branch, so a member
    // cannot manufacture an admin-only programme baseline through the clone.
    expect(sql).toMatch(/if p_anchor_date is not null and public\.is_org_admin\(p_org_id\)/);
    // The checklist clone is outside that gate (member-writable).
    expect(sql).toMatch(/Checklist clone \(any member\)/);
    // Only clones a baseline when none exists yet (revision-1 semantics).
    expect(sql).toMatch(/if not v_has_baseline then/);
  });

  it("set_milestone_dependencies refuses self-deps, cross-baseline links, and CYCLES", () => {
    const sql = migration(DEPS);
    expect(sql).toMatch(/a milestone cannot depend on itself/);
    expect(sql).toMatch(/a dependency references a milestone outside this baseline/);
    // Recursive cycle check + refusal.
    expect(sql).toMatch(/with recursive walk/);
    expect(sql).toMatch(/these dependencies form a loop/);
    // Atomic under a per-baseline advisory lock.
    expect(sql).toMatch(/pg_advisory_xact_lock\(hashtext\('job_milestone_deps'\)/);
  });

  it("save_job_template replaces children atomically under an advisory lock", () => {
    const sql = migration(TEMPLATES);
    expect(sql).toMatch(/pg_advisory_xact_lock\(hashtext\('job_template'\)/);
    expect(sql).toMatch(/delete from public\.job_template_milestones where template_id = v_id/);
    expect(sql).toMatch(/delete from public\.job_template_checklist_items where template_id = v_id/);
  });
});

describe("checklist completion provenance is trigger-stamped, not client-trusted", () => {
  const sql = migration(CHECKLISTS);
  it("a BEFORE trigger derives done_at/done_by from the is_done transition", () => {
    expect(sql).toMatch(/create trigger job_checklists_completion\s*before insert or update/);
    expect(sql).toMatch(/new\.done_by := auth\.uid\(\)/);
    // Un-ticking clears the stamp.
    expect(sql).toMatch(/not new\.is_done and old\.is_done/);
  });
});

describe("multi-day spans are strictly additive & backward-compatible", () => {
  const sql = migration(SPAN);
  it("adds a NULLABLE scheduled_end_date column (existing rows unaffected)", () => {
    expect(sql).toMatch(/add column if not exists scheduled_end_date date/);
    expect(sql).not.toMatch(/scheduled_end_date date not null/);
  });
  it("a CHECK guarantees an end never precedes the start", () => {
    expect(sql).toMatch(
      /check \(\s*scheduled_end_date is null\s*or \(scheduled_date is not null and scheduled_end_date >= scheduled_date\)/,
    );
  });
});

describe("app wiring", () => {
  it("createJob clones a chosen template and writes the span end", () => {
    const src = read("app/(app)/jobs/actions.ts");
    expect(src).toMatch(/rpc\("clone_job_template"/);
    expect(src).toMatch(/scheduled_end_date: result\.data\.scheduled_end_date/);
    // Span cross-field rule is enforced before both writes.
    expect(src).toMatch(/function validateSpan/);
  });

  it("checklist + template + dependency by-id tenant writes pin the active org", () => {
    const checklist = read("app/(app)/jobs/[id]/checklist-actions.ts");
    // Both the toggle (update) and delete pin org_id in-statement.
    expect(checklist.match(/\.eq\("org_id", ctx\.org\.id\)/g)?.length).toBeGreaterThanOrEqual(3);
    const templates = read("app/(app)/jobs/templates/actions.ts");
    expect(templates).toMatch(/\.delete\(\)[\s\S]*?\.eq\("id", templateId\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("the span reader + template list reader are active-org pinned and paged", () => {
    const span = read("lib/jobs/schedule-spans.ts");
    expect(span).toMatch(/\.eq\("org_id", orgId\)/);
    expect(span).toMatch(/fetchAllRows/);
    const list = read("lib/jobs/template-list.ts");
    expect(list).toMatch(/\.eq\("org_id", orgId\)/);
    expect(list).toMatch(/fetchAllRows/);
  });

  it("the gantt/resource calendar view reads the dedicated span reader", () => {
    const page = read("app/(app)/jobs/calendar/page.tsx");
    expect(page).toMatch(/fetchJobSpansForWindow/);
    expect(page).toMatch(/view === "gantt" \|\| view === "resource"/);
  });
});

describe("new org-scoped tables are registered for GDPR export", () => {
  it("all five appear in lib/gdpr/org-tables.json known[]", () => {
    const json = JSON.parse(read("lib/gdpr/org-tables.json")) as {
      known: string[];
      excluded: Record<string, string>;
    };
    for (const t of [
      "job_checklists",
      "job_templates",
      "job_template_milestones",
      "job_template_checklist_items",
      "job_milestone_dependencies",
    ]) {
      expect(json.known, `${t} must be registered`).toContain(t);
      // None is a credential table, so none should be excluded.
      expect(json.excluded[t]).toBeUndefined();
    }
  });
});

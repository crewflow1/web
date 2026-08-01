import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ATTACHMENT_TARGET_TABLES } from "@/server/services/tenant-attachments";

/**
 * Works Quality (ITP) — security source-contracts.
 *
 * Runtime behaviour is proven against real Postgres in
 * __tests__/integration/rls/works-quality-isolation.test.ts. These lock the
 * load-bearing rules AT THE SOURCE so a regression is a red build, following
 * __tests__/security/health-safety.test.ts.
 */

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const migration = read("supabase/migrations/20261076000000_works_quality_itp.sql");
const data = read("app/(app)/quality/_data.ts");
const actions = read("app/(app)/quality/actions.ts");
const register = read("app/(app)/quality/page.tsx");
const detail = read("app/(app)/quality/[id]/page.tsx");
const itemCard = read("app/(app)/quality/_item-card.tsx");
const warnPanel = read("app/(app)/quality/_hold-point-warnings.tsx");
const jobPanel = read("app/(app)/jobs/[id]/_job-quality.tsx");
const domain = read("lib/quality/itp.ts");
const schema = read("lib/quality/schema.ts");

const APP_SOURCES: Array<[string, string]> = [
  ["_data.ts", data],
  ["actions.ts", actions],
  ["page.tsx", register],
  ["[id]/page.tsx", detail],
  ["_item-card.tsx", itemCard],
  ["_job-quality.tsx", jobPanel],
];

/**
 * Strip comments so the "must not contain X" pins match CODE only. Prose that
 * NAMES what the file deliberately avoids ("nothing here writes to `finances`",
 * "the asset_inspection* engine is untouched") is exactly the documentation we
 * want, and a naive substring pin would punish it — the house convention set by
 * __tests__/security/health-safety.test.ts ("match CODE identifiers only").
 */
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments (JS/TS)
    .replace(/^\s*\/\/.*$/gm, " ") // line comments (JS/TS)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ") // JSX comments
    .replace(/^\s*--.*$/gm, " "); // line comments (SQL)

const migrationCode = codeOnly(migration);

// ---------------------------------------------------------------------------
describe("migration — tenant isolation is DB-enforced", () => {
  it("RLS is enabled on all three tables", () => {
    for (const t of ["inspection_test_plans", "inspection_plan_items", "inspection_signoffs"]) {
      expect(migration).toMatch(new RegExp(`alter table public\\.${t}\\s+enable row level security`));
    }
  });

  it("every policy is scoped by org membership; hard delete is admin + draft only", () => {
    expect(migration).toMatch(/current_org_ids\(\)/);
    expect(migration).toMatch(/is_org_admin\(org_id\) and status = 'draft'/);
  });

  it("children carry composite-FK tenant integrity to their parent (id, org_id)", () => {
    expect(migration).toMatch(/constraint itp_id_org_key unique \(id, org_id\)/);
    expect(migration).toMatch(/constraint ipi_id_org_key unique \(id, org_id\)/);
    expect(migration).toMatch(/references public\.inspection_test_plans \(id, org_id\)/);
    expect(migration).toMatch(/references public\.inspection_plan_items \(id, org_id\)/);
  });

  it("a child's org_id is trigger-DERIVED from its parent, never trusted from the client", () => {
    expect(migration).toMatch(/tg_ipi_derive_org/);
    expect(migration).toMatch(/new\.org_id\s*:=\s*parent_org/);
    // sign-offs derive theirs from the item they hang off
    expect(migration).toMatch(/new\.org_id\s*:=\s*v_item_org/);
  });

  it("the job link is validated same-org", () => {
    expect(migration).toMatch(/tg_itp_validate_job_org/);
    expect(migration).toMatch(/does not belong to this organisation/);
  });

  it("the self-referential supersede FK is composite AND deferrable, never restrict", () => {
    // RESTRICT can never be deferred, so it would abort `delete from
    // organizations` (the 20261052 teardown P1).
    expect(migration).toMatch(
      /constraint itp_supersedes_org_fkey[\s\S]{0,200}on delete no action deferrable initially deferred/,
    );
    expect(migration).not.toMatch(/on delete restrict deferrable/i);
  });

  it("no cascade child uses ON DELETE RESTRICT", () => {
    // The one restrict in the DDL is inspected_by -> public.users, which is NOT
    // on the org-teardown cascade path (users has no org_id, so `delete from
    // organizations` never reaches it). Assert there is exactly one, and that it
    // is that one — a restrict on any org-scoped child would abort teardown.
    const restricts = migrationCode.match(/on delete restrict/g) ?? [];
    expect(restricts).toHaveLength(1);
    expect(migrationCode).toMatch(
      /inspected_by\s+uuid not null references public\.users\(id\) on delete restrict/,
    );
    // Proven at runtime: works-quality-isolation.test.ts deletes an org holding
    // sign-offs, then deletes the signer.
  });

  it("every SECURITY DEFINER function pins search_path (no mutable-path escalation)", () => {
    const defs = migration.match(/security definer/g) ?? [];
    const pins = migration.match(/set search_path = public/g) ?? [];
    expect(defs.length).toBeGreaterThan(0);
    expect(pins.length).toBeGreaterThanOrEqual(defs.length);
  });

  it("the register view is security_invoker — it inherits RLS, never launders it", () => {
    expect(migration).toMatch(/create or replace view public\.works_quality_plan_status\s*\n\s*with \(security_invoker = true\)/);
  });

  it("the atomic issue RPC is SECURITY INVOKER so RLS + every trigger still apply", () => {
    expect(migration).toMatch(/create or replace function public\.issue_inspection_plan[\s\S]{0,200}security invoker/);
  });
});

// ---------------------------------------------------------------------------
describe("migration — the controlled document is immutable once issued", () => {
  it("a plan is always born a draft (a direct INSERT cannot skip the issue gate)", () => {
    expect(migration).toMatch(/an inspection plan is created as a draft, then issued/);
  });

  it("immutability runs whenever the plan has left draft, not only on a status change", () => {
    // The 20261019 P0-2 lesson: an edit must not ride in on a transition.
    expect(migration).toMatch(/if old\.status <> 'draft' then[\s\S]{0,900}an issued inspection plan is immutable/);
  });

  it("issue is gated on a named job and at least one check", () => {
    expect(migration).toMatch(/cannot issue: an inspection plan must name the job/);
    expect(migration).toMatch(/cannot issue: an inspection plan needs at least one inspection item/);
  });

  it("items are frozen (and undeletable) once the plan leaves draft", () => {
    expect(migration).toMatch(/cannot modify the items of a % inspection plan/);
    expect(migration).toMatch(/tg_ipi_block_delete_when_issued/);
  });

  it("an issued plan cannot be hard-deleted — as a TRIGGER, so it binds service_role", () => {
    expect(migration).toMatch(/tg_itp_block_delete_when_issued/);
    expect(migration).toMatch(/is quality evidence and cannot be deleted; withdraw it instead/);
  });

  it("every delete-block lets the org-teardown cascade through", () => {
    // Without this escape, `delete from organizations` aborts (20261052 class).
    const escapes = migration.match(/exists \(select 1 from public\.organizations where id = old\.org_id\)/g) ?? [];
    expect(escapes.length).toBeGreaterThanOrEqual(3);
  });

  it("only ONE issued plan may exist per (job, work package)", () => {
    expect(migration).toMatch(
      /create unique index if not exists itp_one_current_per_package_idx[\s\S]{0,200}where status = 'issued'/,
    );
  });
});

// ---------------------------------------------------------------------------
describe("migration — sign-offs are evidence", () => {
  it("only an ISSUED plan can be signed off against", () => {
    expect(migration).toMatch(/cannot sign off against a % inspection plan/);
  });

  it("membership is checked BEFORE anything else leaks the plan's state", () => {
    // The 20261020 lesson: error messages must not let a non-member probe
    // another org's document status/reference.
    const memberIdx = migration.indexOf("the inspector is not a member of this organisation");
    const statusIdx = migration.indexOf("cannot sign off against a % inspection plan");
    expect(memberIdx).toBeGreaterThan(0);
    expect(statusIdx).toBeGreaterThan(memberIdx);
  });

  it("the signer is bound to the authenticated session (no signing for a colleague)", () => {
    expect(migration).toMatch(/an inspector can only sign off as themselves/);
    expect(migration).toMatch(/inspected_by = auth\.uid\(\)/);
  });

  it("the record is version-anchored to the plan's issued reference", () => {
    expect(migration).toMatch(/version mismatch: the plan is at % not %/);
  });

  it("timestamps are server-pinned (the client cannot backdate the record)", () => {
    expect(migration).toMatch(/new\.recorded_at\s*:=\s*now\(\)/);
    expect(migration).toMatch(/the inspection date cannot be in the future/);
  });

  it("a sign-off is never born void", () => {
    expect(migration).toMatch(/new\.voided_at\s*:=\s*null/);
  });

  it("a recorded sign-off is immutable, correctable only by void-and-redo", () => {
    expect(migration).toMatch(/tg_signoff_void_only/);
    expect(migration).toMatch(/a recorded sign-off is immutable; void it and record a new one/);
    expect(migration).toMatch(/a voided sign-off is terminal and cannot be changed/);
    // A void must be explained.
    expect(migration).toMatch(/constraint isg_void_triple/);
  });

  it("a sign-off can never be deleted, not even by the service role", () => {
    expect(migration).toMatch(/tg_signoff_block_delete/);
    expect(migration).toMatch(/cannot be deleted; void it instead/);
    // No DELETE policy exists for authenticated either.
    expect(migration).not.toMatch(/create policy isg_delete/);
  });

  it("at most one LIVE sign-off per item, voided rows retained", () => {
    expect(migration).toMatch(
      /create unique index if not exists isg_one_live_per_item_idx[\s\S]{0,120}where voided_at is null/,
    );
  });

  it("a non-pass result must be explained", () => {
    expect(migration).toMatch(/constraint isg_comment_required_unless_plain_pass/);
  });
});

// ---------------------------------------------------------------------------
describe("the hold-point gate: modelled in the DB, and a WARN seam not a block", () => {
  it("the hold-point flag is a real column with a structural coherence rule", () => {
    expect(migration).toMatch(/is_hold_point\s+boolean not null default false/);
    // An optional hold point is incoherent.
    expect(migration).toMatch(/constraint ipi_hold_point_is_required check \(not is_hold_point or required\)/);
  });

  it("the gate has ONE authority: a DB function, reused by the stamp trigger", () => {
    expect(migration).toMatch(/create or replace function public\.works_quality_open_hold_point/);
    expect(migration).toMatch(/v_gate := public\.works_quality_open_hold_point\(v_plan_id\)/);
  });

  it("only an ACCEPTING result releases a hold point — a fail leaves it open", () => {
    const fn = migration.slice(
      migration.indexOf("function public.works_quality_open_hold_point"),
      migration.indexOf("grant execute on function public.works_quality_open_hold_point"),
    );
    expect(fn).toMatch(/s\.voided_at is null/);
    expect(fn).toMatch(/s\.result in \('pass', 'pass_with_comment'\)/);
  });

  it("the breach is STAMPED and frozen, never used to refuse the write", () => {
    expect(migration).toMatch(/new\.hold_point_breach := true/);
    expect(migration).toMatch(/hold_point_breach.*is distinct from|new\.hold_point_breach, new\.open_hold_item_number/s);
    // The stamping trigger must NOT raise on a breach. Assert no refusal wording
    // exists anywhere near the gate stamp.
    const stamp = migration.slice(migration.indexOf("9. STAMP THE GATE"));
    expect(stamp).not.toMatch(/raise exception[^\n]*hold point/i);
  });

  it("the migration states the WARN decision explicitly, with the precedent", () => {
    expect(migration).toMatch(/THE GATE IS A WARN SEAM, NOT A WORK BLOCK/);
    expect(migration).toMatch(/20260928/); // the one place the platform DOES block, and why it differs
  });

  it("the app's warning text never claims anything is blocked", () => {
    for (const [name, src] of APP_SOURCES) {
      // "should not proceed" is the honest phrasing; "cannot proceed" would lie.
      expect(src, `${name} must not claim work is blocked`).not.toMatch(
        /cannot proceed|is blocked from|work is blocked|prevented from proceeding/i,
      );
    }
    expect(domain).toMatch(/WARN, NOT BLOCK/);
    expect(warnPanel).toMatch(/ONLY thing an open hold point does to the UI: it warns/);
  });

  it("no control is disabled because a hold point is open", () => {
    // The single `disabled` in the domain UI is the issue button, gated on
    // canIssue (document completeness), never on the hold-point gate.
    const disableds = detail.match(/disabled=\{[^}]*\}/g) ?? [];
    expect(disableds).toEqual(["disabled={!gate.ok}"]);
    expect(itemCard).not.toMatch(/disabled/);
    // and the sign-off form is rendered on the same condition regardless of the gate
    expect(itemCard).toMatch(/canSignOff && !live && planVersion/);
  });

  it("the sign-off form warns about an out-of-sequence record without stopping it", () => {
    expect(itemCard).toMatch(/wouldBreach/);
    expect(itemCard).toMatch(/You can record this/);
  });
});

// ---------------------------------------------------------------------------
describe("server actions — RLS-scoped, count-gated, never service-role", () => {
  it("all writes go through the tenant (user-JWT) client", () => {
    expect(actions).toMatch(/from "@\/lib\/supabase\/server"/);
    for (const [name, src] of APP_SOURCES) {
      expect(src, `${name} must not reach for the service-role client`).not.toMatch(
        /serviceClient\(|SUPABASE_SERVICE_ROLE_KEY|createServiceClient|createAdminClient/,
      );
    }
  });

  it("every mutation is gated by requireOrgContext + the active org, and count-checked", () => {
    expect(actions).toMatch(/requireOrgContext\(\)/);
    expect(actions).toMatch(/\.eq\("org_id", ctx\.org\.id\)/);
    expect(actions).toMatch(/if \(!count\)/);
  });

  it("issuing goes through the atomic RPC, never a hand-rolled supersede", () => {
    expect(actions).toMatch(/rpc\(\s*"issue_inspection_plan"/);
    expect(actions).not.toMatch(/status:\s*"superseded"/);
  });

  it("issuing re-checks readiness (canIssue) before calling the RPC", () => {
    expect(actions).toMatch(/canIssue\(/);
  });

  it("the sign-off's inspector is the session user, never form input", () => {
    expect(actions).toMatch(/inspected_by: user\.id/);
    expect(actions).not.toMatch(/inspected_by:\s*(v|formData)/);
  });

  it("voiding only ever touches a not-yet-voided row", () => {
    expect(actions).toMatch(/\.is\("voided_at", null\)/);
  });
});

// ---------------------------------------------------------------------------
describe("active-org pinning — every read carries its own org predicate", () => {
  it("EVERY org-scoped read in the data layer carries its own org predicate", () => {
    // The file must never rely on RLS alone — current_org_ids() spans a dual-org
    // member's companies, which is what #456/#463/#468 were.
    const code = codeOnly(data);
    const selects = code.match(/\.select\(/g) ?? [];
    const orgPins = code.match(/\.eq\("org_id", orgId\)/g) ?? [];
    expect(selects.length).toBeGreaterThanOrEqual(10);
    // Exactly ONE read is not org-pinned: loadUserNames reads public.users,
    // which has no org_id at all, and only ever resolves display names for ids
    // that came off rows already pinned by the caller. If this count ever moves,
    // a new read has appeared without a pin — go and look at it.
    expect(
      selects.length - orgPins.length,
      "a new un-pinned read appeared in app/(app)/quality/_data.ts",
    ).toBe(1);
    const unpinned = code.slice(code.indexOf("export async function loadUserNames"));
    expect(unpinned).toMatch(/\.from\("users"\)|from\(\s*"users"\s*\)|\("users"\)/);
  });

  it("the pages pass ctx.org.id into the data layer, never an unpinned read", () => {
    expect(register).toMatch(/listPlans\(ctx\.org\.id\)/);
    expect(detail).toMatch(/getPlan\(ctx\.org\.id, id\)/);
    expect(jobPanel).toMatch(/\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("the job panel pins the org AND the job (not the job alone)", () => {
    const pins = jobPanel.match(/\.eq\("org_id", ctx\.org\.id\)/g) ?? [];
    expect(pins.length).toBeGreaterThanOrEqual(2);
    expect(jobPanel).toMatch(/\.eq\("job_id", jobId\)/);
  });

  it("a plan outside the active org is indistinguishable from a missing one", () => {
    expect(detail).toMatch(/if \(!loaded\) notFound\(\)/);
  });
});

// ---------------------------------------------------------------------------
describe("loud reads — a failed read must never render as 'no hold points'", () => {
  it("the data layer throws on every rejected query", () => {
    expect(data).toMatch(/from "@\/lib\/supabase\/read-failure"/);
    const throws = data.match(/throw readFailure\(/g) ?? [];
    const selects = data.match(/\.select\(/g) ?? [];
    expect(throws.length).toBeGreaterThanOrEqual(selects.length);
    // and never swallows an error into an empty result
    expect(data).not.toMatch(/data \?\? \[\];\s*\n?\s*\/\/ ignore/);
  });

  it("the job panel reports and renders an EXPLICIT error block, not an empty state", () => {
    expect(jobPanel).toMatch(/reportReadFailure\(/);
    expect(jobPanel).toMatch(/is NOT\s*\n?\s*\* *saying there are none|NOT\s+saying there are none/);
  });

  it("the register's empty state is only reachable on a genuinely empty read", () => {
    // listPlans throws on error, so `rows.length === 0` can only mean empty.
    expect(register).toMatch(/rows\.length === 0/);
    expect(register).toMatch(/listPlans\(ctx\.org\.id\)/);
  });
});

// ---------------------------------------------------------------------------
describe("no money, no AI", () => {
  it("the migration writes nothing to finances and touches no monetary table", () => {
    expect(migrationCode).not.toMatch(/insert into public\.finances/i);
    expect(migrationCode).not.toMatch(/\bpublic\.finances\b/);
    expect(migrationCode).not.toMatch(
      /\bpublic\.invoices\b|\bpublic\.invoice_payments\b|\bpublic\.supplier_bills\b/,
    );
    // …and there is no money column anywhere on the three new tables.
    expect(migrationCode).not.toMatch(/_pence\b|numeric\(\d+, ?2\)/);
  });

  it("no source in this domain references a money column or a posting", () => {
    const sources: Array<[string, string]> = [
      ...APP_SOURCES,
      ["itp.ts", domain],
      ["schema.ts", schema],
    ];
    for (const [name, src] of sources) {
      expect(codeOnly(src), `${name} must not touch money`).not.toMatch(
        /amount_pence|total_pence|formatGbp|\bfinances\b|posting/i,
      );
    }
  });

  it("no AI on any path in this lane", () => {
    const sources: Array<[string, string]> = [
      ...APP_SOURCES,
      ["itp.ts", domain],
      ["schema.ts", schema],
      ["migration", migration],
    ];
    for (const [name, src] of sources) {
      expect(codeOnly(src), `${name} must contain no AI`).not.toMatch(
        /anthropic|openai|@\/lib\/ai\/|claude-|\bllm\b|ai_invocations|governor/i,
      );
    }
  });
});

// ---------------------------------------------------------------------------
describe("attachment target widening — DB CHECK and TS list moved together", () => {
  it("the TS list carries the new target", () => {
    expect(ATTACHMENT_TARGET_TABLES).toContain("inspection_signoffs");
  });

  it("the migration re-adds the CHECK by introspection, preserving every prior target", () => {
    // Introspect-drop-readd: an under-stated list silently REVOKES a whole
    // domain's attachment support.
    expect(migration).toMatch(/drop constraint %I/);
    expect(migration).toMatch(/add constraint tenant_attachments_target_table_check/);
    const body = migration.match(/target_table in \(([^)]+)\)/)!;
    const values = [...body[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(values).toContain("inspection_signoffs");
    // Every previously-supported target must still be there.
    for (const prior of [
      "customers", "jobs", "quotes", "invoices", "suppliers", "memberships", "leads",
      "snags", "site_diary_entries", "toolbox_talks", "site_reports", "assets",
      "asset_assignments", "asset_inspections", "asset_maintenance_cases",
      "asset_fuel_logs", "goods_received_notes",
    ]) {
      expect(values, `${prior} must survive the re-add`).toContain(prior);
    }
    expect(new Set(values).size).toBe(18);
  });

  it("sign-off evidence is append-only: DELETE is blocked by a DB trigger", () => {
    expect(migration).toMatch(/tg_tenant_attachment_freeze_signoff/);
    expect(migration).toMatch(/before delete on public\.tenant_attachments/);
    expect(migration).toMatch(/add new files, never remove or replace one/);
    // The existing toolbox freeze must be left alone (separate trigger).
    expect(migration).not.toMatch(/tg_tenant_attachment_freeze_delivered_toolbox\s*\(\)\s*returns/);
    // and the UI must not offer a Delete control on frozen evidence
    expect(itemCard).toMatch(/targetTable="inspection_signoffs" targetId=\{live\.id\} frozen/);
  });
});

// ---------------------------------------------------------------------------
describe("this is a NEW domain — the asset-inspection engine is untouched", () => {
  it("the migration's DDL touches no asset_inspection table", () => {
    // The header PROSE names asset_inspection* to explain the distinction, and
    // the attachment-target re-add MUST keep 'asset_inspections' in the value
    // list (dropping it would revoke that domain's attachments). Neither is a
    // dependency. What must not appear is a reference to the table itself.
    expect(migrationCode).not.toMatch(/public\.asset_inspection/);
    expect(migrationCode).not.toMatch(/(from|join|references|into|update)\s+asset_inspection/i);
    // Nor may it alter anything the plant regime owns.
    expect(migrationCode).not.toMatch(/alter table public\.asset/);
    // The only occurrence outside comments is the preserved attachment target.
    const hits = migrationCode.match(/asset_inspections/g) ?? [];
    expect(hits).toHaveLength(1);
    expect(migrationCode).toMatch(/'asset_inspections',/);
  });

  it("no source in this lane imports from the assets domain", () => {
    for (const [name, src] of APP_SOURCES) {
      expect(codeOnly(src), `${name} must not reach into asset inspections`).not.toMatch(
        /@\/lib\/assets|asset_inspections|\/assets\/\[id\]\/inspections/,
      );
    }
  });

  it("the migration says out loud what it is not, so nobody re-derives it", () => {
    expect(migration).toMatch(/asset_inspection\*/);
    expect(migration).toMatch(/PLANT\/EQUIPMENT regime/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// M2 (migration 20261081): NCRs + corrective actions, witness invitations,
// ITP templates, revision lineage, evidence PDF.
//
// Same contract as above: runtime behaviour is proven against real Postgres in
// __tests__/integration/rls/works-quality-m2.test.ts; these pin the rules AT
// THE SOURCE so a regression is a red build.
// ═══════════════════════════════════════════════════════════════════════════
const migration2 = read("supabase/migrations/20261081000000_works_quality_m2.sql");
const migration2Code = codeOnly(migration2);

const ncrData = read("app/(app)/quality/ncrs/_data.ts");
const ncrActions = read("app/(app)/quality/ncrs/actions.ts");
const ncrRegister = read("app/(app)/quality/ncrs/page.tsx");
const ncrDetail = read("app/(app)/quality/ncrs/[id]/page.tsx");
const ncrNew = read("app/(app)/quality/ncrs/new/page.tsx");
const tplData = read("app/(app)/quality/templates/_data.ts");
const tplActions = read("app/(app)/quality/templates/actions.ts");
const tplRegister = read("app/(app)/quality/templates/page.tsx");
const tplDetail = read("app/(app)/quality/templates/[id]/page.tsx");
const witnessPanel = read("app/(app)/quality/_witness-panel.tsx");
const pdfRoute = read("app/api/quality/[id]/pdf/route.ts");
const pdfDoc = read("lib/pdf/itp-pdf.tsx");
const ncrDomain = read("lib/quality/ncr.ts");
const tplDomain = read("lib/quality/templates.ts");

const M2_APP_SOURCES: Array<[string, string]> = [
  ["ncrs/_data.ts", ncrData],
  ["ncrs/actions.ts", ncrActions],
  ["ncrs/page.tsx", ncrRegister],
  ["ncrs/[id]/page.tsx", ncrDetail],
  ["ncrs/new/page.tsx", ncrNew],
  ["templates/_data.ts", tplData],
  ["templates/actions.ts", tplActions],
  ["templates/page.tsx", tplRegister],
  ["templates/[id]/page.tsx", tplDetail],
  ["_witness-panel.tsx", witnessPanel],
  ["api/quality/[id]/pdf/route.ts", pdfRoute],
];

// ---------------------------------------------------------------------------
describe("M2 migration — tenant isolation on the five new tables", () => {
  it("RLS is enabled on all five new tables", () => {
    for (const t of [
      "non_conformance_reports",
      "ncr_corrective_actions",
      "inspection_witness_invitations",
      "inspection_plan_templates",
      "inspection_plan_template_items",
    ]) {
      expect(migration2).toMatch(
        new RegExp(`alter table public\\.${t}\\s+enable row level security`),
      );
    }
  });

  it("every policy is membership-scoped; NCRs and actions have NO delete policy at all", () => {
    expect(migration2).toMatch(/current_org_ids\(\)/);
    expect(migration2).not.toMatch(/create policy ncr_delete/);
    expect(migration2).not.toMatch(/create policy nca_delete/);
    // Template hard-delete is admin + draft only, like the M1 plan rule.
    expect(migration2).toMatch(/public\.is_org_admin\(org_id\) and status = 'draft'/);
  });

  it("every child derives org_id from its parent by trigger — never from the client", () => {
    // NCR + witness invitation derive from the plan item; the corrective action
    // derives from its NCR; template items derive from the template.
    const derives = migration2.match(/new\.org_id\s*:=\s*(v_item_org|v_org|parent_org)/g) ?? [];
    expect(derives.length).toBeGreaterThanOrEqual(4);
  });

  it("children carry composite (id, org_id) FK tenant integrity to their parents", () => {
    expect(migration2).toMatch(/constraint ncr_id_org_key unique \(id, org_id\)/);
    expect(migration2).toMatch(/constraint nca_id_org_key unique \(id, org_id\)/);
    expect(migration2).toMatch(/constraint iwi_id_org_key unique \(id, org_id\)/);
    expect(migration2).toMatch(/constraint ipt_id_org_key unique \(id, org_id\)/);
    expect(migration2).toMatch(/references public\.non_conformance_reports \(id, org_id\)/);
    expect(migration2).toMatch(/references public\.inspection_plan_templates \(id, org_id\)/);
    expect(migration2).toMatch(/references public\.inspection_witness_invitations \(id, org_id\)/);
  });

  it("membership is checked BEFORE any state check can leak another org's document state", () => {
    // The 20261020 lesson, held on every new insert authority.
    for (const fn of ["tg_ncr_before_insert", "tg_nca_before_insert", "tg_iwi_before_insert"]) {
      const body = migration2.slice(migration2.indexOf(`function public.${fn}`));
      const member = body.indexOf("not a member of this organisation");
      expect(member, `${fn} must check membership`).toBeGreaterThan(0);
    }
    const ncrFn = migration2.slice(
      migration2.indexOf("function public.tg_ncr_before_insert"),
      migration2.indexOf("trigger tg_ncr_before_insert"),
    );
    expect(ncrFn.indexOf("not a member of this organisation")).toBeLessThan(
      ncrFn.indexOf("an NCR can only be raised against an issued inspection plan"),
    );
  });

  it("every new SECURITY DEFINER function pins search_path", () => {
    const defs = migration2.match(/security definer/g) ?? [];
    const pins = migration2.match(/set search_path = public/g) ?? [];
    expect(defs.length).toBeGreaterThan(0);
    expect(pins.length).toBeGreaterThanOrEqual(defs.length);
  });

  it("every delete-block trigger lets org teardown through (the 20261052 class)", () => {
    const escapes =
      migration2.match(/exists \(select 1 from public\.organizations where id = old\.org_id\)/g) ??
      [];
    // ncr, nca, iwi, ipt, ipti — five block triggers, five escapes.
    expect(escapes.length).toBeGreaterThanOrEqual(5);
  });

  it("teardown-path FKs are deferred no-action, never restrict; the only RESTRICTs are user accountability", () => {
    expect(migration2).toMatch(
      /ncr_source_signoff_org_fk[\s\S]{0,220}on delete no action deferrable initially deferred/,
    );
    expect(migration2).toMatch(
      /isg_witness_invitation_org_fk[\s\S]{0,220}on delete no action deferrable initially deferred/,
    );
    // raised_by + responsible_user_id → public.users (not on the org cascade
    // path — users has no org_id), the inspected_by rule from 20261076.
    const restricts = migration2Code.match(/on delete restrict/g) ?? [];
    expect(restricts).toHaveLength(2);
    expect(migration2Code).toMatch(
      /responsible_user_id\s+uuid references public\.users\(id\) on delete restrict/,
    );
    expect(migration2Code).toMatch(
      /raised_by\s+uuid not null references public\.users\(id\) on delete restrict/,
    );
  });

  it("M1's issue RPC is NOT touched — revision issue composes around it", () => {
    expect(migration2Code).not.toMatch(/create or replace function public\.issue_inspection_plan/);
  });
});

// ---------------------------------------------------------------------------
describe("M2 migration — the NCR lifecycle is DB-enforced", () => {
  it("an NCR is born open with clean provenance — a direct INSERT cannot mint a closed one", () => {
    expect(migration2).toMatch(/an NCR is raised open, then worked through its corrective actions/);
    const fn = migration2.slice(
      migration2.indexOf("function public.tg_ncr_before_insert"),
      migration2.indexOf("trigger tg_ncr_before_insert"),
    );
    expect(fn).toMatch(/new\.verified_by := null/);
    expect(fn).toMatch(/new\.verified_at := null/);
    expect(fn).toMatch(/new\.closure_comment := null/);
  });

  it("NCR-NNNN is allocated by the insert trigger — org-predicated, unique-backstopped, client value ignored", () => {
    expect(migration2).toMatch(/'NCR-' \|\| lpad\(/);
    expect(migration2).toMatch(/constraint ncr_org_reference_key unique \(org_id, reference\)/);
    const alloc = migration2.slice(migration2.indexOf("'NCR-' || lpad("));
    expect(alloc.slice(0, 400)).toMatch(/where org_id = v_item_org/);
  });

  it("an NCR can only be raised against a plan that has LEFT DRAFT", () => {
    expect(migration2).toMatch(/an NCR can only be raised against an issued inspection plan/);
  });

  it("the source sign-off, when named, must be a FAIL against the SAME item", () => {
    expect(migration2).toMatch(/the source sign-off must be a failed sign-off of this inspection item/);
    expect(migration2).toMatch(/s\.inspection_plan_item_id = new\.inspection_plan_item_id/);
    expect(migration2).toMatch(/s\.result = 'fail'/);
  });

  it("a responsible party is structurally required — member OR named subcontractor", () => {
    expect(migration2).toMatch(
      /constraint ncr_responsible_party_present[\s\S]{0,220}responsible_user_id is not null[\s\S]{0,220}responsible_subcontractor is not null/,
    );
  });

  it("identity is frozen at raise; substance is frozen outside open and never rides in on a transition", () => {
    expect(migration2).toMatch(/an NCR''s identity \(reference, item, source, raiser\) is frozen at raise/);
    expect(migration2).toMatch(/if old\.status <> 'open' or new\.status is distinct from old\.status then/);
    expect(migration2).toMatch(/an NCR under corrective action is frozen/);
  });

  it("the middle statuses are DERIVED: marker-gated so a raw JWT cannot PostgREST an NCR forward", () => {
    expect(migration2).toMatch(/crewflow\.ncr_cascade/);
    expect(migration2).toMatch(/this status is DERIVED from the corrective-action record, not set by hand/);
    // The marker names THIS row, so one cascade cannot wave another row through.
    expect(migration2).toMatch(/v_marker <> new\.id::text/);
  });

  it("the cascade captures FOUND BEFORE clearing the marker — the divergence guard must be live code", () => {
    // PERFORM set_config sets FOUND itself (set_config returns a row), so a
    // FOUND check placed after the clearing PERFORM would ALWAYS pass and a
    // decision could silently land on an action whose NCR was cancelled.
    const cascade = migration2.slice(
      migration2.indexOf("function public.tg_nca_cascade"),
      migration2.indexOf("trigger tg_nca_cascade_ins"),
    );
    const captures = cascade.match(/v_moved := found;/g) ?? [];
    expect(captures).toHaveLength(4);
    expect(cascade).not.toMatch(/if not found then/);
    // Every capture sits between the UPDATE and the marker-clearing PERFORM.
    for (const block of cascade.split("update public.non_conformance_reports").slice(1)) {
      const capture = block.indexOf("v_moved := found;");
      const clear = block.indexOf("perform set_config('crewflow.ncr_cascade', '', true)");
      expect(capture).toBeGreaterThan(-1);
      expect(capture).toBeLessThan(clear);
    }
  });

  it("closing pins the verifier to the session and structurally requires the closure comment", () => {
    expect(migration2).toMatch(/closing an NCR requires a closure comment describing the verification/);
    expect(migration2).toMatch(/new\.verified_at := now\(\)/);
    expect(migration2).toMatch(
      /constraint ncr_closure_provenance[\s\S]{0,240}closure_comment is not null/,
    );
    expect(migration2).toMatch(/closure verification is written by the close transition, not edited by hand/);
  });

  it("cancel is raiser-or-admin pre-decision, ADMIN ONLY post-decision; terminal states are final", () => {
    expect(migration2).toMatch(/only the raiser or an admin can cancel it/);
    expect(migration2).toMatch(/once a corrective action is approved, only an admin can cancel it/);
    expect(migration2).toMatch(/% is final/);
  });

  it("an NCR is never hard-deleted, by any role — cancelled is the retraction path", () => {
    expect(migration2).toMatch(/tg_ncr_block_delete/);
    expect(migration2).toMatch(/an NCR is quality evidence and cannot be deleted; cancel it instead/);
  });
});

// ---------------------------------------------------------------------------
describe("M2 migration — corrective-action decisions are write-once", () => {
  it("a decision exists iff its timestamp does (the material_requests CHECK shape)", () => {
    expect(migration2).toMatch(
      /constraint nca_decision_stamped check \(\(decision is null\) = \(decided_at is null\)\)/,
    );
  });

  it("the decision is write-once, admin-gated, and server-pinned", () => {
    expect(migration2).toMatch(/a corrective-action decision is write-once; it cannot be changed/);
    expect(migration2).toMatch(/only an owner or admin can accept or reject a corrective action/);
    const guard = migration2.slice(
      migration2.indexOf("function public.tg_nca_update_guard"),
      migration2.indexOf("trigger tg_nca_update_guard"),
    );
    expect(guard).toMatch(/new\.decided_at := now\(\)/);
  });

  it("a rejection must carry its reason — as a CHECK and in the trigger", () => {
    expect(migration2).toMatch(/constraint nca_rejection_reason_required/);
    expect(migration2).toMatch(/rejecting a corrective action requires a reason/);
  });

  it("the proposal itself is never edited — a different fix is a NEW proposal", () => {
    expect(migration2).toMatch(/a proposed corrective action is never edited; reject it and propose a new one/);
  });

  it("at most ONE undecided proposal per NCR (partial unique)", () => {
    expect(migration2).toMatch(
      /create unique index if not exists nca_one_pending_per_ncr_idx[\s\S]{0,140}where decision is null/,
    );
  });

  it("completion is write-once, comment-required, and only on an ALREADY-accepted action", () => {
    expect(migration2).toMatch(/corrective-action completion is write-once/);
    expect(migration2).toMatch(/only an accepted corrective action can be completed/);
    // old.decision, not new — completion cannot ride in with the decision.
    expect(migration2).toMatch(/if old\.decision is distinct from 'accepted' then/);
    expect(migration2).toMatch(/constraint nca_completion_pair/);
    expect(migration2).toMatch(/constraint nca_completion_requires_acceptance/);
  });

  it("corrective actions are never hard-deleted (audit trail)", () => {
    expect(migration2).toMatch(/a corrective action is part of the NCR audit trail and cannot be deleted/);
  });
});

// ---------------------------------------------------------------------------
describe("M2 migration — witness invitations are staff-recorded; portal writes DEFERRED", () => {
  it("only witness/approve control points on an ISSUED plan take an invitation", () => {
    expect(migration2).toMatch(/a witness can only be invited to a witness or approve control point/);
    expect(migration2).toMatch(/witnesses are invited against an issued plan/);
  });

  it("every recorded outcome is terminal; attendance provenance is server-pinned", () => {
    expect(migration2).toMatch(/a % witness invitation is final; invite them again instead/);
    const guard = migration2.slice(
      migration2.indexOf("function public.tg_iwi_update_guard"),
      migration2.indexOf("trigger tg_iwi_update_guard"),
    );
    expect(guard).toMatch(/new\.attendance_recorded_at := now\(\)/);
    expect(guard).toMatch(/attendance is recorded by the attended\/not-attended transition, not by hand/);
    expect(migration2).toMatch(/constraint iwi_attendance_stamped/);
  });

  it("the portal deferral is stated plainly, and NO token-holder write path exists", () => {
    expect(migration2).toMatch(/PORTAL WITNESS VISIBILITY IS DEFERRED, STATED PLAINLY/);
    // No portal/token surface anywhere in this lane — deferred means absent,
    // not half-built.
    for (const [name, src] of M2_APP_SOURCES) {
      expect(codeOnly(src), `${name} must carry no portal-token path`).not.toMatch(
        /portal_access_tokens|portalToken|token_hash|\/portal\//,
      );
    }
    expect(migration2Code).not.toMatch(/portal_access_tokens/);
  });

  it("a sign-off may honour an invitation — same ITEM, not cancelled, and frozen after insert", () => {
    expect(migration2).toMatch(/the witness invitation does not belong to this inspection item \(or was cancelled\)/);
    expect(migration2).toMatch(/w\.inspection_plan_item_id = new\.inspection_plan_item_id/);
    // The void-only frozen tuple gained the new column.
    const voidFn = migration2.slice(
      migration2.indexOf("function public.tg_signoff_void_only"),
      migration2.indexOf("4. ITP templates"),
    );
    expect(voidFn).toMatch(/new\.witness_invitation_id/);
    expect(voidFn).toMatch(/old\.witness_invitation_id/);
  });
});

// ---------------------------------------------------------------------------
describe("M2 migration — templates are versioned controlled documents", () => {
  it("at most one PUBLISHED version per (org, name) — a partial unique, not app discipline", () => {
    expect(migration2).toMatch(
      /create unique index if not exists ipt_one_published_per_name_idx[\s\S]{0,140}where status = 'published'/,
    );
  });

  it("publish is an atomic SECURITY INVOKER RPC with the item gate", () => {
    expect(migration2).toMatch(
      /create or replace function public\.publish_inspection_plan_template[\s\S]{0,200}security invoker/,
    );
    expect(migration2).toMatch(/cannot publish: a template needs at least one inspection item/);
    expect(migration2).toMatch(/only a draft template version can be published/);
  });

  it("published substance is immutable; items are frozen once the version leaves draft", () => {
    expect(migration2).toMatch(/a published template version is immutable; create a new version instead/);
    expect(migration2).toMatch(/cannot modify the items of a % template version/);
    expect(migration2).toMatch(/tg_ipti_block_delete_when_published/);
  });

  it("a non-draft version cannot be deleted, by any role", () => {
    expect(migration2).toMatch(/a % template version is a controlled document and cannot be deleted/);
  });

  it("template items mirror the plan item's structural hold-point rule", () => {
    expect(migration2).toMatch(/constraint ipti_hold_point_is_required check \(not is_hold_point or required\)/);
  });
});

// ---------------------------------------------------------------------------
describe("M2 migration — revision lineage (the RAMS 20261022 shape)", () => {
  it("root_plan_id is NOT NULL after a self-rooting backfill; revisions are unique per series", () => {
    expect(migration2).toMatch(/update public\.inspection_test_plans set root_plan_id = id/);
    expect(migration2).toMatch(/alter table public\.inspection_test_plans alter column root_plan_id set not null/);
    expect(migration2).toMatch(/create unique index if not exists itp_series_revision_idx/);
  });

  it("a series can never fork: one draft AND one issued per series (partial uniques)", () => {
    expect(migration2).toMatch(
      /itp_one_draft_per_series_idx[\s\S]{0,120}where status = 'draft'/,
    );
    expect(migration2).toMatch(
      /itp_one_issued_per_series_idx[\s\S]{0,120}where status = 'issued'/,
    );
  });

  it("lineage is identity: frozen from creation, and ALSO in the post-issue frozen tuple", () => {
    expect(migration2).toMatch(/a plan''s revision lineage is fixed at creation/);
    // Strict-superset tg_itp_lifecycle: the immutability tuple gained both columns.
    const lifecycle = migration2.slice(
      migration2.indexOf("create or replace function public.tg_itp_lifecycle"),
      migration2.indexOf("6. RLS"),
    );
    expect(lifecycle).toMatch(/new\.root_plan_id, new\.revision_number/);
    expect(lifecycle).toMatch(/old\.root_plan_id, old\.revision_number/);
  });

  it("a revision root must be a plan in the SAME org", () => {
    expect(migration2).toMatch(/is not an inspection plan in this organisation/);
  });

  it("the app's revision copy carries hold points forward and composes with the untouched issue RPC", () => {
    // createPlanRevision copies EVERY item column, is_hold_point included.
    const revision = actions.slice(actions.indexOf("export async function createPlanRevision"));
    expect(revision).toMatch(/root_plan_id: plan\.root_plan_id/);
    expect(revision).toMatch(/revision_number: plan\.revision_number \+ 1/);
    expect(revision).toMatch(/is_hold_point: i\.is_hold_point/);
    expect(revision).toMatch(/required: i\.required/);
    // The draft is issued later through the SAME RPC as any plan — no second
    // supersede path exists in this lane.
    expect(revision).not.toMatch(/status:\s*"(issued|superseded)"/);
  });
});

// ---------------------------------------------------------------------------
describe("M2 attachment widening — NCR evidence, DB CHECK and TS list together", () => {
  it("the TS list carries the new target", () => {
    expect(ATTACHMENT_TARGET_TABLES).toContain("non_conformance_reports");
  });

  it("the re-added CHECK preserves all 18 prior targets and adds the 19th", () => {
    expect(migration2).toMatch(/drop constraint %I/);
    expect(migration2).toMatch(/add constraint tenant_attachments_target_table_check/);
    const body = migration2.match(/target_table in \(([^)]+)\)/)!;
    const values = [...body[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(values).toContain("non_conformance_reports");
    for (const prior of [
      "customers", "jobs", "quotes", "invoices", "suppliers", "memberships", "leads",
      "snags", "site_diary_entries", "toolbox_talks", "site_reports", "assets",
      "asset_assignments", "asset_inspections", "asset_maintenance_cases",
      "asset_fuel_logs", "goods_received_notes", "inspection_signoffs",
    ]) {
      expect(values, `${prior} must survive the re-add`).toContain(prior);
    }
    expect(new Set(values).size).toBe(19);
  });

  it("the NCR detail page offers the attachments panel on the NCR target", () => {
    expect(ncrDetail).toMatch(/targetTable="non_conformance_reports"/);
  });
});

// ---------------------------------------------------------------------------
describe("M2 server actions — RLS-scoped, count-gated, never service-role", () => {
  it("no M2 source reaches for the service-role client", () => {
    for (const [name, src] of M2_APP_SOURCES) {
      expect(src, `${name} must not reach for the service-role client`).not.toMatch(
        /serviceClient\(|SUPABASE_SERVICE_ROLE_KEY|createServiceClient|createAdminClient/,
      );
    }
  });

  it("every mutation runs under requireOrgContext and pins the active org", () => {
    for (const [name, src] of [
      ["ncrs/actions.ts", ncrActions],
      ["templates/actions.ts", tplActions],
    ] as const) {
      expect(src, name).toMatch(/requireOrgContext\(\)/);
      expect(src, name).toMatch(/\.eq\("org_id", ctx\.org\.id\)/);
      expect(src, name).toMatch(/count: "exact"/);
      expect(src, name).toMatch(/if \(!count\)/);
    }
  });

  it("the NCR actions NEVER write a derived status — the DB cascade is the one writer", () => {
    expect(ncrActions).not.toMatch(
      /status:\s*"(corrective_action_proposed|corrective_action_approved|completed)"/,
    );
    // The two hand transitions that DO exist are close and cancel, from the
    // right predecessors only.
    expect(ncrActions).toMatch(/status: "closed"/);
    expect(ncrActions).toMatch(/\.eq\("status", "completed"\)/);
    expect(ncrActions).toMatch(/status: "cancelled"/);
  });

  it("the decision write targets only a still-undecided row; completion only an accepted, uncompleted one", () => {
    expect(ncrActions).toMatch(/\.is\("decision", null\)/);
    expect(ncrActions).toMatch(/\.eq\("decision", "accepted"\)/);
    expect(ncrActions).toMatch(/\.is\("completed_at", null\)/);
  });

  it("template instantiation refuses a non-published version and births a DRAFT plan", () => {
    expect(tplActions).toMatch(/template\.status !== "published"/);
    // The plan insert names no status at all — born draft, and the DB refuses
    // anything else anyway.
    const instantiate = tplActions.slice(tplActions.indexOf("export async function instantiateTemplate"));
    expect(instantiate).not.toMatch(/status:/);
  });

  it("the publish flow goes through the atomic RPC, never a hand-rolled archive+publish", () => {
    expect(tplActions).toMatch(/rpc\(\s*\n?\s*"publish_inspection_plan_template"/);
    expect(tplActions).not.toMatch(/status: "published"/);
  });
});

// ---------------------------------------------------------------------------
describe("M2 active-org pinning + loud reads on every new data layer", () => {
  it("EVERY read in ncrs/_data.ts and templates/_data.ts carries its own org pin", () => {
    for (const [name, src] of [
      ["ncrs/_data.ts", ncrData],
      ["templates/_data.ts", tplData],
    ] as const) {
      const code = codeOnly(src);
      const selects = code.match(/\.select\(/g) ?? [];
      const orgPins = code.match(/\.eq\("org_id", orgId\)/g) ?? [];
      expect(selects.length, `${name} should have reads`).toBeGreaterThan(0);
      expect(
        orgPins.length,
        `${name}: a read appeared without its own .eq("org_id", orgId) pin`,
      ).toBe(selects.length);
    }
  });

  it("every rejected read THROWS (an empty NCR register on a failed read claims the works conform)", () => {
    for (const [name, src] of [
      ["ncrs/_data.ts", ncrData],
      ["templates/_data.ts", tplData],
    ] as const) {
      expect(src, name).toMatch(/from "@\/lib\/supabase\/read-failure"/);
      const throws = src.match(/throw readFailure\(/g) ?? [];
      const selects = codeOnly(src).match(/\.select\(/g) ?? [];
      expect(throws.length, `${name} must throw on every read`).toBeGreaterThanOrEqual(selects.length);
    }
  });

  it("a cross-org NCR or template is INDISTINGUISHABLE from a missing one", () => {
    expect(ncrDetail).toMatch(/if \(!loaded\) notFound\(\)/);
    expect(tplDetail).toMatch(/if \(!loaded\) notFound\(\)/);
  });

  it("the registers and detail pages pass ctx.org.id into the data layer", () => {
    expect(ncrRegister).toMatch(/listNcrs\(ctx\.org\.id\)/);
    expect(ncrDetail).toMatch(/getNcr\(ctx\.org\.id, /);
    expect(tplRegister).toMatch(/listTemplates\(ctx\.org\.id\)/);
    expect(tplDetail).toMatch(/getTemplate\(ctx\.org\.id, /);
  });
});

// ---------------------------------------------------------------------------
describe("M2 evidence PDF — issued-only, private, active-org letterhead", () => {
  it("a draft returns 409 — there is no numbered, frozen record to produce", () => {
    expect(pdfRoute).toMatch(/plan\.status === "draft"/);
    expect(pdfRoute).toMatch(/\{ status: 409 \}/);
  });

  it("the response is private and never cached", () => {
    expect(pdfRoute).toMatch(/"Cache-Control": "private, no-store"/);
  });

  it("every read is active-org pinned, letterhead included — the header can never name another company", () => {
    expect(pdfRoute).toMatch(/requireOrgContext\(\)/);
    expect(pdfRoute).toMatch(/getPlan\(ctx\.org\.id, id\)/);
    expect(pdfRoute).toMatch(/listPlanNcrs\(ctx\.org\.id, /);
    expect(pdfRoute).toMatch(/\.eq\("id", ctx\.org\.id\)/);
    // A missing plan (or one in the other company) is a 404, not a leak.
    expect(pdfRoute).toMatch(/\{ status: 404 \}/);
  });

  it("the PDF document is pure presentation — no client, no fetch, no secrets", () => {
    expect(pdfDoc).not.toMatch(/createClient|fetch\(|process\.env/);
  });
});

// ---------------------------------------------------------------------------
describe("M2 — no money, no AI, snags untouched", () => {
  it("the M2 migration writes nothing to finances and touches no monetary table or column", () => {
    expect(migration2Code).not.toMatch(/insert into public\.finances/i);
    expect(migration2Code).not.toMatch(/\bpublic\.finances\b/);
    expect(migration2Code).not.toMatch(
      /\bpublic\.invoices\b|\bpublic\.invoice_payments\b|\bpublic\.supplier_bills\b/,
    );
    expect(migration2Code).not.toMatch(/_pence\b|numeric\(\d+, ?2\)/);
  });

  it("the snags domain is not touched — an NCR is not a snag", () => {
    // 'snags' survives only as a preserved attachment-target value.
    expect(migration2Code).not.toMatch(/(from|join|references|into|update|alter table)\s+(public\.)?snags\b/i);
    const hits = migration2Code.match(/\bsnags\b/g) ?? [];
    expect(hits).toHaveLength(1);
    expect(migration2Code).toMatch(/'snags',/);
  });

  it("no M2 source touches money or AI", () => {
    const sources: Array<[string, string]> = [
      ...M2_APP_SOURCES,
      ["ncr.ts", ncrDomain],
      ["templates.ts", tplDomain],
      ["itp-pdf.tsx", pdfDoc],
      ["migration2", migration2],
    ];
    for (const [name, src] of sources) {
      expect(codeOnly(src), `${name} must not touch money`).not.toMatch(
        /amount_pence|total_pence|formatGbp|\bfinances\b|posting/i,
      );
      expect(codeOnly(src), `${name} must contain no AI`).not.toMatch(
        /anthropic|openai|@\/lib\/ai\/|claude-|\bllm\b|ai_invocations|governor/i,
      );
    }
  });
});

// ---------------------------------------------------------------------------
describe("mobile — this is used on a phone, in gloves", () => {
  it("every interactive control in the item card meets the 44px touch target", () => {
    const controls = itemCard.match(/(?:<button|<summary|<label|<input|<textarea|<select)[\s\S]{0,400}?className="([^"]*)"/g) ?? [];
    expect(controls.length).toBeGreaterThan(5);
    // Radio/checkbox inputs use h-5 w-5 inside a min-h-[44px] label, which is
    // the accessible pattern; assert the wrapper labels carry it.
    const labelWrappers = itemCard.match(/<label[^>]*className="flex min-h-\[44px\]/g) ?? [];
    const buttons = itemCard.match(/<button[\s\S]{0,300}?className="([^"]*)"/g) ?? [];
    for (const b of buttons) expect(b).toMatch(/min-h-\[44px\]/);
    expect(labelWrappers.length + buttons.length).toBeGreaterThan(0);
  });

  it("the item layout is a card at every width, not a table that overflows a 375px screen", () => {
    // Deliberate divergence from the RAMS table+cards pair — see _item-card.tsx.
    expect(itemCard).not.toMatch(/<table|min-w-\[\d+px\]/);
    expect(itemCard).toMatch(/375px/);
  });

  it("form inputs use text-base so iOS does not zoom on focus", () => {
    expect(itemCard).toMatch(/text-base/);
    expect(detail).toMatch(/text-base/);
  });
});

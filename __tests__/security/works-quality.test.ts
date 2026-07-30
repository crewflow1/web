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

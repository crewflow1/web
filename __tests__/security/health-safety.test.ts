import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Health & Safety (RAMS) — security source-contracts. The runtime behaviour is
 * proven against real Postgres in __tests__/integration/health-safety + rls; these
 * lock the load-bearing rules at the source so a regression fails CI.
 */

const root = join(__dirname, "..", "..");
const migration = readFileSync(join(root, "supabase/migrations/20261018000000_health_safety_rams.sql"), "utf8");
const actions = readFileSync(join(root, "app/(app)/health-safety/actions.ts"), "utf8");
const data = readFileSync(join(root, "app/(app)/health-safety/_data.ts"), "utf8");
const permMig = readFileSync(join(root, "supabase/migrations/20261019000000_health_safety_permits.sql"), "utf8");
const permActions = readFileSync(join(root, "app/(app)/health-safety/permits/actions.ts"), "utf8");
const permData = readFileSync(join(root, "app/(app)/health-safety/permits/_data.ts"), "utf8");
const ackMig = readFileSync(join(root, "supabase/migrations/20261020000000_health_safety_acknowledgements.sql"), "utf8");
const ackActions = readFileSync(join(root, "app/(app)/health-safety/signoff-actions.ts"), "utf8");
const ramsPdfRoute = readFileSync(join(root, "app/api/health-safety/[id]/pdf/route.ts"), "utf8");
const permitPdfRoute = readFileSync(join(root, "app/api/health-safety/permits/[id]/pdf/route.ts"), "utf8");
const ramsPdfLib = readFileSync(join(root, "lib/pdf/rams-pdf.tsx"), "utf8");
const permitPdfLib = readFileSync(join(root, "lib/pdf/permit-pdf.tsx"), "utf8");
const hardening = readFileSync(join(root, "supabase/migrations/20261021000000_health_safety_evidence_hardening.sql"), "utf8");
const revising = readFileSync(join(root, "supabase/migrations/20261022000000_health_safety_rams_revisioning.sql"), "utf8");

describe("migration — tenant isolation + immutability are DB-enforced", () => {
  it("RLS is enabled on both RAMS tables", () => {
    expect(migration).toMatch(/alter table public\.risk_assessments\s+enable row level security/);
    expect(migration).toMatch(/alter table public\.risk_assessment_hazards enable row level security/);
  });
  it("every policy is scoped by org membership (current_org_ids) / is_org_admin", () => {
    expect(migration).toMatch(/current_org_ids\(\)/);
    expect(migration).toMatch(/is_org_admin\(org_id\)/); // admin-only hard delete on the header
  });
  it("hazards carry a composite-FK tenant integrity to their parent (id, org_id)", () => {
    expect(migration).toMatch(/references public\.risk_assessments \(id, org_id\)/);
    expect(migration).toMatch(/unique \(id, org_id\)/);
  });
  it("a hazard's org_id is trigger-derived from its parent, never trusted from the client", () => {
    expect(migration).toMatch(/tg_rah_derive_org/);
    expect(migration).toMatch(/new\.org_id\s*:=\s*parent_org/);
  });
  it("the optional job link is validated same-org", () => {
    expect(migration).toMatch(/tg_ra_validate_job_org/);
    expect(migration).toMatch(/does not belong to this organisation/);
  });
  it("issued records are immutable at the DB (content frozen, forward-only status)", () => {
    expect(migration).toMatch(/tg_ra_immutable_when_issued/);
    expect(migration).toMatch(/is immutable; raise a new revision instead/);
    // the reference/issue CHECKs that stop a draft skipping straight to a terminal state
    expect(migration).toMatch(/\(status = 'draft'\) = \(reference is null\)/);
  });
  it("every SECURITY DEFINER function pins search_path (no mutable-path escalation)", () => {
    const defs = migration.match(/security definer/g) ?? [];
    const pins = migration.match(/set search_path = public/g) ?? [];
    expect(defs.length).toBeGreaterThan(0);
    expect(pins.length).toBeGreaterThanOrEqual(defs.length);
  });
});

describe("server actions — RLS-scoped, never service-role", () => {
  it("all writes go through the tenant (user-JWT) client, never the service-role client", () => {
    expect(actions).toMatch(/from "@\/lib\/supabase\/server"/);
    // match CODE identifiers only — prose like "service-role" in a doc comment is fine
    expect(actions).not.toMatch(/serviceClient\(|SUPABASE_SERVICE_ROLE_KEY|createServiceClient|createAdminClient/);
    expect(data).not.toMatch(/serviceClient\(|SUPABASE_SERVICE_ROLE_KEY|createServiceClient|createAdminClient/);
  });
  it("mutations are gated by requireOrgContext + org_id, and count-checked (no false success)", () => {
    expect(actions).toMatch(/requireOrgContext\(\)/);
    expect(actions).toMatch(/\.eq\("org_id", ctx\.org\.id\)/);
    expect(actions).toMatch(/if \(!count\)/);
  });
  it("issuing re-checks readiness (canIssue) before allocating a number", () => {
    expect(actions).toMatch(/canIssue\(/);
    expect(actions).toMatch(/next_ra_number/);
  });
});

describe("permits (M2) — lifecycle + evidence integrity are DB-enforced", () => {
  it("RLS is enabled + membership-scoped on both permit tables", () => {
    expect(permMig).toMatch(/alter table public\.permits_to_work\s+enable row level security/);
    expect(permMig).toMatch(/alter table public\.permit_conditions enable row level security/);
    expect(permMig).toMatch(/current_org_ids\(\)/);
    expect(permMig).toMatch(/is_org_admin\(org_id\)/);
  });
  it("conditions carry composite-FK tenant integrity + a trigger-derived org_id", () => {
    expect(permMig).toMatch(/references public\.permits_to_work \(id, org_id\)/);
    expect(permMig).toMatch(/tg_permit_condition_derive_org/);
    expect(permMig).toMatch(/new\.org_id\s*:=\s*parent_org/);
  });
  it("job + RAMS links are validated same-org (and same-job)", () => {
    expect(permMig).toMatch(/tg_permit_validate_links/);
    expect(permMig).toMatch(/does not belong to this organisation/);
    expect(permMig).toMatch(/belongs to a different job/);
  });
  it("the lifecycle trigger enforces the transition matrix, the issue-gate + immutability", () => {
    expect(permMig).toMatch(/tg_permit_lifecycle/);
    expect(permMig).toMatch(/invalid permit transition/);
    expect(permMig).toMatch(/required condition\(s\) not confirmed/);
    expect(permMig).toMatch(/an issued permit is immutable/);
  });
  it("[hardening] the lifecycle trigger fires on INSERT too (no born-issued permit)", () => {
    expect(permMig).toMatch(/before insert or update on public\.permits_to_work/);
    expect(permMig).toMatch(/a permit is created as a draft/);
  });
  it("[hardening] a live permit needs a validity window + an ISSUED RAMS", () => {
    expect(permMig).toMatch(/permits_window_required_when_live/);
    expect(permMig).toMatch(/the linked risk assessment is .* \(must be issued\)/);
  });
  it("[hardening] confirmations are frozen + conditions cannot be deleted / reparented once live", () => {
    expect(permMig).toMatch(/a confirmed control cannot be un-confirmed/);
    expect(permMig).toMatch(/the confirmation record \(who\/when\) is immutable/);
    expect(permMig).toMatch(/cannot be moved to another permit/);
    expect(permMig).toMatch(/tg_permit_condition_block_delete/);
  });
  it("[hardening] next_ptw_number gates the caller to their own org", () => {
    expect(permMig).toMatch(/forbidden: not a member of organisation/);
  });
  it("the validity window is CHECK-ordered + every definer pins search_path", () => {
    expect(permMig).toMatch(/valid_until > valid_from/);
    const defs = permMig.match(/security definer/g) ?? [];
    const pins = permMig.match(/set search_path = public/g) ?? [];
    expect(defs.length).toBeGreaterThan(0);
    expect(pins.length).toBeGreaterThanOrEqual(defs.length);
  });
  it("permit actions are tenant-client-only, requireOrgContext-gated, count-checked", () => {
    expect(permActions).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(permActions).not.toMatch(/serviceClient\(|SUPABASE_SERVICE_ROLE_KEY|createServiceClient|createAdminClient/);
    expect(permData).not.toMatch(/serviceClient\(|SUPABASE_SERVICE_ROLE_KEY|createServiceClient|createAdminClient/);
    expect(permActions).toMatch(/requireOrgContext\(\)/);
    expect(permActions).toMatch(/\.eq\("org_id", ctx\.org\.id\)/);
    expect(permActions).toMatch(/if \(!count\)/);
    expect(permActions).toMatch(/canIssue\(/);
  });
});

describe("operative sign-off (M3) — append-only, tamper-proof, self-signed evidence", () => {
  it("RLS: members read; insert only AS THEMSELVES; NO update or delete policy", () => {
    expect(ackMig).toMatch(/alter table public\.safety_acknowledgements enable row level security/);
    expect(ackMig).toMatch(/user_id = auth\.uid\(\)/);
    expect(ackMig).not.toMatch(/for delete/);      // non-erasable evidence
    expect(ackMig).not.toMatch(/for update/);      // append-only
  });
  it("append-only trigger blocks UPDATE even for the service role", () => {
    expect(ackMig).toMatch(/tg_safety_ack_no_update/);
    expect(ackMig).toMatch(/append-only and cannot be modified/);
  });
  it("validate trigger: membership-first, session-bound, timestamp-pinned, version-anchored, live-only", () => {
    expect(ackMig).toMatch(/tg_safety_ack_validate/);
    expect(ackMig).toMatch(/signer is not a member/);
    expect(ackMig).toMatch(/can only acknowledge as themselves/);
    expect(ackMig).toMatch(/new\.acknowledged_at := now\(\)/);
    expect(ackMig).toMatch(/version mismatch/);
    expect(ackMig).toMatch(/outside its validity window/);
  });
  it("org_id derived from the subject (anti cross-tenant) + statement/name non-empty", () => {
    expect(ackMig).toMatch(/new\.org_id := s_org/);
    expect(ackMig).toMatch(/length\(trim\(signed_name\)\) > 0/);
  });
  it("the sign-off action is tenant-client-only + requireOrgContext-gated + signs as auth user", () => {
    expect(ackActions).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(ackActions).not.toMatch(/serviceClient\(|SUPABASE_SERVICE_ROLE_KEY|createServiceClient|createAdminClient/);
    expect(ackActions).toMatch(/requireOrgContext\(\)/);
    expect(ackActions).toMatch(/user_id: user\.id/);
  });
});

describe("evidence PDF (M4) — auth-gated, RLS-scoped, issued-only, no internal leak", () => {
  it("both PDF routes require org context + use the tenant client (never service-role)", () => {
    for (const r of [ramsPdfRoute, permitPdfRoute]) {
      expect(r).toMatch(/requireOrgContext\(\)/);
      expect(r).toMatch(/from "@\/lib\/supabase\/server"/);
      expect(r).not.toMatch(/serviceClient\(|SUPABASE_SERVICE_ROLE_KEY|createServiceClient|createAdminClient/);
    }
  });
  it("a draft (unissued) document produces no evidence PDF", () => {
    expect(ramsPdfRoute).toMatch(/status === "draft"/);
    expect(ramsPdfRoute).toMatch(/Not issued/);
    expect(permitPdfRoute).toMatch(/status === "draft"/);
  });
  it("the PDF is private-cached (no shared cache of an evidence document)", () => {
    expect(ramsPdfRoute).toMatch(/private, no-store/);
    expect(permitPdfRoute).toMatch(/private, no-store/);
  });
  it("the RAMS PDF component references no cost/margin/price data field", () => {
    // (data fields — not CSS margin*): a cost/margin/price leak into evidence
    expect(ramsPdfLib).not.toMatch(/profit|unit_price|day_rate|_cost|cost_|net_amount|vat_/i);
  });
});

describe("evidence-integrity hardening (M5, final adversarial review)", () => {
  it("[P0] a RAMS is born a draft — a direct INSERT can never mint an issued record", () => {
    expect(hardening).toMatch(/tg_ra_lifecycle/);
    expect(hardening).toMatch(/before insert or update on public\.risk_assessments/);
    expect(hardening).toMatch(/a risk assessment is created as a draft/);
  });
  it("[P0] the issue-gate (assessor + >=1 hazard) is DB-enforced, not only in the action", () => {
    expect(hardening).toMatch(/cannot issue: a risk assessment needs a named assessor/);
    expect(hardening).toMatch(/needs at least one hazard/);
    expect(hardening).toMatch(/risk_assessment_hazards\s*\n?\s*where risk_assessment_id = new\.id/);
  });
  it("[P1] issue provenance is pinned server-side on BOTH tables (no forged/back-dated issuer)", () => {
    // RAMS pins in tg_ra_lifecycle; permits pin in a dedicated tg_permit_pin_provenance.
    expect(hardening).toMatch(/new\.issued_by := auth\.uid\(\)/);
    expect(hardening).toMatch(/new\.issued_at := now\(\)/);
    expect(hardening).toMatch(/tg_permit_pin_provenance/);
    // and only for real (JWT) callers — the trusted service role keeps explicit values.
    expect(hardening).toMatch(/auth\.uid\(\) is not null/);
  });
  it("[P1] issued evidence is non-deletable via a TRIGGER (role-independent, not just RLS)", () => {
    expect(hardening).toMatch(/tg_ra_block_delete_when_issued/);
    expect(hardening).toMatch(/tg_permit_block_delete_when_issued/);
    expect(hardening).toMatch(/before delete on public\.risk_assessments/);
    expect(hardening).toMatch(/before delete on public\.permits_to_work/);
    expect(hardening).toMatch(/an issued risk assessment is evidence and cannot be deleted/);
    // org teardown (cascade) is still allowed — the org row is gone by then.
    expect(hardening).toMatch(/exists \(select 1 from public\.organizations where id = old\.org_id\)/);
  });
  it("[P1] the draft-only DELETE policies remain as defence-in-depth on the JWT path", () => {
    expect(hardening).toMatch(/risk_assessments_delete[\s\S]*?is_org_admin\(org_id\) and status = 'draft'/);
    expect(hardening).toMatch(/permits_delete[\s\S]*?is_org_admin\(org_id\) and status = 'draft'/);
  });
  it("[P2] next_ra_number gates the caller to their own org (no cross-org count oracle)", () => {
    expect(hardening).toMatch(/next_ra_number/);
    expect(hardening).toMatch(/forbidden: not a member of organisation/);
    expect(hardening).toMatch(/target_org not in \(select public\.current_org_ids\(\)\)/);
  });
  it("every SECURITY DEFINER in the hardening migration pins search_path", () => {
    const defs = hardening.match(/security definer/g) ?? [];
    const pins = hardening.match(/set search_path = public/g) ?? [];
    expect(defs.length).toBeGreaterThan(0);
    expect(pins.length).toBeGreaterThanOrEqual(defs.length);
  });
  it("[P2] the permit evidence PDF shows a derived status (never a stale 'active' when expired)", () => {
    expect(permitPdfRoute).toMatch(/effectiveStatus\(/);
    expect(permitPdfLib).toMatch(/effective_status/);
    expect(permitPdfLib).toMatch(/EXPIRED/);
  });
  it("[P2] both PDF routes label the header with the SUBJECT's own org, not the active org", () => {
    expect(permitPdfRoute).toMatch(/\.eq\("id", permit\.org_id\)/);
    expect(ramsPdfRoute).toMatch(/\.eq\("id", ra\.org_id\)/);
  });
});

describe("RAMS revisioning (M6a) — lineage + one-current + atomic supersede are DB-enforced", () => {
  it("the series has DB-enforced lineage (root + revision) and lineage integrity", () => {
    expect(revising).toMatch(/root_risk_assessment_id/);
    expect(revising).toMatch(/revision_number/);
    expect(revising).toMatch(/tg_ra_revision_integrity/);
    expect(revising).toMatch(/a risk assessment cannot supersede itself/);
    expect(revising).toMatch(/must be another revision of the same series/);
  });
  it("exactly one issued + one draft per series (partial unique indexes)", () => {
    expect(revising).toMatch(/unique index[\s\S]*?root_risk_assessment_id\)\s*where status = 'issued'/);
    expect(revising).toMatch(/unique index[\s\S]*?root_risk_assessment_id\)\s*where status = 'draft'/);
    expect(revising).toMatch(/\(root_risk_assessment_id, revision_number\)/);
  });
  it("issuing a revision is ATOMIC (supersede current + promote draft in one RPC)", () => {
    expect(revising).toMatch(/function public\.issue_rams_revision/);
    expect(revising).toMatch(/for update/);
    expect(revising).toMatch(/set status = 'superseded'\s*\n?\s*where root_risk_assessment_id = v_root and status = 'issued'/);
    expect(revising).toMatch(/security invoker/); // RLS + M5 triggers still gate the caller
  });
  it("lineage fields are frozen once issued (immutability list extended)", () => {
    expect(revising).toMatch(/new\.root_risk_assessment_id, new\.revision_number/);
  });
  it("the action issues a revision via the atomic RPC, not a bare status flip", () => {
    expect(actions).toMatch(/issue_rams_revision/);
    expect(actions).toMatch(/createRamsRevision/);
    // still tenant-client only (no service-role) for the revision path
    expect(actions).not.toMatch(/serviceClient\(|SUPABASE_SERVICE_ROLE_KEY|createServiceClient|createAdminClient/);
  });
});

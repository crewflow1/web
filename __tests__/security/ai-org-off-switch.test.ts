import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Per-company AI off switch (migration 20261366000000, gap G-13) — trust-boundary
 * pins over SOURCE TEXT. The behaviour is proven on real Postgres in
 * __tests__/integration/ai/org-ai-switch.test.ts; these keep the shape from drifting.
 */
const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const exec = (sql: string) =>
  sql.split("\n").map((l) => (l.includes("--") ? l.slice(0, l.indexOf("--")) : l)).join("\n");

const MIG = exec(read("supabase/migrations/20261366000000_ai_org_off_switch.sql"));

describe("20261366000000 · AI off switch migration", () => {
  it("is enforced inside ai_reserve_invocation, after the per-org lock and BEFORE the ceiling", () => {
    const fn = MIG.slice(MIG.indexOf("create or replace function public.ai_reserve_invocation"));
    const lock = fn.indexOf("pg_advisory_xact_lock(hashtext('ai_budget_reservation')");
    const sw = fn.indexOf("ai_org_switches");
    const ceil = fn.indexOf("ai_org_budget_ceilings");
    expect(lock).toBeGreaterThan(-1);
    expect(sw).toBeGreaterThan(lock);
    expect(ceil).toBeGreaterThan(sw);
    expect(fn).toMatch(/ai_enabled is false/);
    expect(fn).toMatch(/'ai_disabled'/);
  });

  it("absent row means ON, and the platform/org ceiling logic is otherwise untouched", () => {
    expect(MIG).toMatch(/s\.ai_enabled is false/); // only an explicit false blocks
    expect(MIG).toContain("'platform_ceiling'");
    expect(MIG).toContain("v_plat_ceiling");
  });

  it("owner RPC is SECURITY DEFINER, guards with current_org_ids() + owner membership, raises 42501", () => {
    const fn = MIG.slice(
      MIG.indexOf("create or replace function public.ai_owner_set_ai_enabled"),
      MIG.indexOf("revoke all on function public.ai_owner_set_ai_enabled"),
    );
    expect(fn).toMatch(/security definer/);
    expect(fn).toMatch(/set search_path to ''/);
    expect(fn).toMatch(/current_org_ids\(\)/);
    expect(fn).toMatch(/m\.role = 'owner'/);
    expect(fn).toMatch(/errcode = '42501'/);
    expect(fn).toMatch(/auth\.uid\(\)/);
    // ON requires an active (not held/suspended) company; OFF does not.
    expect(fn).toMatch(/if p_enabled and not public\.org_is_writable\(p_org_id\)/);
  });

  it("grants: owner RPC to authenticated (not anon/public); HQ RPC service-role only; tables locked", () => {
    expect(MIG).toMatch(/revoke all on function public\.ai_owner_set_ai_enabled\(uuid, boolean\) from public, anon;/);
    expect(MIG).toMatch(/grant execute on function public\.ai_owner_set_ai_enabled\(uuid, boolean\) to authenticated, service_role;/);
    expect(MIG).toMatch(/revoke all on function public\.ai_hq_set_ai_enabled\(uuid, boolean, uuid\) from public, anon, authenticated;/);
    expect(MIG).toMatch(/grant execute on function public\.ai_hq_set_ai_enabled\(uuid, boolean, uuid\) to service_role;/);
    expect(MIG).toMatch(/revoke all on table public\.ai_org_switches from anon, authenticated, public;/);
    expect(MIG).toMatch(/grant select on table public\.ai_org_switches to authenticated;/);
    expect(MIG).not.toMatch(/grant [^;]*(insert|update|delete)[^;]* on table public\.ai_org_switches to authenticated/);
    expect(MIG).not.toMatch(/to authenticated[^;]*ai_org_switch_audit|ai_org_switch_audit to authenticated/);
    expect(MIG).toMatch(/enable row level security/);
  });

  it("every change writes an audit row in the same function as the switch write", () => {
    const writes = MIG.match(/insert into public\.ai_org_switches/g) ?? [];
    const audits = MIG.match(/insert into public\.ai_org_switch_audit/g) ?? [];
    expect(writes.length).toBe(2);
    expect(audits.length).toBe(2);
  });

  it("the reserve function is re-granted to service_role only", () => {
    expect(MIG).toMatch(/revoke all on function public\.ai_reserve_invocation\([^)]*\) from public, anon, authenticated;/);
    expect(MIG).toMatch(/grant execute on function public\.ai_reserve_invocation\([^)]*\) to service_role;/);
  });

  it("rollback restores the previous reserve body and drops the objects", () => {
    const rb = read("docs/engineering/release/rollback-20261366000000.sql");
    expect(rb).not.toContain("ai_org_switches s");
    expect(rb).toContain("drop table if exists public.ai_org_switches;");
    expect(rb).toContain("drop function if exists public.ai_owner_set_ai_enabled");
  });
});

describe("app layer", () => {
  it("governor maps ai_disabled and raises no spend alert for it", () => {
    const g = read("lib/ai/governor.ts");
    expect(g).toContain('row.block_reason === "ai_disabled"');
    expect(g).toMatch(/reservation\.reason === "ceiling" \|\| reservation\.reason === "platform_ceiling"/);
  });

  it("owner action takes the org from the session, checks owner, and uses the user-JWT client", () => {
    const a = read("app/(app)/settings/ai-features/actions.ts");
    expect(a).toContain("requireOrgContext");
    expect(a).toContain('role !== "owner"');
    expect(a).toContain("await createClient()");
    expect(a).not.toContain("createAdminClient");
    expect(a).not.toMatch(/formData\.get\("org/);
  });

  it("HQ action is super-admin gated and uses the service-role RPC", () => {
    const a = read("app/admin/ai-costs/actions.ts");
    const fn = a.slice(a.indexOf("export async function setOrgAiEnabledAction"));
    expect(fn).toContain("await requireAdmin()");
    expect(fn).toContain("ai_hq_set_ai_enabled");
  });

  it("new tables are classified in the GDPR org-table registry", () => {
    const j = read("lib/gdpr/org-tables.json");
    expect(j).toContain('"ai_org_switches"');
    expect(j).toContain('"ai_org_switch_audit"');
  });
});

import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * Maintenance cases + costs — real-Postgres proof (20261002000000).
 *
 * Proves the M5a invariants against a live database (triggers fire for every
 * role; RLS proven with anon):
 *   - G1 completed requires work evidence; G3 cancelled requires a reason;
 *   - G4 a completed case is FROZEN (status + evidence), even for service role;
 *   - G2 return-to-service is refused while the LINKED safety fail is uncleared,
 *     allowed after a LINKED passing re-inspection, and allowed under an ACTIVE
 *     admin override (the SHARED clearing predicate — same as the custody guard);
 *   - G0 same-org refs (asset / supplier / source inspection / assignee) and the
 *     costs satellite's cross-org case smuggle are rejected;
 *   - the costs satellite is invisible to anon (RLS);
 *   - the widened attachment CHECK accepts 'asset_maintenance_cases', still
 *     accepts every prior target (spot: 'assets', 'asset_inspections'), and
 *     rejects bogus.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Q extends PromiseLike<Res<Row[]>> {
  eq(k: string, v: unknown): Q;
  maybeSingle(): PromiseLike<Res<Row>>;
  single(): PromiseLike<Res<Row>>;
}
interface Upd extends PromiseLike<Res<Row[]>> {
  eq(k: string, v: unknown): Upd;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(c?: string): { single(): PromiseLike<Res<Row>> };
}
interface Del extends PromiseLike<Res<null>> {
  eq(k: string, v: unknown): Del;
}
interface Table {
  select(c?: string): Q;
  insert(r: Row | Row[]): Ins;
  update(r: Row): Upd;
  delete(): Del;
}
interface Client {
  from(t: string): Table;
}
const db = (c: unknown) => c as unknown as Client;

const TAG = `it-mnt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function mkOrg(slug: string): Promise<string> {
  const { data, error } = await db(serviceClient())
    .from("organizations").insert({ name: `Mnt ${slug}`, slug: `${TAG}-${slug}` }).select("id").single();
  expect(error, error?.message).toBeNull();
  return String(data?.id ?? "");
}
async function mkAsset(org: string): Promise<string> {
  const { data, error } = await db(serviceClient())
    .from("assets").insert({ org_id: org, name: "maintained asset" }).select("id").single();
  expect(error, error?.message).toBeNull();
  return String(data?.id ?? "");
}
async function mkFail(org: string, asset: string): Promise<string> {
  const { data, error } = await db(serviceClient()).from("asset_inspections").insert({
    org_id: org, asset_id: asset, title: "safety", status: "issued",
    safety_critical: true, outcome: "fail", snapshot: { frozen: true },
    inspected_at: "2026-01-01T00:00:00.000Z",
  }).select("id").single();
  expect(error, error?.message).toBeNull();
  return String(data?.id ?? "");
}
function mkCase(org: string, asset: string, over: Row = {}) {
  return db(serviceClient()).from("asset_maintenance_cases").insert({
    org_id: org, asset_id: asset, case_type: "breakdown", title: "burst hose", status: "reported", ...over,
  }).select("id").single();
}
function upd(id: string, patch: Row) {
  return db(serviceClient()).from("asset_maintenance_cases").update(patch).eq("id", id);
}

describeIntegration("asset_maintenance_cases · state invariants + costs privacy", () => {
  let orgA = "";
  let orgB = "";
  let assetA = "";
  let assetB = "";

  beforeAll(async () => {
    orgA = await mkOrg("a");
    orgB = await mkOrg("b");
    assetA = await mkAsset(orgA);
    assetB = await mkAsset(orgB);
  });
  afterAll(async () => {
    if (orgA) await db(serviceClient()).from("organizations").delete().eq("id", orgA);
    if (orgB) await db(serviceClient()).from("organizations").delete().eq("id", orgB);
  });

  it("G1: completing without work evidence is refused; with evidence it completes", async () => {
    const c = await mkCase(orgA, assetA);
    const id = String(c.data?.id);
    const bare = await upd(id, { status: "completed" });
    expect(bare.error?.message ?? "").toMatch(/work evidence/i);

    const ok = await upd(id, {
      status: "completed", work_performed: "Replaced hose, pressure tested",
      completed_at: new Date().toISOString(),
    });
    expect(ok.error, ok.error?.message).toBeNull();
  });

  it("G4: a completed case is frozen — status and evidence — even as service role", async () => {
    const c = await mkCase(orgA, assetA);
    const id = String(c.data?.id);
    await upd(id, { status: "completed", work_performed: "done", completed_at: new Date().toISOString() });

    const reopen = await upd(id, { status: "in_progress" });
    expect(reopen.error?.message ?? "").toMatch(/is frozen/i);
    const rewrite = await upd(id, { work_performed: "history laundering" });
    expect(rewrite.error?.message ?? "").toMatch(/is frozen/i);
  });

  it("G3: cancelling requires a reason", async () => {
    const c = await mkCase(orgA, assetA);
    const id = String(c.data?.id);
    const bare = await upd(id, { status: "cancelled" });
    expect(bare.error?.message ?? "").toMatch(/requires a reason/i);
    const ok = await upd(id, { status: "cancelled", cancellation_reason: "duplicate report" });
    expect(ok.error, ok.error?.message).toBeNull();
  });

  it("G2: RTS refused while the linked fail is uncleared; a LINKED pass clears it", async () => {
    const failId = await mkFail(orgA, assetA);
    const c = await mkCase(orgA, assetA, { source_inspection_id: failId, reinspection_required: true });
    const id = String(c.data?.id);

    const blocked = await upd(id, { status: "ready_for_return_to_service" });
    expect(blocked.error?.message ?? "").toMatch(/unresolved safety block/i);

    // A passing re-inspection EXPLICITLY linked to the fail (arm 1, backdate-safe).
    const pass = await db(serviceClient()).from("asset_inspections").insert({
      org_id: orgA, asset_id: assetA, title: "re-check", status: "issued",
      safety_critical: true, outcome: "pass", snapshot: { frozen: true },
      inspected_at: "2026-01-02T00:00:00.000Z", reinspection_of: failId,
    }).select("id").single();
    expect(pass.error, pass.error?.message).toBeNull();

    const allowed = await upd(id, { status: "ready_for_return_to_service" });
    expect(allowed.error, allowed.error?.message).toBeNull();
  });

  it("G2 via override: an ACTIVE admin override also satisfies the RTS gate", async () => {
    const failId = await mkFail(orgA, assetA);
    const c = await mkCase(orgA, assetA, { source_inspection_id: failId });
    const id = String(c.data?.id);

    const blocked = await upd(id, { status: "ready_for_return_to_service" });
    expect(blocked.error?.message ?? "").toMatch(/unresolved safety block/i);

    const ovr = await db(serviceClient()).from("asset_inspection_overrides").insert({
      org_id: orgA, asset_id: assetA, inspection_id: failId,
      reason: "Manager decision: restricted duties while parts ship",
    }).select("id").single();
    expect(ovr.error, ovr.error?.message).toBeNull();

    const allowed = await upd(id, { status: "ready_for_return_to_service" });
    expect(allowed.error, allowed.error?.message).toBeNull();
  });

  it("G0: cross-org refs are rejected (asset, source inspection, costs smuggle)", async () => {
    const crossAsset = await mkCase(orgA, assetB);
    expect(crossAsset.error?.message ?? "").toMatch(/not in org/i);

    const failB = await mkFail(orgB, assetB);
    const crossInspection = await mkCase(orgA, assetA, { source_inspection_id: failB });
    expect(crossInspection.error?.message ?? "").toMatch(/not in org/i);

    const cB = await mkCase(orgB, assetB);
    const smuggle = await db(serviceClient()).from("asset_maintenance_case_costs").insert({
      case_id: String(cB.data?.id), org_id: orgA, cost_parts: 100,
    }).select("case_id").single();
    expect(smuggle.error?.message ?? "").toMatch(/not in org/i);
  });

  it("costs are invisible to anon; cases too (RLS)", async () => {
    const c = await mkCase(orgA, assetA);
    const id = String(c.data?.id);
    await db(serviceClient()).from("asset_maintenance_case_costs").insert({
      case_id: id, org_id: orgA, cost_parts: 250, cost_labour: 90,
    }).select("case_id").single();

    const anonCosts = await db(anonClient()).from("asset_maintenance_case_costs").select("case_id").eq("case_id", id);
    expect(anonCosts.error, anonCosts.error?.message).toBeNull();
    expect(anonCosts.data ?? []).toHaveLength(0);
    const anonCases = await db(anonClient()).from("asset_maintenance_cases").select("id").eq("id", id);
    expect(anonCases.error, anonCases.error?.message).toBeNull();
    expect(anonCases.data ?? []).toHaveLength(0);
  });

  it("attachment CHECK accepts the new target, keeps prior targets, rejects bogus", async () => {
    const c = await mkCase(orgA, assetA);
    const caseId = String(c.data?.id);

    const ok = await db(serviceClient()).from("tenant_attachments").insert({
      org_id: orgA, target_table: "asset_maintenance_cases", target_id: caseId,
      filename: "damage.jpg", storage_path: `${orgA}/m.jpg`,
    }).select("id").single();
    expect(ok.error, ok.error?.message).toBeNull();

    for (const target of ["assets", "asset_inspections"] as const) {
      const prior = await db(serviceClient()).from("tenant_attachments").insert({
        org_id: orgA, target_table: target, target_id: assetA,
        filename: "p.pdf", storage_path: `${orgA}/p-${target}.pdf`,
      }).select("id").single();
      expect(prior.error, `${target}: ${prior.error?.message}`).toBeNull();
    }

    const bogus = await db(serviceClient()).from("tenant_attachments").insert({
      org_id: orgA, target_table: "not_a_table", target_id: caseId,
      filename: "b.pdf", storage_path: `${orgA}/b.pdf`,
    }).select("id").single();
    expect(bogus.error).not.toBeNull();
  });
});

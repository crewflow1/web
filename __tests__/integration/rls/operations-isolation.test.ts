import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import {
  gatherOperationsFacts,
  type OperationsClient,
} from "@/server/services/operations-snapshot";
import { composeOperations, type OperationsFacts } from "@/lib/operations/compose";

/**
 * Operations command centre against REAL Postgres.
 *
 * THE THING THIS PROVES that no mocked test structurally can: a viewer who
 * belongs to org A AND org B, with the SAME SHAPE of operational trouble in
 * each, sees only org A's numbers while org A is active. `current_org_ids()`
 * returns both of their orgs, so RLS alone hands back both estates — strip the
 * `.eq("org_id", orgId)` pin out of the service's paged reader and every
 * assertion below about "org B's rows are absent" goes red, and the composed
 * counts double.
 *
 * It also proves the page NEVER WRITES: every row count in every estate table,
 * in both orgs, is captured before and after, and a table-level write proxy
 * sits in front of the client.
 *
 * SCOPE. This file covers the eight reads server/services/operations-snapshot.ts
 * owns. The other two halves of the page carry their own runtime proofs and are
 * not duplicated here: the fleet register in rls/fleet-isolation.test.ts, and
 * the schedule detector in schedule/schedule-integrity.test.ts.
 *
 * Residue-independent: every fixture is namespaced by a per-run TOKEN and every
 * assertion is made against ids created by THIS run, so a dirty database (or a
 * concurrent suite on the shared local stack) can neither pass nor fail it
 * spuriously.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(c: string, v: unknown): Sel;
  select(c?: string, o?: unknown): Sel;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(c?: string): { single(): PromiseLike<Res<Row>> };
}
interface Del {
  eq(c: string, v: unknown): Del & PromiseLike<Res<null>>;
}
interface Table {
  select(c?: string, o?: unknown): Sel;
  insert(r: Row | Row[]): Ins;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-ops-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
/** Forces real page boundaries on a tiny fixture. */
const PAGE = 2;

/** Pinned clock so every due/overdue judgement below has one right answer. */
const NOW = new Date("2026-08-10T09:00:00Z");
const TODAY = "2026-08-10";
const NOW_ISO = NOW.toISOString();
const SINCE_ISO = new Date(NOW.getTime() - 14 * 86_400_000).toISOString();

const ESTATE_TABLES = [
  "assets",
  "asset_maintenance_cases",
  "asset_inspections",
  "asset_inspection_overrides",
  "asset_assignments",
] as const;

/**
 * A `from()` proxy that refuses every write verb. The service's own client type
 * already exposes only read verbs; this is the runtime half of the same claim.
 */
function readOnlyClient(client: unknown): OperationsClient {
  const inner = client as { from(t: string): Record<string, unknown> };
  const FORBIDDEN = new Set(["insert", "update", "upsert", "delete", "rpc"]);
  return {
    from(table: string) {
      const builder = inner.from(table);
      return new Proxy(builder, {
        get(target, prop, receiver) {
          if (typeof prop === "string" && FORBIDDEN.has(prop)) {
            throw new Error(`operations-snapshot attempted a WRITE (${prop}) on ${table}`);
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as unknown as ReturnType<OperationsClient["from"]>;
    },
  };
}

async function insId(svc: ReturnType<typeof db>, table: string, row: Row): Promise<string> {
  const res = await svc.from(table).insert(row).select("id").single();
  expect(res.error, `${table}: ${res.error?.message}`).toBeNull();
  const id = String(res.data?.id ?? "");
  if (!id) throw new Error(`failed to insert into ${table}`);
  return id;
}

async function mkUser(suffix: string, orgIds: string[]): Promise<{ id: string; token: string }> {
  const email = `${TOKEN}-${suffix}@example.test`;
  const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  await db(serviceClient()).from("users").insert({ id, email, full_name: `${TOKEN} ${suffix}` });
  for (const orgId of orgIds) {
    const m = await db(serviceClient())
      .from("memberships")
      .insert({ org_id: orgId, user_id: id, role: "owner" });
    expect(m.error, m.error?.message).toBeNull();
  }
  const token =
    (await anonClient().auth.signInWithPassword({ email, password })).data.session?.access_token ??
    "";
  if (!id || !token) throw new Error(`failed to make user ${suffix}`);
  return { id, token };
}

/** Row counts for every estate table in both fixture orgs. */
async function estateCounts(orgIds: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of ESTATE_TABLES) {
    for (const orgId of orgIds) {
      const res = await db(serviceClient()).from(table).select("id").eq("org_id", orgId);
      out[`${table}:${orgId}`] = (res.data ?? []).length;
    }
  }
  return out;
}

/** One org's estate: the SAME shape of trouble in both tenants. */
interface Fixture {
  orgId: string;
  brokenAsset: string;
  runningAsset: string;
  blockedAsset: string;
  lateCase: string;
  otherCase: string;
  doneCase: string;
  staleCase: string;
  overdueInspection: string;
  upcomingInspection: string;
  failedInspection: string;
  lateCustody: string;
  fineCustody: string;
}

async function seedOrg(svc: ReturnType<typeof db>, label: string): Promise<Fixture> {
  const orgId = await insId(svc, "organizations", {
    name: `Ops ${label}`,
    slug: `${TOKEN}-${label}`,
  });

  const brokenAsset = await insId(svc, "assets", {
    org_id: orgId,
    name: `${TOKEN} ${label} Excavator`,
    status: "active",
  });
  const runningAsset = await insId(svc, "assets", {
    org_id: orgId,
    name: `${TOKEN} ${label} Dumper`,
    status: "active",
  });
  const blockedAsset = await insId(svc, "assets", {
    org_id: orgId,
    name: `${TOKEN} ${label} Telehandler`,
    status: "active",
  });
  // A disposed asset: on the register, but never counted as active or idle.
  await insId(svc, "assets", {
    org_id: orgId,
    name: `${TOKEN} ${label} Sold van`,
    status: "sold",
  });

  const lateCase = await insId(svc, "asset_maintenance_cases", {
    org_id: orgId,
    asset_id: brokenAsset,
    case_type: "breakdown",
    status: "awaiting_parts",
    priority: "high",
    title: `${label} hydraulic failure`,
    out_of_service: true,
  });
  const otherCase = await insId(svc, "asset_maintenance_cases", {
    org_id: orgId,
    asset_id: runningAsset,
    case_type: "preventive",
    status: "scheduled",
    priority: "low",
    title: `${label} greasing`,
    out_of_service: false,
  });
  const doneCase = await insId(svc, "asset_maintenance_cases", {
    org_id: orgId,
    asset_id: runningAsset,
    case_type: "service",
    status: "completed",
    title: `${label} annual service`,
    work_performed: "Full service",
    completed_at: "2026-08-04T10:00:00Z",
  });
  // Completed OUTSIDE the recent window — proves the read is bounded, not "all".
  const staleCase = await insId(svc, "asset_maintenance_cases", {
    org_id: orgId,
    asset_id: runningAsset,
    case_type: "service",
    status: "completed",
    title: `${label} last year's service`,
    work_performed: "Full service",
    completed_at: "2026-01-04T10:00:00Z",
  });

  const overdueInspection = await insId(svc, "asset_inspections", {
    org_id: orgId,
    asset_id: brokenAsset,
    title: `${label} pre-use check`,
    status: "draft",
    due_at: "2026-08-03",
  });
  const upcomingInspection = await insId(svc, "asset_inspections", {
    org_id: orgId,
    asset_id: runningAsset,
    title: `${label} weekly check`,
    status: "draft",
    due_at: "2026-08-14",
  });
  // A draft with NO due date — must never be sorted into the queue.
  await insId(svc, "asset_inspections", {
    org_id: orgId,
    asset_id: runningAsset,
    title: `${label} ad-hoc note`,
    status: "draft",
  });
  const failedInspection = await insId(svc, "asset_inspections", {
    org_id: orgId,
    asset_id: blockedAsset,
    title: `${label} LOLER examination`,
    status: "issued",
    safety_critical: true,
    outcome: "fail",
    snapshot: { frozen: true },
    inspected_at: "2026-08-01T10:00:00Z",
  });

  const lateCustody = await insId(svc, "asset_assignments", {
    org_id: orgId,
    asset_id: runningAsset,
    assignment_type: "issued_to_staff",
    status: "open",
    assigned_at: "2026-07-01T08:00:00Z",
    expected_return_at: "2026-08-05",
  });
  const fineCustody = await insId(svc, "asset_assignments", {
    org_id: orgId,
    asset_id: brokenAsset,
    assignment_type: "stored_at_depot",
    status: "open",
    location: `${label} yard`,
    assigned_at: "2026-07-01T08:00:00Z",
    expected_return_at: "2026-09-05",
  });
  // A CLOSED holding — "signed out" must mean open custody, nothing else.
  await insId(svc, "asset_assignments", {
    org_id: orgId,
    asset_id: blockedAsset,
    assignment_type: "allocated_to_job",
    status: "closed",
    assigned_at: "2026-06-01T08:00:00Z",
    actual_return_at: "2026-06-10T08:00:00Z",
  });

  return {
    orgId,
    brokenAsset,
    runningAsset,
    blockedAsset,
    lateCase,
    otherCase,
    doneCase,
    staleCase,
    overdueInspection,
    upcomingInspection,
    failedInspection,
    lateCustody,
    fineCustody,
  };
}

describeIntegration("operations command centre · dual-org isolation (RLS)", () => {
  const svc = db(serviceClient());

  let A: Fixture;
  let B: Fixture;
  /** Member of BOTH orgs — the blend probe. */
  let viewer = { id: "", token: "" };
  /** Member of org B only — must see nothing at all under org A. */
  let outsider = { id: "", token: "" };

  async function factsFor(token: string, orgId: string, pageSize = PAGE) {
    return gatherOperationsFacts(readOnlyClient(userClient(token)), orgId, SINCE_ISO, pageSize);
  }

  /** The composed view over real rows, with the two externally-proved halves empty. */
  async function viewFor(token: string, orgId: string) {
    const estate = await factsFor(token, orgId);
    const facts: OperationsFacts = {
      todayIso: TODAY,
      nowIso: NOW_ISO,
      ...estate,
      vehicleAssetIds: new Set<string>(),
      vehicleCounts: { total: 0, inService: 0, offRoad: 0, inWorkshop: 0 },
      compliance: [],
      conflicts: [],
    };
    return composeOperations(facts);
  }

  beforeAll(async () => {
    A = await seedOrg(svc, "a");
    B = await seedOrg(svc, "b");
    viewer = await mkUser("viewer", [A.orgId, B.orgId]);
    outsider = await mkUser("outsider", [B.orgId]);
  });

  afterAll(async () => {
    for (const orgId of [A?.orgId, B?.orgId]) {
      if (orgId) await svc.from("organizations").delete().eq("id", orgId);
    }
    for (const u of [viewer, outsider]) {
      if (u.id) await serviceClient().auth.admin.deleteUser(u.id);
    }
  });

  // ── The reads find what is really there ────────────────────────────────────

  it("reads the open maintenance cases and leaves the terminal ones alone", async () => {
    const facts = await factsFor(viewer.token, A.orgId);
    const ids = facts.openCases.map((c) => c.id).sort();
    expect(ids).toEqual([A.lateCase, A.otherCase].sort());
    expect(ids).not.toContain(A.doneCase);
  });

  it("bounds recent completions to the window instead of the whole history", async () => {
    const facts = await factsFor(viewer.token, A.orgId);
    expect(facts.recentCompletions.map((c) => c.id)).toEqual([A.doneCase]);
    expect(facts.recentCompletions.map((c) => c.id)).not.toContain(A.staleCase);
  });

  it("reads the open due queue and skips a draft with no due date", async () => {
    const facts = await factsFor(viewer.token, A.orgId);
    expect(facts.dueInspections.map((i) => i.id).sort()).toEqual(
      [A.overdueInspection, A.upcomingInspection].sort(),
    );
  });

  it("reads open custody only", async () => {
    const facts = await factsFor(viewer.token, A.orgId);
    expect(facts.openCustody.map((c) => c.id).sort()).toEqual(
      [A.lateCustody, A.fineCustody].sort(),
    );
  });

  it("composes exactly the operator's answer from those rows", async () => {
    const view = await viewFor(viewer.token, A.orgId);
    expect(view.equipment.outOfService.map((c) => c.caseId)).toEqual([A.lateCase]);
    expect(view.equipment.otherOpen.map((c) => c.caseId)).toEqual([A.otherCase]);
    expect(view.inspections.overdue.map((i) => i.inspectionId)).toEqual([A.overdueInspection]);
    expect(view.inspections.upcoming.map((i) => i.inspectionId)).toEqual([A.upcomingInspection]);
    expect(view.custody.overdue.map((c) => c.assignmentId)).toEqual([A.lateCustody]);
    expect(view.custody.openTotal).toBe(2);
    expect(view.equipment.safetyBlocked.map((a) => a.assetId)).toEqual([A.blockedAsset]);
    expect(view.equipment.safetyBlocked[0]!.blocking).toBe(true);
    expect(view.recentCompletions.map((c) => c.caseId)).toEqual([A.doneCase]);
    // 4 assets on the register, one sold; two of the three live ones are out.
    expect(view.estate.assets).toEqual({ total: 4, active: 3, held: 2, idle: 1 });
    expect(view.isNewEstate).toBe(false);
  });

  // ── THE ORG-PIN PROOF ──────────────────────────────────────────────────────

  /**
   * Both orgs hold the same shape of trouble and the viewer belongs to both.
   * Without `.eq("org_id", …)` every count below doubles and org B's ids appear
   * in org A's lists. Delete the pin and this goes red.
   */
  it("never blends the viewer's OTHER org into this org's command centre", async () => {
    const facts = await factsFor(viewer.token, A.orgId);
    const seen = new Set<string>([
      ...facts.assets.map((r) => r.id),
      ...facts.openCases.map((r) => r.id),
      ...facts.recentCompletions.map((r) => r.id),
      ...facts.dueInspections.map((r) => r.id),
      ...facts.safetyInspections.map((r) => r.id),
      ...facts.overrides.map((r) => r.id),
      ...facts.openCustody.map((r) => r.id),
    ]);
    const orgBIds = [
      B.brokenAsset,
      B.runningAsset,
      B.blockedAsset,
      B.lateCase,
      B.otherCase,
      B.doneCase,
      B.overdueInspection,
      B.upcomingInspection,
      B.failedInspection,
      B.lateCustody,
      B.fineCustody,
    ];
    for (const id of orgBIds) expect(seen.has(id), `leaked org B row ${id}`).toBe(false);
  });

  it("keeps every composed count single-org, not doubled", async () => {
    const view = await viewFor(viewer.token, A.orgId);
    expect(view.equipment.outOfService).toHaveLength(1);
    expect(view.inspections.overdue).toHaveLength(1);
    expect(view.custody.overdue).toHaveLength(1);
    expect(view.equipment.safetyBlocked).toHaveLength(1);
    expect(view.estate.assets.total).toBe(4);
  });

  it("serves org B its OWN estate to the same dual-org viewer, uncontaminated", async () => {
    const view = await viewFor(viewer.token, B.orgId);
    expect(view.equipment.outOfService.map((c) => c.caseId)).toEqual([B.lateCase]);
    expect(view.equipment.safetyBlocked.map((a) => a.assetId)).toEqual([B.blockedAsset]);
    expect(view.custody.overdue.map((c) => c.assignmentId)).toEqual([B.lateCustody]);
    expect(view.estate.assets.total).toBe(4);
  });

  it("shows a member of only the OTHER org nothing at all for org A", async () => {
    const facts = await factsFor(outsider.token, A.orgId);
    expect(facts.assets).toEqual([]);
    expect(facts.openCases).toEqual([]);
    expect(facts.dueInspections).toEqual([]);
    expect(facts.safetyInspections).toEqual([]);
    expect(facts.openCustody).toEqual([]);
    const view = await viewFor(outsider.token, A.orgId);
    expect(view.isNewEstate).toBe(true);
  });

  it("denies an unauthenticated (anon) caller", async () => {
    const facts = await gatherOperationsFacts(
      readOnlyClient(anonClient()),
      A.orgId,
      SINCE_ISO,
      PAGE,
    );
    expect(facts.assets).toEqual([]);
    expect(facts.openCases).toEqual([]);
    expect(facts.openCustody).toEqual([]);
  });

  // ── The safety follow-up is narrowed WITHOUT losing the answer ─────────────

  it("finds the clearing pass for a failing asset, and drops the block", async () => {
    const clearing = await insId(svc, "asset_inspections", {
      org_id: A.orgId,
      asset_id: A.blockedAsset,
      title: `${TOKEN} a re-examination`,
      status: "issued",
      safety_critical: true,
      outcome: "pass",
      reinspection_of: A.failedInspection,
      snapshot: { frozen: true },
      inspected_at: "2026-08-06T10:00:00Z",
    });
    try {
      const view = await viewFor(viewer.token, A.orgId);
      expect(view.equipment.safetyBlocked).toEqual([]);
    } finally {
      await svc.from("asset_inspections").delete().eq("id", clearing);
    }
  });

  it("finds a live override, shows the failure, and never calls it cleared", async () => {
    const ov = await insId(svc, "asset_inspection_overrides", {
      org_id: A.orgId,
      asset_id: A.blockedAsset,
      inspection_id: A.failedInspection,
      reason: `${TOKEN} isolated and tagged out for a controlled lift`,
    });
    try {
      const view = await viewFor(viewer.token, A.orgId);
      expect(view.equipment.safetyBlocked).toHaveLength(1);
      expect(view.equipment.safetyBlocked[0]!.blocking).toBe(false);
      // …and org B's identical override never reaches org A.
      const facts = await factsFor(viewer.token, A.orgId);
      expect(facts.overrides.map((o) => o.id)).toEqual([ov]);
    } finally {
      await svc.from("asset_inspection_overrides").delete().eq("id", ov);
    }
  });

  // ── Paging + purity ────────────────────────────────────────────────────────

  it("pages every read without dropping or duplicating a row", async () => {
    // Org A holds 4 assets and 3 draft inspections; a page size of 2 crosses a
    // real boundary in both.
    const small = await factsFor(viewer.token, A.orgId, PAGE);
    const assetIds = small.assets.map((a) => a.id);
    expect(assetIds).toHaveLength(4);
    expect(new Set(assetIds).size).toBe(assetIds.length);
    expect(assetIds).toEqual([...assetIds].sort()); // ordered by the unique key

    const big = await factsFor(viewer.token, A.orgId, 500);
    expect([...big.assets.map((a) => a.id)].sort()).toEqual([...assetIds].sort());
    expect([...big.openCases.map((c) => c.id)].sort()).toEqual(
      [...small.openCases.map((c) => c.id)].sort(),
    );
  });

  it("performs NO writes — every estate row count is unchanged", async () => {
    const before = await estateCounts([A.orgId, B.orgId]);
    await viewFor(viewer.token, A.orgId);
    await viewFor(viewer.token, B.orgId);
    await viewFor(outsider.token, A.orgId);
    const after = await estateCounts([A.orgId, B.orgId]);
    expect(after).toEqual(before);
    // …and the counts are not trivially zero, so "unchanged" means something.
    expect(before[`assets:${A.orgId}`]).toBe(4);
  });

  it("is repeatable: the same clock over the same data yields identical numbers", async () => {
    const a = await viewFor(viewer.token, A.orgId);
    const b = await viewFor(viewer.token, A.orgId);
    expect(a).toEqual(b);
  });
});

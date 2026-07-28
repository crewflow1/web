import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import {
  gatherScheduleFacts,
  type ScheduleClient,
} from "@/server/services/schedule-integrity";
import {
  detectScheduleConflicts,
  summariseScheduleConflicts,
  type ScheduleConflict,
} from "@/lib/schedule/conflicts";
import { buildScheduleWindow } from "@/lib/schedule/window";

/**
 * Schedule Integrity against REAL Postgres.
 *
 * Three things are proved here that no mocked unit test structurally can:
 *
 *   1. THE DETECTOR FINDS REAL CONFLICTS. The double-booking fixture is not
 *      hand-written rota rows — it is two JOBS assigned to one person on one
 *      date, which the live `jobs_rota_sync_trigger` turns into two identical
 *      08:00–17:00 shifts. That is the production path, and the rota form's own
 *      write-time guard never runs on it.
 *   2. ORG ISOLATION. `current_org_ids()` returns EVERY org a viewer belongs to,
 *      so an RLS-only read BLENDS tenants. The probe viewer here is a member of
 *      org A AND org B, and the double-booked staff member is a member of BOTH —
 *      with deliberately overlapping shifts in each. Drop the `.eq("org_id", …)`
 *      pins and this suite invents a cross-tenant clash that does not exist.
 *   3. NO WRITES. Every row count in every scheduling table is captured before
 *      and after, and a table-level write proxy sits in front of the client.
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

const TOKEN = `it-sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PAGE = 2; // force real page boundaries on a tiny fixture

/** Pinned clock → a fixed, reproducible fortnight: 10–23 August 2026 (BST). */
const NOW = new Date("2026-08-10T09:00:00Z");
const WINDOW = buildScheduleWindow(NOW);
const DAY_CLASH = "2026-08-12";
const DAY_OFF_ROTA = "2026-08-14";
const DAY_LEAVE = "2026-08-18";
const DAY_EMPTY = "2026-08-20";

const SCHEDULE_TABLES = ["rota_entries", "jobs", "leave_requests", "asset_assignments"] as const;

/**
 * A `from()` proxy that refuses every write verb. The detector's own client type
 * already exposes only read verbs, so this is the runtime half of the same claim:
 * a table-level insert/update/delete/upsert added to the service would throw here
 * rather than silently mutating a tenant's rota.
 */
function readOnlyClient(client: unknown): ScheduleClient {
  const inner = client as { from(t: string): Record<string, unknown> };
  const FORBIDDEN = new Set(["insert", "update", "upsert", "delete", "rpc"]);
  return {
    from(table: string) {
      const builder = inner.from(table);
      return new Proxy(builder, {
        get(target, prop, receiver) {
          if (typeof prop === "string" && FORBIDDEN.has(prop)) {
            throw new Error(`schedule-integrity attempted a WRITE (${prop}) on ${table}`);
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as unknown as ReturnType<ScheduleClient["from"]>;
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

async function mkUser(
  suffix: string,
  orgIds: string[],
  fullName: string,
): Promise<{ id: string; token: string; name: string }> {
  const email = `${TOKEN}-${suffix}@example.test`;
  const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  await db(serviceClient()).from("users").insert({ id, email, full_name: fullName });
  for (const orgId of orgIds) {
    const m = await db(serviceClient()).from("memberships").insert({ org_id: orgId, user_id: id, role: "owner" });
    expect(m.error, m.error?.message).toBeNull();
  }
  const token =
    (await anonClient().auth.signInWithPassword({ email, password })).data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`failed to make user ${suffix}`);
  return { id, token, name: fullName };
}

/** Row counts for every scheduling table in both fixture orgs. */
async function scheduleCounts(orgIds: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of SCHEDULE_TABLES) {
    for (const orgId of orgIds) {
      const res = await db(serviceClient()).from(table).select("id").eq("org_id", orgId);
      out[`${table}:${orgId}`] = (res.data ?? []).length;
    }
  }
  return out;
}

async function conflictsFor(token: string, orgId: string, pageSize = PAGE): Promise<ScheduleConflict[]> {
  const facts = await gatherScheduleFacts(readOnlyClient(userClient(token)), orgId, WINDOW, pageSize);
  return detectScheduleConflicts(facts);
}

describeIntegration("schedule integrity · real conflicts + org isolation (RLS)", () => {
  const svc = db(serviceClient());

  let orgA = "";
  let orgB = "";
  /** Member of BOTH orgs — the blend probe's viewer. */
  let viewer = { id: "", token: "", name: "" };
  /** Double-booked in org A, and ALSO holds an overlapping org B shift. */
  let dave = { id: "", token: "", name: "" };
  /** Org A only — the approved-leave clash. */
  let sam = { id: "", token: "", name: "" };
  /** Org B only — must never be seen or named under org A. */
  let bob = { id: "", token: "", name: "" };

  const orgAJobs: string[] = [];
  const orgBRowIds: string[] = [];
  let jobEmptyA = "";
  let jobOffRotaA = "";
  let assetA = "";

  beforeAll(async () => {
    orgA = await insId(svc, "organizations", { name: "Sched A", slug: `${TOKEN}-a` });
    orgB = await insId(svc, "organizations", { name: "Sched B", slug: `${TOKEN}-b` });

    viewer = await mkUser("viewer", [orgA, orgB], `${TOKEN} Viewer`);
    dave = await mkUser("dave", [orgA, orgB], `${TOKEN} Dave Baker`);
    sam = await mkUser("sam", [orgA], `${TOKEN} Sam Okafor`);
    bob = await mkUser("bob", [orgB], `${TOKEN} Bob Ordell`);

    const customerA = await insId(svc, "customers", { org_id: orgA, name: `${TOKEN} Harborne Build Co` });

    // ── org A · a REAL double-booking, made the way production makes one ──────
    // Two jobs, one person, one date. `jobs_rota_sync_trigger` writes a default
    // 08:00–17:00 shift for each; nothing in the product notices they collide.
    orgAJobs.push(
      await insId(svc, "jobs", {
        org_id: orgA, customer_id: customerA, assigned_to: dave.id,
        scheduled_date: DAY_CLASH, status: "new",
      }),
      await insId(svc, "jobs", {
        org_id: orgA, customer_id: customerA, assigned_to: dave.id,
        scheduled_date: DAY_CLASH, status: "in-progress",
      }),
    );

    // ── org A · an approved-leave clash ──────────────────────────────────────
    await insId(svc, "leave_requests", {
      org_id: orgA, user_id: sam.id, type: "holiday", status: "approved",
      starts_at: "2026-08-17", ends_at: "2026-08-19",
    });
    await insId(svc, "rota_entries", {
      org_id: orgA, user_id: sam.id,
      starts_at: `${DAY_LEAVE}T07:00:00Z`, ends_at: `${DAY_LEAVE}T16:00:00Z`,
    });
    // A PENDING request on another day must be ignored entirely.
    await insId(svc, "leave_requests", {
      org_id: orgA, user_id: sam.id, type: "holiday", status: "pending",
      starts_at: "2026-08-21", ends_at: "2026-08-22",
    });
    await insId(svc, "rota_entries", {
      org_id: orgA, user_id: sam.id,
      starts_at: "2026-08-21T07:00:00Z", ends_at: "2026-08-21T16:00:00Z",
    });

    // ── org A · the job record and the rota disagree ─────────────────────────
    // The sync trigger writes Sam a shift the moment the job is assigned; deleting
    // it is the real-world path (an admin drops the shift and forgets the job).
    jobOffRotaA = await insId(svc, "jobs", {
      org_id: orgA, customer_id: customerA, assigned_to: sam.id,
      scheduled_date: DAY_OFF_ROTA, status: "new",
    });
    orgAJobs.push(jobOffRotaA);
    const dropped = await svc.from("rota_entries").delete().eq("job_id", jobOffRotaA).eq("org_id", orgA);
    expect(dropped.error, dropped.error?.message).toBeNull();

    // ── org A · a job with nobody on it ──────────────────────────────────────
    jobEmptyA = await insId(svc, "jobs", {
      org_id: orgA, customer_id: customerA, scheduled_date: DAY_EMPTY, status: "new",
    });
    orgAJobs.push(jobEmptyA);

    // ── org A · overlapping plant custody (both CLOSED, so the partial unique
    // index on open custody does not apply — the only reachable overlap shape) ─
    assetA = await insId(svc, "assets", { org_id: orgA, name: `${TOKEN} Telehandler 3` });
    await insId(svc, "asset_assignments", {
      org_id: orgA, asset_id: assetA, assignment_type: "issued_to_staff", status: "closed",
      assigned_at: "2026-08-11T07:00:00Z", actual_return_at: "2026-08-15T16:00:00Z",
    });
    await insId(svc, "asset_assignments", {
      org_id: orgA, asset_id: assetA, assignment_type: "allocated_to_job", status: "closed",
      assigned_at: "2026-08-12T07:00:00Z", actual_return_at: "2026-08-14T16:00:00Z",
    });

    // ── org B · shifts that would FAKE a clash if the reads blended tenants ───
    // Dave is a member of both orgs; this org B shift overlaps his org A pair
    // exactly. Correct scoping means org A never sees it and org B never pairs
    // it with org A's shifts.
    orgBRowIds.push(
      await insId(svc, "rota_entries", {
        org_id: orgB, user_id: dave.id,
        starts_at: `${DAY_CLASH}T09:00:00Z`, ends_at: `${DAY_CLASH}T12:00:00Z`,
      }),
      // Org B's OWN double-booking — its two shifts must never leak into org A.
      await insId(svc, "rota_entries", {
        org_id: orgB, user_id: bob.id,
        starts_at: `${DAY_CLASH}T08:00:00Z`, ends_at: `${DAY_CLASH}T17:00:00Z`,
      }),
      await insId(svc, "rota_entries", {
        org_id: orgB, user_id: bob.id,
        starts_at: `${DAY_CLASH}T15:00:00Z`, ends_at: `${DAY_CLASH}T19:00:00Z`,
      }),
      await insId(svc, "jobs", { org_id: orgB, scheduled_date: DAY_EMPTY, status: "new" }),
    );
  });

  afterAll(async () => {
    for (const orgId of [orgA, orgB]) {
      if (orgId) await svc.from("organizations").delete().eq("id", orgId);
    }
    for (const u of [viewer, dave, sam, bob]) {
      if (u.id) await serviceClient().auth.admin.deleteUser(u.id);
    }
  });

  // ── The detector actually detects ──────────────────────────────────────────

  it("detects the double-booking the job-assignment trigger silently created", async () => {
    const conflicts = await conflictsFor(viewer.token, orgA);
    const doubles = conflicts.filter((c) => c.kind === "staff_double_booked");
    expect(doubles).toHaveLength(1);
    const c = doubles[0]!;
    expect(c.subjectId).toBe(dave.id);
    expect(c.subjectName).toBe(dave.name);
    expect(c.day).toBe(DAY_CLASH);
    expect(c.sourceIds).toHaveLength(2);
    // BST: the stored 08:00–17:00Z default shift reads 09:00–18:00 locally.
    expect(c.detail).toContain("09:00–18:00");
  });

  it("detects the approved-leave clash and ignores the PENDING request", async () => {
    const conflicts = await conflictsFor(viewer.token, orgA);
    const clashes = conflicts.filter((c) => c.kind === "leave_clash");
    expect(clashes).toHaveLength(1);
    expect(clashes[0]!.subjectId).toBe(sam.id);
    expect(clashes[0]!.day).toBe(DAY_LEAVE);
    expect(clashes[0]!.detail).toContain("holiday");
  });

  it("detects the job with nobody on it, and not the ones that are staffed", async () => {
    const conflicts = await conflictsFor(viewer.token, orgA);
    const unassigned = conflicts.filter((c) => c.kind === "job_unassigned");
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0]!.sourceIds).toEqual([jobEmptyA]);
    expect(unassigned[0]!.href).toBe(`/jobs/${jobEmptyA}`);
  });

  it("detects a job whose assignee holds no shift on the scheduled day", async () => {
    const conflicts = await conflictsFor(viewer.token, orgA);
    const drift = conflicts.filter((c) => c.kind === "assignment_off_rota");
    expect(drift).toHaveLength(1);
    expect(drift[0]!.sourceIds).toEqual([jobOffRotaA]);
    expect(drift[0]!.subjectId).toBe(sam.id);
    expect(drift[0]!.day).toBe(DAY_OFF_ROTA);
    // …and Sam's OTHER days, where he does hold shifts, produce no such finding.
    expect(drift[0]!.href).toBe(`/jobs/${jobOffRotaA}`);
  });

  it("detects the overlapping plant custody the open-custody unique index cannot prevent", async () => {
    const conflicts = await conflictsFor(viewer.token, orgA);
    const plant = conflicts.filter((c) => c.kind === "asset_double_booked");
    expect(plant).toHaveLength(1);
    expect(plant[0]!.subjectId).toBe(assetA);
    expect(plant[0]!.href).toBe(`/assets/${assetA}`);
  });

  it("summarises the org's schedule with an honest, non-critical worst severity", async () => {
    const summary = summariseScheduleConflicts(await conflictsFor(viewer.token, orgA));
    // All FIVE classes that survived schema verification, each found exactly once.
    expect(summary.total).toBe(5);
    expect(summary.byKind.staff_double_booked.count).toBe(1);
    expect(summary.byKind.leave_clash.count).toBe(1);
    expect(summary.byKind.job_unassigned.count).toBe(1);
    expect(summary.byKind.assignment_off_rota.count).toBe(1);
    expect(summary.byKind.asset_double_booked.count).toBe(1);
    expect(summary.worstSeverity).not.toBe("critical");
  });

  // ── Tenant isolation ───────────────────────────────────────────────────────

  /**
   * THE ORG-PIN PROOF. The viewer belongs to both orgs and so does Dave, whose
   * org B shift overlaps his org A pair. Without `.eq("org_id", …)` the read
   * returns all three shifts and the detector reports THREE clashes instead of
   * one — an invented cross-tenant conflict. Delete the pin and this goes red.
   */
  it("never blends a dual-org member's OTHER org into this org's conflicts", async () => {
    const conflicts = await conflictsFor(viewer.token, orgA);
    const seen = new Set(conflicts.flatMap((c) => c.sourceIds));
    for (const id of orgBRowIds) expect(seen.has(id), `leaked org B row ${id}`).toBe(false);
    expect(conflicts.filter((c) => c.kind === "staff_double_booked")).toHaveLength(1);
  });

  it("never NAMES a person from the viewer's other org on this org's page", async () => {
    // `users` RLS lets a viewer read any co-worker across ALL their orgs, so the
    // name map is pinned to THIS org's memberships, not to the ids in hand.
    const conflicts = await conflictsFor(viewer.token, orgA);
    const names = conflicts.map((c) => c.subjectName ?? "").join(" | ");
    expect(names).not.toContain(bob.name);
    expect(names).toContain(dave.name);
  });

  it("serves org B its OWN conflicts to the same dual-org viewer, uncontaminated", async () => {
    const conflicts = await conflictsFor(viewer.token, orgB);
    const doubles = conflicts.filter((c) => c.kind === "staff_double_booked");
    expect(doubles).toHaveLength(1);
    expect(doubles[0]!.subjectId).toBe(bob.id);
    const seen = new Set(conflicts.flatMap((c) => c.sourceIds));
    for (const id of orgAJobs) expect(seen.has(id), `leaked org A row ${id}`).toBe(false);
    // Dave's single org B shift has no partner inside org B — no invented clash.
    expect(doubles.some((c) => c.subjectId === dave.id)).toBe(false);
  });

  it("shows a member of only the OTHER org nothing at all for org A", async () => {
    expect(await conflictsFor(bob.token, orgA)).toEqual([]);
  });

  it("denies an unauthenticated (anon) caller", async () => {
    const facts = await gatherScheduleFacts(readOnlyClient(anonClient()), orgA, WINDOW, PAGE);
    expect(facts.rota).toEqual([]);
    expect(facts.jobs).toEqual([]);
    expect(facts.leave).toEqual([]);
    expect(detectScheduleConflicts(facts)).toEqual([]);
  });

  // ── Paging + purity ────────────────────────────────────────────────────────

  it("pages every windowed read without dropping or duplicating a row", async () => {
    // Org A holds 4 rota entries and 3 jobs in the window; a page size of 2
    // crosses real boundaries in both.
    const facts = await gatherScheduleFacts(readOnlyClient(userClient(viewer.token)), orgA, WINDOW, PAGE);
    const rotaIds = facts.rota.map((r) => r.id);
    expect(rotaIds).toHaveLength(4);
    expect(new Set(rotaIds).size).toBe(rotaIds.length);
    expect(rotaIds).toEqual([...rotaIds].sort()); // ordered by the unique key
    const jobIds = facts.jobs.map((j) => j.id);
    expect([...jobIds].sort()).toEqual([...orgAJobs].sort());

    // The same read at the production page size yields the identical set.
    const big = await gatherScheduleFacts(readOnlyClient(userClient(viewer.token)), orgA, WINDOW);
    expect([...big.rota.map((r) => r.id)].sort()).toEqual([...rotaIds].sort());
    expect([...big.jobs.map((j) => j.id)].sort()).toEqual([...jobIds].sort());
  });

  it("resolves the customer name that labels a job (jobs carry no title)", async () => {
    const facts = await gatherScheduleFacts(readOnlyClient(userClient(viewer.token)), orgA, WINDOW, PAGE);
    const labelled = facts.jobs.filter((j) => (j.customer_name ?? "").includes("Harborne"));
    expect(labelled.length).toBeGreaterThan(0);
  });

  it("performs NO writes — every scheduling row count is unchanged", async () => {
    const before = await scheduleCounts([orgA, orgB]);
    await conflictsFor(viewer.token, orgA);
    await conflictsFor(viewer.token, orgB);
    await conflictsFor(bob.token, orgA);
    const after = await scheduleCounts([orgA, orgB]);
    expect(after).toEqual(before);
    // …and the counts are not trivially zero, so "unchanged" means something.
    expect(before[`rota_entries:${orgA}`]).toBe(4);
  });

  it("is repeatable: the same window over the same data yields identical findings", async () => {
    const a = await conflictsFor(viewer.token, orgA);
    const b = await conflictsFor(viewer.token, orgA);
    expect(a.map((c) => c.key)).toEqual(b.map((c) => c.key));
    expect(a).toEqual(b);
  });
});

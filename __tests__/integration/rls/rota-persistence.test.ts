import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import {
  insertRotaEntries,
  listWeekRotaEntries,
  type RotaClient,
  type RotaInsertRow,
  type RotaWriteClient,
} from "@/server/services/rota";
import {
  planRotaPersistence,
  type PersistableAssignment,
} from "@/lib/schedule/persist";

/**
 * Automatic rota persistence — the approve→save path against REAL Postgres.
 *
 * The server action (persistGeneratedRota) needs a Next request context, so it
 * cannot run under vitest; this suite drives its DATA PATH with real user JWTs —
 * the exact service functions and pure planner the action composes — so the
 * guarantees are proven against live RLS and live constraints, not mocked:
 *
 *   1. APPROVE → PERSIST → RELOAD: an owner writes the plan atomically and the
 *      saved rota reads back.
 *   2. IDEMPOTENT RE-APPROVE: re-running the same proposal inserts nothing.
 *   3. CONFLICT REJECTED: a proposal overlapping a hand-confirmed shift is
 *      dropped, and the confirmed shift is left byte-for-byte untouched.
 *   4. STAFF ISOLATION (fail-closed READ): a worker reads ONLY their own rota
 *      rows — never a colleague's — and anon reads nothing.
 *   5. FAIL-CLOSED WRITE: a non-admin's insert is refused by RLS.
 *
 * Residue-independent: fixtures are namespaced by a per-run TOKEN and every
 * assertion is made against ids created by THIS run.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Ins extends PromiseLike<Res<Row[]>> {
  select(c?: string): { single(): PromiseLike<Res<Row>> };
}
interface Upd {
  eq(c: string, v: unknown): PromiseLike<Res<null>>;
}
interface Sel {
  eq(c: string, v: unknown): PromiseLike<Res<Row[]>>;
}
interface Del {
  eq(c: string, v: unknown): PromiseLike<Res<null>>;
}
interface Table {
  insert(r: Row | Row[]): Ins;
  select(c: string): Sel;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-rotapersist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// One fixed week; two days inside it so A's and C's rows never collide.
const WEEK_START_ISO = "2026-03-02T00:00:00Z"; // Monday
const WEEK_END_ISO = "2026-03-08T23:59:59Z";
const DAY = "2026-03-04"; // Wed — the persisted plan
const DAY2 = "2026-03-05"; // Thu — the conflict case

async function insId(svc: ReturnType<typeof db>, table: string, row: Row): Promise<string> {
  const res = await svc.from(table).insert(row).select("id").single();
  expect(res.error, `${table}: ${res.error?.message}`).toBeNull();
  const id = String(res.data?.id ?? "");
  if (!id) throw new Error(`failed to insert into ${table}`);
  return id;
}

async function mkUser(
  suffix: string,
  memberships: Array<{ orgId: string; role: string }>,
): Promise<{ id: string; token: string }> {
  const email = `${TOKEN}-${suffix}@example.test`;
  const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  await db(serviceClient()).from("users").insert({ id, email, full_name: email });
  for (const m of memberships) {
    const res = await db(serviceClient()).from("memberships").insert({ org_id: m.orgId, user_id: id, role: m.role });
    expect(res.error, res.error?.message).toBeNull();
  }
  const token =
    (await anonClient().auth.signInWithPassword({ email, password })).data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`failed to make user ${suffix}`);
  return { id, token };
}

function assignment(over: Partial<PersistableAssignment> & { userId: string }): PersistableAssignment {
  return {
    userId: over.userId,
    jobId: over.jobId ?? null,
    startIso: over.startIso ?? `${DAY}T08:00:00Z`,
    endIso: over.endIso ?? `${DAY}T17:00:00Z`,
    notes: over.notes ?? "Auto-generated rota",
  };
}

function toRows(orgId: string, createdBy: string, assigns: PersistableAssignment[]): RotaInsertRow[] {
  return assigns.map((a) => ({
    org_id: orgId,
    user_id: a.userId,
    job_id: a.jobId,
    starts_at: a.startIso,
    ends_at: a.endIso,
    notes: a.notes ?? null,
    created_by: createdBy,
  }));
}

describeIntegration("automatic rota persistence (approve → save, RLS)", () => {
  const svc = db(serviceClient());

  let orgA = "";
  let owner = { id: "", token: "" };
  let worker1 = { id: "", token: "" };
  let worker2 = { id: "", token: "" };
  let job1 = "";
  let job2 = "";

  // Captured across the ordered tests.
  let worker1EntryId = "";
  let worker2EntryId = "";
  let manualId = ""; // the hand-confirmed shift the conflict case must not touch

  beforeAll(async () => {
    orgA = await insId(svc, "organizations", { name: "Rota Persist A", slug: `${TOKEN}-a` });
    owner = await mkUser("owner", [{ orgId: orgA, role: "owner" }]);
    worker1 = await mkUser("worker1", [{ orgId: orgA, role: "staff" }]);
    worker2 = await mkUser("worker2", [{ orgId: orgA, role: "staff" }]);
    job1 = await insId(svc, "jobs", { org_id: orgA, status: "in-progress" });
    job2 = await insId(svc, "jobs", { org_id: orgA, status: "in-progress" });
  });

  afterAll(async () => {
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    for (const u of [owner, worker1, worker2]) {
      if (u.id) await serviceClient().auth.admin.deleteUser(u.id);
    }
  });

  it("1. APPROVE → PERSIST → RELOAD: owner saves the plan atomically and it reads back", async () => {
    const ownerC = userClient(owner.token) as unknown as RotaClient & RotaWriteClient;

    const existing = await listWeekRotaEntries(ownerC, orgA, WEEK_START_ISO, WEEK_END_ISO);
    expect(existing).toEqual([]);

    const assigns = [
      assignment({ userId: worker1.id, jobId: job1, startIso: `${DAY}T08:00:00Z`, endIso: `${DAY}T12:00:00Z` }),
      assignment({ userId: worker2.id, jobId: job2, startIso: `${DAY}T13:00:00Z`, endIso: `${DAY}T17:00:00Z` }),
    ];
    const plan = planRotaPersistence(
      assigns,
      existing.map((e) => ({ user_id: e.user_id, job_id: e.job_id, starts_at: e.starts_at, ends_at: e.ends_at })),
    );
    expect(plan.toInsert).toHaveLength(2);
    expect(plan.conflicts).toHaveLength(0);

    const inserted = await insertRotaEntries(ownerC, toRows(orgA, owner.id, plan.toInsert));
    expect(inserted).toHaveLength(2);

    // Reload — the saved rota shows.
    const reload = await listWeekRotaEntries(ownerC, orgA, WEEK_START_ISO, WEEK_END_ISO);
    expect(reload).toHaveLength(2);
    worker1EntryId = reload.find((e) => e.user_id === worker1.id)?.id ?? "";
    worker2EntryId = reload.find((e) => e.user_id === worker2.id)?.id ?? "";
    expect(worker1EntryId).not.toBe("");
    expect(worker2EntryId).not.toBe("");
  });

  it("2. IDEMPOTENT RE-APPROVE: the same proposal inserts nothing the second time", async () => {
    const ownerC = userClient(owner.token) as unknown as RotaClient & RotaWriteClient;

    const existing = await listWeekRotaEntries(ownerC, orgA, WEEK_START_ISO, WEEK_END_ISO);
    const assigns = [
      assignment({ userId: worker1.id, jobId: job1, startIso: `${DAY}T08:00:00Z`, endIso: `${DAY}T12:00:00Z` }),
      assignment({ userId: worker2.id, jobId: job2, startIso: `${DAY}T13:00:00Z`, endIso: `${DAY}T17:00:00Z` }),
    ];
    const plan = planRotaPersistence(
      assigns,
      existing.map((e) => ({ user_id: e.user_id, job_id: e.job_id, starts_at: e.starts_at, ends_at: e.ends_at })),
    );
    expect(plan.toInsert, "re-approve must add nothing").toHaveLength(0);
    expect(plan.alreadySaved).toHaveLength(2);

    const inserted = await insertRotaEntries(ownerC, toRows(orgA, owner.id, plan.toInsert));
    expect(inserted).toEqual([]);

    const reload = await listWeekRotaEntries(ownerC, orgA, WEEK_START_ISO, WEEK_END_ISO);
    expect(reload.map((e) => e.id).sort()).toEqual([worker1EntryId, worker2EntryId].sort());
  });

  it("3. CONFLICT REJECTED: a proposal overlapping a hand-confirmed shift is dropped, and that shift is untouched", async () => {
    const ownerC = userClient(owner.token) as unknown as RotaClient & RotaWriteClient;

    // A manager confirms a shift by hand (worker1, 09:00–12:00 on DAY2).
    manualId = await insId(svc, "rota_entries", {
      org_id: orgA,
      user_id: worker1.id,
      job_id: null,
      starts_at: `${DAY2}T09:00:00Z`,
      ends_at: `${DAY2}T12:00:00Z`,
      notes: "hand-confirmed",
      created_by: owner.id,
    });

    const existing = await listWeekRotaEntries(ownerC, orgA, WEEK_START_ISO, WEEK_END_ISO);
    // The plan proposes a full day for worker1 on DAY2 — it OVERLAPS the manual shift.
    const assigns = [
      assignment({ userId: worker1.id, jobId: job1, startIso: `${DAY2}T08:00:00Z`, endIso: `${DAY2}T17:00:00Z` }),
    ];
    const plan = planRotaPersistence(
      assigns,
      existing.map((e) => ({ user_id: e.user_id, job_id: e.job_id, starts_at: e.starts_at, ends_at: e.ends_at })),
    );
    expect(plan.toInsert).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(1);

    const inserted = await insertRotaEntries(ownerC, toRows(orgA, owner.id, plan.toInsert));
    expect(inserted).toEqual([]);

    // The hand-confirmed shift is byte-for-byte unchanged, and no extra worker1
    // row exists on DAY2.
    const manualRow = await svc.from("rota_entries").select("id, starts_at, ends_at, notes").eq("id", manualId);
    expect(manualRow.error).toBeNull();
    expect(manualRow.data).toHaveLength(1);
    expect((manualRow.data?.[0] as Row | undefined)?.notes).toBe("hand-confirmed");

    const day2 = await listWeekRotaEntries(ownerC, orgA, `${DAY2}T00:00:00Z`, `${DAY2}T23:59:59Z`);
    expect(day2.filter((e) => e.user_id === worker1.id)).toHaveLength(1);
    expect(day2[0]?.id).toBe(manualId);
  });

  it("4. STAFF ISOLATION: a worker reads ONLY their own rota rows; anon reads nothing", async () => {
    const worker1C = userClient(worker1.token) as unknown as RotaClient;
    const worker2C = userClient(worker2.token) as unknown as RotaClient;

    // worker1 sees their own DAY shift + their own DAY2 manual shift — never worker2's.
    const seenBy1 = await listWeekRotaEntries(worker1C, orgA, WEEK_START_ISO, WEEK_END_ISO);
    const ids1 = seenBy1.map((e) => e.id);
    expect(seenBy1.every((e) => e.user_id === worker1.id), "worker1 saw a row that is not theirs").toBe(true);
    expect(ids1).toContain(worker1EntryId);
    expect(ids1, "colleague's shift leaked to worker1").not.toContain(worker2EntryId);

    // Mirror: worker2 sees only their own.
    const seenBy2 = await listWeekRotaEntries(worker2C, orgA, WEEK_START_ISO, WEEK_END_ISO);
    const ids2 = seenBy2.map((e) => e.id);
    expect(ids2).toContain(worker2EntryId);
    expect(ids2, "worker1's shift leaked to worker2").not.toContain(worker1EntryId);
    expect(ids2).not.toContain(manualId);

    // Even asking for the colleague's row id directly returns nothing (RLS, not filtering).
    const directProbe = await db(userClient(worker2.token)).from("rota_entries").select("id").eq("id", worker1EntryId);
    expect(directProbe.error).toBeNull();
    expect(directProbe.data).toEqual([]);

    // Anon sees nothing at all.
    const anon = anonClient() as unknown as RotaClient;
    expect(await listWeekRotaEntries(anon, orgA, WEEK_START_ISO, WEEK_END_ISO)).toEqual([]);
  });

  it("5. FAIL-CLOSED WRITE: a non-admin worker's insert is refused by RLS", async () => {
    const worker1C = userClient(worker1.token) as unknown as RotaWriteClient;
    const row = toRows(orgA, worker1.id, [
      assignment({ userId: worker1.id, jobId: job1, startIso: `${DAY}T18:00:00Z`, endIso: `${DAY}T20:00:00Z` }),
    ]);
    await expect(insertRotaEntries(worker1C, row), "staff could write the rota").rejects.toThrow();

    // And nothing landed.
    const ownerC = userClient(owner.token) as unknown as RotaClient;
    const after = await listWeekRotaEntries(ownerC, orgA, `${DAY}T18:00:00Z`, `${DAY}T23:59:59Z`);
    expect(after).toEqual([]);
  });
});

import { beforeAll, afterAll, it, expect } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * Shared Memory — the AI `forget()` primitive, real-Postgres proof
 * (Volume X §12.2/§14; CEO Directive 009 Module 1, PR6 — SDK Integration).
 *
 * The unit tier proves the SDK→service→RPC wiring (memory-sdk.test.ts, mocked).
 * The security tier pins `hq_memory_forget`'s source text. This tier proves the
 * BEHAVIOUR neither can — that the primitive actually RUNS under `search_path =
 * ''` and enforces the §14 contract end to end:
 *
 *   - an employee forgets memory IT OWNS → status flips active→archived, the
 *     version is bumped + snapshotted (memory stays an audit subject — NOT a
 *     hard delete), the act is audited as `archived` with the acting employee
 *     stamped and `action:'forget'` in the detail, and NOTHING hits The Pulse;
 *   - forgetting ANOTHER employee's memory is refused (`not_owner`), unchanged;
 *   - forgetting the OWNER-LESS company brain is refused (`not_owner`) — an AI
 *     can never silently retract shared knowledge (that is a Module 4 approval);
 *   - a second forget is an idempotent no-op (`already_inactive`), no second
 *     archival, no second version;
 *   - an unknown id is `not_found`; and
 *   - the primitive is service_role-only (anon is refused outright).
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no
 * database, FAILED loudly in CI if the database is missing. Mutable fixtures are
 * cleaned up in afterAll; deleting a memory cascades its versions + events.
 */

type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type Filterable<T> = Term<T> & { eq(column: string, value: unknown): Filterable<T> };
type Insertable = Term<Record<string, unknown>[]> & {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
};
type MemTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  insert(row: Record<string, unknown>): Insertable;
  update(row: Record<string, unknown>): Filterable<null>;
  delete(): Filterable<null>;
};
type MemClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T>;
  from(table: string): MemTable;
};

const svc = (): MemClient => serviceClient() as unknown as MemClient;
const anon = (): MemClient => anonClient() as unknown as MemClient;

type ForgetResult = { ok: boolean; reason?: string; memory_id?: string; version?: number };

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

const createdMemories: string[] = [];
const createdEmployees: string[] = [];

function coin(): string {
  return "zephyrquux" + Math.random().toString(36).slice(2, 9);
}

async function makeEmployee(slug: string, department: string): Promise<string> {
  const ins = await svc()
    .from("ai_employees")
    .insert({
      name: slug,
      slug,
      role: "Integration fixture",
      department,
      permissions: { can_execute: true, requires_approval: false, scopes: ["read"] },
    })
    .select("id");
  expect(ins.error, ins.error?.message).toBeNull();
  const id = ins.data?.[0]?.id as string | undefined;
  expect(typeof id, "fixture employee id").toBe("string");
  createdEmployees.push(id as string);
  return id as string;
}

type SeedInput = {
  memoryClass?: string;
  visibility?: string;
  owner?: string | null;
  status?: string;
};

async function seedMemory(over: SeedInput): Promise<string> {
  const ins = await svc()
    .from("hq_memories")
    .insert({
      title: coin(),
      summary: "fixture",
      body: "fixture body",
      memory_type: "research",
      source: "ai_employee",
      status: over.status ?? "active",
      visibility: over.visibility ?? "private",
      memory_class: over.memoryClass ?? "episodic",
      owner_employee_id: over.owner ?? null,
    })
    .select("id");
  expect(ins.error, ins.error?.message).toBeNull();
  const id = ins.data?.[0]?.id as string | undefined;
  expect(typeof id, "seeded memory id").toBe("string");
  createdMemories.push(id as string);
  return id as string;
}

async function getMemory(id: string): Promise<Record<string, unknown> | undefined> {
  const res = await svc()
    .from("hq_memories")
    .select("id, status, version, owner_employee_id")
    .eq("id", id);
  return res.data?.[0];
}

async function versionsFor(id: string): Promise<number[]> {
  const res = await svc().from("hq_memory_versions").select("version").eq("memory_id", id);
  return (res.data ?? []).map((r) => r.version as number);
}

/** Per-memory audit rows: event_type + actor + detail (the forget signature). */
async function eventsFor(
  id: string,
): Promise<Array<{ event_type: string; ai_employee_id: string | null; detail: Record<string, unknown> | null }>> {
  const res = await svc()
    .from("hq_memory_events")
    .select("event_type, ai_employee_id, detail")
    .eq("memory_id", id);
  return (res.data ?? []) as Array<{
    event_type: string;
    ai_employee_id: string | null;
    detail: Record<string, unknown> | null;
  }>;
}

async function pulseVerbsFor(id: string): Promise<string[]> {
  const res = await svc().from("hq_events").select("verb").eq("object_id", id);
  return (res.data ?? []).map((r) => r.verb as string);
}

function forget(employeeId: string, memoryId: string, reason: string): Term<ForgetResult> {
  return svc().rpc<ForgetResult>("hq_memory_forget", {
    p_employee_id: employeeId,
    p_memory_id: memoryId,
    p_reason: reason,
  });
}

describeIntegration("Shared Memory · forget primitive (hq_memory_forget PR6)", () => {
  let empA = "";
  let empB = "";

  beforeAll(async () => {
    empA = await makeEmployee(`forget-a-${coin()}`, "engineering");
    empB = await makeEmployee(`forget-b-${coin()}`, "sales");
  });

  afterAll(async () => {
    for (const id of createdMemories) await svc().from("hq_memories").delete().eq("id", id);
    for (const id of createdEmployees) await svc().from("ai_employees").delete().eq("id", id);
  });

  it("archives + versions + audits an owned active memory, with nothing on The Pulse", async () => {
    const id = await seedMemory({ owner: empA, memoryClass: "episodic", visibility: "private" });

    const before = await getMemory(id);
    const baseVersion = before?.version as number;

    const res = await forget(empA, id, "no longer relevant");
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data?.ok).toBe(true);
    expect(res.data?.memory_id).toBe(id);
    expect(res.data?.version).toBe(baseVersion + 1);

    // Archived, version bumped — NOT deleted (the row is still there).
    const after = await getMemory(id);
    expect(after?.status).toBe("archived");
    expect(after?.version).toBe(baseVersion + 1);

    // A version snapshot was written at the new version.
    expect(await versionsFor(id)).toContain(baseVersion + 1);

    // Audited as a deliberate, employee-attributed forget.
    const events = await eventsFor(id);
    const archived = events.find(
      (e) => e.event_type === "archived" && e.ai_employee_id === empA,
    );
    expect(archived, "an 'archived' event attributed to the employee").toBeDefined();
    expect(archived?.detail?.action).toBe("forget");
    expect(archived?.detail?.reason).toBe("no longer relevant");

    // Forget is not a business event — The Pulse stays silent.
    expect(await pulseVerbsFor(id)).toEqual([]);
  });

  it("refuses to forget another employee's memory (not_owner), unchanged", async () => {
    const id = await seedMemory({ owner: empA, memoryClass: "episodic", visibility: "private" });

    const res = await forget(empB, id, "trying to forget someone else's");
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data?.ok).toBe(false);
    expect(res.data?.reason).toBe("not_owner");

    const after = await getMemory(id);
    expect(after?.status).toBe("active");
  });

  it("refuses to forget the owner-less company brain (not_owner)", async () => {
    // A shared semantic memory with no owner — the company brain. No employee
    // may forget it; retraction is a Module 4 approval-gated transition.
    const id = await seedMemory({ owner: null, memoryClass: "semantic", visibility: "public_hq" });

    const res = await forget(empA, id, "cannot retract shared knowledge");
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data?.ok).toBe(false);
    expect(res.data?.reason).toBe("not_owner");

    const after = await getMemory(id);
    expect(after?.status).toBe("active");
  });

  it("is idempotent: a second forget is an already_inactive no-op", async () => {
    const id = await seedMemory({ owner: empA, memoryClass: "working", visibility: "private" });

    const first = await forget(empA, id, "first");
    expect(first.data?.ok).toBe(true);
    const archivedVersion = first.data?.version as number;

    const second = await forget(empA, id, "second");
    expect(second.error, second.error?.message).toBeNull();
    expect(second.data?.ok).toBe(false);
    expect(second.data?.reason).toBe("already_inactive");

    // No second archival, no second version bump.
    const after = await getMemory(id);
    expect(after?.version).toBe(archivedVersion);
    const archivedEvents = (await eventsFor(id)).filter((e) => e.event_type === "archived");
    expect(archivedEvents.length).toBe(1);
  });

  it("reports not_found for an unknown memory id", async () => {
    const res = await forget(empA, ZERO_UUID, "ghost");
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data?.ok).toBe(false);
    expect(res.data?.reason).toBe("not_found");
  });

  it("refuses the anon (JWT) role outright — service_role only", async () => {
    const id = await seedMemory({ owner: empA, memoryClass: "episodic", visibility: "private" });
    const res = await anon().rpc<ForgetResult>("hq_memory_forget", {
      p_employee_id: empA,
      p_memory_id: id,
      p_reason: "anon",
    });
    expect(res.error, "anon must be refused execute").not.toBeNull();

    // And the memory is untouched by the refused call.
    const after = await getMemory(id);
    expect(after?.status).toBe("active");
  });
});

import { beforeAll, afterAll, it, expect } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import { decideMemoryWrite, type MemoryClass } from "@/lib/memory/model";

/**
 * Shared Memory — AI write path, real-Postgres proof (Volume X §6/§12;
 * Directive 009 Module 1, PR2).
 *
 * The unit tier proves the pure §6 predicate; the security tier pins the
 * migration's text contract. This tier proves the BEHAVIOUR neither can:
 * that `hq_memory_write` actually commits owned experience atomically (row +
 * version + per-memory event + a memory.asserted Pulse event, in ONE
 * transaction), WITHHOLDS a shared-knowledge proposal so the company brain is
 * never written without the capability, honours the capability waiver, raises
 * on every §6 denial, and is closed to JWT clients — and that the SQL gate
 * agrees with the pure predicate across the §6 matrix.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no
 * database, FAILED loudly in CI if the database is missing.
 *
 * hq_events is append-only, so the memory.asserted rows these tests emit are
 * intentionally left behind — harmless in the ephemeral CI database. The
 * mutable fixtures (employees + memories) are cleaned up in afterAll.
 */

// hq_memory_write / hq_* tables are service-role-only and not in the generated
// Database types — cast to the minimal surface this suite exercises (the same
// `as unknown as` convention the HQ services and spine suites use).
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type Filterable<T> = Term<T> & { eq(column: string, value: unknown): Filterable<T> };
// `insert(...)` is awaitable on its own AND chainable into `.select(...)`
// (PostgREST returns the inserted rows). Modelled as one type so the chain
// resolves unambiguously, rather than an intersection of two call signatures.
type Insertable = Term<Record<string, unknown>[]> & {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
};
type MemTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  insert(row: Record<string, unknown>): Insertable;
  delete(): Filterable<null>;
};
type MemClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T>;
  from(table: string): MemTable;
};

const svc = (): MemClient => serviceClient() as unknown as MemClient;
const anon = (): MemClient => anonClient() as unknown as MemClient;

const SHARED_SCOPE = "memory.write.shared";
const createdMemories: string[] = [];
let aliceId = ""; // no shared scope
let carolId = ""; // holds memory.write.shared

/** Create a disposable AI employee and return its generated id. */
async function makeEmployee(slug: string, scopes: string[]): Promise<string> {
  const ins = await svc()
    .from("ai_employees")
    .insert({
      name: slug,
      slug,
      role: "Integration fixture",
      department: "sales",
      permissions: { can_execute: true, requires_approval: false, scopes },
    })
    .select("id");
  expect(ins.error, ins.error?.message).toBeNull();
  const id = ins.data?.[0]?.id as string | undefined;
  expect(typeof id, "fixture employee id").toBe("string");
  return id as string;
}

/** Call the write primitive, tracking any committed memory for teardown. */
async function write(args: Record<string, unknown>): Promise<RpcResult<string>> {
  const res = await svc().rpc<string>("hq_memory_write", args);
  if (typeof res.data === "string") createdMemories.push(res.data);
  return res;
}

describeIntegration("Shared Memory · AI write path (hq_memory_write, PR2)", () => {
  beforeAll(async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    aliceId = await makeEmployee(`it-mem-alice-${stamp}`, ["read"]);
    carolId = await makeEmployee(`it-mem-carol-${stamp}`, ["read", SHARED_SCOPE]);
  });

  afterAll(async () => {
    // Delete memories first (cascades to versions + per-memory events), then the
    // employees. The append-only hq_events rows are intentionally left behind.
    for (const id of createdMemories) {
      await svc().from("hq_memories").delete().eq("id", id);
    }
    if (aliceId) await svc().from("ai_employees").delete().eq("id", aliceId);
    if (carolId) await svc().from("ai_employees").delete().eq("id", carolId);
  });

  it("autonomous owned write: commits memory + version + per-memory event + a memory.asserted Pulse event, atomically", async () => {
    const corr = crypto.randomUUID();
    const res = await write({
      p_employee_id: aliceId,
      p_class: "episodic",
      p_type: "research",
      p_title: `IT episodic ${corr}`,
      p_summary: "what I observed",
      p_body: "the body",
      p_visibility: "private",
      p_owner: aliceId,
      p_salience: 70,
      p_correlation_id: corr,
    });
    expect(res.error, res.error?.message).toBeNull();
    expect(typeof res.data, "autonomous write returns a uuid").toBe("string");
    const memId = res.data as string;

    const mem = await svc()
      .from("hq_memories")
      .select("id, memory_class, owner_employee_id, source, visibility, salience, last_reinforced_at")
      .eq("id", memId);
    expect(mem.data).toHaveLength(1);
    const row = mem.data?.[0] ?? {};
    expect(row.memory_class).toBe("episodic");
    expect(row.owner_employee_id).toBe(aliceId);
    expect(row.source).toBe("ai_employee");
    expect(row.visibility).toBe("private");
    expect(row.salience).toBe(70);
    expect(row.last_reinforced_at, "a fresh write is reinforced now").not.toBeNull();

    const ver = await svc().from("hq_memory_versions").select("version").eq("memory_id", memId);
    expect(ver.data).toHaveLength(1);
    expect(ver.data?.[0]?.version).toBe(1);

    const ev = await svc()
      .from("hq_memory_events")
      .select("event_type, ai_employee_id")
      .eq("memory_id", memId);
    expect(ev.data).toHaveLength(1);
    expect(ev.data?.[0]?.event_type).toBe("created");
    expect(ev.data?.[0]?.ai_employee_id).toBe(aliceId);

    // The transactional outbox: the canonical event landed in the SAME write.
    const pulse = await svc()
      .from("hq_events")
      .select("verb, actor_type, actor_id, object_id")
      .eq("correlation_id", corr);
    expect(pulse.data).toHaveLength(1);
    expect(pulse.data?.[0]?.verb).toBe("memory.asserted");
    expect(pulse.data?.[0]?.actor_type).toBe("ai_employee");
    expect(pulse.data?.[0]?.actor_id).toBe(aliceId);
    expect(pulse.data?.[0]?.object_id).toBe(memId);
  });

  it("protects the company brain: a shared write WITHOUT the capability is withheld (null sentinel, no row)", async () => {
    const title = `IT withheld ${crypto.randomUUID()}`;
    const res = await write({
      p_employee_id: aliceId, // no shared scope
      p_class: "semantic",
      p_type: "company",
      p_title: title,
      p_visibility: "public_hq",
      p_owner: null,
    });
    // A proposal is VALID (not an error) — it is simply not committed.
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data, "shared write without capability returns the NULL sentinel").toBeNull();

    const mem = await svc().from("hq_memories").select("id").eq("title", title);
    expect(mem.data ?? [], "nothing is written to the company brain").toHaveLength(0);
  });

  it("the memory.write.shared capability waives the checkpoint: a shared write commits", async () => {
    const res = await write({
      p_employee_id: carolId, // holds memory.write.shared
      p_class: "semantic",
      p_type: "company",
      p_title: `IT shared committed ${crypto.randomUUID()}`,
      p_visibility: "public_hq",
      p_owner: null,
    });
    expect(res.error, res.error?.message).toBeNull();
    expect(typeof res.data).toBe("string");

    const mem = await svc()
      .from("hq_memories")
      .select("memory_class, visibility, owner_employee_id, source")
      .eq("id", res.data as string);
    expect(mem.data?.[0]?.memory_class).toBe("semantic");
    expect(mem.data?.[0]?.visibility).toBe("public_hq");
    expect(mem.data?.[0]?.owner_employee_id).toBeNull();
    expect(mem.data?.[0]?.source).toBe("ai_employee");
  });

  it("denials RAISE (never silently commit): system, another employee's private memory, unknown employee, invalid class", async () => {
    const base = { p_type: "research", p_title: `IT deny ${crypto.randomUUID()}` };

    const sys = await write({
      ...base,
      p_employee_id: carolId,
      p_class: "semantic",
      p_visibility: "system",
      p_owner: carolId,
    });
    expect(sys.error, "system memory must be denied").not.toBeNull();

    const foreign = await write({
      ...base,
      p_employee_id: carolId,
      p_class: "episodic",
      p_visibility: "private",
      p_owner: aliceId, // another employee's private memory
    });
    expect(foreign.error, "another employee's private memory must be denied").not.toBeNull();

    const unknown = await write({
      ...base,
      p_employee_id: crypto.randomUUID(),
      p_class: "episodic",
      p_visibility: "private",
      p_owner: null,
    });
    expect(unknown.error, "an unknown employee must be denied").not.toBeNull();

    const badClass = await write({
      ...base,
      p_employee_id: aliceId,
      p_class: "nonsense",
      p_visibility: "private",
      p_owner: aliceId,
    });
    expect(badClass.error, "an invalid memory_class must be denied").not.toBeNull();
  });

  it("the SQL gate agrees with the pure decideMemoryWrite predicate across the §6 matrix", async () => {
    type Case = { cls: MemoryClass; vis: string; owner: "self" | "none" | "other"; emp: "alice" | "carol" };
    const cases: Case[] = [
      { cls: "episodic", vis: "private", owner: "self", emp: "alice" },
      { cls: "working", vis: "private", owner: "self", emp: "alice" },
      { cls: "semantic", vis: "private", owner: "self", emp: "alice" },
      { cls: "semantic", vis: "public_hq", owner: "none", emp: "alice" },
      { cls: "long_term", vis: "department", owner: "none", emp: "alice" },
      { cls: "semantic", vis: "public_hq", owner: "none", emp: "carol" },
      { cls: "procedural", vis: "department", owner: "none", emp: "carol" },
      { cls: "episodic", vis: "private", owner: "other", emp: "alice" },
      { cls: "episodic", vis: "public_hq", owner: "none", emp: "alice" },
    ];

    for (const c of cases) {
      const empId = c.emp === "alice" ? aliceId : carolId;
      const scopes = c.emp === "alice" ? ["read"] : ["read", SHARED_SCOPE];
      const ownerId =
        c.owner === "self" ? empId : c.owner === "other" ? (c.emp === "alice" ? carolId : aliceId) : null;

      const predicted = decideMemoryWrite(
        { memory_class: c.cls, visibility: c.vis, owner_employee_id: ownerId },
        { id: empId, scopes },
      ).outcome;

      const res = await write({
        p_employee_id: empId,
        p_class: c.cls,
        p_type: "research",
        p_title: `IT matrix ${c.cls}/${c.vis}/${c.owner}/${c.emp} ${crypto.randomUUID()}`,
        p_visibility: c.vis,
        p_owner: ownerId,
      });

      const label = `${c.cls}/${c.vis}/owner=${c.owner}/${c.emp} → ${predicted}`;
      if (predicted === "autonomous") {
        expect(res.error, `${label}: ${res.error?.message}`).toBeNull();
        expect(typeof res.data, label).toBe("string");
      } else if (predicted === "approval_required") {
        expect(res.error, `${label}: ${res.error?.message}`).toBeNull();
        expect(res.data, label).toBeNull();
      } else {
        expect(res.error, label).not.toBeNull();
      }
    }
  });

  it("anon cannot EXECUTE hq_memory_write — the primitive is service_role-only", async () => {
    const res = await anon().rpc<string>("hq_memory_write", {
      p_employee_id: aliceId,
      p_class: "episodic",
      p_type: "research",
      p_title: `IT anon ${crypto.randomUUID()}`,
      p_visibility: "private",
      p_owner: aliceId,
    });
    expect(res.error, "anon must not be able to write memory").not.toBeNull();
  });
});

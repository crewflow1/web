import { beforeAll, afterAll, it, expect } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import { canEmployeeAccess } from "@/lib/memory/model";

/**
 * Shared Memory — AI recall path, real-Postgres proof (Volume X §7/§8/§12;
 * Directive 009 Module 1, PR3).
 *
 * The unit tier proves the pure §7.3→§7.4→§8 ranking; the security tier pins
 * the migration's text contract. This tier proves the BEHAVIOUR neither can:
 * that `hq_memory_recall` filters by the §6 permission rules IN SQL (stage 1),
 * so an employee can NEVER retrieve another's private memory, an off-department
 * memory, or engine-internal `system` memory through ANY channel; that an
 * explicit grant widens access; that hybrid ranking (lexical + structural)
 * works with embeddings OFF; that the class filter and structural-subject
 * recall behave; that `hq_memory_reinforce` reinforces + audits the assembled
 * set; that the SQL gate AGREES with the pure `canEmployeeAccess` predicate
 * across the §6 matrix; and that both primitives are closed to JWT clients.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no
 * database, FAILED loudly in CI if the database is missing.
 *
 * The mutable fixtures (employees + memories) are cleaned up in afterAll;
 * deleting a memory cascades its grants, relationships and (ai_accessed) events.
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
  delete(): Filterable<null>;
};
type MemClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T>;
  from(table: string): MemTable;
};

const svc = (): MemClient => serviceClient() as unknown as MemClient;
const anon = (): MemClient => anonClient() as unknown as MemClient;

/** A recall candidate row (subset the assertions need). */
type CandidateRow = {
  id: string;
  ts_rank: number;
  structural_match: number;
  memory_class: string;
  visibility: string;
};

const createdMemories: string[] = [];
let aliceId = ""; // sales
let bobId = ""; // engineering

/** A coined, hyphen-free token so a recall query isolates exactly the seeded rows. */
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
  return id as string;
}

type SeedInput = {
  title: string;
  visibility: string;
  department?: string | null;
  owner?: string | null;
  memoryClass?: string;
  salience?: number;
  pinned?: boolean;
  body?: string;
};

/** Insert a memory fixture directly (ground-truth setup) and track it for teardown. */
async function seedMemory(over: SeedInput): Promise<string> {
  const ins = await svc()
    .from("hq_memories")
    .insert({
      title: over.title,
      summary: "",
      body: over.body ?? "",
      memory_type: "research",
      source: "ai_employee",
      status: "active",
      visibility: over.visibility,
      department: over.department ?? null,
      memory_class: over.memoryClass ?? "semantic",
      owner_employee_id: over.owner ?? null,
      salience: over.salience ?? 50,
      pinned: over.pinned ?? false,
    })
    .select("id");
  expect(ins.error, ins.error?.message).toBeNull();
  const id = ins.data?.[0]?.id as string | undefined;
  expect(typeof id, `seeded memory id (${over.title})`).toBe("string");
  createdMemories.push(id as string);
  return id as string;
}

async function recall(args: Record<string, unknown>): Promise<RpcResult<CandidateRow[]>> {
  return svc().rpc<CandidateRow[]>("hq_memory_recall", args);
}

const idsOf = (res: RpcResult<CandidateRow[]>): string[] => (res.data ?? []).map((r) => r.id);

describeIntegration("Shared Memory · AI recall path (hq_memory_recall, PR3)", () => {
  beforeAll(async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    aliceId = await makeEmployee(`it-recall-alice-${stamp}`, "sales");
    bobId = await makeEmployee(`it-recall-bob-${stamp}`, "engineering");
  });

  afterAll(async () => {
    for (const id of createdMemories) {
      await svc().from("hq_memories").delete().eq("id", id);
    }
    if (aliceId) await svc().from("ai_employees").delete().eq("id", aliceId);
    if (bobId) await svc().from("ai_employees").delete().eq("id", bobId);
  });

  it("stage-1 permission filter: never returns another employee's private, an off-department, or system memory", async () => {
    const term = coin();
    const pub = await seedMemory({ title: `pub ${term}`, visibility: "public_hq" });
    const aPriv = await seedMemory({ title: `apriv ${term}`, visibility: "private", owner: aliceId });
    const bPriv = await seedMemory({ title: `bpriv ${term}`, visibility: "private", owner: bobId });
    const salesDept = await seedMemory({ title: `sales ${term}`, visibility: "department", department: "sales" });
    const engDept = await seedMemory({ title: `eng ${term}`, visibility: "department", department: "engineering" });
    const sys = await seedMemory({ title: `sys ${term}`, visibility: "system", owner: aliceId });

    const res = await recall({ p_employee_id: aliceId, p_query: term, p_limit: 100 });
    expect(res.error, res.error?.message).toBeNull();
    const ids = idsOf(res);

    // Permitted to alice (sales): public, her own private, her department.
    expect(ids).toContain(pub);
    expect(ids).toContain(aPriv);
    expect(ids).toContain(salesDept);
    // Forbidden: another's private, another department, engine-internal system.
    expect(ids).not.toContain(bPriv);
    expect(ids).not.toContain(engDept);
    expect(ids, "system memory is NEVER recalled, even when owned").not.toContain(sys);
  });

  it("an explicit grant widens access: a restricted memory granted to the department is recalled", async () => {
    const term = coin();
    const granted = await seedMemory({ title: `granted ${term}`, visibility: "restricted", owner: bobId });
    const ungranted = await seedMemory({ title: `ungranted ${term}`, visibility: "restricted", owner: bobId });

    const g = await svc()
      .from("hq_memory_access_grants")
      .insert({ memory_id: granted, grantee_type: "department", grantee_value: "sales" });
    expect(g.error, g.error?.message).toBeNull();

    const ids = idsOf(await recall({ p_employee_id: aliceId, p_query: term, p_limit: 100 }));
    expect(ids, "the department grant is honoured").toContain(granted);
    expect(ids, "an ungranted restricted memory stays hidden").not.toContain(ungranted);
  });

  it("hybrid ranking with embeddings OFF: a lexical match is recalled (ts_rank > 0), an irrelevant memory is not", async () => {
    const term = coin();
    const match = await seedMemory({ title: `runbook ${term} migration`, visibility: "public_hq" });
    const noMatch = await seedMemory({ title: `entirely unrelated note ${coin()}`, visibility: "public_hq" });

    // queryEmbedding is deliberately omitted (null) — recall must work on the
    // lexical channel alone until pgvector is switched on (PR4).
    const res = await recall({ p_employee_id: aliceId, p_query: term, p_query_embedding: null, p_limit: 100 });
    const rows = res.data ?? [];
    const hit = rows.find((r) => r.id === match);
    expect(hit, "the lexical match is a candidate").toBeTruthy();
    expect(hit?.ts_rank, "lexical rank is a positive signal").toBeGreaterThan(0);
    expect(rows.map((r) => r.id), "an irrelevant memory is not pulled in by a query").not.toContain(noMatch);
  });

  it("the class filter restricts recall to the requested cognitive classes", async () => {
    const term = coin();
    const proc = await seedMemory({ title: `proc ${term}`, visibility: "public_hq", memoryClass: "procedural" });
    const sem = await seedMemory({ title: `sem ${term}`, visibility: "public_hq", memoryClass: "semantic" });

    const ids = idsOf(
      await recall({ p_employee_id: aliceId, p_query: term, p_class_filter: ["procedural"], p_limit: 100 }),
    );
    expect(ids).toContain(proc);
    expect(ids, "the semantic memory is filtered out").not.toContain(sem);
  });

  it("structural recall: a memory linked to the task subject is pulled in WITHOUT a lexical match", async () => {
    const featureId = `feat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const linked = await seedMemory({ title: `owl dashboard ${coin()}`, visibility: "public_hq" });
    const rel = await svc().from("hq_memory_relationships").insert({
      memory_id: linked,
      entity_type: "feature",
      entity_id: featureId,
      entity_label: "Owl dashboard",
      relation: "related_to",
    });
    expect(rel.error, rel.error?.message).toBeNull();

    // A query term that matches NOTHING — only the structural edge can surface it.
    const res = await recall({
      p_employee_id: aliceId,
      p_query: coin(),
      p_subject_kind: "feature",
      p_subject_id: featureId,
      p_limit: 100,
    });
    const hit = (res.data ?? []).find((r) => r.id === linked);
    expect(hit, "the structurally-linked memory is recalled despite no lexical hit").toBeTruthy();
    expect(hit?.structural_match, "structural match is signalled to the ranker").toBe(1);
  });

  it("hq_memory_reinforce reinforces the assembled set and writes the ai_accessed audit", async () => {
    const mem = await seedMemory({ title: `reinforce ${coin()}`, visibility: "public_hq" });

    const r = await svc().rpc("hq_memory_reinforce", { p_employee_id: aliceId, p_memory_ids: [mem] });
    expect(r.error, r.error?.message).toBeNull();

    const after = await svc()
      .from("hq_memories")
      .select("last_reinforced_at, access_count")
      .eq("id", mem);
    const row = after.data?.[0] ?? {};
    expect(row.last_reinforced_at, "recall reinforces decay (last_reinforced_at set)").not.toBeNull();
    expect(row.access_count, "recall bumps the popularity counter").toBe(1);

    const ev = await svc()
      .from("hq_memory_events")
      .select("event_type, ai_employee_id")
      .eq("memory_id", mem);
    const accessed = (ev.data ?? []).filter((e) => e.event_type === "ai_accessed");
    expect(accessed, "a per-memory ai_accessed event is written").toHaveLength(1);
    expect(accessed[0]?.ai_employee_id, "the read is attributed to the employee").toBe(aliceId);

    // Idempotent / safe on an empty set (the no-assembled-items path).
    const empty = await svc().rpc("hq_memory_reinforce", { p_employee_id: aliceId, p_memory_ids: [] });
    expect(empty.error, "reinforcing nothing is a no-op, not an error").toBeNull();
  });

  it("the SQL gate agrees with the pure canEmployeeAccess predicate across the §6 matrix", async () => {
    type Case = { vis: string; owner: "alice" | "bob" | "none"; dept: string | null };
    const cases: Case[] = [
      { vis: "public_hq", owner: "none", dept: null },
      { vis: "private", owner: "alice", dept: null },
      { vis: "private", owner: "bob", dept: null },
      { vis: "department", owner: "none", dept: "sales" },
      { vis: "department", owner: "none", dept: "engineering" },
      { vis: "department", owner: "alice", dept: "engineering" },
      { vis: "restricted", owner: "none", dept: null },
      { vis: "restricted", owner: "alice", dept: null },
      { vis: "system", owner: "alice", dept: "sales" },
    ];

    for (const c of cases) {
      const ownerId = c.owner === "alice" ? aliceId : c.owner === "bob" ? bobId : null;
      const predicted = canEmployeeAccess(
        { visibility: c.vis, department: c.dept, owner_employee_id: ownerId },
        { id: aliceId, department: "sales" },
        [],
      );

      const term = coin();
      const id = await seedMemory({
        title: `matrix ${term}`,
        visibility: c.vis,
        department: c.dept,
        owner: ownerId,
      });

      const ids = idsOf(await recall({ p_employee_id: aliceId, p_query: term, p_limit: 100 }));
      const label = `${c.vis}/owner=${c.owner}/dept=${c.dept} → ${predicted ? "readable" : "hidden"}`;
      expect(ids.includes(id), label).toBe(predicted);
    }
  });

  it("recall raises on an unknown employee (fail-closed, no candidate leak)", async () => {
    const res = await recall({ p_employee_id: crypto.randomUUID(), p_query: coin() });
    expect(res.error, "an unknown employee must be denied").not.toBeNull();
  });

  it("anon cannot EXECUTE the recall primitives — they are service_role-only", async () => {
    const r1 = await anon().rpc<CandidateRow[]>("hq_memory_recall", {
      p_employee_id: aliceId,
      p_query: coin(),
    });
    expect(r1.error, "anon must not be able to recall memory").not.toBeNull();

    const r2 = await anon().rpc("hq_memory_reinforce", { p_employee_id: aliceId, p_memory_ids: [] });
    expect(r2.error, "anon must not be able to reinforce memory").not.toBeNull();
  });
});

import { beforeAll, afterAll, it, expect } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Shared Memory — the SEMANTIC (ANN) recall channel, real-Postgres proof
 * (Volume X §7/§16; CEO Directive 009 Module 1, PR4d).
 *
 * The unit tier proves the TS seam (recallMemory generates the probe + degrades
 * gracefully) and the security tier pins the migration's text. This tier proves
 * the BEHAVIOUR only a live pgvector can — that the migration actually RUNS and
 * is correct under `search_path = ''`:
 *
 *   - the `p_query_embedding::real[]::public.vector` cast and the
 *     `OPERATOR(public.<=>)` cosine distance resolve and execute (this would
 *     fail at runtime if the type/operator weren't schema-qualified);
 *   - semantic recall is ADDITIVE — a memory with NO lexical/structural overlap
 *     is surfaced purely by vector proximity, while a lexical-only row still
 *     comes back (with a null cos_sim);
 *   - PERMISSION isolation holds in the ANN channel — the nearest vector that
 *     belongs to another employee's private memory is NEVER returned (a vector
 *     inherits its memory's permissions);
 *   - VERSION + DIMENSION isolation hold — a vector embedded under a different
 *     version, or tagged with a different dimension, is never compared;
 *   - the channel is GATED by its args — with a null embedding/version, the
 *     same semantic-only memory is invisible (graceful fallback to lexical).
 *
 * Runs only against a live DB (describeIntegration). Fixtures are cleaned up in
 * afterAll; deleting a memory cascades its grants, relationships and events.
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

/** A recall candidate row (the subset the ANN assertions need). */
type CandidateRow = {
  id: string;
  ts_rank: number;
  structural_match: number;
  cos_sim: number | null;
  memory_class: string;
  visibility: string;
};

// "Version 1" identity (matches the OpenAI provider's info.version for d1536).
const DIM = 1536;
const V1 = "openai:text-embedding-3-small:d1536:v1";
const V2 = "openai:text-embedding-3-small:d1536:v2"; // a different revision

const createdMemories: string[] = [];
let aliceId = ""; // sales
let bobId = ""; // engineering

/** A coined, hyphen-free token so a recall query isolates exactly the seeded rows. */
function coin(): string {
  return "zephyrquux" + Math.random().toString(36).slice(2, 9);
}

/** A 1536-d unit basis vector (1 at `i`, 0 elsewhere) — controls cosine exactly. */
function basis(i: number): number[] {
  const a = new Array<number>(DIM).fill(0);
  a[i] = 1;
  return a;
}

/** pgvector text input format: `[v1,v2,…]`. */
function vlit(a: number[]): string {
  return `[${a.join(",")}]`;
}

async function makeEmployee(slug: string, department: string): Promise<string> {
  const ins = await svc()
    .from("ai_employees")
    .insert({
      name: slug,
      slug,
      role: "Integration fixture",
      department,
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
  body?: string;
  /** Optional embedding (a DIM-length vector) + its versioned identity. */
  embedding?: number[];
  embeddingVersion?: string;
  embeddingDimension?: number;
};

/** Insert a memory fixture directly (ground-truth setup) and track it for teardown. */
async function seedMemory(over: SeedInput): Promise<string> {
  const row: Record<string, unknown> = {
    title: over.title,
    summary: "",
    body: over.body ?? "",
    memory_type: "research",
    source: "ai_employee",
    status: "active",
    visibility: over.visibility,
    department: over.department ?? null,
    memory_class: "semantic",
    owner_employee_id: over.owner ?? null,
  };
  if (over.embedding) {
    row.embedding = vlit(over.embedding);
    row.embedding_version = over.embeddingVersion ?? V1;
    row.embedding_dimension = over.embeddingDimension ?? over.embedding.length;
    row.embedding_status = "embedded";
    row.embedded_at = new Date().toISOString();
  }

  const ins = await svc().from("hq_memories").insert(row).select("id");
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
const rowOf = (res: RpcResult<CandidateRow[]>, id: string): CandidateRow | undefined =>
  (res.data ?? []).find((r) => r.id === id);

describeIntegration("Shared Memory · semantic recall (hq_memory_recall ANN, PR4d)", () => {
  beforeAll(async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    aliceId = await makeEmployee(`it-ann-alice-${stamp}`, "sales");
    bobId = await makeEmployee(`it-ann-bob-${stamp}`, "engineering");
  });

  afterAll(async () => {
    for (const id of createdMemories) {
      await svc().from("hq_memories").delete().eq("id", id);
    }
    if (aliceId) await svc().from("ai_employees").delete().eq("id", aliceId);
    if (bobId) await svc().from("ai_employees").delete().eq("id", bobId);
  });

  it("the cast + cosine operator run, and semantic is ADDITIVE to lexical", async () => {
    const lexTerm = coin();
    // Semantic-only: NO lexical/structural overlap, embedding == the query vector.
    const sem = await seedMemory({
      title: coin(),
      body: coin(),
      visibility: "public_hq",
      embedding: basis(0),
    });
    // Lexical-only: matches the query term, has NO embedding at all.
    const lex = await seedMemory({ title: `runbook ${lexTerm}`, visibility: "public_hq" });
    // Far vector (orthogonal to the query), same version, no lexical overlap.
    const far = await seedMemory({ title: coin(), visibility: "public_hq", embedding: basis(1) });

    const res = await recall({
      p_employee_id: aliceId,
      p_query: lexTerm,
      p_query_embedding: basis(0),
      p_query_version: V1,
      p_limit: 100,
    });
    expect(res.error, res.error?.message).toBeNull();

    // The semantic-only memory is surfaced PURELY by vector proximity, ~1.0.
    const semRow = rowOf(res, sem);
    expect(semRow, "semantic-only memory recalled via the ANN channel").toBeTruthy();
    expect(semRow?.cos_sim ?? 0, "an identical vector scores ~1").toBeGreaterThan(0.9);

    // The lexical-only memory still comes back — semantic never narrows the set.
    const lexRow = rowOf(res, lex);
    expect(lexRow, "lexical match still recalled (additive, not replaced)").toBeTruthy();
    expect(lexRow?.cos_sim ?? null, "a row with no vector has a null cos_sim").toBeNull();

    // The orthogonal vector, if returned, scores ~0 and ranks below the match.
    const farRow = rowOf(res, far);
    if (farRow) {
      expect(farRow.cos_sim ?? 0, "an orthogonal vector scores ~0").toBeLessThan(0.1);
      expect(
        (semRow?.cos_sim ?? 0) > (farRow.cos_sim ?? 0),
        "the near match out-scores the far one",
      ).toBe(true);
    }
  });

  it("PERMISSION isolation: the nearest vector of another's private memory is NEVER returned", async () => {
    // Bob's private memory whose vector is identical to alice's query.
    const bobPrivate = await seedMemory({
      title: coin(),
      visibility: "private",
      owner: bobId,
      embedding: basis(0),
    });

    const res = await recall({
      p_employee_id: aliceId,
      p_query: coin(), // matches nothing — only the vector could surface it
      p_query_embedding: basis(0),
      p_query_version: V1,
      p_limit: 100,
    });
    expect(res.error, res.error?.message).toBeNull();
    expect(
      idsOf(res),
      "a vector inherits its memory's permissions — semantic can't leak it",
    ).not.toContain(bobPrivate);
  });

  it("VERSION + DIMENSION isolation: a different-version or different-dimension vector is never compared", async () => {
    // Identical vector, but stamped with a DIFFERENT embedding version.
    const otherVersion = await seedMemory({
      title: coin(),
      visibility: "public_hq",
      embedding: basis(0),
      embeddingVersion: V2,
    });
    // Identical vector + matching version, but tagged with a different dimension.
    const otherDim = await seedMemory({
      title: coin(),
      visibility: "public_hq",
      embedding: basis(0),
      embeddingVersion: V1,
      embeddingDimension: 768,
    });

    const res = await recall({
      p_employee_id: aliceId,
      p_query: coin(), // no lexical hit — semantic is the only possible channel
      p_query_embedding: basis(0),
      p_query_version: V1,
      p_limit: 100,
    });
    expect(res.error, res.error?.message).toBeNull();

    const ids = idsOf(res);
    expect(ids, "a cross-version vector is filtered out of the ANN channel").not.toContain(
      otherVersion,
    );
    expect(ids, "a mismatched-dimension vector is filtered out of the ANN channel").not.toContain(
      otherDim,
    );
  });

  it("the semantic channel is GATED by its args — null probe ⇒ the same memory is invisible", async () => {
    // A semantic-only memory: no lexical term, embedding == the query vector.
    const sem = await seedMemory({ title: coin(), visibility: "public_hq", embedding: basis(0) });
    const noLexTerm = coin();

    // Probe ON → surfaced via ANN.
    const on = await recall({
      p_employee_id: aliceId,
      p_query: noLexTerm,
      p_query_embedding: basis(0),
      p_query_version: V1,
      p_limit: 100,
    });
    expect(idsOf(on), "semantic ON recalls the vector-only memory").toContain(sem);

    // Probe OFF (null embedding + null version) → degrades to lexical, which
    // misses it. Byte-identical to the PR3 behaviour (plug-in, not dependency).
    const off = await recall({
      p_employee_id: aliceId,
      p_query: noLexTerm,
      p_query_embedding: null,
      p_query_version: null,
      p_limit: 100,
    });
    expect(idsOf(off), "semantic OFF makes the vector-only memory invisible").not.toContain(sem);
  });
});

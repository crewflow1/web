import { beforeAll, afterAll, it, expect } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import {
  DEDUPE_COSINE_THRESHOLD,
  MIN_CONSOLIDATION_SOURCES,
  SUMMARY_MIN_BODY_CHARS,
} from "@/lib/memory/lifecycle";

/**
 * Shared Memory — the LIFECYCLE + REDUCTION engines, real-Postgres proof
 * (Volume X §9/§10/§15; CEO Directive 009 Module 1, PR5).
 *
 * The unit tier proves the pure §9/§10 policy (lib/memory/lifecycle.ts) and the
 * worker's orchestration (memory-lifecycle.test.ts, fully mocked). The security
 * tier pins the migration's text + the SQL↔TS invariants. This tier proves the
 * BEHAVIOUR neither can — that the migration actually RUNS and is correct under
 * `search_path = ''`, that the decay math + keeper rule + theme matching execute
 * in Postgres exactly as the policy says, and that every transition is atomic,
 * audited, reversible and permission-safe:
 *
 *   - the KILL-SWITCH truly gates the autonomous engines: with the worker
 *     disabled, expire_sweep is an explicit no-op and consolidate withholds —
 *     no row changes, no Pulse event (the only thing protecting the ungated
 *     apply primitives is the worker's own gate, so the SQL gate must agree);
 *   - TTL EXPIRY archives ephemeral memory past its clock, DECAY ARCHIVAL
 *     archives a consolidated episode below the retention floor, an
 *     UNCONSOLIDATED episode is NEVER decay-archived (its lesson would be lost),
 *     and durable company-brain classes are untouched — all in one bounded,
 *     idempotent sweep;
 *   - CONSOLIDATION rolls ≥ MIN_CONSOLIDATION_SOURCES themed episodes into ONE
 *     private long_term lesson, links (not archives) the sources, emits the
 *     canonical `memory.asserted`, and is naturally idempotent (a re-run finds
 *     < 3 fresh sources and no-ops);
 *   - DEDUPLICATION finds the near-duplicate pair purely by vector proximity,
 *     labels the survivor with the exact chooseDedupeKeeper rule, and a
 *     null-embedding row is never paired (embeddings are a plug-in, not a
 *     dependency); SUPERSESSION then merges the loser away atomically —
 *     status→superseded, version bumped, lineage edge recorded, `memory.superseded`
 *     emitted — and is idempotent;
 *   - SUMMARISATION detection returns the body to summarise in one read, the
 *     apply step persists + audits it and drops the row out of the candidate set;
 *   - GOLDEN SIGNALS reads the whole lifecycle in one call; and
 *   - every primitive is service_role-only (anon is refused).
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no
 * database, FAILED loudly in CI if the database is missing. The worker gate is a
 * global singleton — it is captured in beforeAll and RESTORED in afterAll, and
 * left enabled for every test except the explicit fail-dark one. Mutable
 * fixtures (employees + memories) are cleaned up in afterAll; deleting a memory
 * cascades its versions, relationships and per-memory events. The append-only
 * hq_events (Pulse) rows are intentionally left behind — harmless in CI.
 */

// hq_* tables + hq_memory_* RPCs are service-role-only and not in the generated
// Database types — cast to the minimal surface this suite exercises (the same
// `as unknown as` convention the write-path / ANN suites use).
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

// ---- jsonb return shapes (the subset each assertion needs) -----------------
type SweepResult = {
  skipped?: string;
  ttl_expired: number;
  decayed_archived: number;
  ran_at?: string;
  limit?: number;
};
type Pair = { keep_id: string; drop_id: string; cos_sim: number };
type SupersedeResult = { ok: boolean; reason?: string; keep_id?: string; drop_id?: string };
type Candidate = {
  id: string;
  title: string;
  body: string;
  body_chars: number;
  summary_chars: number;
};
type SetSummaryResult = { ok: boolean; reason?: string; memory_id?: string; version?: number };

const DIM = 1536;

const createdMemories: string[] = [];
const createdEmployees: string[] = [];
let originalSettings: Record<string, unknown> | null = null;

/** A coined, hyphen-free token so a theme / lexical query isolates exactly the seeded rows. */
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

/** ISO timestamp `n` days before now (clock-skew-safe decay fixtures). */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
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
  title?: string;
  summary?: string;
  body?: string;
  memoryType?: string;
  memoryClass?: string;
  visibility?: string;
  department?: string | null;
  owner?: string | null;
  salience?: number;
  confidence?: number;
  status?: string;
  expiresAt?: string | null;
  consolidatedInto?: string | null;
  lastReinforcedAt?: string | null;
  embedding?: number[];
  embeddingVersion?: string;
  embeddingDimension?: number;
};

/** Insert a memory fixture directly (ground-truth setup) and track it for teardown. */
async function seedMemory(over: SeedInput): Promise<string> {
  const row: Record<string, unknown> = {
    title: over.title ?? coin(),
    summary: over.summary ?? "",
    body: over.body ?? "",
    memory_type: over.memoryType ?? "research",
    source: "ai_employee",
    status: over.status ?? "active",
    visibility: over.visibility ?? "public_hq",
    memory_class: over.memoryClass ?? "semantic",
    owner_employee_id: over.owner ?? null,
  };
  if (over.department !== undefined) row.department = over.department;
  if (over.salience !== undefined) row.salience = over.salience;
  if (over.confidence !== undefined) row.confidence = over.confidence;
  if (over.expiresAt !== undefined) row.expires_at = over.expiresAt;
  if (over.consolidatedInto !== undefined) row.consolidated_into = over.consolidatedInto;
  if (over.lastReinforcedAt !== undefined) row.last_reinforced_at = over.lastReinforcedAt;
  if (over.embedding) {
    row.embedding = vlit(over.embedding);
    row.embedding_version = over.embeddingVersion ?? "it-lifecycle:v1";
    row.embedding_dimension = over.embeddingDimension ?? over.embedding.length;
    row.embedding_status = "embedded";
    row.embedded_at = new Date().toISOString();
  }

  const ins = await svc().from("hq_memories").insert(row).select("id");
  expect(ins.error, ins.error?.message).toBeNull();
  const id = ins.data?.[0]?.id as string | undefined;
  expect(typeof id, `seeded memory id (${row.title as string})`).toBe("string");
  createdMemories.push(id as string);
  return id as string;
}

/** Read one memory's lifecycle-relevant columns. */
async function getMemory(id: string): Promise<Record<string, unknown> | undefined> {
  const res = await svc()
    .from("hq_memories")
    .select("id, status, version, memory_class, visibility, owner_employee_id, consolidated_into, summary, source")
    .eq("id", id);
  return res.data?.[0];
}

/** The per-memory audit event_types recorded against a memory. */
async function eventTypesFor(id: string): Promise<string[]> {
  const res = await svc().from("hq_memory_events").select("event_type").eq("memory_id", id);
  return (res.data ?? []).map((r) => r.event_type as string);
}

/** The Pulse verbs emitted with object_id = `id`. */
async function pulseVerbsFor(id: string): Promise<string[]> {
  const res = await svc().from("hq_events").select("verb").eq("object_id", id);
  return (res.data ?? []).map((r) => r.verb as string);
}

/** Flip the global lifecycle kill-switch, merging into existing settings. */
async function setWorkerEnabled(on: boolean): Promise<void> {
  const cur = await svc().from("hq_settings").select("data").eq("id", "singleton");
  const data = (cur.data?.[0]?.data ?? {}) as Record<string, unknown>;
  const section = (data.memory_lifecycle ?? {}) as Record<string, unknown>;
  const next = { ...data, memory_lifecycle: { ...section, worker_enabled: on } };
  const upd = await svc().from("hq_settings").update({ data: next }).eq("id", "singleton");
  expect(upd.error, upd.error?.message).toBeNull();
}

describeIntegration("Shared Memory · lifecycle engines (hq_memory_* PR5)", () => {
  beforeAll(async () => {
    // Capture the live kill-switch so afterAll can restore it untouched.
    const cur = await svc().from("hq_settings").select("data").eq("id", "singleton");
    originalSettings = (cur.data?.[0]?.data ?? null) as Record<string, unknown> | null;

    // Default state for the suite: enabled. The fail-dark test flips it off and
    // back on itself, so the autonomous-engine tests can assume it is on.
    await setWorkerEnabled(true);
    const gate = await svc().rpc<boolean>("hq_memory_lifecycle_enabled", {});
    expect(gate.error, gate.error?.message).toBeNull();
    expect(gate.data, "the kill-switch is readable + on for the suite").toBe(true);
  });

  afterAll(async () => {
    for (const id of createdMemories) {
      await svc().from("hq_memories").delete().eq("id", id);
    }
    for (const id of createdEmployees) {
      await svc().from("ai_employees").delete().eq("id", id);
    }
    // Restore the kill-switch exactly as we found it.
    if (originalSettings !== null) {
      await svc().from("hq_settings").update({ data: originalSettings }).eq("id", "singleton");
    }
  });

  it("the kill-switch gates the autonomous engines: disabled ⇒ expire_sweep no-ops + consolidate withholds, nothing changes", async () => {
    await setWorkerEnabled(false);
    try {
      // A memory that WOULD be TTL-archived if the worker were running.
      const due = await seedMemory({
        memoryClass: "working",
        visibility: "private",
        expiresAt: daysAgo(1),
      });
      // ≥3 themed episodes that WOULD consolidate if the worker were running.
      const theme = coin();
      const emp = await makeEmployee(`it-lc-dark-${Date.now()}`, "sales");
      const sources: string[] = [];
      for (let i = 0; i < MIN_CONSOLIDATION_SOURCES; i++) {
        sources.push(
          await seedMemory({
            title: `${theme} dark ${i}`,
            memoryClass: "episodic",
            visibility: "private",
            owner: emp,
          }),
        );
      }

      const sweep = await svc().rpc<SweepResult>("hq_memory_expire_sweep", {});
      expect(sweep.error, sweep.error?.message).toBeNull();
      expect(sweep.data?.skipped, "sweep reports the disabled gate").toBe("worker_disabled");
      expect(sweep.data?.ttl_expired).toBe(0);
      expect((await getMemory(due))?.status, "a disabled sweep archives nothing").toBe("active");

      const cons = await svc().rpc<string | null>("hq_memory_consolidate", {
        p_employee_id: emp,
        p_theme: theme,
      });
      expect(cons.error, cons.error?.message).toBeNull();
      expect(cons.data, "a disabled consolidate withholds (null sentinel)").toBeNull();
      for (const s of sources) {
        expect((await getMemory(s))?.consolidated_into, "no source was consolidated").toBeNull();
      }
    } finally {
      // Re-arm for the remaining tests, whatever happened above.
      await setWorkerEnabled(true);
    }
  });

  it("expire_sweep: TTL + decay archival in one bounded idempotent pass; unconsolidated + durable are spared", async () => {
    const lesson = await seedMemory({ memoryClass: "long_term", visibility: "private" });

    // (a) TTL-due ephemeral → archived/'expired'.
    const ttlWorking = await seedMemory({
      memoryClass: "working",
      visibility: "private",
      expiresAt: daysAgo(2),
    });
    const ttlEpisodic = await seedMemory({
      memoryClass: "episodic",
      visibility: "private",
      expiresAt: daysAgo(2),
    });
    // (b) Consolidated + decayed-below-floor episode → archived/'archived'.
    const decayed = await seedMemory({
      memoryClass: "episodic",
      visibility: "private",
      salience: 1,
      lastReinforcedAt: daysAgo(365),
      consolidatedInto: lesson,
    });
    // (c) UNCONSOLIDATED, equally old + faint → must survive (its lesson is not saved).
    const unconsolidated = await seedMemory({
      memoryClass: "episodic",
      visibility: "private",
      salience: 1,
      lastReinforcedAt: daysAgo(365),
    });
    // (d) Consolidated but reinforced now + salient → above floor, must survive.
    const fresh = await seedMemory({
      memoryClass: "episodic",
      visibility: "private",
      salience: 100,
      lastReinforcedAt: new Date().toISOString(),
      consolidatedInto: lesson,
    });
    // (e) Durable class with a (bogus) past TTL → the class guard spares it.
    const durable = await seedMemory({
      memoryClass: "semantic",
      visibility: "private",
      expiresAt: daysAgo(2),
    });

    const sweep = await svc().rpc<SweepResult>("hq_memory_expire_sweep", { p_limit: 500 });
    expect(sweep.error, sweep.error?.message).toBeNull();
    expect(sweep.data?.skipped, "an enabled sweep does not short-circuit").toBeUndefined();
    expect(sweep.data?.ttl_expired ?? 0, "≥ my 2 TTL rows were expired").toBeGreaterThanOrEqual(2);
    expect(sweep.data?.decayed_archived ?? 0, "≥ my 1 decayed row was archived").toBeGreaterThanOrEqual(1);

    expect((await getMemory(ttlWorking))?.status).toBe("archived");
    expect((await getMemory(ttlEpisodic))?.status).toBe("archived");
    expect(await eventTypesFor(ttlWorking), "TTL archival is audited 'expired'").toContain("expired");
    expect((await getMemory(decayed))?.status).toBe("archived");
    expect(await eventTypesFor(decayed), "decay archival is audited 'archived'").toContain("archived");

    expect(
      (await getMemory(unconsolidated))?.status,
      "an unconsolidated episode is NEVER decay-archived",
    ).toBe("active");
    expect((await getMemory(fresh))?.status, "an above-floor episode survives").toBe("active");
    expect((await getMemory(durable))?.status, "a durable class is spared the clock").toBe("active");

    // Mechanical maintenance emits NOTHING on The Pulse.
    expect(await pulseVerbsFor(ttlWorking), "TTL expiry emits no Pulse verb").toHaveLength(0);
    expect(await pulseVerbsFor(decayed), "decay archival emits no Pulse verb").toHaveLength(0);

    // Idempotent: a second sweep leaves my already-archived rows untouched.
    const before = await eventTypesFor(ttlWorking);
    await svc().rpc<SweepResult>("hq_memory_expire_sweep", { p_limit: 500 });
    expect(await eventTypesFor(ttlWorking), "re-running the sweep never re-archives").toEqual(before);
  });

  it("consolidate: ≥3 themed episodes roll into ONE private long_term lesson, sources linked (not archived), memory.asserted emitted, idempotent", async () => {
    const emp = await makeEmployee(`it-lc-cons-${Date.now()}`, "engineering");
    const theme = coin();
    const sources: string[] = [];
    for (let i = 0; i < MIN_CONSOLIDATION_SOURCES; i++) {
      sources.push(
        await seedMemory({
          title: `${theme} lesson ${i}`,
          body: `episode ${i} about ${theme}`,
          memoryClass: "episodic",
          visibility: "private",
          owner: emp,
          salience: 60 + i,
        }),
      );
    }

    const cons = await svc().rpc<string | null>("hq_memory_consolidate", {
      p_employee_id: emp,
      p_theme: theme,
    });
    expect(cons.error, cons.error?.message).toBeNull();
    expect(typeof cons.data, "consolidation returns the new lesson's id").toBe("string");
    const lessonId = cons.data as string;
    createdMemories.push(lessonId);

    const lesson = await getMemory(lessonId);
    expect(lesson?.memory_class, "the lesson is long_term").toBe("long_term");
    expect(lesson?.visibility, "the lesson is private (autonomous, not shared)").toBe("private");
    expect(lesson?.owner_employee_id, "the lesson is owner-scoped").toBe(emp);
    expect(lesson?.source).toBe("ai_employee");

    for (const s of sources) {
      expect((await getMemory(s))?.consolidated_into, "each source points at the lesson").toBe(lessonId);
      expect((await getMemory(s))?.status, "sources are linked, NOT archived").toBe("active");
      expect(await eventTypesFor(s), "each source is audited 'consolidated'").toContain("consolidated");
    }
    expect(await eventTypesFor(lessonId), "the lesson records its authorship").toContain("created");

    // The canonical write verb is on The Pulse (a future embed-consumer vectors it).
    expect(await pulseVerbsFor(lessonId), "consolidation asserts knowledge").toContain("memory.asserted");

    // Idempotent: the sources now carry consolidated_into, so a re-run no-ops.
    const again = await svc().rpc<string | null>("hq_memory_consolidate", {
      p_employee_id: emp,
      p_theme: theme,
    });
    expect(again.error, again.error?.message).toBeNull();
    expect(again.data, "re-consolidating the same theme is a no-op").toBeNull();

    // Below the floor: only 2 fresh sources on a new theme → no pattern → null.
    const sparseTheme = coin();
    await seedMemory({ title: `${sparseTheme} one`, memoryClass: "episodic", visibility: "private", owner: emp });
    await seedMemory({ title: `${sparseTheme} two`, memoryClass: "episodic", visibility: "private", owner: emp });
    const sparse = await svc().rpc<string | null>("hq_memory_consolidate", {
      p_employee_id: emp,
      p_theme: sparseTheme,
    });
    expect(sparse.error, sparse.error?.message).toBeNull();
    expect(sparse.data, "fewer than 3 sources is noise, not a pattern").toBeNull();
  });

  it("dedupe_pairs + supersede: near-duplicate found by vector, keeper rule applied, merge is atomic/audited/idempotent; no-embedding row never paired", async () => {
    const owner = await makeEmployee(`it-lc-dedupe-${Date.now()}`, "sales");
    const version = `it-dedupe-${Date.now()}`; // isolates the vector space to this pair
    // Two co-scoped memories with an IDENTICAL vector (cosine = 1) and different
    // confidence → keeper rule keeps the higher-confidence one.
    const high = await seedMemory({
      memoryType: "research",
      visibility: "private",
      owner,
      confidence: 90,
      embedding: basis(7),
      embeddingVersion: version,
    });
    const low = await seedMemory({
      memoryType: "research",
      visibility: "private",
      owner,
      confidence: 70,
      embedding: basis(7),
      embeddingVersion: version,
    });
    // A co-scoped TWIN with NO embedding → must never be paired (plug-in, not dependency).
    const noVec = await seedMemory({
      memoryType: "research",
      visibility: "private",
      owner,
      confidence: 95,
    });

    const pairsRes = await svc().rpc<Pair[]>("hq_memory_dedupe_pairs", {
      p_limit: 1000,
      p_threshold: DEDUPE_COSINE_THRESHOLD,
    });
    expect(pairsRes.error, pairsRes.error?.message).toBeNull();
    const pairs = pairsRes.data ?? [];
    const mine = pairs.find(
      (p) => [p.keep_id, p.drop_id].includes(high) && [p.keep_id, p.drop_id].includes(low),
    );
    expect(mine, "the identical-vector pair is detected").toBeTruthy();
    expect(mine?.keep_id, "keeper rule keeps the higher-confidence memory").toBe(high);
    expect(mine?.drop_id).toBe(low);
    expect(mine?.cos_sim ?? 0, "identical vectors score ~1").toBeGreaterThan(DEDUPE_COSINE_THRESHOLD);
    expect(
      pairs.some((p) => p.keep_id === noVec || p.drop_id === noVec),
      "a memory with no embedding is never a dedupe candidate",
    ).toBe(false);

    // Apply the merge.
    const sup = await svc().rpc<SupersedeResult>("hq_memory_supersede", {
      p_keep_id: high,
      p_drop_id: low,
      p_reason: "dedupe",
    });
    expect(sup.error, sup.error?.message).toBeNull();
    expect(sup.data?.ok, "the merge succeeds").toBe(true);

    const dropped = await getMemory(low);
    expect(dropped?.status, "the loser is superseded").toBe("superseded");
    expect(dropped?.version, "the loser's version is bumped").toBe(2);
    expect((await getMemory(high))?.status, "the keeper stays active").toBe("active");
    expect(await eventTypesFor(low), "the merge is audited 'superseded'").toContain("superseded");

    // The reversibility breadcrumb: a 'superseded_by' lineage edge → the keeper.
    const rel = await svc()
      .from("hq_memory_relationships")
      .select("relation, entity_id, entity_type")
      .eq("memory_id", low);
    const lineage = (rel.data ?? []).find((r) => r.relation === "superseded_by");
    expect(lineage, "a superseded_by lineage edge is recorded").toBeTruthy();
    expect(lineage?.entity_id, "the lineage edge points at the keeper").toBe(high);

    // The business fact is on The Pulse.
    expect(await pulseVerbsFor(low), "supersession emits memory.superseded").toContain("memory.superseded");

    // Idempotent: a second merge of the now-inactive loser is refused.
    const again = await svc().rpc<SupersedeResult>("hq_memory_supersede", {
      p_keep_id: high,
      p_drop_id: low,
      p_reason: "dedupe",
    });
    expect(again.error, again.error?.message).toBeNull();
    expect(again.data?.ok, "re-superseding an inactive drop is refused").toBe(false);
    expect(again.data?.reason).toBe("drop_not_active");
  });

  it("summary_candidates + set_summary: a long under-summarised body is detected with its text, then summarised, audited, and drops out", async () => {
    const title = coin();
    const body = "detail ".repeat(280); // ~1960 chars, comfortably ≥ the min, < 24000
    expect(body.length).toBeGreaterThanOrEqual(SUMMARY_MIN_BODY_CHARS);
    const id = await seedMemory({ title, body, summary: "", visibility: "private" });

    const before = await svc().rpc<Candidate[]>("hq_memory_summary_candidates", { p_limit: 1000 });
    expect(before.error, before.error?.message).toBeNull();
    const cand = (before.data ?? []).find((c) => c.id === id);
    expect(cand, "a long empty-summary body is a candidate").toBeTruthy();
    expect(cand?.body_chars ?? 0, "body_chars reports the true length").toBeGreaterThanOrEqual(
      SUMMARY_MIN_BODY_CHARS,
    );
    expect(cand?.summary_chars, "the empty summary is reported as 0").toBe(0);
    expect(cand?.body, "the worker gets the body to summarise in one read").toBe(body);

    // Empty summary is refused.
    const blank = await svc().rpc<SetSummaryResult>("hq_memory_set_summary", {
      p_memory_id: id,
      p_summary: "   ",
    });
    expect(blank.data?.ok).toBe(false);
    expect(blank.data?.reason).toBe("empty_summary");

    // Persist a concise summary.
    const set = await svc().rpc<SetSummaryResult>("hq_memory_set_summary", {
      p_memory_id: id,
      p_summary: "A concise lesson distilled from the long body.",
    });
    expect(set.error, set.error?.message).toBeNull();
    expect(set.data?.ok, "the summary is persisted").toBe(true);
    expect(set.data?.version, "the version is bumped").toBe(2);

    const after = await getMemory(id);
    expect(after?.summary).toBe("A concise lesson distilled from the long body.");
    expect(await eventTypesFor(id), "summarisation is audited 'summarised'").toContain("summarised");
    expect(await pulseVerbsFor(id), "summarisation emits no Pulse verb").toHaveLength(0);

    // It now has a short, non-empty summary → it leaves the candidate set.
    const recheck = await svc().rpc<Candidate[]>("hq_memory_summary_candidates", { p_limit: 1000 });
    expect(
      (recheck.data ?? []).some((c) => c.id === id),
      "a freshly-summarised memory is no longer a candidate",
    ).toBe(false);

    // set_summary on a non-active id is refused.
    const missing = await svc().rpc<SetSummaryResult>("hq_memory_set_summary", {
      p_memory_id: crypto.randomUUID(),
      p_summary: "nope",
    });
    expect(missing.data?.ok).toBe(false);
    expect(missing.data?.reason).toBe("not_active");
  });

  it("golden_signals: one operational read reports the gate, the class distribution, the backlog and 24h transitions", async () => {
    const res = await svc().rpc<Record<string, unknown>>("hq_memory_golden_signals", {});
    expect(res.error, res.error?.message).toBeNull();
    const gs = res.data ?? {};
    expect(gs.worker_enabled, "the signals report the live gate").toBe(true);

    const memories = (gs.memories ?? {}) as Record<string, number>;
    expect(typeof memories.total, "a total memory count is reported").toBe("number");
    expect(memories.total, "the suite has seeded memories").toBeGreaterThan(0);

    expect(typeof gs.by_class, "the class distribution is reported").toBe("object");
    expect(typeof gs.lifecycle_backlog, "the engine backlog is reported").toBe("object");

    // We superseded + summarised at least one memory this run; the append-only
    // event log only grows, so these counts can only be ≥ our activity.
    const tr = (gs.transitions_24h ?? {}) as Record<string, number>;
    expect(tr.superseded ?? 0, "a supersession in the last 24h is counted").toBeGreaterThanOrEqual(1);
    expect(tr.summarised ?? 0, "a summarisation in the last 24h is counted").toBeGreaterThanOrEqual(1);
  });

  it("every lifecycle primitive is service_role-only — anon is refused", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["hq_memory_lifecycle_enabled", {}],
      ["hq_memory_expire_sweep", {}],
      ["hq_memory_consolidate", { p_employee_id: crypto.randomUUID(), p_theme: "x" }],
      ["hq_memory_dedupe_pairs", {}],
      ["hq_memory_supersede", { p_keep_id: crypto.randomUUID(), p_drop_id: crypto.randomUUID() }],
      ["hq_memory_summary_candidates", {}],
      ["hq_memory_set_summary", { p_memory_id: crypto.randomUUID(), p_summary: "x" }],
      ["hq_memory_archive", { p_memory_id: crypto.randomUUID() }],
      ["hq_memory_golden_signals", {}],
    ];
    for (const [fn, args] of calls) {
      const res = await anon().rpc(fn, args);
      expect(res.error, `anon must not execute ${fn}`).not.toBeNull();
    }
  });
});

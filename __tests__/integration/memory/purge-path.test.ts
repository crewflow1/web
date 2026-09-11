import { beforeAll, afterAll, it, expect } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * Shared Memory — REAL PURGE semantics, real-Postgres proof (E2).
 *
 * The security tier pins `20261228000000_hq_memory_purge.sql`'s source text;
 * the unit tier proves the action gating. This tier proves the BEHAVIOUR the
 * CEO named, end to end on live Postgres:
 *
 *   (a) purge scrubs body + title + summary + tags/keywords + the embedding
 *       (vector AND all metadata) + EVERY hq_memory_versions snapshot + the
 *       inbound relationship labels — after a purge, the distinctive content
 *       token exists NOWHERE in the memory's row, versions, events or edges;
 *   (b) recall no longer returns the row — lexically (the GENERATED
 *       search_tsv empties) AND with a live vector present pre-purge (the
 *       semantic ANN channel), and the admin lexical listing (textSearch over
 *       search_tsv, the searchMemories shape) stops matching;
 *   (c) hq_embedding_claim_batch claims NOTHING for the tombstone — even
 *       though embedded_at is null — and a content-UPDATE resurrection
 *       attempt RAISES at the SQL layer (the drift trigger can never re-queue
 *       a purged row);
 *   (d) hq_embedding_enqueue_stale and hq_embedding_reset_failed both skip
 *       the tombstone (retries/backfills cannot resurrect it);
 *   (e) the audit evidence survives WITHOUT the content: the 'purged' event
 *       carries {reason, had_embedding, versions_scrubbed} and no content,
 *       and the tombstone keeps purged_at/purged_by/purge_reason;
 *   (f) the forget/archive path is UNCHANGED: forget still archives with the
 *       content fully intact (reversible), purge is the only eraser;
 *   plus: idempotency (a re-purge is a refused no-op, one event only),
 *   one-way-ness (the tombstone cannot leave 'purged' or regain a vector,
 *   while benign bookkeeping updates still pass), and service_role-only
 *   EXECUTE (anon refused).
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no
 * database, FAILED loudly in CI if the database is missing. Fixtures cleaned
 * in afterAll; the embed-worker gate is always left DARK.
 */

type Row = Record<string, unknown>;
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type PurgeResult = {
  ok: boolean;
  reason?: string;
  memory_id?: string;
  had_embedding?: boolean;
  versions_scrubbed?: number;
};

const DIM = 1536;
const EMB_VERSION = "itest:purge-probe:d1536:v1";

/** A vector literal pgvector accepts over PostgREST: [1,0,0,...]. */
const VEC_LITERAL = `[1${",0".repeat(DIM - 1)}]`;
/** The same vector as the float8[] recall parameter. */
const QUERY_VEC: number[] = [1, ...Array.from({ length: DIM - 1 }, () => 0)];

const createdMemories: string[] = [];
const createdEmployees: string[] = [];

function token(): string {
  return "quokkapurge" + Math.random().toString(36).slice(2, 9);
}

const svc = () => serviceClient();

async function makeEmployee(): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ins = await svc()
    .from("ai_employees" as never)
    .insert({
      name: `it-purge-${stamp}`,
      slug: `it-purge-${stamp}`,
      role: "Purge fixture",
      department: "engineering",
    } as never)
    .select("id");
  const id = (ins.data as Row[] | null)?.[0]?.id as string | undefined;
  expect(typeof id, "fixture employee id").toBe("string");
  createdEmployees.push(id as string);
  return id as string;
}

async function seedMemory(fields: Row = {}): Promise<string> {
  const ins = await svc()
    .from("hq_memories" as never)
    .insert({
      title: `probe ${crypto.randomUUID()}`,
      summary: "probe summary",
      body: "probe body",
      memory_type: "research",
      source: "ai_employee",
      status: "active",
      visibility: "public_hq",
      memory_class: "semantic",
      ...fields,
    } as never)
    .select("id");
  expect(ins.error, ins.error?.message ?? "").toBeNull();
  const id = (ins.data as Row[] | null)?.[0]?.id as string | undefined;
  expect(typeof id, "seeded memory id").toBe("string");
  createdMemories.push(id as string);
  return id as string;
}

async function forgeEmbedding(id: string): Promise<void> {
  const res = await svc()
    .from("hq_memories" as never)
    .update({
      embedding: VEC_LITERAL,
      embedding_provider: "itest",
      embedding_model: "purge-probe",
      embedding_dimension: DIM,
      embedding_version: EMB_VERSION,
      embedding_checksum: "probe",
      embedded_at: new Date().toISOString(),
      embedding_status: "embedded",
    } as never)
    .eq("id", id);
  expect(res.error, res.error?.message ?? "").toBeNull();
}

async function getMemory(id: string): Promise<Row> {
  const { data, error } = await svc()
    .from("hq_memories" as never)
    .select(
      "id, title, summary, body, tags, keywords, organisation_name, status, pinned, " +
        "embedding, embedding_provider, embedding_model, embedding_dimension, " +
        "embedding_version, embedding_checksum, embedded_at, embedding_status, " +
        "embedding_claimed_at, embedding_claimed_by, embedding_next_attempt_at, embedding_last_error, " +
        "purged_at, purged_by, purge_reason, version",
    )
    .eq("id", id)
    .single();
  expect(error, error?.message ?? "").toBeNull();
  return data as unknown as Row;
}

function purge(id: string, actor: string, reason: string) {
  return svc().rpc("hq_memory_purge" as never, {
    p_memory_id: id,
    p_actor: actor,
    p_reason: reason,
  } as never) as unknown as PromiseLike<RpcResult<PurgeResult>>;
}

async function recallIds(
  employeeId: string,
  query: string | null,
  withVector: boolean,
): Promise<string[]> {
  const { data, error } = (await svc().rpc("hq_memory_recall" as never, {
    p_employee_id: employeeId,
    p_query: query,
    p_query_embedding: withVector ? QUERY_VEC : null,
    p_subject_kind: null,
    p_subject_id: null,
    p_class_filter: null,
    p_limit: 200,
    p_query_version: withVector ? EMB_VERSION : null,
  } as never)) as unknown as RpcResult<Array<{ id: string; cos_sim: number | null }>>;
  expect(error, error?.message ?? "").toBeNull();
  return (data ?? []).map((r) => r.id);
}

/** The /admin lexical listing shape: textSearch over the generated tsvector. */
async function lexicalListingIds(term: string): Promise<string[]> {
  const { data, error } = await svc()
    .from("hq_memories" as never)
    .select("id")
    .textSearch("search_tsv", term, { type: "websearch", config: "english" })
    .limit(50);
  expect(error, error?.message ?? "").toBeNull();
  return ((data as Row[] | null) ?? []).map((r) => r.id as string);
}

/** Read-modify-write the embed worker kill-switch (left dark afterwards). */
async function setEmbedGate(on: boolean): Promise<void> {
  const cur = await svc()
    .from("hq_settings" as never)
    .select("data")
    .eq("id", "singleton")
    .single();
  const data =
    ((cur.data as { data?: Record<string, Record<string, unknown>> } | null)?.data) ?? {};
  data.memory_embedding = { ...(data.memory_embedding ?? {}), worker_enabled: on };
  await svc().from("hq_settings" as never).update({ data } as never).eq("id", "singleton");
}

describeIntegration("Shared Memory · REAL PURGE semantics (hq_memory_purge, E2)", () => {
  let empId = "";

  beforeAll(async () => {
    empId = await makeEmployee();
  });

  afterAll(async () => {
    for (const id of createdMemories) {
      await svc().from("hq_memories" as never).delete().eq("id", id);
    }
    for (const id of createdEmployees) {
      await svc().from("ai_employees" as never).delete().eq("id", id);
    }
    await setEmbedGate(false); // always leave the worker dark
  });

  // ===================================================================
  // (a) + (e) The scrub: content + vector + versions gone, evidence kept
  // ===================================================================
  it("scrubs title/summary/body/tags/keywords, the vector + metadata, EVERY version snapshot and inbound edge labels — keeping content-free evidence", async () => {
    const t = token();
    const id = await seedMemory({
      title: `${t} secret plan`,
      summary: `${t} secret summary`,
      body: `${t} the full secret body`,
      tags: [t, "sensitive"],
      keywords: [t],
      organisation_name: `${t} Ltd`,
      pinned: true,
    });
    await forgeEmbedding(id);

    // Two content-bearing version snapshots (where the body would survive).
    for (const v of [1, 2]) {
      const ins = await svc()
        .from("hq_memory_versions" as never)
        .insert({
          memory_id: id,
          version: v,
          title: `${t} secret plan v${v}`,
          summary: `${t} old summary`,
          body: `${t} old body`,
          tags: [t],
          status: "active",
        } as never);
      expect(ins.error, ins.error?.message ?? "").toBeNull();
    }

    // An inbound relationship whose label quotes the title (the supersede
    // lineage pattern) — hosted on a second memory.
    const otherId = await seedMemory({});
    const relIns = await svc()
      .from("hq_memory_relationships" as never)
      .insert({
        memory_id: otherId,
        entity_type: "memory",
        entity_id: id,
        entity_label: `Superseded by ${t} secret plan`,
        relation: "superseded_by",
      } as never);
    expect(relIns.error, relIns.error?.message ?? "").toBeNull();

    const res = await purge(id, "ops@crewflow.uk", "dsar erasure probe");
    expect(res.error, res.error?.message ?? "").toBeNull();
    expect(res.data?.ok).toBe(true);
    expect(res.data?.had_embedding).toBe(true);
    expect(res.data?.versions_scrubbed).toBe(2);

    // The tombstone: content gone, vector gone, evidence kept.
    const after = await getMemory(id);
    expect(after.title).toBe("[purged]");
    expect(after.summary).toBe("");
    expect(after.body).toBe("");
    expect(after.tags).toEqual([]);
    expect(after.keywords).toEqual([]);
    expect(after.organisation_name).toBeNull();
    expect(after.pinned).toBe(false);
    expect(after.status).toBe("purged");
    expect(after.embedding).toBeNull();
    for (const col of [
      "embedding_provider",
      "embedding_model",
      "embedding_dimension",
      "embedding_version",
      "embedding_checksum",
      "embedded_at",
      "embedding_claimed_at",
      "embedding_claimed_by",
      "embedding_next_attempt_at",
    ]) {
      expect(after[col], `${col} must be null`).toBeNull();
    }
    expect(after.embedding_status).toBe("purged");
    expect(after.purged_at).not.toBeNull();
    expect(after.purged_by).toBe("ops@crewflow.uk");
    expect(after.purge_reason).toBe("dsar erasure probe");

    // Version snapshots scrubbed (skeletons remain).
    const vers = await svc()
      .from("hq_memory_versions" as never)
      .select("version, title, summary, body, tags")
      .eq("memory_id", id);
    expect((vers.data as Row[] | null)?.length).toBe(2);
    for (const v of (vers.data as Row[]) ?? []) {
      expect(v.title).toBe("[purged]");
      expect(v.summary).toBe("");
      expect(v.body).toBe("");
      expect(v.tags).toEqual([]);
    }

    // Inbound edge label scrubbed.
    const rels = await svc()
      .from("hq_memory_relationships" as never)
      .select("entity_label")
      .eq("entity_id", id);
    for (const r of (rels.data as Row[]) ?? []) {
      expect(r.entity_label).toBe("[purged]");
    }

    // (e) The audit event: content-free, with the CEO-named metadata.
    const events = await svc()
      .from("hq_memory_events" as never)
      .select("event_type, actor_email, detail")
      .eq("memory_id", id);
    const purged = ((events.data as Row[]) ?? []).find(
      (e) => e.event_type === "purged",
    );
    expect(purged, "a 'purged' timeline event").toBeDefined();
    expect(purged?.actor_email).toBe("ops@crewflow.uk");
    const detail = purged?.detail as Row;
    expect(detail.reason).toBe("dsar erasure probe");
    expect(detail.had_embedding).toBe(true);
    expect(detail.versions_scrubbed).toBe(2);
    expect(detail.from_status).toBe("active");

    // THE erasure assertion: the distinctive token survives NOWHERE in the
    // memory's row, versions, events, or inbound edges.
    const everything = JSON.stringify({
      row: after,
      versions: vers.data,
      events: events.data,
      rels: rels.data,
    });
    expect(everything.includes(t), "content token must be gone everywhere").toBe(false);
  });

  // ===================================================================
  // (b) Recall + lexical-listing disappearance (lexical AND semantic)
  // ===================================================================
  it("recall (lexical AND semantic-with-vector) and the admin lexical listing stop returning the row after purge", async () => {
    const t = token();
    const id = await seedMemory({
      title: `${t} recall probe`,
      summary: `${t} summary`,
      body: `${t} body text`,
    });
    await forgeEmbedding(id);

    // Pre-purge: BOTH channels surface it.
    expect(await recallIds(empId, t, false), "lexical recall pre-purge").toContain(id);
    expect(await recallIds(empId, t, true), "semantic recall pre-purge").toContain(id);
    expect(await lexicalListingIds(t), "admin listing pre-purge").toContain(id);

    const res = await purge(id, "ops@crewflow.uk", "recall probe");
    expect(res.data?.ok).toBe(true);

    // Post-purge: no channel can surface it — status filter, empty tsv, null
    // vector are three independent locks.
    expect(await recallIds(empId, t, false), "lexical recall post-purge").not.toContain(id);
    expect(await recallIds(empId, t, true), "semantic recall post-purge").not.toContain(id);
    expect(await recallIds(empId, null, true), "query-less recall post-purge").not.toContain(id);
    expect(await lexicalListingIds(t), "admin listing post-purge").toEqual([]);
  });

  // ===================================================================
  // (c) claim_batch resurrection-proofing + the one-way tombstone guard
  // ===================================================================
  it("claim_batch never claims the tombstone, and a content-UPDATE resurrection attempt raises", async () => {
    const t = token();
    const id = await seedMemory({ title: `${t} claim probe`, body: `${t} body` });
    await forgeEmbedding(id);

    const res = await purge(id, "ops@crewflow.uk", "claim probe");
    expect(res.data?.ok).toBe(true);

    // The tombstone LOOKS like queue bait (embedded_at null) — prove it is not.
    const after = await getMemory(id);
    expect(after.embedded_at).toBeNull();
    expect(after.embedding_status).toBe("purged");

    await setEmbedGate(true);
    try {
      const claim1 = (await svc().rpc("hq_embedding_claim_batch" as never, {
        p_worker_id: "purge-probe-worker",
        p_limit: 500,
        p_lease_seconds: 1,
      } as never)) as unknown as RpcResult<{ claimed: Array<{ id: string }> }>;
      expect(claim1.error, claim1.error?.message ?? "").toBeNull();
      const claimedIds1 = (claim1.data?.claimed ?? []).map((r) => r.id);
      expect(claimedIds1, "tombstone must never be claimable").not.toContain(id);

      // Resurrection attempt: a content UPDATE on the tombstone RAISES (so
      // the drift-requeue trigger can never run for it).
      const upd = await svc()
        .from("hq_memories" as never)
        .update({ body: "resurrected content" } as never)
        .eq("id", id);
      expect(upd.error, "content update on a tombstone must raise").not.toBeNull();
      expect(upd.error?.message ?? "").toMatch(/immutable|purged/i);

      // And leaving the purged status is equally impossible.
      const flip = await svc()
        .from("hq_memories" as never)
        .update({ status: "active" } as never)
        .eq("id", id);
      expect(flip.error, "un-purging must raise").not.toBeNull();

      // Re-arming the vector is impossible too.
      const rearm = await svc()
        .from("hq_memories" as never)
        .update({ embedding_status: "pending", embedded_at: new Date().toISOString() } as never)
        .eq("id", id);
      expect(rearm.error, "re-arming the embed state must raise").not.toBeNull();

      // After every attempt, the queue still cannot see it.
      const claim2 = (await svc().rpc("hq_embedding_claim_batch" as never, {
        p_worker_id: "purge-probe-worker-2",
        p_limit: 500,
        p_lease_seconds: 1,
      } as never)) as unknown as RpcResult<{ claimed: Array<{ id: string }> }>;
      const claimedIds2 = (claim2.data?.claimed ?? []).map((r) => r.id);
      expect(claimedIds2).not.toContain(id);
    } finally {
      await setEmbedGate(false);
    }

    // Benign bookkeeping still passes (a reinforce sweep can't explode).
    const bump = await svc()
      .from("hq_memories" as never)
      .update({ access_count: 7 } as never)
      .eq("id", id);
    expect(bump.error, bump.error?.message ?? "").toBeNull();
  });

  // ===================================================================
  // (d) enqueue_stale + reset_failed skip the tombstone
  // ===================================================================
  it("hq_embedding_enqueue_stale cannot re-queue a tombstone (backfills don't resurrect)", async () => {
    const t = token();
    const id = await seedMemory({ title: `${t} stale probe`, body: `${t} body` });
    await forgeEmbedding(id);
    const res = await purge(id, "ops@crewflow.uk", "stale probe");
    expect(res.data?.ok).toBe(true);

    const n = (await svc().rpc("hq_embedding_enqueue_stale" as never, {
      p_target_version: "itest:new-model:d1536:v2",
      p_limit: 500,
    } as never)) as unknown as RpcResult<number>;
    expect(n.error, n.error?.message ?? "").toBeNull();

    const after = await getMemory(id);
    expect(after.embedding_status, "must remain terminal").toBe("purged");
    expect(after.embedded_at).toBeNull();
    expect(after.embedding).toBeNull();
  });

  it("hq_embedding_reset_failed cannot drain a tombstone back into the queue", async () => {
    const t = token();
    // A dead-lettered row that then gets purged: the purge rewrites the
    // embedding state to 'purged', and the DLQ drain must leave it there.
    const id = await seedMemory({
      title: `${t} dlq probe`,
      body: `${t} body`,
      embedding_status: "failed",
      embedding_attempts: 5,
      embedding_last_error: "provider down",
    });
    const res = await purge(id, "ops@crewflow.uk", "dlq probe");
    expect(res.data?.ok).toBe(true);

    const n = (await svc().rpc("hq_embedding_reset_failed" as never, {
      p_limit: 500,
    } as never)) as unknown as RpcResult<number>;
    expect(n.error, n.error?.message ?? "").toBeNull();

    const after = await getMemory(id);
    expect(after.embedding_status, "must remain terminal, never 'pending'").toBe("purged");
    expect(after.embedding_last_error, "failure bookkeeping was scrubbed").toBeNull();
  });

  // ===================================================================
  // (f) forget/archive is UNCHANGED — reversible, content intact
  // ===================================================================
  it("the forget path still archives with content fully intact (purge is the only eraser)", async () => {
    const t = token();
    const id = await seedMemory({
      title: `${t} forget probe`,
      summary: `${t} summary`,
      body: `${t} body stays`,
      visibility: "private",
      memory_class: "episodic",
      owner_employee_id: empId,
    });

    const res = (await svc().rpc("hq_memory_forget" as never, {
      p_employee_id: empId,
      p_memory_id: id,
      p_reason: "no longer relevant",
    } as never)) as unknown as RpcResult<{ ok: boolean }>;
    expect(res.error, res.error?.message ?? "").toBeNull();
    expect(res.data?.ok).toBe(true);

    const after = await getMemory(id);
    expect(after.status).toBe("archived");
    expect(after.title).toBe(`${t} forget probe`);
    expect(after.body).toBe(`${t} body stays`);
    expect(after.purged_at).toBeNull();
  });

  // ===================================================================
  // Idempotency + not_found + privilege model
  // ===================================================================
  it("is idempotent: a re-purge is refused (already_purged) with exactly one event", async () => {
    const id = await seedMemory({});
    const first = await purge(id, "ops@crewflow.uk", "first");
    expect(first.data?.ok).toBe(true);

    const second = await purge(id, "ops@crewflow.uk", "second");
    expect(second.error, second.error?.message ?? "").toBeNull();
    expect(second.data?.ok).toBe(false);
    expect(second.data?.reason).toBe("already_purged");

    const events = await svc()
      .from("hq_memory_events" as never)
      .select("event_type")
      .eq("memory_id", id);
    const purgedEvents = ((events.data as Row[]) ?? []).filter(
      (e) => e.event_type === "purged",
    );
    expect(purgedEvents.length).toBe(1);

    const after = await getMemory(id);
    expect(after.purge_reason, "the first purge's attribution wins").toBe("first");
  });

  it("reports not_found for an unknown memory id", async () => {
    const res = await purge(
      "00000000-0000-0000-0000-000000000000",
      "ops@crewflow.uk",
      "ghost",
    );
    expect(res.error, res.error?.message ?? "").toBeNull();
    expect(res.data?.ok).toBe(false);
    expect(res.data?.reason).toBe("not_found");
  });

  it("refuses the anon (JWT) role outright — service_role only", async () => {
    const id = await seedMemory({});
    const res = (await anonClient().rpc("hq_memory_purge" as never, {
      p_memory_id: id,
      p_actor: "anon@evil.test",
      p_reason: "anon",
    } as never)) as unknown as RpcResult<PurgeResult>;
    expect(res.error, "anon must be refused execute").not.toBeNull();

    const after = await getMemory(id);
    expect(after.status).toBe("active");
  });
});

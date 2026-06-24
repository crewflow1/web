import { beforeAll, afterAll, it, expect } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { runEmbeddingWorker } from "@/server/services/memory-embedder";
import { isEmbeddingConfigured } from "@/lib/ai/embeddings";

/**
 * Shared Memory — embedding-worker CRASH RECOVERY, real-Postgres
 * (Directive 009 Module 1 Final Validation, "system must recover automatically").
 *
 * The unit tier (`__tests__/memory/memory-embedder.test.ts`) already proves the
 * worker ORCHESTRATES recovery correctly — reclaiming crashed leases, failing a
 * batch into retry/backoff, dead-lettering a corrupt vector, treating a lost
 * lease as a no-op — but it does so against a MOCKED claim RPC. The callRpc
 * this-binding bug taught the lesson the hard way: a mock can hide whether the
 * REAL SQL works. This suite drives the actual lease/reclaim/backoff functions
 * (`hq_embedding_reclaim_stale`, `hq_embedding_claim_batch`) — and the real
 * `runEmbeddingWorker` — against live Postgres, one deterministic probe per
 * recovery guarantee:
 *
 *   1. A crashed worker's EXPIRED lease is reclaimed → the row is claimable
 *      again (resume-after-restart; no work is lost).
 *   2. A FRESH, still-valid lease is NOT reclaimed → an in-flight worker is
 *      never yanked out from under itself (no double-embedding).
 *   3. A backed-off row (future `next_attempt_at`) is NOT claimed → a failing
 *      provider produces retry pacing, never a retry storm.
 *   4. End-to-end: `runEmbeddingWorker` reclaims a crashed lease AND completes
 *      it in the same run (provider-gated — a no-op when no provider is
 *      configured, by graceful-degradation design).
 *
 * To forge a crashed lease we write the queue columns directly (the service
 * write path deliberately won't let a caller set a lease) — same table-level
 * seed the bench harness uses. Skipped locally with no database; FAILS loudly
 * in CI without one. Must run when no other embed worker is draining the global
 * queue (the finalize gate runs it on an idle corpus).
 */

type IdRow = { id: string };
type QueueRow = {
  embedding_claimed_at: string | null;
  embedding_claimed_by: string | null;
  embedded_at: string | null;
  embedding_status: string;
};

const created: string[] = [];
let empId = "";
const HOUR_MS = 3_600_000;

async function makeEmployee(): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ins = await serviceClient()
    .from("ai_employees" as never)
    .insert({
      name: `it-rec-${stamp}`,
      slug: `it-rec-${stamp}`,
      role: "Recovery fixture",
      department: "quality",
      permissions: { can_execute: true, requires_approval: false, scopes: ["read"] },
    } as never)
    .select("id");
  const id = (ins.data as IdRow[] | null)?.[0]?.id;
  expect(typeof id, "fixture employee id").toBe("string");
  return id as string;
}

/** Plant a memory row directly, forging whatever queue/lease state the probe needs. */
async function plantMemory(fields: Record<string, unknown>): Promise<string> {
  const ins = await serviceClient()
    .from("hq_memories" as never)
    .insert({
      title: `IT recovery ${crypto.randomUUID()}`,
      summary: "recovery probe",
      body: "recovery probe body alpha bravo charlie",
      memory_type: "research",
      source: "ai_employee",
      status: "active",
      visibility: "private",
      memory_class: "episodic",
      owner_employee_id: empId,
      salience: 50,
      embedding_status: "pending",
      ...fields,
    } as never)
    .select("id");
  const id = (ins.data as IdRow[] | null)?.[0]?.id;
  expect(typeof id, "planted memory id").toBe("string");
  created.push(id as string);
  return id as string;
}

async function getRow(id: string): Promise<QueueRow | null> {
  const { data } = await serviceClient()
    .from("hq_memories" as never)
    .select("embedding_claimed_at, embedding_claimed_by, embedded_at, embedding_status")
    .eq("id", id)
    .single();
  return data as QueueRow | null;
}

/** Read-modify-write the embed worker kill-switch, like the bench harness. */
async function setEmbedGate(on: boolean): Promise<void> {
  const svc = serviceClient();
  const cur = await svc.from("hq_settings" as never).select("data").eq("id", "singleton").single();
  const data = ((cur.data as { data?: Record<string, Record<string, unknown>> } | null)?.data) ?? {};
  data.memory_embedding = { ...(data.memory_embedding ?? {}), worker_enabled: on };
  await svc.from("hq_settings" as never).update({ data } as never).eq("id", "singleton");
}

describeIntegration("Shared Memory · embedding-worker crash recovery (real client)", () => {
  beforeAll(async () => {
    empId = await makeEmployee();
  });

  afterAll(async () => {
    for (const id of created) {
      await serviceClient().from("hq_memories" as never).delete().eq("id", id);
    }
    if (empId) await serviceClient().from("ai_employees" as never).delete().eq("id", empId);
    await setEmbedGate(false); // leave the gate dark, like every harness
  });

  it("reclaims a crashed worker's EXPIRED lease so the row is claimable again", async () => {
    const id = await plantMemory({
      embedding_claimed_at: new Date(Date.now() - HOUR_MS).toISOString(),
      embedding_claimed_by: "dead-worker-aaa",
      embedded_at: null,
    });
    const n = await serviceClient().rpc("hq_embedding_reclaim_stale", {
      p_lease_seconds: 300,
      p_limit: 500,
    });
    expect(n.error, n.error?.message ?? "").toBeNull();
    expect((n.data as number) >= 1, "≥1 stale lease reclaimed").toBe(true);

    const row = await getRow(id);
    expect(row?.embedding_claimed_at, "lease cleared").toBeNull();
    expect(row?.embedding_claimed_by, "worker cleared").toBeNull();
    expect(row?.embedded_at, "re-queued, not silently marked done").toBeNull();
  });

  it("does NOT reclaim a fresh, still-valid lease (in-flight work is protected)", async () => {
    const id = await plantMemory({
      embedding_claimed_at: new Date().toISOString(),
      embedding_claimed_by: "live-worker-bbb",
      embedded_at: null,
    });
    const n = await serviceClient().rpc("hq_embedding_reclaim_stale", {
      p_lease_seconds: 300,
      p_limit: 500,
    });
    expect(n.error, n.error?.message ?? "").toBeNull();

    const row = await getRow(id);
    expect(row?.embedding_claimed_by, "live lease must still be held").toBe("live-worker-bbb");
  });

  it("does NOT claim a backed-off row until its next_attempt is due (retry-storm throttle)", async () => {
    await setEmbedGate(true);
    const id = await plantMemory({
      embedding_next_attempt_at: new Date(Date.now() + HOUR_MS).toISOString(),
      embedded_at: null,
    });
    const res = await serviceClient().rpc("hq_embedding_claim_batch", {
      p_worker_id: "probe-ccc",
      p_limit: 100,
      p_lease_seconds: 300,
    });
    expect(res.error, res.error?.message ?? "").toBeNull();
    const claimed = ((res.data as { claimed?: { id: string }[] }).claimed ?? []).map((r) => r.id);
    expect(claimed.includes(id), "a backed-off row must be skipped").toBe(false);
    await setEmbedGate(false);
  });

  it("runEmbeddingWorker reclaims a crashed lease AND completes it end-to-end", async () => {
    if (!isEmbeddingConfigured()) {
      // No provider here → the worker is a graceful no-op by design (stopped:
      // 'no_provider'); the SQL-primitive probes above already prove the
      // recovery mechanics. Nothing to assert end-to-end in this environment.
      return;
    }
    await setEmbedGate(true);
    const id = await plantMemory({
      embedding_claimed_at: new Date(Date.now() - HOUR_MS).toISOString(),
      embedding_claimed_by: "dead-worker-ddd",
      embedded_at: null,
      embedding_status: "pending",
    });

    const s = await runEmbeddingWorker({
      batchSize: 64,
      maxBatches: 5,
      maxRunMs: 60_000,
      maxCostUsd: 1e12,
    });
    expect(s.reclaimed >= 1, "the run reclaimed the crashed lease").toBe(true);

    const row = await getRow(id);
    expect(row?.embedded_at, "reclaimed row is now embedded").not.toBeNull();
    expect(row?.embedding_status, "status flips to embedded").toBe("embedded");
    await setEmbedGate(false);
  });
});

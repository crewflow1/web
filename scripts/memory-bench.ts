/**
 * Shared Memory — local validation + performance harness (CEO Directive 009
 * Module 1 Final Validation). NOT shipped behaviour: a developer/CI tool that
 * drives the REAL service + worker code (rememberMemory / recallMemory /
 * forgetMemory / runEmbeddingWorker / runMemoryLifecycleWorker) against a local
 * Docker Supabase, with the offline deterministic embedding provider so the full
 * queue→embed→store→ANN loop runs with zero network and zero API key.
 *
 * Usage (always with the local env sourced):
 *   tsx scripts/memory-bench.ts clean
 *   tsx scripts/memory-bench.ts seed <N>
 *   tsx scripts/memory-bench.ts embed
 *   tsx scripts/memory-bench.ts recall <K>
 *   tsx scripts/memory-bench.ts lifecycle
 *   tsx scripts/memory-bench.ts write <N>        # exercise the write path
 *   tsx scripts/memory-bench.ts report
 *
 * Every row it creates is tagged (title prefix BENCH_PREFIX, slug prefix
 * bench-) so `clean` removes exactly the harness's footprint and nothing else.
 */

import { performance } from "node:perf_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { recallMemory, rememberMemory } from "@/server/services/hq-memory";
import { runEmbeddingWorker } from "@/server/services/memory-embedder";
import { runMemoryLifecycleWorker } from "@/server/services/memory-lifecycle";
import { getEmbeddingProvider } from "@/lib/ai/embeddings";
import { assertLocalDestructiveTarget } from "@/lib/testing/destructive-db-guard";

const BENCH_PREFIX = "BENCH·";
const BENCH_SLUG = "bench-";
// Must satisfy ai_employees_department_check (a fixed enum of real depts);
// identification is by slug/title prefix, so the specific value is immaterial.
const BENCH_DEPT = "operations";
const EMPLOYEES = 4;

// The generated `Database` type predates the HQ memory tables (added by
// migration, types never regenerated), so the strongly-typed admin client
// rejects `.from("hq_memories")` etc. The service layer erases this with
// `from(name as never)`; a harness is simpler with one untyped client.
type Admin = SupabaseClient;
const now = () => performance.now();
const ms = (n: number) => `${n.toFixed(1)}ms`;

function pctl(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx] as number;
}

function stats(label: string, lat: number[]): void {
  const total = lat.reduce((a, b) => a + b, 0);
  console.log(
    `  ${label}: n=${lat.length} p50=${ms(pctl(lat, 50))} p95=${ms(pctl(lat, 95))} ` +
      `max=${ms(Math.max(...lat))} mean=${ms(total / lat.length)}`,
  );
}

/** Idempotently ensure the bench employee pool exists; return their ids. */
async function ensureEmployees(admin: Admin): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < EMPLOYEES; i++) {
    const slug = `${BENCH_SLUG}e${i}`;
    const existing = await admin.from("ai_employees").select("id").eq("slug", slug).maybeSingle();
    if (existing.data?.id) {
      ids.push(existing.data.id as string);
      continue;
    }
    const ins = await admin
      .from("ai_employees")
      .insert({
        name: slug,
        slug,
        role: "Benchmark fixture",
        department: BENCH_DEPT,
        // Authority is sourced from the Capability Registry (Directive #015 / D-05);
        // LR5.4B removed the legacy ai_employees.permissions column, so the bench
        // fixtures carry none — a grantless employee resolves to the deny floor, which
        // is fine for a memory-recall benchmark that exercises no capability gate.
      })
      .select("id")
      .single();
    if (ins.error) throw new Error(`ensureEmployees: ${ins.error.message}`);
    ids.push(ins.data.id as string);
  }
  return ids;
}

/** Read-modify-write a worker kill-switch in hq_settings. */
async function setGate(admin: Admin, section: string, on: boolean): Promise<void> {
  const cur = await admin.from("hq_settings").select("data").eq("id", "singleton").single();
  if (cur.error) throw new Error(`setGate read: ${cur.error.message}`);
  const data = (cur.data.data ?? {}) as Record<string, Record<string, unknown>>;
  data[section] = { ...(data[section] ?? {}), worker_enabled: on };
  const upd = await admin.from("hq_settings").update({ data }).eq("id", "singleton");
  if (upd.error) throw new Error(`setGate write: ${upd.error.message}`);
}

async function corpusSize(admin: Admin): Promise<number> {
  const { count } = await admin
    .from("hq_memories")
    .select("id", { count: "exact", head: true })
    .like("title", `${BENCH_PREFIX}%`);
  return count ?? 0;
}

// --- commands ----------------------------------------------------------------

async function cmdClean(admin: Admin): Promise<void> {
  const del = await admin.from("hq_memories").delete().like("title", `${BENCH_PREFIX}%`);
  if (del.error) throw new Error(del.error.message);
  const delEmp = await admin.from("ai_employees").delete().like("slug", `${BENCH_SLUG}%`);
  if (delEmp.error) throw new Error(delEmp.error.message);
  await setGate(admin, "memory_embedding", false);
  await setGate(admin, "memory_lifecycle", false);
  console.log("clean: removed all BENCH· memories + bench- employees; gates reset to dark");
}

async function cmdSeed(admin: Admin, n: number): Promise<void> {
  const emp = await ensureEmployees(admin);
  const vis = ["private", "department", "public_hq", "private"] as const;
  const cls = ["episodic", "semantic", "procedural", "working"] as const;
  const BATCH = 1000;
  const t0 = now();
  let made = 0;
  for (let start = 0; start < n; start += BATCH) {
    const rows: Record<string, unknown>[] = [];
    for (let i = start; i < Math.min(start + BATCH, n); i++) {
      const v = vis[i % vis.length]!;
      const ownerId = v === "public_hq" ? null : emp[i % emp.length]!;
      rows.push({
        title: `${BENCH_PREFIX}${i}`,
        summary: `benchmark corpus summary ${i}`,
        body: `benchmark corpus document ${i} alpha bravo charlie ${(i * 2654435761) % 999983}`,
        memory_type: "research",
        source: "ai_employee",
        status: "active",
        visibility: v,
        memory_class: cls[i % cls.length]!,
        department: v === "department" ? BENCH_DEPT : null,
        owner_employee_id: ownerId,
        salience: 40 + (i % 40),
      });
    }
    const ins = await admin.from("hq_memories").insert(rows);
    if (ins.error) throw new Error(`seed batch @${start}: ${ins.error.message}`);
    made += rows.length;
  }
  const dt = now() - t0;
  console.log(
    `seed: inserted ${made} memories in ${ms(dt)} ` +
      `(${(made / (dt / 1000)).toFixed(0)} rows/s); corpus now ${await corpusSize(admin)}`,
  );
}

async function cmdEmbed(admin: Admin): Promise<void> {
  const provider = getEmbeddingProvider();
  console.log(`embed: provider=${provider ? provider.info.version : "NONE"}`);
  await setGate(admin, "memory_embedding", true);
  let embedded = 0,
    claimed = 0,
    failed = 0,
    batches = 0,
    cost = 0;
  const t0 = now();
  for (;;) {
    const s = await runEmbeddingWorker({
      batchSize: 256,
      maxBatches: 1000,
      maxRunMs: 10 * 60_000,
      maxCostUsd: 1e12,
    });
    embedded += s.embedded;
    claimed += s.claimed;
    failed += s.failed;
    batches += s.batches;
    cost += s.costUsd;
    if (s.claimed === 0) break;
    process.stdout.write(`\r  …embedded ${embedded} (batches ${batches})   `);
  }
  const dt = now() - t0;
  console.log(
    `\nembed: claimed=${claimed} embedded=${embedded} failed=${failed} batches=${batches} ` +
      `in ${ms(dt)} → ${(embedded / (dt / 1000)).toFixed(0)} memories/s; ledger cost $${cost.toFixed(6)}`,
  );
  await setGate(admin, "memory_embedding", false);
}

async function cmdRecall(admin: Admin, k: number): Promise<void> {
  const emp = await ensureEmployees(admin);
  const e = { id: emp[0]! };
  const size = await corpusSize(admin);
  console.log(`recall: corpus=${size}, ${k} iterations as employee ${e.id.slice(0, 8)}…`);

  const warm = await recallMemory({ query: "benchmark", candidateLimit: 60, reinforce: false }, e);
  if (!warm.ok) throw new Error(`recall failed: ${warm.error}`);
  console.log(`  (warm-up candidateCount=${warm.candidateCount}, assembled=${warm.items.length})`);

  const lex: number[] = [];
  for (let i = 0; i < k; i++) {
    const t = now();
    const r = await recallMemory(
      { query: "benchmark corpus alpha", candidateLimit: 60, reinforce: false },
      e,
    );
    lex.push(now() - t);
    if (!r.ok) throw new Error(`recall failed: ${r.error}`);
  }
  stats("lexical+semantic recall (query)", lex);

  const rec: number[] = [];
  for (let i = 0; i < k; i++) {
    const t = now();
    const r = await recallMemory({ query: null, candidateLimit: 60, reinforce: false }, e);
    rec.push(now() - t);
    if (!r.ok) throw new Error(`recall(recency) failed: ${r.error}`);
  }
  stats("recency recall (no query)", rec);
}

async function cmdLifecycle(admin: Admin): Promise<void> {
  await setGate(admin, "memory_lifecycle", true);
  const t0 = now();
  const s = await runMemoryLifecycleWorker({ scanLimit: 1000, maxRunMs: 5 * 60_000, maxCostUsd: 1e12 });
  console.log(`lifecycle: ${ms(now() - t0)} →`, JSON.stringify(s));
  await setGate(admin, "memory_lifecycle", false);
}

async function cmdWrite(admin: Admin, n: number): Promise<void> {
  const emp = await ensureEmployees(admin);
  const e = { id: emp[0]! };
  const lat: number[] = [];
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const t = now();
    const r = await rememberMemory(
      {
        memoryClass: "episodic",
        memoryType: "research",
        title: `${BENCH_PREFIX}write ${i} ${Date.now()}`,
        summary: "write-path probe",
        body: `write path probe document ${i}`,
        visibility: "private",
      },
      e,
    );
    lat.push(now() - t);
    if (r.ok) ok++;
    else console.log(`  write ${i} refused: ${r.error}`);
  }
  console.log(`write: ${ok}/${n} via rememberMemory()`);
  stats("rememberMemory()", lat);
}

async function cmdReport(admin: Admin): Promise<void> {
  const size = await corpusSize(admin);
  const embedded = await admin
    .from("hq_memories")
    .select("id", { count: "exact", head: true })
    .like("title", `${BENCH_PREFIX}%`)
    .eq("embedding_status", "embedded");
  const runs = await admin.from("hq_embedding_runs").select("status", { count: "exact", head: true });
  console.log(
    `report: bench corpus=${size}, embedded=${embedded.count ?? 0}, embedding_runs ledger=${runs.count ?? 0}`,
  );
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  /**
   * This harness writes AND deletes (`clean` removes every bench-tagged memory
   * and ai_employee row; `seed`/`write` insert thousands). It is documented as a
   * local-Docker-Supabase tool, but it resolves its database from the ambient
   * environment via createAdminClient() — which reads NEXT_PUBLIC_SUPABASE_URL,
   * the same variable a shell left over from a production session would hold.
   * Refuse before the client is built. Same variable createAdminClient reads.
   */
  assertLocalDestructiveTarget(process.env.NEXT_PUBLIC_SUPABASE_URL, {
    entryPoint: "shared-memory bench harness (scripts/memory-bench.ts)",
    envVar: "NEXT_PUBLIC_SUPABASE_URL",
  });
  const admin = createAdminClient() as unknown as Admin;
  switch (cmd) {
    case "clean":
      return cmdClean(admin);
    case "seed":
      return cmdSeed(admin, Number(arg));
    case "embed":
      return cmdEmbed(admin);
    case "recall":
      return cmdRecall(admin, Number(arg ?? 50));
    case "lifecycle":
      return cmdLifecycle(admin);
    case "write":
      return cmdWrite(admin, Number(arg ?? 100));
    case "report":
      return cmdReport(admin);
    default:
      console.error("usage: memory-bench <clean|seed N|embed|recall K|lifecycle|write N|report>");
      process.exit(1);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("FATAL:", e instanceof Error ? e.message : e);
    process.exit(1);
  },
);

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Shared Memory — embedding-layer security invariants (Volume X §11; CEO
 * Directive 009 Module 1, PR4).
 *
 * CI has no database in this tier (live behaviour is proven in the integration
 * tier), so — exactly like the spine + write + recall invariant suites — we pin
 * the embedding migration's security contract against its source text. These
 * are the assertions that, if they ever silently flipped, would be a hole: an
 * external AI call leaking into a SQL transaction, the worker queue becoming
 * JWT-callable, an un-hardened SECURITY DEFINER primitive, a destructive
 * (non-additive) change, the kill-switch defaulting ON, the lease/idempotency
 * guard disappearing (duplicate embeddings), or the embedding path emitting a
 * (non-existent) business event on The Pulse.
 *
 * Load-bearing checks run over `exec` (executable SQL with `--` comments
 * stripped) so prose can't satisfy a positive match or trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG_REL = "supabase/migrations/20260725000000_hq_memory_embeddings.sql";
const mig = read(MIG_REL);

const exec = mig
  .split("\n")
  .map((line) => {
    const idx = line.indexOf("--");
    return idx === -1 ? line : line.slice(0, idx);
  })
  .join("\n");

/** The header of a CREATE FUNCTION (signature → `as $$`), where hardening lives. */
function fnHeader(name: string): string {
  const start = exec.indexOf(`create or replace function public.${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const bodyAt = exec.indexOf("as $$", start);
  expect(bodyAt, `function ${name} body not found`).toBeGreaterThan(start);
  return exec.slice(start, bodyAt);
}

/** The full source of a CREATE FUNCTION (signature → closing `$$;`). */
function fnSource(name: string): string {
  const start = exec.indexOf(`create or replace function public.${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const end = exec.indexOf("$$;", start);
  expect(end, `function ${name} end not found`).toBeGreaterThan(start);
  return exec.slice(start, end);
}

const WORKER_FNS = [
  "hq_memory_embed_enabled",
  "hq_embedding_claim_batch",
  "hq_embedding_complete",
  "hq_embedding_fail",
  "hq_embedding_reclaim_stale",
  "hq_embedding_enqueue_stale",
  "hq_embedding_reset_failed",
  "hq_embedding_golden_signals",
];

// =====================================================================
// 0. The migration ships
// =====================================================================

describe("memory embeddings — migration is present", () => {
  it("the PR4 embedding-layer migration exists", () => {
    expect(existsSync(resolve(ROOT, MIG_REL))).toBe(true);
  });
});

// =====================================================================
// 1. Additive & dark — no destructive change
// =====================================================================

describe("memory embeddings — the migration is additive and dark", () => {
  it("drops or retypes nothing (production-safe)", () => {
    // `drop trigger if exists` (idempotent recreate) is allowed; destructive
    // drops of tables/columns/functions/indexes are not.
    expect(exec).not.toMatch(/drop\s+(table|column|function|index)\b/i);
    expect(exec).not.toMatch(/alter\s+table[^;]*\bdrop\b/i);
    expect(exec).not.toMatch(/\btruncate\b/i);
  });

  it("touches NO tenant table — only hq_memories + the new hq_embedding_runs", () => {
    // The only mutated tables are the HQ memory table + the new ledger + the
    // HQ settings singleton (the kill-switch). No customer/staff tables.
    expect(exec).toMatch(/alter table public\.hq_memories\s+add column/i);
    expect(exec).toMatch(/create table if not exists public\.hq_embedding_runs/i);
  });

  it("the worker ships DARK — the kill-switch defaults to false", () => {
    expect(exec).toMatch(/'memory_embedding'/);
    expect(exec).toMatch(/'worker_enabled', false/);
  });
});

// =====================================================================
// 2. pgvector + the vector column + the 9 permanent metadata fields
// =====================================================================

describe("memory embeddings — pgvector + versioned-asset columns", () => {
  it("enables pgvector, pinned to the public schema", () => {
    expect(exec).toMatch(/create extension if not exists vector/i);
    // Pinned to `public` so the search_path='' functions can resolve
    // `public.vector` / `OPERATOR(public.<=>)` deterministically.
    expect(exec).toMatch(/create extension if not exists vector with schema public/i);
  });

  it("adds the real vector column sized for Version 1 (1536-d)", () => {
    expect(exec).toMatch(/add column if not exists embedding vector\(1536\)/i);
  });

  it("permanently stores all 9 embedding metadata fields the directive names", () => {
    for (const col of [
      "embedding_provider",
      "embedding_model",
      "embedding_dimension",
      "embedding_version",
      "embedding_checksum",
      "embedded_at",
      "embedding_latency_ms",
      "embedding_cost",
      "embedding_status",
    ]) {
      expect(exec, `missing metadata column ${col}`).toMatch(
        new RegExp(`add column if not exists ${col}\\b`, "i"),
      );
    }
  });

  it("adds the worker queue/lease/backoff bookkeeping columns", () => {
    for (const col of [
      "embedding_attempts",
      "embedding_last_error",
      "embedding_claimed_at",
      "embedding_claimed_by",
      "embedding_next_attempt_at",
    ]) {
      expect(exec, `missing worker column ${col}`).toMatch(
        new RegExp(`add column if not exists ${col}\\b`, "i"),
      );
    }
  });
});

// =====================================================================
// 3. Indexes — ANN (HNSW) for recall + a tiny partial queue index
// =====================================================================

describe("memory embeddings — built for millions of rows", () => {
  it("creates an HNSW cosine ANN index, partial over non-null vectors", () => {
    expect(exec).toMatch(/using hnsw \(embedding vector_cosine_ops\)/i);
    expect(exec).toMatch(/hq_memories_embedding_hnsw[\s\S]*?where embedding is not null/i);
  });

  it("creates a PARTIAL queue index so the per-minute claim never seq-scans", () => {
    expect(exec).toMatch(
      /hq_memories_embed_queue_idx[\s\S]*?where embedded_at is null and embedding_status <> 'failed'/i,
    );
  });
});

// =====================================================================
// 4. The cost ledger — every request recorded, RLS-locked
// =====================================================================

describe("memory embeddings — the per-request cost ledger", () => {
  it("creates hq_embedding_runs with the full cost-accounting contract", () => {
    const start = exec.indexOf("create table if not exists public.hq_embedding_runs");
    const end = exec.indexOf(");", start);
    const ddl = exec.slice(start, end);
    for (const col of [
      "worker_id",
      "provider",
      "model",
      "dimension",
      "tokens",
      "cost",
      "latency_ms",
      "attempt",
      "status",
      "failure_reason",
      "created_at",
    ]) {
      expect(ddl, `ledger missing ${col}`).toMatch(new RegExp(`\\b${col}\\b`, "i"));
    }
  });

  it("the ledger is RLS-locked (service-role only — no JWT can read spend)", () => {
    expect(exec).toMatch(/alter table public\.hq_embedding_runs enable row level security/i);
  });
});

// =====================================================================
// 5. External AI calls NEVER run inside a SQL transaction (CEO rule)
// =====================================================================

describe("memory embeddings — no external AI call inside Postgres", () => {
  it("the SQL never reaches out to a provider (the worker does, in TS)", () => {
    expect(exec).not.toMatch(/\bopenai\b/i);
    expect(exec).not.toMatch(/\banthropic\b/i);
    expect(exec).not.toMatch(/\bhttp\b/i);
    expect(exec).not.toMatch(/pg_net|net\.http|extensions\.http/i);
  });
});

// =====================================================================
// 6. Embedding is NOT a business event — nothing on The Pulse
// =====================================================================

describe("memory embeddings — the worker emits nothing on the event spine", () => {
  it("no hq_emit_event, no hq_events insert, no memory.* verb literal", () => {
    expect(exec).not.toMatch(/hq_emit_event/i);
    expect(exec).not.toMatch(/insert into public\.hq_events/i);
    expect(exec).not.toMatch(/'memory\.[a-z_]+'/i);
  });
});

// =====================================================================
// 7. The claim → embed (in TS) → complete/fail contract
// =====================================================================

describe("memory embeddings — claim/complete/fail mechanics", () => {
  it("claim leases a bounded batch with FOR UPDATE SKIP LOCKED and is fail-dark", () => {
    const src = fnSource("hq_embedding_claim_batch");
    expect(src).toMatch(/if not public\.hq_memory_embed_enabled\(\)/i);
    expect(src).toMatch(/for update skip locked/i);
    expect(src).toMatch(/limit greatest\(p_limit, 1\)/i);
    expect(src).toMatch(/embedding_claimed_by = p_worker_id/i);
  });

  it("complete swaps the vector + metadata ATOMICALLY, lease-guarded (idempotent)", () => {
    const src = fnSource("hq_embedding_complete");
    // single atomic UPDATE that writes the vector and clears the lease. The
    // type is SCHEMA-QUALIFIED (public.vector) because the function pins
    // search_path = '' — an unqualified ::vector would not resolve at runtime.
    expect(src).toMatch(/embedding\s*=\s*p_embedding::real\[\]::public\.vector/i);
    expect(src).toMatch(/embedded_at\s*=\s*now\(\)/i);
    // idempotency / crash-recovery guard: only the lease holder may complete
    expect(src).toMatch(/where m\.id = p_memory_id[\s\S]*?and m\.embedding_claimed_by = p_worker_id/i);
    // defends the ANN index from a wrong-length vector
    expect(src).toMatch(/dimension_mismatch/i);
    // records the success in the cost ledger
    expect(src).toMatch(/insert into public\.hq_embedding_runs/i);
  });

  it("fail does exponential backoff + dead-letters after the threshold", () => {
    const src = fnSource("hq_embedding_fail");
    expect(src).toMatch(/embedding_attempts\s*=\s*m\.embedding_attempts \+ 1/i);
    expect(src).toMatch(/power\(2, m\.embedding_attempts \+ 1\)/i); // exponential
    expect(src).toMatch(/least\([\s\S]*?3600\)/i); // capped at 1h
    expect(src).toMatch(/then 'failed'/i); // DLQ at the threshold
    expect(src).toMatch(/and m\.embedding_claimed_by = p_worker_id/i); // lease-guarded
    expect(src).toMatch(/insert into public\.hq_embedding_runs/i);
  });
});

// =====================================================================
// 8. Recovery + re-embed primitives
// =====================================================================

describe("memory embeddings — crash recovery + re-embedding", () => {
  it("reclaim_stale frees expired leases on not-yet-completed rows", () => {
    const src = fnSource("hq_embedding_reclaim_stale");
    expect(src).toMatch(/embedding_claimed_at is not null/i);
    expect(src).toMatch(/embedded_at is null/i);
    expect(src).toMatch(/embedding_claimed_at < now\(\) - make_interval/i);
  });

  it("enqueue_stale re-queues version-mismatched rows but KEEPS the old vector", () => {
    const src = fnSource("hq_embedding_enqueue_stale");
    expect(src).toMatch(/embedding_version is distinct from p_target_version/i);
    expect(src).toMatch(/embedded_at = null/i);
    // it must NOT null the vector itself — old vectors stay searchable
    expect(src).not.toMatch(/\bembedding\s*=\s*null/i);
  });

  it("reset_failed drains the dead-letter queue (deliberate operator action)", () => {
    const src = fnSource("hq_embedding_reset_failed");
    expect(src).toMatch(/embedding_status = 'failed'/i);
    expect(src).toMatch(/embedding_status = 'pending'/i);
  });
});

// =====================================================================
// 9. Function hardening — SECURITY DEFINER + pinned empty search_path
// =====================================================================

describe("memory embeddings — every function is hardened", () => {
  for (const fn of WORKER_FNS) {
    it(`${fn} is SECURITY DEFINER with an empty search_path`, () => {
      const header = fnHeader(fn);
      expect(header).toMatch(/security definer/i);
      expect(header).toMatch(/set search_path = ''/i);
    });
  }
});

// =====================================================================
// 10. Privilege model — service_role-only (L-4), never a JWT role
// =====================================================================

describe("memory embeddings — EXECUTE granted only to service_role", () => {
  for (const fn of WORKER_FNS) {
    it(`${fn} is revoked from JWT roles and granted only to service_role`, () => {
      expect(exec).toMatch(
        new RegExp(
          `revoke all on function\\s+public\\.${fn}\\([\\s\\S]*?\\)\\s*from public, anon, authenticated`,
          "i",
        ),
      );
      expect(exec).toMatch(
        new RegExp(
          `grant execute on function\\s+public\\.${fn}\\([\\s\\S]*?\\)\\s*to service_role`,
          "i",
        ),
      );
    });
  }

  it("never grants EXECUTE/privilege to a JWT role (anon/authenticated/public)", () => {
    expect(exec).not.toMatch(/\bto\s+anon\b/i);
    expect(exec).not.toMatch(/\bto\s+authenticated\b/i);
    expect(exec).not.toMatch(/grant[\s\S]*?\bto\s+public\b/i);
  });
});

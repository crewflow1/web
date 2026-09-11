import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { EVENT_TYPES, MEMORY_STATUSES, PURGED_STATUS } from "@/lib/memory/model";

/**
 * Shared Memory — REAL PURGE semantics: security invariants (E2).
 *
 * CI has no database in this tier (live behaviour is proven in the integration
 * tier: __tests__/integration/memory/purge-path.test.ts), so — exactly like the
 * forget/embedding/lifecycle invariant suites — we pin the purge migration's
 * contract against its source text. These are the assertions that, if they ever
 * silently flipped, would be a hole:
 *
 *   - purge becoming a ROW DELETE (the audit skeleton must survive — children
 *     cascade on delete, which would destroy the evidence);
 *   - the scrub set shrinking (content or vector surviving a purge — including
 *     the hq_memory_versions snapshots, where the body would otherwise live on);
 *   - a resurrection vector reopening: the drift-requeue trigger re-enqueueing
 *     the tombstone, claim_batch / enqueue_stale / reset_failed selecting
 *     purged rows, or the one-way tombstone guard disappearing;
 *   - content leaking into the audit event detail;
 *   - 'purged' becoming an OPERATOR-SETTABLE status (it must only ever be
 *     reachable through the scrubbing primitive);
 *   - an un-hardened or JWT-callable SECURITY DEFINER primitive.
 *
 * Load-bearing checks run over `exec` (executable SQL with `--` comments
 * stripped) so prose can't satisfy a positive match or trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG_REL = "supabase/migrations/20261228000000_hq_memory_purge.sql";
const mig = read(MIG_REL);

const exec = mig
  .split("\n")
  .map((line) => {
    const idx = line.indexOf("--");
    return idx === -1 ? line : line.slice(0, idx);
  })
  .join("\n");

function fnHeader(name: string): string {
  const start = exec.indexOf(`create or replace function public.${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const bodyAt = exec.indexOf("as $$", start);
  expect(bodyAt, `function ${name} body not found`).toBeGreaterThan(start);
  return exec.slice(start, bodyAt);
}

function fnSource(name: string): string {
  const start = exec.indexOf(`create or replace function public.${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const end = exec.indexOf("$$;", start);
  expect(end, `function ${name} end not found`).toBeGreaterThan(start);
  return exec.slice(start, end);
}

// =====================================================================
// 0. The migration ships, and stays additive
// =====================================================================

describe("memory purge — migration is present and additive", () => {
  it("the E2 purge migration exists", () => {
    expect(existsSync(resolve(ROOT, MIG_REL))).toBe(true);
  });

  it("drops or retypes no table/column/function/index (production-safe)", () => {
    // The CHECK-widening idiom (drop constraint if exists + re-add) and the
    // idempotent `drop trigger if exists` are the only drops allowed.
    expect(exec).not.toMatch(/drop\s+(table|column|function|index)\b/i);
    expect(exec).not.toMatch(/alter\s+table[^;]*\bdrop\s+(?!constraint)/i);
    expect(exec).not.toMatch(/\btruncate\b/i);
    expect(exec).not.toMatch(/\balter\s+column\b/i);
  });

  it("adds the three content-free attribution columns", () => {
    for (const col of ["purged_at", "purged_by", "purge_reason"]) {
      expect(exec, `missing column ${col}`).toMatch(
        new RegExp(`add column if not exists ${col}\\b`, "i"),
      );
    }
  });

  it("WIDENS the status CHECKs (every pre-existing value stays legal)", () => {
    expect(exec).toMatch(
      /check \(status in \('draft', 'active', 'archived', 'superseded', 'purged'\)\)/i,
    );
    expect(exec).toMatch(
      /check \(embedding_status in \('pending', 'embedded', 'failed', 'stale', 'purged'\)\)/i,
    );
  });

  it("touches no RLS (the tables are already service-role-only)", () => {
    expect(exec).not.toMatch(/create policy|alter policy|drop policy/i);
    expect(exec).not.toMatch(/disable row level security/i);
  });
});

// =====================================================================
// 1. Purge is a TOMBSTONE, never a row delete
// =====================================================================

describe("memory purge — scrub-in-place, never delete", () => {
  it("no statement deletes from hq_memories or its children", () => {
    expect(exec).not.toMatch(/delete\s+from/i);
  });

  it("the primitive scrubs title/summary/body to fixed redaction markers", () => {
    const src = fnSource("hq_memory_purge");
    expect(src).toMatch(/title\s*=\s*'\[purged\]'/i);
    expect(src).toMatch(/summary\s*=\s*''/i);
    expect(src).toMatch(/body\s*=\s*''/i);
    expect(src).toMatch(/tags\s*=\s*'\{\}'/i);
    expect(src).toMatch(/keywords\s*=\s*'\{\}'/i);
    expect(src).toMatch(/organisation_name\s*=\s*null/i);
    expect(src).toMatch(/embedding_placeholder\s*=\s*null/i);
  });

  it("the vector AND all embedding metadata are nulled", () => {
    const src = fnSource("hq_memory_purge");
    expect(src).toMatch(/\bembedding\s*=\s*null/i);
    for (const col of [
      "embedding_provider",
      "embedding_model",
      "embedding_dimension",
      "embedding_version",
      "embedding_checksum",
      "embedded_at",
    ]) {
      expect(src, `${col} must be nulled`).toMatch(
        new RegExp(`${col}\\s*=\\s*null`, "i"),
      );
    }
    expect(src).toMatch(/embedding_status\s*=\s*'purged'/i);
  });

  it("scrubs EVERY hq_memory_versions snapshot (where the body would survive)", () => {
    const src = fnSource("hq_memory_purge");
    expect(src).toMatch(
      /update public\.hq_memory_versions[\s\S]*?title\s*=\s*'\[purged\]'[\s\S]*?summary\s*=\s*''[\s\S]*?body\s*=\s*''/i,
    );
  });

  it("scrubs inbound relationship labels that may quote the title", () => {
    const src = fnSource("hq_memory_purge");
    expect(src).toMatch(
      /update public\.hq_memory_relationships[\s\S]*?entity_label\s*=\s*'\[purged\]'/i,
    );
  });

  it("is idempotent (a re-purge is refused, never a second event)", () => {
    const src = fnSource("hq_memory_purge");
    expect(src).toMatch(/'already_purged'/i);
    expect(src).toMatch(/and m\.status <> 'purged'/i);
  });

  it("writes NO version snapshot of the purge (nothing restorable)", () => {
    const src = fnSource("hq_memory_purge");
    expect(src).not.toMatch(/insert into public\.hq_memory_versions/i);
  });
});

// =====================================================================
// 2. Resurrection-proofing — every requeue path skips the tombstone
// =====================================================================

describe("memory purge — resurrection vectors are closed", () => {
  it("the drift-requeue trigger SKIPS purged rows (the scrub cannot re-enqueue)", () => {
    const src = fnSource("_hq_memories_embed_requeue");
    expect(src).toMatch(/if new\.status = 'purged' then[\s\S]*?return new/i);
  });

  it("claim_batch can never lease a purged row", () => {
    const src = fnSource("hq_embedding_claim_batch");
    expect(src).toMatch(/embedding_status not in \('failed', 'purged'\)/i);
    expect(src).toMatch(/and status <> 'purged'/i);
  });

  it("enqueue_stale skips purged rows (and still keeps old vectors elsewhere)", () => {
    const src = fnSource("hq_embedding_enqueue_stale");
    expect(src).toMatch(/status <> 'purged'/i);
    expect(src).toMatch(/embedding_status <> 'purged'/i);
    // it must still NOT null the vector of the rows it re-queues
    expect(src).not.toMatch(/\bembedding\s*=\s*null/i);
  });

  it("reset_failed skips purged rows", () => {
    const src = fnSource("hq_embedding_reset_failed");
    expect(src).toMatch(/and status <> 'purged'/i);
  });

  it("the tombstone guard makes purge a ONE-WAY door at the SQL layer", () => {
    const src = fnSource("_hq_memories_purge_guard");
    expect(src).toMatch(/old\.status = 'purged'/i);
    expect(src).toMatch(/new\.status is distinct from 'purged'[\s\S]*?raise exception/i);
    expect(src).toMatch(/raise exception 'hq_memories: purged memory content is immutable/i);
    expect(src).toMatch(
      /new\.embedding is not null or new\.embedded_at is not null[\s\S]*?raise exception/i,
    );
    // and the guard trigger is actually attached
    expect(exec).toMatch(
      /create trigger hq_memories_purge_guard\s+before update on public\.hq_memories/i,
    );
  });
});

// =====================================================================
// 3. Audit — evidence survives, content does not
// =====================================================================

describe("memory purge — audit evidence without content", () => {
  it("writes a 'purged' per-memory event whose detail carries NO content fields", () => {
    const src = fnSource("hq_memory_purge");
    const eventAt = src.indexOf("insert into public.hq_memory_events");
    expect(eventAt).toBeGreaterThanOrEqual(0);
    const eventSql = src.slice(eventAt, src.indexOf(");", eventAt));
    expect(eventSql).toMatch(/'purged'/);
    expect(eventSql).toMatch(/'reason'/);
    expect(eventSql).toMatch(/'had_embedding'/);
    expect(eventSql).toMatch(/'versions_scrubbed'/);
    // no memory content can flow into the detail: the event insert references
    // no title/summary/body value.
    expect(eventSql).not.toMatch(/\b(m|v)\.(title|summary|body)\b/i);
    expect(eventSql).not.toMatch(/'title'|'summary'|'body'/i);
  });

  it("records the attribution on the tombstone (purged_at/by/reason)", () => {
    const src = fnSource("hq_memory_purge");
    expect(src).toMatch(/purged_at\s*=\s*now\(\)/i);
    expect(src).toMatch(/purged_by\s*=\s*p_actor/i);
    expect(src).toMatch(/purge_reason\s*=\s*v_reason/i);
  });

  it("emits nothing on The Pulse (no memory.purged verb exists in the registry)", () => {
    expect(exec).not.toMatch(/hq_emit_event/i);
    expect(exec).not.toMatch(/insert into public\.hq_events\b/i);
    expect(exec).not.toMatch(/'memory\.[a-z_]+'/i);
  });
});

// =====================================================================
// 4. TS mirrors — vocabulary stays in lock-step, purge stays un-flippable
// =====================================================================

describe("memory purge — SQL and TS vocabularies agree", () => {
  it("'purged' is a registered TS event type AND legal in the SQL CHECK", () => {
    expect(EVENT_TYPES as readonly string[]).toContain("purged");
    expect(exec).toMatch(/'purged'/);
  });

  it("'purged' is NOT operator-settable: never a member of MEMORY_STATUSES", () => {
    // MEMORY_STATUSES feeds the status dropdown + setStatusAction's zod enum.
    // 'purged' must only be reachable via the scrubbing primitive.
    expect(PURGED_STATUS).toBe("purged");
    expect(MEMORY_STATUSES as readonly string[]).not.toContain("purged");
  });
});

// =====================================================================
// 5. Hardening + privilege model (L-4)
// =====================================================================

describe("memory purge — every re/defined engine function is hardened", () => {
  for (const fn of [
    "hq_memory_purge",
    "hq_embedding_claim_batch",
    "hq_embedding_enqueue_stale",
    "hq_embedding_reset_failed",
  ]) {
    it(`${fn} is SECURITY DEFINER with an empty search_path`, () => {
      const header = fnHeader(fn);
      expect(header).toMatch(/security definer/i);
      expect(header).toMatch(/set search_path = ''/i);
    });

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

  it("no external AI call inside Postgres", () => {
    expect(exec).not.toMatch(/\bopenai\b/i);
    expect(exec).not.toMatch(/\banthropic\b/i);
    expect(exec).not.toMatch(/pg_net|net\.http|extensions\.http/i);
  });
});

describe("audit residue is prevented at the SOURCE (review P1-1)", () => {
  it("the memory actions write NO content into the append-only activity log", () => {
    // admin_activity_log is append-only by trigger for every role, so any
    // content copied into it is unredactable forever. The actions therefore
    // log shape (title_chars), never the title itself.
    const src = readFileSync(
      resolve(__dirname, "../../app/admin/memory/actions.ts"),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    // No metadata object may carry a raw title value.
    expect(code).not.toMatch(/metadata:\s*\{[^}]*\btitle:\s/);
    expect(code).toMatch(/title_chars/);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { VERB_GROUPS, isVerb } from "@/lib/events/registry";
import { EVENT_TYPES } from "@/lib/memory/model";
import {
  DECAY_FLOOR,
  EPISODIC_DECAY_TAU_MS,
  MIN_CONSOLIDATION_SOURCES,
  SUMMARY_MIN_BODY_CHARS,
  SUMMARY_MAX_RATIO,
  DEDUPE_COSINE_THRESHOLD,
} from "@/lib/memory/lifecycle";

/**
 * Shared Memory — consolidation + lifecycle security invariants
 * (Volume X §9–§10; CEO Directive 009 Module 1, PR5).
 *
 * CI has no database in this tier (live behaviour is proven in the integration
 * tier), so — exactly like the spine + write + recall + embedding invariant
 * suites — we pin the lifecycle migration's contract against its source text.
 * These are the assertions that, if they ever silently flipped, would be a hole:
 * an autonomous archival/consolidation losing its kill-switch, the company brain
 * being written without the canonical verb, a durable memory becoming evictable,
 * an unconsolidated episode being archived (its lesson lost), an un-hardened or
 * JWT-callable SECURITY DEFINER primitive, an external AI call leaking into a SQL
 * transaction, a non-additive change, or — crucially — the SQL policy numbers
 * drifting away from the pure lib/memory/lifecycle.ts policy they must mirror.
 *
 * Load-bearing checks run over `exec` (executable SQL with `--` comments
 * stripped) so prose can't satisfy a positive match or trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG_REL = "supabase/migrations/20260727000000_hq_memory_lifecycle.sql";
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

const LIFECYCLE_FNS = [
  "hq_memory_lifecycle_enabled",
  "hq_memory_expire_sweep",
  "hq_memory_consolidate",
  "hq_memory_dedupe_pairs",
  "hq_memory_supersede",
  "hq_memory_summary_candidates",
  "hq_memory_set_summary",
  "hq_memory_archive",
  "hq_memory_golden_signals",
];

// =====================================================================
// 0. The migration ships
// =====================================================================

describe("memory lifecycle — migration is present", () => {
  it("the PR5 consolidation + lifecycle migration exists", () => {
    expect(existsSync(resolve(ROOT, MIG_REL))).toBe(true);
  });

  it("defines every promised lifecycle primitive", () => {
    for (const fn of LIFECYCLE_FNS) {
      expect(
        exec.includes(`create or replace function public.${fn}(`),
        `missing function ${fn}`,
      ).toBe(true);
    }
  });
});

// =====================================================================
// 1. Additive & dark — only the event-vocabulary CHECK is (widened), nothing
//    is dropped/retyped, and the worker ships behind a default-OFF kill-switch
// =====================================================================

describe("memory lifecycle — the migration is additive and dark", () => {
  it("drops or retypes nothing destructive (production-safe)", () => {
    // Widening a CHECK via `drop constraint if exists` + re-add is the repo's
    // additive idiom and is allowed; destructive drops of tables/columns/
    // functions/indexes and TRUNCATE are not.
    expect(exec).not.toMatch(/drop\s+(table|function|index)\b/i);
    expect(exec).not.toMatch(/alter\s+table[^;]*\bdrop\s+column\b/i);
    expect(exec).not.toMatch(/\btruncate\b/i);
  });

  it("only WIDENS the event_type vocabulary (every pre-existing kind stays legal)", () => {
    // The named inline CHECK is dropped + re-added with the new kinds appended.
    expect(exec).toMatch(
      /drop constraint if exists hq_memory_events_event_type_check/i,
    );
    expect(exec).toMatch(
      /add constraint hq_memory_events_event_type_check\s+check \(event_type in \(/i,
    );
    for (const kind of [
      "created", "updated", "viewed", "ai_accessed", "status_changed",
      "pinned", "unpinned", "linked", "unlinked", "version_restored",
      "summarised", "consolidated", "superseded", "archived", "expired",
    ]) {
      expect(exec, `event_type '${kind}' must remain legal`).toMatch(
        new RegExp(`'${kind}'`),
      );
    }
  });

  it("the worker ships DARK — the kill-switch defaults to false", () => {
    expect(exec).toMatch(/'memory_lifecycle'/);
    expect(exec).toMatch(/'worker_enabled', false/);
    // and it is seeded non-clobbering (only when absent)
    expect(exec).toMatch(/\(data #> '\{memory_lifecycle,worker_enabled\}'\) is null/i);
  });

  it("touches NO tenant table — only the HQ memory tables + the settings singleton", () => {
    expect(exec).not.toMatch(/\b(customers|jobs|invoices|leads|staff|organizations)\b/i);
  });
});

// =====================================================================
// 2. The TS event vocabulary is widened in LOCK-STEP with the SQL CHECK
// =====================================================================

describe("memory lifecycle — SQL CHECK and TS EVENT_TYPES agree", () => {
  for (const kind of ["summarised", "consolidated", "superseded", "archived", "expired"]) {
    it(`'${kind}' is a registered TS event type AND legal in the SQL CHECK`, () => {
      expect(EVENT_TYPES as readonly string[]).toContain(kind);
      expect(exec).toMatch(new RegExp(`'${kind}'`));
    });
  }
});

// =====================================================================
// 3. The SQL policy numbers MIRROR the pure lib/memory/lifecycle.ts policy.
//    These pins make SQL ↔ TS drift impossible: change a TS constant and the
//    matching SQL literal must move with it or this suite fails.
// =====================================================================

describe("memory lifecycle — SQL mirrors the pure policy constants exactly", () => {
  it("DECAY_FLOOR (0.05) is the archival floor in the decay expression", () => {
    expect(DECAY_FLOOR).toBe(0.05);
    expect(exec).toContain(`< ${DECAY_FLOOR}`); // "< 0.05"
  });

  it("the episodic τ is 30 days, the EPISODIC_DECAY_TAU_MS half-life", () => {
    const tauDays = EPISODIC_DECAY_TAU_MS / 86_400_000;
    expect(tauDays).toBe(30);
    expect(exec).toContain(`interval '${tauDays} days'`); // "interval '30 days'"
  });

  it("MIN_CONSOLIDATION_SOURCES (3) is the consolidation no-op threshold", () => {
    expect(MIN_CONSOLIDATION_SOURCES).toBe(3);
    expect(fnSource("hq_memory_consolidate")).toContain(`< ${MIN_CONSOLIDATION_SOURCES}`);
  });

  it("SUMMARY_MIN_BODY_CHARS (1200) gates the summary candidate scan", () => {
    expect(SUMMARY_MIN_BODY_CHARS).toBe(1200);
    expect(exec).toContain(`>= ${SUMMARY_MIN_BODY_CHARS}`);
  });

  it("SUMMARY_MAX_RATIO (0.6) is the 'summary too long to help' ratio", () => {
    expect(SUMMARY_MAX_RATIO).toBe(0.6);
    expect(exec).toContain(`* ${SUMMARY_MAX_RATIO}`); // body * 0.6
  });

  it("DEDUPE_COSINE_THRESHOLD (0.95) is the near-duplicate threshold default", () => {
    expect(DEDUPE_COSINE_THRESHOLD).toBe(0.95);
    expect(exec).toContain(`default ${DEDUPE_COSINE_THRESHOLD}`); // default 0.95
  });
});

// =====================================================================
// 4. §10 expire/decay — archive ONLY consolidated, decayed episodes; never an
//    unconsolidated one (its lesson would be lost); never a durable class
// =====================================================================

describe("memory lifecycle — TTL + decay archival is conservative", () => {
  const src = fnSource("hq_memory_expire_sweep");

  it("is fail-dark on the kill-switch (no autonomous archival when disabled)", () => {
    expect(src).toMatch(/if not public\.hq_memory_lifecycle_enabled\(\)/i);
    expect(src).toMatch(/'skipped',\s*'worker_disabled'/i);
  });

  it("TTL expiry only ever touches ephemeral classes (durable never expires)", () => {
    expect(src).toMatch(/memory_class in \('working', 'episodic'\)/i);
    expect(src).toMatch(/expires_at is not null/i);
    expect(src).toMatch(/expires_at <= p_now/i);
  });

  it("decay archival requires the episode to be CONSOLIDATED first (lesson preserved)", () => {
    expect(src).toMatch(/memory_class = 'episodic'/i);
    expect(src).toMatch(/consolidated_into is not null/i);
  });

  it("uses the effectiveScore decay shape e^(-age/τ)·salience/100 < floor", () => {
    expect(src).toMatch(/exp\(/i);
    expect(src).toMatch(/extract\(epoch from interval '30 days'\)/i);
    expect(src).toMatch(/\(salience \/ 100\.0\)/i);
    expect(src).toMatch(/< 0\.05/);
    // clock-skew safe: age is clamped at zero (mirrors memoryAgeMs)
    expect(src).toMatch(/greatest\(0,\s*extract\(epoch/i);
  });

  it("is idempotent — both passes are guarded by status='active'", () => {
    expect(src.match(/status = 'active'/gi)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("audits both transitions per-memory ('expired' for TTL, 'archived' for decay)", () => {
    expect(src).toMatch(/'expired'/);
    expect(src).toMatch(/'archived'/);
    expect(src).toMatch(/insert into public\.hq_memory_events/i);
  });
});

// =====================================================================
// 5. §10 eviction — durable company-brain classes are STRUCTURALLY un-evictable
// =====================================================================

describe("memory lifecycle — eviction never touches the durable company brain", () => {
  const src = fnSource("hq_memory_archive");

  it("archives ONLY working/episodic, however it is called", () => {
    expect(src).toMatch(/memory_class in \('working', 'episodic'\)/i);
    expect(src).toMatch(/status = 'active'/i); // idempotent
  });

  it("audits the eviction and never broadcasts it on The Pulse", () => {
    expect(src).toMatch(/'archived'/);
    expect(src).not.toMatch(/hq_emit_event/i);
  });
});

// =====================================================================
// 6. §9.2 consolidation — autonomous, gated, private, ≥3 sources, deterministic
// =====================================================================

describe("memory lifecycle — consolidation is a gated, private, deterministic write", () => {
  const src = fnSource("hq_memory_consolidate");

  it("is fail-dark on the kill-switch (no autonomous company-brain write when off)", () => {
    expect(src).toMatch(/if not public\.hq_memory_lifecycle_enabled\(\)/i);
  });

  it("no-ops below MIN_CONSOLIDATION_SOURCES (noise, not a pattern)", () => {
    expect(src).toMatch(/coalesce\(v_count, 0\) < 3/i);
    expect(src).toMatch(/return null/i);
  });

  it("creates ONE private, owner-scoped long_term lesson (autonomous per §6)", () => {
    expect(src).toMatch(/'long_term'/);
    expect(src).toMatch(/'private'/);
    expect(src).toMatch(/insert into public\.hq_memories/i);
  });

  it("preserves sources — links consolidated_into, never archives them", () => {
    expect(src).toMatch(/set consolidated_into = v_new_id/i);
    expect(src).not.toMatch(/status\s*=\s*'archived'/i);
    expect(src).not.toMatch(/status\s*=\s*'superseded'/i);
  });

  it("snapshots a version and audits authorship + each source's consolidation", () => {
    expect(src).toMatch(/insert into public\.hq_memory_versions/i);
    expect(src).toMatch(/'consolidated'/);
  });
});

// =====================================================================
// 7. §9.3 dedup — keeper rule MIRRORS chooseDedupeKeeper, scoped + index-backed
// =====================================================================

describe("memory lifecycle — deduplication detection", () => {
  const src = fnSource("hq_memory_dedupe_pairs");

  it("probes the vector index with the schema-qualified cosine operator", () => {
    expect(src).toMatch(/OPERATOR\(public\.<=>\)/);
  });

  it("only compares co-scoped, same-model-space vectors (never cross-scope)", () => {
    expect(src).toMatch(/m2\.memory_type = s\.memory_type/i);
    expect(src).toMatch(/m2\.visibility = s\.visibility/i);
    expect(src).toMatch(/m2\.owner_employee_id is not distinct from s\.owner_employee_id/i);
    expect(src).toMatch(/m2\.embedding_version = s\.embedding_version/i);
    expect(src).toMatch(/m2\.embedding_dimension = s\.embedding_dimension/i);
  });

  it("keeper rule == chooseDedupeKeeper: confidence, then latest, then smaller id", () => {
    expect(src).toMatch(/a_conf > b_conf/i);
    expect(src).toMatch(/a_created > b_created/i);
    expect(src).toMatch(/least\(a_id::text, b_id::text\)/i);
  });

  it("only pairs above the cosine threshold qualify", () => {
    expect(src).toMatch(/cos_sim > coalesce\(p_threshold, 0\.95\)/i);
  });
});

// =====================================================================
// 8. §9.3 supersession — reversible, idempotent, relinks, emits the verb
// =====================================================================

describe("memory lifecycle — supersession is reversible + idempotent", () => {
  const src = fnSource("hq_memory_supersede");

  it("is idempotent — only an active drop is superseded", () => {
    expect(src).toMatch(/m\.id = p_drop_id\s+and m\.status = 'active'/i);
    expect(src).toMatch(/'drop_not_active'/i);
  });

  it("refuses a non-active keeper", () => {
    expect(src).toMatch(/'keeper_not_active'/i);
  });

  it("relinks inbound references + consolidated_into pointers to the keeper", () => {
    expect(src).toMatch(/update public\.hq_memory_relationships\s+set entity_id = p_keep_id/i);
    expect(src).toMatch(/set consolidated_into = p_keep_id/i);
  });

  it("records a reversible lineage edge + a version snapshot of the drop", () => {
    expect(src).toMatch(/'superseded_by'/i);
    expect(src).toMatch(/insert into public\.hq_memory_versions/i);
  });
});

// =====================================================================
// 9. §9.1 summarisation — needsSummary twin (detection) + safe apply
// =====================================================================

describe("memory lifecycle — summarisation primitives", () => {
  it("the candidate scan is the SQL twin of needsSummary", () => {
    const src = fnSource("hq_memory_summary_candidates");
    expect(src).toMatch(/char_length\(coalesce\(m\.body, ''\)\) >= 1200/i);
    expect(src).toMatch(/char_length\(coalesce\(m\.summary, ''\)\) = 0/i);
    expect(src).toMatch(/>= char_length\(coalesce\(m\.body, ''\)\) \* 0\.6/i);
  });

  it("set_summary refuses an empty summary and is status-guarded + snapshotted", () => {
    const src = fnSource("hq_memory_set_summary");
    expect(src).toMatch(/'empty_summary'/i);
    expect(src).toMatch(/m\.status = 'active'/i);
    expect(src).toMatch(/insert into public\.hq_memory_versions/i);
    expect(src).toMatch(/'summarised'/);
  });
});

// =====================================================================
// 10. Event discipline — exactly TWO Pulse verbs, both registered; the
//     mechanical maintenance engines broadcast NOTHING
// =====================================================================

describe("memory lifecycle — the right things (and only those) hit The Pulse", () => {
  it("emits ONLY memory.asserted (consolidation) + memory.superseded (dedup)", () => {
    const verbs = new Set(
      [...exec.matchAll(/'(memory\.[a-z_]+)'/g)].map((m) => m[1]),
    );
    expect(verbs).toEqual(new Set(["memory.asserted", "memory.superseded"]));
  });

  it("both emitted verbs are REGISTERED in the event spine", () => {
    for (const v of ["memory.asserted", "memory.superseded"]) {
      expect(isVerb(v), `${v} must be registered`).toBe(true);
      expect(new Set<string>(VERB_GROUPS.memory).has(v)).toBe(true);
    }
  });

  it("goes through the validated entry point, never a raw hq_events INSERT", () => {
    expect(exec).toMatch(/perform public\.hq_emit_event\(/i);
    expect(exec).not.toMatch(/insert into public\.hq_events/i);
  });

  it("mechanical maintenance (expire/archive/summarise) emits nothing on The Pulse", () => {
    expect(fnSource("hq_memory_expire_sweep")).not.toMatch(/hq_emit_event/i);
    expect(fnSource("hq_memory_archive")).not.toMatch(/hq_emit_event/i);
    expect(fnSource("hq_memory_set_summary")).not.toMatch(/hq_emit_event/i);
  });
});

// =====================================================================
// 11. No external AI call ever runs inside a SQL transaction (CEO rule)
// =====================================================================

describe("memory lifecycle — no external AI call inside Postgres", () => {
  it("the SQL never reaches out to a model provider (the worker does, in TS)", () => {
    expect(exec).not.toMatch(/\bopenai\b/i);
    expect(exec).not.toMatch(/\banthropic\b/i);
    expect(exec).not.toMatch(/\bhttp\b/i);
    expect(exec).not.toMatch(/pg_net|net\.http|extensions\.http/i);
  });
});

// =====================================================================
// 12. Function hardening — SECURITY DEFINER + pinned empty search_path
// =====================================================================

describe("memory lifecycle — every function is hardened", () => {
  for (const fn of LIFECYCLE_FNS) {
    it(`${fn} is SECURITY DEFINER with an empty search_path`, () => {
      const header = fnHeader(fn);
      expect(header).toMatch(/security definer/i);
      expect(header).toMatch(/set search_path = ''/i);
    });
  }
});

// =====================================================================
// 13. Privilege model — service_role-only (L-4), never a JWT role
// =====================================================================

describe("memory lifecycle — EXECUTE granted only to service_role", () => {
  for (const fn of LIFECYCLE_FNS) {
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

// =====================================================================
// 14. The kill-switch gate is fail-dark (defaults OFF on a missing key)
// =====================================================================

describe("memory lifecycle — the gate fails dark", () => {
  it("hq_memory_lifecycle_enabled defaults to false on a missing key", () => {
    const src = fnSource("hq_memory_lifecycle_enabled");
    expect(src).toMatch(/coalesce\(/i);
    expect(src).toMatch(/memory_lifecycle,worker_enabled/i);
    expect(src).toMatch(/false\s*\)/i);
  });
});

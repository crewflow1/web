import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { VERB_GROUPS, isVerb } from "@/lib/events/registry";

/**
 * Shared Memory — AI recall-path invariants (Volume X §7/§8/§12; Directive
 * 009 Module 1, PR3).
 *
 * CI has no database in this tier (the live behaviour is proven in the
 * integration tier), so — exactly like the spine + write invariant suites —
 * we pin the `hq_memory_recall` migration's security contract against its
 * source text. These are the assertions that, if they ever silently flipped,
 * would be a hole: recall returning a row an employee may not read, the
 * permission filter degrading from a stage-1 WHERE into a post-filter, system
 * memory becoming recallable, a read that broadcasts on The Pulse (it must
 * not — there is no recall verb), pgvector waking up early, a JWT-callable
 * engine primitive, an un-hardened SECURITY DEFINER function, or a migration
 * that stopped being additive/dark.
 *
 * The load-bearing checks run over `exec` (executable SQL with `--` comments
 * stripped) so the prose that documents the contract can't satisfy a positive
 * match or trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG_REL = "supabase/migrations/20260724000000_hq_memory_recall.sql";
const mig = read(MIG_REL);

// Strip SQL line comments (-- … EOL) so assertions test the EXECUTABLE
// statements, not the prose that documents the read contract.
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

// =====================================================================
// 0. The migration ships
// =====================================================================

describe("memory recall — migration is present", () => {
  it("the PR3 AI recall-path migration exists", () => {
    expect(existsSync(resolve(ROOT, MIG_REL))).toBe(true);
  });
});

// =====================================================================
// 1. Additive & dark — no destructive change
// =====================================================================

describe("memory recall — the migration is additive and dark", () => {
  it("drops or retypes nothing (production-safe)", () => {
    expect(exec).not.toMatch(/drop\s+(table|column|function|index)/i);
    expect(exec).not.toMatch(/alter\s+table[\s\S]*?drop\s+/i);
  });

  it("adds ONLY the two engine functions (no schema mutation, no seed)", () => {
    expect(exec).toMatch(/create or replace function public\.hq_memory_recall\(/i);
    expect(exec).toMatch(/create or replace function public\.hq_memory_reinforce\(/i);
    expect(exec).not.toMatch(/create table/i);
    expect(exec).not.toMatch(/alter table/i);
  });
});

// =====================================================================
// 2. §6 — the permission filter runs IN SQL, BEFORE scoring (stage 1)
// =====================================================================

describe("memory recall — the §6 read rules are enforced in SQL", () => {
  const src = fnSource("hq_memory_recall");

  it("resolves the employee's department from ai_employees (drives §6)", () => {
    expect(src).toMatch(/from public\.ai_employees/i);
    expect(src).toMatch(/e\.department\s+into\s+v_dept/i);
  });

  it("mirrors canEmployeeAccess: public_hq, owner, department, and grant branches", () => {
    expect(src).toMatch(/m\.visibility = 'public_hq'/i);
    expect(src).toMatch(/m\.owner_employee_id\s*=\s*p_employee_id/i);
    expect(src).toMatch(/m\.visibility = 'department'[\s\S]*?m\.department\s*=\s*v_dept/i);
    expect(src).toMatch(/from public\.hq_memory_access_grants/i);
    expect(src).toMatch(/grantee_type = 'employee'[\s\S]*?grantee_value = p_employee_id::text/i);
  });

  it("NEVER recalls system memory — ownership widens ONLY {department,private,restricted}", () => {
    // canEmployeeAccess returns false for `system` EVEN TO THE OWNER. The old
    // version of this gate only checked the literal 'system' was absent — but an
    // UNCONDITIONAL ownership branch (`or (m.owner_employee_id = caller)`) recalls
    // owned system memory WITHOUT ever naming 'system', so the literal check gave
    // false confidence. We now pin the structure instead.
    //
    // (a) the source never lists 'system' as a permitted branch:
    expect(src).not.toMatch(/'system'/);
    // (b) the stage-1 ownership clause is visibility-scoped to exactly the three
    //     owner-widenable visibilities (mirrors canEmployeeAccess):
    expect(src).toMatch(
      /m\.visibility in \('department',\s*'private',\s*'restricted'\)\s+and\s+m\.owner_employee_id is not null and m\.owner_employee_id = p_employee_id/i,
    );
    // (c) there is NO bare ownership branch — i.e. no `or (m.owner_employee_id …)`
    //     opening a permission group unguarded by a visibility scope. This is the
    //     exact shape of the leak; the working/episodic STAGE-2 relevance clause
    //     opens with `(m.memory_class …`, so it is unaffected by this guard.
    expect(src).not.toMatch(/or\s*\(\s*m\.owner_employee_id\b/i);
  });

  it("permission is a WHERE filter, not a post-filter (relevance comes AFTER it)", () => {
    const permIdx = src.indexOf("STAGE 1".toLowerCase()) >= 0 ? 0 : src.search(/m\.visibility = 'public_hq'/i);
    const relevanceIdx = src.search(/m\.search_tsv @@ v_query/i);
    expect(permIdx).toBeGreaterThanOrEqual(0);
    expect(relevanceIdx).toBeGreaterThan(permIdx);
  });
});

// =====================================================================
// 3. The split — SQL returns RAW candidates; it never computes the score
// =====================================================================

describe("memory recall — returns raw candidate signals, ranks in the pure lib", () => {
  const src = fnSource("hq_memory_recall");

  it("returns a bounded candidate set as jsonb (not a single assembled blob)", () => {
    expect(fnHeader("hq_memory_recall")).toMatch(/returns jsonb/i);
    expect(src).toMatch(/limit v_limit/i);
    expect(src).toMatch(/jsonb_agg\(jsonb_build_object\(/i);
  });

  it("ships RAW signals (ts_rank, structural_match, token estimates) for the pure scorer", () => {
    expect(src).toMatch(/'ts_rank',\s*l_rank/i);
    expect(src).toMatch(/'structural_match',\s*s_match/i);
    expect(src).toMatch(/'body_tokens'/i);
    expect(src).toMatch(/'summary_tokens'/i);
  });

  it("does NOT compute the blended §7.3 score in SQL (that lives in lib/memory/retrieval.ts)", () => {
    // No weight constants / scorer leaked into SQL — the coarse pre-rank only
    // chooses the top candidates; the authoritative score is computed in TS.
    expect(src).not.toMatch(/scorecandidate/i);
    expect(src).not.toMatch(/w_sem|w_lex|weights/i);
  });

  it("never ships the body, the search vector, or the reserved embedding column", () => {
    expect(src).not.toMatch(/to_jsonb\s*\(/i); // never dumps a whole row
    expect(src).not.toMatch(/'body'\s*,/i); // a token estimate ships, never the body
    expect(src).not.toMatch(/embedding_placeholder/i);
    expect(src).not.toMatch(/search_tsv'/i); // tsvector is read for ranking, never returned
  });
});

// =====================================================================
// 4. Reads do NOT broadcast — no Pulse verb (the registry has none)
// =====================================================================

describe("memory recall — reads are audited per-memory, NEVER on The Pulse", () => {
  it("recall + reinforce emit NOTHING on the event spine", () => {
    expect(exec).not.toMatch(/hq_emit_event/i);
    expect(exec).not.toMatch(/insert into public\.hq_events/i);
    expect(exec).not.toMatch(/'memory\.[a-z_]+'/i); // no event verb literal at all
  });

  it("the registry has NO recall verb — the design, pinned against source of truth", () => {
    expect(isVerb("memory.read")).toBe(false);
    expect(isVerb("memory.recalled")).toBe(false);
    const memory = new Set<string>(VERB_GROUPS.memory);
    expect(memory.has("memory.read")).toBe(false);
    expect(memory.has("memory.recalled")).toBe(false);
    // memory.asserted (the WRITE verb) is the only registered memory write verb.
    expect(isVerb("memory.asserted")).toBe(true);
  });

  it("reinforce records the AI read per-memory (ai_accessed) and reinforces decay", () => {
    const src = fnSource("hq_memory_reinforce");
    expect(src).toMatch(/insert into public\.hq_memory_events/i);
    expect(src).toMatch(/'ai_accessed'/);
    expect(src).toMatch(/last_reinforced_at\s*=\s*now\(\)/i);
    expect(src).toMatch(/access_count\s*=\s*access_count\s*\+\s*1/i);
  });
});

// =====================================================================
// 5. Embeddings are a PLUG-IN — the seam is present, pgvector stays dormant
// =====================================================================

describe("memory recall — the embedding seam exists but pgvector is dormant", () => {
  it("exposes the stable query-embedding parameter as a plain float8[] (no extension)", () => {
    expect(exec).toMatch(/p_query_embedding\s+float8\[\]/i);
  });

  it("does NOT enable pgvector, reference the vector type, or cast the seam yet (PR4)", () => {
    expect(exec).not.toMatch(/create\s+extension[\s\S]*?vector/i);
    expect(exec).not.toMatch(/\bvector\b/i); // no vector type anywhere in executable SQL
    expect(exec).not.toMatch(/p_query_embedding::/i); // PR4 casts it; PR3 ignores it
  });
});

// =====================================================================
// 6. Function hardening — SECURITY DEFINER + pinned empty search_path
// =====================================================================

describe("memory recall — the functions are hardened", () => {
  for (const fn of ["hq_memory_recall", "hq_memory_reinforce"]) {
    it(`${fn} is SECURITY DEFINER with an empty search_path`, () => {
      const header = fnHeader(fn);
      expect(header).toMatch(/security definer/i);
      expect(header).toMatch(/set search_path = ''/i);
    });
  }
});

// =====================================================================
// 7. Privilege model — service_role-only (L-4), never a JWT role
// =====================================================================

describe("memory recall — EXECUTE revoked from JWT roles, granted only to service_role", () => {
  it("revokes both functions from public, anon AND authenticated", () => {
    expect(exec).toMatch(
      /revoke all on function\s+public\.hq_memory_recall\([\s\S]*?\)\s*from public, anon, authenticated/i,
    );
    expect(exec).toMatch(
      /revoke all on function\s+public\.hq_memory_reinforce\([\s\S]*?\)\s*from public, anon, authenticated/i,
    );
  });

  it("grants execute on both functions only to service_role", () => {
    expect(exec).toMatch(
      /grant execute on function\s+public\.hq_memory_recall\([\s\S]*?\)\s*to service_role/i,
    );
    expect(exec).toMatch(
      /grant execute on function\s+public\.hq_memory_reinforce\([\s\S]*?\)\s*to service_role/i,
    );
  });

  it("never grants EXECUTE/privilege to a JWT role (anon/authenticated/public)", () => {
    expect(exec).not.toMatch(/\bto\s+anon\b/i);
    expect(exec).not.toMatch(/\bto\s+authenticated\b/i);
    expect(exec).not.toMatch(/grant[\s\S]*?\bto\s+public\b/i);
  });
});

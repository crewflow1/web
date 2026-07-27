import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { VERB_GROUPS, isVerb } from "@/lib/events/registry";

/**
 * Shared Memory — the SEMANTIC (ANN) recall channel invariants
 * (Volume X §7/§16; CEO Directive 009 Module 1, PR4d).
 *
 * PR3 shipped `hq_memory_recall` with the semantic stage dormant; PR4b lit
 * pgvector up; THIS migration (20260726000000) connects them — it turns the
 * semantic channel on INSIDE recall without moving the permission boundary and
 * without changing the SDK call shape. CI has no database in this tier (the
 * live behaviour is proven in the integration tier), so — exactly like the PR3
 * recall suite and the PR4b embedding suite — we pin the migration's security
 * contract against its source text. These are the assertions that, if they ever
 * silently flipped, would be a hole:
 *
 *   - the semantic channel surfacing a memory the employee may not read (the §6
 *     permission predicate must guard BOTH the lexical AND the ANN candidate
 *     sources — there are two copies and both must be present);
 *   - the ANN probe being routed through a CTE/join (which would defeat the HNSW
 *     index — it must select from the base table and order by distance there);
 *   - a cross-model comparison (the cosine operator must only ever see vectors
 *     of the query's exact version AND dimension);
 *   - the cosine type/operator resolving unqualified under `search_path=''`
 *     (must be `public.vector` / `OPERATOR(public.<=>)`);
 *   - the body / tsvector / raw embedding leaking into the projection;
 *   - a read that broadcasts on The Pulse (there is no recall verb);
 *   - the signature evolution dropping anything other than the one function it
 *     recreates, or turning destructive;
 *   - a JWT-callable engine primitive, or an un-hardened SECURITY DEFINER fn.
 *
 * The load-bearing checks run over `exec` (executable SQL with `--` comments
 * stripped) so the prose that documents the contract can't satisfy a positive
 * match or trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG_REL = "supabase/migrations/20260726000000_hq_memory_recall_ann.sql";
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

/** Count non-overlapping matches of a global regex in the executable SQL. */
function count(re: RegExp): number {
  const m = exec.match(re);
  return m ? m.length : 0;
}

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

describe("memory recall ANN — migration is present", () => {
  it("the PR4d semantic recall migration exists", () => {
    expect(existsSync(resolve(ROOT, MIG_REL))).toBe(true);
  });
});

// =====================================================================
// 1. Signature evolution — drop the 7-arg, recreate an 8-arg superset
// =====================================================================

describe("memory recall ANN — a scoped, non-destructive signature evolution", () => {
  it("drops NOTHING but the one recall function it immediately recreates", () => {
    // No data structures are ever dropped or mutated — this is additive.
    expect(exec).not.toMatch(/drop\s+(table|column|index|type|schema)/i);
    expect(exec).not.toMatch(/alter\s+table/i);
    expect(exec).not.toMatch(/create table/i);
    expect(exec).not.toMatch(/truncate/i);
    // Exactly one DROP FUNCTION, and it targets hq_memory_recall.
    expect(count(/drop function/gi)).toBe(1);
    expect(exec).toMatch(/drop function if exists public\.hq_memory_recall\(/i);
    // hq_memory_reinforce (PR3) is left entirely untouched here.
    expect(exec).not.toMatch(/drop function[\s\S]*?hq_memory_reinforce/i);
    expect(exec).not.toMatch(/create or replace function public\.hq_memory_reinforce/i);
  });

  it("drops the EXACT PR3 7-arg signature (so the new 8-arg fn is unambiguous)", () => {
    expect(exec).toMatch(
      /drop function if exists public\.hq_memory_recall\(\s*uuid,\s*text,\s*float8\[\],\s*text,\s*text,\s*text\[\],\s*integer\s*\)/i,
    );
  });

  it("recreates hq_memory_recall with a trailing p_query_version text default null", () => {
    const header = fnHeader("hq_memory_recall");
    expect(header).toMatch(/p_query_version\s+text\s+default null/i);
    // The new parameter is LAST (PR3-era 7-arg calls still resolve by default).
    expect(header).toMatch(/p_limit\s+integer\s+default 48[\s\S]*?p_query_version\s+text\s+default null/i);
    expect(fnHeader("hq_memory_recall")).toMatch(/returns jsonb/i);
  });
});

// =====================================================================
// 2. §6 permission filter — IN SQL, BEFORE distance, in BOTH channels
// =====================================================================

describe("memory recall ANN — the §6 read rules guard BOTH candidate sources", () => {
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

  it("applies the permission predicate in BOTH the lexical AND the semantic source", () => {
    // The whole point of PR4d's design: the §6 predicate is duplicated inline
    // into the base-table ANN scan, so a non-permitted row is never a candidate
    // in EITHER channel. Both copies must be present (kept textually in sync).
    expect(count(/m\.visibility = 'public_hq'/gi)).toBeGreaterThanOrEqual(2);
    expect(count(/from public\.hq_memory_access_grants/gi)).toBeGreaterThanOrEqual(2);
  });

  it("NEVER recalls system memory — ownership is visibility-scoped in BOTH channels", () => {
    // Same hardening as the PR3 gate (an unconditional ownership branch leaks
    // owned `system` memory without ever naming the literal), but PR4 carries TWO
    // inline copies of the §6 predicate — lexical AND semantic. So the leak shape
    // must be absent everywhere, and the visibility-scoped owner clause must
    // appear in BOTH copies (kept textually in sync).
    expect(src).not.toMatch(/'system'/);
    expect(
      count(
        /m\.visibility in \('department',\s*'private',\s*'restricted'\)\s+and\s+m\.owner_employee_id is not null and m\.owner_employee_id = p_employee_id/gi,
      ),
    ).toBeGreaterThanOrEqual(2);
    expect(src).not.toMatch(/or\s*\(\s*m\.owner_employee_id\b/i);
  });

  it("permission is enforced BEFORE the cosine distance order-by (not a post-filter)", () => {
    // In the semantic CTE the §6 WHERE must precede `order by ... <=>`, so the
    // ANN probe can only ever rank rows the employee may already read.
    const grantsIdx = src.search(/from public\.hq_memory_access_grants/i);
    const distanceIdx = src.search(/order by\s+m\.embedding\s+OPERATOR\(public\.<=>\)/i);
    expect(grantsIdx).toBeGreaterThanOrEqual(0);
    expect(distanceIdx).toBeGreaterThan(grantsIdx);
  });
});

// =====================================================================
// 3. The ANN probe — base-table scan, HNSW-backed, additive UNION
// =====================================================================

describe("memory recall ANN — the probe is index-backed and purely additive", () => {
  const src = fnSource("hq_memory_recall");

  it("orders by cosine distance on the BASE table (so the HNSW index applies)", () => {
    // The ANN candidate set selects from public.hq_memories directly and orders
    // by distance there — NOT through a CTE/join, which would defeat the index.
    expect(src).toMatch(
      /semantic as \(\s*select m\.id\s*from public\.hq_memories m/i,
    );
    expect(src).toMatch(/order by\s+m\.embedding\s+OPERATOR\(public\.<=>\)\s+v_qvec\s+limit\s+v_sem_k/i);
  });

  it("UNIONs lexical + semantic candidates — semantic never narrows the set", () => {
    expect(src).toMatch(/select id from lexical\s+union\s+select id from semantic/i);
  });

  it("arms the semantic channel ONLY with a query embedding AND its version", () => {
    // The plug-in contract: no version ⇒ no safe single-model comparison ⇒
    // semantic OFF, recall degrades to lexical + structural.
    expect(src).toMatch(/v_semantic\s*:=\s*p_query_embedding is not null/i);
    expect(src).toMatch(/and p_query_version is not null/i);
    // The ANN CTE itself is short-circuited by the armed flag.
    expect(src).toMatch(/semantic as \([\s\S]*?where v_semantic/i);
  });
});

// =====================================================================
// 4. pgvector is schema-qualified (resolves under search_path='')
// =====================================================================

describe("memory recall ANN — the vector type + operator are schema-qualified", () => {
  it("declares the query vector as public.vector and casts via ::public.vector", () => {
    expect(exec).toMatch(/v_qvec\s+public\.vector/i);
    expect(exec).toMatch(/p_query_embedding::real\[\]::public\.vector/i);
  });

  it("uses OPERATOR(public.<=>) for cosine distance — never a bare operator", () => {
    // Every `<=>` must be the schema-qualified OPERATOR(public.<=>) form, or it
    // would not resolve with an empty search_path.
    expect(count(/<=>/g)).toBeGreaterThan(0);
    expect(count(/<=>/g)).toBe(count(/OPERATOR\(public\.<=>\)/gi));
  });

  it("never references an UNqualified vector type (would fail at runtime)", () => {
    // `::public.vector` is fine; a bare `::vector` is not.
    expect(exec).not.toMatch(/::vector\b/i);
    // Every executable `vector` token belongs to `public.vector`.
    expect(count(/\bvector\b/gi)).toBe(count(/public\.vector\b/gi));
  });
});

// =====================================================================
// 5. Version isolation — one model's space, equal dimension, never mixed
// =====================================================================

describe("memory recall ANN — vectors are compared only within one model space", () => {
  const src = fnSource("hq_memory_recall");

  it("filters the ANN candidates to the query's exact version AND dimension", () => {
    expect(src).toMatch(/m\.embedding_version\s*=\s*p_query_version/i);
    expect(src).toMatch(/m\.embedding_dimension\s*=\s*v_qdim/i);
    expect(src).toMatch(/m\.embedding is not null/i);
  });

  it("computes cos_sim under the SAME version+dimension guard (CASE short-circuit)", () => {
    // The cosine operator must never run on a mismatched-dimension row, so the
    // cos_sim CASE re-checks version + dimension before evaluating `<=>`.
    expect(src).toMatch(
      /case when v_semantic[\s\S]*?embedding_version\s*=\s*p_query_version[\s\S]*?embedding_dimension\s*=\s*v_qdim[\s\S]*?<=>[\s\S]*?else null end as cos_sim/i,
    );
    // Both the candidate filter AND the cos_sim CASE check the version.
    expect(count(/embedding_version\s*=\s*p_query_version/gi)).toBeGreaterThanOrEqual(2);
  });

  it("derives the query dimension from the array, not a hard-coded 1536", () => {
    expect(src).toMatch(/v_qdim\s*:=\s*array_length\(p_query_embedding,\s*1\)/i);
  });
});

// =====================================================================
// 6. The split — SQL ships RAW signals incl. cos_sim, never the body/vector
// =====================================================================

describe("memory recall ANN — returns raw signals; never the body, tsv, or vector", () => {
  const src = fnSource("hq_memory_recall");

  it("ships cos_sim alongside the PR3 raw signals for the pure scorer", () => {
    expect(src).toMatch(/'cos_sim',\s*cos_sim/i);
    expect(src).toMatch(/'ts_rank',\s*l_rank/i);
    expect(src).toMatch(/'structural_match',\s*s_match/i);
    expect(src).toMatch(/'body_tokens'/i);
    expect(src).toMatch(/'summary_tokens'/i);
  });

  it("does NOT compute the blended §7.3 score in SQL (that lives in the pure lib)", () => {
    expect(src).not.toMatch(/scorecandidate/i);
    expect(src).not.toMatch(/w_sem|w_lex|weights/i);
  });

  it("never ships the body, the search vector, or the raw embedding column", () => {
    expect(src).not.toMatch(/to_jsonb\s*\(/i); // never dumps a whole row
    expect(src).not.toMatch(/'body'\s*,/i); // a token estimate ships, never the body
    expect(src).not.toMatch(/'search_tsv'/i); // tsvector is read for ranking, never returned
    expect(src).not.toMatch(/'embedding'\s*,/i); // the vector itself is never returned
  });

  it("returns a bounded candidate set as jsonb (not one assembled blob)", () => {
    expect(fnHeader("hq_memory_recall")).toMatch(/returns jsonb/i);
    expect(src).toMatch(/limit v_limit/i);
    expect(src).toMatch(/jsonb_agg\(jsonb_build_object\(/i);
  });
});

// =====================================================================
// 7. Reads do NOT broadcast — no Pulse verb (the registry has none)
// =====================================================================

describe("memory recall ANN — recall stays silent on The Pulse", () => {
  it("emits nothing on the event spine and writes no row", () => {
    expect(exec).not.toMatch(/hq_emit_event/i);
    expect(exec).not.toMatch(/insert into/i);
    expect(exec).not.toMatch(/'memory\.[a-z_]+'/i); // no event verb literal at all
  });

  it("the registry still has NO recall verb — pinned against source of truth", () => {
    expect(isVerb("memory.read")).toBe(false);
    expect(isVerb("memory.recalled")).toBe(false);
    const memory = new Set<string>(VERB_GROUPS.memory);
    expect(memory.has("memory.read")).toBe(false);
    expect(memory.has("memory.recalled")).toBe(false);
    expect(isVerb("memory.asserted")).toBe(true);
  });
});

// =====================================================================
// 8. Function hardening — SECURITY DEFINER + pinned empty search_path
// =====================================================================

describe("memory recall ANN — the function is hardened", () => {
  it("hq_memory_recall is SECURITY DEFINER with an empty search_path", () => {
    const header = fnHeader("hq_memory_recall");
    expect(header).toMatch(/security definer/i);
    expect(header).toMatch(/set search_path = ''/i);
    expect(header).toMatch(/\bstable\b/i);
  });
});

// =====================================================================
// 9. Privilege model — service_role-only (L-4), never a JWT role
// =====================================================================

describe("memory recall ANN — EXECUTE revoked from JWT roles, granted only to service_role", () => {
  it("revokes the NEW 8-arg signature from public, anon AND authenticated", () => {
    expect(exec).toMatch(
      /revoke all on function\s+public\.hq_memory_recall\(\s*uuid,\s*text,\s*float8\[\],\s*text,\s*text,\s*text\[\],\s*integer,\s*text\s*\)\s*from public, anon, authenticated/i,
    );
  });

  it("grants execute on the NEW 8-arg signature only to service_role", () => {
    expect(exec).toMatch(
      /grant execute on function\s+public\.hq_memory_recall\(\s*uuid,\s*text,\s*float8\[\],\s*text,\s*text,\s*text\[\],\s*integer,\s*text\s*\)\s*to service_role/i,
    );
  });

  it("never grants EXECUTE/privilege to a JWT role (anon/authenticated/public)", () => {
    expect(exec).not.toMatch(/\bto\s+anon\b/i);
    expect(exec).not.toMatch(/\bto\s+authenticated\b/i);
    expect(exec).not.toMatch(/grant[\s\S]*?\bto\s+public\b/i);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The Pulse — security invariants (Module 1, PR5 / CEO Directive #005).
 *
 * CI has no database in this tier (the live projection/replay is proven in the
 * integration tier), so — exactly like the PR1–PR4 spine suites — we pin the
 * read-model's SECURITY contract against its source text. These are the
 * assertions that, if they ever silently flipped, would be a hole:
 *   • the projection readable by a JWT client (anon/authenticated);
 *   • a timeline reader/writer callable by a JWT client, or with an unpinned
 *     search_path, or via dynamic SQL (an escalation surface);
 *   • a NON-idempotent apply (replay would duplicate rows);
 *   • an UNBOUNDED page scan (a caller asking for the whole table);
 *   • the CQRS rule broken: the read side reading hq_events (the truth log)
 *     directly, or reaching the projection table outside its granted RPCs;
 *   • the HQ gate (requireHqPage / requireHqApi) missing from the surface, or
 *     answering 403 (announcing itself) instead of 404.
 *
 * The migration checks run over `exec` (executable SQL with `--` comments
 * stripped); the TS checks run over `code` (TS source with // and block comments
 * stripped) — so the prose that DOCUMENTS the contract can never satisfy a
 * positive match or trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// Strip SQL line comments (-- … EOL).
function execOf(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

// Strip TS block + line comments so a negative match can't be tripped by prose
// in a doc comment (e.g. a header that NAMES hq_events while describing the rule).
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const MIG_REL = "supabase/migrations/20260720040000_hq_timeline_projection.sql";
const mig = read(MIG_REL);
const exec = execOf(mig);

/** The header of a CREATE FUNCTION (signature → `as $$`), where the hardening lives. */
function fnHeader(name: string): string {
  const start = exec.indexOf(`create or replace function public.${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const bodyAt = exec.indexOf("as $$", start);
  expect(bodyAt, `function ${name} body not found`).toBeGreaterThan(start);
  return exec.slice(start, bodyAt);
}

// The five functions this migration creates or replaces — the entire read+write
// API surface of the projection. (apply is REPLACED to add the timeline branch.)
const FUNCTIONS = [
  "hq_consumer_apply",
  "hq_timeline_reset",
  "hq_timeline_page",
  "hq_timeline_event",
  "hq_timeline_facets",
] as const;

// =====================================================================
// 0. The migration ships
// =====================================================================

describe("pulse — migration is present", () => {
  it("the PR5 timeline projection migration exists", () => {
    expect(existsSync(resolve(ROOT, MIG_REL))).toBe(true);
  });
});

// =====================================================================
// 1. Projection shape — idempotency anchor + generated columns
// =====================================================================

describe("pulse — hq_timeline projection contract", () => {
  it("event_id is the PRIMARY KEY — the idempotency anchor replay relies on", () => {
    expect(exec).toMatch(/create table if not exists public\.hq_timeline/i);
    expect(exec).toMatch(/event_id\s+bigint\s+primary key/i);
  });

  it("namespace is GENERATED from the verb prefix (meaning stays in TS, no migration to re-home)", () => {
    expect(exec).toMatch(
      /namespace\s+text\s+generated always as \(split_part\(verb, '\.', 1\)\) stored/i,
    );
  });

  it("search is a GENERATED, weighted tsvector (identifiers rank above buried payload JSON)", () => {
    expect(exec).toMatch(/search\s+tsvector\s+generated always as/i);
    expect(exec).toMatch(/setweight\(to_tsvector\('english',[\s\S]*?\), 'a'\)/i);
    expect(exec).toMatch(/setweight\(to_tsvector\('english', coalesce\(payload::text, ''\)\), 'd'\)/i);
  });
});

// =====================================================================
// 2. RLS:hq — the projection is service-role only (RLS on, ZERO policies)
// =====================================================================

describe("pulse — the projection is RLS:hq with no JWT reader", () => {
  it("enables row level security on hq_timeline", () => {
    expect(exec).toMatch(/alter table public\.hq_timeline enable row level security/i);
  });

  it("declares NO policies — service_role (BYPASSRLS) is the only reader", () => {
    expect(exec).not.toMatch(/create policy/i);
  });
});

// =====================================================================
// 3. Idempotent apply — replay/redelivery must be a no-op (no dup rows)
// =====================================================================

describe("pulse — the timeline apply branch is idempotent", () => {
  it("upserts ON CONFLICT (event_id) DO NOTHING (re-apply + replay are no-ops)", () => {
    expect(exec).toMatch(
      /when 'timeline' then[\s\S]*?insert into public\.hq_timeline[\s\S]*?on conflict \(event_id\) do nothing/i,
    );
  });

  it("uses STATIC dispatch — no dynamic EXECUTE anywhere (no escalation surface)", () => {
    expect(exec).not.toMatch(/\bexecute\s+format\(/i);
    expect(exec).not.toMatch(/\bexecute\s+'/i);
  });
});

// =====================================================================
// 4. Bounded reads — the feed can never ask for an unbounded scan
// =====================================================================

describe("pulse — the feed read is bounded + keyset-paged", () => {
  it("clamps the page limit to [1, 200] (a caller can't request the whole table)", () => {
    expect(exec).toMatch(/greatest\(least\(coalesce\(p_limit, 50\), 200\), 1\)/i);
  });

  it("paginates by strict keyset on (ts, event_id), newest-first", () => {
    expect(exec).toMatch(/\(t\.ts, t\.event_id\) < \(p_before_ts, p_before_id\)/i);
    expect(exec).toMatch(/order by t\.ts desc, t\.event_id desc/i);
  });
});

// =====================================================================
// 5. The projection is disposable — reset = truncate + replay from 0
// =====================================================================

describe("pulse — the projection is a disposable view of the spine", () => {
  it("hq_timeline_reset truncates the projection and rewinds the consumer to 0", () => {
    expect(exec).toMatch(/truncate table public\.hq_timeline/i);
    expect(exec).toMatch(/hq_replay_consumer\('timeline', 0\)/i);
  });

  it("registers the timeline consumer at offset 0 — replay the ENTIRE company history", () => {
    expect(exec).toMatch(/select public\.hq_consumer_register\('timeline', 0\)/i);
  });
});

// =====================================================================
// 6. Function hardening — SECURITY DEFINER + pinned empty search_path
// =====================================================================

describe("pulse — every timeline function is hardened", () => {
  for (const fn of FUNCTIONS) {
    it(`${fn} is SECURITY DEFINER with an empty search_path`, () => {
      const header = fnHeader(fn);
      expect(header).toMatch(/security definer/i);
      expect(header).toMatch(/set search_path = ''/i);
    });
  }
});

// =====================================================================
// 7. Privilege model — every function is service_role-only ("grant IS the gate")
// =====================================================================

describe("pulse — EXECUTE revoked from anon/authenticated, granted only to service_role", () => {
  for (const fn of FUNCTIONS) {
    it(`${fn} revokes from public, anon AND authenticated`, () => {
      expect(exec).toMatch(
        new RegExp(
          `revoke all on function\\s+public\\.${fn}\\([\\s\\S]*?\\)\\s*from public, anon, authenticated`,
          "i",
        ),
      );
    });

    it(`${fn} grants execute only to service_role`, () => {
      expect(exec).toMatch(
        new RegExp(
          `grant execute on function\\s+public\\.${fn}\\([\\s\\S]*?\\)\\s*to service_role`,
          "i",
        ),
      );
    });
  }

  it("no EXECUTE/privilege is ever GRANTED to a JWT role (anon/authenticated/public)", () => {
    expect(exec).not.toMatch(/\bto\s+anon\b/i);
    expect(exec).not.toMatch(/\bto\s+authenticated\b/i);
    expect(exec).not.toMatch(/grant[\s\S]*?\bto\s+public\b/i);
  });
});

// =====================================================================
// 8. CQRS rule — the read side never touches the truth log or the table directly
// =====================================================================

describe("pulse — the reader service obeys the one CQRS rule", () => {
  const svc = codeOf(read("server/services/spine-timeline.ts"));

  it("reads ONLY through the three granted timeline RPCs", () => {
    expect(svc).toContain("hq_timeline_page");
    expect(svc).toContain("hq_timeline_event");
    expect(svc).toContain("hq_timeline_facets");
  });

  it("NEVER reads hq_events directly (the spine is the truth; the timeline is the view)", () => {
    expect(svc).not.toMatch(/hq_events/);
  });

  it("NEVER reaches the projection over PostgREST — no .from(table) table access", () => {
    expect(svc).not.toMatch(/\.from\(/);
  });

  it("is read-only — it calls no mutation/consumer RPC (emit, drain, replay, reset)", () => {
    expect(svc).not.toMatch(/hq_emit_event/);
    expect(svc).not.toMatch(/hq_drain_consumer/);
    expect(svc).not.toMatch(/hq_replay_consumer/);
    expect(svc).not.toMatch(/hq_timeline_reset/);
  });

  it("is a server-only module (cannot be pulled into a client bundle)", () => {
    expect(read("server/services/spine-timeline.ts")).toMatch(/^import "server-only";/m);
  });
});

// =====================================================================
// 9. The HQ gate wraps every Pulse surface (STEP 4 — single source of truth)
// =====================================================================

describe("pulse — the HQ gate guards the page + both endpoints", () => {
  it("the page gates on requireHqPage()", () => {
    expect(read("app/admin/pulse/page.tsx")).toMatch(/await requireHqPage\(\)/);
  });

  for (const route of ["app/api/hq/pulse/route.ts", "app/api/hq/pulse/[id]/route.ts"]) {
    it(`${route} gates on requireHqApi() and returns its 404 on denial`, () => {
      const src = read(route);
      expect(src).toMatch(/const gate = await requireHqApi\(\)/);
      expect(src).toMatch(/if \(!gate\.ok\) return gate\.response/);
    });
  }

  it("the detail endpoint never 500s on a bad id — it returns { event: null }", () => {
    expect(read("app/api/hq/pulse/[id]/route.ts")).toMatch(/event: null/);
  });
});

// =====================================================================
// 10. The gate's denial is 404 — never 403 (an HQ surface does not announce itself)
// =====================================================================

describe("pulse — the gate's non-disclosure semantics", () => {
  const authRaw = read("server/auth/hq.ts");
  const authCode = codeOf(authRaw);

  it("reduces to the single isSuperAdminEmail allowlist predicate", () => {
    expect(authCode).toMatch(/isSuperAdminEmail/);
  });

  it("answers 404 for non-allowlisted callers (notFound for pages, status 404 for the API)", () => {
    expect(authCode).toMatch(/notFound\(\)/);
    expect(authCode).toMatch(/status:\s*404/);
  });

  it("never answers 403 (which would announce the surface's existence)", () => {
    expect(authCode).not.toMatch(/403/);
  });
});

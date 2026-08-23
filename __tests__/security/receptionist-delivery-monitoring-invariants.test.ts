import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — DELIVERY MONITORING invariants (the AI Receptionist Programme,
 * R9 — DELIVERY MONITORING: OPERATOR VISIBILITY).
 *
 * R4–R7 built the outbound lifecycle as three APPEND-ONLY ledgers of record: every reply
 * and its enforcement verdict (`ai_reply_audits`), every send attempt (`ai_reply_transports`)
 * and the provider's async terminal fate (`ai_reply_delivery_receipts`). R9 adds NOTHING to
 * that pipeline — it grants the HQ operator READ-ONLY visibility over what the ledgers
 * already recorded. The directive's law: no parallel monitoring store, no new outbound
 * path, no retry, no send, no Twilio poll, no automation, no mutation of a lifecycle record,
 * no second source of truth — visibility ONLY, over the EXISTING tables, on the EXISTING
 * admin surface. This suite proves that law as a matter of SOURCE (not discipline) and the
 * read-only guarantee as a matter of MIGRATION:
 *
 *   • THE READ MODEL IS A VIEW, NOT A TABLE — the migration creates a `security_invoker`
 *     VIEW over the three ledgers and NOTHING ELSE: no table, no row, no trigger, no policy,
 *     no function, no INSTEAD OF write path. A projection holds no rows and is no new source
 *     of truth.
 *   • THE VIEW CANNOT LAUNDER PRIVILEGE — `security_invoker = true` makes it inherit the
 *     caller's RLS, so the ledgers' zero-policy RLS still denies every JWT client through
 *     the view; and it is GRANTED SELECT ONLY, to service_role alone.
 *   • THE VIEW HAS EXACTLY ONE READER SURFACE — across all non-test source, the only modules
 *     that name the `ai_reply_lifecycle` relation are the two delivery-monitoring pages.
 *   • THE MONITOR ADDS NO NEW SEND — the delivery pages reach NO provider, NO transport /
 *     audit / receipt write primitive, NO `.insert`/`.update`/`.delete`, NO event spine.
 *     They are HQ-gated server components that only SELECT.
 *   • THE LEDGERS ARE UNTOUCHED — R9 ships no migration that creates, alters, or drops any
 *     of the three ledgers, their triggers, their policies or their write primitives; the
 *     append-only law proven in R4–R7 is upstream of this view and unaffected by it.
 *
 * The join behaviour, the "missing receipt" absence, and the not-writable-through-the-view
 * guarantee are pinned against real Postgres in
 * __tests__/integration/receptionist/lifecycle-view-pipeline.test.ts; the pure stage/filter
 * fold in the unit tier. This tier is HERMETIC — a filesystem scan over comment-stripped
 * source — so the prose documenting the contract can neither satisfy a positive match nor
 * trip a negative.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip block + line comments so only executable TS source is matched. */
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `://` in URLs)
}

/**
 * Reduce SQL to executable tokens only: strip block + line comments AND single-quoted
 * string literals (Postgres doubles `''` to escape). The migration's `comment on view … is
 * '…'` documents the read-only contract in prose — "no INSTEAD OF trigger", "append-only" —
 * and that prose must be unable to trip a negative match, exactly as the `--` header prose
 * is. Positive assertions here match only real DDL (create view, revoke, grant), never a
 * string literal, so blanking literals is safe.
 */
function sqlCodeOf(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/--[^\n]*/g, "") // line comments
    .replace(/'(?:[^']|'')*'/g, "''"); // string literals → empty (prose can't match)
}

/** Every module specifier the source imports — `from "x"` and bare `import "x"`. */
function importSpecifiers(code: string): string[] {
  const specs: string[] = [];
  const fromRe = /\bfrom\s*["']([^"']+)["']/g;
  const bareRe = /\bimport\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(code))) {
    if (m[1]) specs.push(m[1]);
  }
  while ((m = bareRe.exec(code))) {
    if (m[1]) specs.push(m[1]);
  }
  return specs;
}

/** Recursively collect every non-test .ts/.tsx source file under the given roots. */
function walkSources(roots: readonly string[]): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // a root that does not exist is simply skipped
    }
    for (const entry of entries) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry === ".next" || entry === "__tests__") continue;
        visit(full);
      } else if (/\.tsx?$/.test(entry)) {
        if (!full.endsWith("/lib/supabase/types.ts")) out.push(full);
      }
    }
  };
  for (const r of roots) visit(resolve(ROOT, r));
  return out;
}

/** A repo-relative, POSIX-style path for stable assertions across platforms. */
const rel = (full: string) => relative(ROOT, full).split(sep).join("/");

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

const MIGRATION = "supabase/migrations/20260818000000_ai_reply_lifecycle_view.sql";
const READ_MODEL = "lib/ai-receptionist/lifecycle.ts";
const LIST_PAGE = "app/admin/ai-receptionist/deliveries/page.tsx";
const DETAIL_PAGE = "app/admin/ai-receptionist/deliveries/[auditId]/page.tsx";
const DELIVERY_PAGES = [LIST_PAGE, DETAIL_PAGE] as const;

/** The view (read model) relation name. */
const VIEW = "ai_reply_lifecycle";

/** The three ledgers' write primitives — a monitor must name NONE of them. */
const WRITE_PRIMITIVES = [
  /\brecord_ai_reply_audit\b/,
  /\brecord_ai_reply_transport\b/,
  /\brecord_ai_reply_delivery_receipt\b/,
] as const;

// =====================================================================
// 0. The read model ships — the view migration, the pure module and the two pages.
// =====================================================================

describe("receptionist delivery monitoring — the read-only surface ships", () => {
  it(`ships the read-model view migration ${MIGRATION}`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION)), MIGRATION).toBe(true);
  });

  it(`ships the pure presentation module ${READ_MODEL}`, () => {
    expect(existsSync(resolve(ROOT, READ_MODEL)), READ_MODEL).toBe(true);
    const code = codeOf(read(READ_MODEL));
    expect(code).toMatch(/export function deriveLifecycleStage\(/);
    expect(code).toMatch(/export function stageMatchesFilter\(/);
  });

  it("ships the delivery-monitoring list and detail pages", () => {
    for (const p of DELIVERY_PAGES) expect(existsSync(resolve(ROOT, p)), p).toBe(true);
  });
});

// =====================================================================
// 1. THE READ MODEL IS A VIEW, NOT A TABLE. The migration creates a security_invoker view
//    over the three ledgers and NOTHING that writes.
// =====================================================================

describe("receptionist delivery monitoring — the migration is a read-only projection", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("creates the ai_reply_lifecycle VIEW", () => {
    expect(sql).toMatch(/create or replace view public\.ai_reply_lifecycle\b/i);
  });

  it("the view is security_invoker — it inherits the caller's RLS, never launders it", () => {
    expect(sql).toMatch(/with\s*\(\s*security_invoker\s*=\s*true\s*\)/i);
  });

  it("projects from the three ledgers of record (audit ⟕ transport ⟕ receipt)", () => {
    expect(sql).toMatch(/from public\.ai_reply_audits\b/i);
    expect(sql).toMatch(/left join public\.ai_reply_transports\b/i);
    expect(sql).toMatch(/from public\.ai_reply_delivery_receipts\b/i); // in the lateral picks
  });

  it("is GRANTED SELECT ONLY, to service_role, and revoked from every other role", () => {
    expect(sql).toMatch(
      /revoke all on public\.ai_reply_lifecycle from public, anon, authenticated, service_role/i,
    );
    expect(sql).toMatch(/grant select on public\.ai_reply_lifecycle to service_role/i);
    // INSERT / UPDATE / DELETE are NEVER granted on the view.
    expect(sql).not.toMatch(/grant[\s\S]*?(insert|update|delete)[\s\S]*?on public\.ai_reply_lifecycle/i);
  });

  it("WRITES NOTHING — no table, row, trigger, policy, function or INSTEAD OF write path", () => {
    // A projection creates only a view (+ its comment/grants). Any of these would mean R9
    // had grown a store, a producer, or a write path — exactly what the directive forbids.
    expect(sql).not.toMatch(/create table/i);
    expect(sql).not.toMatch(/alter table/i);
    expect(sql).not.toMatch(/insert into/i);
    expect(sql).not.toMatch(/\bupdate\s+public\./i);
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
    expect(sql).not.toMatch(/create (or replace )?function/i);
    expect(sql).not.toMatch(/create trigger/i);
    expect(sql).not.toMatch(/instead of/i);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/\bdrop\b/i);
  });

  it("does NOT create a parallel monitoring table (no *_monitor / *_lifecycle table)", () => {
    // The only new relation is the VIEW; there is no second source of truth.
    expect(sql).not.toMatch(/create table[\s\S]*?(monitor|lifecycle|delivery_log|_events)/i);
  });
});

// =====================================================================
// 2. THE LEDGERS ARE UNTOUCHED. R9 ships exactly one migration, and it names none of the
//    ledgers' guards, policies or write primitives in a mutating position.
// =====================================================================

describe("receptionist delivery monitoring — the append-only ledgers are unchanged", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("does not alter or drop any of the three ledgers", () => {
    for (const ledger of [
      "ai_reply_audits",
      "ai_reply_transports",
      "ai_reply_delivery_receipts",
    ]) {
      expect(sql, `alter ${ledger}`).not.toMatch(new RegExp(`alter table public\\.${ledger}`, "i"));
      expect(sql, `drop ${ledger}`).not.toMatch(new RegExp(`drop [\\s\\S]*?${ledger}`, "i"));
    }
  });

  it("does not touch the ledgers' append-only guards or their RLS policies", () => {
    expect(sql).not.toMatch(/block_mutation/i);
    expect(sql).not.toMatch(/enable row level security/i);
    expect(sql).not.toMatch(/disable row level security/i);
  });

  it("does not redefine any ledger write primitive", () => {
    for (const fn of WRITE_PRIMITIVES) {
      expect(sql, String(fn)).not.toMatch(fn);
    }
  });
});

// =====================================================================
// 3. THE VIEW HAS EXACTLY ONE READER SURFACE. Only the two delivery pages name the relation.
// =====================================================================

describe("receptionist delivery monitoring — the view is read by exactly the two pages", () => {
  const readers = walkSources(SOURCE_ROOTS)
    .filter((full) => new RegExp(`["']${VIEW}["']`).test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the ONLY modules naming the ai_reply_lifecycle relation are the two delivery pages", () => {
    // The pure module references the view only in prose (stripped by codeOf); the relation
    // string appears in executable code solely in the pages that SELECT from it.
    expect(readers).toEqual([...DELIVERY_PAGES].sort());
  });
});

// =====================================================================
// 4. THE MONITOR ADDS NO NEW SEND. The delivery pages are HQ-gated, read the view, and
//    reach no provider, no ledger write, no event spine.
// =====================================================================

describe("receptionist delivery monitoring — the pages are read-only and add no send", () => {
  for (const page of DELIVERY_PAGES) {
    describe(page, () => {
      const code = codeOf(read(page));

      it("is HQ-gated — it requires an HQ page session", () => {
        expect(code).toMatch(/requireHqPage\s*\(/);
      });

      it("reads the read model — it SELECTs from ai_reply_lifecycle", () => {
        expect(code).toMatch(new RegExp(`from\\(\\s*["']${VIEW}["']`));
        expect(code).toMatch(/\.select\s*\(/);
      });

      it("performs NO table write — no insert / update / delete anywhere on the page", () => {
        expect(code).not.toMatch(/\.insert\s*\(/);
        expect(code).not.toMatch(/\.update\s*\(/);
        expect(code).not.toMatch(/\.delete\s*\(/);
        expect(code).not.toMatch(/\.upsert\s*\(/);
      });

      it("reaches NO ledger write primitive — no audit / transport / receipt write RPC", () => {
        for (const fn of WRITE_PRIMITIVES) expect(code, String(fn)).not.toMatch(fn);
      });

      it("reaches NO provider and NO new send path", () => {
        expect(code).not.toMatch(/\bgetSmsProvider\s*\(/);
        expect(code).not.toMatch(/provider\.send\s*\(/);
        expect(code).not.toMatch(/\bsendSms\b/);
        expect(code).not.toMatch(/recordSmsDeliveryReceipt\s*\(/);
        expect(code).not.toMatch(/enforceAndAuditReply\s*\(/);
      });

      it("reaches NO event spine, NO retry and NO Twilio poll", () => {
        expect(code).not.toMatch(/\bemitEvent\s*\(/);
        expect(importSpecifiers(code)).not.toContain("@/server/services/event-spine");
        expect(code).not.toMatch(/\bretry\b/i);
        expect(code).not.toMatch(/validateRequest\s*\(/); // no Twilio SDK use
        expect(code).not.toMatch(/api\.twilio\.com/); // no provider poll
      });

      it("does not call any Supabase write RPC — the only rpc surface is read enrichment", () => {
        // A read model must never invoke a mutating stored procedure. (These pages don't
        // call .rpc at all; assert the ledger writers specifically, and no generic write.)
        expect(code).not.toMatch(/\.rpc\s*\(\s*["']record_/);
      });
    });
  }
});

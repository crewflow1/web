import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — reply PRODUCTION & AUDIT enforcement invariants
 * (the AI Receptionist Programme, R4 — reply production & audit pipeline).
 *
 * R3 proved there is exactly ONE enforcement path and no module may bypass it. R4
 * completes the INTERNAL pipeline — Draft → Enforce → Audit — and makes the audit
 * MANDATORY: "no reply may leave the pipeline without producing an audit record; the
 * audit trail is not optional, not best effort, not configurable." This suite proves
 * that contract as a matter of SOURCE, not discipline — the house bar of
 * tool-registry-describes-not-authorises.test.ts:
 *
 *   • SINGLE WRITE PATH — across all non-test source (app/, server/, lib/), the
 *     ledger's write primitive (`record_ai_reply_audit`) is named by EXACTLY ONE
 *     module: the canonical receptionist service. No other file can file an audit,
 *     so there is no second write path.
 *   • PRODUCER IS PURE & CAPTIVE — the deterministic producer (lib/receptionist/
 *     reply.ts) reaches for no server/policy/IO/model, and is consumed by EXACTLY
 *     ONE module: the canonical service. It DRAFTS; it never enforces.
 *   • ENFORCE ↔ AUDIT ARE WELDED — the seam enforces via the R3 chokepoint and then
 *     writes the ledger; the producer path composes then routes through that seam.
 *     No branch produces a reply without both.
 *   • THE AUDIT IS MANDATORY, IN SOURCE — a failed ledger write THROWS; it is not
 *     swallowed (contrast the admin activity log) and does not rest on the
 *     best-effort event spine (contrast `emitEvent`).
 *   • APPEND-ONLY LEDGER, IN THE MIGRATION — the store is RLS-enabled with no
 *     policies, UPDATE/DELETE are rejected by triggers, and the write primitive is a
 *     SECURITY DEFINER function granted only to service_role.
 *
 * The pipeline's runtime behaviour (exactly one audit per attempted reply; allow /
 * review / block all audited; append-only; RLS) is pinned against real Postgres in
 * __tests__/integration/receptionist/reply-audit-pipeline.test.ts. This tier is
 * HERMETIC — a filesystem scan over comment-stripped source — so the prose
 * documenting the contract can neither satisfy a positive match nor trip a negative.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip block + line comments so only executable TS source is matched. */
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `://` in URLs)
}

/** Strip `--` line comments so only executable SQL is matched. */
function sqlCodeOf(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
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
        out.push(full);
      }
    }
  };
  for (const r of roots) visit(resolve(ROOT, r));
  return out;
}

/** A repo-relative, POSIX-style path for stable assertions across platforms. */
const rel = (full: string) => relative(ROOT, full).split(sep).join("/");

const SERVICE = "server/services/receptionist.ts";
const PRODUCER = "lib/receptionist/reply.ts";
// R13 (CEO Directive #018) replaced the fixed acknowledgement composer, at both pipeline draft sites,
// with the conversation-aware draft generator. The deterministic producer above became that generator's
// FALLBACK. R25 then lifted the generation — including that fallback shaping — into the canonical
// Conversation Generation Engine's PURE CORE, so the producer's single consumer is now the engine core
// (the draft seam is a thin adapter that reaches it only THROUGH the engine).
const GENERATION_CORE = "lib/receptionist/conversation-generation.ts";
const MIGRATION = "supabase/migrations/20260815000000_ai_reply_audits.sql";

/** The ledger's write primitive — the function an auditor would call to file a row. */
const WRITE_FN = /\brecord_ai_reply_audit\b/;
const PRODUCER_SPEC = "@/lib/receptionist/reply";
const PRODUCER_FN = /\bcomposeReceptionistReply\b/;
/** The harvested policy's decision surface — the producer must name none of it. */
const DECISION_FNS = /\b(?:evaluateReply|isAutoSendable|redactReply)\b/;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

// =====================================================================
// 0. The ledger, the producer and the pipeline all ship.
// =====================================================================

describe("receptionist reply audit — the pipeline ships", () => {
  it(`ships the append-only ledger migration ${MIGRATION}`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION)), MIGRATION).toBe(true);
  });

  it(`ships the pure producer ${PRODUCER}`, () => {
    expect(existsSync(resolve(ROOT, PRODUCER)), PRODUCER).toBe(true);
  });

  it("the canonical service exports both pipeline seams", () => {
    const code = codeOf(read(SERVICE));
    expect(code).toMatch(/export async function enforceAndAuditReply\(/);
    expect(code).toMatch(/export async function produceAndEnforceReply\(/);
  });
});

// =====================================================================
// 1. SINGLE WRITE PATH — exactly one module can file a reply audit.
// =====================================================================

describe("receptionist reply audit — exactly one module writes the ledger", () => {
  const writers = walkSources(SOURCE_ROOTS)
    .filter((full) => WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the ONLY module that names the ledger write primitive is the canonical service", () => {
    // If this list ever grows, a second audit-write path (or a bypass) has appeared.
    expect(writers).toEqual([SERVICE]);
  });

  it("no app/ route, action, or component writes the ledger directly", () => {
    expect(writers.filter((p) => p.startsWith("app/"))).toEqual([]);
  });

  it("no other server/ module writes the ledger directly", () => {
    expect(writers.filter((p) => p !== SERVICE && p.startsWith("server/"))).toEqual([]);
  });
});

// =====================================================================
// 2. The producer is PURE and consumed only by the canonical service.
// =====================================================================

describe("receptionist reply audit — the producer is pure and captive", () => {
  const producerReachers = walkSources(SOURCE_ROOTS)
    .filter((full) => rel(full) !== PRODUCER)
    .filter((full) => {
      const code = codeOf(read(rel(full)));
      return importSpecifiers(code).includes(PRODUCER_SPEC) || PRODUCER_FN.test(code);
    })
    .map(rel)
    .sort();

  it("the producer is consumed by EXACTLY ONE module — the R25 generation engine core (its fallback)", () => {
    // Post-R25 the deterministic composer is the generation engine's fallback shaping, so its sole
    // consumer is the engine's pure core. If this list ever grows, the fixed acknowledgement has leaked
    // a second consumer.
    expect(producerReachers).toEqual([GENERATION_CORE]);
  });

  const pcode = codeOf(read(PRODUCER));

  it("is a shared pure module (NOT server-only — the SDK, the service, and tests import it)", () => {
    expect(importSpecifiers(pcode)).not.toContain("server-only");
  });

  it("DRAFTS, it does not ENFORCE — it never imports the policy nor names its decisions", () => {
    // If the producer reached the policy it would become a SECOND enforcement path.
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/policy");
    expect(pcode).not.toMatch(DECISION_FNS);
  });

  it("touches no I/O and calls no model — it composes, it does not generate", () => {
    expect(pcode).not.toMatch(/createAdminClient/);
    expect(pcode).not.toMatch(/supabase/i);
    expect(pcode).not.toMatch(/\bfetch\(/);
    expect(pcode).not.toMatch(/@\/lib\/ai\//);
    expect(pcode).not.toMatch(/Anthropic/);
  });

  it("has no clock and no RNG (a produced draft is reconstructable)", () => {
    expect(pcode).not.toMatch(/Math\.random/);
    expect(pcode).not.toMatch(/Date\.now/);
    expect(pcode).not.toMatch(/new Date\(/);
  });
});

// =====================================================================
// 3. Enforce ↔ audit are welded; the producer path routes through the seam.
// =====================================================================

describe("receptionist reply audit — enforcement and audit are inseparable", () => {
  const code = codeOf(read(SERVICE));

  it("the seam ENFORCES (R3 chokepoint) and THEN writes the ledger — in that order", () => {
    expect(code).toMatch(/enforceReceptionistReply\([\s\S]{0,1200}record_ai_reply_audit/);
  });

  it("the producer path generates the draft and routes it through the audited seam", () => {
    // R13: the draft is GENERATED (through the conversation-aware generator, which owns the
    // deterministic fallback) and then routed through the mandatory enforce+audit seam — in that order.
    expect(code).toMatch(/produceAndEnforceReply[\s\S]{0,800}generateReplyDraft\(/);
    expect(code).toMatch(/produceAndEnforceReply[\s\S]{0,800}enforceAndAuditReply\(/);
  });

  it("still delegates enforcement to the harvested policy via the R3 seam", () => {
    expect(code).toMatch(/\bevaluateReply\s*\(/);
    expect(code).toMatch(/allowed:\s*isAutoSendable\(/);
  });
});

// =====================================================================
// 4. The audit is MANDATORY in source — it throws, it is not swallowed,
//    and it does not rest on the best-effort event spine.
// =====================================================================

describe("receptionist reply audit — the audit is mandatory, not best-effort", () => {
  const code = codeOf(read(SERVICE));

  it("a failed ledger write THROWS — a reply may not proceed unaudited", () => {
    expect(code).toMatch(/record_ai_reply_audit[\s\S]{0,1200}throw new Error/);
  });

  it("never manufactures an affirmative send decision (deny-by-default preserved)", () => {
    expect(code).not.toMatch(/allowed:\s*true/);
  });

  it("does not lean the mandatory audit on the best-effort event spine", () => {
    // The spine never throws; a mandatory audit cannot rest on it. The dedicated
    // ledger primitive is the audit of record.
    expect(importSpecifiers(code)).not.toContain("@/server/services/event-spine");
    expect(code).not.toMatch(/\bemitEvent\s*\(/);
  });
});

// =====================================================================
// 5. The migration installs an APPEND-ONLY, service-role-only ledger.
// =====================================================================

describe("receptionist reply audit — the ledger is append-only and service-role-only", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("creates the ai_reply_audits table", () => {
    expect(sql).toMatch(/create table if not exists public\.ai_reply_audits/i);
  });

  it("captures the organisation, conversation, customer, employee, draft and decision", () => {
    for (const column of [
      "org_id",
      "employee_slug",
      "channel",
      "enquiry_id",
      "lead_id",
      "customer_ref",
      "correlation_id",
      "draft",
      "verdict",
      "allowed",
      "categories",
      "reason",
      "safe_text",
      "metadata",
      "created_at",
    ]) {
      expect(sql, `column ${column}`).toMatch(new RegExp(`\\b${column}\\b`));
    }
  });

  it("bounds the verdict to the guardrail codomain and pins deny-by-default in DDL", () => {
    expect(sql).toMatch(
      /check\s*\(\s*verdict\s+in\s*\(\s*'allow'\s*,\s*'review'\s*,\s*'block'\s*\)\s*\)/i,
    );
    // `allowed` is auto-sendable ONLY for a clean `allow` — the ledger cannot lie.
    expect(sql).toMatch(/check\s*\(\s*allowed\s*=\s*\(\s*verdict\s*=\s*'allow'\s*\)\s*\)/i);
  });

  it("enables RLS with NO policies — service-role / SECURITY DEFINER only", () => {
    expect(sql).toMatch(/alter table public\.ai_reply_audits enable row level security/i);
    // No SELECT/INSERT policy opens the table to a JWT client.
    expect(sql).not.toMatch(/create policy[\s\S]*?on public\.ai_reply_audits/i);
  });

  it("is APPEND-ONLY — UPDATE and DELETE are rejected by triggers", () => {
    expect(sql).toMatch(/create or replace function public\.ai_reply_audits_block_mutation\(/i);
    expect(sql).toMatch(/raise exception[\s\S]*?append-only[\s\S]*?tg_op/i);
    expect(sql).toMatch(/errcode\s*=\s*'restrict_violation'/i);
    expect(sql).toMatch(
      /create trigger ai_reply_audits_no_update\s+before update on public\.ai_reply_audits/i,
    );
    expect(sql).toMatch(
      /create trigger ai_reply_audits_no_delete\s+before delete on public\.ai_reply_audits/i,
    );
  });

  it("writes only through a SECURITY DEFINER primitive granted only to service_role", () => {
    expect(sql).toMatch(/create or replace function public\.record_ai_reply_audit\(/i);
    expect(sql).toMatch(/returns uuid/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = ''/i);
    expect(sql).toMatch(/insert into public\.ai_reply_audits/i);
    expect(sql).toMatch(/revoke all on function[\s\S]*?from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*?to service_role/i);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * AI cost observability (Phase 0) — trust-boundary + scope contracts.
 *
 * Pins: the migration is ADDITIVE (extends ai_invocations, no CREATE TABLE, no
 * writer/behaviour change), the estate rollup is SERVICE-ROLE-ONLY (no client can
 * read cross-tenant spend), telemetry stays privacy-safe (no prompt/content stored),
 * and the report service is read-only. Hermetic source scan.
 */
const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) => ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const sqlOnly = (s: string) =>
  s.split("\n").map((l) => { const i = l.indexOf("--"); return i === -1 ? l : l.slice(0, i); }).join("\n");

const MIG = "supabase/migrations/20261235000000_ai_cost_observability.sql";
const REPORT = "server/services/ai-cost-report.ts";
const GOVERNOR = "lib/ai/governor.ts";

describe("migration — additive + service-role-only rollup", () => {
  const sql = sqlOnly(read(MIG));
  it("is ADDITIVE: alters ai_invocations, creates no table", () => {
    expect(sql).toMatch(/alter table public\.ai_invocations/i);
    expect(sql).not.toMatch(/create table/i);
  });
  it("adds the three observability columns; cached is NULLABLE (null = unknown, honest)", () => {
    // cached_input_tokens is nullable (no NOT NULL / no default 0) — null = provider
    // did not report, never a fabricated zero.
    expect(sql).toMatch(/add column if not exists cached_input_tokens integer\s*\n\s*check \(cached_input_tokens is null or cached_input_tokens >= 0\)/i);
    expect(sql).not.toMatch(/cached_input_tokens integer not null default 0/i);
    expect(sql).toMatch(/add column if not exists engine text not null default 'hosted'/i);
    expect(sql).toMatch(/add column if not exists is_fallback boolean not null default false/i);
  });
  it("the rollup function is service-role-only (execute revoked from client roles)", () => {
    expect(sql).toMatch(/create or replace function public\.ai_cost_window/i);
    expect(sql).toMatch(/revoke all on function public\.ai_cost_window\(text\) from anon, authenticated/i);
    // Not SECURITY DEFINER (so it can't be a privilege-escalation surface).
    expect(sql).not.toMatch(/security definer/i);
  });
  it("computes the window in Europe/London (DST-safe) — not naive UTC", () => {
    expect(sql).toMatch(/Europe\/London/);
    expect(sql).toMatch(/date_trunc/i);
  });
});

describe("report service — read-only, service-role, no mutation", () => {
  const src = read(REPORT);
  it("only CALLS the rollup rpc — never inserts/updates the ledger", () => {
    expect(src).toMatch(/rpc\(\s*["']ai_cost_window["']/);
    expect(src).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
  });
  it("fails loud on a read error (error !== empty)", () => {
    expect(src).toMatch(/throw new Error\(`ai_cost_window/);
  });
});

describe("writer — additive population, no behaviour change", () => {
  const src = read(GOVERNOR);
  it("records engine + is_fallback + cached tokens with honest defaults", () => {
    expect(src).toMatch(/engine: input\.engine \?\? "hosted"/);
    expect(src).toMatch(/is_fallback: input\.isFallback \?\? false/);
    // null (not 0) when cached tokens are unknown
    expect(src).toMatch(/input\.usage\.cachedInputTokens == null\s*\n?\s*\? null/);
  });
});

describe("exactly-once settlement — no undercount, no double-count", () => {
  const gov = read(GOVERNOR);
  const report = read(REPORT);
  // Scope to the settleReservation function body (other functions also have `if (error)`).
  const settleFn = codeOf(
    gov.slice(
      gov.indexOf("export async function settleReservation"),
      gov.indexOf("export async function releaseReservation"),
    ),
  );
  it("settleReservation RETRIES the idempotent RPC on error (never a blind insert)", () => {
    expect(settleFn).toMatch(/SETTLE_ATTEMPTS/);
    // The RPC-error branch retries (continue) and does NOT call recordInvocation.
    const errBranch = settleFn.slice(settleFn.indexOf("if (error) {"), settleFn.indexOf("const row ="));
    expect(errBranch).toMatch(/continue;/);
    expect(errBranch).not.toMatch(/recordInvocation/);
  });
  it("recordInvocation is used ONLY for the 'not_found' (reservation-gone) case", () => {
    // Exactly one recordInvocation call in settle, and it sits after the not_found check.
    expect(settleFn.match(/recordInvocation\(/g)?.length).toBe(1);
    expect(settleFn.indexOf('outcome === "not_found"')).toBeLessThan(settleFn.indexOf("recordInvocation("));
  });
  it("exhausted retries surface an explicit ACCOUNTING DEGRADED signal (not silent)", () => {
    expect(gov).toMatch(/ACCOUNTING DEGRADED/);
  });
  it("degraded visibility reuses the reservations table — no second cost ledger", () => {
    expect(report).toMatch(/readAccountingHealth/);
    expect(report).toMatch(/from\(["']ai_cost_reservations["']\)/);
    // No new ledger table is created by this PR's migration.
    expect(sqlOnly(read(MIG))).not.toMatch(/create table/i);
  });
});

describe("privacy-safe telemetry", () => {
  it("the ledger stores a content FINGERPRINT, never the prompt/content", () => {
    const ledgerMig = read("supabase/migrations/20261062000000_ai_invocations.sql");
    expect(ledgerMig).toMatch(/content_hash/);
    // No raw prompt/content/body column on the ledger.
    expect(sqlOnly(ledgerMig)).not.toMatch(/\b(prompt|content|body|message_text|request_body)\s+text/i);
  });
});

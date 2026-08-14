import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * CrewFlow HQ — auto morning CEO briefing store, security source-contracts (P2 HQ AI Operating
 * System). Mirrors the executor-shadow store hardening (20260815*) and the HQ Event Spine: RLS:hq,
 * a SECURITY DEFINER service-role-only write primitive, and an append-only immutable guard. The
 * load-bearing extra rule: the briefing is DETERMINISTIC-ONLY — the `source` CHECK admits one
 * literal and the RPC hardcodes it, so generative prose is dark by construction.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
function execOf(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const MIGRATION = "supabase/migrations/20261128000001_hq_ceo_briefings.sql";
const exec = execOf(read(MIGRATION));

describe("hq_ceo_briefings — RLS:hq (enabled, ZERO policies → service-role only)", () => {
  it("enables RLS on the table", () => {
    expect(exec).toMatch(/alter table public\.hq_ceo_briefings\s+enable row level security/);
  });
  it("creates NO policy and no JWT-client grant on the table", () => {
    expect(exec).not.toMatch(/create policy/i);
    expect(exec).not.toMatch(/grant\s+(select|insert|update|delete|all)\s+on\s+(table\s+)?public\.hq_ceo_briefings/i);
  });
});

describe("hq_ceo_briefings — DETERMINISTIC ONLY (generative prose is dark)", () => {
  it("the source column CHECK admits only the literal 'deterministic'", () => {
    expect(exec).toMatch(/source\s+text\s+not null\s+default\s+'deterministic'/);
    expect(exec).toMatch(/check\s*\(source\s*=\s*'deterministic'\)/);
  });
  it("the write RPC hardcodes source and takes NO p_source parameter", () => {
    expect(exec).toMatch(/create or replace function public\.hq_record_ceo_briefing\(/);
    expect(exec).not.toMatch(/p_source/);
    // the insert literal is hardcoded 'deterministic'
    expect(exec).toMatch(/values\s*\(\s*[^)]*'deterministic'/s);
  });
});

describe("hq_ceo_briefings — append-only + immutable (a briefing is never rewritten)", () => {
  it("blocks UPDATE and DELETE even under service-role", () => {
    expect(exec).toMatch(/create or replace function public\.hq_ceo_briefings_block_mutation\(\)/);
    expect(exec).toMatch(/hq_ceo_briefings is append-only/);
    expect(exec).toMatch(/before update on public\.hq_ceo_briefings/);
    expect(exec).toMatch(/before delete on public\.hq_ceo_briefings/);
  });
  it("keeps one briefing per day (the idempotency key)", () => {
    expect(exec).toMatch(/unique \(briefing_date\)/);
  });
});

describe("hq_ceo_briefings — the write primitive is SECURITY DEFINER, service-role only", () => {
  it("is SECURITY DEFINER with a pinned empty search_path", () => {
    expect(exec).toMatch(/security definer/);
    expect(exec).toMatch(/set search_path = ''/);
  });
  it("EXECUTE is revoked from public/anon/authenticated and granted only to service_role", () => {
    expect(exec).toMatch(/revoke all on function public\.hq_record_ceo_briefing\([^)]*\)\s*from public, anon, authenticated/);
    expect(exec).toMatch(/grant execute on function public\.hq_record_ceo_briefing\([^)]*\)\s*to service_role/);
  });
  it("is idempotent per day (on conflict do nothing, then returns the day's id)", () => {
    expect(exec).toMatch(/on conflict \(briefing_date\) do nothing/);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { VERB_GROUPS } from "@/lib/events/registry";
import { DRAFT_PROVENANCES, DRAFT_STATUSES } from "@/lib/drafts/model";

/**
 * CrewFlow HQ — Draft Generation security invariants (Directive 010, Phase 3).
 *
 * Phase 3 builds the FIRST REUSABLE INTELLIGENCE LAYER for the whole AI workforce —
 * "reusable intelligence for the entire AI workforce", not an Outreach feature. Every
 * future employee (Sales, Customer Success, Finance, Business Coach, Voice) inherits
 * it, so its trust boundary is pinned here, exhaustively, against SOURCE TEXT. The
 * CEO's exclusions are the spec: "Generate drafts only. Do not build delivery,
 * automation, scheduling, or follow-up." Plus: every draft auditable, costs measured,
 * one event vocabulary, and the prose never leaves the platform.
 *
 * The load-bearing facts these pin, and what breaks if one silently flips:
 *   • The artifact is WRITE-ONCE, enforced in the DATABASE (a trigger no caller can
 *     bypass), because the service reaches the table through the service-role admin
 *     client, which BYPASSES RLS. If that weakened, "every draft auditable / immutable"
 *     would be a lie.
 *   • The audit REUSES the spine's frozen ai.* run-lifecycle verbs (no draft.* /
 *     outreach.* minted; "one event vocabulary"). If it grew its own log or verb, the
 *     directive's "one history" would be void.
 *   • The draft PROSE never enters the spine payload — it stays sealed in the RLS:hq
 *     row. If the subject/body leaked into an event, customer-facing content would
 *     escape the locked artifact.
 *   • The engine NEVER sends, delivers, schedules, or automates (Phase-3 exclusions).
 *     Generation via the bounded LLM IS the point — but a send channel or scheduler
 *     would be overreach.
 *
 * SQL checks run over `exec` (-- comments stripped); TS checks over `code` (// + block
 * comments stripped) — so the prose that DOCUMENTS the contract can neither satisfy a
 * positive match nor trip a negative one.
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

function codeOf(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const MIGRATION = "supabase/migrations/20260731000000_hq_drafts.sql";
const SERVICE = "server/services/hq-drafts.ts";
const PROMPT = "lib/drafts/prompt.ts";
const MODEL = "lib/drafts/model.ts";

// =====================================================================
// 0. The engine ships, generic, as ONE immutable artifact + its inline ledger.
// =====================================================================

describe("draft engine — the migration ships one generic artifact, no new audit surface", () => {
  it(`${MIGRATION} exists`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION))).toBe(true);
  });

  const exec = execOf(read(MIGRATION));

  it("creates exactly ONE table — hq_drafts — and no second audit/event/log store", () => {
    const creates = exec.match(/create\s+table\s+if\s+not\s+exists\s+public\.(\w+)/gi) ?? [];
    expect(creates).toHaveLength(1);
    expect(exec).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.hq_drafts/i);
    expect(exec).not.toMatch(/create\s+table[^;]*\b(audit|event|log|history)\b/i);
  });

  it("is RLS:hq — RLS enabled, ZERO policies (service-role only; no JWT client)", () => {
    expect(exec).toMatch(/alter\s+table\s+public\.hq_drafts\s+enable\s+row\s+level\s+security/i);
    expect(exec).not.toMatch(/create\s+policy/i);
  });

  it("is GENERIC shared infrastructure — the table/triggers name no employee", () => {
    // execOf strips the -- prose; the DDL itself is employee-agnostic.
    expect(exec).not.toMatch(/outreach/i);
  });

  it("references ai_employees (the generator) — reuses existing identity", () => {
    expect(exec).toMatch(/references\s+public\.ai_employees\s*\(\s*id\s*\)/i);
  });

  it("carries the cost ledger inline (the artifact IS its run): tokens, cost, latency", () => {
    expect(exec).toMatch(/input_tokens\s+integer/i);
    expect(exec).toMatch(/output_tokens\s+integer/i);
    expect(exec).toMatch(/cost_usd\s+numeric/i);
    expect(exec).toMatch(/latency_ms\s+integer/i);
  });

  it("records prompt provenance — version + checksum — so every draft is traceable", () => {
    expect(exec).toMatch(/prompt_version\s+text\s+not\s+null/i);
    expect(exec).toMatch(/prompt_checksum\s+text\s+not\s+null/i);
  });
});

// =====================================================================
// 1. The status/provenance pair is constrained — and AGREES with the model enums.
// =====================================================================

describe("draft engine — status & provenance are constrained and mirror the pure model", () => {
  const exec = execOf(read(MIGRATION));

  it("constrains status to exactly the model's DRAFT_STATUSES", () => {
    expect(DRAFT_STATUSES).toEqual(["generated", "fallback"]);
    for (const s of DRAFT_STATUSES) expect(exec).toMatch(new RegExp(`'${s}'`));
    expect(exec).toMatch(/status\s+text[\s\S]*?check\s*\(\s*status\s+in\s*\(\s*'generated'\s*,\s*'fallback'\s*\)/i);
  });

  it("constrains provenance to exactly the model's DRAFT_PROVENANCES", () => {
    expect(DRAFT_PROVENANCES).toEqual(["anthropic", "openai", "deterministic"]);
    expect(exec).toMatch(
      /provenance\s+text[\s\S]*?check\s*\(\s*provenance\s+in\s*\(\s*'anthropic'\s*,\s*'openai'\s*,\s*'deterministic'\s*\)/i,
    );
  });

  it("ties status TO provenance — generated⇒llm, fallback⇒deterministic (never incoherent)", () => {
    expect(exec).toMatch(
      /status\s*=\s*'generated'\s+and\s+provenance\s+in\s*\(\s*'anthropic'\s*,\s*'openai'\s*\)/i,
    );
    expect(exec).toMatch(/status\s*=\s*'fallback'\s+and\s+provenance\s*=\s*'deterministic'/i);
  });
});

// =====================================================================
// 2. The artifact is WRITE-ONCE, enforced by a DB trigger no caller can bypass.
// =====================================================================

describe("draft engine — a draft is immutable, enforced in the database", () => {
  const exec = execOf(read(MIGRATION));

  it("a BEFORE UPDATE trigger rejects EVERY mutation (regeneration supersedes, never mutates)", () => {
    expect(exec).toMatch(/before\s+update\s+on\s+public\.hq_drafts/i);
    expect(exec).toMatch(/execute\s+function\s+public\.hq_drafts_immutable\(\)/i);
    expect(exec).toMatch(/raise\s+exception/i);
    expect(exec).toMatch(/write-once|immutable/i);
  });

  it("regeneration links back via supersedes_id — the prior draft stays in the record", () => {
    expect(exec).toMatch(/supersedes_id\s+uuid\s+references\s+public\.hq_drafts\s*\(\s*id\s*\)/i);
  });
});

// =====================================================================
// 3. The audit REUSES the spine's frozen ai.* verbs — one vocabulary, prose OFF-spine.
// =====================================================================

describe("draft engine — audit reuses the event spine; mints no new vocabulary; prose stays sealed", () => {
  const exec = execOf(read(MIGRATION));

  it("emits THROUGH hq_emit_event — the single validated spine primitive", () => {
    expect(exec).toMatch(/public\.hq_emit_event\s*\(/i);
    expect(exec).not.toMatch(/insert\s+into\s+public\.hq_events/i);
    expect(exec).not.toMatch(/create\s+type[^;]*verb/i);
  });

  it("a generated/fallback draft is a completed run → the FROZEN ai.run_completed verb", () => {
    expect(exec).toMatch(/'ai\.run_completed'/);
    expect(VERB_GROUPS.ai).toContain("ai.run_completed");
  });

  it("mints NO new vocabulary — no draft.* / outreach.* verb, and only the frozen ai.* group", () => {
    expect(exec).not.toMatch(/'draft\.[a-z_]+'/i);
    expect(exec).not.toMatch(/'outreach\.[a-z_]+'/i);
    // Every ai.* verb literal it emits is a member of the registry's frozen ai group.
    const aiVerbs = [...exec.matchAll(/'(ai\.[a-z_]+)'/g)].map((m) => m[1]);
    expect(aiVerbs.length).toBeGreaterThan(0);
    for (const v of aiVerbs) expect(VERB_GROUPS.ai).toContain(v as (typeof VERB_GROUPS.ai)[number]);
  });

  it("the PROSE never enters the spine — the payload carries NO draft content/subject/body", () => {
    // The emit trigger never references the content column, and builds no subject/body key.
    expect(exec).not.toMatch(/new\.content/);
    expect(exec).not.toMatch(/'body'/);
    expect(exec).not.toMatch(/'subject'/); // subject_type/_id are identifiers (target_*), not payload
    // What it DOES carry is identifiers + metadata: kind, status, provenance, cost, version.
    expect(exec).toMatch(/'prompt_checksum'/);
    expect(exec).toMatch(/'cost_usd'/);
  });

  it("the spine emitter fn is SECURITY DEFINER and hardened (service_role-only EXECUTE)", () => {
    expect(exec).toMatch(/function\s+public\.hq_drafts_emit\(\)[\s\S]*?security\s+definer/i);
    expect(exec).toMatch(/set\s+search_path\s*=\s*''/i);
    expect(exec).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.hq_drafts_emit\(\)\s+from\s+public,\s*anon,\s*authenticated/i,
    );
    expect(exec).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.hq_drafts_emit\(\)\s+to\s+service_role/i,
    );
  });

  it("uses NO dynamic SQL anywhere (no execute format / execute '…')", () => {
    expect(exec).not.toMatch(/\bexecute\s+format\s*\(/i);
    expect(exec).not.toMatch(/\bexecute\s+'/i);
  });
});

// =====================================================================
// 4. The service GENERATES and stops — it never sends, delivers, schedules, automates.
// =====================================================================

describe("draft engine — the service generates only, within the Phase-3 mandate", () => {
  const code = codeOf(read(SERVICE));

  it("exposes generation + context assembly, and writes ONE immutable row (never updates)", () => {
    expect(code).toMatch(/export\s+async\s+function\s+generateDraft/);
    expect(code).toMatch(/export\s+async\s+function\s+assembleDraftContext/);
    // Regeneration supersedes; the service never mutates a draft (the DB forbids it too).
    expect(code).toMatch(/\.insert\s*\(/);
    expect(code).not.toMatch(/\.update\s*\(/);
  });

  it("bounds the LLM edge — temperature 0 and a maxTokens cap (determinism + cost control)", () => {
    expect(code).toMatch(/temperature:\s*0\b/);
    expect(code).toMatch(/maxTokens/);
  });

  it("degrades to the deterministic fallback — no provider / throw / bad JSON all fall back", () => {
    expect(code).toMatch(/getTextProvider\s*\(\s*\)/);
    expect(code).toMatch(/deterministicDraft/);
    expect(code).toMatch(/no_provider/);
  });

  it("measures cost for every generated draft (costs measurable)", () => {
    expect(code).toMatch(/textCostUsd/);
  });

  it("NEVER sends, delivers, schedules, or automates — the Phase-3 exclusions, pinned", () => {
    // No send/delivery channel.
    expect(code).not.toMatch(/nodemailer|resend|sendgrid|sendEmail|email\/send|\bsmtp\b|twilio/i);
    // No scheduling / follow-up automation.
    expect(code).not.toMatch(/\bcron\b|setInterval|setTimeout|scheduleAt|enqueue/i);
    // No raw outbound calls from the service itself.
    expect(code).not.toMatch(/\bfetch\s*\(/);
    // Generic — the service code names no employee.
    expect(code).not.toMatch(/outreach/i);
  });

  it("reuses existing infrastructure (no reinvention): admin client, text seam, the three reads", () => {
    expect(code).toMatch(/createAdminClient/);
    expect(code).toMatch(/assembleDraftPrompt/);
    expect(code).toMatch(/createMemory/);
    expect(code).toMatch(/getResearchReport/);
    expect(code).toMatch(/getQualificationReport/);
  });
});

// =====================================================================
// 5. The pure core is PURE — no IO, no transport — and states the never-send doctrine.
// =====================================================================

describe("draft engine — the pure core has no IO and forbids the model from sending", () => {
  const promptCode = codeOf(read(PROMPT));
  const modelCode = codeOf(read(MODEL));

  it("lib/drafts/prompt.ts is pure — no server-only, no DB client, no transport", () => {
    expect(promptCode).not.toMatch(/server-only/);
    expect(promptCode).not.toMatch(/createAdminClient|supabase/i);
    expect(promptCode).not.toMatch(/\bfetch\s*\(/);
    expect(promptCode).not.toMatch(/nodemailer|resend|sendEmail/i);
  });

  it("the system prompt tells the model it NEVER sends and nothing is transmitted", () => {
    expect(promptCode).toMatch(/never send/i);
    expect(promptCode).toMatch(/transmitted/i);
  });

  it("lib/drafts/model.ts is the pure vocabulary — no server-only — pinning the provenance enum", () => {
    expect(modelCode).not.toMatch(/server-only/);
    expect(modelCode).toMatch(
      /DRAFT_PROVENANCES\s*=\s*\[\s*"anthropic"\s*,\s*"openai"\s*,\s*"deterministic"\s*\]/,
    );
  });
});

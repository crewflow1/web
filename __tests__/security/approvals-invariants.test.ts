import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { VERB_GROUPS } from "@/lib/events/registry";
import { APPROVAL_ACTIONS, verbFor } from "@/lib/approvals/state";

/**
 * CrewFlow HQ — The Approval Engine security invariants (Directive 010, Phase 2).
 *
 * Phase 2 builds the FIRST REUSABLE APPROVAL ENGINE for the whole AI workforce —
 * "shared infrastructure, not Outreach-specific code." Every future employee
 * (Sales, Customer Success, Finance, Business Coach, Voice) inherits it, so its
 * trust boundary is pinned here, exhaustively, against SOURCE TEXT. The CEO success
 * criteria are the spec: deterministic, auditable, explicit reviewer permissions,
 * recoverable rejections, tracked edits, IMMUTABLE history, and security boundaries
 * that CANNOT be bypassed.
 *
 * The load-bearing facts these pin, and what breaks if one silently flips:
 *   • The state machine + immutability + reviewer requirement are enforced in the
 *     DATABASE (a trigger no caller can bypass), not just in TypeScript — because
 *     the service reaches the table through the service-role admin client, which
 *     BYPASSES RLS. If that guard weakened, "cannot be bypassed" would be a lie.
 *   • The audit trail REUSES the append-only event spine's reserved approval.*
 *     verbs (immutable history, no second audit store, no new vocabulary). If the
 *     engine grew its own mutable log, "immutable history" would be void.
 *   • The engine is GENERIC — it names no employee. If "outreach" leaked in, it
 *     would stop being shared infrastructure.
 *   • It NEVER sends, generates, or automates (the Phase-2 exclusions). If a send
 *     channel or model were wired here, Phase 2 would have overreached its mandate.
 *
 * SQL checks run over `exec` (-- comments stripped); TS checks over `code` (// +
 * block comments stripped) — so the prose that DOCUMENTS the contract can neither
 * satisfy a positive match nor trip a negative one.
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
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const MIGRATION = "supabase/migrations/20260730000000_hq_approvals.sql";
const STATE = "lib/approvals/state.ts";
const SERVICE = "server/services/hq-approvals.ts";

const RESERVED_APPROVAL_VERBS = [
  "approval.requested",
  "approval.granted",
  "approval.rejected",
  "approval.edited",
  "approval.expired",
  "approval.escalated",
];

// =====================================================================
// 0. The engine ships, generic, on the reserved foundation.
// =====================================================================

describe("approval engine — the migration ships one generic state table, no new surface", () => {
  it(`${MIGRATION} exists`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION))).toBe(true);
  });

  const exec = execOf(read(MIGRATION));

  it("creates exactly ONE table — hq_approvals — and no second audit/event/log store", () => {
    const creates = exec.match(/create\s+table\s+if\s+not\s+exists\s+public\.(\w+)/gi) ?? [];
    expect(creates).toHaveLength(1);
    expect(exec).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.hq_approvals/i);
    // The audit trail is the spine — the engine must not grow its own log table.
    expect(exec).not.toMatch(/create\s+table[^;]*\b(audit|event|log|history)\b/i);
  });

  it("is RLS:hq — RLS enabled, ZERO policies (service-role only; no JWT client)", () => {
    expect(exec).toMatch(/alter\s+table\s+public\.hq_approvals\s+enable\s+row\s+level\s+security/i);
    expect(exec).not.toMatch(/create\s+policy/i);
  });

  it("is GENERIC shared infrastructure — it names no employee (no 'outreach')", () => {
    expect(exec).not.toMatch(/outreach/i);
  });

  it("references ai_employees (proposer) and users (reviewer) — reuses existing identity", () => {
    expect(exec).toMatch(/references\s+public\.ai_employees\s*\(\s*id\s*\)/i);
    expect(exec).toMatch(/references\s+public\.users\s*\(\s*id\s*\)/i);
  });
});

// =====================================================================
// 1. The audit trail REUSES the append-only spine's reserved approval.* verbs.
// =====================================================================

describe("approval engine — audit reuses the event spine; mints no new vocabulary", () => {
  const exec = execOf(read(MIGRATION));

  it("emits THROUGH hq_emit_event — the single validated spine primitive", () => {
    expect(exec).toMatch(/public\.hq_emit_event\s*\(/i);
    // It does not invent a parallel event-writer or its own verb registry.
    expect(exec).not.toMatch(/insert\s+into\s+public\.hq_events/i); // goes through the primitive
    expect(exec).not.toMatch(/create\s+type[^;]*verb/i);
  });

  it("brings ALL SIX reserved approval.* verbs to life — no more, no less", () => {
    for (const v of RESERVED_APPROVAL_VERBS) {
      expect(exec).toMatch(new RegExp(`'${v.replace(".", "\\.")}'`));
    }
    // No approval.* verb outside the reserved six is emitted.
    const emitted = [...exec.matchAll(/'(approval\.[a-z_]+)'/g)].map((m) => m[1]);
    for (const v of emitted) expect(RESERVED_APPROVAL_VERBS).toContain(v);
  });

  it("the emitted verbs are EXACTLY the registry's frozen approval group", () => {
    expect([...RESERVED_APPROVAL_VERBS].sort()).toEqual([...VERB_GROUPS.approval].sort());
  });
});

// =====================================================================
// 2. The state machine is DB-ENFORCED and cannot be bypassed.
// =====================================================================

describe("approval engine — the deterministic state machine is enforced by a trigger", () => {
  const exec = execOf(read(MIGRATION));

  it("a BEFORE trigger guards every insert AND update (the unbypassable enforcer)", () => {
    expect(exec).toMatch(/before\s+insert\s+on\s+public\.hq_approvals/i);
    expect(exec).toMatch(/before\s+update\s+on\s+public\.hq_approvals/i);
    expect(exec).toMatch(/execute\s+function\s+public\.hq_approvals_guard\(\)/i);
  });

  it("terminal states are IMMUTABLE — any update to approved/rejected/expired raises", () => {
    expect(exec).toMatch(
      /old\.state\s+in\s*\(\s*'approved'\s*,\s*'rejected'\s*,\s*'expired'\s*\)/i,
    );
    expect(exec).toMatch(/terminal\s+and\s+immutable|raise\s+exception/i);
  });

  it("the proposal is WRITE-ONCE — changing what was proposed raises", () => {
    expect(exec).toMatch(/new\.subject_type\s+is\s+distinct\s+from\s+old\.subject_type/i);
    expect(exec).toMatch(/new\.proposed_payload\s+is\s+distinct\s+from\s+old\.proposed_payload/i);
    expect(exec).toMatch(/new\.ai_employee_id\s+is\s+distinct\s+from\s+old\.ai_employee_id/i);
  });

  it("a new approval is BORN pending — it cannot be inserted into a later state", () => {
    expect(exec).toMatch(/new\.state\s*<>\s*'pending'/i);
  });

  it("legal transitions only: pending may escalate; either active state may decide", () => {
    expect(exec).toMatch(/old\.state\s*=\s*'pending'\s+and\s+new\.state\s+in\s*\([^)]*'escalated'/i);
    expect(exec).toMatch(/old\.state\s*=\s*'escalated'\s+and\s+new\.state\s+in\s*\([^)]*'approved'/i);
    // De-escalation is NOT a legal move — escalated never transitions back to pending.
    expect(exec).not.toMatch(/'escalated'\s+and\s+new\.state\s+in\s*\([^)]*'pending'/i);
  });

  it("decisions carry their evidence: a reviewer on approve/reject, a reason on reject", () => {
    expect(exec).toMatch(
      /new\.state\s+in\s*\(\s*'approved'\s*,\s*'rejected'\s*\)\s+and\s+new\.reviewer_id\s+is\s+null/i,
    );
    expect(exec).toMatch(/new\.state\s*=\s*'rejected'\s+and\s*\(\s*new\.decision_reason\s+is\s+null/i);
  });
});

// =====================================================================
// 3. No new escalation surface — the engine adds no dynamic SQL / unsafe definer.
// =====================================================================

describe("approval engine — no new attack surface beyond the hardened emitter", () => {
  const exec = execOf(read(MIGRATION));

  it("the spine emitter fn is SECURITY DEFINER and hardened (service_role-only EXECUTE)", () => {
    expect(exec).toMatch(/function\s+public\.hq_approvals_emit\(\)[\s\S]*?security\s+definer/i);
    expect(exec).toMatch(/set\s+search_path\s*=\s*''/i);
    expect(exec).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.hq_approvals_emit\(\)\s+from\s+public,\s*anon,\s*authenticated/i,
    );
    expect(exec).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.hq_approvals_emit\(\)\s+to\s+service_role/i,
    );
  });

  it("uses NO dynamic SQL anywhere (no execute format / execute '…')", () => {
    expect(exec).not.toMatch(/\bexecute\s+format\s*\(/i);
    expect(exec).not.toMatch(/\bexecute\s+'/i);
  });
});

// =====================================================================
// 4. The pure state module mirrors the registry vocabulary, generically.
// =====================================================================

describe("approval engine — the pure state module is the generic, registry-bound mirror", () => {
  const code = codeOf(read(STATE));

  it("maps its six actions to EXACTLY the six reserved verbs (compile-bound to the registry)", () => {
    const verbs = APPROVAL_ACTIONS.map((a) => verbFor(a)).sort();
    expect(verbs).toEqual([...VERB_GROUPS.approval].sort());
  });

  it("declares the active/terminal partition in source", () => {
    expect(code).toMatch(/ACTIVE_STATES\s*=\s*\[\s*"pending"\s*,\s*"escalated"\s*\]/);
    expect(code).toMatch(/TERMINAL_STATES\s*=\s*\[\s*"approved"\s*,\s*"rejected"\s*,\s*"expired"/);
  });

  it("is generic and pure — names no employee, imports no server/IO", () => {
    expect(code).not.toMatch(/outreach/i);
    expect(code).not.toMatch(/server-only/);
    expect(code).not.toMatch(/createAdminClient|supabase/i);
  });
});

// =====================================================================
// 5. The service enforces reviewer permissions and NEVER sends/generates/automates.
// =====================================================================

describe("approval engine — the service gates reviewers and stays within the Phase-2 mandate", () => {
  const code = codeOf(read(SERVICE));

  it("reviewer DECISIONS are HQ-gated in code (admin client bypasses RLS)", () => {
    expect(code).toMatch(/isSuperAdminEmail/);
    expect(code).toMatch(/reviewerGate/);
    // The four human-decision entry points all run the gate.
    for (const fn of ["editApproval", "escalateApproval", "approveApproval", "rejectApproval"]) {
      expect(code).toMatch(new RegExp(`export\\s+async\\s+function\\s+${fn}`));
    }
  });

  it("rejections require a reason; recovery supersedes rather than mutating a terminal row", () => {
    expect(code).toMatch(/reason_required/);
    expect(code).toMatch(/supersedesId|supersedes_id/);
    expect(code).toMatch(/export\s+async\s+function\s+recoverApproval/);
  });

  it("NEVER sends, generates, or automates — the Phase-2 exclusions, pinned", () => {
    // No send channel.
    expect(code).not.toMatch(/email\/send|sendEmail|nodemailer|resend/i);
    // No generative model wired into the approval engine.
    expect(code).not.toMatch(/anthropic|openai|claude-|messages\.create/i);
    // No outbound automation.
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/outreach/i);
  });

  it("reuses the existing audit + identity primitives (no reinvented infrastructure)", () => {
    expect(code).toMatch(/recordAdminActivity/);
    expect(code).toMatch(/createAdminClient/);
  });
});

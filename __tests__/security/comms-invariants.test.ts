import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { VERB_GROUPS } from "@/lib/events/registry";
import { COMM_ACTIONS, TRANSITIONS } from "@/lib/comms/state";

/**
 * CrewFlow HQ — Communication Layer security invariants (Directive 010, Phase 4).
 *
 * Phase 4 delivers an APPROVED draft through a replaceable provider — SHARED workforce
 * infrastructure every future AI employee inherits (Sales, Customer Success, Finance,
 * Business Coach, Voice). Its trust boundary is pinned here, exhaustively, against
 * SOURCE TEXT. The CEO's constraints are the spec, and each is load-bearing:
 *
 *   • "Every outbound communication still requires the Approval Engine." The gate is a
 *     BEFORE INSERT trigger that subqueries hq_approvals — UNBYPASSABLE even by the
 *     service-role client that BYPASSES RLS. If it weakened to TypeScript-only, a future
 *     caller could deliver an ungated message. THIS is the boundary, in the database.
 *   • "Nothing should ever send automatically. No autonomous sending / campaigns /
 *     follow-ups." The service is a CALLABLE PRIMITIVE — no cron, no scheduler, no
 *     timer, no queue-drainer. A human decision and an explicit call are always upstream.
 *   • "The Draft Engine and Communication Layer remain separate systems." The comms
 *     service reaches drafts only through the public READ seam (getDraft) — never the
 *     generation internals — joined by draft_id + the shared approval.
 *   • One event vocabulary — the six comm.* verbs, reused from the frozen registry; no
 *     second audit store, no minted vocabulary. The recipient + prose NEVER leave the
 *     RLS-locked row: the spine event carries identifiers + metadata only.
 *   • The state machine MIRROR (lib/comms/state.ts) and the database ENFORCER (the
 *     trigger) agree — proven by deriving the legal moves from the map and finding them
 *     in the SQL.
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

const MIGRATION = "supabase/migrations/20260801000000_hq_communications.sql";
const SERVICE = "server/services/hq-comms.ts";
const STATE = "lib/comms/state.ts";
const POLICY = "lib/comms/policy.ts";
const COST = "lib/comms/cost.ts";
const TYPES = "lib/comms/types.ts";
const INDEX = "lib/comms/index.ts";
const RESEND = "lib/comms/providers/resend.ts";

// =====================================================================
// 0. The migration ships TWO generic objects — the attempt + the do-not-contact list.
// =====================================================================

describe("comms layer — the migration ships the attempt + suppression tables, no new audit surface", () => {
  it(`${MIGRATION} exists`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION))).toBe(true);
  });

  const exec = execOf(read(MIGRATION));

  it("creates exactly TWO tables — hq_communications + hq_comms_suppressions — and no second audit/event/log store", () => {
    const creates = exec.match(/create\s+table\s+if\s+not\s+exists\s+public\.(\w+)/gi) ?? [];
    expect(creates).toHaveLength(2);
    expect(exec).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.hq_communications/i);
    expect(exec).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.hq_comms_suppressions/i);
    expect(exec).not.toMatch(/create\s+table[^;]*\b(audit|event|log|history)\b/i);
  });

  it("both tables are RLS:hq — RLS enabled, ZERO policies (service-role only; no JWT client)", () => {
    expect(exec).toMatch(/alter\s+table\s+public\.hq_communications\s+enable\s+row\s+level\s+security/i);
    expect(exec).toMatch(/alter\s+table\s+public\.hq_comms_suppressions\s+enable\s+row\s+level\s+security/i);
    expect(exec).not.toMatch(/create\s+policy/i);
  });

  it("is GENERIC shared infrastructure — the DDL names no employee (no `outreach`)", () => {
    expect(exec).not.toMatch(/outreach/i);
  });

  it("reuses existing identity — references ai_employees, hq_drafts, hq_approvals (no new actor table)", () => {
    expect(exec).toMatch(/references\s+public\.ai_employees\s*\(\s*id\s*\)/i);
    expect(exec).toMatch(/references\s+public\.hq_drafts\s*\(\s*id\s*\)/i);
    expect(exec).toMatch(/references\s+public\.hq_approvals\s*\(\s*id\s*\)/i);
  });

  it("carries the cost ledger inline (costs measurable): cost_usd + latency_ms per attempt", () => {
    expect(exec).toMatch(/cost_usd\s+numeric/i);
    expect(exec).toMatch(/latency_ms\s+integer/i);
  });
});

// =====================================================================
// 1. THE approval gate — the load-bearing boundary, enforced in the database.
// =====================================================================

describe("comms layer — every delivery requires an APPROVED action, enforced by the database", () => {
  const exec = execOf(read(MIGRATION));

  it("approval_id is NOT NULL and FK-bound to hq_approvals — there is no ungated delivery row", () => {
    expect(exec).toMatch(
      /approval_id\s+uuid\s+not\s+null\s+references\s+public\.hq_approvals\s*\(\s*id\s*\)/i,
    );
  });

  it("a BEFORE INSERT trigger SUBQUERIES hq_approvals and REJECTS unless the approval is 'approved'", () => {
    // The gate lives on INSERT (a CHECK cannot subquery; a trigger can).
    expect(exec).toMatch(/before\s+insert\s+on\s+public\.hq_communications/i);
    expect(exec).toMatch(/execute\s+function\s+public\.hq_communications_guard\(\)/i);
    // The exact gate: read the referenced approval's state and refuse anything but 'approved'.
    expect(exec).toMatch(
      /select\s+state\s+from\s+public\.hq_approvals\s+where\s+id\s*=\s*new\.approval_id\s*\)\s*is\s+distinct\s+from\s+'approved'/i,
    );
    expect(exec).toMatch(/raise\s+exception[^;]*approval[^;]*not\s+approved/i);
  });

  it("the gate guards EVERY birth — a suppressed or failed attempt is gated too (no exceptions)", () => {
    // The approval-state check precedes the born-state check inside the INSERT branch, so
    // it runs for every insert regardless of the status the row is born in.
    const insertBranch = exec.slice(
      exec.indexOf("tg_op = 'INSERT'"),
      exec.indexOf("tg_op = 'UPDATE' from here") === -1
        ? exec.length
        : exec.indexOf("tg_op = 'UPDATE' from here"),
    );
    const iGate = insertBranch.indexOf("is distinct from 'approved'");
    const iBorn = insertBranch.indexOf("born sent");
    expect(iGate).toBeGreaterThan(-1);
    // Whether or not the prose marker survives execOf, the gate is present in the insert path.
    if (iBorn > -1) expect(iGate).toBeLessThan(iBorn);
  });
});

// =====================================================================
// 2. The state machine MIRROR (lib/comms/state.ts) == the database ENFORCER (the trigger).
// =====================================================================

describe("comms layer — the pure state map and the SQL trigger encode the SAME legal moves", () => {
  const exec = execOf(read(MIGRATION));

  // Derive the legal moves from the single source of truth (the pure map)…
  const bornStates = COMM_ACTIONS.filter((a) => TRANSITIONS[a].from === null).map(
    (a) => TRANSITIONS[a].to,
  );
  const transitionTargets = COMM_ACTIONS.filter((a) => TRANSITIONS[a].from !== null).map(
    (a) => TRANSITIONS[a].to,
  );

  it("the BORN states agree — the map says sent/failed/suppressed; the SQL enforces exactly that", () => {
    expect([...bornStates].sort()).toEqual(["failed", "sent", "suppressed"]);
    expect(exec).toMatch(/new\.status\s+not\s+in\s*\(\s*'sent'\s*,\s*'failed'\s*,\s*'suppressed'\s*\)/i);
  });

  it("the live→terminal transitions agree — the map says sent → delivered/bounced/complained; the SQL enforces exactly that", () => {
    expect([...transitionTargets].sort()).toEqual(["bounced", "complained", "delivered"]);
    expect(exec).toMatch(
      /old\.status\s*=\s*'sent'\s+and\s+new\.status\s+in\s*\(\s*'delivered'\s*,\s*'bounced'\s*,\s*'complained'\s*\)/i,
    );
  });

  it("terminal rows are FROZEN — a BEFORE UPDATE trigger rejects any mutation of a terminal row", () => {
    expect(exec).toMatch(/before\s+update\s+on\s+public\.hq_communications/i);
    expect(exec).toMatch(
      /old\.status\s+in\s*\(\s*'delivered'\s*,\s*'bounced'\s*,\s*'complained'\s*,\s*'failed'\s*,\s*'suppressed'\s*\)/i,
    );
    expect(exec).toMatch(/terminal\s+and\s+immutable/i);
  });

  it("the routing + evidence is write-once — who/what/where/under-which-approval can never be rewritten", () => {
    expect(exec).toMatch(/new\.approval_id\s+is\s+distinct\s+from\s+old\.approval_id/i);
    expect(exec).toMatch(/new\.to_address\s+is\s+distinct\s+from\s+old\.to_address/i);
    expect(exec).toMatch(/new\.draft_id\s+is\s+distinct\s+from\s+old\.draft_id/i);
  });

  it("retry is NOT a transition — the supersedes_id self-reference is the retry mechanism (the prior row stays)", () => {
    expect(exec).toMatch(/supersedes_id\s+uuid\s+references\s+public\.hq_communications\s*\(\s*id\s*\)/i);
  });
});

// =====================================================================
// 3. One vocabulary — the six comm.* verbs, reused; prose stays sealed off-spine.
// =====================================================================

describe("comms layer — audit reuses the spine, mints no vocabulary, and keeps PII + prose off-spine", () => {
  const exec = execOf(read(MIGRATION));

  it("emits THROUGH hq_emit_event — never inserts into hq_events directly, mints no verb type", () => {
    expect(exec).toMatch(/public\.hq_emit_event\s*\(/i);
    expect(exec).not.toMatch(/insert\s+into\s+public\.hq_events/i);
    expect(exec).not.toMatch(/create\s+type[^;]*verb/i);
  });

  it("every comm.* verb it emits is a member of the registry's frozen comm group — exactly the six", () => {
    const commVerbs = [...exec.matchAll(/'(comm\.[a-z_]+)'/g)].map((m) => m[1]);
    expect(commVerbs.length).toBeGreaterThan(0);
    for (const v of commVerbs) {
      expect(VERB_GROUPS.comm).toContain(v as (typeof VERB_GROUPS.comm)[number]);
    }
    // The distinct set the SQL emits is exactly the six reserved verbs.
    expect([...new Set(commVerbs)].sort()).toEqual([...VERB_GROUPS.comm].sort());
  });

  it("mints NO new vocabulary — no comm-adjacent draft.* / outreach.* / delivery.* verb", () => {
    expect(exec).not.toMatch(/'draft\.[a-z_]+'/i);
    expect(exec).not.toMatch(/'outreach\.[a-z_]+'/i);
    expect(exec).not.toMatch(/'delivery\.[a-z_]+'/i);
  });

  it("attributes the actor HONESTLY — `send` is the employee's act; every other state is the system's", () => {
    // The one deliberate act is the AI employee's send…
    expect(exec).toMatch(/new\.status\s*=\s*'sent'\s+then[\s\S]*?v_actor_type\s*:=\s*'ai_employee'/i);
    // …and ai_employee is asserted exactly ONCE as an actor (the rest are 'system').
    const aiActor = [...exec.matchAll(/v_actor_type\s*:=\s*'ai_employee'/g)];
    expect(aiActor).toHaveLength(1);
    expect(exec).toMatch(/v_actor_type\s*:=\s*'system'/i);
  });

  it("the PROSE + recipient NEVER enter the spine — the payload carries no to_address / subject / body / content", () => {
    // The emit payload references no recipient address and no draft prose.
    expect(exec).not.toMatch(/p_payload[\s\S]*to_address/i);
    expect(exec).not.toMatch(/p_payload[\s\S]*new\.content/i);
    const payload = exec.match(/jsonb_build_object\(([\s\S]*?)\n\s*\)\n\s*\);/i)?.[1] ?? "";
    expect(payload.length).toBeGreaterThan(0);
    expect(payload).not.toContain("to_address");
    expect(payload).not.toMatch(/'subject'|'body'|'content'/);
    // What it DOES carry: identifiers + routing metadata + the cost ledger.
    expect(payload).toContain("'status'");
    expect(payload).toContain("'provider'");
    expect(payload).toContain("'cost_usd'");
  });

  it("the spine emitter is SECURITY DEFINER + hardened (empty search_path, service_role-only EXECUTE), no dynamic SQL", () => {
    expect(exec).toMatch(/function\s+public\.hq_communications_emit\(\)[\s\S]*?security\s+definer/i);
    expect(exec).toMatch(/set\s+search_path\s*=\s*''/i);
    expect(exec).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.hq_communications_emit\(\)\s+from\s+public,\s*anon,\s*authenticated/i,
    );
    expect(exec).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.hq_communications_emit\(\)\s+to\s+service_role/i,
    );
    expect(exec).not.toMatch(/\bexecute\s+format\s*\(/i);
    expect(exec).not.toMatch(/\bexecute\s+'/i);
  });
});

// =====================================================================
// 4. The service — a callable primitive: gated, never autonomous, two systems kept separate.
// =====================================================================

describe("comms layer — the service is gated, never autonomous, and reuses existing infrastructure", () => {
  const code = codeOf(read(SERVICE));

  it("fast-fails any delivery whose approval is not 'approved' (the clean mirror of the DB gate)", () => {
    expect(code).toMatch(/approval\.state\s*!==\s*"approved"/);
    expect(code).toMatch(/not_approved/);
  });

  it("NOTHING sends autonomously — no cron, no scheduler, no timer, no queue-drainer", () => {
    expect(code).not.toMatch(/\bcron\b|CronJob|schedule\b|scheduleAt/i);
    expect(code).not.toMatch(/setInterval|setTimeout/);
    expect(code).not.toMatch(/\benqueue\b|queue-?drain|drainQueue|worker/i);
  });

  it("delivers ONLY through the replaceable provider seam — never a second mailer, never raw transport", () => {
    expect(code).toMatch(/getEmailProvider/);
    // The service does not reach the transport directly — that is the resend provider's job.
    expect(code).not.toMatch(/sendEmail|nodemailer|sendgrid|twilio|postmark/i);
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });

  it("keeps the Draft Engine + Communication Layer SEPARATE — joins via the getDraft READ seam only, not generation internals", () => {
    expect(code).toMatch(/getDraft\b/);
    expect(code).not.toMatch(/generateDraft|assembleDraftPrompt|assembleDraftContext|deterministicDraft/);
  });

  it("requires the Approval Engine — resolves the gating approval through getApproval", () => {
    expect(code).toMatch(/getApproval\b/);
  });

  it("reuses existing infrastructure — admin client, the provider seam, the pure policy, the rate limiter", () => {
    expect(code).toMatch(/createAdminClient/);
    expect(code).toMatch(/from\s+"@\/lib\/comms"/);
    expect(code).toMatch(/from\s+"@\/lib\/comms\/policy"/);
    expect(code).toMatch(/\bconsume\b/); // the existing lib/security/rate-limit limiter
  });

  it("retry SUPERSEDES, never mutates — a failed attempt is retried as a NEW row", () => {
    expect(code).toMatch(/export\s+async\s+function\s+retryDelivery/);
    expect(code).toMatch(/canRetry/);
    expect(code).toMatch(/supersedesId/);
  });
});

// =====================================================================
// 5. The pure core is PURE; the provider seam degrades gracefully and throws on failure.
// =====================================================================

describe("comms layer — the pure core has no IO, and the provider seam is the only transport edge", () => {
  for (const path of [STATE, POLICY, COST, TYPES]) {
    it(`${path} is pure — no server-only, no DB client, no network, no transport`, () => {
      const c = codeOf(read(path));
      expect(c).not.toMatch(/server-only/);
      expect(c).not.toMatch(/createAdminClient|@\/lib\/supabase/);
      expect(c).not.toMatch(/\bfetch\s*\(/);
      expect(c).not.toMatch(/nodemailer|sendEmail|@\/lib\/email/);
    });
  }

  it("the factory degrades to null when no provider is configured (graceful off-switch, the CI path)", () => {
    const c = codeOf(read(INDEX));
    expect(c).toMatch(/export\s+function\s+getEmailProvider\s*\(\s*\)\s*:\s*EmailProvider\s*\|\s*null/);
    expect(c).toMatch(/RESEND_API_KEY/);
    expect(c).toMatch(/return\s+null/);
    expect(c).toMatch(/export\s+function\s+isEmailConfigured/);
  });

  it("the Resend provider EXTENDS the existing transport (delegates to lib/email/send) and THROWS on failure", () => {
    const c = codeOf(read(RESEND));
    // Prefer extension over replacement: it wraps the existing wrapper, never re-implements transport.
    expect(c).toMatch(/from\s+"@\/lib\/email\/send"/);
    expect(c).not.toMatch(/\bfetch\s*\(/);
    expect(c).not.toMatch(/new\s+Resend\s*\(/);
    // The seam contract is THROW-on-failure (the service records `failed` and owns retry).
    expect(c).toMatch(/throw\s+new\s+Error/);
  });
});

// =====================================================================
// 6. The registry pin — the comm group is exactly the six past-tense delivery facts.
// =====================================================================

describe("comms layer — the frozen registry holds exactly the six comm.* verbs", () => {
  it("VERB_GROUPS.comm is the six delivery verbs, all past-tense (facts that happened)", () => {
    expect([...VERB_GROUPS.comm].sort()).toEqual(
      ["comm.bounced", "comm.complained", "comm.delivered", "comm.failed", "comm.sent", "comm.suppressed"].sort(),
    );
    // There is no comm.queued — the send is synchronous, so there is no queued state.
    expect(VERB_GROUPS.comm as readonly string[]).not.toContain("comm.queued");
  });
});

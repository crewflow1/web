import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONVERSATION EXECUTION ENGINE governance invariants
 * (the AI Receptionist Programme, R28 — CONVERSATION EXECUTION ENGINE).
 *
 * R17–R25 built the DERIVING stack; R26 added the OUTCOME ENGINE; R27 added the ACTION ENGINE — the layer that
 * PREPARES an internal business action. R28 is the NEXT layer: it DECIDES whether a PREPARED action may
 * execute. Its law is exact — "the Execution Engine determines WHETHER work may execute; it must NEVER bypass
 * Policy, Audit, Human Review or organisational controls; it does not broaden execution authority beyond the
 * approved scope; and it EXECUTES nothing." This suite proves that contract as a matter of SOURCE, not
 * discipline — the house bar of tool-registry-describes-not-authorises.test.ts:
 *
 *   • SINGLE WRITE PATH — across all non-test source (app/, server/, lib/), the execution ledger's write
 *     primitive (`record_receptionist_conversation_execution`) is named by EXACTLY ONE module: the execution
 *     server runtime. No other file can file a decision, so there is no second write path.
 *   • THE PURE CORE IS PURE & MODEL-FREE — it reaches no server / IO / model / clock / RNG, and its ONLY
 *     imports are the R27 action predicate+types it CONSUMES and the R3 policy VERDICT TYPE (type-only). It
 *     DECIDES; it persists nothing.
 *   • THE ACTION ENGINE STAYS AUTHORITATIVE — the core CONSUMES the prepared action (imports
 *     `isActionableAction`, defers on it FIRST) and NEVER re-derives it (it never names `resolveAction`), so no
 *     duplicate action-resolution logic exists and the Action Engine (and transitively the Outcome Engine)
 *     stays authoritative.
 *   • POLICY STAYS MANDATORY — NOT RE-RUN — the core imports the `GuardrailVerdict` TYPE but NEVER names a
 *     policy DECISION function (`evaluateReply` / `isAutoSendable` / `redactReply` / `clearForHumanSend`): it
 *     CONSUMES the verdict the guardrail already computed, so no duplicate policy logic exists — and a `block`
 *     forces `blocked_by_policy`.
 *   • HUMAN REVIEW STAYS MANDATORY — the eligibility vocabulary is EXACTLY
 *     {requires_human_review, blocked_by_policy, blocked_by_org}: it structurally OMITS any autonomous-execute
 *     value, so the strongest a booking can reach is human review. A booking NEVER executes autonomously.
 *   • IT DECIDES ELIGIBILITY — IT EXECUTES NO EXTERNAL ACTION — neither the core nor the runtime reaches a
 *     transport, provider, generator, calendar or booking API; the runtime writes NO tenant row (no lead
 *     reflection, no customer promotion) — the ledger IS the exposure.
 *   • THE PERSIST IS BEST-EFFORT — the runtime SWALLOWS a failed write (returns null), it never THROWS, and it
 *     NEVER generates the confirmation — no model, no reply pipeline.
 *   • THE LEDGER IS APPEND-ONLY, SERVICE-ROLE-ONLY, NON-EXECUTING & DETERMINISTIC — RLS-enabled with no
 *     policies, UPDATE/DELETE rejected by triggers, a SECURITY DEFINER writer granted only to service_role, its
 *     `status` CHECK-pinned to 'decided', its `eligibility` CHECK-pinned to the three non-autonomous values,
 *     and a CHECK that pins the eligibility to the EXACT deterministic fold of its inputs — so no row can
 *     record a non-deterministic or autonomous decision.
 *   • THE RUNTIME DECIDES ALONGSIDE — NOT INSTEAD OF — THE AUDITED REPLY — the canonical service runs the
 *     UNCHANGED dispatch, records the outcome, prepares the action, THEN decides execution from the reply's
 *     ALREADY-computed verdict, gated on a real audited dispatch; R28 adds no second reply/generation/transport
 *     path, and the org constraint is a DEFAULT-OFF feature flag.
 *
 * The engine's runtime behaviour is pinned against real Postgres in
 * __tests__/integration/receptionist/conversation-execution-pipeline.test.ts, and the pure core's resolution
 * exhaustively in __tests__/receptionist/conversation-execution.test.ts. This tier is HERMETIC — a filesystem
 * scan over comment-stripped source — so the prose documenting the contract can neither satisfy a positive
 * match nor trip a negative.
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

const CORE = "lib/receptionist/conversation-execution.ts";
const RUNTIME = "server/services/receptionist-execution.ts";
const SERVICE = "server/services/receptionist.ts";
const MIGRATION = "supabase/migrations/20260828000000_receptionist_conversation_executions.sql";

/** The execution ledger's write primitive — the function an auditor would call to file a decision. */
const WRITE_FN = /\brecord_receptionist_conversation_execution\b/;

/** The policy DECISION functions — the core must NAME NONE of them (it consumes the verdict, never re-runs it). */
const POLICY_DECISION_FNS = /\b(?:evaluateReply|isAutoSendable|redactReply|clearForHumanSend)\b/;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

// =====================================================================
// 0. The engine, the ledger and the runtime all ship, and the service integrates them.
// =====================================================================

describe("receptionist execution — the engine ships and is wired", () => {
  it(`ships the append-only execution ledger migration ${MIGRATION}`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION)), MIGRATION).toBe(true);
  });

  it(`ships the pure core ${CORE}`, () => {
    expect(existsSync(resolve(ROOT, CORE)), CORE).toBe(true);
  });

  it(`ships the server runtime ${RUNTIME}`, () => {
    expect(existsSync(resolve(ROOT, RUNTIME)), RUNTIME).toBe(true);
  });

  it("the pure core exports the single resolution entry point and its predicate", () => {
    const code = codeOf(read(CORE));
    expect(code).toMatch(/export function resolveExecution\(/);
    expect(code).toMatch(/export function isExecutionDecided\(/);
  });

  it("the server runtime exports the single record entry point and the org-constraint gate", () => {
    const code = codeOf(read(RUNTIME));
    expect(code).toMatch(/export async function recordConversationExecution\(/);
    expect(code).toMatch(/export function isBookingExecutionLive\(/);
  });

  it("the canonical service resolves the execution decision and records it", () => {
    const specs = importSpecifiers(codeOf(read(SERVICE)));
    expect(specs).toContain("@/lib/receptionist/conversation-execution");
    expect(specs).toContain("@/server/services/receptionist-execution");
  });
});

// =====================================================================
// 1. SINGLE WRITE PATH — exactly one module names the execution ledger write primitive.
// =====================================================================

describe("receptionist execution — exactly one module writes the ledger", () => {
  const writers = walkSources(SOURCE_ROOTS)
    .filter((full) => WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the ONLY module that names the ledger write primitive is the execution server runtime", () => {
    // If this list ever grows, a second execution-write path (or a bypass) has appeared.
    expect(writers).toEqual([RUNTIME]);
  });

  it("no app/ route, action, or component writes the ledger directly", () => {
    expect(writers.filter((p) => p.startsWith("app/"))).toEqual([]);
  });

  it("no other server/ module writes the ledger directly", () => {
    expect(writers.filter((p) => p !== RUNTIME && p.startsWith("server/"))).toEqual([]);
  });
});

// =====================================================================
// 2. The pure core is PURE and MODEL-FREE — it DECIDES, it persists nothing.
// =====================================================================

describe("receptionist execution — the pure core is pure and model-free", () => {
  const pcode = codeOf(read(CORE));

  it("is a shared pure module (NOT server-only — the runtime and tests import it)", () => {
    expect(importSpecifiers(pcode)).not.toContain("server-only");
  });

  it("its ONLY imports are the R27 action surface it consumes and the R3 policy VERDICT type", () => {
    // The action import is the predicate it CONSUMES (isActionableAction) plus its types; the policy import is
    // the GuardrailVerdict TYPE alone. No other import is permitted — and crucially it imports NO resolver and
    // NO policy decision function.
    expect(pcode).toMatch(/isActionableAction/);
    expect(pcode).toMatch(/import type \{\s*GuardrailVerdict\s*\} from "@\/lib\/receptionist\/policy"/);
    expect(importSpecifiers(pcode).sort()).toEqual(
      ["@/lib/receptionist/conversation-action", "@/lib/receptionist/policy"].sort(),
    );
  });

  it("DUPLICATES NOTHING beneath it — it re-derives no action, outcome, strategy, goal, gap, information or intent", () => {
    // It consumes ALREADY-computed inputs; it names none of the resolvers/extractors/detectors — most
    // importantly it NEVER re-resolves the action (it CONSUMES the R27 resolution) and NEVER re-runs policy.
    expect(pcode).not.toMatch(/\bresolveAction\b/);
    expect(pcode).not.toMatch(/\bresolveOutcome\b/);
    expect(pcode).not.toMatch(/\bresolveStrategy\b/);
    expect(pcode).not.toMatch(/\bresolveGoal\b/);
    expect(pcode).not.toMatch(/\bdetectGap\b/);
    expect(pcode).not.toMatch(/\bextractInformation\b/);
    expect(pcode).not.toMatch(/\bresolveConversationIntent\b/);
    expect(pcode).not.toMatch(/assembleConversationContext/);
  });

  it("touches no I/O and calls no model — it decides, it does not generate or persist", () => {
    expect(pcode).not.toMatch(/createAdminClient/);
    expect(pcode).not.toMatch(/supabase/i);
    expect(pcode).not.toMatch(/\bfetch\(/);
    expect(pcode).not.toMatch(/@\/lib\/ai\//);
    expect(pcode).not.toMatch(/Anthropic/);
    // It performs NO org lookup and NO env read — the runtime resolves the org constraint and passes it in.
    expect(pcode).not.toMatch(/process\.env/);
  });

  it("has no clock and no RNG (a decision is reconstructable)", () => {
    expect(pcode).not.toMatch(/Math\.random/);
    expect(pcode).not.toMatch(/Date\.now/);
    expect(pcode).not.toMatch(/new Date\(/);
  });
});

// =====================================================================
// 3. The Action Engine remains AUTHORITATIVE — the execution CONSUMES it and DEFERS to it.
// =====================================================================

describe("receptionist execution — the Action Engine stays authoritative", () => {
  const pcode = codeOf(read(CORE));
  const scode = codeOf(read(SERVICE));

  it("CONVERTS the prepared action — resolveExecution takes the action as its FIRST input and defers on it", () => {
    // The first gate stands down when the Action Engine prepared no action.
    expect(pcode).toMatch(/if \(!isActionableAction\(action\)\) return abstain\("no_action_prepared"\)/);
  });

  it("NEVER re-derives the action — it names isActionableAction but not resolveAction", () => {
    expect(pcode).toMatch(/isActionableAction/);
    expect(pcode).not.toMatch(/\bresolveAction\b/);
  });

  it("the action→execution map maps prepare_booking → execute_booking (it consumes the R27 vocabulary)", () => {
    expect(pcode).toMatch(/prepare_booking:\s*"execute_booking"/);
  });

  it("the service resolves the execution FROM the action (it consumes the R27 result)", () => {
    expect(scode).toMatch(/resolveExecution\(\s*action,/);
  });
});

// =====================================================================
// 4. Policy stays MANDATORY — the core CONSUMES the verdict, it never RE-RUNS policy.
// =====================================================================

describe("receptionist execution — policy is consumed, never re-run", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("imports the GuardrailVerdict TYPE but NAMES no policy decision function", () => {
    expect(importSpecifiers(pcode)).toContain("@/lib/receptionist/policy");
    // It consumes the ALREADY-computed verdict; it must re-run NONE of the guardrail's decision logic.
    expect(pcode).not.toMatch(POLICY_DECISION_FNS);
    expect(rcode).not.toMatch(POLICY_DECISION_FNS);
  });

  it("a block verdict forces blocked_by_policy in the fold (policy always refuses)", () => {
    expect(pcode).toMatch(/policyVerdict === "block"/);
    expect(pcode).toMatch(/blocked_by_policy/);
  });

  it("the runtime records the policy verdict it consumed (the fold is reconstructable from the row)", () => {
    expect(rcode).toMatch(/p_policy_verdict:/);
  });
});

// =====================================================================
// 5. Human Review stays MANDATORY — the eligibility vocabulary has NO autonomous-execute value.
// =====================================================================

describe("receptionist execution — the eligibility vocabulary is non-autonomous by construction", () => {
  const pcode = codeOf(read(CORE));
  const sql = sqlCodeOf(read(MIGRATION));

  it("the eligibility type is EXACTLY {requires_human_review, blocked_by_policy, blocked_by_org}", () => {
    expect(pcode).toMatch(/"requires_human_review"/);
    expect(pcode).toMatch(/"blocked_by_policy"/);
    expect(pcode).toMatch(/"blocked_by_org"/);
  });

  it("names NO autonomous-execute value anywhere in the core (no execute_now / autonomous execute)", () => {
    // The load-bearing R28 guarantee: there is no eligibility that authorises autonomous execution.
    expect(pcode).not.toMatch(/execute_now/i);
    expect(pcode).not.toMatch(/execute_autonomously/i);
    expect(pcode).not.toMatch(/autonomous[_-]?execut/i);
  });

  it("the strongest eligibility a booking reaches is requires_human_review (the human is the authority)", () => {
    // The else-arm of the fold — after org-enabled and non-block — is human review, never autonomous send.
    expect(pcode).toMatch(/eligibility = "requires_human_review"/);
  });

  it("the ledger CHECK-pins eligibility to the three non-autonomous values", () => {
    expect(sql).toMatch(
      /check\s*\(\s*eligibility\s+in\s*\(\s*'requires_human_review'\s*,\s*'blocked_by_policy'\s*,\s*'blocked_by_org'\s*\)\s*\)/i,
    );
  });
});

// =====================================================================
// 6. It DECIDES eligibility — it EXECUTES NO EXTERNAL business action.
// =====================================================================

describe("receptionist execution — eligibility decisions only, no external business action", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("the execution vocabulary is EXACTLY {execute_booking} — quote/scheduling execution types are absent", () => {
    expect(pcode).toMatch(/EXECUTION_TYPES\s*=\s*\[\s*"execute_booking"\s*\]/);
  });

  it("neither the core nor the runtime reaches a reply / transport / generation / booking path", () => {
    for (const code of [pcode, rcode]) {
      expect(code).not.toMatch(/dispatchReceptionistReply/);
      expect(code).not.toMatch(/record_ai_reply_transport/);
      expect(code).not.toMatch(/generateConversationResponse/);
      expect(code).not.toMatch(/transportReply/);
      expect(code).not.toMatch(/getSmsProvider/);
      expect(code).not.toMatch(/calendar/i);
    }
  });

  it("the runtime writes NO tenant row — no lead reflection, no customer promotion (the ledger IS the exposure)", () => {
    // Like the R27 action runtime (and unlike the R26 outcome runtime), an execution decision touches NO tenant
    // table: no `.from(...)` at all, no lead write, no customers. Preparing-toward-execution is a non-goal.
    expect(rcode).not.toMatch(/\.from\(/);
    expect(rcode).not.toMatch(/customers/);
    expect(rcode).not.toMatch(/\bleads\b/);
    expect(rcode).not.toMatch(/contact_phone/);
  });

  it("the runtime writes ONLY the one internal row — the execution ledger, through the write primitive", () => {
    expect(rcode).toMatch(WRITE_FN);
  });
});

// =====================================================================
// 7. The persist is BEST-EFFORT — it never gates the turn, and it never generates the confirmation.
// =====================================================================

describe("receptionist execution — the persist is best-effort, the confirmation is not generated here", () => {
  const rcode = codeOf(read(RUNTIME));

  it("SWALLOWS a failed write — it never THROWS (contrast the mandatory reply audit)", () => {
    // A durable, audited confirmation is never undone because a bookkeeping row could not be filed.
    expect(rcode).not.toMatch(/\bthrow\b/);
    expect(rcode).toMatch(/console\.error/);
    expect(rcode).toMatch(/return null/);
  });

  it("reaches no model and no reply pipeline — the confirmation flows through the UNCHANGED pipeline", () => {
    const specs = importSpecifiers(rcode);
    expect(specs).not.toContain("@/lib/ai/text");
    expect(specs.some((s) => s.startsWith("@/lib/ai/"))).toBe(false);
    expect(rcode).not.toMatch(/getTextProvider/);
  });

  it("is server-only — it is the ONE place a resolved decision is durably recorded", () => {
    expect(importSpecifiers(rcode)).toContain("server-only");
  });
});

// =====================================================================
// 8. The migration installs an APPEND-ONLY, service-role-only, NON-EXECUTING, DETERMINISTIC ledger.
// =====================================================================

describe("receptionist execution — the ledger is append-only, service-role-only, non-executing and deterministic", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("creates the receptionist_conversation_executions table", () => {
    expect(sql).toMatch(/create table if not exists public\.receptionist_conversation_executions/i);
  });

  it("captures the anchors, the decision, its inputs, the payload, the status and the metadata", () => {
    for (const column of [
      "org_id",
      "conversation_id",
      "enquiry_id",
      "lead_id",
      "customer_ref",
      "correlation_id",
      "action_id",
      "execution_type",
      "eligibility",
      "policy_verdict",
      "live_execution",
      "job_type",
      "postcode",
      "phone_number",
      "status",
      "metadata",
      "created_at",
    ]) {
      expect(sql, `column ${column}`).toMatch(new RegExp(`\\b${column}\\b`));
    }
  });

  it("bounds the execution type to the vocabulary {execute_booking}", () => {
    expect(sql).toMatch(/check\s*\(\s*execution_type\s+in\s*\(\s*'execute_booking'\s*\)\s*\)/i);
  });

  it("NON-EXECUTING BY CONSTRUCTION — status is CHECK-pinned to the single value 'decided'", () => {
    // The load-bearing R28 storage law: a row can NEVER claim an automatic external business action.
    expect(sql).toMatch(/status\s+text\s+not null\s+default\s+'decided'/i);
    expect(sql).toMatch(/check\s*\(\s*status\s*=\s*'decided'\s*\)/i);
  });

  it("DETERMINISTIC BY CONSTRUCTION — a CHECK pins eligibility to the exact fold of its inputs", () => {
    // The fold: org-disabled ⇒ blocked_by_org; else block ⇒ blocked_by_policy; else requires_human_review.
    // No writer — not even service_role — can file a row whose eligibility contradicts its inputs.
    expect(sql).toMatch(/constraint receptionist_conversation_executions_eligibility_fold check/i);
    expect(sql).toMatch(/not live_execution and eligibility = 'blocked_by_org'/i);
    expect(sql).toMatch(/live_execution and policy_verdict = 'block' and eligibility = 'blocked_by_policy'/i);
    expect(sql).toMatch(
      /live_execution and policy_verdict <> 'block' and eligibility = 'requires_human_review'/i,
    );
  });

  it("bounds the booking number to the E.164 shape and the postcode to its shape in DDL", () => {
    expect(sql).toMatch(/phone_number\s+text\s+check\s*\([\s\S]*?\+\\d\{10,15\}/i);
    expect(sql).toMatch(/postcode\s+text\s+check\s*\([\s\S]*?A-Z/i);
  });

  it("enables RLS with NO policies — service-role / SECURITY DEFINER only", () => {
    expect(sql).toMatch(
      /alter table public\.receptionist_conversation_executions enable row level security/i,
    );
    expect(sql).not.toMatch(/create policy[\s\S]*?on public\.receptionist_conversation_executions/i);
  });

  it("is APPEND-ONLY — UPDATE and DELETE are rejected by triggers", () => {
    expect(sql).toMatch(
      /create or replace function public\.receptionist_conversation_executions_block_mutation\(/i,
    );
    expect(sql).toMatch(/raise exception[\s\S]*?append-only[\s\S]*?tg_op/i);
    expect(sql).toMatch(/errcode\s*=\s*'restrict_violation'/i);
    expect(sql).toMatch(
      /create trigger receptionist_conversation_executions_no_update\s+before update on public\.receptionist_conversation_executions/i,
    );
    expect(sql).toMatch(
      /create trigger receptionist_conversation_executions_no_delete\s+before delete on public\.receptionist_conversation_executions/i,
    );
  });

  it("writes only through a SECURITY DEFINER primitive granted only to service_role", () => {
    expect(sql).toMatch(/create or replace function public\.record_receptionist_conversation_execution\(/i);
    expect(sql).toMatch(/returns uuid/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = ''/i);
    expect(sql).toMatch(/insert into public\.receptionist_conversation_executions/i);
    expect(sql).toMatch(/revoke all on function[\s\S]*?from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*?to service_role/i);
  });

  it("the write primitive re-validates the eligibility fold (belt-and-braces with the table CHECK)", () => {
    expect(sql).toMatch(/does not match the deterministic fold/i);
  });

  it("REQUIRES a job type plus a well-formed postcode and E.164 number for an execute_booking", () => {
    expect(sql).toMatch(/p_execution_type\s*=\s*'execute_booking'[\s\S]*?\+\\d\{10,15\}/i);
    expect(sql).toMatch(/p_execution_type\s*=\s*'execute_booking'[\s\S]*?p_job_type is null/i);
  });
});

// =====================================================================
// 9. The runtime decides ALONGSIDE — not instead of — the audited reply; the org gate defaults OFF.
// =====================================================================

describe("receptionist execution — decided alongside the audited reply, never bypassing the pipeline", () => {
  const scode = codeOf(read(SERVICE));
  const rcode = codeOf(read(RUNTIME));

  it("runs the UNCHANGED dispatch, records the outcome, prepares the action, THEN decides execution — in that order", () => {
    // The confirmation is produced and audited by the canonical dispatch; the outcome is recorded, the action
    // prepared, then the execution decided AFTER all, so the decision can never precede or replace the reply.
    expect(scode).toMatch(
      /const dispatch = await dispatchReceptionistReply\([\s\S]{0,2400}resolveExecution\(/,
    );
    expect(scode).toMatch(/recordConversationAction\([\s\S]{0,2400}recordConversationExecution\(/);
  });

  it("decides FROM the reply's already-computed policy verdict (Policy is not re-run)", () => {
    expect(scode).toMatch(/dispatch\.decision\?\.verdict/);
  });

  it("records ONLY for a decided decision on a REAL audited dispatch (idempotent on retries)", () => {
    // Gated on the decided predicate AND a non-null correlation id — a duplicate dispatch (null correlation)
    // records no second decision.
    expect(scode).toMatch(/isExecutionDecided\(execution\)/);
    expect(scode).toMatch(/dispatch\.correlation_id\s*!==\s*null/);
  });

  it("threads the decision to the dispatch's correlation id and the action row it decides over", () => {
    expect(scode).toMatch(/correlation_id:\s*dispatch\.correlation_id/);
    expect(scode).toMatch(/action_id:\s*recordedAction\?\.action_id/);
  });

  it("the organisational constraint is a DEFAULT-OFF feature flag read at call time", () => {
    // R28's org control mirrors R6's controlled-live-execution gate: default OFF, a genuine runtime toggle.
    expect(rcode).toMatch(/process\.env\.NEXT_PUBLIC_FEATURE_BOOKING_EXECUTION === "true"/);
  });

  it("surfaces the decision on the turn result without a second reply/generation/transport path", () => {
    expect(scode).toMatch(/execution_decided:/);
    expect(scode).toMatch(/execution_id:/);
    // The reply pipeline is still delegated WHOLE to the ONE canonical dispatch — no second send here.
    expect(scode).toMatch(/dispatchReceptionistReply\(input, assembledContext, responseSpec\)/);
  });
});

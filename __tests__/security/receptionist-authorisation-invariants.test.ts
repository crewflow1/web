import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONVERSATION AUTHORISATION ENGINE governance invariants
 * (the AI Receptionist Programme, R29 — CONVERSATION AUTHORISATION ENGINE).
 *
 * R17–R25 built the DERIVING stack; R26 added the OUTCOME ENGINE; R27 added the ACTION ENGINE; R28 added the
 * EXECUTION ENGINE — the layer that DECIDES whether a prepared action may execute. R29 is the NEXT layer: it
 * DETERMINES whether a DECIDED execution requires approval. Its law is exact — "the Authorisation Engine
 * determines APPROVAL; it must preserve Policy, Audit and Human Review as mandatory; it does not broaden
 * authority beyond the approved scope; and it EXECUTES nothing, and GRANTS nothing." This suite proves that
 * contract as a matter of SOURCE, not discipline — the house bar of
 * tool-registry-describes-not-authorises.test.ts:
 *
 *   • SINGLE WRITE PATH — across all non-test source (app/, server/, lib/), the authorisation ledger's write
 *     primitive (`record_receptionist_conversation_authorisation`) is named by EXACTLY ONE module: the
 *     authorisation server runtime. No other file can file a decision, so there is no second write path.
 *   • THE PURE CORE IS PURE, MODEL-FREE & POLICY-FREE — it reaches no server / IO / model / clock / RNG, and its
 *     ONLY import is the R28 execution predicate+types it CONSUMES. Crucially it imports NO policy module at all
 *     (R28 folded policy into the eligibility), so there is provably NO duplicate policy logic. It DETERMINES; it
 *     persists nothing.
 *   • THE EXECUTION ENGINE STAYS AUTHORITATIVE — the core CONSUMES the decided execution (imports
 *     `isExecutionDecided`, defers on it FIRST) and NEVER re-derives it (it never names `resolveExecution`), so
 *     no duplicate execution logic exists, and the Execution Engine (and transitively the Action and Outcome
 *     Engines) stays authoritative.
 *   • POLICY STAYS MANDATORY — TRANSITIVELY, NOT RE-RUN — the core imports no policy surface and NAMES no policy
 *     decision function: a `block` verdict already forced the execution to `blocked_by_policy`, which folds here
 *     to `foreclosed`. Policy's refusal PROPAGATES through the eligibility, without a re-import or a re-run.
 *   • HUMAN REVIEW STAYS MANDATORY — the TURN-TIME state vocabulary is EXACTLY {pending, foreclosed}: it
 *     structurally OMITS any grant value, so the strongest a booking reaches at decision time is `pending`. A
 *     booking is NEVER auto-approved.
 *   • IT INTEGRATES WITH HUMAN REVIEW — IT NEVER DUPLICATES THE GRANT — the grant states (`approved` / `rejected`)
 *     arise ONLY through the single bridge `deriveAuthorisationState`, folding an EXISTING review resolution the
 *     core merely READS. The runtime NAMES no human-grant writer (`record_receptionist_review_resolution`); it
 *     threads `review_audit_id` so the two ledgers JOIN.
 *   • IT DETERMINES APPROVAL — IT EXECUTES & GRANTS NOTHING — neither the core nor the runtime reaches a
 *     transport, provider, generator, calendar or booking API; the runtime writes NO tenant row — the ledger IS
 *     the exposure.
 *   • THE PERSIST IS BEST-EFFORT — the runtime SWALLOWS a failed write (returns null), it never THROWS, and it
 *     NEVER generates the confirmation — no model, no reply pipeline.
 *   • THE LEDGER IS APPEND-ONLY, SERVICE-ROLE-ONLY, NON-GRANTING & DETERMINISTIC — RLS-enabled with no policies,
 *     UPDATE/DELETE rejected by triggers, a SECURITY DEFINER writer granted only to service_role, its `status`
 *     CHECK-pinned to 'assessed', its `authorisation_state` CHECK-pinned to the two non-granting values, and a
 *     CHECK that pins (requirement, state) to the EXACT deterministic fold of the eligibility — so no row can
 *     record a non-deterministic authorisation or an autonomous grant.
 *   • THE RUNTIME AUTHORISES ALONGSIDE — NOT INSTEAD OF — THE AUDITED REPLY — the canonical service runs the
 *     UNCHANGED dispatch, records the outcome, prepares the action, decides execution, THEN authorises from that
 *     decision, gated on a real audited dispatch; R29 adds no second reply/generation/transport path, and — unlike
 *     R28 — consults NO org feature flag (the org constraint was already folded into the eligibility).
 *
 * The engine's runtime behaviour is pinned against real Postgres in
 * __tests__/integration/receptionist/conversation-authorisation-pipeline.test.ts, and the pure core's resolution
 * exhaustively in __tests__/receptionist/conversation-authorisation.test.ts. This tier is HERMETIC — a filesystem
 * scan over comment-stripped source — so the prose documenting the contract can neither satisfy a positive match
 * nor trip a negative.
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
        if (!full.endsWith("/lib/supabase/types.ts")) out.push(full);
      }
    }
  };
  for (const r of roots) visit(resolve(ROOT, r));
  return out;
}

/** A repo-relative, POSIX-style path for stable assertions across platforms. */
const rel = (full: string) => relative(ROOT, full).split(sep).join("/");

const CORE = "lib/receptionist/conversation-authorisation.ts";
const RUNTIME = "server/services/receptionist-authorisation.ts";
const SERVICE = "server/services/receptionist.ts";
const MIGRATION = "supabase/migrations/20260829000000_receptionist_conversation_authorisations.sql";

/** The authorisation ledger's write primitive — the function an auditor would call to file a decision. */
const WRITE_FN = /\brecord_receptionist_conversation_authorisation\b/;

/** The R14 human-grant writer — R29 must NAME it NOWHERE (it READS the resolution, it never re-records it). */
const REVIEW_RESOLUTION_WRITE_FN = /\brecord_receptionist_review_resolution\b/;

/** The policy DECISION functions — the core must NAME NONE (it consumes the eligibility, never re-runs policy). */
const POLICY_DECISION_FNS = /\b(?:evaluateReply|isAutoSendable|redactReply|clearForHumanSend)\b/;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

// =====================================================================
// 0. The engine, the ledger and the runtime all ship, and the service integrates them.
// =====================================================================

describe("receptionist authorisation — the engine ships and is wired", () => {
  it(`ships the append-only authorisation ledger migration ${MIGRATION}`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION)), MIGRATION).toBe(true);
  });

  it(`ships the pure core ${CORE}`, () => {
    expect(existsSync(resolve(ROOT, CORE)), CORE).toBe(true);
  });

  it(`ships the server runtime ${RUNTIME}`, () => {
    expect(existsSync(resolve(ROOT, RUNTIME)), RUNTIME).toBe(true);
  });

  it("the pure core exports the single resolution entry point, its predicate and the Human Review bridge", () => {
    const code = codeOf(read(CORE));
    expect(code).toMatch(/export function resolveAuthorisation\(/);
    expect(code).toMatch(/export function isAuthorisationDecided\(/);
    expect(code).toMatch(/export function deriveAuthorisationState\(/);
  });

  it("the server runtime exports the single record entry point", () => {
    const code = codeOf(read(RUNTIME));
    expect(code).toMatch(/export async function recordConversationAuthorisation\(/);
  });

  it("the canonical service resolves the authorisation decision and records it", () => {
    const specs = importSpecifiers(codeOf(read(SERVICE)));
    expect(specs).toContain("@/lib/receptionist/conversation-authorisation");
    expect(specs).toContain("@/server/services/receptionist-authorisation");
  });
});

// =====================================================================
// 1. SINGLE WRITE PATH — exactly one module names the authorisation ledger write primitive.
// =====================================================================

describe("receptionist authorisation — exactly one module writes the ledger", () => {
  const writers = walkSources(SOURCE_ROOTS)
    .filter((full) => WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the ONLY module that names the ledger write primitive is the authorisation server runtime", () => {
    // If this list ever grows, a second authorisation-write path (or a bypass) has appeared.
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
// 2. The pure core is PURE, MODEL-FREE and POLICY-FREE — it DETERMINES, it persists nothing.
// =====================================================================

describe("receptionist authorisation — the pure core is pure, model-free and policy-free", () => {
  const pcode = codeOf(read(CORE));

  it("is a shared pure module (NOT server-only — the runtime and tests import it)", () => {
    expect(importSpecifiers(pcode)).not.toContain("server-only");
  });

  it("its ONLY import is the R28 execution surface it consumes — NO policy, NO other module", () => {
    // The execution import is the predicate it CONSUMES (isExecutionDecided) plus its types. There is NOTHING
    // else — most importantly NO policy module (R28 already folded policy into the eligibility). This is the
    // headline R29 proof that no duplicate policy logic is introduced.
    expect(pcode).toMatch(/isExecutionDecided/);
    expect(importSpecifiers(pcode)).toEqual(["@/lib/receptionist/conversation-execution"]);
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/policy");
  });

  it("DUPLICATES NOTHING beneath it — it re-derives no execution, action, outcome, strategy, goal, gap, information or intent", () => {
    // It consumes ALREADY-computed inputs; it names none of the resolvers/extractors/detectors — most
    // importantly it NEVER re-decides the execution (it CONSUMES the R28 decision).
    expect(pcode).not.toMatch(/\bresolveExecution\b/);
    expect(pcode).not.toMatch(/\bresolveAction\b/);
    expect(pcode).not.toMatch(/\bresolveOutcome\b/);
    expect(pcode).not.toMatch(/\bresolveStrategy\b/);
    expect(pcode).not.toMatch(/\bresolveGoal\b/);
    expect(pcode).not.toMatch(/\bdetectGap\b/);
    expect(pcode).not.toMatch(/\bextractInformation\b/);
    expect(pcode).not.toMatch(/\bresolveConversationIntent\b/);
    expect(pcode).not.toMatch(/assembleConversationContext/);
  });

  it("touches no I/O and calls no model — it determines, it does not generate or persist", () => {
    expect(pcode).not.toMatch(/createAdminClient/);
    expect(pcode).not.toMatch(/supabase/i);
    expect(pcode).not.toMatch(/\bfetch\(/);
    expect(pcode).not.toMatch(/@\/lib\/ai\//);
    expect(pcode).not.toMatch(/Anthropic/);
    // It performs NO org lookup and NO env read — R29 consults no org feature flag at all.
    expect(pcode).not.toMatch(/process\.env/);
  });

  it("has no clock and no RNG (a decision is reconstructable)", () => {
    expect(pcode).not.toMatch(/Math\.random/);
    expect(pcode).not.toMatch(/Date\.now/);
    expect(pcode).not.toMatch(/new Date\(/);
  });
});

// =====================================================================
// 3. The Execution Engine remains AUTHORITATIVE — the authorisation CONSUMES it and DEFERS to it.
// =====================================================================

describe("receptionist authorisation — the Execution Engine stays authoritative", () => {
  const pcode = codeOf(read(CORE));
  const scode = codeOf(read(SERVICE));

  it("CONVERTS the decided execution — resolveAuthorisation takes it as its ONLY input and defers on it FIRST", () => {
    // The first gate stands down when the Execution Engine rendered no decision.
    expect(pcode).toMatch(
      /if \(!isExecutionDecided\(execution\)\) return abstain\("no_execution_decision"\)/,
    );
  });

  it("NEVER re-derives the execution — it names isExecutionDecided but not resolveExecution", () => {
    expect(pcode).toMatch(/isExecutionDecided/);
    expect(pcode).not.toMatch(/\bresolveExecution\b/);
  });

  it("the execution→authorisation map maps execute_booking → approve_booking (it consumes the R28 vocabulary)", () => {
    expect(pcode).toMatch(/execute_booking:\s*"approve_booking"/);
  });

  it("the service resolves the authorisation FROM the execution (it consumes the R28 result)", () => {
    expect(scode).toMatch(/resolveAuthorisation\(\s*execution\s*\)/);
  });
});

// =====================================================================
// 4. Policy stays MANDATORY — transitively, through the eligibility; the core neither imports nor re-runs it.
// =====================================================================

describe("receptionist authorisation — policy is consumed transitively, never imported or re-run", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));
  const sql = sqlCodeOf(read(MIGRATION));

  it("neither the core nor the runtime imports the policy module (the eligibility already folded the verdict)", () => {
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/policy");
    expect(importSpecifiers(rcode)).not.toContain("@/lib/receptionist/policy");
  });

  it("neither the core nor the runtime NAMES a policy decision function or the guardrail verdict type", () => {
    // R28 imported the GuardrailVerdict TYPE; R29 folds from the execution ELIGIBILITY, so it needs no policy
    // surface whatsoever — the strongest proof that no policy logic is duplicated.
    expect(pcode).not.toMatch(POLICY_DECISION_FNS);
    expect(rcode).not.toMatch(POLICY_DECISION_FNS);
    expect(pcode).not.toMatch(/GuardrailVerdict/);
    expect(rcode).not.toMatch(/GuardrailVerdict/);
  });

  it("a non-human-review eligibility folds to (not_required, foreclosed) — policy's/org's refusal propagates", () => {
    // requires_human_review ⇒ (human_approval_required, pending); ANY other eligibility (blocked_by_policy /
    // blocked_by_org) ⇒ (not_required, foreclosed). Policy's block therefore forecloses, without a re-run.
    expect(pcode).toMatch(
      /eligibility === "requires_human_review" \? "human_approval_required" : "not_required"/,
    );
    expect(pcode).toMatch(/eligibility === "requires_human_review" \? "pending" : "foreclosed"/);
  });

  it("the ledger's deterministic fold names blocked_by_policy → (not_required, foreclosed)", () => {
    expect(sql).toMatch(
      /execution_eligibility in \(\s*'blocked_by_policy'\s*,\s*'blocked_by_org'\s*\)\s*and requirement = 'not_required' and authorisation_state = 'foreclosed'/i,
    );
  });
});

// =====================================================================
// 5. Human Review stays MANDATORY — the turn-time state vocabulary has NO grant value.
// =====================================================================

describe("receptionist authorisation — the turn-time state vocabulary is non-granting by construction", () => {
  const pcode = codeOf(read(CORE));
  const sql = sqlCodeOf(read(MIGRATION));

  it("the turn-time state resolver yields ONLY pending or foreclosed (never a grant)", () => {
    expect(pcode).toMatch(/eligibility === "requires_human_review" \? "pending" : "foreclosed"/);
  });

  it("the strongest turn-time state a booking reaches is pending (the human is the authority)", () => {
    // requires_human_review is the strongest eligibility, and it folds to `pending` — never an autonomous grant.
    expect(pcode).toMatch(/"pending"/);
    expect(pcode).toMatch(/AuthorisationOpeningState/);
  });

  it("names NO autonomous-approve construct anywhere in the core", () => {
    // The load-bearing R29 guarantee: there is no turn-time state that grants approval automatically.
    expect(pcode).not.toMatch(/auto[_-]?approve/i);
    expect(pcode).not.toMatch(/approve_now/i);
    expect(pcode).not.toMatch(/autonomous[_-]?approv/i);
  });

  it("the ledger CHECK-pins authorisation_state to the two non-granting values {pending, foreclosed}", () => {
    expect(sql).toMatch(
      /check\s*\(\s*authorisation_state\s+in\s*\(\s*'pending'\s*,\s*'foreclosed'\s*\)\s*\)/i,
    );
  });
});

// =====================================================================
// 6. INTEGRATE with Human Review — NEVER DUPLICATE the grant.
// =====================================================================

describe("receptionist authorisation — integrates with Human Review, never duplicates the grant", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("the grant states arise ONLY through deriveAuthorisationState, folding an EXISTING review resolution", () => {
    // sent ⇒ approved, dismissed ⇒ rejected — produced only here, and only from a resolution the core READS.
    expect(pcode).toMatch(/resolution === "sent"\) return "approved"/);
    expect(pcode).toMatch(/resolution === "dismissed"\) return "rejected"/);
    expect(pcode).toMatch(/ReviewResolutionSignal/);
  });

  it("NEITHER the core nor the runtime records a human grant — it names no review-resolution writer", () => {
    // The grant is the human's, recorded by the UNCHANGED R14 Human Review architecture. R29 reads it; it never
    // re-records it, so there is no duplicate human-decision recorder.
    expect(pcode).not.toMatch(REVIEW_RESOLUTION_WRITE_FN);
    expect(rcode).not.toMatch(REVIEW_RESOLUTION_WRITE_FN);
  });

  it("the runtime threads the held-reply reference (review_audit_id) — the JOIN to the Human Review inbox", () => {
    expect(rcode).toMatch(/p_review_audit_id:/);
  });
});

// =====================================================================
// 7. It DETERMINES approval — it EXECUTES and GRANTS NOTHING; the persist is best-effort.
// =====================================================================

describe("receptionist authorisation — approval decisions only, no external business action, best-effort persist", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("the authorisation vocabulary is EXACTLY {approve_booking} — quote/scheduling approvals are absent", () => {
    expect(pcode).toMatch(/AUTHORISATION_TYPES\s*=\s*\[\s*"approve_booking"\s*\]/);
  });

  it("neither the core nor the runtime reaches a reply / transport / generation / booking / calendar path", () => {
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
    // Like the R27 action and R28 execution runtimes, an authorisation decision touches NO tenant table: no
    // `.from(...)` at all, no lead write, no customers. Granting and executing are non-goals.
    expect(rcode).not.toMatch(/\.from\(/);
    expect(rcode).not.toMatch(/customers/);
    expect(rcode).not.toMatch(/\bleads\b/);
    expect(rcode).not.toMatch(/contact_phone/);
  });

  it("the runtime writes ONLY the one internal row — the authorisation ledger, through the write primitive", () => {
    expect(rcode).toMatch(WRITE_FN);
  });

  it("SWALLOWS a failed write — it never THROWS (contrast the mandatory reply audit)", () => {
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
// 8. The migration installs an APPEND-ONLY, service-role-only, NON-GRANTING, DETERMINISTIC ledger.
// =====================================================================

describe("receptionist authorisation — the ledger is append-only, service-role-only, non-granting and deterministic", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("creates the receptionist_conversation_authorisations table", () => {
    expect(sql).toMatch(/create table if not exists public\.receptionist_conversation_authorisations/i);
  });

  it("captures the anchors, the decision, its input, the payload, the status and the metadata", () => {
    for (const column of [
      "org_id",
      "conversation_id",
      "enquiry_id",
      "lead_id",
      "customer_ref",
      "correlation_id",
      "action_id",
      "execution_id",
      "review_audit_id",
      "authorisation_type",
      "requirement",
      "authorisation_state",
      "execution_eligibility",
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

  it("bounds the authorisation type to the vocabulary {approve_booking}", () => {
    expect(sql).toMatch(/check\s*\(\s*authorisation_type\s+in\s*\(\s*'approve_booking'\s*\)\s*\)/i);
  });

  it("NON-GRANTING BY CONSTRUCTION — status is CHECK-pinned to the single value 'assessed'", () => {
    // The load-bearing R29 storage law: a row can NEVER claim a granted approval or an executed action.
    expect(sql).toMatch(/status\s+text\s+not null\s+default\s+'assessed'/i);
    expect(sql).toMatch(/check\s*\(\s*status\s*=\s*'assessed'\s*\)/i);
  });

  it("NON-GRANTING BY CONSTRUCTION — authorisation_state is CHECK-pinned to {pending, foreclosed} only", () => {
    // A grant value ('approved'/'rejected') is UNREPRESENTABLE here — the grant lives only in the R14 ledger.
    expect(sql).toMatch(
      /check\s*\(\s*authorisation_state\s+in\s*\(\s*'pending'\s*,\s*'foreclosed'\s*\)\s*\)/i,
    );
  });

  it("DETERMINISTIC BY CONSTRUCTION — a CHECK pins (requirement, state) to the exact fold of the eligibility", () => {
    // requires_human_review ⇒ (human_approval_required, pending); blocked_by_policy / blocked_by_org ⇒
    // (not_required, foreclosed). No writer — not even service_role — can file a row that contradicts its input.
    expect(sql).toMatch(/constraint receptionist_conversation_authorisations_state_fold check/i);
    expect(sql).toMatch(
      /execution_eligibility = 'requires_human_review'\s*and requirement = 'human_approval_required' and authorisation_state = 'pending'/i,
    );
    expect(sql).toMatch(
      /execution_eligibility in \(\s*'blocked_by_policy'\s*,\s*'blocked_by_org'\s*\)\s*and requirement = 'not_required' and authorisation_state = 'foreclosed'/i,
    );
  });

  it("bounds the booking number to the E.164 shape and the postcode to its shape in DDL", () => {
    expect(sql).toMatch(/phone_number\s+text\s+check\s*\([\s\S]*?\+\\d\{10,15\}/i);
    expect(sql).toMatch(/postcode\s+text\s+check\s*\([\s\S]*?A-Z/i);
  });

  it("enables RLS with NO policies — service-role / SECURITY DEFINER only", () => {
    expect(sql).toMatch(
      /alter table public\.receptionist_conversation_authorisations enable row level security/i,
    );
    expect(sql).not.toMatch(
      /create policy[\s\S]*?on public\.receptionist_conversation_authorisations/i,
    );
  });

  it("is APPEND-ONLY — UPDATE and DELETE are rejected by triggers", () => {
    expect(sql).toMatch(
      /create or replace function public\.receptionist_conversation_authorisations_block_mutation\(/i,
    );
    expect(sql).toMatch(/raise exception[\s\S]*?append-only[\s\S]*?tg_op/i);
    expect(sql).toMatch(/errcode\s*=\s*'restrict_violation'/i);
    expect(sql).toMatch(
      /create trigger receptionist_conversation_authorisations_no_update\s+before update on public\.receptionist_conversation_authorisations/i,
    );
    expect(sql).toMatch(
      /create trigger receptionist_conversation_authorisations_no_delete\s+before delete on public\.receptionist_conversation_authorisations/i,
    );
  });

  it("writes only through a SECURITY DEFINER primitive granted only to service_role", () => {
    expect(sql).toMatch(
      /create or replace function public\.record_receptionist_conversation_authorisation\(/i,
    );
    expect(sql).toMatch(/returns uuid/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = ''/i);
    expect(sql).toMatch(/insert into public\.receptionist_conversation_authorisations/i);
    expect(sql).toMatch(/revoke all on function[\s\S]*?from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*?to service_role/i);
  });

  it("the write primitive re-validates the (requirement, state) fold (belt-and-braces with the table CHECK)", () => {
    expect(sql).toMatch(/does not match the deterministic fold/i);
  });

  it("REQUIRES a job type plus a well-formed postcode and E.164 number for an approve_booking", () => {
    expect(sql).toMatch(/p_authorisation_type\s*=\s*'approve_booking'[\s\S]*?\+\\d\{10,15\}/i);
    expect(sql).toMatch(/p_authorisation_type\s*=\s*'approve_booking'[\s\S]*?p_job_type is null/i);
  });
});

// =====================================================================
// 9. The runtime authorises ALONGSIDE — not instead of — the audited reply; NO org feature flag.
// =====================================================================

describe("receptionist authorisation — authorised alongside the audited reply, never bypassing the pipeline", () => {
  const scode = codeOf(read(SERVICE));
  const rcode = codeOf(read(RUNTIME));

  it("runs the UNCHANGED dispatch, decides execution, THEN authorises — in that order", () => {
    // The confirmation is produced and audited by the canonical dispatch; the execution is decided, then the
    // authorisation resolved AFTER it, so the authorisation can never precede or replace the reply or the decision.
    expect(scode).toMatch(/resolveExecution\([\s\S]{0,2400}resolveAuthorisation\(/);
    expect(scode).toMatch(/recordConversationExecution\([\s\S]{0,2400}recordConversationAuthorisation\(/);
  });

  it("authorises FROM the decided execution (the Execution Engine is authoritative)", () => {
    expect(scode).toMatch(/resolveAuthorisation\(execution\)/);
  });

  it("records ONLY for a decided authorisation on a REAL audited dispatch (idempotent on retries)", () => {
    // Gated on the decided predicate AND a non-null correlation id — a duplicate dispatch (null correlation)
    // records no second decision.
    expect(scode).toMatch(/isAuthorisationDecided\(authorisation\)/);
    expect(scode).toMatch(/dispatch\.correlation_id\s*!==\s*null/);
  });

  it("threads the decision to the correlation id, the execution row and the held-reply review reference", () => {
    expect(scode).toMatch(/correlation_id:\s*dispatch\.correlation_id/);
    expect(scode).toMatch(/execution_id:\s*recordedExecution\?\.execution_id/);
    expect(scode).toMatch(/review_audit_id:\s*dispatch\.decision\?\.verdict === "review"/);
  });

  it("consults NO org feature flag — R29 reads no env (the org constraint was folded by R28)", () => {
    // Unlike the R28 runtime (a DEFAULT-OFF booking-execution flag), the authorisation runtime reads no env at
    // all: the organisational constraint was already folded into the eligibility it consumes.
    expect(rcode).not.toMatch(/process\.env/);
  });

  it("surfaces the decision on the turn result without a second reply/generation/transport path", () => {
    expect(scode).toMatch(/authorisation_recorded:/);
    expect(scode).toMatch(/authorisation_id:/);
    // The reply pipeline is still delegated WHOLE to the ONE canonical dispatch — no second send here.
    expect(scode).toMatch(/dispatchReceptionistReply\(input, assembledContext, responseSpec\)/);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONVERSATION FULFILMENT ENGINE governance invariants
 * (the AI Receptionist Programme, R30 — CONVERSATION FULFILMENT ENGINE).
 *
 * R17–R25 built the DERIVING stack; R26 RESOLVES an outcome; R27 PREPARES an action; R28 DECIDES an execution's
 * eligibility; R29 DETERMINES whether that decided execution requires APPROVAL. R30 is the NEXT layer — and, in
 * this stack, the FIRST that PERFORMS: given an APPROVED authorisation, it CARRIES OUT the approved internal
 * business operation (booking fulfilment is the first) and records it. Its law is exact — "the Fulfilment Engine
 * performs APPROVED work; it consumes the Authorisation Decision and the human's grant, it re-derives neither; it
 * preserves Policy, Audit and Human Review as mandatory; it performs the INTERNAL operation only (it reaches no
 * external system); it is idempotent (an approved booking is performed AT MOST ONCE); and it MUST NOT bypass Human
 * Review." This suite proves that contract as a matter of SOURCE, not discipline — the house bar of
 * tool-registry-describes-not-authorises.test.ts:
 *
 *   • SINGLE WRITE PATH & SINGLE READ PATH — across all non-test source (app/, server/, lib/), the fulfilment
 *     ledger's write primitive (`record_receptionist_conversation_fulfilment`) AND the pending-authorisation reader
 *     (`find_receptionist_pending_booking_authorisation`) are each named by EXACTLY ONE module: the fulfilment
 *     server runtime. No other file can perform a fulfilment, so there is no second path.
 *   • THE PURE CORE IS PURE, MODEL-FREE & POLICY-FREE — it reaches no server / IO / model / clock / RNG, and its
 *     ONLY import is the R29 authorisation predicate + types it CONSUMES. It imports NO policy module (R28 folded
 *     policy into the eligibility, R29 folded that into the authorisation), so there is provably NO duplicate policy
 *     logic. It DERIVES a decision; it persists nothing and performs nothing.
 *   • THE AUTHORISATION ENGINE STAYS AUTHORITATIVE — the core CONSUMES the decided authorisation (imports
 *     `isAuthorisationDecided`, defers on it FIRST) and NEVER re-derives it (it never names `resolveAuthorisation`),
 *     so no duplicate authorisation logic exists, and the Authorisation Engine (and transitively Execution, Action
 *     and Outcome) stays authoritative.
 *   • POLICY STAYS MANDATORY — TRANSITIVELY, NOT RE-RUN — neither the core nor the runtime imports a policy surface
 *     or NAMES a policy decision function: a `block` verdict already forced the execution to `blocked_by_policy`
 *     (R28), which R29 folded to a `foreclosed` authorisation, which can NEVER derive to `approved`. Policy's
 *     refusal PROPAGATES all the way into fulfilment, without a re-import or a re-run.
 *   • THE HUMAN REVIEW GATE IS THE KEYSTONE — the INVERSE of R29 — a fulfilment is emitted ONLY when the grant is
 *     `approved`. The pure core abstains (`approval_not_granted`) for every other terminal state; the ledger
 *     CHECK-pins `approval_state` to the single value 'approved'; and the write primitive REJECTS any other
 *     approval with "Human Review may not be bypassed". There is no path to performing un-approved work.
 *   • IT INTEGRATES WITH HUMAN REVIEW — IT NEVER DUPLICATES THE GRANT — the terminal grant arises ONLY through
 *     R29's single bridge `deriveAuthorisationState`, which the RUNTIME (not the core) reuses to fold an EXISTING
 *     `sent` resolution. Neither the core nor the runtime records a grant (`record_receptionist_review_resolution`);
 *     the runtime threads the full Human Review provenance so the ledgers JOIN.
 *   • IT PERFORMS APPROVED WORK — REACHING NO EXTERNAL SYSTEM — neither the core nor the runtime reaches a
 *     transport, provider, generator, calendar, scheduler or quote path; the runtime writes NO tenant row — the
 *     internal ledger row IS the performed operation and its audit.
 *   • IT IS IDEMPOTENT — NOT RETRY — the ledger's `authorisation_id` is UNIQUE and the writer inserts ON CONFLICT DO
 *     NOTHING (returning the existing id), so a repeat performs nothing; the runtime orchestrates no re-attempt
 *     (retry is an explicit R30 non-goal — it names no setTimeout / setInterval / backoff).
 *   • THE PERSIST IS BEST-EFFORT — the runtime SWALLOWS a failed write (returns null), it never THROWS, and it
 *     reaches no model and no reply pipeline — the confirmation and the grant flow through the UNCHANGED pipelines.
 *   • THE LEDGER IS APPEND-ONLY, SERVICE-ROLE-ONLY, APPROVED-ONLY & DETERMINISTIC — RLS-enabled with no policies,
 *     UPDATE/DELETE rejected by triggers, a SECURITY DEFINER writer granted only to service_role, its `status`
 *     CHECK-pinned to 'fulfilled', its `approval_state` CHECK-pinned to 'approved', and a CHECK that pins
 *     (fulfilment_type, fulfilment_outcome) to the EXACT deterministic fold — so no row can record an un-approved,
 *     un-reviewed or non-deterministic operation.
 *   • THE READER READS ONLY THE R29 LEDGER — a service-role-only SECURITY DEFINER `sql` function that SELECTs (never
 *     writes) the PENDING `approve_booking` authorisation behind a held reply; the approval FOLD stays in R29.
 *   • THE RUNTIME FULFILS ON SEND ONLY — DOWNSTREAM OF A HUMAN'S GRANT — it is invoked from `resolveReviewSend`
 *     (never `resolveReviewDismiss`), exactly once, strictly AFTER the durable `sent` resolution guard, so Human
 *     Review can NEVER be bypassed by construction.
 *
 * The engine's runtime behaviour is pinned against real Postgres in
 * __tests__/integration/receptionist/conversation-fulfilment-pipeline.test.ts, and the pure core's resolution
 * exhaustively in __tests__/receptionist/conversation-fulfilment.test.ts. This tier is HERMETIC — a filesystem
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

const CORE = "lib/receptionist/conversation-fulfilment.ts";
const RUNTIME = "server/services/receptionist-fulfilment.ts";
const REVIEW_SEAM = "server/services/receptionist-review.ts";
const AUTH_CORE = "lib/receptionist/conversation-authorisation.ts";
const MIGRATION = "supabase/migrations/20260830000000_receptionist_conversation_fulfilments.sql";

/** The fulfilment ledger's write primitive — the function an auditor would call to file a performed fulfilment. */
const WRITE_FN = /\brecord_receptionist_conversation_fulfilment\b/;

/** The pending-authorisation reader — the JOIN the runtime resolves the held reply's authorisation through. */
const READER_FN = /\bfind_receptionist_pending_booking_authorisation\b/;

/** The R14 human-grant writer — R30 must NAME it NOWHERE (it READS the resolution via R29, it never re-records it). */
const REVIEW_RESOLUTION_WRITE_FN = /\brecord_receptionist_review_resolution\b/;

/** The policy DECISION functions — neither core nor runtime may NAME one (policy is consumed transitively). */
const POLICY_DECISION_FNS = /\b(?:evaluateReply|isAutoSendable|redactReply|clearForHumanSend)\b/;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

// =====================================================================
// 0. The engine, the ledger and the runtime all ship, and the review SEND path integrates them.
// =====================================================================

describe("receptionist fulfilment — the engine ships and is wired", () => {
  it(`ships the append-only fulfilment ledger migration ${MIGRATION}`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION)), MIGRATION).toBe(true);
  });

  it(`ships the pure core ${CORE}`, () => {
    expect(existsSync(resolve(ROOT, CORE)), CORE).toBe(true);
  });

  it(`ships the server runtime ${RUNTIME}`, () => {
    expect(existsSync(resolve(ROOT, RUNTIME)), RUNTIME).toBe(true);
  });

  it("the pure core exports the single resolution entry point and its decided predicate", () => {
    const code = codeOf(read(CORE));
    expect(code).toMatch(/export function resolveFulfilment\(/);
    expect(code).toMatch(/export function isFulfilmentDecided\(/);
  });

  it("the server runtime exports the single fulfilment entry point", () => {
    const code = codeOf(read(RUNTIME));
    expect(code).toMatch(/export async function fulfilApprovedBooking\(/);
  });

  it("the Human Review SEND path imports the fulfilment runtime (the sole caller)", () => {
    const specs = importSpecifiers(codeOf(read(REVIEW_SEAM)));
    expect(specs).toContain("@/server/services/receptionist-fulfilment");
  });
});

// =====================================================================
// 1. SINGLE WRITE PATH & SINGLE READ PATH — exactly one module names each ledger primitive.
// =====================================================================

describe("receptionist fulfilment — exactly one module writes the ledger and one reads the authorisation", () => {
  const writers = walkSources(SOURCE_ROOTS)
    .filter((full) => WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();
  const readers = walkSources(SOURCE_ROOTS)
    .filter((full) => READER_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the ONLY module that names the ledger write primitive is the fulfilment server runtime", () => {
    // If this list ever grows, a second fulfilment-write path (or a bypass) has appeared.
    expect(writers).toEqual([RUNTIME]);
  });

  it("the ONLY module that names the pending-authorisation reader is the fulfilment server runtime", () => {
    expect(readers).toEqual([RUNTIME]);
  });

  it("no app/ route, action, or component performs a fulfilment directly", () => {
    expect(writers.filter((p) => p.startsWith("app/"))).toEqual([]);
    expect(readers.filter((p) => p.startsWith("app/"))).toEqual([]);
  });

  it("no other server/ module performs a fulfilment directly", () => {
    expect(writers.filter((p) => p !== RUNTIME && p.startsWith("server/"))).toEqual([]);
    expect(readers.filter((p) => p !== RUNTIME && p.startsWith("server/"))).toEqual([]);
  });

  it("the resolution entry point resolveFulfilment is DEFINED in exactly one module — the pure core", () => {
    // No feature implements independent fulfilment logic: the single source of truth is exported once and consumed.
    const definers = walkSources(SOURCE_ROOTS)
      .filter((full) => /export function resolveFulfilment\(/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(definers).toEqual([CORE]);
  });
});

// =====================================================================
// 2. The pure core is PURE, MODEL-FREE and POLICY-FREE — it DERIVES, it persists and performs nothing.
// =====================================================================

describe("receptionist fulfilment — the pure core is pure, model-free and policy-free", () => {
  const pcode = codeOf(read(CORE));

  it("is a shared pure module (NOT server-only — the runtime and tests import it)", () => {
    expect(importSpecifiers(pcode)).not.toContain("server-only");
  });

  it("its ONLY import is the R29 authorisation surface it consumes — NO policy, NO other module", () => {
    // The authorisation import is the predicate it CONSUMES (isAuthorisationDecided) plus its types. There is
    // NOTHING else — most importantly NO policy module. This is the headline R30 proof that no duplicate policy or
    // authorisation logic is introduced.
    expect(pcode).toMatch(/isAuthorisationDecided/);
    expect(importSpecifiers(pcode)).toEqual(["@/lib/receptionist/conversation-authorisation"]);
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/policy");
  });

  it("DUPLICATES NOTHING beneath it — it re-derives no authorisation, execution, action, outcome or lower engine", () => {
    // It consumes ALREADY-computed inputs; it names none of the resolvers/extractors/detectors — most importantly
    // it NEVER re-decides the authorisation (it CONSUMES the R29 decision) and it never re-folds the grant.
    expect(pcode).not.toMatch(/\bresolveAuthorisation\b/);
    expect(pcode).not.toMatch(/\bderiveAuthorisationState\b/);
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

  it("touches no I/O and calls no model — it derives, it does not generate, persist or perform", () => {
    expect(pcode).not.toMatch(/createAdminClient/);
    expect(pcode).not.toMatch(/supabase/i);
    expect(pcode).not.toMatch(/\bfetch\(/);
    expect(pcode).not.toMatch(/@\/lib\/ai\//);
    expect(pcode).not.toMatch(/Anthropic/);
    // It performs NO org lookup and NO env read.
    expect(pcode).not.toMatch(/process\.env/);
  });

  it("has no clock and no RNG (a decision is reconstructable)", () => {
    expect(pcode).not.toMatch(/Math\.random/);
    expect(pcode).not.toMatch(/Date\.now/);
    expect(pcode).not.toMatch(/new Date\(/);
  });

  it("names NO ledger primitive — the pure core reaches neither the writer nor the reader", () => {
    expect(pcode).not.toMatch(WRITE_FN);
    expect(pcode).not.toMatch(READER_FN);
  });
});

// =====================================================================
// 3. The Authorisation Engine remains AUTHORITATIVE — the fulfilment CONSUMES it and DEFERS to it.
// =====================================================================

describe("receptionist fulfilment — the Authorisation Engine stays authoritative", () => {
  const pcode = codeOf(read(CORE));

  it("CONSUMES the decided authorisation — resolveFulfilment defers on it FIRST", () => {
    // The first gate stands down when the Authorisation Engine rendered no decision (transitively preserving the
    // Execution, Action and Outcome Engines' authority too).
    expect(pcode).toMatch(
      /if \(!isAuthorisationDecided\(authorisation\)\) return abstain\("no_authorisation_decision"\)/,
    );
  });

  it("NEVER re-derives the authorisation — it names isAuthorisationDecided but not resolveAuthorisation", () => {
    expect(pcode).toMatch(/isAuthorisationDecided/);
    expect(pcode).not.toMatch(/\bresolveAuthorisation\b/);
  });

  it("the authorisation→fulfilment map maps approve_booking → fulfil_booking (it consumes the R29 vocabulary)", () => {
    expect(pcode).toMatch(/approve_booking:\s*"fulfil_booking"/);
  });

  it("the payload it fulfils is BY REFERENCE the authorisation's action — it can never drift from the decision", () => {
    expect(pcode).toMatch(/booking:\s*authorisation\.execution\.action/);
  });
});

// =====================================================================
// 4. Policy stays MANDATORY — transitively, through the authorisation; neither core nor runtime imports or re-runs it.
// =====================================================================

describe("receptionist fulfilment — policy is consumed transitively, never imported or re-run", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("neither the core nor the runtime imports the policy module (the authorisation already folded the verdict)", () => {
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/policy");
    expect(importSpecifiers(rcode)).not.toContain("@/lib/receptionist/policy");
  });

  it("neither the core nor the runtime NAMES a policy decision function or the guardrail verdict type", () => {
    // A policy `block` foreclosed the authorisation at R29, and a foreclosed authorisation can never derive to
    // `approved` — so a policy-blocked booking is structurally unfulfillable WITHOUT this engine touching policy.
    expect(pcode).not.toMatch(POLICY_DECISION_FNS);
    expect(rcode).not.toMatch(POLICY_DECISION_FNS);
    expect(pcode).not.toMatch(/GuardrailVerdict/);
    expect(rcode).not.toMatch(/GuardrailVerdict/);
  });
});

// =====================================================================
// 5. THE HUMAN REVIEW GATE — the R30 KEYSTONE (the inverse of R29): a fulfilment exists ONLY for an approved grant.
// =====================================================================

describe("receptionist fulfilment — the approval gate is the keystone, enforced in the core AND the ledger", () => {
  const pcode = codeOf(read(CORE));
  const sql = sqlCodeOf(read(MIGRATION));

  it("the pure core emits a fulfilment ONLY for an approved grant — every other state abstains", () => {
    // The load-bearing R30 invariant, in the core: `approval !== "approved"` yields NO fulfilment.
    expect(pcode).toMatch(/if \(approval !== "approved"\) return abstain\("approval_not_granted"\)/);
  });

  it("names NO autonomous-approve construct anywhere in the core — the grant is the human's", () => {
    expect(pcode).not.toMatch(/auto[_-]?approve/i);
    expect(pcode).not.toMatch(/approve_now/i);
    expect(pcode).not.toMatch(/autonomous[_-]?approv/i);
  });

  it("APPROVED BY CONSTRUCTION — the ledger CHECK-pins approval_state to the single value 'approved'", () => {
    // The INVERSE of R29 (whose authorisation_state can never BE a grant): here a row can ONLY be an approved one.
    expect(sql).toMatch(/check\s*\(\s*approval_state\s*=\s*'approved'\s*\)/i);
  });

  it("PERFORMED BY CONSTRUCTION — the ledger CHECK-pins status to the single value 'fulfilled'", () => {
    expect(sql).toMatch(/status\s+text\s+not null\s+default\s+'fulfilled'/i);
    expect(sql).toMatch(/check\s*\(\s*status\s*=\s*'fulfilled'\s*\)/i);
  });

  it("the write primitive REJECTS any non-approved authorisation — 'Human Review may not be bypassed'", () => {
    expect(sql).toMatch(/p_approval_state\s*<>\s*'approved'/i);
    expect(sql).toMatch(/Human Review may not be bypassed/i);
  });
});

// =====================================================================
// 6. INTEGRATE with Human Review — NEVER DUPLICATE the grant. The grant is R29's, reused by the runtime only.
// =====================================================================

describe("receptionist fulfilment — integrates with Human Review, never duplicates the grant", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("the grant is folded ONLY through R29's bridge, and ONLY in the runtime (never the core)", () => {
    // deriveAuthorisationState lives in R29; the runtime reuses it to fold an EXISTING `sent` resolution. The core
    // never folds the grant — it receives the already-derived terminal state. No duplicate approval logic.
    expect(rcode).toMatch(/\bderiveAuthorisationState\b/);
    expect(pcode).not.toMatch(/\bderiveAuthorisationState\b/);
  });

  it("NEITHER the core nor the runtime records a human grant — it names no review-resolution writer", () => {
    // The grant is the human's, recorded by the UNCHANGED R14 Human Review architecture. R30 reads it; it never
    // re-records it, so there is no duplicate human-decision recorder.
    expect(pcode).not.toMatch(REVIEW_RESOLUTION_WRITE_FN);
    expect(rcode).not.toMatch(REVIEW_RESOLUTION_WRITE_FN);
  });

  it("the runtime threads the FULL Human Review provenance — the held reply, the sent reply and the resolution", () => {
    expect(rcode).toMatch(/p_review_audit_id:/);
    expect(rcode).toMatch(/p_sent_audit_id:/);
    expect(rcode).toMatch(/p_review_resolution_id:/);
  });
});

// =====================================================================
// 7. It PERFORMS approved work — reaching NO external system; idempotent (not retry); best-effort.
// =====================================================================

describe("receptionist fulfilment — performs the internal operation only, idempotently, best-effort", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("the fulfilment vocabulary is EXACTLY {fulfil_booking} — scheduling/quote/promotion fulfilments are absent", () => {
    expect(pcode).toMatch(/FULFILMENT_TYPES\s*=\s*\[\s*"fulfil_booking"\s*\]/);
  });

  it("neither the core nor the runtime reaches a transport / generation / calendar / scheduler / quote path", () => {
    for (const code of [pcode, rcode]) {
      expect(code).not.toMatch(/dispatchReceptionistReply/);
      expect(code).not.toMatch(/record_ai_reply_transport/);
      expect(code).not.toMatch(/generateConversationResponse/);
      expect(code).not.toMatch(/transportReply/);
      expect(code).not.toMatch(/getSmsProvider/);
      expect(code).not.toMatch(/calendar/i);
      expect(code).not.toMatch(/\bschedule\b/i);
      expect(code).not.toMatch(/\bquote\b/i);
    }
  });

  it("the runtime writes NO tenant row — no lead reflection, no customer promotion (the ledger IS the operation)", () => {
    // Like the R27–R29 runtimes, a fulfilment touches NO tenant table: no `.from(...)` at all, no lead write, no
    // customers. Scheduling, promotion and external writes are non-goals.
    expect(rcode).not.toMatch(/\.from\(/);
    expect(rcode).not.toMatch(/customers/);
    expect(rcode).not.toMatch(/\bleads\b/);
    expect(rcode).not.toMatch(/contact_phone/);
  });

  it("the runtime writes ONLY the one internal row — the fulfilment ledger, through the write primitive", () => {
    expect(rcode).toMatch(WRITE_FN);
  });

  it("IDEMPOTENT, NOT RETRY — it names no re-attempt orchestration (retry is an explicit R30 non-goal)", () => {
    expect(rcode).not.toMatch(/\bretry\b/i);
    expect(rcode).not.toMatch(/setTimeout/);
    expect(rcode).not.toMatch(/setInterval/);
    expect(rcode).not.toMatch(/backoff/i);
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

  it("is server-only — it is the ONE place an approved fulfilment is durably performed", () => {
    expect(importSpecifiers(rcode)).toContain("server-only");
  });
});

// =====================================================================
// 8. The migration installs an APPEND-ONLY, service-role-only, APPROVED-ONLY, DETERMINISTIC, IDEMPOTENT ledger.
// =====================================================================

describe("receptionist fulfilment — the ledger is append-only, service-role-only, approved-only and idempotent", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("creates the receptionist_conversation_fulfilments table", () => {
    expect(sql).toMatch(/create table if not exists public\.receptionist_conversation_fulfilments/i);
  });

  it("captures the anchors, the Human Review provenance, the operation, its payload, the status and the metadata", () => {
    for (const column of [
      "org_id",
      "conversation_id",
      "enquiry_id",
      "lead_id",
      "customer_ref",
      "correlation_id",
      "action_id",
      "execution_id",
      "authorisation_id",
      "review_audit_id",
      "sent_audit_id",
      "review_resolution_id",
      "fulfilment_type",
      "fulfilment_outcome",
      "approval_state",
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

  it("bounds the fulfilment type and outcome to their vocabularies {fulfil_booking} / {booking_recorded}", () => {
    expect(sql).toMatch(/check\s*\(\s*fulfilment_type\s+in\s*\(\s*'fulfil_booking'\s*\)\s*\)/i);
    expect(sql).toMatch(/check\s*\(\s*fulfilment_outcome\s+in\s*\(\s*'booking_recorded'\s*\)\s*\)/i);
  });

  it("DETERMINISTIC BY CONSTRUCTION — a CHECK pins (fulfilment_type, fulfilment_outcome) to the exact fold", () => {
    // fulfil_booking ⇒ booking_recorded. No writer — not even service_role — can file a row whose outcome
    // contradicts its type.
    expect(sql).toMatch(/constraint receptionist_conversation_fulfilments_outcome_fold check/i);
    expect(sql).toMatch(
      /fulfilment_type = 'fulfil_booking' and fulfilment_outcome = 'booking_recorded'/i,
    );
  });

  it("IDEMPOTENT BY CONSTRUCTION — authorisation_id is UNIQUE and the writer inserts ON CONFLICT DO NOTHING", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_fulfilments_authorisation_unique unique \(authorisation_id\)/i,
    );
    expect(sql).toMatch(/on conflict \(authorisation_id\) do nothing/i);
    // On a repeat, the primitive resolves the existing row's id so the operation is a true no-op.
    expect(sql).toMatch(/select id into v_id[\s\S]*?where authorisation_id = p_authorisation_id/i);
  });

  it("bounds the booking number to the E.164 shape and the postcode to its shape in DDL", () => {
    expect(sql).toMatch(/phone_number\s+text\s+check\s*\([\s\S]*?\+\\d\{10,15\}/i);
    expect(sql).toMatch(/postcode\s+text\s+check\s*\([\s\S]*?A-Z/i);
  });

  it("enables RLS with NO policies — service-role / SECURITY DEFINER only", () => {
    expect(sql).toMatch(
      /alter table public\.receptionist_conversation_fulfilments enable row level security/i,
    );
    expect(sql).not.toMatch(/create policy[\s\S]*?on public\.receptionist_conversation_fulfilments/i);
  });

  it("is APPEND-ONLY — UPDATE and DELETE are rejected by triggers", () => {
    expect(sql).toMatch(
      /create or replace function public\.receptionist_conversation_fulfilments_block_mutation\(/i,
    );
    expect(sql).toMatch(/raise exception[\s\S]*?append-only[\s\S]*?tg_op/i);
    expect(sql).toMatch(/errcode\s*=\s*'restrict_violation'/i);
    expect(sql).toMatch(
      /create trigger receptionist_conversation_fulfilments_no_update\s+before update on public\.receptionist_conversation_fulfilments/i,
    );
    expect(sql).toMatch(
      /create trigger receptionist_conversation_fulfilments_no_delete\s+before delete on public\.receptionist_conversation_fulfilments/i,
    );
  });

  it("writes only through a SECURITY DEFINER primitive granted only to service_role", () => {
    expect(sql).toMatch(
      /create or replace function public\.record_receptionist_conversation_fulfilment\(/i,
    );
    expect(sql).toMatch(/returns uuid/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = ''/i);
    expect(sql).toMatch(/insert into public\.receptionist_conversation_fulfilments/i);
    expect(sql).toMatch(/revoke all on function[\s\S]*?from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*?to service_role/i);
  });

  it("the write primitive re-validates the (type, outcome) fold (belt-and-braces with the table CHECK)", () => {
    expect(sql).toMatch(/does not match the deterministic fold/i);
  });

  it("REQUIRES the full Human Review provenance and a well-formed booking payload for a fulfil_booking", () => {
    // The authorisation anchor plus the three provenance ids are mandatory...
    expect(sql).toMatch(
      /p_review_audit_id is null[\s\S]*?p_sent_audit_id is null[\s\S]*?p_review_resolution_id is null/i,
    );
    // ...and a fulfil_booking must carry a job type plus a well-formed postcode and E.164 number.
    expect(sql).toMatch(/p_fulfilment_type\s*=\s*'fulfil_booking'[\s\S]*?\+\\d\{10,15\}/i);
    expect(sql).toMatch(/p_fulfilment_type\s*=\s*'fulfil_booking'[\s\S]*?p_job_type is null/i);
  });
});

// =====================================================================
// 9. The READER reads only the R29 ledger; the runtime fulfils ALONGSIDE the audited reply, on SEND only.
// =====================================================================

describe("receptionist fulfilment — the reader is read-only over R29, and fulfilment fires on SEND only", () => {
  const sql = sqlCodeOf(read(MIGRATION));
  const seam = codeOf(read(REVIEW_SEAM));

  it("the reader is a service-role-only SECURITY DEFINER sql function granted only to service_role", () => {
    expect(sql).toMatch(
      /create or replace function public\.find_receptionist_pending_booking_authorisation\(/i,
    );
    expect(sql).toMatch(
      /revoke all on function public\.find_receptionist_pending_booking_authorisation\(uuid, uuid\)\s*from public, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.find_receptionist_pending_booking_authorisation\(uuid, uuid\)\s*to service_role/i,
    );
  });

  it("the reader READS ONLY the R29 authorisation ledger, filtered to a PENDING approve_booking — it never writes", () => {
    // Slice the reader function body (from its definition to its revoke) and prove it is a pure SELECT.
    const start = sql.indexOf("function public.find_receptionist_pending_booking_authorisation");
    const body = sql.slice(start, sql.indexOf("revoke all on function", start));
    expect(body).toMatch(/language sql/i);
    expect(body).toMatch(/security definer/i);
    expect(body).toMatch(/from public\.receptionist_conversation_authorisations/i);
    expect(body).toMatch(/a\.authorisation_type = 'approve_booking'/i);
    expect(body).toMatch(/a\.authorisation_state = 'pending'/i);
    expect(body).toMatch(/a\.status = 'assessed'/i);
    // The approval FOLD stays in R29 — the reader supplies the row, it never decides approval, and never mutates.
    expect(body).not.toMatch(/\binsert\b/i);
    expect(body).not.toMatch(/\bupdate\b/i);
    expect(body).not.toMatch(/\bdelete\b/i);
  });

  it("the SEND path invokes the Fulfilment Engine EXACTLY ONCE", () => {
    const calls = seam.match(/fulfilApprovedBooking\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("fulfilment is invoked from resolveReviewSend — NEVER from resolveReviewDismiss", () => {
    // Prove placement structurally: the call lives between the two function definitions (inside SEND), and the
    // DISMISS body — everything from its definition onward — names the engine NOWHERE.
    const sendIdx = seam.indexOf("resolveReviewSend");
    const dismissIdx = seam.indexOf("resolveReviewDismiss");
    expect(sendIdx).toBeGreaterThan(-1);
    expect(dismissIdx).toBeGreaterThan(sendIdx);
    const sendBody = seam.slice(sendIdx, dismissIdx);
    const dismissBody = seam.slice(dismissIdx);
    expect(sendBody).toMatch(/fulfilApprovedBooking\(/);
    expect(dismissBody).not.toMatch(/fulfilApprovedBooking\(/);
  });

  it("fulfilment fires STRICTLY AFTER the durable `sent` resolution guard, gated on a real sent audit", () => {
    // Human Review can never be bypassed: the call is downstream of the `resolutionId === null ⇒ already_resolved`
    // guard (so a concurrent resolver can't double-fulfil) and only when the send produced an audit.
    const sendIdx = seam.indexOf("resolveReviewSend");
    const dismissIdx = seam.indexOf("resolveReviewDismiss");
    const sendBody = seam.slice(sendIdx, dismissIdx);
    const guardIdx = sendBody.indexOf('"already_resolved", outcome');
    const fulfilIdx = sendBody.indexOf("fulfilApprovedBooking(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fulfilIdx).toBeGreaterThan(guardIdx);
    expect(sendBody).toMatch(/if \(outcome\.audit_id !== null\)/);
  });
});

// =====================================================================
// 10. The R29 authorisation core stays the SOLE authority the fulfilment engine consumes.
// =====================================================================

describe("receptionist fulfilment — it consumes the R29 authorisation core, and re-derives nothing", () => {
  it("the R29 authorisation core ships (the surface the fulfilment engine consumes)", () => {
    expect(existsSync(resolve(ROOT, AUTH_CORE)), AUTH_CORE).toBe(true);
  });

  it("the runtime reconstructs the authorisation and folds the grant — it re-authorises nothing", () => {
    const rcode = codeOf(read(RUNTIME));
    // It rebuilds the R29 authorisation from the reader row and folds the grant through R29's bridge, but it names
    // NO resolver of its own — the Authorisation Engine is authoritative.
    expect(rcode).toMatch(/kind:\s*"approve_booking"/);
    expect(rcode).toMatch(/\bderiveAuthorisationState\b/);
    expect(rcode).not.toMatch(/\bresolveAuthorisation\b/);
    expect(rcode).not.toMatch(/\bresolveExecution\b/);
    expect(rcode).not.toMatch(/\bresolveAction\b/);
  });
});

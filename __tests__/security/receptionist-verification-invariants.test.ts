import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONVERSATION VERIFICATION ENGINE governance invariants
 * (the AI Receptionist Programme, R31 — CONVERSATION VERIFICATION ENGINE).
 *
 * R17–R25 built the DERIVING stack; R26 RESOLVES an outcome; R27 PREPARES an action; R28 DECIDES an execution's
 * eligibility; R29 DETERMINES whether that decided execution requires APPROVAL; R30 PERFORMS the approved internal
 * business operation (booking fulfilment). R31 is the NEXT layer — and, in this stack, the FIRST that VERIFIES:
 * given a DECIDED fulfilment and the durable record R30 filed beside it, it RECONCILES the two and records an
 * auditable INTEGRITY verdict. Its law is exact — "the Verification Engine VERIFIES fulfilled work; it consumes the
 * Fulfilment Decision (re-deriving nothing) and reads the recorded operation; it produces a verdict
 * (consistent / missing / inconsistent), never a business action; it preserves Policy, Audit and Human Review as
 * mandatory (transitively, through the fulfilment it consumes); it is idempotent (an approved fulfilment is verified
 * AT MOST ONCE); and it MUST NOT bypass Human Review, perform a fulfilment, or duplicate any lower engine's logic."
 * This suite proves that contract as a matter of SOURCE, not discipline — the house bar of
 * tool-registry-describes-not-authorises.test.ts:
 *
 *   • SINGLE WRITE PATH & SINGLE READ PATH — across all non-test source (app/, server/, lib/), the verification
 *     ledger's write primitive (`record_receptionist_conversation_verification`) AND the reconciliation reader
 *     (`find_receptionist_fulfilment_reconciliation`) are each named by EXACTLY ONE module: the verification server
 *     runtime. No other file can file a verification, so there is no second path.
 *   • THE PURE CORE IS PURE, MODEL-FREE & POLICY-FREE — it reaches no server / IO / model / clock / RNG, and its
 *     ONLY import is the R30 fulfilment surface it CONSUMES. It imports NO policy module, NO authorisation module and
 *     NO other engine — R30 folded the whole stack (policy, execution, action, outcome, approval) into the fulfilment
 *     decision — so there is provably NO duplicate logic. It DERIVES a verdict; it persists nothing and verifies
 *     nothing itself.
 *   • THE FULFILMENT ENGINE STAYS AUTHORITATIVE — the core CONSUMES the decided fulfilment (imports
 *     `isFulfilmentDecided`, defers on it FIRST) and NEVER re-derives it (it never names `resolveFulfilment`), so no
 *     duplicate fulfilment logic exists, and the Fulfilment Engine (and transitively Authorisation, Execution,
 *     Action and Outcome) stays authoritative.
 *   • POLICY & HUMAN REVIEW STAY MANDATORY — TRANSITIVELY, NOT RE-RUN — neither the core nor the runtime imports a
 *     policy surface or NAMES a policy decision function: a decided fulfilment exists ONLY for an approved,
 *     policy-cleared operation (R30's keystone), so a policy-blocked or un-approved booking is structurally
 *     UNVERIFIABLE without this engine touching policy or re-deciding approval.
 *   • THE APPROVAL GATE IS INHERITED, AND RE-PINNED AT STORAGE — the core emits a verification ONLY for a decided
 *     fulfilment (which only exists for an `approved` grant), so the approval gate is inherited via the FIRST defer;
 *     the ledger CHECK-pins `approval_state` to the single value 'approved' and `status` to 'verified'; and the write
 *     primitive REJECTS any other approval with "Human Review may not be bypassed". There is no path to verifying
 *     un-approved work.
 *   • INTEGRITY IS A COHERENT VERDICT — THE R31 KEYSTONE — a CHECK (and the write primitive) pin
 *     (fulfilment_id is null) = (integrity = 'missing'): a stored verdict can NEVER contradict the presence of the
 *     record it claims to have reconciled. `missing` iff no fulfilment; `consistent`/`inconsistent` iff a fulfilment.
 *   • IT INTEGRATES WITH HUMAN REVIEW — IT NEVER DUPLICATES THE GRANT — the terminal grant arises ONLY through R29's
 *     single bridge `deriveAuthorisationState`, which the RUNTIME (not the core) reuses to fold an EXISTING `sent`
 *     resolution. Neither the core nor the runtime records a grant (`record_receptionist_review_resolution`); the
 *     runtime threads the full Human Review provenance so the ledgers JOIN.
 *   • IT VERIFIES WORK — IT PERFORMS NONE — neither the core nor the runtime reaches a transport, provider,
 *     generator, calendar, scheduler or quote path, AND — the load-bearing R31 proof — the runtime NAMES NO R30
 *     fulfilment writer (`record_receptionist_conversation_fulfilment`): it re-derives the EXPECTED fulfilment through
 *     R30's PURE `resolveFulfilment`, but it PERFORMS no fulfilment and writes NO tenant row. The verification ledger
 *     row IS the verdict and its audit.
 *   • IT IS IDEMPOTENT — NOT RETRY — the ledger's `authorisation_id` is UNIQUE and the writer inserts ON CONFLICT DO
 *     NOTHING (returning the existing id), so a repeat verifies nothing; the runtime orchestrates no re-attempt
 *     (retry is an explicit R31 non-goal — it names no setTimeout / setInterval / backoff).
 *   • THE PERSIST IS BEST-EFFORT — the runtime SWALLOWS a failed write (returns null), it never THROWS, and it
 *     reaches no model and no reply pipeline — the confirmation, the grant and the fulfilment flow through the
 *     UNCHANGED pipelines.
 *   • THE LEDGER IS APPEND-ONLY, SERVICE-ROLE-ONLY, APPROVED-ONLY, DETERMINISTIC & INTEGRITY-COHERENT — RLS-enabled
 *     with no policies, UPDATE/DELETE rejected by triggers, a SECURITY DEFINER writer granted only to service_role,
 *     its `status` CHECK-pinned to 'verified', its `approval_state` CHECK-pinned to 'approved', a CHECK that pins
 *     (verification_type, verification_outcome) to the EXACT deterministic fold, and the coherence CHECK above.
 *   • THE READER RECONCILES BOTH LEDGERS — a service-role-only SECURITY DEFINER `sql` function that SELECTs (never
 *     writes) the PENDING `approve_booking` authorisation behind a held reply LEFT JOINed to the fulfilment R30 filed
 *     for it; the approval FOLD stays in R29 and the EXPECTED shape stays in R30.
 *   • THE RUNTIME VERIFIES ON SEND ONLY — STRICTLY AFTER R30 — it is invoked from `resolveReviewSend` (never
 *     `resolveReviewDismiss`), exactly once, strictly AFTER the durable `sent` resolution guard AND strictly AFTER
 *     the R30 fulfilment call, so Human Review can NEVER be bypassed and R31 always re-reads a committed R30 row.
 *   • IT DOES NOT BREAK R30 — R31 adds a VERIFIER, not a second PERFORMER: R30's fulfilment write primitive and its
 *     pending-authorisation reader are STILL each named by exactly one module (the R30 runtime), and the SEND path
 *     STILL invokes `fulfilApprovedBooking` exactly once. R31's modules name neither R30 primitive.
 *
 * The engine's runtime behaviour is pinned against real Postgres in
 * __tests__/integration/receptionist/conversation-verification-pipeline.test.ts, and the pure core's resolution
 * exhaustively in __tests__/receptionist/conversation-verification.test.ts. This tier is HERMETIC — a filesystem
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
        out.push(full);
      }
    }
  };
  for (const r of roots) visit(resolve(ROOT, r));
  return out;
}

/** A repo-relative, POSIX-style path for stable assertions across platforms. */
const rel = (full: string) => relative(ROOT, full).split(sep).join("/");

const CORE = "lib/receptionist/conversation-verification.ts";
const RUNTIME = "server/services/receptionist-verification.ts";
const REVIEW_SEAM = "server/services/receptionist-review.ts";
const FULFILMENT_CORE = "lib/receptionist/conversation-fulfilment.ts";
const MIGRATION = "supabase/migrations/20260831000000_receptionist_conversation_verifications.sql";

/** The verification ledger's write primitive — the function an auditor would call to file a verification verdict. */
const WRITE_FN = /\brecord_receptionist_conversation_verification\b/;

/** The reconciliation reader — the JOIN the runtime resolves both sides (authorisation + fulfilment) through. */
const READER_FN = /\bfind_receptionist_fulfilment_reconciliation\b/;

/** R30's fulfilment WRITE primitive — R31 must NAME it NOWHERE (it VERIFIES fulfilled work, it never PERFORMS it). */
const FULFIL_WRITE_FN = /\brecord_receptionist_conversation_fulfilment\b/;

/** R30's pending-authorisation reader — R31 uses its OWN reconciliation reader, so R31 must NAME this NOWHERE. */
const FULFIL_READER_FN = /\bfind_receptionist_pending_booking_authorisation\b/;

/** The R14 human-grant writer — R31 must NAME it NOWHERE (it READS the resolution via R29, it never re-records it). */
const REVIEW_RESOLUTION_WRITE_FN = /\brecord_receptionist_review_resolution\b/;

/** The policy DECISION functions — neither core nor runtime may NAME one (policy is consumed transitively). */
const POLICY_DECISION_FNS = /\b(?:evaluateReply|isAutoSendable|redactReply|clearForHumanSend)\b/;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

// =====================================================================
// 0. The engine, the ledger and the runtime all ship, and the review SEND path integrates them.
// =====================================================================

describe("receptionist verification — the engine ships and is wired", () => {
  it(`ships the append-only verification ledger migration ${MIGRATION}`, () => {
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
    expect(code).toMatch(/export function resolveVerification\(/);
    expect(code).toMatch(/export function isVerificationDecided\(/);
  });

  it("the server runtime exports the single verification entry point", () => {
    const code = codeOf(read(RUNTIME));
    expect(code).toMatch(/export async function verifyApprovedFulfilment\(/);
  });

  it("the Human Review SEND path imports the verification runtime (the sole caller)", () => {
    const specs = importSpecifiers(codeOf(read(REVIEW_SEAM)));
    expect(specs).toContain("@/server/services/receptionist-verification");
  });
});

// =====================================================================
// 1. SINGLE WRITE PATH & SINGLE READ PATH — exactly one module names each ledger primitive.
// =====================================================================

describe("receptionist verification — exactly one module writes the ledger and one reads the reconciliation", () => {
  const writers = walkSources(SOURCE_ROOTS)
    .filter((full) => WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();
  const readers = walkSources(SOURCE_ROOTS)
    .filter((full) => READER_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the ONLY module that names the ledger write primitive is the verification server runtime", () => {
    // If this list ever grows, a second verification-write path (or a bypass) has appeared.
    expect(writers).toEqual([RUNTIME]);
  });

  it("the ONLY module that names the reconciliation reader is the verification server runtime", () => {
    expect(readers).toEqual([RUNTIME]);
  });

  it("no app/ route, action, or component files a verification directly", () => {
    expect(writers.filter((p) => p.startsWith("app/"))).toEqual([]);
    expect(readers.filter((p) => p.startsWith("app/"))).toEqual([]);
  });

  it("no other server/ module files a verification directly", () => {
    expect(writers.filter((p) => p !== RUNTIME && p.startsWith("server/"))).toEqual([]);
    expect(readers.filter((p) => p !== RUNTIME && p.startsWith("server/"))).toEqual([]);
  });

  it("the resolution entry point resolveVerification is DEFINED in exactly one module — the pure core", () => {
    // No feature implements independent verification logic: the single source of truth is exported once and consumed.
    const definers = walkSources(SOURCE_ROOTS)
      .filter((full) => /export function resolveVerification\(/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(definers).toEqual([CORE]);
  });
});

// =====================================================================
// 2. The pure core is PURE, MODEL-FREE and POLICY-FREE — it CONSUMES the fulfilment surface, and nothing else.
// =====================================================================

describe("receptionist verification — the pure core is pure, model-free and policy-free", () => {
  const pcode = codeOf(read(CORE));

  it("is a shared pure module (NOT server-only — the runtime and tests import it)", () => {
    expect(importSpecifiers(pcode)).not.toContain("server-only");
  });

  it("its ONLY import is the R30 fulfilment surface it consumes — NO policy, NO authorisation, NO other module", () => {
    // The fulfilment import is the predicate it CONSUMES (isFulfilmentDecided) plus its types. There is NOTHING else
    // — most importantly NO policy module and NO authorisation module (R30 already folded the whole stack into the
    // fulfilment decision). This is the headline R31 proof that no duplicate policy, authorisation or fulfilment
    // logic is introduced.
    expect(pcode).toMatch(/isFulfilmentDecided/);
    expect(importSpecifiers(pcode)).toEqual(["@/lib/receptionist/conversation-fulfilment"]);
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/policy");
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/conversation-authorisation");
  });

  it("DUPLICATES NOTHING beneath it — it re-derives no fulfilment, authorisation, execution, action or outcome", () => {
    // It consumes ALREADY-computed inputs; it names none of the resolvers/extractors/detectors — most importantly it
    // NEVER re-derives the fulfilment (it CONSUMES the R30 decision via isFulfilmentDecided) and it never re-folds
    // the grant. This is the R31 analogue of R30's "never names resolveAuthorisation".
    expect(pcode).not.toMatch(/\bresolveFulfilment\b/);
    expect(pcode).not.toMatch(/\bderiveAuthorisationState\b/);
    expect(pcode).not.toMatch(/\bresolveAuthorisation\b/);
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

  it("touches no I/O and calls no model — it derives, it does not generate, persist or verify", () => {
    expect(pcode).not.toMatch(/createAdminClient/);
    expect(pcode).not.toMatch(/supabase/i);
    expect(pcode).not.toMatch(/\bfetch\(/);
    expect(pcode).not.toMatch(/@\/lib\/ai\//);
    expect(pcode).not.toMatch(/Anthropic/);
    // It performs NO org lookup and NO env read.
    expect(pcode).not.toMatch(/process\.env/);
  });

  it("has no clock and no RNG (a verdict is reconstructable)", () => {
    expect(pcode).not.toMatch(/Math\.random/);
    expect(pcode).not.toMatch(/Date\.now/);
    expect(pcode).not.toMatch(/new Date\(/);
  });

  it("names NO ledger primitive — the pure core reaches neither the writer nor the reader (its own or R30's)", () => {
    expect(pcode).not.toMatch(WRITE_FN);
    expect(pcode).not.toMatch(READER_FN);
    expect(pcode).not.toMatch(FULFIL_WRITE_FN);
    expect(pcode).not.toMatch(FULFIL_READER_FN);
  });
});

// =====================================================================
// 3. The Fulfilment Engine remains AUTHORITATIVE — the verification CONSUMES it and DEFERS to it.
// =====================================================================

describe("receptionist verification — the Fulfilment Engine stays authoritative", () => {
  const pcode = codeOf(read(CORE));

  it("CONSUMES the decided fulfilment — resolveVerification defers on it FIRST", () => {
    // The first gate stands down when the Fulfilment Engine rendered no decision (transitively preserving the
    // Authorisation, Execution, Action and Outcome Engines' authority too — a decided fulfilment only exists for an
    // approved authorisation).
    expect(pcode).toMatch(
      /if \(!isFulfilmentDecided\(fulfilment\)\) return abstain\("no_fulfilment_decision"\)/,
    );
  });

  it("NEVER re-derives the fulfilment — it names isFulfilmentDecided but not resolveFulfilment", () => {
    expect(pcode).toMatch(/isFulfilmentDecided/);
    expect(pcode).not.toMatch(/\bresolveFulfilment\b/);
  });

  it("the fulfilment→verification map maps fulfil_booking → verify_booking_fulfilment (it consumes the R30 vocabulary)", () => {
    expect(pcode).toMatch(/fulfil_booking:\s*"verify_booking_fulfilment"/);
  });

  it("the booking it verifies is BY REFERENCE the fulfilment's payload — it can never drift from the decision", () => {
    expect(pcode).toMatch(/booking:\s*fulfilment\.booking/);
  });
});

// =====================================================================
// 4. Policy stays MANDATORY — transitively, through the fulfilment; neither core nor runtime imports or re-runs it.
// =====================================================================

describe("receptionist verification — policy is consumed transitively, never imported or re-run", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("neither the core nor the runtime imports the policy module (the fulfilment already folded the verdict)", () => {
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/policy");
    expect(importSpecifiers(rcode)).not.toContain("@/lib/receptionist/policy");
  });

  it("neither the core nor the runtime NAMES a policy decision function or the guardrail verdict type", () => {
    // A policy `block` foreclosed the authorisation at R29, foreclosed can never derive to `approved`, and an
    // un-approved authorisation is never fulfilled at R30 — so a policy-blocked booking is structurally UNVERIFIABLE
    // WITHOUT this engine touching policy.
    expect(pcode).not.toMatch(POLICY_DECISION_FNS);
    expect(rcode).not.toMatch(POLICY_DECISION_FNS);
    expect(pcode).not.toMatch(/GuardrailVerdict/);
    expect(rcode).not.toMatch(/GuardrailVerdict/);
  });
});

// =====================================================================
// 5. THE APPROVAL GATE — inherited from R30 via the FIRST defer, and re-pinned at the storage layer.
// =====================================================================

describe("receptionist verification — the approval gate is inherited, and re-pinned in the ledger", () => {
  const pcode = codeOf(read(CORE));
  const sql = sqlCodeOf(read(MIGRATION));

  it("the pure core emits a verification ONLY for a DECIDED fulfilment — the approval gate is inherited", () => {
    // R31's core has no approval literal of its own: a decided fulfilment exists ONLY for an `approved` grant (R30's
    // keystone), so deferring to isFulfilmentDecided FIRST inherits the approval gate transitively.
    expect(pcode).toMatch(
      /if \(!isFulfilmentDecided\(fulfilment\)\) return abstain\("no_fulfilment_decision"\)/,
    );
  });

  it("names NO autonomous-approve construct anywhere in the core — the grant is the human's", () => {
    expect(pcode).not.toMatch(/auto[_-]?approve/i);
    expect(pcode).not.toMatch(/approve_now/i);
    expect(pcode).not.toMatch(/autonomous[_-]?approv/i);
  });

  it("APPROVED BY CONSTRUCTION — the ledger CHECK-pins approval_state to the single value 'approved'", () => {
    // Inherited from R30: a verification can ONLY exist for an approved operation.
    expect(sql).toMatch(/check\s*\(\s*approval_state\s*=\s*'approved'\s*\)/i);
  });

  it("VERIFIED BY CONSTRUCTION — the ledger CHECK-pins status to the single value 'verified'", () => {
    expect(sql).toMatch(/status\s+text\s+not null\s+default\s+'verified'/i);
    expect(sql).toMatch(/check\s*\(\s*status\s*=\s*'verified'\s*\)/i);
  });

  it("the write primitive REJECTS any non-approved authorisation — 'Human Review may not be bypassed'", () => {
    expect(sql).toMatch(/p_approval_state\s*<>\s*'approved'/i);
    expect(sql).toMatch(/Human Review may not be bypassed/i);
  });
});

// =====================================================================
// 6. INTEGRITY IS A COHERENT VERDICT — the R31 KEYSTONE: (fulfilment_id is null) = (integrity = 'missing').
// =====================================================================

describe("receptionist verification — the integrity verdict is coherent with the record it reconciles", () => {
  const pcode = codeOf(read(CORE));
  const sql = sqlCodeOf(read(MIGRATION));

  it("the integrity vocabulary is EXACTLY {consistent, missing, inconsistent} — a closed set of verdicts", () => {
    expect(pcode).toMatch(
      /VerificationIntegrity\s*=\s*"consistent"\s*\|\s*"missing"\s*\|\s*"inconsistent"/,
    );
  });

  it("a record is produced for ALL THREE verdicts — missing and inconsistent are NOT abstentions", () => {
    // The abstention vocabulary is ONLY the two deferrals; the integrity verdicts are findings on a produced record.
    expect(pcode).toMatch(
      /VerificationAbstention\s*=\s*"no_fulfilment_decision"\s*\|\s*"unsupported_fulfilment"/,
    );
    // Isolate the abstention type DECLARATION (from its `=` to the terminating `;`) and prove neither integrity
    // verdict leaks into it — `missing` / `inconsistent` are findings on a produced decision, never a "nothing here".
    const declStart = pcode.indexOf("VerificationAbstention =");
    const abstentionDecl = pcode.slice(declStart, pcode.indexOf(";", declStart));
    expect(declStart).toBeGreaterThan(-1);
    expect(abstentionDecl).not.toMatch(/missing/);
    expect(abstentionDecl).not.toMatch(/inconsistent/);
  });

  it("COHERENT BY CONSTRUCTION — a table CHECK pins (fulfilment_id is null) = (integrity = 'missing')", () => {
    expect(sql).toMatch(/constraint receptionist_conversation_verifications_integrity_coherence check/i);
    expect(sql).toMatch(/\(\s*fulfilment_id is null\s*\)\s*=\s*\(\s*integrity = 'missing'\s*\)/i);
  });

  it("the write primitive re-validates the coherence (belt-and-braces with the table CHECK)", () => {
    // A `missing` verdict carrying a fulfilment_id — or a `consistent`/`inconsistent` verdict without one — is
    // rejected by the primitive, not only by the column CHECK.
    expect(sql).toMatch(/\(p_fulfilment_id is null\)\s*<>\s*\(p_integrity = 'missing'\)/i);
    expect(sql).toMatch(/incoherent with fulfilment_id/i);
  });

  it("bounds the integrity to its vocabulary in the ledger CHECK and the primitive", () => {
    expect(sql).toMatch(
      /check\s*\(\s*integrity\s+in\s*\(\s*'consistent',\s*'missing',\s*'inconsistent'\s*\)\s*\)/i,
    );
    expect(sql).toMatch(/p_integrity not in \('consistent', 'missing', 'inconsistent'\)/i);
  });
});

// =====================================================================
// 7. INTEGRATE with Human Review — NEVER DUPLICATE the grant. The grant is R29's, reused by the runtime only.
// =====================================================================

describe("receptionist verification — integrates with Human Review, never duplicates the grant", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("the grant is folded ONLY through R29's bridge, and ONLY in the runtime (never the core)", () => {
    // deriveAuthorisationState lives in R29; the runtime reuses it to fold an EXISTING `sent` resolution. The core
    // never folds the grant — it receives the already-decided fulfilment. No duplicate approval logic.
    expect(rcode).toMatch(/\bderiveAuthorisationState\b/);
    expect(pcode).not.toMatch(/\bderiveAuthorisationState\b/);
  });

  it("NEITHER the core nor the runtime records a human grant — it names no review-resolution writer", () => {
    // The grant is the human's, recorded by the UNCHANGED R14 Human Review architecture. R31 reads it; it never
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
// 8. It VERIFIES work — it PERFORMS none; reaching NO external system; idempotent (not retry); best-effort.
// =====================================================================

describe("receptionist verification — verifies work, performs none, idempotently, best-effort", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("the verification vocabulary is EXACTLY {verify_booking_fulfilment} — quote/scheduling verifications are absent", () => {
    expect(pcode).toMatch(/VERIFICATION_TYPES\s*=\s*\[\s*"verify_booking_fulfilment"\s*\]/);
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

  it("IT VERIFIES — IT NEVER PERFORMS — neither the core nor the runtime NAMES R30's fulfilment write primitive", () => {
    // THE load-bearing R31 proof. The runtime re-derives the EXPECTED fulfilment through R30's PURE resolveFulfilment
    // (a derivation, below), but it PERFORMS no fulfilment: it files a verification verdict, never a fulfilment row.
    expect(pcode).not.toMatch(FULFIL_WRITE_FN);
    expect(rcode).not.toMatch(FULFIL_WRITE_FN);
  });

  it("the runtime writes NO tenant row — no lead reflection, no customer promotion (the ledger IS the verdict)", () => {
    // Like the R27–R30 runtimes, a verification touches NO tenant table: no `.from(...)` at all, no lead write, no
    // customers. Scheduling, promotion and external writes are non-goals.
    expect(rcode).not.toMatch(/\.from\(/);
    expect(rcode).not.toMatch(/customers/);
    expect(rcode).not.toMatch(/\bleads\b/);
    expect(rcode).not.toMatch(/contact_phone/);
  });

  it("the runtime writes ONLY the one internal row — the verification ledger, through the write primitive", () => {
    expect(rcode).toMatch(WRITE_FN);
  });

  it("IDEMPOTENT, NOT RETRY — it names no re-attempt orchestration (retry is an explicit R31 non-goal)", () => {
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

  it("is server-only — it is the ONE place an approved fulfilment is durably verified", () => {
    expect(importSpecifiers(rcode)).toContain("server-only");
  });
});

// =====================================================================
// 9. The migration installs an APPEND-ONLY, service-role-only, APPROVED-ONLY, DETERMINISTIC, IDEMPOTENT ledger.
// =====================================================================

describe("receptionist verification — the ledger is append-only, service-role-only, approved-only and idempotent", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("creates the receptionist_conversation_verifications table", () => {
    expect(sql).toMatch(/create table if not exists public\.receptionist_conversation_verifications/i);
  });

  it("captures the anchors, the Human Review provenance, the operation, its verdict, its payload and the status", () => {
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
      "fulfilment_id",
      "review_audit_id",
      "sent_audit_id",
      "review_resolution_id",
      "verification_type",
      "verification_outcome",
      "integrity",
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

  it("bounds the verification type and outcome to their vocabularies {verify_booking_fulfilment} / {fulfilment_reconciled}", () => {
    expect(sql).toMatch(
      /check\s*\(\s*verification_type\s+in\s*\(\s*'verify_booking_fulfilment'\s*\)\s*\)/i,
    );
    expect(sql).toMatch(
      /check\s*\(\s*verification_outcome\s+in\s*\(\s*'fulfilment_reconciled'\s*\)\s*\)/i,
    );
  });

  it("DETERMINISTIC BY CONSTRUCTION — a CHECK pins (verification_type, verification_outcome) to the exact fold", () => {
    // verify_booking_fulfilment ⇒ fulfilment_reconciled. No writer — not even service_role — can file a row whose
    // outcome contradicts its type.
    expect(sql).toMatch(/constraint receptionist_conversation_verifications_outcome_fold check/i);
    expect(sql).toMatch(
      /verification_type = 'verify_booking_fulfilment' and verification_outcome = 'fulfilment_reconciled'/i,
    );
  });

  it("IDEMPOTENT BY CONSTRUCTION — authorisation_id is UNIQUE and the writer inserts ON CONFLICT DO NOTHING", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_verifications_authorisation_unique unique \(authorisation_id\)/i,
    );
    expect(sql).toMatch(/on conflict \(authorisation_id\) do nothing/i);
    // On a repeat, the primitive resolves the existing row's id so the operation is a true no-op.
    expect(sql).toMatch(/select id into v_id[\s\S]*?where authorisation_id = p_authorisation_id/i);
  });

  it("bounds the expected booking number to the E.164 shape and the postcode to its shape in DDL", () => {
    expect(sql).toMatch(/phone_number\s+text\s+check\s*\([\s\S]*?\+\\d\{10,15\}/i);
    expect(sql).toMatch(/postcode\s+text\s+check\s*\([\s\S]*?A-Z/i);
  });

  it("enables RLS with NO policies — service-role / SECURITY DEFINER only", () => {
    expect(sql).toMatch(
      /alter table public\.receptionist_conversation_verifications enable row level security/i,
    );
    expect(sql).not.toMatch(/create policy[\s\S]*?on public\.receptionist_conversation_verifications/i);
  });

  it("is APPEND-ONLY — UPDATE and DELETE are rejected by triggers", () => {
    expect(sql).toMatch(
      /create or replace function public\.receptionist_conversation_verifications_block_mutation\(/i,
    );
    expect(sql).toMatch(/raise exception[\s\S]*?append-only[\s\S]*?tg_op/i);
    expect(sql).toMatch(/errcode\s*=\s*'restrict_violation'/i);
    expect(sql).toMatch(
      /create trigger receptionist_conversation_verifications_no_update\s+before update on public\.receptionist_conversation_verifications/i,
    );
    expect(sql).toMatch(
      /create trigger receptionist_conversation_verifications_no_delete\s+before delete on public\.receptionist_conversation_verifications/i,
    );
  });

  it("writes only through a SECURITY DEFINER primitive granted only to service_role", () => {
    expect(sql).toMatch(
      /create or replace function public\.record_receptionist_conversation_verification\(/i,
    );
    expect(sql).toMatch(/returns uuid/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = ''/i);
    expect(sql).toMatch(/insert into public\.receptionist_conversation_verifications/i);
    expect(sql).toMatch(/revoke all on function[\s\S]*?from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*?to service_role/i);
  });

  it("the write primitive re-validates the (type, outcome) fold (belt-and-braces with the table CHECK)", () => {
    expect(sql).toMatch(/does not match the deterministic fold/i);
  });

  it("REQUIRES the full Human Review provenance and a well-formed expected booking payload for a verify_booking_fulfilment", () => {
    // The authorisation anchor plus the three provenance ids are mandatory...
    expect(sql).toMatch(
      /p_review_audit_id is null[\s\S]*?p_sent_audit_id is null[\s\S]*?p_review_resolution_id is null/i,
    );
    // ...and a verify_booking_fulfilment must carry an expected job type plus a well-formed postcode and E.164 number.
    expect(sql).toMatch(/p_verification_type\s*=\s*'verify_booking_fulfilment'[\s\S]*?\+\\d\{10,15\}/i);
    expect(sql).toMatch(/p_verification_type\s*=\s*'verify_booking_fulfilment'[\s\S]*?p_job_type is null/i);
  });
});

// =====================================================================
// 10. The RECONCILIATION READER reads only the R29 + R30 ledgers; the runtime verifies on SEND, AFTER R30.
// =====================================================================

describe("receptionist verification — the reader reconciles both ledgers, and verification fires on SEND after R30", () => {
  const sql = sqlCodeOf(read(MIGRATION));
  const seam = codeOf(read(REVIEW_SEAM));

  it("the reader is a service-role-only SECURITY DEFINER sql function granted only to service_role", () => {
    expect(sql).toMatch(
      /create or replace function public\.find_receptionist_fulfilment_reconciliation\(/i,
    );
    expect(sql).toMatch(
      /revoke all on function public\.find_receptionist_fulfilment_reconciliation\(uuid, uuid\)\s*from public, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.find_receptionist_fulfilment_reconciliation\(uuid, uuid\)\s*to service_role/i,
    );
  });

  it("the reader READS ONLY the R29 authorisation ledger LEFT JOINed to the R30 fulfilment ledger — it never writes", () => {
    // Slice the reader function body (from its definition to its revoke) and prove it is a pure reconciliation SELECT.
    const start = sql.indexOf("function public.find_receptionist_fulfilment_reconciliation");
    const body = sql.slice(start, sql.indexOf("revoke all on function", start));
    expect(body).toMatch(/language sql/i);
    expect(body).toMatch(/security definer/i);
    expect(body).toMatch(/from public\.receptionist_conversation_authorisations/i);
    expect(body).toMatch(/left join public\.receptionist_conversation_fulfilments/i);
    expect(body).toMatch(/a\.authorisation_type = 'approve_booking'/i);
    expect(body).toMatch(/a\.authorisation_state = 'pending'/i);
    expect(body).toMatch(/a\.status = 'assessed'/i);
    // The approval FOLD stays in R29 and the EXPECTED shape stays in R30 — the reader supplies both rows, it never
    // decides approval, re-derives the fulfilment, or mutates.
    expect(body).not.toMatch(/\binsert\b/i);
    expect(body).not.toMatch(/\bupdate\b/i);
    expect(body).not.toMatch(/\bdelete\b/i);
  });

  it("the SEND path invokes the Verification Engine EXACTLY ONCE", () => {
    const calls = seam.match(/verifyApprovedFulfilment\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("verification is invoked from resolveReviewSend — NEVER from resolveReviewDismiss", () => {
    // Prove placement structurally: the call lives between the two function definitions (inside SEND), and the
    // DISMISS body — everything from its definition onward — names the engine NOWHERE.
    const sendIdx = seam.indexOf("resolveReviewSend");
    const dismissIdx = seam.indexOf("resolveReviewDismiss");
    expect(sendIdx).toBeGreaterThan(-1);
    expect(dismissIdx).toBeGreaterThan(sendIdx);
    const sendBody = seam.slice(sendIdx, dismissIdx);
    const dismissBody = seam.slice(dismissIdx);
    expect(sendBody).toMatch(/verifyApprovedFulfilment\(/);
    expect(dismissBody).not.toMatch(/verifyApprovedFulfilment\(/);
  });

  it("verification fires STRICTLY AFTER the durable `sent` resolution guard AND STRICTLY AFTER the R30 fulfilment", () => {
    // Human Review can never be bypassed AND R31 always re-reads a committed R30 row: the call is downstream of the
    // `already_resolved` guard, downstream of the fulfilApprovedBooking call, and only when the send produced an audit.
    const sendIdx = seam.indexOf("resolveReviewSend");
    const dismissIdx = seam.indexOf("resolveReviewDismiss");
    const sendBody = seam.slice(sendIdx, dismissIdx);
    const guardIdx = sendBody.indexOf('"already_resolved", outcome');
    const fulfilIdx = sendBody.indexOf("fulfilApprovedBooking(");
    const verifyIdx = sendBody.indexOf("verifyApprovedFulfilment(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fulfilIdx).toBeGreaterThan(guardIdx);
    expect(verifyIdx).toBeGreaterThan(fulfilIdx); // VERIFY strictly after FULFIL
    expect(sendBody).toMatch(/if \(outcome\.audit_id !== null\)/);
  });
});

// =====================================================================
// 11. The R30 fulfilment core stays the SOLE authority the verification engine consumes; and R31 does NOT break R30.
// =====================================================================

describe("receptionist verification — it consumes the R30 fulfilment core, and adds a verifier not a second performer", () => {
  it("the R30 fulfilment core ships (the surface the verification engine consumes)", () => {
    expect(existsSync(resolve(ROOT, FULFILMENT_CORE)), FULFILMENT_CORE).toBe(true);
  });

  it("the runtime reconstructs the authorisation, folds the grant and re-derives the EXPECTED fulfilment — nothing more", () => {
    const rcode = codeOf(read(RUNTIME));
    // It rebuilds the R29 authorisation from the reader row, folds the grant through R29's bridge, and re-derives the
    // EXPECTED fulfilment through R30's PURE resolveFulfilment — but it names NO resolver of its own, and it
    // re-decides neither the authorisation nor the execution/action. The Fulfilment and Authorisation Engines are
    // authoritative.
    expect(rcode).toMatch(/kind:\s*"approve_booking"/);
    expect(rcode).toMatch(/\bderiveAuthorisationState\b/);
    expect(rcode).toMatch(/\bresolveFulfilment\b/); // the PURE re-derivation (a derivation, not a performance)
    expect(rcode).toMatch(/\bresolveVerification\b/);
    expect(rcode).not.toMatch(/\bresolveAuthorisation\b/);
    expect(rcode).not.toMatch(/\bresolveExecution\b/);
    expect(rcode).not.toMatch(/\bresolveAction\b/);
  });

  it("R31 NAMES NEITHER R30 ledger primitive — it performs no fulfilment and does its OWN reconciliation read", () => {
    const pcode = codeOf(read(CORE));
    const rcode = codeOf(read(RUNTIME));
    for (const code of [pcode, rcode]) {
      expect(code).not.toMatch(FULFIL_WRITE_FN); // never files an R30 fulfilment
      expect(code).not.toMatch(FULFIL_READER_FN); // never uses R30's own reader (it has its reconciliation reader)
    }
  });

  it("R31 DOES NOT BREAK R30 — R30's write primitive and reader are STILL each named by exactly one module", () => {
    // R31 must not have introduced a second fulfilment write path or reader. Across all source, R30's primitives are
    // STILL named ONLY by the R30 runtime — proof that R31 is additive, not a second performer.
    const R30_RUNTIME = "server/services/receptionist-fulfilment.ts";
    const fulfilWriters = walkSources(SOURCE_ROOTS)
      .filter((full) => FULFIL_WRITE_FN.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    const fulfilReaders = walkSources(SOURCE_ROOTS)
      .filter((full) => FULFIL_READER_FN.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(fulfilWriters).toEqual([R30_RUNTIME]);
    expect(fulfilReaders).toEqual([R30_RUNTIME]);
  });

  it("R31 DOES NOT BREAK R30 — the SEND path STILL invokes fulfilApprovedBooking exactly once", () => {
    const seam = codeOf(read(REVIEW_SEAM));
    const calls = seam.match(/fulfilApprovedBooking\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });
});

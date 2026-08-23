import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONVERSATION RECOVERY ENGINE governance invariants
 * (the AI Receptionist Programme, R32 — CONVERSATION RECOVERY ENGINE).
 *
 * R17–R25 built the DERIVING stack; R26 RESOLVES an outcome; R27 PREPARES an action; R28 DECIDES an execution's
 * eligibility; R29 DETERMINES whether that decided execution requires APPROVAL; R30 PERFORMS the approved internal
 * business operation (booking fulfilment); R31 VERIFIES that performed operation and records an INTEGRITY verdict
 * (consistent / missing / inconsistent). R32 is the NEXT layer — and, in this stack, the SECOND that does not perform:
 * given a DECIDED verification, it CLASSIFIES that verdict into the RECOVERY it warrants and records an auditable
 * RECOVERY DISPOSITION. Its law is exact — "the Recovery Engine DETERMINES recovery for verified work; it CONSUMES the
 * Verification Decision (re-deriving nothing) and reads the RECORDED verdict; it CLASSIFIES the integrity verdict into
 * a disposition (none / reinstate / reconcile) and reports whether recovery is required, never a business action; it
 * preserves Policy, Audit and Human Review as mandatory (transitively, through the verification it consumes); it is
 * idempotent (an approved fulfilment's recovery is determined AT MOST ONCE); and it MUST NOT bypass Human Review,
 * perform or verify a fulfilment, execute a recovery, or duplicate any lower engine's logic." This suite proves that
 * contract as a matter of SOURCE, not discipline — the house bar of tool-registry-describes-not-authorises.test.ts:
 *
 *   • SINGLE WRITE PATH & SINGLE READ PATH — across all non-test source (app/, server/, lib/), the recovery ledger's
 *     write primitive (`record_receptionist_conversation_recovery`) AND the recovery-context reader
 *     (`find_receptionist_recovery_context`) are each named by EXACTLY ONE module: the recovery server runtime. No
 *     other file can file a recovery, so there is no second path.
 *   • THE PURE CORE IS PURE, MODEL-FREE & POLICY-FREE — it reaches no server / IO / model / clock / RNG, and its ONLY
 *     import is the R31 verification surface it CONSUMES. It imports NO policy module, NO fulfilment module, NO
 *     authorisation module and NO other engine — R31 folded the whole stack (policy, fulfilment, authorisation,
 *     execution, action, outcome) into the verification decision — so there is provably NO duplicate logic. It CLASSIFIES
 *     a verdict; it persists nothing and recovers nothing itself.
 *   • THE VERIFICATION ENGINE STAYS AUTHORITATIVE — the core CONSUMES the decided verification (imports
 *     `isVerificationDecided`, defers on it FIRST) and NEVER re-derives it (it never names `resolveVerification`), so no
 *     duplicate verification logic exists, and the Verification Engine (and transitively Fulfilment, Authorisation,
 *     Execution, Action and Outcome) stays authoritative. The RUNTIME goes further than R31: it reads R31's RECORDED
 *     verdict and re-derives NOTHING — it names NO resolver of ANY lower engine (not `resolveVerification`, not
 *     `resolveFulfilment`, not `deriveAuthorisationState`).
 *   • POLICY & HUMAN REVIEW STAY MANDATORY — TRANSITIVELY, NOT RE-RUN — neither the core nor the runtime imports a
 *     policy surface or NAMES a policy decision function: a decided verification exists ONLY for an approved,
 *     policy-cleared, verified operation (R31's inherited gate), so a policy-blocked or un-approved booking is
 *     structurally UNRECOVERABLE without this engine touching policy or re-deciding approval.
 *   • THE APPROVAL GATE IS INHERITED, AND RE-PINNED AT STORAGE — the core emits a recovery ONLY for a decided
 *     verification (which only exists for an `approved` grant), so the approval gate is inherited via the FIRST defer;
 *     the ledger CHECK-pins `approval_state` to the single value 'approved' and `status` to 'determined'; and the write
 *     primitive REJECTS any other approval with "Human Review may not be bypassed". There is no path to recovering
 *     un-approved work.
 *   • RECOVERY-REQUIREMENT IS A COHERENT DISPOSITION — THE R32 KEYSTONE — a CHECK (and the write primitive) pin
 *     `recovery_required = (recovery_classification <> 'none')`: a stored recovery can NEVER claim recovery is required
 *     over a `none` disposition, nor deny it over a `reinstate`/`reconcile` one. Required iff a real recovery.
 *   • THE CLASSIFICATION IS A DETERMINISTIC FOLD — a CHECK (and the core switch, and the write primitive) pin the exact
 *     fold of the SOURCE integrity verdict: `consistent` ⇒ `none`, `missing` ⇒ `reinstate`, `inconsistent` ⇒
 *     `reconcile`. And INTEGRITY COHERENCE is inherited from R31: (fulfilment_id is null) = (integrity = 'missing').
 *   • IT INTEGRATES WITH HUMAN REVIEW — IT NEVER DUPLICATES THE GRANT — the terminal grant arises ONLY through R14's
 *     Human Review architecture and R29's fold; the RUNTIME reads the RECORDED `approved` state, so — unlike R31 — it
 *     re-folds NOTHING (it names no `deriveAuthorisationState`) and records NOTHING (it names no
 *     `record_receptionist_review_resolution`). It threads the full Human Review provenance so the ledgers JOIN.
 *   • IT DETERMINES RECOVERY — IT EXECUTES NONE — neither the core nor the runtime reaches a transport, provider,
 *     generator, calendar, scheduler or quote path, AND — the load-bearing R32 proof — the runtime NAMES NEITHER R30's
 *     fulfilment writer (`record_receptionist_conversation_fulfilment`) NOR R31's verification writer
 *     (`record_receptionist_conversation_verification`): it re-books nothing, re-verifies nothing, retries nothing,
 *     schedules nothing and corrects no record. The recovery ledger row IS the disposition and its audit.
 *   • IT IS IDEMPOTENT — NOT RETRY — the ledger's `authorisation_id` is UNIQUE and the writer inserts ON CONFLICT DO
 *     NOTHING (returning the existing id), so a repeat determines nothing; the runtime orchestrates no re-attempt
 *     (retry is an explicit R32 non-goal — it names no setTimeout / setInterval / backoff).
 *   • THE PERSIST IS BEST-EFFORT — the runtime SWALLOWS a failed write (returns null), it never THROWS, and it reaches
 *     no model and no reply pipeline — the confirmation, the grant, the fulfilment and the verification flow through the
 *     UNCHANGED pipelines.
 *   • THE LEDGER IS APPEND-ONLY, SERVICE-ROLE-ONLY, APPROVED-ONLY, DETERMINISTIC & COHERENT — RLS-enabled with no
 *     policies, UPDATE/DELETE rejected by triggers, a SECURITY DEFINER writer granted only to service_role, its
 *     `status` CHECK-pinned to 'determined', its `approval_state` CHECK-pinned to 'approved', a CHECK that pins
 *     (recovery_type, recovery_outcome) to the EXACT fold, the keystone coherence, the classification fold and the
 *     integrity coherence above.
 *   • THE READER CENTRES ON THE VERIFICATION LEDGER — a service-role-only SECURITY DEFINER `sql` function that SELECTs
 *     (never writes) R31's RECORDED verdict from `receptionist_conversation_verifications` alone — it re-reads NEITHER
 *     the R29 authorisation ledger NOR the R30 fulfilment ledger directly. This centring IS the storage embodiment of
 *     "the Verification Engine remains authoritative — the Recovery Engine consumes its RECORDED decision".
 *   • THE RUNTIME DETERMINES ON SEND ONLY — STRICTLY AFTER R30 AND R31 — it is invoked from `resolveReviewSend` (never
 *     `resolveReviewDismiss`), exactly once, strictly AFTER the durable `sent` resolution guard, AFTER the R30
 *     fulfilment call AND AFTER the R31 verification call, so Human Review can NEVER be bypassed and R32 always re-reads
 *     a committed R31 verdict.
 *   • IT DOES NOT BREAK R31 OR R30 — R32 adds a DETERMINER, not a second verifier or performer: R31's verification write
 *     primitive and reconciliation reader are STILL each named by exactly one module (the R31 runtime), R30's fulfilment
 *     write primitive and pending-authorisation reader STILL each by one (the R30 runtime), `resolveVerification` is
 *     STILL defined only in the R31 core, and the SEND path STILL invokes `verifyApprovedFulfilment` and
 *     `fulfilApprovedBooking` exactly once each. R32's modules name none of those primitives.
 *
 * The engine's runtime behaviour is pinned against real Postgres in
 * __tests__/integration/receptionist/conversation-recovery-pipeline.test.ts, and the pure core's resolution
 * exhaustively in __tests__/receptionist/conversation-recovery.test.ts. This tier is HERMETIC — a filesystem scan over
 * comment-stripped source — so the prose documenting the contract can neither satisfy a positive match nor trip a
 * negative.
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

const CORE = "lib/receptionist/conversation-recovery.ts";
const RUNTIME = "server/services/receptionist-recovery.ts";
const REVIEW_SEAM = "server/services/receptionist-review.ts";
const VERIFICATION_CORE = "lib/receptionist/conversation-verification.ts";
const MIGRATION = "supabase/migrations/20260901000000_receptionist_conversation_recoveries.sql";

/** The recovery ledger's write primitive — the function an auditor would call to file a recovery disposition. */
const WRITE_FN = /\brecord_receptionist_conversation_recovery\b/;

/** The recovery-context reader — the READ the runtime resolves R31's RECORDED verdict through. */
const READER_FN = /\bfind_receptionist_recovery_context\b/;

/** R31's verification WRITE primitive — R32 must NAME it NOWHERE (it CONSUMES the recorded verdict, it never re-files it). */
const VERIFY_WRITE_FN = /\brecord_receptionist_conversation_verification\b/;

/** R31's reconciliation reader — R32 uses its OWN recovery-context reader, so R32 must NAME this NOWHERE. */
const VERIFY_RECONCILE_READER_FN = /\bfind_receptionist_fulfilment_reconciliation\b/;

/** R30's fulfilment WRITE primitive — R32 must NAME it NOWHERE (it DETERMINES recovery, it never PERFORMS a fulfilment). */
const FULFIL_WRITE_FN = /\brecord_receptionist_conversation_fulfilment\b/;

/** R30's pending-authorisation reader — R32 must NAME this NOWHERE (it reads the recorded verification, not the authorisation). */
const FULFIL_READER_FN = /\bfind_receptionist_pending_booking_authorisation\b/;

/** The R14 human-grant writer — R32 must NAME it NOWHERE (it READS the recorded grant, it never re-records it). */
const REVIEW_RESOLUTION_WRITE_FN = /\brecord_receptionist_review_resolution\b/;

/** The policy DECISION functions — neither core nor runtime may NAME one (policy is consumed transitively). */
const POLICY_DECISION_FNS = /\b(?:evaluateReply|isAutoSendable|redactReply|clearForHumanSend)\b/;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

// =====================================================================
// 0. The engine, the ledger and the runtime all ship, and the review SEND path integrates them.
// =====================================================================

describe("receptionist recovery — the engine ships and is wired", () => {
  it(`ships the append-only recovery ledger migration ${MIGRATION}`, () => {
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
    expect(code).toMatch(/export function resolveRecovery\(/);
    expect(code).toMatch(/export function isRecoveryDecided\(/);
  });

  it("the server runtime exports the single recovery entry point", () => {
    const code = codeOf(read(RUNTIME));
    expect(code).toMatch(/export async function recoverVerifiedFulfilment\(/);
  });

  it("the Human Review SEND path imports the recovery runtime (the sole caller)", () => {
    const specs = importSpecifiers(codeOf(read(REVIEW_SEAM)));
    expect(specs).toContain("@/server/services/receptionist-recovery");
  });
});

// =====================================================================
// 1. SINGLE WRITE PATH & SINGLE READ PATH — exactly one module names each ledger primitive.
// =====================================================================

describe("receptionist recovery — exactly one module writes the ledger and one reads the context", () => {
  const writers = walkSources(SOURCE_ROOTS)
    .filter((full) => WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();
  const readers = walkSources(SOURCE_ROOTS)
    .filter((full) => READER_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the ONLY module that names the ledger write primitive is the recovery server runtime", () => {
    // If this list ever grows, a second recovery-write path (or a bypass) has appeared.
    expect(writers).toEqual([RUNTIME]);
  });

  it("the ONLY module that names the recovery-context reader is the recovery server runtime", () => {
    expect(readers).toEqual([RUNTIME]);
  });

  it("no app/ route, action, or component files a recovery directly", () => {
    expect(writers.filter((p) => p.startsWith("app/"))).toEqual([]);
    expect(readers.filter((p) => p.startsWith("app/"))).toEqual([]);
  });

  it("no other server/ module files a recovery directly", () => {
    expect(writers.filter((p) => p !== RUNTIME && p.startsWith("server/"))).toEqual([]);
    expect(readers.filter((p) => p !== RUNTIME && p.startsWith("server/"))).toEqual([]);
  });

  it("the resolution entry point resolveRecovery is DEFINED in exactly one module — the pure core", () => {
    // No feature implements independent recovery logic: the single source of truth is exported once and consumed.
    const definers = walkSources(SOURCE_ROOTS)
      .filter((full) => /export function resolveRecovery\(/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(definers).toEqual([CORE]);
  });
});

// =====================================================================
// 2. The pure core is PURE, MODEL-FREE and POLICY-FREE — it CONSUMES the verification surface, and nothing else.
// =====================================================================

describe("receptionist recovery — the pure core is pure, model-free and policy-free", () => {
  const pcode = codeOf(read(CORE));

  it("is a shared pure module (NOT server-only — the runtime and tests import it)", () => {
    expect(importSpecifiers(pcode)).not.toContain("server-only");
  });

  it("its ONLY import is the R31 verification surface it consumes — NO policy, NO fulfilment, NO other module", () => {
    // The verification import is the predicate it CONSUMES (isVerificationDecided) plus its types. There is NOTHING
    // else — most importantly NO policy module, NO fulfilment module and NO authorisation module (R31 already folded
    // the whole stack into the verification decision). This is the headline R32 proof that no duplicate policy,
    // fulfilment, authorisation or verification logic is introduced.
    expect(pcode).toMatch(/isVerificationDecided/);
    expect(importSpecifiers(pcode)).toEqual(["@/lib/receptionist/conversation-verification"]);
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/policy");
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/conversation-fulfilment");
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/conversation-authorisation");
  });

  it("DUPLICATES NOTHING beneath it — it re-derives no verification, fulfilment, authorisation, action or outcome", () => {
    // It consumes ALREADY-computed inputs; it names none of the resolvers/extractors/detectors — most importantly it
    // NEVER re-derives the verification (it CONSUMES the R31 decision via isVerificationDecided) and it re-folds no
    // grant. This is the R32 analogue of R31's "never names resolveFulfilment".
    expect(pcode).not.toMatch(/\bresolveVerification\b/);
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

  it("touches no I/O and calls no model — it classifies, it does not generate, persist or recover", () => {
    expect(pcode).not.toMatch(/createAdminClient/);
    expect(pcode).not.toMatch(/supabase/i);
    expect(pcode).not.toMatch(/\bfetch\(/);
    expect(pcode).not.toMatch(/@\/lib\/ai\//);
    expect(pcode).not.toMatch(/Anthropic/);
    // It performs NO org lookup and NO env read.
    expect(pcode).not.toMatch(/process\.env/);
  });

  it("has no clock and no RNG (a disposition is reconstructable)", () => {
    expect(pcode).not.toMatch(/Math\.random/);
    expect(pcode).not.toMatch(/Date\.now/);
    expect(pcode).not.toMatch(/new Date\(/);
  });

  it("names NO ledger primitive — the pure core reaches neither its own writer/reader nor R30/R31's", () => {
    expect(pcode).not.toMatch(WRITE_FN);
    expect(pcode).not.toMatch(READER_FN);
    expect(pcode).not.toMatch(VERIFY_WRITE_FN);
    expect(pcode).not.toMatch(VERIFY_RECONCILE_READER_FN);
    expect(pcode).not.toMatch(FULFIL_WRITE_FN);
    expect(pcode).not.toMatch(FULFIL_READER_FN);
  });
});

// =====================================================================
// 3. The Verification Engine remains AUTHORITATIVE — the recovery CONSUMES it and DEFERS to it.
// =====================================================================

describe("receptionist recovery — the Verification Engine stays authoritative", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("CONSUMES the decided verification — resolveRecovery defers on it FIRST", () => {
    // The first gate stands down when the Verification Engine rendered no decision (transitively preserving the
    // Fulfilment, Authorisation, Execution, Action and Outcome Engines' authority too — a decided verification only
    // exists for an approved, reconciled operation).
    expect(pcode).toMatch(
      /if \(!isVerificationDecided\(verification\)\) return abstain\("no_verification_decision"\)/,
    );
  });

  it("NEVER re-derives the verification — the core names isVerificationDecided but not resolveVerification", () => {
    expect(pcode).toMatch(/isVerificationDecided/);
    expect(pcode).not.toMatch(/\bresolveVerification\b/);
  });

  it("the RUNTIME re-derives NOTHING — it consumes R31's RECORDED verdict and names no lower resolver", () => {
    // Design B: the runtime reads R31's RECORDED verification row and reconstructs the decision verbatim from the
    // recorded columns. It never re-verifies, never re-derives the fulfilment, never re-folds the grant — so it names
    // NO resolver of ANY lower engine. This is a STRONGER authority proof than R31's runtime (which re-derived the
    // expected fulfilment): R32 consumes the recorded verdict wholesale.
    expect(rcode).not.toMatch(/\bresolveVerification\b/);
    expect(rcode).not.toMatch(/\bresolveFulfilment\b/);
    expect(rcode).not.toMatch(/\bderiveAuthorisationState\b/);
    expect(rcode).not.toMatch(/\bresolveAuthorisation\b/);
    expect(rcode).not.toMatch(/\bresolveExecution\b/);
    expect(rcode).not.toMatch(/\bresolveAction\b/);
  });

  it("the verification→recovery map maps verify_booking_fulfilment → recover_booking_fulfilment (it consumes the R31 vocabulary)", () => {
    expect(pcode).toMatch(/verify_booking_fulfilment:\s*"recover_booking_fulfilment"/);
  });

  it("the booking it recovers is BY REFERENCE the verification's payload — it can never drift from the decision", () => {
    expect(pcode).toMatch(/booking:\s*verification\.booking/);
  });
});

// =====================================================================
// 4. Policy stays MANDATORY — transitively, through the verification; neither core nor runtime imports or re-runs it.
// =====================================================================

describe("receptionist recovery — policy is consumed transitively, never imported or re-run", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("neither the core nor the runtime imports the policy module (the verification already folded the verdict)", () => {
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/policy");
    expect(importSpecifiers(rcode)).not.toContain("@/lib/receptionist/policy");
  });

  it("neither the core nor the runtime NAMES a policy decision function or the guardrail verdict type", () => {
    // A policy `block` foreclosed the authorisation at R29, foreclosed can never derive to `approved`, an un-approved
    // authorisation is never fulfilled at R30 nor verified at R31 — so a policy-blocked booking is structurally
    // UNRECOVERABLE WITHOUT this engine touching policy.
    expect(pcode).not.toMatch(POLICY_DECISION_FNS);
    expect(rcode).not.toMatch(POLICY_DECISION_FNS);
    expect(pcode).not.toMatch(/GuardrailVerdict/);
    expect(rcode).not.toMatch(/GuardrailVerdict/);
  });
});

// =====================================================================
// 5. THE APPROVAL GATE — inherited from R31 via the FIRST defer, and re-pinned at the storage layer.
// =====================================================================

describe("receptionist recovery — the approval gate is inherited, and re-pinned in the ledger", () => {
  const pcode = codeOf(read(CORE));
  const sql = sqlCodeOf(read(MIGRATION));

  it("the pure core emits a recovery ONLY for a DECIDED verification — the approval gate is inherited", () => {
    // R32's core has no approval literal of its own: a decided verification exists ONLY for an `approved` grant (R31's
    // inherited gate, R30's keystone), so deferring to isVerificationDecided FIRST inherits the approval gate
    // transitively.
    expect(pcode).toMatch(
      /if \(!isVerificationDecided\(verification\)\) return abstain\("no_verification_decision"\)/,
    );
  });

  it("names NO autonomous-approve construct anywhere in the core — the grant is the human's", () => {
    expect(pcode).not.toMatch(/auto[_-]?approve/i);
    expect(pcode).not.toMatch(/approve_now/i);
    expect(pcode).not.toMatch(/autonomous[_-]?approv/i);
  });

  it("APPROVED BY CONSTRUCTION — the ledger CHECK-pins approval_state to the single value 'approved'", () => {
    // Inherited from R31 → R30: a recovery can ONLY exist for an approved operation.
    expect(sql).toMatch(/check\s*\(\s*approval_state\s*=\s*'approved'\s*\)/i);
  });

  it("DETERMINED BY CONSTRUCTION — the ledger CHECK-pins status to the single value 'determined'", () => {
    expect(sql).toMatch(/status\s+text\s+not null\s+default\s+'determined'/i);
    expect(sql).toMatch(/check\s*\(\s*status\s*=\s*'determined'\s*\)/i);
  });

  it("the write primitive REJECTS any non-approved authorisation — 'Human Review may not be bypassed'", () => {
    expect(sql).toMatch(/p_approval_state\s*<>\s*'approved'/i);
    expect(sql).toMatch(/Human Review may not be bypassed/i);
  });
});

// =====================================================================
// 6. THE R32 KEYSTONE — recovery_required = (recovery_classification <> 'none'); plus the classification fold and the
//    inherited integrity coherence. The whole row is deterministic and coherent by construction.
// =====================================================================

describe("receptionist recovery — the disposition is coherent with its requirement (the R32 keystone)", () => {
  const pcode = codeOf(read(CORE));
  const sql = sqlCodeOf(read(MIGRATION));

  it("the recovery classification vocabulary is EXACTLY {none, reinstate, reconcile} — a closed set of dispositions", () => {
    expect(pcode).toMatch(
      /RecoveryClassification\s*=\s*"none"\s*\|\s*"reinstate"\s*\|\s*"reconcile"/,
    );
  });

  it("a record is produced for ALL THREE dispositions — reinstate and reconcile are NOT abstentions", () => {
    // The abstention vocabulary is ONLY the two deferrals; the dispositions are findings on a produced record.
    expect(pcode).toMatch(
      /RecoveryAbstention\s*=\s*"no_verification_decision"\s*\|\s*"unsupported_verification"/,
    );
    // Isolate the abstention type DECLARATION (from its `=` to the terminating `;`) and prove neither recovery
    // disposition leaks into it — `reinstate` / `reconcile` are findings on a produced decision, never a "nothing here".
    const declStart = pcode.indexOf("RecoveryAbstention =");
    const abstentionDecl = pcode.slice(declStart, pcode.indexOf(";", declStart));
    expect(declStart).toBeGreaterThan(-1);
    expect(abstentionDecl).not.toMatch(/reinstate/);
    expect(abstentionDecl).not.toMatch(/reconcile/);
  });

  it("THE KEYSTONE, IN THE CORE — recovery_required is TRUE iff the classification is not `none`", () => {
    expect(pcode).toMatch(/recovery_required:\s*classification !== "none"/);
  });

  it("COHERENT BY CONSTRUCTION — a table CHECK pins recovery_required = (recovery_classification <> 'none')", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_recoveries_requirement_coherence check/i,
    );
    expect(sql).toMatch(/recovery_required = \(recovery_classification <> 'none'\)/i);
  });

  it("the write primitive re-validates the keystone (belt-and-braces with the table CHECK)", () => {
    // A `none` disposition carrying recovery_required=true — or a `reinstate`/`reconcile` carrying false — is rejected
    // by the primitive, not only by the column CHECK.
    expect(sql).toMatch(/p_recovery_required <> \(p_recovery_classification <> 'none'\)/i);
    expect(sql).toMatch(/is incoherent with classification/i);
  });
});

describe("receptionist recovery — the classification is the deterministic fold of the verdict, coherent with the record", () => {
  const pcode = codeOf(read(CORE));
  const sql = sqlCodeOf(read(MIGRATION));

  it("THE FOLD, IN THE CORE — a closed switch folds consistent⇒none, missing⇒reinstate, inconsistent⇒reconcile", () => {
    expect(pcode).toMatch(/case "consistent":\s*return "none"/);
    expect(pcode).toMatch(/case "missing":\s*return "reinstate"/);
    expect(pcode).toMatch(/case "inconsistent":\s*return "reconcile"/);
  });

  it("THE FOLD, ENFORCED — a table CHECK pins the exact fold of the source integrity verdict to its classification", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_recoveries_classification_fold check/i,
    );
    expect(sql).toMatch(/\(integrity = 'consistent' and recovery_classification = 'none'\)/i);
    expect(sql).toMatch(/\(integrity = 'missing' and recovery_classification = 'reinstate'\)/i);
    expect(sql).toMatch(/\(integrity = 'inconsistent' and recovery_classification = 'reconcile'\)/i);
  });

  it("the write primitive re-validates the classification fold (belt-and-braces with the table CHECK)", () => {
    expect(sql).toMatch(/is not the deterministic fold of integrity/i);
  });

  it("INTEGRITY COHERENCE, INHERITED FROM R31 — a table CHECK pins (fulfilment_id is null) = (integrity = 'missing')", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_recoveries_integrity_coherence check/i,
    );
    expect(sql).toMatch(/\(\s*fulfilment_id is null\s*\)\s*=\s*\(\s*integrity = 'missing'\s*\)/i);
  });

  it("the write primitive re-validates the integrity coherence (belt-and-braces with the table CHECK)", () => {
    expect(sql).toMatch(/\(p_fulfilment_id is null\)\s*<>\s*\(p_integrity = 'missing'\)/i);
    expect(sql).toMatch(/incoherent with fulfilment_id/i);
  });

  it("bounds the classification and the integrity to their vocabularies in the ledger CHECK and the primitive", () => {
    expect(sql).toMatch(
      /check\s*\(\s*recovery_classification\s+in\s*\(\s*'none',\s*'reinstate',\s*'reconcile'\s*\)\s*\)/i,
    );
    expect(sql).toMatch(
      /check\s*\(\s*integrity\s+in\s*\(\s*'consistent',\s*'missing',\s*'inconsistent'\s*\)\s*\)/i,
    );
    expect(sql).toMatch(/p_recovery_classification not in \('none', 'reinstate', 'reconcile'\)/i);
    expect(sql).toMatch(/p_integrity not in \('consistent', 'missing', 'inconsistent'\)/i);
  });
});

// =====================================================================
// 7. INTEGRATE with Human Review — NEVER DUPLICATE the grant. R32 reads the RECORDED grant; it re-folds nothing.
// =====================================================================

describe("receptionist recovery — integrates with Human Review, never duplicates the grant", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("the grant is neither re-folded nor re-recorded — the runtime reads the RECORDED approval_state", () => {
    // Unlike R31 (whose runtime re-folded the grant through R29's deriveAuthorisationState), R32 consumes R31's
    // RECORDED verification row — which already carries the folded `approved` state — so neither the core nor the
    // runtime re-folds the grant. No duplicate approval logic; a strictly smaller surface than R31.
    expect(pcode).not.toMatch(/\bderiveAuthorisationState\b/);
    expect(rcode).not.toMatch(/\bderiveAuthorisationState\b/);
  });

  it("NEITHER the core nor the runtime records a human grant — it names no review-resolution writer", () => {
    // The grant is the human's, recorded by the UNCHANGED R14 Human Review architecture. R32 reads it; it never
    // re-records it, so there is no duplicate human-decision recorder.
    expect(pcode).not.toMatch(REVIEW_RESOLUTION_WRITE_FN);
    expect(rcode).not.toMatch(REVIEW_RESOLUTION_WRITE_FN);
  });

  it("the runtime threads the FULL provenance — the verification, the held reply, the sent reply and the resolution", () => {
    expect(rcode).toMatch(/p_verification_id:/);
    expect(rcode).toMatch(/p_review_audit_id:/);
    expect(rcode).toMatch(/p_sent_audit_id:/);
    expect(rcode).toMatch(/p_review_resolution_id:/);
  });
});

// =====================================================================
// 8. It DETERMINES recovery — it EXECUTES none; reaching NO external system; idempotent (not retry); best-effort.
// =====================================================================

describe("receptionist recovery — determines recovery, executes none, idempotently, best-effort", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("the recovery vocabulary is EXACTLY {recover_booking_fulfilment} — quote/scheduling recoveries are absent", () => {
    expect(pcode).toMatch(/RECOVERY_TYPES\s*=\s*\[\s*"recover_booking_fulfilment"\s*\]/);
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

  it("IT DETERMINES — IT NEVER EXECUTES — neither the core nor the runtime NAMES R30's fulfilment or R31's verification writer", () => {
    // THE load-bearing R32 proof. R32 re-books nothing (names no R30 fulfilment writer) and re-verifies nothing (names
    // no R31 verification writer): it reads R31's RECORDED verdict through its own reader and files a recovery
    // disposition — never a fulfilment row, never a verification row.
    expect(pcode).not.toMatch(FULFIL_WRITE_FN);
    expect(rcode).not.toMatch(FULFIL_WRITE_FN);
    expect(pcode).not.toMatch(VERIFY_WRITE_FN);
    expect(rcode).not.toMatch(VERIFY_WRITE_FN);
  });

  it("the runtime writes NO tenant row — no lead reflection, no customer promotion (the ledger IS the disposition)", () => {
    // Like the R27–R31 runtimes, a recovery touches NO tenant table: no `.from(...)` at all, no lead write, no
    // customers. Scheduling, promotion, re-booking and external writes are non-goals.
    expect(rcode).not.toMatch(/\.from\(/);
    expect(rcode).not.toMatch(/customers/);
    expect(rcode).not.toMatch(/\bleads\b/);
    expect(rcode).not.toMatch(/contact_phone/);
  });

  it("the runtime writes ONLY the one internal row — the recovery ledger, through the write primitive", () => {
    expect(rcode).toMatch(WRITE_FN);
  });

  it("IDEMPOTENT, NOT RETRY — it names no re-attempt orchestration (retry is an explicit R32 non-goal)", () => {
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

  it("is server-only — it is the ONE place a verified fulfilment's recovery is durably determined", () => {
    expect(importSpecifiers(rcode)).toContain("server-only");
  });
});

// =====================================================================
// 9. The migration installs an APPEND-ONLY, service-role-only, APPROVED-ONLY, DETERMINISTIC, IDEMPOTENT ledger.
// =====================================================================

describe("receptionist recovery — the ledger is append-only, service-role-only, approved-only and idempotent", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("creates the receptionist_conversation_recoveries table", () => {
    expect(sql).toMatch(/create table if not exists public\.receptionist_conversation_recoveries/i);
  });

  it("captures the anchors, the Human Review provenance, the operation, its disposition, its payload and the status", () => {
    for (const column of [
      "org_id",
      "conversation_id",
      "enquiry_id",
      "lead_id",
      "customer_ref",
      "correlation_id",
      "action_id",
      "execution_id",
      "verification_id",
      "authorisation_id",
      "fulfilment_id",
      "review_audit_id",
      "sent_audit_id",
      "review_resolution_id",
      "recovery_type",
      "recovery_outcome",
      "recovery_classification",
      "recovery_required",
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

  it("bounds the recovery type and outcome to their vocabularies {recover_booking_fulfilment} / {fulfilment_recovery_determined}", () => {
    expect(sql).toMatch(
      /check\s*\(\s*recovery_type\s+in\s*\(\s*'recover_booking_fulfilment'\s*\)\s*\)/i,
    );
    expect(sql).toMatch(
      /check\s*\(\s*recovery_outcome\s+in\s*\(\s*'fulfilment_recovery_determined'\s*\)\s*\)/i,
    );
  });

  it("DETERMINISTIC BY CONSTRUCTION — a CHECK pins (recovery_type, recovery_outcome) to the exact fold", () => {
    // recover_booking_fulfilment ⇒ fulfilment_recovery_determined. No writer — not even service_role — can file a row
    // whose outcome contradicts its type.
    expect(sql).toMatch(/constraint receptionist_conversation_recoveries_outcome_fold check/i);
    expect(sql).toMatch(
      /recovery_type = 'recover_booking_fulfilment' and recovery_outcome = 'fulfilment_recovery_determined'/i,
    );
  });

  it("IDEMPOTENT BY CONSTRUCTION — authorisation_id is UNIQUE and the writer inserts ON CONFLICT DO NOTHING", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_recoveries_authorisation_unique unique \(authorisation_id\)/i,
    );
    expect(sql).toMatch(/on conflict \(authorisation_id\) do nothing/i);
    // On a repeat, the primitive resolves the existing row's id so the operation is a true no-op.
    expect(sql).toMatch(/select id into v_id[\s\S]*?where authorisation_id = p_authorisation_id/i);
  });

  it("the verification anchor is NOT NULL in DDL — a recovery is ALWAYS determined from a recorded verification", () => {
    // R32's load-bearing anchor: the storage proof that "the Verification Engine remains authoritative".
    expect(sql).toMatch(/verification_id uuid\s+not null/i);
  });

  it("bounds the expected booking number to the E.164 shape and the postcode to its shape in DDL", () => {
    expect(sql).toMatch(/phone_number\s+text\s+check\s*\([\s\S]*?\+\\d\{10,15\}/i);
    expect(sql).toMatch(/postcode\s+text\s+check\s*\([\s\S]*?A-Z/i);
  });

  it("enables RLS with NO policies — service-role / SECURITY DEFINER only", () => {
    expect(sql).toMatch(
      /alter table public\.receptionist_conversation_recoveries enable row level security/i,
    );
    expect(sql).not.toMatch(/create policy[\s\S]*?on public\.receptionist_conversation_recoveries/i);
  });

  it("is APPEND-ONLY — UPDATE and DELETE are rejected by triggers", () => {
    expect(sql).toMatch(
      /create or replace function public\.receptionist_conversation_recoveries_block_mutation\(/i,
    );
    expect(sql).toMatch(/raise exception[\s\S]*?append-only[\s\S]*?tg_op/i);
    expect(sql).toMatch(/errcode\s*=\s*'restrict_violation'/i);
    expect(sql).toMatch(
      /create trigger receptionist_conversation_recoveries_no_update\s+before update on public\.receptionist_conversation_recoveries/i,
    );
    expect(sql).toMatch(
      /create trigger receptionist_conversation_recoveries_no_delete\s+before delete on public\.receptionist_conversation_recoveries/i,
    );
  });

  it("writes only through a SECURITY DEFINER primitive granted only to service_role", () => {
    expect(sql).toMatch(
      /create or replace function public\.record_receptionist_conversation_recovery\(/i,
    );
    expect(sql).toMatch(/returns uuid/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = ''/i);
    expect(sql).toMatch(/insert into public\.receptionist_conversation_recoveries/i);
    expect(sql).toMatch(/revoke all on function[\s\S]*?from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*?to service_role/i);
  });

  it("the write primitive re-validates the (type, outcome) fold (belt-and-braces with the table CHECK)", () => {
    expect(sql).toMatch(/does not match the deterministic fold/i);
  });

  it("REQUIRES the verification anchor and the full Human Review provenance and a well-formed booking payload", () => {
    // The verification + authorisation anchors plus the three provenance ids are mandatory...
    expect(sql).toMatch(
      /p_verification_id is null[\s\S]*?p_authorisation_id is null[\s\S]*?p_review_audit_id is null[\s\S]*?p_sent_audit_id is null[\s\S]*?p_review_resolution_id is null/i,
    );
    // ...and a recover_booking_fulfilment must carry an expected job type plus a well-formed postcode and E.164 number.
    expect(sql).toMatch(/p_recovery_type\s*=\s*'recover_booking_fulfilment'[\s\S]*?\+\\d\{10,15\}/i);
    expect(sql).toMatch(/p_recovery_type\s*=\s*'recover_booking_fulfilment'[\s\S]*?p_job_type is null/i);
  });
});

// =====================================================================
// 10. The RECOVERY-CONTEXT READER centres on the R31 verification ledger; the runtime determines on SEND, AFTER R31.
// =====================================================================

describe("receptionist recovery — the reader centres on the verification ledger, and recovery fires on SEND after R31", () => {
  const sql = sqlCodeOf(read(MIGRATION));
  const seam = codeOf(read(REVIEW_SEAM));

  it("the reader is a service-role-only SECURITY DEFINER sql function granted only to service_role", () => {
    expect(sql).toMatch(
      /create or replace function public\.find_receptionist_recovery_context\(/i,
    );
    expect(sql).toMatch(
      /revoke all on function public\.find_receptionist_recovery_context\(uuid, uuid\)\s*from public, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.find_receptionist_recovery_context\(uuid, uuid\)\s*to service_role/i,
    );
  });

  it("the reader CENTRES on the R31 verification ledger — it reads the RECORDED verdict, and it never writes", () => {
    // Slice the reader function body (from its definition to its revoke) and prove it is a pure SELECT over R31's
    // verification ledger. THE storage embodiment of "the Verification Engine remains authoritative": the reader
    // supplies R31's RECORDED verdict, and the runtime reconstructs the decision from it — it never decides.
    const start = sql.indexOf("function public.find_receptionist_recovery_context");
    const body = sql.slice(start, sql.indexOf("revoke all on function", start));
    expect(body).toMatch(/language sql/i);
    expect(body).toMatch(/security definer/i);
    expect(body).toMatch(/from public\.receptionist_conversation_verifications/i);
    expect(body).toMatch(/v\.status = 'verified'/i);
    expect(body).not.toMatch(/\binsert\b/i);
    expect(body).not.toMatch(/\bupdate\b/i);
    expect(body).not.toMatch(/\bdelete\b/i);
  });

  it("Design B — the reader re-reads NEITHER the R29 authorisation ledger NOR the R30 fulfilment ledger directly", () => {
    // R32 consumes R31's RECORDED verdict wholesale; it does NOT re-derive from the lower ledgers (that would be
    // duplicate logic). The reader's ONLY source is the verification ledger.
    const start = sql.indexOf("function public.find_receptionist_recovery_context");
    const body = sql.slice(start, sql.indexOf("revoke all on function", start));
    expect(body).not.toMatch(/from public\.receptionist_conversation_authorisations/i);
    expect(body).not.toMatch(/join public\.receptionist_conversation_fulfilments/i);
  });

  it("the SEND path invokes the Recovery Engine EXACTLY ONCE", () => {
    const calls = seam.match(/recoverVerifiedFulfilment\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("recovery is invoked from resolveReviewSend — NEVER from resolveReviewDismiss", () => {
    // Prove placement structurally: the call lives between the two function definitions (inside SEND), and the DISMISS
    // body — everything from its definition onward — names the engine NOWHERE.
    const sendIdx = seam.indexOf("resolveReviewSend");
    const dismissIdx = seam.indexOf("resolveReviewDismiss");
    expect(sendIdx).toBeGreaterThan(-1);
    expect(dismissIdx).toBeGreaterThan(sendIdx);
    const sendBody = seam.slice(sendIdx, dismissIdx);
    const dismissBody = seam.slice(dismissIdx);
    expect(sendBody).toMatch(/recoverVerifiedFulfilment\(/);
    expect(dismissBody).not.toMatch(/recoverVerifiedFulfilment\(/);
  });

  it("recovery fires STRICTLY AFTER the `sent` guard, AFTER the R30 fulfilment AND AFTER the R31 verification", () => {
    // Human Review can never be bypassed AND R32 always re-reads a committed R31 verdict: the call is downstream of the
    // `already_resolved` guard, downstream of fulfilApprovedBooking, downstream of verifyApprovedFulfilment, and only
    // when the send produced an audit.
    const sendIdx = seam.indexOf("resolveReviewSend");
    const dismissIdx = seam.indexOf("resolveReviewDismiss");
    const sendBody = seam.slice(sendIdx, dismissIdx);
    const guardIdx = sendBody.indexOf('"already_resolved", outcome');
    const fulfilIdx = sendBody.indexOf("fulfilApprovedBooking(");
    const verifyIdx = sendBody.indexOf("verifyApprovedFulfilment(");
    const recoverIdx = sendBody.indexOf("recoverVerifiedFulfilment(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fulfilIdx).toBeGreaterThan(guardIdx);
    expect(verifyIdx).toBeGreaterThan(fulfilIdx); // VERIFY strictly after FULFIL
    expect(recoverIdx).toBeGreaterThan(verifyIdx); // RECOVER strictly after VERIFY
    expect(sendBody).toMatch(/if \(outcome\.audit_id !== null\)/);
  });
});

// =====================================================================
// 11. The R31 verification core stays the SOLE authority R32 consumes; and R32 does NOT break R31 or R30.
// =====================================================================

describe("receptionist recovery — it consumes the R31 verification core, and adds a determiner not a second verifier", () => {
  it("the R31 verification core ships (the surface the recovery engine consumes)", () => {
    expect(existsSync(resolve(ROOT, VERIFICATION_CORE)), VERIFICATION_CORE).toBe(true);
  });

  it("the runtime reconstructs the verification decision from the RECORDED verdict, and classifies it — nothing more", () => {
    const rcode = codeOf(read(RUNTIME));
    // It rebuilds the R31 VerifyBookingDecision from the reader row (the booking is reconstructed verbatim) and hands
    // it to the pure resolveRecovery — but it names NO resolver of any lower engine, and it re-decides neither the
    // verification, the fulfilment, nor the authorisation. The Verification Engine is authoritative.
    expect(rcode).toMatch(/kind:\s*"prepare_booking"/);
    expect(rcode).toMatch(/\bresolveRecovery\b/);
    expect(rcode).not.toMatch(/\bresolveVerification\b/);
    expect(rcode).not.toMatch(/\bresolveFulfilment\b/);
    expect(rcode).not.toMatch(/\bderiveAuthorisationState\b/);
    expect(rcode).not.toMatch(/\bresolveAuthorisation\b/);
    expect(rcode).not.toMatch(/\bresolveExecution\b/);
    expect(rcode).not.toMatch(/\bresolveAction\b/);
  });

  it("R32 NAMES NEITHER R31 ledger primitive NOR R30's — it verifies nothing and performs nothing", () => {
    const pcode = codeOf(read(CORE));
    const rcode = codeOf(read(RUNTIME));
    for (const code of [pcode, rcode]) {
      expect(code).not.toMatch(VERIFY_WRITE_FN); // never files an R31 verification
      expect(code).not.toMatch(VERIFY_RECONCILE_READER_FN); // never uses R31's reconciliation reader
      expect(code).not.toMatch(FULFIL_WRITE_FN); // never files an R30 fulfilment
      expect(code).not.toMatch(FULFIL_READER_FN); // never uses R30's own reader
    }
  });

  it("R32 DOES NOT BREAK R31 — R31's write primitive and reconciliation reader are STILL each named by exactly one module", () => {
    // R32 must not have introduced a second verification write path or reader. Across all source, R31's primitives are
    // STILL named ONLY by the R31 runtime — proof that R32 is additive, not a second verifier.
    const R31_RUNTIME = "server/services/receptionist-verification.ts";
    const verifyWriters = walkSources(SOURCE_ROOTS)
      .filter((full) => VERIFY_WRITE_FN.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    const verifyReaders = walkSources(SOURCE_ROOTS)
      .filter((full) => VERIFY_RECONCILE_READER_FN.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(verifyWriters).toEqual([R31_RUNTIME]);
    expect(verifyReaders).toEqual([R31_RUNTIME]);
  });

  it("R32 DOES NOT BREAK R31 — resolveVerification is STILL defined only in the R31 verification core", () => {
    const definers = walkSources(SOURCE_ROOTS)
      .filter((full) => /export function resolveVerification\(/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(definers).toEqual([VERIFICATION_CORE]);
  });

  it("R32 DOES NOT BREAK R31 — the SEND path STILL invokes verifyApprovedFulfilment exactly once", () => {
    const seam = codeOf(read(REVIEW_SEAM));
    const calls = seam.match(/verifyApprovedFulfilment\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("R32 DOES NOT BREAK R30 — R30's write primitive and reader are STILL each named by exactly one module", () => {
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

  it("R32 DOES NOT BREAK R30 — the SEND path STILL invokes fulfilApprovedBooking exactly once", () => {
    const seam = codeOf(read(REVIEW_SEAM));
    const calls = seam.match(/fulfilApprovedBooking\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });
});

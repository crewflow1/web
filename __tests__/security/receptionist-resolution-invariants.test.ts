import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONVERSATION RESOLUTION ENGINE governance invariants
 * (the AI Receptionist Programme, R33 — CONVERSATION RESOLUTION ENGINE).
 *
 * R17–R25 built the DERIVING stack; R26 RESOLVES an outcome; R27 PREPARES an action; R28 DECIDES an execution's
 * eligibility; R29 DETERMINES whether that decided execution requires APPROVAL; R30 PERFORMS the approved internal
 * business operation (booking fulfilment); R31 VERIFIES that performed operation and records an INTEGRITY verdict
 * (consistent / missing / inconsistent); R32 CLASSIFIES that verdict into the RECOVERY it warrants (none / reinstate /
 * reconcile) and records an auditable RECOVERY DISPOSITION. R33 is the NEXT layer — and, in this stack, the THIRD that
 * does not perform: given a DECIDED recovery, it CLASSIFIES that disposition into the CONVERSATION-COMPLETION state it
 * implies and records an auditable RESOLUTION. Its law is exact — "the Resolution Engine DETERMINES completion for a
 * recovered conversation; it CONSUMES the Recovery Decision (re-deriving nothing) and reads the RECORDED disposition;
 * it CLASSIFIES the disposition into a completion state (terminal / recoverable / unresolved) and reports whether the
 * conversation is terminal and whether further intervention is required, never a business action; it preserves Policy,
 * Audit and Human Review as mandatory (transitively, through the recovery it consumes); it is idempotent (a determined
 * recovery's resolution is determined AT MOST ONCE); and it MUST NOT bypass Human Review, perform / verify a fulfilment,
 * determine or execute a recovery, or duplicate any lower engine's logic." This suite proves that contract as a matter
 * of SOURCE, not discipline — the house bar of tool-registry-describes-not-authorises.test.ts:
 *
 *   • SINGLE WRITE PATH & SINGLE READ PATH — across all non-test source (app/, server/, lib/), the resolution ledger's
 *     write primitive (`record_receptionist_conversation_resolution`) AND the resolution-context reader
 *     (`find_receptionist_resolution_context`) are each named by EXACTLY ONE module: the resolution server runtime. No
 *     other file can file a resolution, so there is no second path.
 *   • THE PURE CORE IS PURE, MODEL-FREE & POLICY-FREE — it reaches no server / IO / model / clock / RNG, and its ONLY
 *     import is the R32 recovery surface it CONSUMES. It imports NO policy module, NO verification module, NO fulfilment
 *     module, NO authorisation module and NO other engine — R32 folded the whole stack (policy, verification, fulfilment,
 *     authorisation, execution, action, outcome) into the recovery decision — so there is provably NO duplicate logic. It
 *     CLASSIFIES a disposition; it persists nothing and resolves nothing itself.
 *   • THE RECOVERY ENGINE STAYS AUTHORITATIVE — the core CONSUMES the decided recovery (imports `isRecoveryDecided`,
 *     defers on it FIRST) and NEVER re-derives it (it never names `resolveRecovery`), so no duplicate recovery logic
 *     exists, and the Recovery Engine (and transitively Verification, Fulfilment, Authorisation, Execution, Action and
 *     Outcome) stays authoritative. The RUNTIME goes further: it reads R32's RECORDED disposition and re-derives NOTHING
 *     — it names NO resolver of ANY lower engine (not `resolveRecovery`, not `resolveVerification`, not
 *     `resolveFulfilment`, not `deriveAuthorisationState`).
 *   • POLICY & HUMAN REVIEW STAY MANDATORY — TRANSITIVELY, NOT RE-RUN — neither the core nor the runtime imports a
 *     policy surface or NAMES a policy decision function: a decided recovery exists ONLY for an approved, policy-cleared,
 *     verified, recovered operation (R32's inherited gate), so a policy-blocked or un-approved booking is structurally
 *     UNRESOLVABLE without this engine touching policy or re-deciding approval.
 *   • THE APPROVAL GATE IS INHERITED, AND RE-PINNED AT STORAGE — the core emits a resolution ONLY for a decided
 *     recovery (which only exists for an `approved` grant), so the approval gate is inherited via the FIRST defer; the
 *     ledger CHECK-pins `approval_state` to the single value 'approved' and `status` to 'determined'; and the write
 *     primitive REJECTS any other approval with "Human Review may not be bypassed". There is no path to resolving
 *     un-approved work.
 *   • THE COMPLETION STATE IS A COHERENT DETERMINATION — THE R33 KEYSTONE — two CHECKs (and the write primitive) pin
 *     `terminal = (resolution_state = 'terminal')` and `intervention_required = (resolution_state <> 'terminal')`: a
 *     stored resolution can NEVER claim the conversation is terminal over a `recoverable`/`unresolved` state, nor claim
 *     intervention is required over a `terminal` one. Terminal iff terminal; intervention required iff not terminal.
 *   • THE STATE IS A DETERMINISTIC FOLD — a CHECK (and the core switch, and the write primitive) pin the exact fold of
 *     the SOURCE recovery classification: `none` ⇒ `terminal`, `reinstate` ⇒ `recoverable`, `reconcile` ⇒ `unresolved`.
 *     And FULFILMENT-PRESENCE COHERENCE is inherited transitively from R32/R31: (fulfilment_id is null) = (classification
 *     = 'reinstate').
 *   • IT INTEGRATES WITH HUMAN REVIEW — IT NEVER DUPLICATES THE GRANT — the terminal grant arises ONLY through R14's
 *     Human Review architecture and R29's fold; the RUNTIME reads the RECORDED `approved` state, so it re-folds NOTHING
 *     (it names no `deriveAuthorisationState`) and records NOTHING (it names no `record_receptionist_review_resolution`).
 *     It threads the full Human Review provenance so the ledgers JOIN.
 *   • IT DETERMINES COMPLETION — IT EXECUTES NONE — neither the core nor the runtime reaches a transport, provider,
 *     generator, calendar, scheduler or quote path, AND — the load-bearing R33 proof — the runtime NAMES NEITHER R32's
 *     recovery writer (`record_receptionist_conversation_recovery`) NOR R32's recovery reader
 *     (`find_receptionist_recovery_context`) NOR R31's verification writer NOR R30's fulfilment writer: it re-recovers
 *     nothing, re-verifies nothing, re-books nothing, retries nothing, schedules nothing and corrects no record. The
 *     resolution ledger row IS the completion state and its audit.
 *   • IT IS IDEMPOTENT — NOT RETRY — the ledger's `recovery_id` is UNIQUE and the writer inserts ON CONFLICT DO NOTHING
 *     (returning the existing id), so a repeat determines nothing; the runtime orchestrates no re-attempt (retry is an
 *     explicit R33 non-goal — it names no setTimeout / setInterval / backoff).
 *   • THE PERSIST IS BEST-EFFORT — the runtime SWALLOWS a failed write (returns null), it never THROWS, and it reaches
 *     no model and no reply pipeline — the confirmation, the grant, the fulfilment, the verification and the recovery
 *     flow through the UNCHANGED pipelines.
 *   • THE LEDGER IS APPEND-ONLY, SERVICE-ROLE-ONLY, APPROVED-ONLY, DETERMINISTIC & COHERENT — RLS-enabled with no
 *     policies, UPDATE/DELETE rejected by triggers, a SECURITY DEFINER writer granted only to service_role, its
 *     `status` CHECK-pinned to 'determined', its `approval_state` CHECK-pinned to 'approved', a CHECK that pins
 *     (resolution_type, resolution_outcome) to the EXACT fold, the two completion-flag coherences, the state fold and
 *     the fulfilment-presence coherence above.
 *   • THE READER CENTRES ON THE RECOVERY LEDGER — a service-role-only SECURITY DEFINER `sql` function that SELECTs
 *     (never writes) R32's RECORDED disposition from `receptionist_conversation_recoveries` alone — it re-reads NEITHER
 *     the R31 verification ledger NOR the R30 fulfilment ledger directly. This centring IS the storage embodiment of
 *     "the Recovery Engine remains authoritative — the Resolution Engine consumes its RECORDED decision".
 *   • THE RUNTIME DETERMINES ON SEND ONLY — STRICTLY AFTER R30, R31 AND R32 — it is invoked from `resolveReviewSend`
 *     (never `resolveReviewDismiss`), exactly once, strictly AFTER the durable `sent` resolution guard, AFTER the R30
 *     fulfilment call, AFTER the R31 verification call AND AFTER the R32 recovery call, so Human Review can NEVER be
 *     bypassed and R33 always re-reads a committed R32 disposition.
 *   • IT DOES NOT BREAK R32, R31 OR R30 — R33 adds a DETERMINER, not a second recoverer, verifier or performer: R32's
 *     recovery write primitive and context reader are STILL each named by exactly one module (the R32 runtime), R31's
 *     verification write primitive STILL by one, R30's fulfilment write primitive STILL by one, `resolveRecovery` is
 *     STILL defined only in the R32 core, and the SEND path STILL invokes `recoverVerifiedFulfilment`,
 *     `verifyApprovedFulfilment` and `fulfilApprovedBooking` exactly once each. R33's modules name none of those
 *     primitives.
 *
 * The engine's runtime behaviour is pinned against real Postgres in
 * __tests__/integration/receptionist/conversation-resolution-pipeline.test.ts, and the pure core's resolution
 * exhaustively in __tests__/receptionist/conversation-resolution.test.ts. This tier is HERMETIC — a filesystem scan over
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
        out.push(full);
      }
    }
  };
  for (const r of roots) visit(resolve(ROOT, r));
  return out;
}

/** A repo-relative, POSIX-style path for stable assertions across platforms. */
const rel = (full: string) => relative(ROOT, full).split(sep).join("/");

const CORE = "lib/receptionist/conversation-resolution.ts";
const RUNTIME = "server/services/receptionist-resolution.ts";
const REVIEW_SEAM = "server/services/receptionist-review.ts";
const RECOVERY_CORE = "lib/receptionist/conversation-recovery.ts";
const MIGRATION = "supabase/migrations/20260902000000_receptionist_conversation_resolutions.sql";

/** The resolution ledger's write primitive — the function an auditor would call to file a resolution state. */
const WRITE_FN = /\brecord_receptionist_conversation_resolution\b/;

/** The resolution-context reader — the READ the runtime resolves R32's RECORDED disposition through. */
const READER_FN = /\bfind_receptionist_resolution_context\b/;

/** R32's recovery WRITE primitive — R33 must NAME it NOWHERE (it CONSUMES the recorded disposition, it never re-files it). */
const RECOVERY_WRITE_FN = /\brecord_receptionist_conversation_recovery\b/;

/** R32's recovery-context reader — R33 uses its OWN resolution-context reader, so R33 must NAME this NOWHERE. */
const RECOVERY_READER_FN = /\bfind_receptionist_recovery_context\b/;

/** R31's verification WRITE primitive — R33 must NAME it NOWHERE (it DETERMINES completion, it never verifies). */
const VERIFY_WRITE_FN = /\brecord_receptionist_conversation_verification\b/;

/** R30's fulfilment WRITE primitive — R33 must NAME it NOWHERE (it DETERMINES completion, it never PERFORMS a fulfilment). */
const FULFIL_WRITE_FN = /\brecord_receptionist_conversation_fulfilment\b/;

/** The R14 human-grant writer — R33 must NAME it NOWHERE (it READS the recorded grant, it never re-records it). */
const REVIEW_RESOLUTION_WRITE_FN = /\brecord_receptionist_review_resolution\b/;

/** The policy DECISION functions — neither core nor runtime may NAME one (policy is consumed transitively). */
const POLICY_DECISION_FNS = /\b(?:evaluateReply|isAutoSendable|redactReply|clearForHumanSend)\b/;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

// =====================================================================
// 0. The engine, the ledger and the runtime all ship, and the review SEND path integrates them.
// =====================================================================

describe("receptionist resolution — the engine ships and is wired", () => {
  it(`ships the append-only resolution ledger migration ${MIGRATION}`, () => {
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
    expect(code).toMatch(/export function resolveConversationResolution\(/);
    expect(code).toMatch(/export function isResolutionDecided\(/);
  });

  it("the server runtime exports the single resolution entry point", () => {
    const code = codeOf(read(RUNTIME));
    expect(code).toMatch(/export async function resolveConversationCompletion\(/);
  });

  it("the Human Review SEND path imports the resolution runtime (the sole caller)", () => {
    const specs = importSpecifiers(codeOf(read(REVIEW_SEAM)));
    expect(specs).toContain("@/server/services/receptionist-resolution");
  });
});

// =====================================================================
// 1. SINGLE WRITE PATH & SINGLE READ PATH — exactly one module names each ledger primitive.
// =====================================================================

describe("receptionist resolution — exactly one module writes the ledger and one reads the context", () => {
  const writers = walkSources(SOURCE_ROOTS)
    .filter((full) => WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();
  const readers = walkSources(SOURCE_ROOTS)
    .filter((full) => READER_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the ONLY module that names the ledger write primitive is the resolution server runtime", () => {
    // If this list ever grows, a second resolution-write path (or a bypass) has appeared.
    expect(writers).toEqual([RUNTIME]);
  });

  it("the ONLY module that names the resolution-context reader is the resolution server runtime", () => {
    expect(readers).toEqual([RUNTIME]);
  });

  it("no app/ route, action, or component files a resolution directly", () => {
    expect(writers.filter((p) => p.startsWith("app/"))).toEqual([]);
    expect(readers.filter((p) => p.startsWith("app/"))).toEqual([]);
  });

  it("no other server/ module files a resolution directly", () => {
    expect(writers.filter((p) => p !== RUNTIME && p.startsWith("server/"))).toEqual([]);
    expect(readers.filter((p) => p !== RUNTIME && p.startsWith("server/"))).toEqual([]);
  });

  it("the resolution entry point resolveConversationResolution is DEFINED in exactly one module — the pure core", () => {
    // No feature implements independent resolution logic: the single source of truth is exported once and consumed.
    const definers = walkSources(SOURCE_ROOTS)
      .filter((full) => /export function resolveConversationResolution\(/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(definers).toEqual([CORE]);
  });
});

// =====================================================================
// 2. The pure core is PURE, MODEL-FREE and POLICY-FREE — it CONSUMES the recovery surface, and nothing else.
// =====================================================================

describe("receptionist resolution — the pure core is pure, model-free and policy-free", () => {
  const pcode = codeOf(read(CORE));

  it("is a shared pure module (NOT server-only — the runtime and tests import it)", () => {
    expect(importSpecifiers(pcode)).not.toContain("server-only");
  });

  it("its ONLY import is the R32 recovery surface it consumes — NO policy, NO verification, NO other module", () => {
    // The recovery import is the predicate it CONSUMES (isRecoveryDecided) plus its types. There is NOTHING else — most
    // importantly NO policy module, NO verification module, NO fulfilment module and NO authorisation module (R32 already
    // folded the whole stack into the recovery decision). This is the headline R33 proof that no duplicate policy,
    // verification, fulfilment, authorisation or recovery logic is introduced.
    expect(pcode).toMatch(/isRecoveryDecided/);
    expect(importSpecifiers(pcode)).toEqual(["@/lib/receptionist/conversation-recovery"]);
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/policy");
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/conversation-verification");
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/conversation-fulfilment");
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/conversation-authorisation");
  });

  it("DUPLICATES NOTHING beneath it — it re-derives no recovery, verification, fulfilment, authorisation, action or outcome", () => {
    // It consumes ALREADY-computed inputs; it names none of the resolvers/extractors/detectors — most importantly it
    // NEVER re-derives the recovery (it CONSUMES the R32 decision via isRecoveryDecided) and it re-folds no grant. This
    // is the R33 analogue of R32's "never names resolveVerification".
    expect(pcode).not.toMatch(/\bresolveRecovery\b/);
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

  it("touches no I/O and calls no model — it classifies, it does not generate, persist or resolve", () => {
    expect(pcode).not.toMatch(/createAdminClient/);
    expect(pcode).not.toMatch(/supabase/i);
    expect(pcode).not.toMatch(/\bfetch\(/);
    expect(pcode).not.toMatch(/@\/lib\/ai\//);
    expect(pcode).not.toMatch(/Anthropic/);
    // It performs NO org lookup and NO env read.
    expect(pcode).not.toMatch(/process\.env/);
  });

  it("has no clock and no RNG (a resolution is reconstructable)", () => {
    expect(pcode).not.toMatch(/Math\.random/);
    expect(pcode).not.toMatch(/Date\.now/);
    expect(pcode).not.toMatch(/new Date\(/);
  });

  it("names NO ledger primitive — the pure core reaches neither its own writer/reader nor R30/R31/R32's", () => {
    expect(pcode).not.toMatch(WRITE_FN);
    expect(pcode).not.toMatch(READER_FN);
    expect(pcode).not.toMatch(RECOVERY_WRITE_FN);
    expect(pcode).not.toMatch(RECOVERY_READER_FN);
    expect(pcode).not.toMatch(VERIFY_WRITE_FN);
    expect(pcode).not.toMatch(FULFIL_WRITE_FN);
  });
});

// =====================================================================
// 3. The Recovery Engine remains AUTHORITATIVE — the resolution CONSUMES it and DEFERS to it.
// =====================================================================

describe("receptionist resolution — the Recovery Engine stays authoritative", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("CONSUMES the decided recovery — resolveConversationResolution defers on it FIRST", () => {
    // The first gate stands down when the Recovery Engine rendered no decision (transitively preserving the
    // Verification, Fulfilment, Authorisation, Execution, Action and Outcome Engines' authority too — a decided recovery
    // only exists for an approved, verified, recovered operation).
    expect(pcode).toMatch(
      /if \(!isRecoveryDecided\(recovery\)\) return abstain\("no_recovery_decision"\)/,
    );
  });

  it("NEVER re-derives the recovery — the core names isRecoveryDecided but not resolveRecovery", () => {
    expect(pcode).toMatch(/isRecoveryDecided/);
    expect(pcode).not.toMatch(/\bresolveRecovery\b/);
  });

  it("the RUNTIME re-derives NOTHING — it consumes R32's RECORDED disposition and names no lower resolver", () => {
    // Design B: the runtime reads R32's RECORDED recovery row and reconstructs the decision verbatim from the recorded
    // columns. It never re-recovers, never re-verifies, never re-derives the fulfilment, never re-folds the grant — so
    // it names NO resolver of ANY lower engine. This is the same strong authority proof as R32's runtime (which consumed
    // the recorded verdict wholesale): R33 consumes the recorded disposition wholesale.
    expect(rcode).not.toMatch(/\bresolveRecovery\b/);
    expect(rcode).not.toMatch(/\bresolveVerification\b/);
    expect(rcode).not.toMatch(/\bresolveFulfilment\b/);
    expect(rcode).not.toMatch(/\bderiveAuthorisationState\b/);
    expect(rcode).not.toMatch(/\bresolveAuthorisation\b/);
    expect(rcode).not.toMatch(/\bresolveExecution\b/);
    expect(rcode).not.toMatch(/\bresolveAction\b/);
  });

  it("the recovery→resolution map maps recover_booking_fulfilment → resolve_booking_recovery (it consumes the R32 vocabulary)", () => {
    expect(pcode).toMatch(/recover_booking_fulfilment:\s*"resolve_booking_recovery"/);
  });

  it("the booking it resolves is BY REFERENCE the recovery's payload — it can never drift from the decision", () => {
    expect(pcode).toMatch(/booking:\s*recovery\.booking/);
  });
});

// =====================================================================
// 4. Policy stays MANDATORY — transitively, through the recovery; neither core nor runtime imports or re-runs it.
// =====================================================================

describe("receptionist resolution — policy is consumed transitively, never imported or re-run", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("neither the core nor the runtime imports the policy module (the recovery already folded the verdict)", () => {
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/policy");
    expect(importSpecifiers(rcode)).not.toContain("@/lib/receptionist/policy");
  });

  it("neither the core nor the runtime NAMES a policy decision function or the guardrail verdict type", () => {
    // A policy `block` foreclosed the authorisation at R29, foreclosed can never derive to `approved`, an un-approved
    // authorisation is never fulfilled at R30, verified at R31 nor recovered at R32 — so a policy-blocked booking is
    // structurally UNRESOLVABLE WITHOUT this engine touching policy.
    expect(pcode).not.toMatch(POLICY_DECISION_FNS);
    expect(rcode).not.toMatch(POLICY_DECISION_FNS);
    expect(pcode).not.toMatch(/GuardrailVerdict/);
    expect(rcode).not.toMatch(/GuardrailVerdict/);
  });
});

// =====================================================================
// 5. THE APPROVAL GATE — inherited from R32 via the FIRST defer, and re-pinned at the storage layer.
// =====================================================================

describe("receptionist resolution — the approval gate is inherited, and re-pinned in the ledger", () => {
  const pcode = codeOf(read(CORE));
  const sql = sqlCodeOf(read(MIGRATION));

  it("the pure core emits a resolution ONLY for a DECIDED recovery — the approval gate is inherited", () => {
    // R33's core has no approval literal of its own: a decided recovery exists ONLY for an `approved` grant (R32's
    // inherited gate, R31's inherited gate, R30's keystone), so deferring to isRecoveryDecided FIRST inherits the
    // approval gate transitively.
    expect(pcode).toMatch(
      /if \(!isRecoveryDecided\(recovery\)\) return abstain\("no_recovery_decision"\)/,
    );
  });

  it("names NO autonomous-approve construct anywhere in the core — the grant is the human's", () => {
    expect(pcode).not.toMatch(/auto[_-]?approve/i);
    expect(pcode).not.toMatch(/approve_now/i);
    expect(pcode).not.toMatch(/autonomous[_-]?approv/i);
  });

  it("APPROVED BY CONSTRUCTION — the ledger CHECK-pins approval_state to the single value 'approved'", () => {
    // Inherited from R32 → R31 → R30: a resolution can ONLY exist for an approved operation.
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
// 6. THE R33 KEYSTONE — terminal = (state = 'terminal') and intervention_required = (state <> 'terminal'); plus the
//    state fold and the inherited fulfilment-presence coherence. The whole row is deterministic and coherent by
//    construction.
// =====================================================================

describe("receptionist resolution — the completion state is coherent with its flags (the R33 keystone)", () => {
  const pcode = codeOf(read(CORE));
  const sql = sqlCodeOf(read(MIGRATION));

  it("the resolution state vocabulary is EXACTLY {terminal, recoverable, unresolved} — a closed set of completions", () => {
    expect(pcode).toMatch(
      /ResolutionState\s*=\s*"terminal"\s*\|\s*"recoverable"\s*\|\s*"unresolved"/,
    );
  });

  it("a record is produced for ALL THREE states — recoverable and unresolved are NOT abstentions", () => {
    // The abstention vocabulary is ONLY the two deferrals; the states are findings on a produced record.
    expect(pcode).toMatch(
      /ResolutionAbstention\s*=\s*"no_recovery_decision"\s*\|\s*"unsupported_recovery"/,
    );
    // Isolate the abstention type DECLARATION (from its `=` to the terminating `;`) and prove neither non-terminal
    // completion state leaks into it — `recoverable` / `unresolved` are findings on a produced decision, never a
    // "nothing here".
    const declStart = pcode.indexOf("ResolutionAbstention =");
    const abstentionDecl = pcode.slice(declStart, pcode.indexOf(";", declStart));
    expect(declStart).toBeGreaterThan(-1);
    expect(abstentionDecl).not.toMatch(/recoverable/);
    expect(abstentionDecl).not.toMatch(/unresolved/);
  });

  it("THE KEYSTONE, IN THE CORE — terminal is TRUE iff the state is `terminal`, intervention required iff it is NOT", () => {
    expect(pcode).toMatch(/terminal:\s*state === "terminal"/);
    expect(pcode).toMatch(/intervention_required:\s*state !== "terminal"/);
  });

  it("COHERENT BY CONSTRUCTION — table CHECKs pin terminal = (state = 'terminal') and intervention_required = (state <> 'terminal')", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_resolutions_terminal_coherence check/i,
    );
    expect(sql).toMatch(/terminal = \(resolution_state = 'terminal'\)/i);
    expect(sql).toMatch(
      /constraint receptionist_conversation_resolutions_intervention_coherence check/i,
    );
    expect(sql).toMatch(/intervention_required = \(resolution_state <> 'terminal'\)/i);
  });

  it("the write primitive re-validates both coherences (belt-and-braces with the table CHECKs)", () => {
    // A `recoverable`/`unresolved` state carrying terminal=true — or a `terminal` state carrying
    // intervention_required=true — is rejected by the primitive, not only by the column CHECKs.
    expect(sql).toMatch(/p_terminal <> \(p_resolution_state = 'terminal'\)/i);
    expect(sql).toMatch(/terminal=% is incoherent with state/i);
    expect(sql).toMatch(/p_intervention_required <> \(p_resolution_state <> 'terminal'\)/i);
    expect(sql).toMatch(/intervention_required=% is incoherent with state/i);
  });
});

describe("receptionist resolution — the state is the deterministic fold of the recovery, coherent with the record", () => {
  const pcode = codeOf(read(CORE));
  const sql = sqlCodeOf(read(MIGRATION));

  it("THE FOLD, IN THE CORE — a closed switch folds none⇒terminal, reinstate⇒recoverable, reconcile⇒unresolved", () => {
    expect(pcode).toMatch(/case "none":\s*return "terminal"/);
    expect(pcode).toMatch(/case "reinstate":\s*return "recoverable"/);
    expect(pcode).toMatch(/case "reconcile":\s*return "unresolved"/);
  });

  it("THE FOLD, ENFORCED — a table CHECK pins the exact fold of the source recovery classification to its state", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_resolutions_state_fold check/i,
    );
    expect(sql).toMatch(/\(recovery_classification = 'none' and resolution_state = 'terminal'\)/i);
    expect(sql).toMatch(
      /\(recovery_classification = 'reinstate' and resolution_state = 'recoverable'\)/i,
    );
    expect(sql).toMatch(
      /\(recovery_classification = 'reconcile' and resolution_state = 'unresolved'\)/i,
    );
  });

  it("the write primitive re-validates the state fold (belt-and-braces with the table CHECK)", () => {
    expect(sql).toMatch(/is not the deterministic fold of recovery classification/i);
  });

  it("FULFILMENT-PRESENCE COHERENCE, INHERITED TRANSITIVELY FROM R32/R31 — a table CHECK pins (fulfilment_id is null) = (classification = 'reinstate')", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_resolutions_fulfilment_coherence check/i,
    );
    expect(sql).toMatch(
      /\(\s*fulfilment_id is null\s*\)\s*=\s*\(\s*recovery_classification = 'reinstate'\s*\)/i,
    );
  });

  it("the write primitive re-validates the fulfilment-presence coherence (belt-and-braces with the table CHECK)", () => {
    expect(sql).toMatch(/\(p_fulfilment_id is null\)\s*<>\s*\(p_recovery_classification = 'reinstate'\)/i);
    expect(sql).toMatch(/incoherent with fulfilment_id/i);
  });

  it("bounds the state and the classification to their vocabularies in the ledger CHECK and the primitive", () => {
    expect(sql).toMatch(
      /check\s*\(\s*resolution_state\s+in\s*\(\s*'terminal',\s*'recoverable',\s*'unresolved'\s*\)\s*\)/i,
    );
    expect(sql).toMatch(
      /check\s*\(\s*recovery_classification\s+in\s*\(\s*'none',\s*'reinstate',\s*'reconcile'\s*\)\s*\)/i,
    );
    expect(sql).toMatch(/p_resolution_state not in \('terminal', 'recoverable', 'unresolved'\)/i);
    expect(sql).toMatch(/p_recovery_classification not in \('none', 'reinstate', 'reconcile'\)/i);
  });
});

// =====================================================================
// 7. INTEGRATE with Human Review — NEVER DUPLICATE the grant. R33 reads the RECORDED grant; it re-folds nothing.
// =====================================================================

describe("receptionist resolution — integrates with Human Review, never duplicates the grant", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("the grant is neither re-folded nor re-recorded — the runtime reads the RECORDED approval_state", () => {
    // R33 consumes R32's RECORDED recovery row — which already carries the folded `approved` state — so neither the core
    // nor the runtime re-folds the grant. No duplicate approval logic.
    expect(pcode).not.toMatch(/\bderiveAuthorisationState\b/);
    expect(rcode).not.toMatch(/\bderiveAuthorisationState\b/);
  });

  it("NEITHER the core nor the runtime records a human grant — it names no review-resolution writer", () => {
    // The grant is the human's, recorded by the UNCHANGED R14 Human Review architecture. R33 reads it; it never
    // re-records it, so there is no duplicate human-decision recorder.
    expect(pcode).not.toMatch(REVIEW_RESOLUTION_WRITE_FN);
    expect(rcode).not.toMatch(REVIEW_RESOLUTION_WRITE_FN);
  });

  it("the runtime threads the FULL provenance — the recovery, the verification, the held reply, the sent reply and the resolution", () => {
    expect(rcode).toMatch(/p_recovery_id:/);
    expect(rcode).toMatch(/p_verification_id:/);
    expect(rcode).toMatch(/p_review_audit_id:/);
    expect(rcode).toMatch(/p_sent_audit_id:/);
    expect(rcode).toMatch(/p_review_resolution_id:/);
  });
});

// =====================================================================
// 8. It DETERMINES completion — it EXECUTES none; reaching NO external system; idempotent (not retry); best-effort.
// =====================================================================

describe("receptionist resolution — determines completion, executes none, idempotently, best-effort", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("the resolution vocabulary is EXACTLY {resolve_booking_recovery} — quote/scheduling resolutions are absent", () => {
    expect(pcode).toMatch(/RESOLUTION_TYPES\s*=\s*\[\s*"resolve_booking_recovery"\s*\]/);
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

  it("IT DETERMINES — IT NEVER EXECUTES — neither the core nor the runtime NAMES R32's recovery, R31's verification or R30's fulfilment writer", () => {
    // THE load-bearing R33 proof. R33 re-recovers nothing (names no R32 recovery writer and no R32 recovery reader),
    // re-verifies nothing (names no R31 verification writer) and re-books nothing (names no R30 fulfilment writer): it
    // reads R32's RECORDED disposition through its OWN reader and files a resolution state — never a recovery row, never
    // a verification row, never a fulfilment row.
    expect(pcode).not.toMatch(RECOVERY_WRITE_FN);
    expect(rcode).not.toMatch(RECOVERY_WRITE_FN);
    expect(pcode).not.toMatch(RECOVERY_READER_FN);
    expect(rcode).not.toMatch(RECOVERY_READER_FN);
    expect(pcode).not.toMatch(VERIFY_WRITE_FN);
    expect(rcode).not.toMatch(VERIFY_WRITE_FN);
    expect(pcode).not.toMatch(FULFIL_WRITE_FN);
    expect(rcode).not.toMatch(FULFIL_WRITE_FN);
  });

  it("the runtime writes NO tenant row — no lead reflection, no customer promotion (the ledger IS the state)", () => {
    // Like the R27–R32 runtimes, a resolution touches NO tenant table: no `.from(...)` at all, no lead write, no
    // customers. Scheduling, promotion, re-booking and external writes are non-goals.
    expect(rcode).not.toMatch(/\.from\(/);
    expect(rcode).not.toMatch(/customers/);
    expect(rcode).not.toMatch(/\bleads\b/);
    expect(rcode).not.toMatch(/contact_phone/);
  });

  it("the runtime writes ONLY the one internal row — the resolution ledger, through the write primitive", () => {
    expect(rcode).toMatch(WRITE_FN);
  });

  it("IDEMPOTENT, NOT RETRY — it names no re-attempt orchestration (retry is an explicit R33 non-goal)", () => {
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

  it("is server-only — it is the ONE place a recovered conversation's resolution is durably determined", () => {
    expect(importSpecifiers(rcode)).toContain("server-only");
  });
});

// =====================================================================
// 9. The migration installs an APPEND-ONLY, service-role-only, APPROVED-ONLY, DETERMINISTIC, IDEMPOTENT ledger.
// =====================================================================

describe("receptionist resolution — the ledger is append-only, service-role-only, approved-only and idempotent", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("creates the receptionist_conversation_resolutions table", () => {
    expect(sql).toMatch(
      /create table if not exists public\.receptionist_conversation_resolutions/i,
    );
  });

  it("captures the anchors, the Human Review provenance, the operation, its state, its payload and the status", () => {
    for (const column of [
      "org_id",
      "conversation_id",
      "enquiry_id",
      "lead_id",
      "customer_ref",
      "correlation_id",
      "action_id",
      "execution_id",
      "recovery_id",
      "authorisation_id",
      "verification_id",
      "fulfilment_id",
      "review_audit_id",
      "sent_audit_id",
      "review_resolution_id",
      "resolution_type",
      "resolution_outcome",
      "resolution_state",
      "terminal",
      "intervention_required",
      "recovery_classification",
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

  it("bounds the resolution type and outcome to their vocabularies {resolve_booking_recovery} / {conversation_resolution_determined}", () => {
    expect(sql).toMatch(
      /check\s*\(\s*resolution_type\s+in\s*\(\s*'resolve_booking_recovery'\s*\)\s*\)/i,
    );
    expect(sql).toMatch(
      /check\s*\(\s*resolution_outcome\s+in\s*\(\s*'conversation_resolution_determined'\s*\)\s*\)/i,
    );
  });

  it("DETERMINISTIC BY CONSTRUCTION — a CHECK pins (resolution_type, resolution_outcome) to the exact fold", () => {
    // resolve_booking_recovery ⇒ conversation_resolution_determined. No writer — not even service_role — can file a row
    // whose outcome contradicts its type.
    expect(sql).toMatch(/constraint receptionist_conversation_resolutions_outcome_fold check/i);
    expect(sql).toMatch(
      /resolution_type = 'resolve_booking_recovery' and resolution_outcome = 'conversation_resolution_determined'/i,
    );
  });

  it("IDEMPOTENT BY CONSTRUCTION — recovery_id is UNIQUE and the writer inserts ON CONFLICT DO NOTHING", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_resolutions_recovery_unique unique \(recovery_id\)/i,
    );
    expect(sql).toMatch(/on conflict \(recovery_id\) do nothing/i);
    // On a repeat, the primitive resolves the existing row's id so the operation is a true no-op.
    expect(sql).toMatch(/select id into v_id[\s\S]*?where recovery_id = p_recovery_id/i);
  });

  it("the recovery anchor is NOT NULL in DDL — a resolution is ALWAYS determined from a recorded recovery", () => {
    // R33's load-bearing anchor: the storage proof that "the Recovery Engine remains authoritative".
    expect(sql).toMatch(/recovery_id\s+uuid\s+not null/i);
    // The authorisation + verification anchors are equally mandatory.
    expect(sql).toMatch(/authorisation_id uuid\s+not null/i);
    expect(sql).toMatch(/verification_id uuid\s+not null/i);
  });

  it("bounds the expected booking number to the E.164 shape and the postcode to its shape in DDL", () => {
    expect(sql).toMatch(/phone_number\s+text\s+check\s*\([\s\S]*?\+\\d\{10,15\}/i);
    expect(sql).toMatch(/postcode\s+text\s+check\s*\([\s\S]*?A-Z/i);
  });

  it("enables RLS with NO policies — service-role / SECURITY DEFINER only", () => {
    expect(sql).toMatch(
      /alter table public\.receptionist_conversation_resolutions enable row level security/i,
    );
    expect(sql).not.toMatch(
      /create policy[\s\S]*?on public\.receptionist_conversation_resolutions/i,
    );
  });

  it("is APPEND-ONLY — UPDATE and DELETE are rejected by triggers", () => {
    expect(sql).toMatch(
      /create or replace function public\.receptionist_conversation_resolutions_block_mutation\(/i,
    );
    expect(sql).toMatch(/raise exception[\s\S]*?append-only[\s\S]*?tg_op/i);
    expect(sql).toMatch(/errcode\s*=\s*'restrict_violation'/i);
    expect(sql).toMatch(
      /create trigger receptionist_conversation_resolutions_no_update\s+before update on public\.receptionist_conversation_resolutions/i,
    );
    expect(sql).toMatch(
      /create trigger receptionist_conversation_resolutions_no_delete\s+before delete on public\.receptionist_conversation_resolutions/i,
    );
  });

  it("writes only through a SECURITY DEFINER primitive granted only to service_role", () => {
    expect(sql).toMatch(
      /create or replace function public\.record_receptionist_conversation_resolution\(/i,
    );
    expect(sql).toMatch(/returns uuid/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = ''/i);
    expect(sql).toMatch(/insert into public\.receptionist_conversation_resolutions/i);
    expect(sql).toMatch(/revoke all on function[\s\S]*?from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*?to service_role/i);
  });

  it("the write primitive re-validates the (type, outcome) fold (belt-and-braces with the table CHECK)", () => {
    expect(sql).toMatch(/does not match the deterministic fold/i);
  });

  it("REQUIRES the recovery anchor and the full Human Review provenance and a well-formed booking payload", () => {
    // The recovery + authorisation + verification anchors plus the three provenance ids are mandatory...
    expect(sql).toMatch(
      /p_recovery_id is null[\s\S]*?p_authorisation_id is null[\s\S]*?p_verification_id is null[\s\S]*?p_review_audit_id is null[\s\S]*?p_sent_audit_id is null[\s\S]*?p_review_resolution_id is null/i,
    );
    // ...and a resolve_booking_recovery must carry an expected job type plus a well-formed postcode and E.164 number.
    expect(sql).toMatch(/p_resolution_type\s*=\s*'resolve_booking_recovery'[\s\S]*?\+\\d\{10,15\}/i);
    expect(sql).toMatch(/p_resolution_type\s*=\s*'resolve_booking_recovery'[\s\S]*?p_job_type is null/i);
  });
});

// =====================================================================
// 10. The RESOLUTION-CONTEXT READER centres on the R32 recovery ledger; the runtime determines on SEND, AFTER R32.
// =====================================================================

describe("receptionist resolution — the reader centres on the recovery ledger, and resolution fires on SEND after R32", () => {
  const sql = sqlCodeOf(read(MIGRATION));
  const seam = codeOf(read(REVIEW_SEAM));

  it("the reader is a service-role-only SECURITY DEFINER sql function granted only to service_role", () => {
    expect(sql).toMatch(
      /create or replace function public\.find_receptionist_resolution_context\(/i,
    );
    expect(sql).toMatch(
      /revoke all on function public\.find_receptionist_resolution_context\(uuid, uuid\)\s*from public, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.find_receptionist_resolution_context\(uuid, uuid\)\s*to service_role/i,
    );
  });

  it("the reader CENTRES on the R32 recovery ledger — it reads the RECORDED disposition, and it never writes", () => {
    // Slice the reader function body (from its definition to its revoke) and prove it is a pure SELECT over R32's
    // recovery ledger. THE storage embodiment of "the Recovery Engine remains authoritative": the reader supplies R32's
    // RECORDED disposition, and the runtime reconstructs the decision from it — it never decides.
    const start = sql.indexOf("function public.find_receptionist_resolution_context");
    const body = sql.slice(start, sql.indexOf("revoke all on function", start));
    expect(body).toMatch(/language sql/i);
    expect(body).toMatch(/security definer/i);
    expect(body).toMatch(/from public\.receptionist_conversation_recoveries/i);
    expect(body).toMatch(/r\.status = 'determined'/i);
    expect(body).not.toMatch(/\binsert\b/i);
    expect(body).not.toMatch(/\bupdate\b/i);
    expect(body).not.toMatch(/\bdelete\b/i);
  });

  it("Design B — the reader re-reads NEITHER the R31 verification ledger NOR the R30 fulfilment ledger directly", () => {
    // R33 consumes R32's RECORDED disposition wholesale; it does NOT re-derive from the lower ledgers (that would be
    // duplicate logic). The reader's ONLY source is the recovery ledger.
    const start = sql.indexOf("function public.find_receptionist_resolution_context");
    const body = sql.slice(start, sql.indexOf("revoke all on function", start));
    expect(body).not.toMatch(/from public\.receptionist_conversation_verifications/i);
    expect(body).not.toMatch(/from public\.receptionist_conversation_fulfilments/i);
    expect(body).not.toMatch(/\bjoin\b/i);
  });

  it("the SEND path invokes the Resolution Engine EXACTLY ONCE", () => {
    const calls = seam.match(/resolveConversationCompletion\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("resolution is invoked from resolveReviewSend — NEVER from resolveReviewDismiss", () => {
    // Prove placement structurally: the call lives between the two function definitions (inside SEND), and the DISMISS
    // body — everything from its definition onward — names the engine NOWHERE.
    const sendIdx = seam.indexOf("resolveReviewSend");
    const dismissIdx = seam.indexOf("resolveReviewDismiss");
    expect(sendIdx).toBeGreaterThan(-1);
    expect(dismissIdx).toBeGreaterThan(sendIdx);
    const sendBody = seam.slice(sendIdx, dismissIdx);
    const dismissBody = seam.slice(dismissIdx);
    expect(sendBody).toMatch(/resolveConversationCompletion\(/);
    expect(dismissBody).not.toMatch(/resolveConversationCompletion\(/);
  });

  it("resolution fires STRICTLY AFTER the `sent` guard, AFTER R30, AFTER R31 AND AFTER R32", () => {
    // Human Review can never be bypassed AND R33 always re-reads a committed R32 disposition: the call is downstream of
    // the `already_resolved` guard, downstream of fulfilApprovedBooking, downstream of verifyApprovedFulfilment,
    // downstream of recoverVerifiedFulfilment, and only when the send produced an audit.
    const sendIdx = seam.indexOf("resolveReviewSend");
    const dismissIdx = seam.indexOf("resolveReviewDismiss");
    const sendBody = seam.slice(sendIdx, dismissIdx);
    const guardIdx = sendBody.indexOf('"already_resolved", outcome');
    const fulfilIdx = sendBody.indexOf("fulfilApprovedBooking(");
    const verifyIdx = sendBody.indexOf("verifyApprovedFulfilment(");
    const recoverIdx = sendBody.indexOf("recoverVerifiedFulfilment(");
    const resolveIdx = sendBody.indexOf("resolveConversationCompletion(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fulfilIdx).toBeGreaterThan(guardIdx);
    expect(verifyIdx).toBeGreaterThan(fulfilIdx); // VERIFY strictly after FULFIL
    expect(recoverIdx).toBeGreaterThan(verifyIdx); // RECOVER strictly after VERIFY
    expect(resolveIdx).toBeGreaterThan(recoverIdx); // RESOLVE strictly after RECOVER
    expect(sendBody).toMatch(/if \(outcome\.audit_id !== null\)/);
  });
});

// =====================================================================
// 11. The R32 recovery core stays the SOLE authority R33 consumes; and R33 does NOT break R32, R31 or R30.
// =====================================================================

describe("receptionist resolution — it consumes the R32 recovery core, and adds a determiner not a second recoverer", () => {
  it("the R32 recovery core ships (the surface the resolution engine consumes)", () => {
    expect(existsSync(resolve(ROOT, RECOVERY_CORE)), RECOVERY_CORE).toBe(true);
  });

  it("the runtime reconstructs the recovery decision from the RECORDED disposition, and classifies it — nothing more", () => {
    const rcode = codeOf(read(RUNTIME));
    // It rebuilds the R32 RecoverBookingDecision from the reader row (the booking is reconstructed verbatim) and hands
    // it to the pure resolveConversationResolution — but it names NO resolver of any lower engine, and it re-decides
    // neither the recovery, the verification, the fulfilment, nor the authorisation. The Recovery Engine is
    // authoritative.
    expect(rcode).toMatch(/kind:\s*"prepare_booking"/);
    expect(rcode).toMatch(/\bresolveConversationResolution\b/);
    expect(rcode).not.toMatch(/\bresolveRecovery\b/);
    expect(rcode).not.toMatch(/\bresolveVerification\b/);
    expect(rcode).not.toMatch(/\bresolveFulfilment\b/);
    expect(rcode).not.toMatch(/\bderiveAuthorisationState\b/);
    expect(rcode).not.toMatch(/\bresolveAuthorisation\b/);
    expect(rcode).not.toMatch(/\bresolveExecution\b/);
    expect(rcode).not.toMatch(/\bresolveAction\b/);
  });

  it("R33 NAMES NEITHER R32's ledger primitives NOR R31's NOR R30's — it recovers nothing, verifies nothing, performs nothing", () => {
    const pcode = codeOf(read(CORE));
    const rcode = codeOf(read(RUNTIME));
    for (const code of [pcode, rcode]) {
      expect(code).not.toMatch(RECOVERY_WRITE_FN); // never files an R32 recovery
      expect(code).not.toMatch(RECOVERY_READER_FN); // never uses R32's own reader
      expect(code).not.toMatch(VERIFY_WRITE_FN); // never files an R31 verification
      expect(code).not.toMatch(FULFIL_WRITE_FN); // never files an R30 fulfilment
    }
  });

  it("R33 DOES NOT BREAK R32 — R32's write primitive and context reader are STILL each named by exactly one module", () => {
    // R33 must not have introduced a second recovery write path or reader. Across all source, R32's primitives are STILL
    // named ONLY by the R32 runtime — proof that R33 is additive, not a second recoverer.
    const R32_RUNTIME = "server/services/receptionist-recovery.ts";
    const recoveryWriters = walkSources(SOURCE_ROOTS)
      .filter((full) => RECOVERY_WRITE_FN.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    const recoveryReaders = walkSources(SOURCE_ROOTS)
      .filter((full) => RECOVERY_READER_FN.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(recoveryWriters).toEqual([R32_RUNTIME]);
    expect(recoveryReaders).toEqual([R32_RUNTIME]);
  });

  it("R33 DOES NOT BREAK R32 — resolveRecovery is STILL defined only in the R32 recovery core", () => {
    const definers = walkSources(SOURCE_ROOTS)
      .filter((full) => /export function resolveRecovery\(/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(definers).toEqual([RECOVERY_CORE]);
  });

  it("R33 DOES NOT BREAK R32 — the SEND path STILL invokes recoverVerifiedFulfilment exactly once", () => {
    const seam = codeOf(read(REVIEW_SEAM));
    const calls = seam.match(/recoverVerifiedFulfilment\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("R33 DOES NOT BREAK R31 — R31's write primitive is STILL named by exactly one module, and SEND STILL verifies once", () => {
    const R31_RUNTIME = "server/services/receptionist-verification.ts";
    const verifyWriters = walkSources(SOURCE_ROOTS)
      .filter((full) => VERIFY_WRITE_FN.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(verifyWriters).toEqual([R31_RUNTIME]);
    const seam = codeOf(read(REVIEW_SEAM));
    const calls = seam.match(/verifyApprovedFulfilment\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("R33 DOES NOT BREAK R30 — R30's write primitive is STILL named by exactly one module, and SEND STILL fulfils once", () => {
    const R30_RUNTIME = "server/services/receptionist-fulfilment.ts";
    const fulfilWriters = walkSources(SOURCE_ROOTS)
      .filter((full) => FULFIL_WRITE_FN.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(fulfilWriters).toEqual([R30_RUNTIME]);
    const seam = codeOf(read(REVIEW_SEAM));
    const calls = seam.match(/fulfilApprovedBooking\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });
});

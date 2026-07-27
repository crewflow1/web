import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONVERSATION LIFECYCLE ENGINE governance invariants
 * (the AI Receptionist Programme, R34 — CONVERSATION LIFECYCLE ENGINE).
 *
 * R17–R25 built the DERIVING stack; R26 RESOLVES an outcome; R27 PREPARES an action; R28 DECIDES an execution's
 * eligibility; R29 DETERMINES whether that decided execution requires APPROVAL; R30 PERFORMS the approved internal
 * business operation (booking fulfilment); R31 VERIFIES that performed operation and records an INTEGRITY verdict
 * (consistent / missing / inconsistent); R32 CLASSIFIES that verdict into the RECOVERY it warrants (none / reinstate /
 * reconcile); R33 CLASSIFIES that recovery into the CONVERSATION-COMPLETION state it implies (terminal / recoverable /
 * unresolved) and records an auditable RESOLUTION. R34 is the NEXT layer — and, in this stack, the FOURTH that does not
 * perform: given a DETERMINED resolution, it GOVERNS that disposition into the CONVERSATION-LIFECYCLE transition it
 * undergoes and the state it comes to rest in, and records an auditable LIFECYCLE. Its law is exact — "the Lifecycle
 * Engine GOVERNS the lifecycle for a resolved conversation; it CONSUMES the Resolution Decision (re-deriving nothing)
 * and reads the RECORDED disposition; it GOVERNS the disposition into a lifecycle transition (close / retain / escalate)
 * and the state it rests in (closed / retained / escalated) and reports whether the conversation is closed and whether
 * it remains ongoing, never a business action; it preserves Policy, Audit and Human Review as mandatory (transitively,
 * through the resolution it consumes); it is idempotent (a determined resolution's lifecycle is governed AT MOST ONCE);
 * and it MUST NOT bypass Human Review, perform / verify a fulfilment, determine or execute a recovery, determine a
 * resolution, or duplicate any lower engine's logic." This suite proves that contract as a matter of SOURCE, not
 * discipline — the house bar of tool-registry-describes-not-authorises.test.ts:
 *
 *   • SINGLE WRITE PATH & SINGLE READ PATH — across all non-test source (app/, server/, lib/), the lifecycle ledger's
 *     write primitive (`record_receptionist_conversation_lifecycle`) AND the lifecycle-context reader
 *     (`find_receptionist_lifecycle_context`) are each named by EXACTLY ONE module: the lifecycle server runtime. No
 *     other file can file a lifecycle, so there is no second path.
 *   • THE PURE CORE IS PURE, MODEL-FREE & POLICY-FREE — it reaches no server / IO / model / clock / RNG, and its ONLY
 *     import is the R33 resolution surface it CONSUMES. It imports NO policy module, NO recovery module, NO verification
 *     module, NO fulfilment module, NO authorisation module and NO other engine — R33 folded the whole stack (policy,
 *     recovery, verification, fulfilment, authorisation, execution, action, outcome) into the resolution decision — so
 *     there is provably NO duplicate logic. It GOVERNS a disposition; it persists nothing and governs nothing itself.
 *   • THE RESOLUTION ENGINE STAYS AUTHORITATIVE — the core CONSUMES the decided resolution (imports `isResolutionDecided`,
 *     defers on it FIRST) and NEVER re-derives it (it never names `resolveConversationResolution`), so no duplicate
 *     resolution logic exists, and the Resolution Engine (and transitively Recovery, Verification, Fulfilment,
 *     Authorisation, Execution, Action and Outcome) stays authoritative. The RUNTIME goes further: it reads R33's
 *     RECORDED disposition and re-derives NOTHING — it names NO resolver of ANY lower engine (not
 *     `resolveConversationResolution`, not `resolveRecovery`, not `resolveVerification`, not `resolveFulfilment`, not
 *     `deriveAuthorisationState`).
 *   • POLICY & HUMAN REVIEW STAY MANDATORY — TRANSITIVELY, NOT RE-RUN — neither the core nor the runtime imports a
 *     policy surface or NAMES a policy decision function: a decided resolution exists ONLY for an approved, policy-cleared,
 *     verified, recovered, resolved operation (R33's inherited gate), so a policy-blocked or un-approved booking is
 *     structurally UN-GOVERNABLE without this engine touching policy or re-deciding approval.
 *   • THE APPROVAL GATE IS INHERITED, AND RE-PINNED AT STORAGE — the core emits a lifecycle ONLY for a decided
 *     resolution (which only exists for an `approved` grant), so the approval gate is inherited via the FIRST defer; the
 *     ledger CHECK-pins `approval_state` to the single value 'approved' and `status` to 'governed'; and the write
 *     primitive REJECTS any other approval with "Human Review may not be bypassed". There is no path to governing the
 *     lifecycle of un-approved work.
 *   • THE LIFECYCLE STATE IS A COHERENT DETERMINATION — THE R34 KEYSTONE — two CHECKs (and the write primitive) pin
 *     `closed = (lifecycle_state = 'closed')` and `ongoing = (lifecycle_state <> 'closed')`: a stored lifecycle can NEVER
 *     claim the conversation is closed over a `retained`/`escalated` state, nor claim it remains ongoing over a `closed`
 *     one. Closed iff closed; ongoing iff not closed.
 *   • THE STATE IS A DETERMINISTIC TWO-STAGE FOLD — a novel R34 shape. STAGE 1 (the transition fold): a CHECK (and the
 *     core switch, and the write primitive) pin the SOURCE resolution state to the transition: `terminal` ⇒ `close`,
 *     `recoverable` ⇒ `retain`, `unresolved` ⇒ `escalate`. STAGE 2 (the state fold): a CHECK (and the core switch, and
 *     the write primitive) pin the transition to the resting state: `close` ⇒ `closed`, `retain` ⇒ `retained`,
 *     `escalate` ⇒ `escalated`. And FULFILMENT-PRESENCE COHERENCE is inherited transitively from R33/R32/R31:
 *     (fulfilment_id is null) = (resolution_state = 'recoverable').
 *   • IT INTEGRATES WITH HUMAN REVIEW — IT NEVER DUPLICATES THE GRANT — the terminal grant arises ONLY through R14's
 *     Human Review architecture and R29's fold; the RUNTIME reads the RECORDED `approved` state, so it re-folds NOTHING
 *     (it names no `deriveAuthorisationState`) and records NOTHING (it names no `record_receptionist_review_resolution`).
 *     It threads the full Human Review provenance so the ledgers JOIN.
 *   • IT GOVERNS THE LIFECYCLE — IT EXECUTES NONE — neither the core nor the runtime reaches a transport, provider,
 *     generator, calendar, scheduler or quote path, AND — the load-bearing R34 proof — the runtime NAMES NEITHER R33's
 *     resolution writer (`record_receptionist_conversation_resolution`) NOR R33's resolution reader
 *     (`find_receptionist_resolution_context`) NOR R32's recovery writer NOR R31's verification writer NOR R30's
 *     fulfilment writer: it re-resolves nothing, re-recovers nothing, re-verifies nothing, re-books nothing, retries
 *     nothing, schedules nothing and corrects no record. The lifecycle ledger row IS the lifecycle state and its audit.
 *   • IT IS IDEMPOTENT — NOT RETRY — the ledger's `resolution_id` is UNIQUE and the writer inserts ON CONFLICT DO NOTHING
 *     (returning the existing id), so a repeat governs nothing; the runtime orchestrates no re-attempt (retry is an
 *     explicit R34 non-goal — it names no setTimeout / setInterval / backoff).
 *   • THE PERSIST IS BEST-EFFORT — the runtime SWALLOWS a failed write (returns null), it never THROWS, and it reaches
 *     no model and no reply pipeline — the confirmation, the grant, the fulfilment, the verification, the recovery and
 *     the resolution flow through the UNCHANGED pipelines.
 *   • THE LEDGER IS APPEND-ONLY, SERVICE-ROLE-ONLY, APPROVED-ONLY, DETERMINISTIC & COHERENT — RLS-enabled with no
 *     policies, UPDATE/DELETE rejected by triggers, a SECURITY DEFINER writer granted only to service_role, its
 *     `status` CHECK-pinned to 'governed', its `approval_state` CHECK-pinned to 'approved', a CHECK that pins
 *     (lifecycle_type, lifecycle_outcome) to the EXACT fold, the two closed/ongoing coherences, the two-stage fold and
 *     the fulfilment-presence coherence above.
 *   • THE READER CENTRES ON THE RESOLUTION LEDGER — a service-role-only SECURITY DEFINER `sql` function that SELECTs
 *     (never writes) R33's RECORDED disposition from `receptionist_conversation_resolutions` alone — it re-reads NEITHER
 *     the R32 recovery ledger, NOR the R31 verification ledger, NOR the R30 fulfilment ledger directly. This centring IS
 *     the storage embodiment of "the Resolution Engine remains authoritative — the Lifecycle Engine consumes its
 *     RECORDED decision".
 *   • THE RUNTIME GOVERNS ON SEND ONLY — STRICTLY AFTER R30, R31, R32 AND R33 — it is invoked from `resolveReviewSend`
 *     (never `resolveReviewDismiss`), exactly once, strictly AFTER the durable `sent` resolution guard, AFTER the R30
 *     fulfilment call, AFTER the R31 verification call, AFTER the R32 recovery call AND AFTER the R33 resolution call, so
 *     Human Review can NEVER be bypassed and R34 always re-reads a committed R33 disposition.
 *   • IT DOES NOT BREAK R33, R32, R31 OR R30 — R34 adds a GOVERNOR, not a second resolver, recoverer, verifier or
 *     performer: R33's resolution write primitive and context reader are STILL each named by exactly one module (the R33
 *     runtime), R32's recovery write primitive and reader STILL by one, R31's verification write primitive STILL by one,
 *     R30's fulfilment write primitive STILL by one, `resolveConversationResolution` is STILL defined only in the R33
 *     core, `resolveRecovery` STILL only in the R32 core, and the SEND path STILL invokes `resolveConversationCompletion`,
 *     `recoverVerifiedFulfilment`, `verifyApprovedFulfilment` and `fulfilApprovedBooking` exactly once each. R34's
 *     modules name none of those primitives.
 *
 * The engine's runtime behaviour is pinned against real Postgres in
 * __tests__/integration/receptionist/conversation-lifecycle-pipeline.test.ts, and the pure core's governance
 * exhaustively in __tests__/receptionist/conversation-lifecycle.test.ts. This tier is HERMETIC — a filesystem scan over
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

const CORE = "lib/receptionist/conversation-lifecycle.ts";
const RUNTIME = "server/services/receptionist-lifecycle.ts";
const REVIEW_SEAM = "server/services/receptionist-review.ts";
const RESOLUTION_CORE = "lib/receptionist/conversation-resolution.ts";
const MIGRATION = "supabase/migrations/20260903000000_receptionist_conversation_lifecycles.sql";

/** The lifecycle ledger's write primitive — the function an auditor would call to file a lifecycle state. */
const WRITE_FN = /\brecord_receptionist_conversation_lifecycle\b/;

/** The lifecycle-context reader — the READ the runtime governs R33's RECORDED disposition through. */
const READER_FN = /\bfind_receptionist_lifecycle_context\b/;

/** R33's resolution WRITE primitive — R34 must NAME it NOWHERE (it CONSUMES the recorded disposition, it never re-files it). */
const RESOLUTION_WRITE_FN = /\brecord_receptionist_conversation_resolution\b/;

/** R33's resolution-context reader — R34 uses its OWN lifecycle-context reader, so R34 must NAME this NOWHERE. */
const RESOLUTION_READER_FN = /\bfind_receptionist_resolution_context\b/;

/** R32's recovery WRITE primitive — R34 must NAME it NOWHERE (it GOVERNS the lifecycle, it never re-files a recovery). */
const RECOVERY_WRITE_FN = /\brecord_receptionist_conversation_recovery\b/;

/** R32's recovery-context reader — R34 must NAME it NOWHERE. */
const RECOVERY_READER_FN = /\bfind_receptionist_recovery_context\b/;

/** R31's verification WRITE primitive — R34 must NAME it NOWHERE (it GOVERNS the lifecycle, it never verifies). */
const VERIFY_WRITE_FN = /\brecord_receptionist_conversation_verification\b/;

/** R30's fulfilment WRITE primitive — R34 must NAME it NOWHERE (it GOVERNS the lifecycle, it never PERFORMS a fulfilment). */
const FULFIL_WRITE_FN = /\brecord_receptionist_conversation_fulfilment\b/;

/** The R14 human-grant writer — R34 must NAME it NOWHERE (it READS the recorded grant, it never re-records it). */
const REVIEW_RESOLUTION_WRITE_FN = /\brecord_receptionist_review_resolution\b/;

/** The policy DECISION functions — neither core nor runtime may NAME one (policy is consumed transitively). */
const POLICY_DECISION_FNS = /\b(?:evaluateReply|isAutoSendable|redactReply|clearForHumanSend)\b/;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

// =====================================================================
// 0. The engine, the ledger and the runtime all ship, and the review SEND path integrates them.
// =====================================================================

describe("receptionist lifecycle — the engine ships and is wired", () => {
  it(`ships the append-only lifecycle ledger migration ${MIGRATION}`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION)), MIGRATION).toBe(true);
  });

  it(`ships the pure core ${CORE}`, () => {
    expect(existsSync(resolve(ROOT, CORE)), CORE).toBe(true);
  });

  it(`ships the server runtime ${RUNTIME}`, () => {
    expect(existsSync(resolve(ROOT, RUNTIME)), RUNTIME).toBe(true);
  });

  it("the pure core exports the single lifecycle entry point and its decided predicate", () => {
    const code = codeOf(read(CORE));
    expect(code).toMatch(/export function resolveConversationLifecycle\(/);
    expect(code).toMatch(/export function isLifecycleDecided\(/);
  });

  it("the server runtime exports the single lifecycle entry point", () => {
    const code = codeOf(read(RUNTIME));
    expect(code).toMatch(/export async function governConversationLifecycle\(/);
  });

  it("the Human Review SEND path imports the lifecycle runtime (the sole caller)", () => {
    const specs = importSpecifiers(codeOf(read(REVIEW_SEAM)));
    expect(specs).toContain("@/server/services/receptionist-lifecycle");
  });
});

// =====================================================================
// 1. SINGLE WRITE PATH & SINGLE READ PATH — exactly one module names each ledger primitive.
// =====================================================================

describe("receptionist lifecycle — exactly one module writes the ledger and one reads the context", () => {
  const writers = walkSources(SOURCE_ROOTS)
    .filter((full) => WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();
  const readers = walkSources(SOURCE_ROOTS)
    .filter((full) => READER_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the ONLY module that names the ledger write primitive is the lifecycle server runtime", () => {
    // If this list ever grows, a second lifecycle-write path (or a bypass) has appeared.
    expect(writers).toEqual([RUNTIME]);
  });

  it("the ONLY module that names the lifecycle-context reader is the lifecycle server runtime", () => {
    expect(readers).toEqual([RUNTIME]);
  });

  it("no app/ route, action, or component files a lifecycle directly", () => {
    expect(writers.filter((p) => p.startsWith("app/"))).toEqual([]);
    expect(readers.filter((p) => p.startsWith("app/"))).toEqual([]);
  });

  it("no other server/ module files a lifecycle directly", () => {
    expect(writers.filter((p) => p !== RUNTIME && p.startsWith("server/"))).toEqual([]);
    expect(readers.filter((p) => p !== RUNTIME && p.startsWith("server/"))).toEqual([]);
  });

  it("the lifecycle entry point resolveConversationLifecycle is DEFINED in exactly one module — the pure core", () => {
    // No feature implements independent lifecycle logic: the single source of truth is exported once and consumed.
    const definers = walkSources(SOURCE_ROOTS)
      .filter((full) => /export function resolveConversationLifecycle\(/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(definers).toEqual([CORE]);
  });
});

// =====================================================================
// 2. The pure core is PURE, MODEL-FREE and POLICY-FREE — it CONSUMES the resolution surface, and nothing else.
// =====================================================================

describe("receptionist lifecycle — the pure core is pure, model-free and policy-free", () => {
  const pcode = codeOf(read(CORE));

  it("is a shared pure module (NOT server-only — the runtime and tests import it)", () => {
    expect(importSpecifiers(pcode)).not.toContain("server-only");
  });

  it("its ONLY import is the R33 resolution surface it consumes — NO policy, NO recovery, NO other module", () => {
    // The resolution import is the predicate it CONSUMES (isResolutionDecided) plus its types. There is NOTHING else —
    // most importantly NO policy module, NO recovery module, NO verification module, NO fulfilment module and NO
    // authorisation module (R33 already folded the whole stack into the resolution decision). This is the headline R34
    // proof that no duplicate policy, recovery, verification, fulfilment, authorisation or resolution logic is introduced.
    expect(pcode).toMatch(/isResolutionDecided/);
    expect(importSpecifiers(pcode)).toEqual(["@/lib/receptionist/conversation-resolution"]);
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/policy");
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/conversation-recovery");
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/conversation-verification");
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/conversation-fulfilment");
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/conversation-authorisation");
  });

  it("DUPLICATES NOTHING beneath it — it re-derives no resolution, recovery, verification, fulfilment, authorisation, action or outcome", () => {
    // It consumes ALREADY-computed inputs; it names none of the resolvers/extractors/detectors — most importantly it
    // NEVER re-derives the resolution (it CONSUMES the R33 decision via isResolutionDecided) and it re-folds no grant.
    // This is the R34 analogue of R33's "never names resolveRecovery".
    expect(pcode).not.toMatch(/\bresolveConversationResolution\b/);
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

  it("touches no I/O and calls no model — it governs, it does not generate, persist or resolve", () => {
    expect(pcode).not.toMatch(/createAdminClient/);
    expect(pcode).not.toMatch(/supabase/i);
    expect(pcode).not.toMatch(/\bfetch\(/);
    expect(pcode).not.toMatch(/@\/lib\/ai\//);
    expect(pcode).not.toMatch(/Anthropic/);
    // It performs NO org lookup and NO env read.
    expect(pcode).not.toMatch(/process\.env/);
  });

  it("has no clock and no RNG (a lifecycle is reconstructable)", () => {
    expect(pcode).not.toMatch(/Math\.random/);
    expect(pcode).not.toMatch(/Date\.now/);
    expect(pcode).not.toMatch(/new Date\(/);
  });

  it("names NO ledger primitive — the pure core reaches neither its own writer/reader nor R30/R31/R32/R33's", () => {
    expect(pcode).not.toMatch(WRITE_FN);
    expect(pcode).not.toMatch(READER_FN);
    expect(pcode).not.toMatch(RESOLUTION_WRITE_FN);
    expect(pcode).not.toMatch(RESOLUTION_READER_FN);
    expect(pcode).not.toMatch(RECOVERY_WRITE_FN);
    expect(pcode).not.toMatch(RECOVERY_READER_FN);
    expect(pcode).not.toMatch(VERIFY_WRITE_FN);
    expect(pcode).not.toMatch(FULFIL_WRITE_FN);
  });
});

// =====================================================================
// 3. The Resolution Engine remains AUTHORITATIVE — the lifecycle CONSUMES it and DEFERS to it.
// =====================================================================

describe("receptionist lifecycle — the Resolution Engine stays authoritative", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("CONSUMES the decided resolution — resolveConversationLifecycle defers on it FIRST", () => {
    // The first gate stands down when the Resolution Engine rendered no decision (transitively preserving the Recovery,
    // Verification, Fulfilment, Authorisation, Execution, Action and Outcome Engines' authority too — a decided
    // resolution only exists for an approved, verified, recovered, resolved operation).
    expect(pcode).toMatch(
      /if \(!isResolutionDecided\(resolution\)\) return abstain\("no_resolution_decision"\)/,
    );
  });

  it("NEVER re-derives the resolution — the core names isResolutionDecided but not resolveConversationResolution", () => {
    expect(pcode).toMatch(/isResolutionDecided/);
    expect(pcode).not.toMatch(/\bresolveConversationResolution\b/);
  });

  it("the RUNTIME re-derives NOTHING — it consumes R33's RECORDED disposition and names no lower resolver", () => {
    // Design B: the runtime reads R33's RECORDED resolution row and reconstructs the decision verbatim from the recorded
    // columns. It never re-resolves, never re-recovers, never re-verifies, never re-derives the fulfilment, never
    // re-folds the grant — so it names NO resolver of ANY lower engine. This is the same strong authority proof as R33's
    // runtime (which consumed the recorded disposition wholesale): R34 consumes the recorded resolution wholesale.
    expect(rcode).not.toMatch(/\bresolveConversationResolution\b/);
    expect(rcode).not.toMatch(/\bresolveRecovery\b/);
    expect(rcode).not.toMatch(/\bresolveVerification\b/);
    expect(rcode).not.toMatch(/\bresolveFulfilment\b/);
    expect(rcode).not.toMatch(/\bderiveAuthorisationState\b/);
    expect(rcode).not.toMatch(/\bresolveAuthorisation\b/);
    expect(rcode).not.toMatch(/\bresolveExecution\b/);
    expect(rcode).not.toMatch(/\bresolveAction\b/);
  });

  it("the resolution→lifecycle map maps resolve_booking_recovery → govern_resolution_lifecycle (it consumes the R33 vocabulary)", () => {
    expect(pcode).toMatch(/resolve_booking_recovery:\s*"govern_resolution_lifecycle"/);
  });

  it("the booking it governs is BY REFERENCE the resolution's payload — it can never drift from the decision", () => {
    expect(pcode).toMatch(/booking:\s*resolution\.booking/);
  });
});

// =====================================================================
// 4. Policy stays MANDATORY — transitively, through the resolution; neither core nor runtime imports or re-runs it.
// =====================================================================

describe("receptionist lifecycle — policy is consumed transitively, never imported or re-run", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("neither the core nor the runtime imports the policy module (the resolution already folded the verdict)", () => {
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/policy");
    expect(importSpecifiers(rcode)).not.toContain("@/lib/receptionist/policy");
  });

  it("neither the core nor the runtime NAMES a policy decision function or the guardrail verdict type", () => {
    // A policy `block` foreclosed the authorisation at R29, foreclosed can never derive to `approved`, an un-approved
    // authorisation is never fulfilled at R30, verified at R31, recovered at R32 nor resolved at R33 — so a
    // policy-blocked booking is structurally UN-GOVERNABLE WITHOUT this engine touching policy.
    expect(pcode).not.toMatch(POLICY_DECISION_FNS);
    expect(rcode).not.toMatch(POLICY_DECISION_FNS);
    expect(pcode).not.toMatch(/GuardrailVerdict/);
    expect(rcode).not.toMatch(/GuardrailVerdict/);
  });
});

// =====================================================================
// 5. THE APPROVAL GATE — inherited from R33 via the FIRST defer, and re-pinned at the storage layer.
// =====================================================================

describe("receptionist lifecycle — the approval gate is inherited, and re-pinned in the ledger", () => {
  const pcode = codeOf(read(CORE));
  const sql = sqlCodeOf(read(MIGRATION));

  it("the pure core emits a lifecycle ONLY for a DECIDED resolution — the approval gate is inherited", () => {
    // R34's core has no approval literal of its own: a decided resolution exists ONLY for an `approved` grant (R33's
    // inherited gate, R32's, R31's, R30's keystone), so deferring to isResolutionDecided FIRST inherits the approval
    // gate transitively.
    expect(pcode).toMatch(
      /if \(!isResolutionDecided\(resolution\)\) return abstain\("no_resolution_decision"\)/,
    );
  });

  it("names NO autonomous-approve construct anywhere in the core — the grant is the human's", () => {
    expect(pcode).not.toMatch(/auto[_-]?approve/i);
    expect(pcode).not.toMatch(/approve_now/i);
    expect(pcode).not.toMatch(/autonomous[_-]?approv/i);
  });

  it("APPROVED BY CONSTRUCTION — the ledger CHECK-pins approval_state to the single value 'approved'", () => {
    // Inherited from R33 → R32 → R31 → R30: a lifecycle can ONLY exist for an approved operation.
    expect(sql).toMatch(/check\s*\(\s*approval_state\s*=\s*'approved'\s*\)/i);
  });

  it("GOVERNED BY CONSTRUCTION — the ledger CHECK-pins status to the single value 'governed'", () => {
    expect(sql).toMatch(/status\s+text\s+not null\s+default\s+'governed'/i);
    expect(sql).toMatch(/check\s*\(\s*status\s*=\s*'governed'\s*\)/i);
  });

  it("the write primitive REJECTS any non-approved authorisation — 'Human Review may not be bypassed'", () => {
    expect(sql).toMatch(/p_approval_state\s*<>\s*'approved'/i);
    expect(sql).toMatch(/Human Review may not be bypassed/i);
  });
});

// =====================================================================
// 6. THE R34 KEYSTONE — closed = (state = 'closed') and ongoing = (state <> 'closed'); plus the novel two-stage fold
//    (resolution state ⇒ transition ⇒ state) and the inherited fulfilment-presence coherence. The whole row is
//    deterministic and coherent by construction.
// =====================================================================

describe("receptionist lifecycle — the lifecycle state is coherent with its flags (the R34 keystone)", () => {
  const pcode = codeOf(read(CORE));
  const sql = sqlCodeOf(read(MIGRATION));

  it("the lifecycle state vocabulary is EXACTLY {closed, retained, escalated} — a closed set of resting states", () => {
    expect(pcode).toMatch(
      /LifecycleState\s*=\s*"closed"\s*\|\s*"retained"\s*\|\s*"escalated"/,
    );
  });

  it("the lifecycle transition vocabulary is EXACTLY {close, retain, escalate} — a closed set of movements", () => {
    expect(pcode).toMatch(
      /LifecycleTransition\s*=\s*"close"\s*\|\s*"retain"\s*\|\s*"escalate"/,
    );
  });

  it("a record is produced for ALL THREE states — retained and escalated are NOT abstentions", () => {
    // The abstention vocabulary is ONLY the two deferrals; the states are findings on a produced record.
    expect(pcode).toMatch(
      /LifecycleAbstention\s*=\s*"no_resolution_decision"\s*\|\s*"unsupported_resolution"/,
    );
    // Isolate the abstention type DECLARATION (from its `=` to the terminating `;`) and prove neither non-closed
    // lifecycle state leaks into it — `retained` / `escalated` are findings on a produced decision, never a "nothing
    // here".
    const declStart = pcode.indexOf("LifecycleAbstention =");
    const abstentionDecl = pcode.slice(declStart, pcode.indexOf(";", declStart));
    expect(declStart).toBeGreaterThan(-1);
    expect(abstentionDecl).not.toMatch(/retained/);
    expect(abstentionDecl).not.toMatch(/escalated/);
  });

  it("THE KEYSTONE, IN THE CORE — closed is TRUE iff the state is `closed`, ongoing iff it is NOT", () => {
    expect(pcode).toMatch(/closed:\s*state === "closed"/);
    expect(pcode).toMatch(/ongoing:\s*state !== "closed"/);
  });

  it("COHERENT BY CONSTRUCTION — table CHECKs pin closed = (state = 'closed') and ongoing = (state <> 'closed')", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_lifecycles_closed_coherence check/i,
    );
    expect(sql).toMatch(/closed = \(lifecycle_state = 'closed'\)/i);
    expect(sql).toMatch(
      /constraint receptionist_conversation_lifecycles_ongoing_coherence check/i,
    );
    expect(sql).toMatch(/ongoing = \(lifecycle_state <> 'closed'\)/i);
  });

  it("the write primitive re-validates both coherences (belt-and-braces with the table CHECKs)", () => {
    // A `retained`/`escalated` state carrying closed=true — or a `closed` state carrying ongoing=true — is rejected by
    // the primitive, not only by the column CHECKs.
    expect(sql).toMatch(/p_closed <> \(p_lifecycle_state = 'closed'\)/i);
    expect(sql).toMatch(/closed=% is incoherent with state/i);
    expect(sql).toMatch(/p_ongoing <> \(p_lifecycle_state <> 'closed'\)/i);
    expect(sql).toMatch(/ongoing=% is incoherent with state/i);
  });
});

describe("receptionist lifecycle — the state is the deterministic TWO-STAGE fold of the resolution, coherent with the record", () => {
  const pcode = codeOf(read(CORE));
  const sql = sqlCodeOf(read(MIGRATION));

  it("STAGE 1, IN THE CORE — a closed switch folds terminal⇒close, recoverable⇒retain, unresolved⇒escalate", () => {
    expect(pcode).toMatch(/case "terminal":\s*return "close"/);
    expect(pcode).toMatch(/case "recoverable":\s*return "retain"/);
    expect(pcode).toMatch(/case "unresolved":\s*return "escalate"/);
  });

  it("STAGE 2, IN THE CORE — a closed switch folds close⇒closed, retain⇒retained, escalate⇒escalated", () => {
    expect(pcode).toMatch(/case "close":\s*return "closed"/);
    expect(pcode).toMatch(/case "retain":\s*return "retained"/);
    expect(pcode).toMatch(/case "escalate":\s*return "escalated"/);
  });

  it("STAGE 1, ENFORCED — a table CHECK pins the transition fold of the source resolution state", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_lifecycles_transition_fold check/i,
    );
    expect(sql).toMatch(/\(resolution_state = 'terminal' and lifecycle_transition = 'close'\)/i);
    expect(sql).toMatch(
      /\(resolution_state = 'recoverable' and lifecycle_transition = 'retain'\)/i,
    );
    expect(sql).toMatch(
      /\(resolution_state = 'unresolved' and lifecycle_transition = 'escalate'\)/i,
    );
  });

  it("STAGE 2, ENFORCED — a table CHECK pins the state fold of the transition", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_lifecycles_state_fold check/i,
    );
    expect(sql).toMatch(/\(lifecycle_transition = 'close' and lifecycle_state = 'closed'\)/i);
    expect(sql).toMatch(/\(lifecycle_transition = 'retain' and lifecycle_state = 'retained'\)/i);
    expect(sql).toMatch(/\(lifecycle_transition = 'escalate' and lifecycle_state = 'escalated'\)/i);
  });

  it("the write primitive re-validates BOTH fold stages (belt-and-braces with the table CHECKs)", () => {
    expect(sql).toMatch(/is not the deterministic fold of resolution state/i);
    expect(sql).toMatch(/is not the deterministic fold of transition/i);
  });

  it("FULFILMENT-PRESENCE COHERENCE, INHERITED TRANSITIVELY FROM R33/R32/R31 — a table CHECK pins (fulfilment_id is null) = (resolution_state = 'recoverable')", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_lifecycles_fulfilment_coherence check/i,
    );
    expect(sql).toMatch(
      /\(\s*fulfilment_id is null\s*\)\s*=\s*\(\s*resolution_state = 'recoverable'\s*\)/i,
    );
  });

  it("the write primitive re-validates the fulfilment-presence coherence (belt-and-braces with the table CHECK)", () => {
    expect(sql).toMatch(/\(p_fulfilment_id is null\)\s*<>\s*\(p_resolution_state = 'recoverable'\)/i);
    expect(sql).toMatch(/incoherent with fulfilment_id/i);
  });

  it("bounds the transition, the state and the source resolution state to their vocabularies in the ledger CHECK and the primitive", () => {
    expect(sql).toMatch(
      /check\s*\(\s*lifecycle_transition\s+in\s*\(\s*'close',\s*'retain',\s*'escalate'\s*\)\s*\)/i,
    );
    expect(sql).toMatch(
      /check\s*\(\s*lifecycle_state\s+in\s*\(\s*'closed',\s*'retained',\s*'escalated'\s*\)\s*\)/i,
    );
    expect(sql).toMatch(
      /check\s*\(\s*resolution_state\s+in\s*\(\s*'terminal',\s*'recoverable',\s*'unresolved'\s*\)\s*\)/i,
    );
    expect(sql).toMatch(/p_lifecycle_transition not in \('close', 'retain', 'escalate'\)/i);
    expect(sql).toMatch(/p_lifecycle_state not in \('closed', 'retained', 'escalated'\)/i);
    expect(sql).toMatch(/p_resolution_state not in \('terminal', 'recoverable', 'unresolved'\)/i);
  });
});

// =====================================================================
// 7. INTEGRATE with Human Review — NEVER DUPLICATE the grant. R34 reads the RECORDED grant; it re-folds nothing.
// =====================================================================

describe("receptionist lifecycle — integrates with Human Review, never duplicates the grant", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("the grant is neither re-folded nor re-recorded — the runtime reads the RECORDED approval_state", () => {
    // R34 consumes R33's RECORDED resolution row — which already carries the folded `approved` state — so neither the
    // core nor the runtime re-folds the grant. No duplicate approval logic.
    expect(pcode).not.toMatch(/\bderiveAuthorisationState\b/);
    expect(rcode).not.toMatch(/\bderiveAuthorisationState\b/);
  });

  it("NEITHER the core nor the runtime records a human grant — it names no review-resolution writer", () => {
    // The grant is the human's, recorded by the UNCHANGED R14 Human Review architecture. R34 reads it; it never
    // re-records it, so there is no duplicate human-decision recorder.
    expect(pcode).not.toMatch(REVIEW_RESOLUTION_WRITE_FN);
    expect(rcode).not.toMatch(REVIEW_RESOLUTION_WRITE_FN);
  });

  it("the runtime threads the FULL provenance — the resolution, the recovery, the verification, the held reply, the sent reply and the human resolution", () => {
    expect(rcode).toMatch(/p_resolution_id:/);
    expect(rcode).toMatch(/p_recovery_id:/);
    expect(rcode).toMatch(/p_verification_id:/);
    expect(rcode).toMatch(/p_review_audit_id:/);
    expect(rcode).toMatch(/p_sent_audit_id:/);
    expect(rcode).toMatch(/p_review_resolution_id:/);
  });
});

// =====================================================================
// 8. It GOVERNS the lifecycle — it EXECUTES none; reaching NO external system; idempotent (not retry); best-effort.
// =====================================================================

describe("receptionist lifecycle — governs the lifecycle, executes none, idempotently, best-effort", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("the lifecycle vocabulary is EXACTLY {govern_resolution_lifecycle} — quote/scheduling lifecycles are absent", () => {
    expect(pcode).toMatch(/LIFECYCLE_TYPES\s*=\s*\[\s*"govern_resolution_lifecycle"\s*\]/);
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

  it("IT GOVERNS — IT NEVER EXECUTES — neither the core nor the runtime NAMES R33's resolution, R32's recovery, R31's verification or R30's fulfilment writer", () => {
    // THE load-bearing R34 proof. R34 re-resolves nothing (names no R33 resolution writer and no R33 resolution reader),
    // re-recovers nothing (names no R32 recovery writer/reader), re-verifies nothing (names no R31 verification writer)
    // and re-books nothing (names no R30 fulfilment writer): it reads R33's RECORDED disposition through its OWN reader
    // and files a lifecycle state — never a resolution row, never a recovery row, never a verification row, never a
    // fulfilment row.
    expect(pcode).not.toMatch(RESOLUTION_WRITE_FN);
    expect(rcode).not.toMatch(RESOLUTION_WRITE_FN);
    expect(pcode).not.toMatch(RESOLUTION_READER_FN);
    expect(rcode).not.toMatch(RESOLUTION_READER_FN);
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
    // Like the R27–R33 runtimes, a lifecycle touches NO tenant table: no `.from(...)` at all, no lead write, no
    // customers. Scheduling, promotion, re-booking and external writes are non-goals.
    expect(rcode).not.toMatch(/\.from\(/);
    expect(rcode).not.toMatch(/customers/);
    expect(rcode).not.toMatch(/\bleads\b/);
    expect(rcode).not.toMatch(/contact_phone/);
  });

  it("the runtime writes ONLY the one internal row — the lifecycle ledger, through the write primitive", () => {
    expect(rcode).toMatch(WRITE_FN);
  });

  it("IDEMPOTENT, NOT RETRY — it names no re-attempt orchestration (retry is an explicit R34 non-goal)", () => {
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

  it("is server-only — it is the ONE place a resolved conversation's lifecycle is durably governed", () => {
    expect(importSpecifiers(rcode)).toContain("server-only");
  });
});

// =====================================================================
// 9. The migration installs an APPEND-ONLY, service-role-only, APPROVED-ONLY, DETERMINISTIC, IDEMPOTENT ledger.
// =====================================================================

describe("receptionist lifecycle — the ledger is append-only, service-role-only, approved-only and idempotent", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("creates the receptionist_conversation_lifecycles table", () => {
    expect(sql).toMatch(
      /create table if not exists public\.receptionist_conversation_lifecycles/i,
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
      "resolution_id",
      "recovery_id",
      "authorisation_id",
      "verification_id",
      "fulfilment_id",
      "review_audit_id",
      "sent_audit_id",
      "review_resolution_id",
      "lifecycle_type",
      "lifecycle_outcome",
      "lifecycle_transition",
      "lifecycle_state",
      "closed",
      "ongoing",
      "resolution_state",
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

  it("bounds the lifecycle type and outcome to their vocabularies {govern_resolution_lifecycle} / {conversation_lifecycle_governed}", () => {
    expect(sql).toMatch(
      /check\s*\(\s*lifecycle_type\s+in\s*\(\s*'govern_resolution_lifecycle'\s*\)\s*\)/i,
    );
    expect(sql).toMatch(
      /check\s*\(\s*lifecycle_outcome\s+in\s*\(\s*'conversation_lifecycle_governed'\s*\)\s*\)/i,
    );
  });

  it("DETERMINISTIC BY CONSTRUCTION — a CHECK pins (lifecycle_type, lifecycle_outcome) to the exact fold", () => {
    // govern_resolution_lifecycle ⇒ conversation_lifecycle_governed. No writer — not even service_role — can file a row
    // whose outcome contradicts its type.
    expect(sql).toMatch(/constraint receptionist_conversation_lifecycles_outcome_fold check/i);
    expect(sql).toMatch(
      /lifecycle_type = 'govern_resolution_lifecycle' and lifecycle_outcome = 'conversation_lifecycle_governed'/i,
    );
  });

  it("IDEMPOTENT BY CONSTRUCTION — resolution_id is UNIQUE and the writer inserts ON CONFLICT DO NOTHING", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_lifecycles_resolution_unique unique \(resolution_id\)/i,
    );
    expect(sql).toMatch(/on conflict \(resolution_id\) do nothing/i);
    // On a repeat, the primitive resolves the existing row's id so the operation is a true no-op.
    expect(sql).toMatch(/select id into v_id[\s\S]*?where resolution_id = p_resolution_id/i);
  });

  it("the resolution anchor is NOT NULL in DDL — a lifecycle is ALWAYS governed from a recorded resolution", () => {
    // R34's load-bearing anchor: the storage proof that "the Resolution Engine remains authoritative".
    expect(sql).toMatch(/resolution_id\s+uuid\s+not null/i);
    // The recovery + authorisation + verification anchors are equally mandatory.
    expect(sql).toMatch(/recovery_id\s+uuid\s+not null/i);
    expect(sql).toMatch(/authorisation_id uuid\s+not null/i);
    expect(sql).toMatch(/verification_id uuid\s+not null/i);
  });

  it("bounds the expected booking number to the E.164 shape and the postcode to its shape in DDL", () => {
    expect(sql).toMatch(/phone_number\s+text\s+check\s*\([\s\S]*?\+\\d\{10,15\}/i);
    expect(sql).toMatch(/postcode\s+text\s+check\s*\([\s\S]*?A-Z/i);
  });

  it("enables RLS with NO policies — service-role / SECURITY DEFINER only", () => {
    expect(sql).toMatch(
      /alter table public\.receptionist_conversation_lifecycles enable row level security/i,
    );
    expect(sql).not.toMatch(
      /create policy[\s\S]*?on public\.receptionist_conversation_lifecycles/i,
    );
  });

  it("is APPEND-ONLY — UPDATE and DELETE are rejected by triggers", () => {
    expect(sql).toMatch(
      /create or replace function public\.receptionist_conversation_lifecycles_block_mutation\(/i,
    );
    expect(sql).toMatch(/raise exception[\s\S]*?append-only[\s\S]*?tg_op/i);
    expect(sql).toMatch(/errcode\s*=\s*'restrict_violation'/i);
    expect(sql).toMatch(
      /create trigger receptionist_conversation_lifecycles_no_update\s+before update on public\.receptionist_conversation_lifecycles/i,
    );
    expect(sql).toMatch(
      /create trigger receptionist_conversation_lifecycles_no_delete\s+before delete on public\.receptionist_conversation_lifecycles/i,
    );
  });

  it("writes only through a SECURITY DEFINER primitive granted only to service_role", () => {
    expect(sql).toMatch(
      /create or replace function public\.record_receptionist_conversation_lifecycle\(/i,
    );
    expect(sql).toMatch(/returns uuid/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = ''/i);
    expect(sql).toMatch(/insert into public\.receptionist_conversation_lifecycles/i);
    expect(sql).toMatch(/revoke all on function[\s\S]*?from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*?to service_role/i);
  });

  it("the write primitive re-validates the (type, outcome) fold (belt-and-braces with the table CHECK)", () => {
    expect(sql).toMatch(/does not match the deterministic fold/i);
  });

  it("REQUIRES the resolution anchor and the full Human Review provenance and a well-formed booking payload", () => {
    // The resolution + recovery + authorisation + verification anchors plus the three provenance ids are mandatory...
    expect(sql).toMatch(
      /p_resolution_id is null[\s\S]*?p_recovery_id is null[\s\S]*?p_authorisation_id is null[\s\S]*?p_verification_id is null[\s\S]*?p_review_audit_id is null[\s\S]*?p_sent_audit_id is null[\s\S]*?p_review_resolution_id is null/i,
    );
    // ...and a govern_resolution_lifecycle must carry an expected job type plus a well-formed postcode and E.164 number.
    expect(sql).toMatch(/p_lifecycle_type\s*=\s*'govern_resolution_lifecycle'[\s\S]*?\+\\d\{10,15\}/i);
    expect(sql).toMatch(/p_lifecycle_type\s*=\s*'govern_resolution_lifecycle'[\s\S]*?p_job_type is null/i);
  });
});

// =====================================================================
// 10. The LIFECYCLE-CONTEXT READER centres on the R33 resolution ledger; the runtime governs on SEND, AFTER R33.
// =====================================================================

describe("receptionist lifecycle — the reader centres on the resolution ledger, and lifecycle fires on SEND after R33", () => {
  const sql = sqlCodeOf(read(MIGRATION));
  const seam = codeOf(read(REVIEW_SEAM));

  it("the reader is a service-role-only SECURITY DEFINER sql function granted only to service_role", () => {
    expect(sql).toMatch(
      /create or replace function public\.find_receptionist_lifecycle_context\(/i,
    );
    expect(sql).toMatch(
      /revoke all on function public\.find_receptionist_lifecycle_context\(uuid, uuid\)\s*from public, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.find_receptionist_lifecycle_context\(uuid, uuid\)\s*to service_role/i,
    );
  });

  it("the reader CENTRES on the R33 resolution ledger — it reads the RECORDED disposition, and it never writes", () => {
    // Slice the reader function body (from its definition to its revoke) and prove it is a pure SELECT over R33's
    // resolution ledger. THE storage embodiment of "the Resolution Engine remains authoritative": the reader supplies
    // R33's RECORDED disposition, and the runtime reconstructs the decision from it — it never decides.
    const start = sql.indexOf("function public.find_receptionist_lifecycle_context");
    const body = sql.slice(start, sql.indexOf("revoke all on function", start));
    expect(body).toMatch(/language sql/i);
    expect(body).toMatch(/security definer/i);
    expect(body).toMatch(/from public\.receptionist_conversation_resolutions/i);
    expect(body).toMatch(/r\.status = 'determined'/i);
    expect(body).not.toMatch(/\binsert\b/i);
    expect(body).not.toMatch(/\bupdate\b/i);
    expect(body).not.toMatch(/\bdelete\b/i);
  });

  it("Design B — the reader re-reads NEITHER the R32 recovery, R31 verification NOR R30 fulfilment ledger directly", () => {
    // R34 consumes R33's RECORDED disposition wholesale; it does NOT re-derive from the lower ledgers (that would be
    // duplicate logic). The reader's ONLY source is the resolution ledger.
    const start = sql.indexOf("function public.find_receptionist_lifecycle_context");
    const body = sql.slice(start, sql.indexOf("revoke all on function", start));
    expect(body).not.toMatch(/from public\.receptionist_conversation_recoveries/i);
    expect(body).not.toMatch(/from public\.receptionist_conversation_verifications/i);
    expect(body).not.toMatch(/from public\.receptionist_conversation_fulfilments/i);
    expect(body).not.toMatch(/\bjoin\b/i);
  });

  it("the SEND path invokes the Lifecycle Engine EXACTLY ONCE", () => {
    const calls = seam.match(/governConversationLifecycle\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("lifecycle is invoked from resolveReviewSend — NEVER from resolveReviewDismiss", () => {
    // Prove placement structurally: the call lives between the two function definitions (inside SEND), and the DISMISS
    // body — everything from its definition onward — names the engine NOWHERE.
    const sendIdx = seam.indexOf("resolveReviewSend");
    const dismissIdx = seam.indexOf("resolveReviewDismiss");
    expect(sendIdx).toBeGreaterThan(-1);
    expect(dismissIdx).toBeGreaterThan(sendIdx);
    const sendBody = seam.slice(sendIdx, dismissIdx);
    const dismissBody = seam.slice(dismissIdx);
    expect(sendBody).toMatch(/governConversationLifecycle\(/);
    expect(dismissBody).not.toMatch(/governConversationLifecycle\(/);
  });

  it("lifecycle fires STRICTLY AFTER the `sent` guard, AFTER R30, AFTER R31, AFTER R32 AND AFTER R33", () => {
    // Human Review can never be bypassed AND R34 always re-reads a committed R33 disposition: the call is downstream of
    // the `already_resolved` guard, downstream of fulfilApprovedBooking, downstream of verifyApprovedFulfilment,
    // downstream of recoverVerifiedFulfilment, downstream of resolveConversationCompletion, and only when the send
    // produced an audit.
    const sendIdx = seam.indexOf("resolveReviewSend");
    const dismissIdx = seam.indexOf("resolveReviewDismiss");
    const sendBody = seam.slice(sendIdx, dismissIdx);
    const guardIdx = sendBody.indexOf('"already_resolved", outcome');
    const fulfilIdx = sendBody.indexOf("fulfilApprovedBooking(");
    const verifyIdx = sendBody.indexOf("verifyApprovedFulfilment(");
    const recoverIdx = sendBody.indexOf("recoverVerifiedFulfilment(");
    const resolveIdx = sendBody.indexOf("resolveConversationCompletion(");
    const governIdx = sendBody.indexOf("governConversationLifecycle(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fulfilIdx).toBeGreaterThan(guardIdx);
    expect(verifyIdx).toBeGreaterThan(fulfilIdx); // VERIFY strictly after FULFIL
    expect(recoverIdx).toBeGreaterThan(verifyIdx); // RECOVER strictly after VERIFY
    expect(resolveIdx).toBeGreaterThan(recoverIdx); // RESOLVE strictly after RECOVER
    expect(governIdx).toBeGreaterThan(resolveIdx); // GOVERN strictly after RESOLVE
    expect(sendBody).toMatch(/if \(outcome\.audit_id !== null\)/);
  });
});

// =====================================================================
// 11. The R33 resolution core stays the SOLE authority R34 consumes; and R34 does NOT break R33, R32, R31 or R30.
// =====================================================================

describe("receptionist lifecycle — it consumes the R33 resolution core, and adds a governor not a second resolver", () => {
  it("the R33 resolution core ships (the surface the lifecycle engine consumes)", () => {
    expect(existsSync(resolve(ROOT, RESOLUTION_CORE)), RESOLUTION_CORE).toBe(true);
  });

  it("the runtime reconstructs the resolution decision from the RECORDED disposition, and governs it — nothing more", () => {
    const rcode = codeOf(read(RUNTIME));
    // It rebuilds the R33 ResolveBookingRecoveryDecision from the reader row (the booking is reconstructed verbatim) and
    // hands it to the pure resolveConversationLifecycle — but it names NO resolver of any lower engine, and it re-decides
    // neither the resolution, the recovery, the verification, the fulfilment, nor the authorisation. The Resolution
    // Engine is authoritative.
    expect(rcode).toMatch(/kind:\s*"prepare_booking"/);
    expect(rcode).toMatch(/\bresolveConversationLifecycle\b/);
    expect(rcode).not.toMatch(/\bresolveConversationResolution\b/);
    expect(rcode).not.toMatch(/\bresolveRecovery\b/);
    expect(rcode).not.toMatch(/\bresolveVerification\b/);
    expect(rcode).not.toMatch(/\bresolveFulfilment\b/);
    expect(rcode).not.toMatch(/\bderiveAuthorisationState\b/);
    expect(rcode).not.toMatch(/\bresolveAuthorisation\b/);
    expect(rcode).not.toMatch(/\bresolveExecution\b/);
    expect(rcode).not.toMatch(/\bresolveAction\b/);
  });

  it("R34 NAMES NEITHER R33's ledger primitives NOR R32's NOR R31's NOR R30's — it resolves nothing, recovers nothing, verifies nothing, performs nothing", () => {
    const pcode = codeOf(read(CORE));
    const rcode = codeOf(read(RUNTIME));
    for (const code of [pcode, rcode]) {
      expect(code).not.toMatch(RESOLUTION_WRITE_FN); // never files an R33 resolution
      expect(code).not.toMatch(RESOLUTION_READER_FN); // never uses R33's own reader
      expect(code).not.toMatch(RECOVERY_WRITE_FN); // never files an R32 recovery
      expect(code).not.toMatch(RECOVERY_READER_FN); // never uses R32's own reader
      expect(code).not.toMatch(VERIFY_WRITE_FN); // never files an R31 verification
      expect(code).not.toMatch(FULFIL_WRITE_FN); // never files an R30 fulfilment
    }
  });

  it("R34 DOES NOT BREAK R33 — R33's write primitive and context reader are STILL each named by exactly one module", () => {
    // R34 must not have introduced a second resolution write path or reader. Across all source, R33's primitives are
    // STILL named ONLY by the R33 runtime — proof that R34 is additive, not a second resolver.
    const R33_RUNTIME = "server/services/receptionist-resolution.ts";
    const resolutionWriters = walkSources(SOURCE_ROOTS)
      .filter((full) => RESOLUTION_WRITE_FN.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    const resolutionReaders = walkSources(SOURCE_ROOTS)
      .filter((full) => RESOLUTION_READER_FN.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(resolutionWriters).toEqual([R33_RUNTIME]);
    expect(resolutionReaders).toEqual([R33_RUNTIME]);
  });

  it("R34 DOES NOT BREAK R33 — resolveConversationResolution is STILL defined only in the R33 resolution core", () => {
    const definers = walkSources(SOURCE_ROOTS)
      .filter((full) => /export function resolveConversationResolution\(/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(definers).toEqual([RESOLUTION_CORE]);
  });

  it("R34 DOES NOT BREAK R33 — the SEND path STILL invokes resolveConversationCompletion exactly once", () => {
    const seam = codeOf(read(REVIEW_SEAM));
    const calls = seam.match(/resolveConversationCompletion\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("R34 DOES NOT BREAK R32 — R32's write primitive and context reader are STILL each named by exactly one module, and SEND STILL recovers once", () => {
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
    const seam = codeOf(read(REVIEW_SEAM));
    const calls = seam.match(/recoverVerifiedFulfilment\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("R34 DOES NOT BREAK R32 — resolveRecovery is STILL defined only in the R32 recovery core", () => {
    const RECOVERY_CORE = "lib/receptionist/conversation-recovery.ts";
    const definers = walkSources(SOURCE_ROOTS)
      .filter((full) => /export function resolveRecovery\(/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(definers).toEqual([RECOVERY_CORE]);
  });

  it("R34 DOES NOT BREAK R31 — R31's write primitive is STILL named by exactly one module, and SEND STILL verifies once", () => {
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

  it("R34 DOES NOT BREAK R30 — R30's write primitive is STILL named by exactly one module, and SEND STILL fulfils once", () => {
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

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONVERSATION ORCHESTRATION ENGINE governance invariants
 * (the AI Receptionist Programme, R35 — CONVERSATION ORCHESTRATION ENGINE).
 *
 * R17–R25 built the DERIVING stack; R26 RESOLVES an outcome; R27 PREPARES an action; R28 DECIDES an execution's
 * eligibility; R29 DETERMINES whether that decided execution requires APPROVAL; R30 PERFORMS the approved internal
 * business operation (booking fulfilment); R31 VERIFIES that performed operation and records an INTEGRITY verdict
 * (consistent / missing / inconsistent); R32 CLASSIFIES that verdict into the RECOVERY it warrants (none / reinstate /
 * reconcile); R33 CLASSIFIES that recovery into the CONVERSATION-COMPLETION state it implies (terminal / recoverable /
 * unresolved) and records a RESOLUTION; R34 GOVERNS that resolution into the CONVERSATION-LIFECYCLE transition it
 * undergoes and the state it rests in (closed / retained / escalated) and records a LIFECYCLE. R35 is the NEXT layer —
 * and, in this stack, the FIFTH that does not perform: given a GOVERNED lifecycle, it ROUTES the conversation to the
 * platform capability that should RESPOND, and records an auditable ORCHESTRATION. Its law is exact — "the Orchestration
 * Engine ROUTES the response for a governed conversation; it CONSUMES the Lifecycle Decision (re-deriving nothing) and
 * reads the RECORDED disposition; it ROUTES the disposition to a capability (conclude / recover / escalate) and the
 * target it routes to (conversation_conclusion / recovery_handling / human_attention) and reports whether the
 * conversation's orchestration is concluded and whether an active capability response is routed, never a business action;
 * it preserves Policy, Audit and Human Review as mandatory (transitively, through the lifecycle it consumes); it is
 * idempotent (a governed lifecycle's response is orchestrated AT MOST ONCE); and it MUST NOT bypass Human Review, perform
 * / verify a fulfilment, determine or execute a recovery, determine a resolution, govern a lifecycle, or duplicate any
 * lower engine's logic. THE ORCHESTRATION ENGINE ROUTES WORK — IT DOES NOT EXECUTE WORK." This suite proves that contract
 * as a matter of SOURCE, not discipline — the house bar of tool-registry-describes-not-authorises.test.ts:
 *
 *   • SINGLE WRITE PATH & SINGLE READ PATH — across all non-test source (app/, server/, lib/), the orchestration ledger's
 *     write primitive (`record_receptionist_conversation_orchestration`) AND the orchestration-context reader
 *     (`find_receptionist_orchestration_context`) are each named by EXACTLY ONE module: the orchestration server runtime.
 *     No other file can file an orchestration, so there is no second path.
 *   • THE PURE CORE IS PURE, MODEL-FREE & POLICY-FREE — it reaches no server / IO / model / clock / RNG, and its ONLY
 *     import is the R34 lifecycle surface it CONSUMES. It imports NO policy module, NO resolution module, NO recovery
 *     module, NO verification module, NO fulfilment module, NO authorisation module and NO other engine — R34 folded the
 *     whole stack (policy, resolution, recovery, verification, fulfilment, authorisation, execution, action, outcome) into
 *     the lifecycle decision — so there is provably NO duplicate logic. It ROUTES a disposition; it persists nothing and
 *     routes nothing itself.
 *   • THE LIFECYCLE ENGINE STAYS AUTHORITATIVE — the core CONSUMES the decided lifecycle (imports `isLifecycleDecided`,
 *     defers on it FIRST) and NEVER re-derives it (it never names `resolveConversationLifecycle`), so no duplicate
 *     lifecycle logic exists, and the Lifecycle Engine (and transitively Resolution, Recovery, Verification, Fulfilment,
 *     Authorisation, Execution, Action and Outcome) stays authoritative. The RUNTIME goes further: it reads R34's RECORDED
 *     disposition and re-derives NOTHING — it names NO resolver of ANY lower engine (not `resolveConversationLifecycle`,
 *     not `resolveConversationResolution`, not `resolveRecovery`, not `resolveVerification`, not `resolveFulfilment`, not
 *     `deriveAuthorisationState`).
 *   • POLICY & HUMAN REVIEW STAY MANDATORY — TRANSITIVELY, NOT RE-RUN — neither the core nor the runtime imports a policy
 *     surface or NAMES a policy decision function: a decided lifecycle exists ONLY for an approved, policy-cleared,
 *     verified, recovered, resolved, governed operation (R34's inherited gate), so a policy-blocked or un-approved booking
 *     is structurally UN-ORCHESTRATABLE without this engine touching policy or re-deciding approval.
 *   • THE APPROVAL GATE IS INHERITED, AND RE-PINNED AT STORAGE — the core emits an orchestration ONLY for a decided
 *     lifecycle (which only exists for an `approved` grant), so the approval gate is inherited via the FIRST defer; the
 *     ledger CHECK-pins `approval_state` to the single value 'approved' and `status` to 'orchestrated'; and the write
 *     primitive REJECTS any other approval with "Human Review may not be bypassed". There is no path to orchestrating the
 *     response of un-approved work.
 *   • THE ROUTE IS A COHERENT DETERMINATION — THE R35 KEYSTONE — two CHECKs (and the write primitive) pin
 *     `concluded = (orchestration_route = 'conclude')` and `active = (orchestration_route <> 'conclude')`: a stored
 *     orchestration can NEVER claim the conversation is concluded over a `recover`/`escalate` route, nor claim an active
 *     response is routed over a `conclude` one. Concluded iff conclude; active iff not conclude.
 *   • THE TARGET IS A DETERMINISTIC TWO-STAGE FOLD — a novel R35 shape. STAGE 1 (the route fold): a CHECK (and the core
 *     switch, and the write primitive) pin the SOURCE lifecycle state to the route: `closed` ⇒ `conclude`, `retained` ⇒
 *     `recover`, `escalated` ⇒ `escalate`. STAGE 2 (the target fold): a CHECK (and the core switch, and the write
 *     primitive) pin the route to the responding capability: `conclude` ⇒ `conversation_conclusion`, `recover` ⇒
 *     `recovery_handling`, `escalate` ⇒ `human_attention`. And FULFILMENT-PRESENCE COHERENCE is inherited transitively
 *     from R34/R33/R32/R31: (fulfilment_id is null) = (lifecycle_state = 'retained').
 *   • IT INTEGRATES WITH HUMAN REVIEW — IT NEVER DUPLICATES THE GRANT — the terminal grant arises ONLY through R14's
 *     Human Review architecture and R29's fold; the RUNTIME reads the RECORDED `approved` state, so it re-folds NOTHING
 *     (it names no `deriveAuthorisationState`) and records NOTHING (it names no `record_receptionist_review_resolution`).
 *     It threads the full Human Review provenance so the ledgers JOIN.
 *   • IT ROUTES THE RESPONSE — IT EXECUTES NONE — neither the core nor the runtime reaches a transport, provider,
 *     generator, calendar, scheduler or quote path, AND — the load-bearing R35 proof — the runtime NAMES NEITHER R34's
 *     lifecycle writer (`record_receptionist_conversation_lifecycle`) NOR R34's lifecycle reader
 *     (`find_receptionist_lifecycle_context`) NOR R33's resolution writer/reader NOR R32's recovery writer/reader NOR
 *     R31's verification writer NOR R30's fulfilment writer: it re-governs nothing, re-resolves nothing, re-recovers
 *     nothing, re-verifies nothing, re-books nothing, retries nothing, schedules nothing and corrects no record. The
 *     orchestration ledger row IS the routing verdict and its audit.
 *   • IT IS IDEMPOTENT — NOT RETRY — the ledger's `lifecycle_id` is UNIQUE and the writer inserts ON CONFLICT DO NOTHING
 *     (returning the existing id), so a repeat orchestrates nothing; the runtime orchestrates no re-attempt (retry is an
 *     explicit R35 non-goal — it names no setTimeout / setInterval / backoff).
 *   • THE PERSIST IS BEST-EFFORT — the runtime SWALLOWS a failed write (returns null), it never THROWS, and it reaches
 *     no model and no reply pipeline — the confirmation, the grant, the fulfilment, the verification, the recovery, the
 *     resolution and the lifecycle flow through the UNCHANGED pipelines.
 *   • THE LEDGER IS APPEND-ONLY, SERVICE-ROLE-ONLY, APPROVED-ONLY, DETERMINISTIC & COHERENT — RLS-enabled with no
 *     policies, UPDATE/DELETE rejected by triggers, a SECURITY DEFINER writer granted only to service_role, its `status`
 *     CHECK-pinned to 'orchestrated', its `approval_state` CHECK-pinned to 'approved', a CHECK that pins
 *     (orchestration_type, orchestration_outcome) to the EXACT fold, the two concluded/active coherences, the two-stage
 *     fold and the fulfilment-presence coherence above.
 *   • THE READER CENTRES ON THE LIFECYCLE LEDGER — a service-role-only SECURITY DEFINER `sql` function that SELECTs
 *     (never writes) R34's RECORDED disposition from `receptionist_conversation_lifecycles` alone — it re-reads NEITHER
 *     the R33 resolution ledger, NOR the R32 recovery ledger, NOR the R31 verification ledger, NOR the R30 fulfilment
 *     ledger directly. This centring IS the storage embodiment of "the Lifecycle Engine remains authoritative — the
 *     Orchestration Engine consumes its RECORDED decision".
 *   • THE RUNTIME ORCHESTRATES ON SEND ONLY — STRICTLY AFTER R30, R31, R32, R33 AND R34 — it is invoked from
 *     `resolveReviewSend` (never `resolveReviewDismiss`), exactly once, strictly AFTER the durable `sent` resolution
 *     guard, AFTER the R30 fulfilment call, AFTER the R31 verification call, AFTER the R32 recovery call, AFTER the R33
 *     resolution call AND AFTER the R34 lifecycle call, so Human Review can NEVER be bypassed and R35 always re-reads a
 *     committed R34 disposition.
 *   • IT DOES NOT BREAK R34, R33, R32, R31 OR R30 — R35 adds a ROUTER, not a second governor, resolver, recoverer,
 *     verifier or performer: R34's lifecycle write primitive and context reader are STILL each named by exactly one module
 *     (the R34 runtime), R33's resolution write primitive and reader STILL by one, R32's recovery write primitive and
 *     reader STILL by one, R31's verification write primitive STILL by one, R30's fulfilment write primitive STILL by
 *     one, `resolveConversationLifecycle` is STILL defined only in the R34 core, `resolveConversationResolution` STILL
 *     only in the R33 core, `resolveRecovery` STILL only in the R32 core, and the SEND path STILL invokes
 *     `governConversationLifecycle`, `resolveConversationCompletion`, `recoverVerifiedFulfilment`,
 *     `verifyApprovedFulfilment` and `fulfilApprovedBooking` exactly once each. R35's modules name none of those
 *     primitives.
 *
 * The engine's runtime behaviour is pinned against real Postgres in
 * __tests__/integration/receptionist/conversation-orchestration-pipeline.test.ts, and the pure core's routing
 * exhaustively in __tests__/receptionist/conversation-orchestration.test.ts. This tier is HERMETIC — a filesystem scan
 * over comment-stripped source — so the prose documenting the contract can neither satisfy a positive match nor trip a
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

const CORE = "lib/receptionist/conversation-orchestration.ts";
const RUNTIME = "server/services/receptionist-orchestration.ts";
const REVIEW_SEAM = "server/services/receptionist-review.ts";
const LIFECYCLE_CORE = "lib/receptionist/conversation-lifecycle.ts";
const MIGRATION = "supabase/migrations/20260904000000_receptionist_conversation_orchestrations.sql";

/** The orchestration ledger's write primitive — the function an auditor would call to file an orchestration route. */
const WRITE_FN = /\brecord_receptionist_conversation_orchestration\b/;

/** The orchestration-context reader — the READ the runtime routes R34's RECORDED disposition through. */
const READER_FN = /\bfind_receptionist_orchestration_context\b/;

/** R34's lifecycle WRITE primitive — R35 must NAME it NOWHERE (it CONSUMES the recorded disposition, it never re-files it). */
const LIFECYCLE_WRITE_FN = /\brecord_receptionist_conversation_lifecycle\b/;

/** R34's lifecycle-context reader — R35 uses its OWN orchestration-context reader, so R35 must NAME this NOWHERE. */
const LIFECYCLE_READER_FN = /\bfind_receptionist_lifecycle_context\b/;

/** R33's resolution WRITE primitive — R35 must NAME it NOWHERE (it ROUTES the response, it never re-files a resolution). */
const RESOLUTION_WRITE_FN = /\brecord_receptionist_conversation_resolution\b/;

/** R33's resolution-context reader — R35 must NAME it NOWHERE. */
const RESOLUTION_READER_FN = /\bfind_receptionist_resolution_context\b/;

/** R32's recovery WRITE primitive — R35 must NAME it NOWHERE (it ROUTES the response, it never re-files a recovery). */
const RECOVERY_WRITE_FN = /\brecord_receptionist_conversation_recovery\b/;

/** R32's recovery-context reader — R35 must NAME it NOWHERE. */
const RECOVERY_READER_FN = /\bfind_receptionist_recovery_context\b/;

/** R31's verification WRITE primitive — R35 must NAME it NOWHERE (it ROUTES the response, it never verifies). */
const VERIFY_WRITE_FN = /\brecord_receptionist_conversation_verification\b/;

/** R30's fulfilment WRITE primitive — R35 must NAME it NOWHERE (it ROUTES the response, it never PERFORMS a fulfilment). */
const FULFIL_WRITE_FN = /\brecord_receptionist_conversation_fulfilment\b/;

/** The R14 human-grant writer — R35 must NAME it NOWHERE (it READS the recorded grant, it never re-records it). */
const REVIEW_RESOLUTION_WRITE_FN = /\brecord_receptionist_review_resolution\b/;

/** The policy DECISION functions — neither core nor runtime may NAME one (policy is consumed transitively). */
const POLICY_DECISION_FNS = /\b(?:evaluateReply|isAutoSendable|redactReply|clearForHumanSend)\b/;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

// =====================================================================
// 0. The engine, the ledger and the runtime all ship, and the review SEND path integrates them.
// =====================================================================

describe("receptionist orchestration — the engine ships and is wired", () => {
  it(`ships the append-only orchestration ledger migration ${MIGRATION}`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION)), MIGRATION).toBe(true);
  });

  it(`ships the pure core ${CORE}`, () => {
    expect(existsSync(resolve(ROOT, CORE)), CORE).toBe(true);
  });

  it(`ships the server runtime ${RUNTIME}`, () => {
    expect(existsSync(resolve(ROOT, RUNTIME)), RUNTIME).toBe(true);
  });

  it("the pure core exports the single orchestration entry point and its decided predicate", () => {
    const code = codeOf(read(CORE));
    expect(code).toMatch(/export function resolveConversationOrchestration\(/);
    expect(code).toMatch(/export function isOrchestrationDecided\(/);
  });

  it("the server runtime exports the single orchestration entry point", () => {
    const code = codeOf(read(RUNTIME));
    expect(code).toMatch(/export async function orchestrateConversationLifecycle\(/);
  });

  it("the Human Review SEND path imports the orchestration runtime (the sole caller)", () => {
    const specs = importSpecifiers(codeOf(read(REVIEW_SEAM)));
    expect(specs).toContain("@/server/services/receptionist-orchestration");
  });
});

// =====================================================================
// 1. SINGLE WRITE PATH & SINGLE READ PATH — exactly one module names each ledger primitive.
// =====================================================================

describe("receptionist orchestration — exactly one module writes the ledger and one reads the context", () => {
  const writers = walkSources(SOURCE_ROOTS)
    .filter((full) => WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();
  const readers = walkSources(SOURCE_ROOTS)
    .filter((full) => READER_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the ONLY module that names the ledger write primitive is the orchestration server runtime", () => {
    // If this list ever grows, a second orchestration-write path (or a bypass) has appeared.
    expect(writers).toEqual([RUNTIME]);
  });

  it("the ONLY module that names the orchestration-context reader is the orchestration server runtime", () => {
    expect(readers).toEqual([RUNTIME]);
  });

  it("no app/ route, action, or component files an orchestration directly", () => {
    expect(writers.filter((p) => p.startsWith("app/"))).toEqual([]);
    expect(readers.filter((p) => p.startsWith("app/"))).toEqual([]);
  });

  it("no other server/ module files an orchestration directly", () => {
    expect(writers.filter((p) => p !== RUNTIME && p.startsWith("server/"))).toEqual([]);
    expect(readers.filter((p) => p !== RUNTIME && p.startsWith("server/"))).toEqual([]);
  });

  it("the orchestration entry point resolveConversationOrchestration is DEFINED in exactly one module — the pure core", () => {
    // No feature implements independent orchestration logic: the single source of truth is exported once and consumed.
    const definers = walkSources(SOURCE_ROOTS)
      .filter((full) => /export function resolveConversationOrchestration\(/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(definers).toEqual([CORE]);
  });
});

// =====================================================================
// 2. The pure core is PURE, MODEL-FREE and POLICY-FREE — it CONSUMES the lifecycle surface, and nothing else.
// =====================================================================

describe("receptionist orchestration — the pure core is pure, model-free and policy-free", () => {
  const pcode = codeOf(read(CORE));

  it("is a shared pure module (NOT server-only — the runtime and tests import it)", () => {
    expect(importSpecifiers(pcode)).not.toContain("server-only");
  });

  it("its ONLY import is the R34 lifecycle surface it consumes — NO policy, NO resolution, NO other module", () => {
    // The lifecycle import is the predicate it CONSUMES (isLifecycleDecided) plus its types. There is NOTHING else —
    // most importantly NO policy module, NO resolution module, NO recovery module, NO verification module, NO fulfilment
    // module and NO authorisation module (R34 already folded the whole stack into the lifecycle decision). This is the
    // headline R35 proof that no duplicate policy, resolution, recovery, verification, fulfilment, authorisation or
    // lifecycle logic is introduced.
    expect(pcode).toMatch(/isLifecycleDecided/);
    expect(importSpecifiers(pcode)).toEqual(["@/lib/receptionist/conversation-lifecycle"]);
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/policy");
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/conversation-resolution");
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/conversation-recovery");
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/conversation-verification");
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/conversation-fulfilment");
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/conversation-authorisation");
  });

  it("DUPLICATES NOTHING beneath it — it re-derives no lifecycle, resolution, recovery, verification, fulfilment, authorisation, action or outcome", () => {
    // It consumes ALREADY-computed inputs; it names none of the resolvers/extractors/detectors — most importantly it
    // NEVER re-derives the lifecycle (it CONSUMES the R34 decision via isLifecycleDecided) and it re-folds no grant. This
    // is the R35 analogue of R34's "never names resolveConversationResolution".
    expect(pcode).not.toMatch(/\bresolveConversationLifecycle\b/);
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

  it("touches no I/O and calls no model — it routes, it does not generate, persist or govern", () => {
    expect(pcode).not.toMatch(/createAdminClient/);
    expect(pcode).not.toMatch(/supabase/i);
    expect(pcode).not.toMatch(/\bfetch\(/);
    expect(pcode).not.toMatch(/@\/lib\/ai\//);
    expect(pcode).not.toMatch(/Anthropic/);
    // It performs NO org lookup and NO env read.
    expect(pcode).not.toMatch(/process\.env/);
  });

  it("has no clock and no RNG (an orchestration is reconstructable)", () => {
    expect(pcode).not.toMatch(/Math\.random/);
    expect(pcode).not.toMatch(/Date\.now/);
    expect(pcode).not.toMatch(/new Date\(/);
  });

  it("names NO ledger primitive — the pure core reaches neither its own writer/reader nor R30/R31/R32/R33/R34's", () => {
    expect(pcode).not.toMatch(WRITE_FN);
    expect(pcode).not.toMatch(READER_FN);
    expect(pcode).not.toMatch(LIFECYCLE_WRITE_FN);
    expect(pcode).not.toMatch(LIFECYCLE_READER_FN);
    expect(pcode).not.toMatch(RESOLUTION_WRITE_FN);
    expect(pcode).not.toMatch(RESOLUTION_READER_FN);
    expect(pcode).not.toMatch(RECOVERY_WRITE_FN);
    expect(pcode).not.toMatch(RECOVERY_READER_FN);
    expect(pcode).not.toMatch(VERIFY_WRITE_FN);
    expect(pcode).not.toMatch(FULFIL_WRITE_FN);
  });
});

// =====================================================================
// 3. The Lifecycle Engine remains AUTHORITATIVE — the orchestration CONSUMES it and DEFERS to it.
// =====================================================================

describe("receptionist orchestration — the Lifecycle Engine stays authoritative", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("CONSUMES the decided lifecycle — resolveConversationOrchestration defers on it FIRST", () => {
    // The first gate stands down when the Lifecycle Engine rendered no decision (transitively preserving the Resolution,
    // Recovery, Verification, Fulfilment, Authorisation, Execution, Action and Outcome Engines' authority too — a decided
    // lifecycle only exists for an approved, verified, recovered, resolved, governed operation).
    expect(pcode).toMatch(
      /if \(!isLifecycleDecided\(lifecycle\)\) return abstain\("no_lifecycle_decision"\)/,
    );
  });

  it("NEVER re-derives the lifecycle — the core names isLifecycleDecided but not resolveConversationLifecycle", () => {
    expect(pcode).toMatch(/isLifecycleDecided/);
    expect(pcode).not.toMatch(/\bresolveConversationLifecycle\b/);
  });

  it("the RUNTIME re-derives NOTHING — it consumes R34's RECORDED disposition and names no lower resolver", () => {
    // Design B: the runtime reads R34's RECORDED lifecycle row and reconstructs the decision verbatim from the recorded
    // columns. It never re-governs, never re-resolves, never re-recovers, never re-verifies, never re-derives the
    // fulfilment, never re-folds the grant — so it names NO resolver of ANY lower engine. This is the same strong
    // authority proof as R34's runtime (which consumed the recorded disposition wholesale): R35 consumes the recorded
    // lifecycle wholesale.
    expect(rcode).not.toMatch(/\bresolveConversationLifecycle\b/);
    expect(rcode).not.toMatch(/\bresolveConversationResolution\b/);
    expect(rcode).not.toMatch(/\bresolveRecovery\b/);
    expect(rcode).not.toMatch(/\bresolveVerification\b/);
    expect(rcode).not.toMatch(/\bresolveFulfilment\b/);
    expect(rcode).not.toMatch(/\bderiveAuthorisationState\b/);
    expect(rcode).not.toMatch(/\bresolveAuthorisation\b/);
    expect(rcode).not.toMatch(/\bresolveExecution\b/);
    expect(rcode).not.toMatch(/\bresolveAction\b/);
  });

  it("the lifecycle→orchestration map maps govern_resolution_lifecycle → orchestrate_lifecycle_response (it consumes the R34 vocabulary)", () => {
    expect(pcode).toMatch(/govern_resolution_lifecycle:\s*"orchestrate_lifecycle_response"/);
  });

  it("the booking it routes is BY REFERENCE the lifecycle's payload — it can never drift from the decision", () => {
    expect(pcode).toMatch(/booking:\s*lifecycle\.booking/);
  });

  it("the source lifecycle state it routes is BY REFERENCE the lifecycle's own state", () => {
    expect(pcode).toMatch(/lifecycle_state:\s*lifecycle\.state/);
  });
});

// =====================================================================
// 4. Policy stays MANDATORY — transitively, through the lifecycle; neither core nor runtime imports or re-runs it.
// =====================================================================

describe("receptionist orchestration — policy is consumed transitively, never imported or re-run", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("neither the core nor the runtime imports the policy module (the lifecycle already folded the verdict)", () => {
    expect(importSpecifiers(pcode)).not.toContain("@/lib/receptionist/policy");
    expect(importSpecifiers(rcode)).not.toContain("@/lib/receptionist/policy");
  });

  it("neither the core nor the runtime NAMES a policy decision function or the guardrail verdict type", () => {
    // A policy `block` foreclosed the authorisation at R29, foreclosed can never derive to `approved`, an un-approved
    // authorisation is never fulfilled at R30, verified at R31, recovered at R32, resolved at R33 nor governed at R34 —
    // so a policy-blocked booking is structurally UN-ORCHESTRATABLE WITHOUT this engine touching policy.
    expect(pcode).not.toMatch(POLICY_DECISION_FNS);
    expect(rcode).not.toMatch(POLICY_DECISION_FNS);
    expect(pcode).not.toMatch(/GuardrailVerdict/);
    expect(rcode).not.toMatch(/GuardrailVerdict/);
  });
});

// =====================================================================
// 5. THE APPROVAL GATE — inherited from R34 via the FIRST defer, and re-pinned at the storage layer.
// =====================================================================

describe("receptionist orchestration — the approval gate is inherited, and re-pinned in the ledger", () => {
  const pcode = codeOf(read(CORE));
  const sql = sqlCodeOf(read(MIGRATION));

  it("the pure core emits an orchestration ONLY for a DECIDED lifecycle — the approval gate is inherited", () => {
    // R35's core has no approval literal of its own: a decided lifecycle exists ONLY for an `approved` grant (R34's
    // inherited gate, R33's, R32's, R31's, R30's keystone), so deferring to isLifecycleDecided FIRST inherits the
    // approval gate transitively.
    expect(pcode).toMatch(
      /if \(!isLifecycleDecided\(lifecycle\)\) return abstain\("no_lifecycle_decision"\)/,
    );
  });

  it("names NO autonomous-approve construct anywhere in the core — the grant is the human's", () => {
    expect(pcode).not.toMatch(/auto[_-]?approve/i);
    expect(pcode).not.toMatch(/approve_now/i);
    expect(pcode).not.toMatch(/autonomous[_-]?approv/i);
  });

  it("APPROVED BY CONSTRUCTION — the ledger CHECK-pins approval_state to the single value 'approved'", () => {
    // Inherited from R34 → R33 → R32 → R31 → R30: an orchestration can ONLY exist for an approved operation.
    expect(sql).toMatch(/check\s*\(\s*approval_state\s*=\s*'approved'\s*\)/i);
  });

  it("ORCHESTRATED BY CONSTRUCTION — the ledger CHECK-pins status to the single value 'orchestrated'", () => {
    expect(sql).toMatch(/status\s+text\s+not null\s+default\s+'orchestrated'/i);
    expect(sql).toMatch(/check\s*\(\s*status\s*=\s*'orchestrated'\s*\)/i);
  });

  it("the write primitive REJECTS any non-approved authorisation — 'Human Review may not be bypassed'", () => {
    expect(sql).toMatch(/p_approval_state\s*<>\s*'approved'/i);
    expect(sql).toMatch(/Human Review may not be bypassed/i);
  });
});

// =====================================================================
// 6. THE R35 KEYSTONE — concluded = (route = 'conclude') and active = (route <> 'conclude'); plus the novel two-stage
//    fold (lifecycle state ⇒ route ⇒ target) and the inherited fulfilment-presence coherence. The whole row is
//    deterministic and coherent by construction.
// =====================================================================

describe("receptionist orchestration — the route is coherent with its flags (the R35 keystone)", () => {
  const pcode = codeOf(read(CORE));
  const sql = sqlCodeOf(read(MIGRATION));

  it("the orchestration route vocabulary is EXACTLY {conclude, recover, escalate} — a closed set of routing verbs", () => {
    expect(pcode).toMatch(
      /OrchestrationRoute\s*=\s*"conclude"\s*\|\s*"recover"\s*\|\s*"escalate"/,
    );
  });

  it("the orchestration target vocabulary is EXACTLY {conversation_conclusion, recovery_handling, human_attention} — a closed set of responding capabilities", () => {
    expect(pcode).toMatch(
      /OrchestrationTarget\s*=\s*\|?\s*"conversation_conclusion"\s*\|\s*"recovery_handling"\s*\|\s*"human_attention"/,
    );
  });

  it("a record is produced for ALL THREE routes — recover and escalate are NOT abstentions", () => {
    // The abstention vocabulary is ONLY the two deferrals; the routes are findings on a produced record.
    expect(pcode).toMatch(
      /OrchestrationAbstention\s*=\s*"no_lifecycle_decision"\s*\|\s*"unsupported_lifecycle"/,
    );
    // Isolate the abstention type DECLARATION (from its `=` to the terminating `;`) and prove neither non-conclude route
    // leaks into it — `recover` / `escalate` are findings on a produced decision, never a "nothing here".
    const declStart = pcode.indexOf("OrchestrationAbstention =");
    const abstentionDecl = pcode.slice(declStart, pcode.indexOf(";", declStart));
    expect(declStart).toBeGreaterThan(-1);
    expect(abstentionDecl).not.toMatch(/\brecover\b/);
    expect(abstentionDecl).not.toMatch(/\bescalate\b/);
  });

  it("THE KEYSTONE, IN THE CORE — concluded is TRUE iff the route is `conclude`, active iff it is NOT", () => {
    expect(pcode).toMatch(/concluded:\s*route === "conclude"/);
    expect(pcode).toMatch(/active:\s*route !== "conclude"/);
  });

  it("COHERENT BY CONSTRUCTION — table CHECKs pin concluded = (route = 'conclude') and active = (route <> 'conclude')", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_orchestrations_concluded_coherence check/i,
    );
    expect(sql).toMatch(/concluded = \(orchestration_route = 'conclude'\)/i);
    expect(sql).toMatch(
      /constraint receptionist_conversation_orchestrations_active_coherence check/i,
    );
    expect(sql).toMatch(/active = \(orchestration_route <> 'conclude'\)/i);
  });

  it("the write primitive re-validates both coherences (belt-and-braces with the table CHECKs)", () => {
    // A `recover`/`escalate` route carrying concluded=true — or a `conclude` route carrying active=true — is rejected by
    // the primitive, not only by the column CHECKs.
    expect(sql).toMatch(/p_concluded <> \(p_orchestration_route = 'conclude'\)/i);
    expect(sql).toMatch(/concluded=% is incoherent with route/i);
    expect(sql).toMatch(/p_active <> \(p_orchestration_route <> 'conclude'\)/i);
    expect(sql).toMatch(/active=% is incoherent with route/i);
  });
});

describe("receptionist orchestration — the target is the deterministic TWO-STAGE fold of the lifecycle, coherent with the record", () => {
  const pcode = codeOf(read(CORE));
  const sql = sqlCodeOf(read(MIGRATION));

  it("STAGE 1, IN THE CORE — a closed switch folds closed⇒conclude, retained⇒recover, escalated⇒escalate", () => {
    expect(pcode).toMatch(/case "closed":\s*return "conclude"/);
    expect(pcode).toMatch(/case "retained":\s*return "recover"/);
    expect(pcode).toMatch(/case "escalated":\s*return "escalate"/);
  });

  it("STAGE 2, IN THE CORE — a closed switch folds conclude⇒conversation_conclusion, recover⇒recovery_handling, escalate⇒human_attention", () => {
    expect(pcode).toMatch(/case "conclude":\s*return "conversation_conclusion"/);
    expect(pcode).toMatch(/case "recover":\s*return "recovery_handling"/);
    expect(pcode).toMatch(/case "escalate":\s*return "human_attention"/);
  });

  it("STAGE 1, ENFORCED — a table CHECK pins the route fold of the source lifecycle state", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_orchestrations_route_fold check/i,
    );
    expect(sql).toMatch(/\(lifecycle_state = 'closed' and orchestration_route = 'conclude'\)/i);
    expect(sql).toMatch(
      /\(lifecycle_state = 'retained' and orchestration_route = 'recover'\)/i,
    );
    expect(sql).toMatch(
      /\(lifecycle_state = 'escalated' and orchestration_route = 'escalate'\)/i,
    );
  });

  it("STAGE 2, ENFORCED — a table CHECK pins the target fold of the route", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_orchestrations_target_fold check/i,
    );
    expect(sql).toMatch(/\(orchestration_route = 'conclude' and orchestration_target = 'conversation_conclusion'\)/i);
    expect(sql).toMatch(/\(orchestration_route = 'recover' and orchestration_target = 'recovery_handling'\)/i);
    expect(sql).toMatch(/\(orchestration_route = 'escalate' and orchestration_target = 'human_attention'\)/i);
  });

  it("the write primitive re-validates BOTH fold stages (belt-and-braces with the table CHECKs)", () => {
    expect(sql).toMatch(/is not the deterministic fold of lifecycle state/i);
    expect(sql).toMatch(/is not the deterministic fold of route/i);
  });

  it("FULFILMENT-PRESENCE COHERENCE, INHERITED TRANSITIVELY FROM R34/R33/R32/R31 — a table CHECK pins (fulfilment_id is null) = (lifecycle_state = 'retained')", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_orchestrations_fulfilment_coherence check/i,
    );
    expect(sql).toMatch(
      /\(\s*fulfilment_id is null\s*\)\s*=\s*\(\s*lifecycle_state = 'retained'\s*\)/i,
    );
  });

  it("the write primitive re-validates the fulfilment-presence coherence (belt-and-braces with the table CHECK)", () => {
    expect(sql).toMatch(/\(p_fulfilment_id is null\)\s*<>\s*\(p_lifecycle_state = 'retained'\)/i);
    expect(sql).toMatch(/incoherent with fulfilment_id/i);
  });

  it("bounds the route, the target and the source lifecycle state to their vocabularies in the ledger CHECK and the primitive", () => {
    expect(sql).toMatch(
      /check\s*\(\s*orchestration_route\s+in\s*\(\s*'conclude',\s*'recover',\s*'escalate'\s*\)\s*\)/i,
    );
    expect(sql).toMatch(
      /check\s*\(\s*orchestration_target\s+in\s*\(\s*'conversation_conclusion',\s*'recovery_handling',\s*'human_attention'\s*\)\s*\)/i,
    );
    expect(sql).toMatch(
      /check\s*\(\s*lifecycle_state\s+in\s*\(\s*'closed',\s*'retained',\s*'escalated'\s*\)\s*\)/i,
    );
    expect(sql).toMatch(/p_orchestration_route not in \('conclude', 'recover', 'escalate'\)/i);
    expect(sql).toMatch(/p_orchestration_target not in \('conversation_conclusion', 'recovery_handling', 'human_attention'\)/i);
    expect(sql).toMatch(/p_lifecycle_state not in \('closed', 'retained', 'escalated'\)/i);
  });
});

// =====================================================================
// 7. INTEGRATE with Human Review — NEVER DUPLICATE the grant. R35 reads the RECORDED grant; it re-folds nothing.
// =====================================================================

describe("receptionist orchestration — integrates with Human Review, never duplicates the grant", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("the grant is neither re-folded nor re-recorded — the runtime reads the RECORDED approval_state", () => {
    // R35 consumes R34's RECORDED lifecycle row — which already carries the folded `approved` state — so neither the
    // core nor the runtime re-folds the grant. No duplicate approval logic.
    expect(pcode).not.toMatch(/\bderiveAuthorisationState\b/);
    expect(rcode).not.toMatch(/\bderiveAuthorisationState\b/);
  });

  it("NEITHER the core nor the runtime records a human grant — it names no review-resolution writer", () => {
    // The grant is the human's, recorded by the UNCHANGED R14 Human Review architecture. R35 reads it; it never
    // re-records it, so there is no duplicate human-decision recorder.
    expect(pcode).not.toMatch(REVIEW_RESOLUTION_WRITE_FN);
    expect(rcode).not.toMatch(REVIEW_RESOLUTION_WRITE_FN);
  });

  it("the runtime threads the FULL provenance — the lifecycle, the resolution, the recovery, the verification, the held reply, the sent reply and the human resolution", () => {
    expect(rcode).toMatch(/p_lifecycle_id:/);
    expect(rcode).toMatch(/p_resolution_id:/);
    expect(rcode).toMatch(/p_recovery_id:/);
    expect(rcode).toMatch(/p_verification_id:/);
    expect(rcode).toMatch(/p_review_audit_id:/);
    expect(rcode).toMatch(/p_sent_audit_id:/);
    expect(rcode).toMatch(/p_review_resolution_id:/);
  });
});

// =====================================================================
// 8. It ROUTES the response — it EXECUTES none; reaching NO external system; idempotent (not retry); best-effort.
// =====================================================================

describe("receptionist orchestration — routes the response, executes none, idempotently, best-effort", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("the orchestration vocabulary is EXACTLY {orchestrate_lifecycle_response} — quote/promotion orchestrations are absent", () => {
    expect(pcode).toMatch(/ORCHESTRATION_TYPES\s*=\s*\[\s*"orchestrate_lifecycle_response"\s*\]/);
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

  it("IT ROUTES — IT NEVER EXECUTES — neither the core nor the runtime NAMES R34's lifecycle, R33's resolution, R32's recovery, R31's verification or R30's fulfilment writer", () => {
    // THE load-bearing R35 proof. R35 re-governs nothing (names no R34 lifecycle writer and no R34 lifecycle reader),
    // re-resolves nothing (names no R33 resolution writer/reader), re-recovers nothing (names no R32 recovery
    // writer/reader), re-verifies nothing (names no R31 verification writer) and re-books nothing (names no R30
    // fulfilment writer): it reads R34's RECORDED disposition through its OWN reader and files an orchestration route —
    // never a lifecycle row, never a resolution row, never a recovery row, never a verification row, never a fulfilment
    // row.
    expect(pcode).not.toMatch(LIFECYCLE_WRITE_FN);
    expect(rcode).not.toMatch(LIFECYCLE_WRITE_FN);
    expect(pcode).not.toMatch(LIFECYCLE_READER_FN);
    expect(rcode).not.toMatch(LIFECYCLE_READER_FN);
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

  it("the runtime writes NO tenant row — no lead reflection, no customer promotion (the ledger IS the routing)", () => {
    // Like the R27–R34 runtimes, an orchestration touches NO tenant table: no `.from(...)` at all, no lead write, no
    // customers. Scheduling, promotion, re-booking and external writes are non-goals.
    expect(rcode).not.toMatch(/\.from\(/);
    expect(rcode).not.toMatch(/customers/);
    expect(rcode).not.toMatch(/\bleads\b/);
    expect(rcode).not.toMatch(/contact_phone/);
  });

  it("the runtime writes ONLY the one internal row — the orchestration ledger, through the write primitive", () => {
    expect(rcode).toMatch(WRITE_FN);
  });

  it("IDEMPOTENT, NOT RETRY — it names no re-attempt orchestration (retry is an explicit R35 non-goal)", () => {
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

  it("is server-only — it is the ONE place a governed conversation's response is durably orchestrated", () => {
    expect(importSpecifiers(rcode)).toContain("server-only");
  });
});

// =====================================================================
// 9. The migration installs an APPEND-ONLY, service-role-only, APPROVED-ONLY, DETERMINISTIC, IDEMPOTENT ledger.
// =====================================================================

describe("receptionist orchestration — the ledger is append-only, service-role-only, approved-only and idempotent", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("creates the receptionist_conversation_orchestrations table", () => {
    expect(sql).toMatch(
      /create table if not exists public\.receptionist_conversation_orchestrations/i,
    );
  });

  it("captures the anchors, the Human Review provenance, the routing, its flags, its payload and the status", () => {
    for (const column of [
      "org_id",
      "conversation_id",
      "enquiry_id",
      "lead_id",
      "customer_ref",
      "correlation_id",
      "action_id",
      "execution_id",
      "lifecycle_id",
      "resolution_id",
      "recovery_id",
      "authorisation_id",
      "verification_id",
      "fulfilment_id",
      "review_audit_id",
      "sent_audit_id",
      "review_resolution_id",
      "orchestration_type",
      "orchestration_outcome",
      "orchestration_route",
      "orchestration_target",
      "concluded",
      "active",
      "lifecycle_state",
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

  it("bounds the orchestration type and outcome to their vocabularies {orchestrate_lifecycle_response} / {conversation_response_orchestrated}", () => {
    expect(sql).toMatch(
      /check\s*\(\s*orchestration_type\s+in\s*\(\s*'orchestrate_lifecycle_response'\s*\)\s*\)/i,
    );
    expect(sql).toMatch(
      /check\s*\(\s*orchestration_outcome\s+in\s*\(\s*'conversation_response_orchestrated'\s*\)\s*\)/i,
    );
  });

  it("DETERMINISTIC BY CONSTRUCTION — a CHECK pins (orchestration_type, orchestration_outcome) to the exact fold", () => {
    // orchestrate_lifecycle_response ⇒ conversation_response_orchestrated. No writer — not even service_role — can file a
    // row whose outcome contradicts its type.
    expect(sql).toMatch(/constraint receptionist_conversation_orchestrations_outcome_fold check/i);
    expect(sql).toMatch(
      /orchestration_type = 'orchestrate_lifecycle_response' and orchestration_outcome = 'conversation_response_orchestrated'/i,
    );
  });

  it("IDEMPOTENT BY CONSTRUCTION — lifecycle_id is UNIQUE and the writer inserts ON CONFLICT DO NOTHING", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_orchestrations_lifecycle_unique unique \(lifecycle_id\)/i,
    );
    expect(sql).toMatch(/on conflict \(lifecycle_id\) do nothing/i);
    // On a repeat, the primitive resolves the existing row's id so the operation is a true no-op.
    expect(sql).toMatch(/select id into v_id[\s\S]*?where lifecycle_id = p_lifecycle_id/i);
  });

  it("the lifecycle anchor is NOT NULL in DDL — an orchestration is ALWAYS routed from a recorded lifecycle", () => {
    // R35's load-bearing anchor: the storage proof that "the Lifecycle Engine remains authoritative".
    expect(sql).toMatch(/lifecycle_id\s+uuid\s+not null/i);
    // The resolution + recovery + authorisation + verification anchors are equally mandatory.
    expect(sql).toMatch(/resolution_id\s+uuid\s+not null/i);
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
      /alter table public\.receptionist_conversation_orchestrations enable row level security/i,
    );
    expect(sql).not.toMatch(
      /create policy[\s\S]*?on public\.receptionist_conversation_orchestrations/i,
    );
  });

  it("is APPEND-ONLY — UPDATE and DELETE are rejected by triggers", () => {
    expect(sql).toMatch(
      /create or replace function public\.receptionist_conversation_orchestrations_block_mutation\(/i,
    );
    expect(sql).toMatch(/raise exception[\s\S]*?append-only[\s\S]*?tg_op/i);
    expect(sql).toMatch(/errcode\s*=\s*'restrict_violation'/i);
    expect(sql).toMatch(
      /create trigger receptionist_conversation_orchestrations_no_update\s+before update on public\.receptionist_conversation_orchestrations/i,
    );
    expect(sql).toMatch(
      /create trigger receptionist_conversation_orchestrations_no_delete\s+before delete on public\.receptionist_conversation_orchestrations/i,
    );
  });

  it("writes only through a SECURITY DEFINER primitive granted only to service_role", () => {
    expect(sql).toMatch(
      /create or replace function public\.record_receptionist_conversation_orchestration\(/i,
    );
    expect(sql).toMatch(/returns uuid/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = ''/i);
    expect(sql).toMatch(/insert into public\.receptionist_conversation_orchestrations/i);
    expect(sql).toMatch(/revoke all on function[\s\S]*?from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*?to service_role/i);
  });

  it("the write primitive re-validates the (type, outcome) fold (belt-and-braces with the table CHECK)", () => {
    expect(sql).toMatch(/does not match the deterministic fold/i);
  });

  it("REQUIRES the lifecycle anchor and the full Human Review provenance and a well-formed booking payload", () => {
    // The lifecycle + resolution + recovery + authorisation + verification anchors plus the three provenance ids are
    // mandatory...
    expect(sql).toMatch(
      /p_lifecycle_id is null[\s\S]*?p_resolution_id is null[\s\S]*?p_recovery_id is null[\s\S]*?p_authorisation_id is null[\s\S]*?p_verification_id is null[\s\S]*?p_review_audit_id is null[\s\S]*?p_sent_audit_id is null[\s\S]*?p_review_resolution_id is null/i,
    );
    // ...and an orchestrate_lifecycle_response must carry an expected job type plus a well-formed postcode and E.164 number.
    expect(sql).toMatch(/p_orchestration_type\s*=\s*'orchestrate_lifecycle_response'[\s\S]*?\+\\d\{10,15\}/i);
    expect(sql).toMatch(/p_orchestration_type\s*=\s*'orchestrate_lifecycle_response'[\s\S]*?p_job_type is null/i);
  });
});

// =====================================================================
// 10. The ORCHESTRATION-CONTEXT READER centres on the R34 lifecycle ledger; the runtime orchestrates on SEND, AFTER R34.
// =====================================================================

describe("receptionist orchestration — the reader centres on the lifecycle ledger, and orchestration fires on SEND after R34", () => {
  const sql = sqlCodeOf(read(MIGRATION));
  const seam = codeOf(read(REVIEW_SEAM));

  it("the reader is a service-role-only SECURITY DEFINER sql function granted only to service_role", () => {
    expect(sql).toMatch(
      /create or replace function public\.find_receptionist_orchestration_context\(/i,
    );
    expect(sql).toMatch(
      /revoke all on function public\.find_receptionist_orchestration_context\(uuid, uuid\)\s*from public, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.find_receptionist_orchestration_context\(uuid, uuid\)\s*to service_role/i,
    );
  });

  it("the reader CENTRES on the R34 lifecycle ledger — it reads the RECORDED disposition, and it never writes", () => {
    // Slice the reader function body (from its definition to its revoke) and prove it is a pure SELECT over R34's
    // lifecycle ledger. THE storage embodiment of "the Lifecycle Engine remains authoritative": the reader supplies
    // R34's RECORDED disposition, and the runtime reconstructs the decision from it — it never decides.
    const start = sql.indexOf("function public.find_receptionist_orchestration_context");
    const body = sql.slice(start, sql.indexOf("revoke all on function", start));
    expect(body).toMatch(/language sql/i);
    expect(body).toMatch(/security definer/i);
    expect(body).toMatch(/from public\.receptionist_conversation_lifecycles/i);
    expect(body).toMatch(/l\.status = 'governed'/i);
    expect(body).not.toMatch(/\binsert\b/i);
    expect(body).not.toMatch(/\bupdate\b/i);
    expect(body).not.toMatch(/\bdelete\b/i);
  });

  it("Design B — the reader re-reads NEITHER the R33 resolution, R32 recovery, R31 verification NOR R30 fulfilment ledger directly", () => {
    // R35 consumes R34's RECORDED disposition wholesale; it does NOT re-derive from the lower ledgers (that would be
    // duplicate logic). The reader's ONLY source is the lifecycle ledger.
    const start = sql.indexOf("function public.find_receptionist_orchestration_context");
    const body = sql.slice(start, sql.indexOf("revoke all on function", start));
    expect(body).not.toMatch(/from public\.receptionist_conversation_resolutions/i);
    expect(body).not.toMatch(/from public\.receptionist_conversation_recoveries/i);
    expect(body).not.toMatch(/from public\.receptionist_conversation_verifications/i);
    expect(body).not.toMatch(/from public\.receptionist_conversation_fulfilments/i);
    expect(body).not.toMatch(/\bjoin\b/i);
  });

  it("the SEND path invokes the Orchestration Engine EXACTLY ONCE", () => {
    const calls = seam.match(/orchestrateConversationLifecycle\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("orchestration is invoked from resolveReviewSend — NEVER from resolveReviewDismiss", () => {
    // Prove placement structurally: the call lives between the two function definitions (inside SEND), and the DISMISS
    // body — everything from its definition onward — names the engine NOWHERE.
    const sendIdx = seam.indexOf("resolveReviewSend");
    const dismissIdx = seam.indexOf("resolveReviewDismiss");
    expect(sendIdx).toBeGreaterThan(-1);
    expect(dismissIdx).toBeGreaterThan(sendIdx);
    const sendBody = seam.slice(sendIdx, dismissIdx);
    const dismissBody = seam.slice(dismissIdx);
    expect(sendBody).toMatch(/orchestrateConversationLifecycle\(/);
    expect(dismissBody).not.toMatch(/orchestrateConversationLifecycle\(/);
  });

  it("orchestration fires STRICTLY AFTER the `sent` guard, AFTER R30, AFTER R31, AFTER R32, AFTER R33 AND AFTER R34", () => {
    // Human Review can never be bypassed AND R35 always re-reads a committed R34 disposition: the call is downstream of
    // the `already_resolved` guard, downstream of fulfilApprovedBooking, downstream of verifyApprovedFulfilment,
    // downstream of recoverVerifiedFulfilment, downstream of resolveConversationCompletion, downstream of
    // governConversationLifecycle, and only when the send produced an audit.
    const sendIdx = seam.indexOf("resolveReviewSend");
    const dismissIdx = seam.indexOf("resolveReviewDismiss");
    const sendBody = seam.slice(sendIdx, dismissIdx);
    const guardIdx = sendBody.indexOf('"already_resolved", outcome');
    const fulfilIdx = sendBody.indexOf("fulfilApprovedBooking(");
    const verifyIdx = sendBody.indexOf("verifyApprovedFulfilment(");
    const recoverIdx = sendBody.indexOf("recoverVerifiedFulfilment(");
    const resolveIdx = sendBody.indexOf("resolveConversationCompletion(");
    const governIdx = sendBody.indexOf("governConversationLifecycle(");
    const orchestrateIdx = sendBody.indexOf("orchestrateConversationLifecycle(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fulfilIdx).toBeGreaterThan(guardIdx);
    expect(verifyIdx).toBeGreaterThan(fulfilIdx); // VERIFY strictly after FULFIL
    expect(recoverIdx).toBeGreaterThan(verifyIdx); // RECOVER strictly after VERIFY
    expect(resolveIdx).toBeGreaterThan(recoverIdx); // RESOLVE strictly after RECOVER
    expect(governIdx).toBeGreaterThan(resolveIdx); // GOVERN strictly after RESOLVE
    expect(orchestrateIdx).toBeGreaterThan(governIdx); // ORCHESTRATE strictly after GOVERN
    expect(sendBody).toMatch(/if \(outcome\.audit_id !== null\)/);
  });
});

// =====================================================================
// 11. The R34 lifecycle core stays the SOLE authority R35 consumes; and R35 does NOT break R34, R33, R32, R31 or R30.
// =====================================================================

describe("receptionist orchestration — it consumes the R34 lifecycle core, and adds a router not a second governor", () => {
  it("the R34 lifecycle core ships (the surface the orchestration engine consumes)", () => {
    expect(existsSync(resolve(ROOT, LIFECYCLE_CORE)), LIFECYCLE_CORE).toBe(true);
  });

  it("the runtime reconstructs the lifecycle decision from the RECORDED disposition, and routes it — nothing more", () => {
    const rcode = codeOf(read(RUNTIME));
    // It rebuilds the R34 GovernResolutionLifecycleDecision from the reader row (the booking is reconstructed verbatim)
    // and hands it to the pure resolveConversationOrchestration — but it names NO resolver of any lower engine, and it
    // re-decides neither the lifecycle, the resolution, the recovery, the verification, the fulfilment, nor the
    // authorisation. The Lifecycle Engine is authoritative.
    expect(rcode).toMatch(/kind:\s*"prepare_booking"/);
    expect(rcode).toMatch(/\bresolveConversationOrchestration\b/);
    expect(rcode).not.toMatch(/\bresolveConversationLifecycle\b/);
    expect(rcode).not.toMatch(/\bresolveConversationResolution\b/);
    expect(rcode).not.toMatch(/\bresolveRecovery\b/);
    expect(rcode).not.toMatch(/\bresolveVerification\b/);
    expect(rcode).not.toMatch(/\bresolveFulfilment\b/);
    expect(rcode).not.toMatch(/\bderiveAuthorisationState\b/);
    expect(rcode).not.toMatch(/\bresolveAuthorisation\b/);
    expect(rcode).not.toMatch(/\bresolveExecution\b/);
    expect(rcode).not.toMatch(/\bresolveAction\b/);
  });

  it("R35 NAMES NEITHER R34's ledger primitives NOR R33's NOR R32's NOR R31's NOR R30's — it governs nothing, resolves nothing, recovers nothing, verifies nothing, performs nothing", () => {
    const pcode = codeOf(read(CORE));
    const rcode = codeOf(read(RUNTIME));
    for (const code of [pcode, rcode]) {
      expect(code).not.toMatch(LIFECYCLE_WRITE_FN); // never files an R34 lifecycle
      expect(code).not.toMatch(LIFECYCLE_READER_FN); // never uses R34's own reader
      expect(code).not.toMatch(RESOLUTION_WRITE_FN); // never files an R33 resolution
      expect(code).not.toMatch(RESOLUTION_READER_FN); // never uses R33's own reader
      expect(code).not.toMatch(RECOVERY_WRITE_FN); // never files an R32 recovery
      expect(code).not.toMatch(RECOVERY_READER_FN); // never uses R32's own reader
      expect(code).not.toMatch(VERIFY_WRITE_FN); // never files an R31 verification
      expect(code).not.toMatch(FULFIL_WRITE_FN); // never files an R30 fulfilment
    }
  });

  it("R35 DOES NOT BREAK R34 — R34's write primitive and context reader are STILL each named by exactly one module", () => {
    // R35 must not have introduced a second lifecycle write path or reader. Across all source, R34's primitives are
    // STILL named ONLY by the R34 runtime — proof that R35 is additive, not a second governor.
    const R34_RUNTIME = "server/services/receptionist-lifecycle.ts";
    const lifecycleWriters = walkSources(SOURCE_ROOTS)
      .filter((full) => LIFECYCLE_WRITE_FN.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    const lifecycleReaders = walkSources(SOURCE_ROOTS)
      .filter((full) => LIFECYCLE_READER_FN.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(lifecycleWriters).toEqual([R34_RUNTIME]);
    expect(lifecycleReaders).toEqual([R34_RUNTIME]);
  });

  it("R35 DOES NOT BREAK R34 — resolveConversationLifecycle is STILL defined only in the R34 lifecycle core", () => {
    const definers = walkSources(SOURCE_ROOTS)
      .filter((full) => /export function resolveConversationLifecycle\(/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(definers).toEqual([LIFECYCLE_CORE]);
  });

  it("R35 DOES NOT BREAK R34 — the SEND path STILL invokes governConversationLifecycle exactly once", () => {
    const seam = codeOf(read(REVIEW_SEAM));
    const calls = seam.match(/governConversationLifecycle\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("R35 DOES NOT BREAK R33 — R33's write primitive and context reader are STILL each named by exactly one module, and SEND STILL resolves once", () => {
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
    const seam = codeOf(read(REVIEW_SEAM));
    const calls = seam.match(/resolveConversationCompletion\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("R35 DOES NOT BREAK R33 — resolveConversationResolution is STILL defined only in the R33 resolution core", () => {
    const RESOLUTION_CORE = "lib/receptionist/conversation-resolution.ts";
    const definers = walkSources(SOURCE_ROOTS)
      .filter((full) => /export function resolveConversationResolution\(/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(definers).toEqual([RESOLUTION_CORE]);
  });

  it("R35 DOES NOT BREAK R32 — R32's write primitive and context reader are STILL each named by exactly one module, and SEND STILL recovers once", () => {
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

  it("R35 DOES NOT BREAK R32 — resolveRecovery is STILL defined only in the R32 recovery core", () => {
    const RECOVERY_CORE = "lib/receptionist/conversation-recovery.ts";
    const definers = walkSources(SOURCE_ROOTS)
      .filter((full) => /export function resolveRecovery\(/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(definers).toEqual([RECOVERY_CORE]);
  });

  it("R35 DOES NOT BREAK R31 — R31's write primitive is STILL named by exactly one module, and SEND STILL verifies once", () => {
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

  it("R35 DOES NOT BREAK R30 — R30's write primitive is STILL named by exactly one module, and SEND STILL fulfils once", () => {
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

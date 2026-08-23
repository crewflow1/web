import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONVERSATION WORK REASSIGNMENT governance invariants
 * (the AI Receptionist Programme, R52 — CONVERSATION WORK REASSIGNMENT).
 *
 * R46 gave a human operator the FIRST write in this stack: the CLAIM — taking OWNERSHIP of a coordinated Conversation
 * Worklist item. R50 gave that door its other side — the RELEASE, an owner returning the item to the unclaimed pool.
 * R51 made the Ownership State Engine the single authority over ownership STATE folded from those two ledgers.
 * Ownership, until now, moved in only two directions: an operator could TAKE an item (R46) or PUT IT BACK (R50), but
 * never HAND IT TO ANOTHER OPERATOR. R52 is that third door — the FIRST governed TRANSFER: the ONLY authorised
 * mechanism for transferring ownership of a Conversation Work item BETWEEN operators, recording the previous owner, the
 * new owner and a timestamp into a dedicated append-only ledger, so the complete ownership history (claimed by A, THEN
 * reassigned to B, THEN to C) survives in full. Its law is exact — "the reassignment records the previous owner, the
 * new owner and a timestamp; it preserves an append-only audit; the Reassignment runtime is authoritative; the Claim,
 * Release and Ownership State engines all remain authoritative; organisation isolation is preserved; and it introduces
 * NO execution path — it does not automatically assign, dispatch, notify, schedule, fulfil, promote, complete or close."
 * This suite proves that contract as a matter of SOURCE, not discipline — the house bar of the R30→R51 invariant suites,
 * mapped to the CEO's seven required demonstrations:
 *
 *   • REASSIGNMENT RUNTIME AUTHORITATIVE / SINGLE WRITE PATH — across all non-test source (app/, server/, lib/), the
 *     reassignment ledger's write primitive (`record_receptionist_conversation_claim_reassignment`) is named by EXACTLY
 *     ONE module: the reassignment server runtime; the runtime entry point `reassignConversationWork` is DEFINED in
 *     exactly that one module; and the pure resolver `resolveReassignment` is DEFINED in exactly the one pure core. No
 *     app/ route, action or component records a reassignment, so there is no second path and no bypass.
 *   • THE PURE CORE IS PURE, MINIMALLY-IMPORTED & MODEL-FREE — it imports ONLY the claim core's operator identity type
 *     (a reassignment reuses WHO a claim recorded, for BOTH operators), reaches no server / IO / model / clock / RNG,
 *     and names no ledger primitive. It DERIVES a decision; it persists nothing and records nothing.
 *   • THE CLAIM RUNTIME REMAINS AUTHORITATIVE — reassignment CONSUMES the ownership fact, it never re-derives it.
 *     Neither the reassignment core nor the reassignment runtime records or resolves a CLAIM;
 *     `record_receptionist_conversation_claim` is still named by exactly the R46 runtime. The writer's OWNERSHIP gate
 *     READS the R46 claim ledger to resolve the current owner and refuses a transfer the source operator does not hold;
 *     it NEVER mutates that ledger (the append-only claim audit is preserved).
 *   • THE RELEASE RUNTIME REMAINS AUTHORITATIVE — reassignment records no release, and the R50 release writer stays the
 *     SOLE authority over recording a release. This migration create-or-REPLACES that one writer to HARDEN its ownership
 *     gate (it now resolves the CURRENT, possibly-reassigned owner from the reassignment ledger, so only that operator
 *     may release) — no second release path, no signature change; for a never-reassigned item it behaves exactly as R50.
 *   • THE OWNERSHIP STATE ENGINE REMAINS AUTHORITATIVE — a reassignment adds NO STATE to the R51 lifecycle (a reassigned
 *     item is still `claimed`), so the STATE fold is unchanged (claims + releases). Since R53 the R51 engine ALSO folds
 *     the reassignments ledger to resolve the CURRENT OWNER, and it is the SOLE TS seam that reads that ledger. The R52
 *     reassignment files themselves re-implement NO ownership derivation and name no state-engine function.
 *   • ORGANISATION ISOLATION IS PRESERVED — the core DEMANDS an organisation on every request (its first gate), the
 *     ledger's `org_id` is NOT NULL, the writer's coordination guard is org-scoped (`c.org_id = p_org_id`) AND its
 *     ownership gate is org-scoped (`claims … and org_id = p_org_id`): a cross-tenant transfer names no coordination in
 *     the reassigning org and is refused at the storage layer.
 *   • INVALID TRANSFERS ARE PREVENTED — `request_id` is UNIQUE and the writer inserts ON CONFLICT (request_id) DO
 *     NOTHING (idempotent); `coordination_id` is DELIBERATELY NOT UNIQUE (a chain A→B→C is allowed); a CHECK and the
 *     core's own gate forbid a self-transfer (from = to); and before it writes, the writer resolves the CURRENT owner
 *     and REFUSES (NULL, no row) when there is no claim, the item is released, or the source is not the current owner.
 *     You can only reassign what you hold.
 *   • THE AUDIT IS APPEND-ONLY — RLS-enabled with NO policies, UPDATE/DELETE rejected by triggers even for service_role,
 *     a SECURITY DEFINER writer granted only to service_role, `status` CHECK-pinned to 'reassigned', and a CHECK that
 *     pins (reassignment_type, reassignment_outcome) to the EXACT deterministic fold — so a transfer can never be
 *     silently rewritten or erased and the previous owner, new owner and timestamp survive in full.
 *   • NO EXECUTION PATH IS INTRODUCED — neither the core nor the runtime names any other engine writer, any engine
 *     execution function, any tenant-table write, or any R52 non-goal token (automatic assign / automate / dispatch /
 *     notify / schedule / fulfil / promote / enqueue / retry / complete / close). The runtime SWALLOWS a failed write
 *     (returns a result, never throws) and orchestrates no re-attempt (the ownership gate is NOT retry).
 *
 * The engine's runtime behaviour is pinned against real Postgres in
 * __tests__/integration/receptionist/reassignment-pipeline.test.ts, and the pure core's resolution exhaustively in
 * __tests__/receptionist/conversation-reassignment.test.ts. This tier is HERMETIC — a filesystem scan over
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

/**
 * The body of ONE `create or replace function public.<fnName>(` … `$$;` in a (comment-stripped) migration. R52's
 * migration co-locates TWO writers — the reassignment writer AND the create-or-replaced R50 release writer — so
 * writer-SPECIFIC assertions (e.g. "the reassignment writer never inserts into the releases ledger") must be scoped to
 * the right function body, or the sibling writer's legitimate statements would satisfy/trip them.
 */
function fnBody(sql: string, fnName: string): string {
  const start = sql.indexOf(`create or replace function public.${fnName}(`);
  if (start < 0) return "";
  const end = sql.indexOf("$$;", start);
  return end < 0 ? sql.slice(start) : sql.slice(start, end + 3);
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

/** Every `.from("table")` target a source names — the tables it reads directly. */
function fromTargets(code: string): string[] {
  const targets: string[] = [];
  const re = /\.from\(\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m[1]) targets.push(m[1]);
  }
  return targets;
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

const CORE = "lib/receptionist/conversation-reassignment.ts";
const RUNTIME = "server/services/receptionist-reassignment.ts";
const MIGRATION =
  "supabase/migrations/20260909000000_receptionist_conversation_claim_reassignments.sql";

// The R46 claim spine the reassignment DEFERS to — it stays authoritative; the reassignment files name none of its writers.
const CLAIM_CORE = "lib/receptionist/conversation-claim.ts";
const CLAIM_RUNTIME = "server/services/receptionist-claim.ts";
const CLAIM_MIGRATION = "supabase/migrations/20260907000000_receptionist_conversation_claims.sql";
// The R50 release spine — its ONE writer this migration UPGRADES in place (create-or-replace); it stays authoritative.
const RELEASE_CORE = "lib/receptionist/conversation-release.ts";
const RELEASE_RUNTIME = "server/services/receptionist-release.ts";
const RELEASE_MIGRATION =
  "supabase/migrations/20260908000000_receptionist_conversation_claim_releases.sql";
// The R48 Ownership Read Model spine — still ships; since R51 it reads NO ledger (it consumes the state engine).
const OWNERSHIP_CORE = "lib/receptionist/conversation-ownership-read-model.ts";
const OWNERSHIP_READER = "server/services/receptionist-ownership-read-model.ts";
// The R51 Ownership State Engine — still the single authority over ownership STATE; a reassignment adds NONE.
const OWNERSHIP_STATE_CORE = "lib/receptionist/conversation-ownership-state.ts";
const OWNERSHIP_STATE_RUNTIME = "server/services/receptionist-ownership-state.ts";

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

/** The reassignment ledger's write primitive — the function an auditor would call to file a reassignment. */
const REASSIGNMENT_WRITE_FN = /\brecord_receptionist_conversation_claim_reassignment\b/;

/** The R50 release ledger's write primitive — must remain named by exactly the release runtime (never a reassignment file). */
const RELEASE_WRITE_FN = /\brecord_receptionist_conversation_claim_release\b/;

/** The R46 claim ledger's write primitive — must remain named by exactly the claim runtime (never a reassignment file). */
const CLAIM_WRITE_FN = /\brecord_receptionist_conversation_claim\b/;

/** The runtime entry point — the ONE governed mechanism that records an operator-to-operator transfer. */
const REASSIGNMENT_ENTRY = /export async function reassignConversationWork\(/;

/** The pure resolver — the single source of truth for what a well-formed reassignment looks like. */
const RESOLVE_REASSIGNMENT_ENTRY = /export function resolveReassignment\(/;

/** The R50 release entry point + resolver — a reassignment file records/decides neither. */
const RELEASE_ENTRY = /\breleaseConversationWork\b/;
const RESOLVE_RELEASE_ENTRY = /\bresolveRelease\b/;

/** The R46 claim entry point + resolver — a reassignment file records/decides neither. */
const CLAIM_ENTRY = /\bclaimConversationWork\b/;
const RESOLVE_CLAIM_ENTRY = /\bresolveClaim\b/;

/** The R51 Ownership State engine functions — a reassignment file re-implements none of them. */
const STATE_ENGINE_FNS =
  /\b(?:projectOwnershipState|reconcileOwnershipStates|deriveOwnershipState|getCoordinationOwnershipState|listCoordinationOwnershipStates)\b/;

/** The R48 ownership-derivation surface — a reassignment file re-implements none of it. */
const OWNERSHIP_DERIVATION =
  /\b(?:projectOwnership|projectOwnershipEvent|selectActiveClaims|summariseOwnership|orderOwnershipEvents|getOwnership|getOwnershipHistory|getOwnershipSummary)\b/;

/** The R36 coordinations base table — the authority the writer guards a reassignment against. */
const COORDINATIONS_TABLE = /\breceptionist_conversation_coordinations\b/;

/** The R46 claims ledger table — the writer reads it (the ownership gate); the reassignment core/runtime name it not. */
const CLAIMS_TABLE = /\breceptionist_conversation_claims\b/;

/** The R50 releases ledger table — the writer reads it (the released-item gate); the state engine folds it. */
const RELEASES_TABLE = /\breceptionist_conversation_claim_releases\b/;

/** The R52 reassignments ledger table — since R53 folded by exactly the R51 ownership state runtime (current-owner). */
const REASSIGNMENTS_TABLE = /\breceptionist_conversation_claim_reassignments\b/;

/** Every engine EXECUTION function (deriving/performing runtimes + resolvers) — a reassignment names none of them. */
const ENGINE_EXECUTION_FNS =
  /\b(?:fulfilApprovedBooking|verifyApprovedFulfilment|recoverVerifiedFulfilment|resolveConversationCompletion|governConversationLifecycle|orchestrateConversationLifecycle|coordinateConversationLifecycle|resolveConversationCoordination|resolveFulfilment|resolveVerification|resolveRecovery|resolveResolution|resolveLifecycle|resolveOrchestration|resolveCoordination)\b/;

/**
 * The R52 explicit non-goals as SOURCE tokens — a reassignment records a HANDING-ON of ownership; it acts on nothing and
 * moves work to no queue. `reassign` is DELIBERATELY ABSENT: it is R52's CAPABILITY, not a non-goal. `release` is absent
 * too — it is a SIBLING capability (R50), asserted separately, not an R52 non-goal. `assign` (automatic assignment) and
 * `automat` (automatically assign work) ARE non-goals and PRESENT: crucially `\bassign\w*` never matches "reassign"
 * (there is no word boundary between "re" and "assign"), so R52's own capability tokens can never trip it. `email` is
 * absent — the ledger records the operators' attribution `*_operator_email`, not the email CHANNEL (asserted separately).
 */
const NON_GOAL_TOKENS = [
  /\bassign\w*/i, // automatic assignment (NEVER matches "reassign")
  /\bautomat\w*/i, // automatically assign work
  /\bdispatch\w*/i, // work dispatch
  /\bnotif\w*/i, // user notification
  /\bschedul\w*/i, // scheduling
  /\bfulfil\w*/i, // quote fulfilment
  /\bpromot\w*/i, // customer promotion
  /\benqueue\w*/i,
  /\bretr(?:y|ies)\b/i,
  /\bcomplet\w*/i, // work completion
  /\bclos(?:e|ing|ed|ure)\b/i, // conversation closing
] as const;

// =====================================================================
// 0. The core, the ledger and the runtime all ship, with their single entry points.
// =====================================================================

describe("receptionist reassignment — the capability ships", () => {
  it(`ships the append-only reassignment ledger migration ${MIGRATION}`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION)), MIGRATION).toBe(true);
  });

  it(`ships the pure core ${CORE}`, () => {
    expect(existsSync(resolve(ROOT, CORE)), CORE).toBe(true);
  });

  it(`ships the server runtime ${RUNTIME}`, () => {
    expect(existsSync(resolve(ROOT, RUNTIME)), RUNTIME).toBe(true);
  });

  it("the pure core exports the single resolver and its decided predicate", () => {
    const code = codeOf(read(CORE));
    expect(code).toMatch(RESOLVE_REASSIGNMENT_ENTRY);
    expect(code).toMatch(/export function isReassignmentDecided\(/);
  });

  it("the server runtime exports the single reassignment entry point", () => {
    expect(codeOf(read(RUNTIME))).toMatch(REASSIGNMENT_ENTRY);
  });
});

// =====================================================================
// 1. REASSIGNMENT RUNTIME AUTHORITATIVE / SINGLE WRITE PATH — exactly one module writes the ledger; the resolver and
//    entry point are each defined once.
// =====================================================================

describe("receptionist reassignment — exactly one module records a reassignment (the reassignment runtime is authoritative)", () => {
  const writers = walkSources(SOURCE_ROOTS)
    .filter((full) => REASSIGNMENT_WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();
  const entryDefiners = walkSources(SOURCE_ROOTS)
    .filter((full) => REASSIGNMENT_ENTRY.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();
  const resolverDefiners = walkSources(SOURCE_ROOTS)
    .filter((full) => RESOLVE_REASSIGNMENT_ENTRY.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the ONLY module that names the reassignment write primitive is the reassignment server runtime", () => {
    // If this list ever grows, a second reassignment-write path (or a bypass) has appeared. The migration co-locates the
    // upgraded R50 release writer, but migrations are not under app/server/lib, so only the runtime is scanned here.
    expect(writers).toEqual([RUNTIME]);
  });

  it("the runtime entry point reassignConversationWork is DEFINED in exactly one module — the runtime", () => {
    expect(entryDefiners).toEqual([RUNTIME]);
  });

  it("the resolver resolveReassignment is DEFINED in exactly one module — the pure core", () => {
    // No feature implements independent reassignment-shaping logic: the single source of truth is exported once.
    expect(resolverDefiners).toEqual([CORE]);
  });

  it("no app/ route, action, or component records a reassignment directly", () => {
    expect(writers.filter((p) => p.startsWith("app/"))).toEqual([]);
  });

  it("no other server/ module records a reassignment directly", () => {
    expect(writers.filter((p) => p !== RUNTIME && p.startsWith("server/"))).toEqual([]);
  });
});

// =====================================================================
// 2. The pure core is PURE, MINIMALLY-IMPORTED and MODEL-FREE — it DERIVES, it persists and records nothing.
// =====================================================================

describe("receptionist reassignment — the pure core is pure, minimally-imported and model-free", () => {
  const pcode = codeOf(read(CORE));

  it("imports ONLY the claim core's operator identity — a reassignment reuses WHO a claim recorded, for both operators", () => {
    expect(importSpecifiers(pcode)).toEqual(["./conversation-claim"]);
  });

  it("is a shared pure module (NOT server-only — the runtime and tests import it)", () => {
    expect(importSpecifiers(pcode)).not.toContain("server-only");
  });

  it("touches no I/O and calls no model — it derives, it does not generate, persist or record", () => {
    expect(pcode).not.toMatch(/createAdminClient/);
    expect(pcode).not.toMatch(/supabase/i);
    expect(pcode).not.toMatch(/\bfetch\(/);
    expect(pcode).not.toMatch(/@\/lib\/ai\//);
    expect(pcode).not.toMatch(/Anthropic/);
    expect(pcode).not.toMatch(/process\.env/);
  });

  it("has no clock and no RNG (a decision is reconstructable)", () => {
    expect(pcode).not.toMatch(/Math\.random/);
    expect(pcode).not.toMatch(/Date\.now/);
    expect(pcode).not.toMatch(/new Date\(/);
  });

  it("names NO ledger primitive — the pure core reaches no writer (claim, release or reassignment)", () => {
    expect(pcode).not.toMatch(REASSIGNMENT_WRITE_FN);
    expect(pcode).not.toMatch(RELEASE_WRITE_FN);
    expect(pcode).not.toMatch(CLAIM_WRITE_FN);
    expect(pcode.match(/record_receptionist_conversation_\w+/g)).toBeNull();
  });

  it("the reassignment vocabulary is EXACTLY {reassign_conversation_work} ⇒ {work_reassigned}, resolutions closed", () => {
    expect(pcode).toMatch(/REASSIGNMENT_TYPES\s*=\s*\[\s*"reassign_conversation_work"\s*\]/);
    expect(pcode).toMatch(/ReassignmentOutcome\s*=\s*"work_reassigned"/);
    expect(pcode).toMatch(
      /REASSIGNMENT_RESOLUTIONS\s*=\s*\[\s*"reassigned",\s*"not_owned",\s*"unavailable"\s*\]/,
    );
  });
});

// =====================================================================
// 3. The CLAIM runtime remains AUTHORITATIVE — reassignment CONSUMES the ownership fact; it records + resolves NO claim,
//    and never mutates the claim ledger.
// =====================================================================

describe("receptionist reassignment — the Claim runtime remains authoritative", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));
  const sql = sqlCodeOf(read(MIGRATION));
  const reassignFn = fnBody(sql, "record_receptionist_conversation_claim_reassignment");

  const claimWriters = walkSources(SOURCE_ROOTS)
    .filter((full) => CLAIM_WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the R46 claim spine ships (the authority the reassignment defers to)", () => {
    expect(existsSync(resolve(ROOT, CLAIM_CORE)), CLAIM_CORE).toBe(true);
    expect(existsSync(resolve(ROOT, CLAIM_RUNTIME)), CLAIM_RUNTIME).toBe(true);
    expect(existsSync(resolve(ROOT, CLAIM_MIGRATION)), CLAIM_MIGRATION).toBe(true);
  });

  it("the claim write primitive is STILL named by exactly the claim runtime — no reassignment file records a claim", () => {
    // `record_receptionist_conversation_claim_reassignment` does NOT match `\brecord_receptionist_conversation_claim\b`
    // (the `_` after `claim` denies the word boundary), so the reassignment runtime is provably absent from this list.
    expect(claimWriters).toEqual([CLAIM_RUNTIME]);
    expect(rcode).not.toMatch(CLAIM_WRITE_FN);
    expect(pcode).not.toMatch(CLAIM_WRITE_FN);
  });

  it("neither reassignment file records or re-resolves a CLAIM — it consumes the ownership fact, never re-derives it", () => {
    for (const code of [pcode, rcode]) {
      expect(code).not.toMatch(CLAIM_ENTRY); // does not record a claim
      expect(code).not.toMatch(RESOLVE_CLAIM_ENTRY); // does not re-decide a claim
    }
  });

  it("the core derives NO coordination and NO claim — it validates the request's shape and stops", () => {
    expect(pcode).not.toMatch(ENGINE_EXECUTION_FNS);
    expect(pcode).not.toMatch(COORDINATIONS_TABLE);
    expect(pcode).not.toMatch(CLAIMS_TABLE);
  });

  it("the runtime SELECTs no ledger itself — it defers the ownership guard to the writer", () => {
    // No `.from(...)` at all: the runtime never reads the claim ledger; the SECURITY DEFINER writer does.
    expect(rcode).not.toMatch(/\.from\(/);
    expect(rcode).not.toMatch(CLAIMS_TABLE);
    expect(rcode).not.toMatch(COORDINATIONS_TABLE);
  });

  it("the writer's OWNERSHIP gate reads the R46 claim ledger and REFUSES a transfer the source operator does not hold", () => {
    // "You can only reassign what you hold": resolve the coordination's active claim, resolve the CURRENT owner, then
    // refuse (NULL, no write) when there is no claim, or when the current owner is a DIFFERENT operator than the source.
    expect(reassignFn).toMatch(
      /select id, operator_id into v_claim_id, v_claim_operator[\s\S]*?from public\.receptionist_conversation_claims\b/i,
    );
    expect(reassignFn).toMatch(/v_claim_id is null/i);
    expect(reassignFn).toMatch(/v_current_owner is distinct from p_from_operator_id/i);
    expect(reassignFn).toMatch(/return null/i);
  });

  it("the reassignment writer NEVER mutates the claim ledger — it only reads it (append-only claim audit preserved)", () => {
    expect(reassignFn).not.toMatch(/update public\.receptionist_conversation_claims\b/i);
    expect(reassignFn).not.toMatch(/delete from public\.receptionist_conversation_claims\b/i);
    expect(reassignFn).not.toMatch(/insert into public\.receptionist_conversation_claims\b/i);
  });
});

// =====================================================================
// 4. The RELEASE runtime remains AUTHORITATIVE — reassignment records no release; the ONE release writer is
//    create-or-REPLACED to HARDEN its ownership gate (respect transfers), with no second release path.
// =====================================================================

describe("receptionist reassignment — the Release runtime remains authoritative", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));
  const sql = sqlCodeOf(read(MIGRATION));
  const reassignFn = fnBody(sql, "record_receptionist_conversation_claim_reassignment");
  const releaseFn = fnBody(sql, "record_receptionist_conversation_claim_release");

  const releaseWriters = walkSources(SOURCE_ROOTS)
    .filter((full) => RELEASE_WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the R50 release spine ships (the authority whose ownership gate this migration hardens)", () => {
    expect(existsSync(resolve(ROOT, RELEASE_CORE)), RELEASE_CORE).toBe(true);
    expect(existsSync(resolve(ROOT, RELEASE_RUNTIME)), RELEASE_RUNTIME).toBe(true);
    expect(existsSync(resolve(ROOT, RELEASE_MIGRATION)), RELEASE_MIGRATION).toBe(true);
  });

  it("the release write primitive is STILL named by exactly the release runtime — no reassignment file records a release", () => {
    // `record_receptionist_conversation_claim_reassignment` does NOT match `\brecord_receptionist_conversation_claim_release\b`,
    // so the reassignment runtime is provably absent from this list; the migration is not scanned (not under the roots).
    expect(releaseWriters).toEqual([RELEASE_RUNTIME]);
    for (const code of [pcode, rcode]) {
      expect(code).not.toMatch(RELEASE_WRITE_FN);
      expect(code).not.toMatch(RELEASE_ENTRY); // does not record a release
      expect(code).not.toMatch(RESOLVE_RELEASE_ENTRY); // does not re-decide a release
    }
  });

  it("the reassignment writer NEVER inserts into the releases ledger — it only READS it (the released-item gate)", () => {
    // The co-located, upgraded release writer legitimately inserts into the releases ledger; the reassignment writer,
    // scoped by fnBody, only SELECTs it to refuse a released item — it writes ONLY the reassignment ledger.
    expect(reassignFn).not.toMatch(/insert into public\.receptionist_conversation_claim_releases\b/i);
    expect(reassignFn).toMatch(/from public\.receptionist_conversation_claim_releases\b/i);
    expect(reassignFn).toMatch(/insert into public\.receptionist_conversation_claim_reassignments\b/i);
  });

  it("the ONE release writer is create-or-REPLACED to HARDEN its ownership gate — it now resolves the CURRENT owner", () => {
    // A pure hardening of the SAME single writer: it still inserts into the releases ledger ON CONFLICT (coordination_id)
    // DO NOTHING (no second release path), but its ownership gate now resolves the latest reassignment's new owner (or
    // the claimant when never reassigned) and lets ONLY that operator release — the R52 ownership-transfer contract.
    expect(releaseFn).toMatch(
      /create or replace function public\.record_receptionist_conversation_claim_release\(/i,
    );
    expect(releaseFn).toMatch(
      /select to_operator_id into v_current_owner[\s\S]*?from public\.receptionist_conversation_claim_reassignments\b/i,
    );
    expect(releaseFn).toMatch(/v_current_owner\s*:=\s*coalesce\(v_current_owner, v_claim_operator\)/i);
    expect(releaseFn).toMatch(/v_current_owner is distinct from p_operator_id/i);
    expect(releaseFn).toMatch(/insert into public\.receptionist_conversation_claim_releases\b/i);
    expect(releaseFn).toMatch(/on conflict \(coordination_id\) do nothing/i);
  });
});

// =====================================================================
// 5. The OWNERSHIP STATE ENGINE remains AUTHORITATIVE — a reassignment adds NO STATE (a reassigned item is still
//    `claimed`); since R53 the engine ALSO folds the reassignments ledger to resolve the CURRENT OWNER, and it is the
//    SOLE TS seam that does.
// =====================================================================

describe("receptionist reassignment — the Ownership State engine remains authoritative", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  const reassignmentTableReaders = walkSources(SOURCE_ROOTS)
    .filter((full) =>
      fromTargets(codeOf(read(rel(full)))).includes(
        "receptionist_conversation_claim_reassignments",
      ),
    )
    .map(rel)
    .sort();

  it("the R51 ownership state engine spine ships (the single authority over ownership STATE)", () => {
    expect(existsSync(resolve(ROOT, OWNERSHIP_STATE_CORE)), OWNERSHIP_STATE_CORE).toBe(true);
    expect(existsSync(resolve(ROOT, OWNERSHIP_STATE_RUNTIME)), OWNERSHIP_STATE_RUNTIME).toBe(true);
    expect(existsSync(resolve(ROOT, OWNERSHIP_CORE)), OWNERSHIP_CORE).toBe(true);
    expect(existsSync(resolve(ROOT, OWNERSHIP_READER)), OWNERSHIP_READER).toBe(true);
  });

  it("the R51 engine STATE fold stays claims+releases, and since R53 it ALSO names the reassignments ledger (current owner)", () => {
    // A reassignment adds NO STATE to the R51 lifecycle (a reassigned item is still `claimed`), so the STATE fold reads
    // the same claims + releases ledgers as at R51. Since R53 the engine ALSO reads the reassignments ledger to resolve
    // the CURRENT OWNER of a held item — so the state runtime now names all THREE ledgers.
    const stateRuntime = codeOf(read(OWNERSHIP_STATE_RUNTIME));
    expect(stateRuntime).toMatch(CLAIMS_TABLE);
    expect(stateRuntime).toMatch(RELEASES_TABLE);
    expect(stateRuntime).toMatch(REASSIGNMENTS_TABLE);
    expect(stateRuntime).toMatch(/reconcileOwnershipStates/);
  });

  it("since R53 EXACTLY ONE TS seam folds the reassignments ledger — the R51 ownership state runtime", () => {
    // R53 closed the former claim-centric gap: the state engine now folds the transfer chain to resolve the current
    // owner, and every consumer reads ownership THROUGH it. Pinned here in source: the state runtime is the SOLE reader.
    expect(reassignmentTableReaders).toEqual([OWNERSHIP_STATE_RUNTIME]);
  });

  it("neither reassignment file re-implements ownership derivation — it names no state-engine function or fold", () => {
    for (const code of [pcode, rcode]) {
      expect(code).not.toMatch(STATE_ENGINE_FNS);
      expect(code).not.toMatch(OWNERSHIP_DERIVATION);
    }
  });

  it("the runtime reads NO ownership — it imports no read model / state engine and issues no `.from(...)`", () => {
    expect(rcode).not.toMatch(/\.from\(/);
    const specs = importSpecifiers(rcode);
    expect(specs).not.toContain("@/server/services/receptionist-ownership-read-model");
    expect(specs).not.toContain("@/server/services/receptionist-ownership-state");
    expect(specs).not.toContain("@/lib/receptionist/conversation-ownership-read-model");
    expect(specs).not.toContain("@/lib/receptionist/conversation-ownership-state");
  });
});

// =====================================================================
// 6. ORGANISATION ISOLATION — the core demands an org, the ledger requires one, both storage guards are org-scoped.
// =====================================================================

describe("receptionist reassignment — organisation isolation is preserved", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));
  const sql = sqlCodeOf(read(MIGRATION));
  const reassignFn = fnBody(sql, "record_receptionist_conversation_claim_reassignment");

  it("the core's FIRST gate demands an organisation — a request without one names no reassignment", () => {
    expect(pcode).toMatch(
      /if \(!isNonEmpty\(request\.org_id\)\) return abstain\("missing_organisation"\)/,
    );
  });

  it("the runtime scopes the write by the org from the DECISION (never from client input)", () => {
    expect(rcode).toMatch(/p_org_id:\s*decision\.org_id/);
  });

  it("the ledger's org_id is NOT NULL — a reassignment is ALWAYS org-scoped", () => {
    expect(sql).toMatch(/org_id\s+uuid\s+not null/i);
  });

  it("the writer's coordination guard is ORG-SCOPED — the cross-tenant transfer is refused structurally", () => {
    expect(reassignFn).toMatch(/from public\.receptionist_conversation_coordinations c/i);
    expect(reassignFn).toMatch(/c\.id\s*=\s*p_coordination_id/i);
    expect(reassignFn).toMatch(/c\.org_id\s*=\s*p_org_id/i);
    expect(reassignFn).toMatch(/names no coordination in this organisation/i);
  });

  it("the writer's OWNERSHIP gate is ALSO org-scoped — the claim is resolved within the reassigning org only", () => {
    expect(reassignFn).toMatch(
      /from public\.receptionist_conversation_claims[\s\S]*?where coordination_id = p_coordination_id[\s\S]*?and org_id = p_org_id/i,
    );
  });
});

// =====================================================================
// 7. INVALID TRANSFERS ARE PREVENTED — UNIQUE request_id + ON CONFLICT DO NOTHING; a NON-UNIQUE coordination (chains
//    allowed); a distinct-operators CHECK; and an ownership gate that refuses non-owners.
// =====================================================================

describe("receptionist reassignment — invalid transfers are prevented by construction", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));
  const sql = sqlCodeOf(read(MIGRATION));
  const reassignFn = fnBody(sql, "record_receptionist_conversation_claim_reassignment");

  it("request_id is UNIQUE — the idempotency conflict key (a retried transfer records at most once)", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_claim_reassignments_request_unique unique \(request_id\)/i,
    );
  });

  it("the writer inserts ON CONFLICT (request_id) DO NOTHING (a replay of the same request is idempotent)", () => {
    expect(reassignFn).toMatch(/on conflict \(request_id\) do nothing/i);
  });

  it("coordination_id is DELIBERATELY NOT UNIQUE — a chain of transfers A→B→C is allowed (history preserved)", () => {
    // No `unique (coordination_id)` anywhere in this migration: a coordinated item can be reassigned repeatedly, each a
    // first-class append-only row. (The release writer's `on conflict (coordination_id)` is a CONFLICT clause, not a
    // UNIQUE constraint declared here.)
    expect(sql).not.toMatch(/unique\s*\(\s*coordination_id\s*\)/i);
  });

  it("a self-transfer is forbidden — a distinct-operators CHECK AND the core's own gate (from must differ from to)", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_claim_reassignments_distinct_operators check \(\s*from_operator_id <> to_operator_id\s*\)/i,
    );
    expect(pcode).toMatch(
      /if \(request\.from_operator\.id === request\.to_operator\.id\) return abstain\("same_operator"\)/,
    );
  });

  it("no claim ⇒ refused; released item ⇒ refused; DIFFERENT current owner ⇒ refused (NULL, no write)", () => {
    expect(reassignFn).toMatch(/v_claim_id is null/i);
    expect(reassignFn).toMatch(/from public\.receptionist_conversation_claim_releases\b/i);
    expect(reassignFn).toMatch(/v_current_owner is distinct from p_from_operator_id/i);
    expect(reassignFn).toMatch(/return null/i);
  });

  it("the runtime maps the refusal to not_owned and a recorded transfer to reassigned", () => {
    expect(rcode).toMatch(
      /if \(!isReassignmentDecided\(decision\)\) return \{ resolution: "unavailable" \}/,
    );
    expect(rcode).toMatch(/if \(!data\) return \{ resolution: "not_owned" \}/);
    expect(rcode).toMatch(/resolution: "reassigned"/);
  });
});

// =====================================================================
// 8. The PREVIOUS OWNER, the NEW OWNER, a TIMESTAMP and the REASSIGNMENT EVENT are recorded — the ledger row IS the
//    event.
// =====================================================================

describe("receptionist reassignment — records the previous owner, the new owner, a timestamp and the event", () => {
  const rcode = codeOf(read(RUNTIME));
  const sql = sqlCodeOf(read(MIGRATION));
  const reassignFn = fnBody(sql, "record_receptionist_conversation_claim_reassignment");

  it("the ledger records the PREVIOUS owner — from_operator_id NOT NULL plus a denormalised from_operator_email", () => {
    expect(sql).toMatch(/from_operator_id\s+uuid\s+not null/i);
    expect(sql).toMatch(/from_operator_email\s+text/i);
  });

  it("the ledger records the NEW owner — to_operator_id NOT NULL plus a denormalised to_operator_email", () => {
    expect(sql).toMatch(/to_operator_id\s+uuid\s+not null/i);
    expect(sql).toMatch(/to_operator_email\s+text/i);
  });

  it("the ledger records WHEN — reassigned_at defaults to now()", () => {
    expect(sql).toMatch(/reassigned_at\s+timestamptz\s+not null\s+default\s+now\(\)/i);
  });

  it("the ledger threads the TRANSFERRED claim — claim_id NOT NULL (a complete ownership audit)", () => {
    expect(sql).toMatch(/claim_id\s+uuid\s+not null/i);
  });

  it("the runtime threads BOTH operators' id and email into the write", () => {
    expect(rcode).toMatch(/p_from_operator_id:\s*decision\.from_operator\.id/);
    expect(rcode).toMatch(/p_to_operator_id:\s*decision\.to_operator\.id/);
    expect(rcode).toMatch(/p_from_operator_email:\s*decision\.from_operator\.email/);
    expect(rcode).toMatch(/p_to_operator_email:\s*decision\.to_operator\.email/);
  });

  it("the writer REQUIRES the org, coordination and BOTH operators — a transfer always records who let it go and who got it", () => {
    expect(reassignFn).toMatch(
      /p_org_id is null or p_coordination_id is null or p_from_operator_id is null or p_to_operator_id is null/i,
    );
  });
});

// =====================================================================
// 9. The AUDIT is APPEND-ONLY, service-role-only and DETERMINISTIC — a reassignment can never be rewritten or erased.
// =====================================================================

describe("receptionist reassignment — the ledger is append-only, service-role-only and deterministic", () => {
  const sql = sqlCodeOf(read(MIGRATION));
  const reassignFn = fnBody(sql, "record_receptionist_conversation_claim_reassignment");

  it("creates the receptionist_conversation_claim_reassignments table", () => {
    expect(sql).toMatch(
      /create table if not exists public\.receptionist_conversation_claim_reassignments/i,
    );
  });

  it("captures the anchors, the claim, both operators, the operation, the status and the timestamps", () => {
    for (const column of [
      "org_id",
      "coordination_id",
      "claim_id",
      "request_id",
      "conversation_id",
      "correlation_id",
      "from_operator_id",
      "from_operator_email",
      "to_operator_id",
      "to_operator_email",
      "reassignment_type",
      "reassignment_outcome",
      "status",
      "metadata",
      "reassigned_at",
      "created_at",
    ]) {
      expect(sql, `column ${column}`).toMatch(new RegExp(`\\b${column}\\b`));
    }
  });

  it("bounds the reassignment type and outcome to their vocabularies {reassign_conversation_work} / {work_reassigned}", () => {
    expect(sql).toMatch(
      /check\s*\(\s*reassignment_type\s+in\s*\(\s*'reassign_conversation_work'\s*\)\s*\)/i,
    );
    expect(sql).toMatch(
      /check\s*\(\s*reassignment_outcome\s+in\s*\(\s*'work_reassigned'\s*\)\s*\)/i,
    );
  });

  it("HELD BY CONSTRUCTION — status is CHECK-pinned to the single value 'reassigned'", () => {
    expect(sql).toMatch(/status\s+text\s+not null\s+default\s+'reassigned'/i);
    expect(sql).toMatch(/check\s*\(\s*status\s*=\s*'reassigned'\s*\)/i);
  });

  it("DETERMINISTIC BY CONSTRUCTION — a CHECK pins (reassignment_type, reassignment_outcome) to the exact fold", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_claim_reassignments_outcome_fold check/i,
    );
    expect(sql).toMatch(
      /reassignment_type = 'reassign_conversation_work' and reassignment_outcome = 'work_reassigned'/i,
    );
  });

  it("DISTINCT OPERATORS BY CONSTRUCTION — a CHECK forbids a self-transfer (from_operator_id <> to_operator_id)", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_claim_reassignments_distinct_operators check/i,
    );
  });

  it("enables RLS with NO policies — service-role / SECURITY DEFINER only", () => {
    expect(sql).toMatch(
      /alter table public\.receptionist_conversation_claim_reassignments enable row level security/i,
    );
    expect(sql).not.toMatch(
      /create policy[\s\S]*?on public\.receptionist_conversation_claim_reassignments/i,
    );
  });

  it("is APPEND-ONLY — UPDATE and DELETE are rejected by triggers (the audit can never be rewritten or erased)", () => {
    expect(sql).toMatch(
      /create or replace function public\.receptionist_conversation_claim_reassignments_block_mutation\(/i,
    );
    expect(sql).toMatch(/raise exception[\s\S]*?append-only[\s\S]*?tg_op/i);
    expect(sql).toMatch(/errcode\s*=\s*'restrict_violation'/i);
    expect(sql).toMatch(
      /create trigger receptionist_conversation_claim_reassignments_no_update\s+before update on public\.receptionist_conversation_claim_reassignments/i,
    );
    expect(sql).toMatch(
      /create trigger receptionist_conversation_claim_reassignments_no_delete\s+before delete on public\.receptionist_conversation_claim_reassignments/i,
    );
  });

  it("writes only through a SECURITY DEFINER primitive granted only to service_role", () => {
    expect(sql).toMatch(
      /create or replace function public\.record_receptionist_conversation_claim_reassignment\(/i,
    );
    expect(sql).toMatch(/returns uuid/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = ''/i);
    expect(reassignFn).toMatch(
      /insert into public\.receptionist_conversation_claim_reassignments/i,
    );
    expect(sql).toMatch(
      /revoke all on function\s+public\.record_receptionist_conversation_claim_reassignment\([\s\S]*?\) from public, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /grant execute on function\s+public\.record_receptionist_conversation_claim_reassignment\([\s\S]*?\) to service_role/i,
    );
  });

  it("the write primitive re-validates the (type, outcome) fold (belt-and-braces with the table CHECK)", () => {
    expect(reassignFn).toMatch(/does not match the deterministic fold/i);
  });
});

// =====================================================================
// 10. NO EXECUTION PATH is introduced — the reassignment records a handing-on; it assigns nothing automatically,
//     dispatches, completes and closes nothing.
// =====================================================================

describe("receptionist reassignment — no execution path is introduced", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("neither the core nor the runtime names any OTHER engine writer — the only writer is the reassignment primitive", () => {
    // The runtime names EXACTLY one record_receptionist_conversation_* token — the reassignment writer; the core names none.
    expect([...new Set(rcode.match(/record_receptionist_conversation_\w+/g) ?? [])]).toEqual([
      "record_receptionist_conversation_claim_reassignment",
    ]);
    expect(pcode.match(/record_receptionist_conversation_\w+/g)).toBeNull();
    // Nor any non-conversation receptionist writer (review resolution, reply transport).
    for (const code of [pcode, rcode]) {
      expect(code).not.toMatch(/record_receptionist_review_resolution/);
      expect(code).not.toMatch(/record_ai_reply_/);
    }
  });

  it("neither the core nor the runtime calls any engine EXECUTION function", () => {
    expect(pcode).not.toMatch(ENGINE_EXECUTION_FNS);
    expect(rcode).not.toMatch(ENGINE_EXECUTION_FNS);
  });

  it("neither the core nor the runtime names an R52 non-goal token (assign/automate/dispatch/…/close)", () => {
    for (const token of NON_GOAL_TOKENS) {
      expect(pcode, `core must not name ${token}`).not.toMatch(token);
      expect(rcode, `runtime must not name ${token}`).not.toMatch(token);
    }
  });

  it("the runtime writes NO tenant row and reaches no transport / calendar / quote / channel / generation path", () => {
    // A reassignment touches NO tenant table (no `.from(...)`), and reaches no business-execution surface.
    expect(rcode).not.toMatch(/\.from\(/);
    expect(rcode).not.toMatch(/\bleads\b/);
    expect(rcode).not.toMatch(/customers/);
    expect(rcode).not.toMatch(/calendar/i);
    expect(rcode).not.toMatch(/\bquote\b/i);
    expect(rcode).not.toMatch(/transport/i);
    expect(rcode).not.toMatch(/\bvoice\b/i);
    expect(rcode).not.toMatch(/whatsapp/i);
    expect(rcode).not.toMatch(/generateConversationResponse/);
  });

  it("the runtime writes ONLY the one internal row — the reassignment ledger, through the write primitive", () => {
    expect(rcode).toMatch(REASSIGNMENT_WRITE_FN);
  });

  it("OWNERSHIP GUARDING, NOT RETRY — it names no re-attempt orchestration", () => {
    expect(rcode).not.toMatch(/setTimeout/);
    expect(rcode).not.toMatch(/setInterval/);
    expect(rcode).not.toMatch(/backoff/i);
  });

  it("SWALLOWS a failed write — it never THROWS (a reassignment attempt can never crash the surface)", () => {
    expect(rcode).not.toMatch(/\bthrow\b/);
    expect(rcode).toMatch(/console\.error/);
  });

  it("is server-only — it is the ONE place a reassignment is durably recorded", () => {
    expect(importSpecifiers(rcode)).toContain("server-only");
  });

  it("reaches no model — a reassignment is not a generation", () => {
    const specs = importSpecifiers(rcode);
    expect(specs.some((s) => s.startsWith("@/lib/ai/"))).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONVERSATION WORK RELEASE governance invariants
 * (the AI Receptionist Programme, R50 — CONVERSATION WORK RELEASE).
 *
 * R46 gave a human operator the FIRST write in this stack: the CLAIM — taking OWNERSHIP of a coordinated Conversation
 * Worklist item. R47 surfaced it, R48 established the canonical Ownership Read Model over the claim ledger, and R49
 * listed an operator their own claims. Ownership, until now, has been a ONE-WAY door. R50 is the door's other side: the
 * FIRST governed RELEASE — the ONLY authorised mechanism for an operator to RELINQUISH ownership of a Conversation Work
 * item, returning it to the unclaimed state. Its law is exact — "the release records the releasing operator, a
 * timestamp and a release event; it preserves an append-only audit; it returns the item to the unclaimed state; it
 * prevents invalid releases; the Claim runtime remains authoritative; the Ownership Read Model remains authoritative;
 * organisation isolation is preserved; and it introduces NO execution path — it does not reassign, assign, dispatch,
 * notify, schedule, fulfil, promote, complete or close." This suite proves that contract as a matter of SOURCE, not
 * discipline — the house bar of the R30→R49 invariant suites:
 *
 *   • RELEASE RUNTIME AUTHORITATIVE / SINGLE WRITE PATH — across all non-test source (app/, server/, lib/), the release
 *     ledger's write primitive (`record_receptionist_conversation_claim_release`) is named by EXACTLY ONE module: the
 *     release server runtime; the runtime entry point `releaseConversationWork` is DEFINED in exactly that one module;
 *     and the pure resolver `resolveRelease` is DEFINED in exactly the one pure core. No app/ route, action or component
 *     records a release, so there is no second path and no bypass.
 *   • THE PURE CORE IS PURE, MINIMALLY-IMPORTED & MODEL-FREE — it imports ONLY the claim core's operator identity type
 *     (a release reuses WHO a claim recorded), reaches no server / IO / model / clock / RNG, and names no ledger
 *     primitive. It DERIVES a decision; it persists nothing and records nothing.
 *   • THE CLAIM RUNTIME REMAINS AUTHORITATIVE — release CONSUMES the ownership fact, it never re-derives it. Neither the
 *     release core nor the release runtime records or resolves a CLAIM: `record_receptionist_conversation_claim` is
 *     still named by exactly the R46 runtime, `claimConversationWork` and `resolveClaim` are still each defined once
 *     (elsewhere), and the release files name neither. The writer's OWNERSHIP gate reads the R46 claim ledger — the
 *     single source of truth for who holds what — and refuses a release the operator does not own.
 *   • THE OWNERSHIP READ MODEL REMAINS AUTHORITATIVE — release records a fact; it re-implements NO ownership derivation.
 *     Neither release file names `projectOwnership` / `selectActiveClaims` / `summariseOwnership` / `getOwnership*`; the
 *     runtime reads NO ownership (no `.from(...)`, no read-model import). The release ledger is READ through exactly ONE
 *     seam — the R51 Ownership State engine (since R51 the R48 reader consumes the engine) — so "does this item read as
 *     unclaimed again?" is answered in the engine's derivation, nowhere else.
 *   • ORGANISATION ISOLATION IS PRESERVED — the core DEMANDS an organisation on every request (its first gate), the
 *     ledger's `org_id` is NOT NULL, the writer's coordination guard is org-scoped (`c.org_id = p_org_id`) AND its
 *     ownership gate is org-scoped (`claims … and org_id = p_org_id`): a cross-tenant release names no coordination in
 *     the releasing org and is refused at the storage layer.
 *   • INVALID RELEASES ARE PREVENTED — `coordination_id` is UNIQUE and the writer inserts ON CONFLICT DO NOTHING; before
 *     it writes, it resolves the coordination's active claim and REFUSES (writing nothing, returning NULL) when there is
 *     no claim, or when the claim is held by a DIFFERENT operator. You can only release what you hold. A repeat by the
 *     owner returns the existing id (idempotent).
 *   • THE RELEASING OPERATOR, A TIMESTAMP AND A RELEASE EVENT ARE RECORDED — the ledger row is the event: `operator_id`
 *     NOT NULL, a denormalised `operator_email`, and `released_at`. The runtime threads the authenticated operator's id
 *     + email straight into the write.
 *   • THE AUDIT IS APPEND-ONLY — RLS-enabled with NO policies, UPDATE/DELETE rejected by triggers even for service_role,
 *     a SECURITY DEFINER writer granted only to service_role, `status` CHECK-pinned to 'released', and a CHECK that pins
 *     (release_type, release_outcome) to the EXACT deterministic fold — so a release can never be silently rewritten or
 *     erased, the claim ledger it relinquishes is NEVER mutated, and ownership history (claimed THEN released) survives
 *     in full.
 *   • NO EXECUTION PATH IS INTRODUCED — neither the core nor the runtime names any other engine writer, any engine
 *     execution function, any tenant-table write, or any R50 non-goal token (reassign / assign / dispatch / notify /
 *     schedule / fulfil / promote / complete / close). The runtime SWALLOWS a failed write (returns a result, never
 *     throws) and orchestrates no re-attempt (the ownership gate is NOT retry).
 *
 * The engine's runtime behaviour is pinned against real Postgres in
 * __tests__/integration/receptionist/conversation-release-pipeline.test.ts, and the pure core's resolution exhaustively
 * in __tests__/receptionist/conversation-release.test.ts. This tier is HERMETIC — a filesystem scan over
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
        out.push(full);
      }
    }
  };
  for (const r of roots) visit(resolve(ROOT, r));
  return out;
}

/** A repo-relative, POSIX-style path for stable assertions across platforms. */
const rel = (full: string) => relative(ROOT, full).split(sep).join("/");

const CORE = "lib/receptionist/conversation-release.ts";
const RUNTIME = "server/services/receptionist-release.ts";
const MIGRATION =
  "supabase/migrations/20260908000000_receptionist_conversation_claim_releases.sql";

// The R46 claim spine the release DEFERS to — it stays authoritative; the release files name none of its writers.
const CLAIM_CORE = "lib/receptionist/conversation-claim.ts";
const CLAIM_RUNTIME = "server/services/receptionist-claim.ts";
const CLAIM_MIGRATION = "supabase/migrations/20260907000000_receptionist_conversation_claims.sql";
// The R48 Ownership Read Model spine — still ships, but since R51 it reads NO ledger: it consumes the state engine.
const OWNERSHIP_CORE = "lib/receptionist/conversation-ownership-read-model.ts";
const OWNERSHIP_READER = "server/services/receptionist-ownership-read-model.ts";
// The R51 Ownership State Engine runtime — since R51 the release ledger's ONLY reader (the sole engine-side event reader).
const OWNERSHIP_STATE_RUNTIME = "server/services/receptionist-ownership-state.ts";

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

/** The release ledger's write primitive — the function an auditor would call to file a release. */
const RELEASE_WRITE_FN = /\brecord_receptionist_conversation_claim_release\b/;

/** The R46 claim ledger's write primitive — must remain named by exactly the claim runtime (never a release file). */
const CLAIM_WRITE_FN = /\brecord_receptionist_conversation_claim\b/;

/** The runtime entry point — the ONE governed mechanism that records an operator release. */
const RELEASE_ENTRY = /export async function releaseConversationWork\(/;

/** The pure resolver — the single source of truth for what a well-formed release looks like. */
const RESOLVE_RELEASE_ENTRY = /export function resolveRelease\(/;

/** The R46 claim entry point + resolver — a release file records neither. */
const CLAIM_ENTRY = /\bclaimConversationWork\b/;
const RESOLVE_CLAIM_ENTRY = /\bresolveClaim\b/;

/** The R48 ownership-derivation surface — a release file re-implements none of it. */
const OWNERSHIP_DERIVATION =
  /\b(?:projectOwnership|projectOwnershipEvent|selectActiveClaims|summariseOwnership|orderOwnershipEvents|getOwnership|getOwnershipHistory|getOwnershipSummary)\b/;

/** The R36 coordinations base table — the authority the writer guards a release against. */
const COORDINATIONS_TABLE = /\breceptionist_conversation_coordinations\b/;

/** The R46 claims ledger table — the writer reads it (the ownership gate); the release core/runtime name it not. */
const CLAIMS_TABLE = /\breceptionist_conversation_claims\b/;

/** Every engine EXECUTION function (deriving/performing runtimes + resolvers) — a release names none of them. */
const ENGINE_EXECUTION_FNS =
  /\b(?:fulfilApprovedBooking|verifyApprovedFulfilment|recoverVerifiedFulfilment|resolveConversationCompletion|governConversationLifecycle|orchestrateConversationLifecycle|coordinateConversationLifecycle|resolveConversationCoordination|resolveFulfilment|resolveVerification|resolveRecovery|resolveResolution|resolveLifecycle|resolveOrchestration|resolveCoordination)\b/;

/**
 * The R50 explicit non-goals as SOURCE tokens — a release records a relinquish; it acts on nothing and moves work to no
 * one. `release` is DELIBERATELY ABSENT: it is R50's CAPABILITY, not a non-goal. `email` is absent too — the ledger
 * records the operator's attribution `operator_email`, which is not the email CHANNEL non-goal (asserted separately).
 */
const NON_GOAL_TOKENS = [
  /\breassign\w*/i, // reassignment
  /\bassign\w*/i, // automatic assignment
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

describe("receptionist release — the capability ships", () => {
  it(`ships the append-only release ledger migration ${MIGRATION}`, () => {
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
    expect(code).toMatch(RESOLVE_RELEASE_ENTRY);
    expect(code).toMatch(/export function isReleaseDecided\(/);
  });

  it("the server runtime exports the single release entry point", () => {
    expect(codeOf(read(RUNTIME))).toMatch(RELEASE_ENTRY);
  });
});

// =====================================================================
// 1. RELEASE RUNTIME AUTHORITATIVE / SINGLE WRITE PATH — exactly one module writes the ledger; the resolver and entry
//    point are each defined once.
// =====================================================================

describe("receptionist release — exactly one module records a release (the release runtime is authoritative)", () => {
  const writers = walkSources(SOURCE_ROOTS)
    .filter((full) => RELEASE_WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();
  const entryDefiners = walkSources(SOURCE_ROOTS)
    .filter((full) => RELEASE_ENTRY.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();
  const resolverDefiners = walkSources(SOURCE_ROOTS)
    .filter((full) => RESOLVE_RELEASE_ENTRY.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the ONLY module that names the release write primitive is the release server runtime", () => {
    // If this list ever grows, a second release-write path (or a bypass) has appeared. The R51 state engine names the
    // release LEDGER (a `.from(...)` read), never this WRITER — so it is absent here.
    expect(writers).toEqual([RUNTIME]);
  });

  it("the runtime entry point releaseConversationWork is DEFINED in exactly one module — the runtime", () => {
    expect(entryDefiners).toEqual([RUNTIME]);
  });

  it("the resolver resolveRelease is DEFINED in exactly one module — the pure core", () => {
    // No feature implements independent release-shaping logic: the single source of truth is exported once and consumed.
    expect(resolverDefiners).toEqual([CORE]);
  });

  it("no app/ route, action, or component records a release directly", () => {
    expect(writers.filter((p) => p.startsWith("app/"))).toEqual([]);
  });

  it("no other server/ module records a release directly", () => {
    expect(writers.filter((p) => p !== RUNTIME && p.startsWith("server/"))).toEqual([]);
  });
});

// =====================================================================
// 2. The pure core is PURE, MINIMALLY-IMPORTED and MODEL-FREE — it DERIVES, it persists and records nothing.
// =====================================================================

describe("receptionist release — the pure core is pure, minimally-imported and model-free", () => {
  const pcode = codeOf(read(CORE));

  it("imports ONLY the claim core's operator identity — a release reuses WHO a claim recorded, nothing more", () => {
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

  it("names NO ledger primitive — the pure core reaches no writer (claim or release)", () => {
    expect(pcode).not.toMatch(RELEASE_WRITE_FN);
    expect(pcode).not.toMatch(CLAIM_WRITE_FN);
    expect(pcode.match(/record_receptionist_conversation_\w+/g)).toBeNull();
  });

  it("the release vocabulary is EXACTLY {release_conversation_work} ⇒ {work_released}, resolutions closed", () => {
    expect(pcode).toMatch(/RELEASE_TYPES\s*=\s*\[\s*"release_conversation_work"\s*\]/);
    expect(pcode).toMatch(/ReleaseOutcome\s*=\s*"work_released"/);
    expect(pcode).toMatch(
      /RELEASE_RESOLUTIONS\s*=\s*\[\s*"released",\s*"not_owned",\s*"unavailable"\s*\]/,
    );
  });
});

// =====================================================================
// 3. The CLAIM runtime remains AUTHORITATIVE — release CONSUMES the ownership fact; it records + resolves NO claim.
// =====================================================================

describe("receptionist release — the Claim runtime remains authoritative", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));
  const sql = sqlCodeOf(read(MIGRATION));

  const claimWriters = walkSources(SOURCE_ROOTS)
    .filter((full) => CLAIM_WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the R46 claim spine ships (the authority the release defers to)", () => {
    expect(existsSync(resolve(ROOT, CLAIM_CORE)), CLAIM_CORE).toBe(true);
    expect(existsSync(resolve(ROOT, CLAIM_RUNTIME)), CLAIM_RUNTIME).toBe(true);
    expect(existsSync(resolve(ROOT, CLAIM_MIGRATION)), CLAIM_MIGRATION).toBe(true);
  });

  it("the claim write primitive is STILL named by exactly the claim runtime — no release file records a claim", () => {
    // `record_receptionist_conversation_claim_release` does NOT match `\brecord_receptionist_conversation_claim\b`
    // (the `_` after `claim` denies the word boundary), so the release runtime is provably absent from this list.
    expect(claimWriters).toEqual([CLAIM_RUNTIME]);
    expect(rcode).not.toMatch(CLAIM_WRITE_FN);
    expect(pcode).not.toMatch(CLAIM_WRITE_FN);
  });

  it("neither release file records or re-resolves a CLAIM — it consumes the ownership fact, never re-derives it", () => {
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

  it("the writer's OWNERSHIP gate reads the R46 claim ledger and REFUSES a release the operator does not hold", () => {
    // "You can only release what you hold": resolve the coordination's active claim, then refuse (NULL, no write) when
    // there is no claim, or when the claim is held by a DIFFERENT operator.
    expect(sql).toMatch(
      /select id, operator_id into v_claim_id, v_claim_operator[\s\S]*?from public\.receptionist_conversation_claims\b/i,
    );
    expect(sql).toMatch(/v_claim_id is null/i);
    expect(sql).toMatch(/v_claim_operator\s+is distinct from\s+p_operator_id/i);
    expect(sql).toMatch(/return null/i);
  });

  it("the release ledger NEVER mutates the claim ledger — it only reads it (append-only claim audit preserved)", () => {
    expect(sql).not.toMatch(/update public\.receptionist_conversation_claims\b/i);
    expect(sql).not.toMatch(/delete from public\.receptionist_conversation_claims\b/i);
    expect(sql).not.toMatch(/insert into public\.receptionist_conversation_claims\b/i);
  });
});

// =====================================================================
// 4. The OWNERSHIP READ MODEL remains AUTHORITATIVE — release records a fact; it re-implements NO ownership derivation,
//    and the release ledger is read through exactly ONE seam.
// =====================================================================

describe("receptionist release — the Ownership Read Model remains authoritative", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  const releaseTableReaders = walkSources(SOURCE_ROOTS)
    .filter((full) =>
      fromTargets(codeOf(read(rel(full)))).includes("receptionist_conversation_claim_releases"),
    )
    .map(rel)
    .sort();

  it("the R48 read model spine ships (the single authority over ownership FACTS)", () => {
    expect(existsSync(resolve(ROOT, OWNERSHIP_CORE)), OWNERSHIP_CORE).toBe(true);
    expect(existsSync(resolve(ROOT, OWNERSHIP_READER)), OWNERSHIP_READER).toBe(true);
  });

  it("neither release file re-implements ownership derivation — it names no read-model projection or fold", () => {
    expect(pcode).not.toMatch(OWNERSHIP_DERIVATION);
    expect(rcode).not.toMatch(OWNERSHIP_DERIVATION);
  });

  it("the runtime reads NO ownership — it imports no read model and issues no `.from(...)`", () => {
    expect(rcode).not.toMatch(/\.from\(/);
    const specs = importSpecifiers(rcode);
    expect(specs).not.toContain("@/server/services/receptionist-ownership-read-model");
    expect(specs).not.toContain("@/lib/receptionist/conversation-ownership-read-model");
  });

  it("the release ledger is READ through exactly ONE seam — the R51 ownership state engine", () => {
    // A `.from("receptionist_conversation_claim_releases")` appears in exactly one module: the state-engine runtime.
    // Since R51 the R48 reader consumes the engine (it names the release ledger no more); no My-Claims list, dashboard
    // or queue reconstructs ownership from the release ledger itself.
    expect(releaseTableReaders).toEqual([OWNERSHIP_STATE_RUNTIME]);
  });

  it("the R51 state engine reads the release ledger — it folds claims + releases into derived ownership state", () => {
    const runtime = codeOf(read(OWNERSHIP_STATE_RUNTIME));
    expect(runtime).toMatch(/receptionist_conversation_claim_releases/);
    expect(runtime).toMatch(/reconcileOwnershipStates/);
  });
});

// =====================================================================
// 5. ORGANISATION ISOLATION — the core demands an org, the ledger requires one, both storage guards are org-scoped.
// =====================================================================

describe("receptionist release — organisation isolation is preserved", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));
  const sql = sqlCodeOf(read(MIGRATION));

  it("the core's FIRST gate demands an organisation — a request without one names no release", () => {
    expect(pcode).toMatch(
      /if \(!isNonEmpty\(request\.org_id\)\) return abstain\("missing_organisation"\)/,
    );
  });

  it("the runtime scopes the write by the org from the DECISION (never from client input)", () => {
    expect(rcode).toMatch(/p_org_id:\s*decision\.org_id/);
  });

  it("the ledger's org_id is NOT NULL — a release is ALWAYS org-scoped", () => {
    expect(sql).toMatch(/org_id\s+uuid\s+not null/i);
  });

  it("the writer's coordination guard is ORG-SCOPED — the cross-tenant release is refused structurally", () => {
    expect(sql).toMatch(/from public\.receptionist_conversation_coordinations c/i);
    expect(sql).toMatch(/c\.id\s*=\s*p_coordination_id/i);
    expect(sql).toMatch(/c\.org_id\s*=\s*p_org_id/i);
    expect(sql).toMatch(/names no coordination in this organisation/i);
  });

  it("the writer's OWNERSHIP gate is ALSO org-scoped — the claim is resolved within the releasing org only", () => {
    expect(sql).toMatch(
      /from public\.receptionist_conversation_claims[\s\S]*?where coordination_id = p_coordination_id[\s\S]*?and org_id = p_org_id/i,
    );
  });
});

// =====================================================================
// 6. INVALID RELEASES ARE PREVENTED — UNIQUE coordination + ON CONFLICT DO NOTHING; ownership gate refuses non-owners.
// =====================================================================

describe("receptionist release — invalid releases are prevented by construction", () => {
  const rcode = codeOf(read(RUNTIME));
  const sql = sqlCodeOf(read(MIGRATION));

  it("coordination_id is UNIQUE — at most one release per coordinated item", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_claim_releases_coordination_unique unique \(coordination_id\)/i,
    );
  });

  it("the writer inserts ON CONFLICT (coordination_id) DO NOTHING (a repeat by the owner is idempotent)", () => {
    expect(sql).toMatch(/on conflict \(coordination_id\) do nothing/i);
  });

  it("no claim ⇒ refused (NULL); DIFFERENT operator ⇒ refused (NULL) — you can only release what you hold", () => {
    expect(sql).toMatch(/v_claim_id is null/i);
    expect(sql).toMatch(/v_claim_operator\s+is distinct from\s+p_operator_id/i);
    expect(sql).toMatch(/return null/i);
  });

  it("the runtime maps the refusal to not_owned and a recorded release to released", () => {
    expect(rcode).toMatch(/if \(!isReleaseDecided\(decision\)\) return \{ resolution: "unavailable" \}/);
    expect(rcode).toMatch(/if \(!data\) return \{ resolution: "not_owned" \}/);
    expect(rcode).toMatch(/resolution: "released"/);
  });
});

// =====================================================================
// 7. The RELEASING OPERATOR, A TIMESTAMP and A RELEASE EVENT are recorded — the ledger row IS the event.
// =====================================================================

describe("receptionist release — records the releasing operator, a timestamp and the release event", () => {
  const rcode = codeOf(read(RUNTIME));
  const sql = sqlCodeOf(read(MIGRATION));

  it("the ledger records WHO — operator_id NOT NULL plus a denormalised operator_email", () => {
    expect(sql).toMatch(/operator_id\s+uuid\s+not null/i);
    expect(sql).toMatch(/operator_email\s+text/i);
  });

  it("the ledger records WHEN — released_at defaults to now()", () => {
    expect(sql).toMatch(/released_at\s+timestamptz\s+not null\s+default\s+now\(\)/i);
  });

  it("the ledger threads the RELINQUISHED claim — claim_id NOT NULL (a complete ownership audit)", () => {
    expect(sql).toMatch(/claim_id\s+uuid\s+not null/i);
  });

  it("the runtime threads the authenticated operator's id and email into the write", () => {
    expect(rcode).toMatch(/p_operator_id:\s*decision\.operator\.id/);
    expect(rcode).toMatch(/p_operator_email:\s*decision\.operator\.email/);
  });

  it("the writer REQUIRES the org, coordination and operator — a release always records who let it go", () => {
    expect(sql).toMatch(/p_org_id is null or p_coordination_id is null or p_operator_id is null/i);
  });
});

// =====================================================================
// 8. The AUDIT is APPEND-ONLY, service-role-only and DETERMINISTIC — a release can never be rewritten or erased.
// =====================================================================

describe("receptionist release — the ledger is append-only, service-role-only and deterministic", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("creates the receptionist_conversation_claim_releases table", () => {
    expect(sql).toMatch(
      /create table if not exists public\.receptionist_conversation_claim_releases/i,
    );
  });

  it("captures the anchors, the claim, the operator, the operation, the status and the timestamps", () => {
    for (const column of [
      "org_id",
      "coordination_id",
      "claim_id",
      "conversation_id",
      "correlation_id",
      "operator_id",
      "operator_email",
      "release_type",
      "release_outcome",
      "status",
      "metadata",
      "released_at",
      "created_at",
    ]) {
      expect(sql, `column ${column}`).toMatch(new RegExp(`\\b${column}\\b`));
    }
  });

  it("bounds the release type and outcome to their vocabularies {release_conversation_work} / {work_released}", () => {
    expect(sql).toMatch(
      /check\s*\(\s*release_type\s+in\s*\(\s*'release_conversation_work'\s*\)\s*\)/i,
    );
    expect(sql).toMatch(/check\s*\(\s*release_outcome\s+in\s*\(\s*'work_released'\s*\)\s*\)/i);
  });

  it("HELD BY CONSTRUCTION — status is CHECK-pinned to the single value 'released'", () => {
    expect(sql).toMatch(/status\s+text\s+not null\s+default\s+'released'/i);
    expect(sql).toMatch(/check\s*\(\s*status\s*=\s*'released'\s*\)/i);
  });

  it("DETERMINISTIC BY CONSTRUCTION — a CHECK pins (release_type, release_outcome) to the exact fold", () => {
    expect(sql).toMatch(/constraint receptionist_conversation_claim_releases_outcome_fold check/i);
    expect(sql).toMatch(
      /release_type = 'release_conversation_work' and release_outcome = 'work_released'/i,
    );
  });

  it("enables RLS with NO policies — service-role / SECURITY DEFINER only", () => {
    expect(sql).toMatch(
      /alter table public\.receptionist_conversation_claim_releases enable row level security/i,
    );
    expect(sql).not.toMatch(
      /create policy[\s\S]*?on public\.receptionist_conversation_claim_releases/i,
    );
  });

  it("is APPEND-ONLY — UPDATE and DELETE are rejected by triggers (the audit can never be rewritten or erased)", () => {
    expect(sql).toMatch(
      /create or replace function public\.receptionist_conversation_claim_releases_block_mutation\(/i,
    );
    expect(sql).toMatch(/raise exception[\s\S]*?append-only[\s\S]*?tg_op/i);
    expect(sql).toMatch(/errcode\s*=\s*'restrict_violation'/i);
    expect(sql).toMatch(
      /create trigger receptionist_conversation_claim_releases_no_update\s+before update on public\.receptionist_conversation_claim_releases/i,
    );
    expect(sql).toMatch(
      /create trigger receptionist_conversation_claim_releases_no_delete\s+before delete on public\.receptionist_conversation_claim_releases/i,
    );
  });

  it("writes only through a SECURITY DEFINER primitive granted only to service_role", () => {
    expect(sql).toMatch(
      /create or replace function public\.record_receptionist_conversation_claim_release\(/i,
    );
    expect(sql).toMatch(/returns uuid/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = ''/i);
    expect(sql).toMatch(/insert into public\.receptionist_conversation_claim_releases/i);
    expect(sql).toMatch(/revoke all on function[\s\S]*?from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*?to service_role/i);
  });

  it("the write primitive re-validates the (type, outcome) fold (belt-and-braces with the table CHECK)", () => {
    expect(sql).toMatch(/does not match the deterministic fold/i);
  });
});

// =====================================================================
// 9. NO EXECUTION PATH is introduced — the release records a relinquish; it reassigns, dispatches and completes nothing.
// =====================================================================

describe("receptionist release — no execution path is introduced", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("neither the core nor the runtime names any OTHER engine writer — the only writer is the release primitive", () => {
    // The runtime names EXACTLY one record_receptionist_conversation_* token — the release writer; the core names none.
    expect([...new Set(rcode.match(/record_receptionist_conversation_\w+/g) ?? [])]).toEqual([
      "record_receptionist_conversation_claim_release",
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

  it("neither the core nor the runtime names an R50 non-goal token (reassign/assign/dispatch/…/close)", () => {
    for (const token of NON_GOAL_TOKENS) {
      expect(pcode, `core must not name ${token}`).not.toMatch(token);
      expect(rcode, `runtime must not name ${token}`).not.toMatch(token);
    }
  });

  it("the runtime writes NO tenant row and reaches no transport / calendar / quote / channel / generation path", () => {
    // A release touches NO tenant table (no `.from(...)`), and reaches no business-execution surface.
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

  it("the runtime writes ONLY the one internal row — the release ledger, through the write primitive", () => {
    expect(rcode).toMatch(RELEASE_WRITE_FN);
  });

  it("OWNERSHIP GUARDING, NOT RETRY — it names no re-attempt orchestration", () => {
    expect(rcode).not.toMatch(/setTimeout/);
    expect(rcode).not.toMatch(/setInterval/);
    expect(rcode).not.toMatch(/backoff/i);
  });

  it("SWALLOWS a failed write — it never THROWS (a release attempt can never crash the surface)", () => {
    expect(rcode).not.toMatch(/\bthrow\b/);
    expect(rcode).toMatch(/console\.error/);
  });

  it("is server-only — it is the ONE place a release is durably recorded", () => {
    expect(importSpecifiers(rcode)).toContain("server-only");
  });

  it("reaches no model — a release is not a generation", () => {
    const specs = importSpecifiers(rcode);
    expect(specs.some((s) => s.startsWith("@/lib/ai/"))).toBe(false);
  });
});

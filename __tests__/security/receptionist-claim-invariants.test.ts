import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONVERSATION WORK CLAIM governance invariants
 * (the AI Receptionist Programme, R46 — CONVERSATION WORK CLAIM).
 *
 * R37–R45 built the READ spine over recorded coordinations (Read Model → Worklist Engine → Read Surface → API →
 * Client → Session → View Model → Operator Surface → Detail Surface) — every layer READ-ONLY. R46 is the NEXT layer,
 * and the FIRST that lets a human operator WRITE: it records that an operator has taken OWNERSHIP of one Conversation
 * Worklist item. Its law is exact — "the claim capability records operator identity, a timestamp and a claim event;
 * it prevents conflicting active claims; it preserves an append-only audit; it preserves organisation isolation; the
 * Coordination Engine remains authoritative; and it introduces NO execution path — it does not assign, dispatch,
 * notify, schedule, fulfil, promote, complete or close." This suite proves that contract as a matter of SOURCE, not
 * discipline — the house bar of the R30→R45 invariant suites:
 *
 *   • SINGLE WRITE PATH — across all non-test source (app/, server/, lib/), the claim ledger's write primitive
 *     (`record_receptionist_conversation_claim`) is named by EXACTLY ONE module: the claim server runtime; the runtime
 *     entry point `claimConversationWork` is DEFINED in exactly that one module; and the pure resolver `resolveClaim`
 *     is DEFINED in exactly the one pure core. No app/ route, action or component records a claim, so there is no
 *     second path and no bypass.
 *   • THE PURE CORE IS PURE, IMPORT-FREE & MODEL-FREE — it imports NOTHING at all (a claim is a shape validation over
 *     opaque ids; it needs no other module), reaches no server / IO / model / clock / RNG, and names no ledger
 *     primitive. It DERIVES a decision; it persists nothing and records nothing.
 *   • THE COORDINATION ENGINE STAYS AUTHORITATIVE — the core derives NO coordination and the runtime SELECTs none; the
 *     writer refuses to file a claim unless the named coordination is a REAL row in the R36 coordinations ledger. The
 *     coordinations ledger stays the single source of truth for a recorded coordination.
 *   • ORGANISATION ISOLATION IS PRESERVED — the core DEMANDS an organisation on every request (its first gate), the
 *     ledger's `org_id` is NOT NULL, and the writer's coordination guard is org-scoped (`c.org_id = p_org_id`): a
 *     cross-tenant claim names no coordination in the claiming org and is refused at the storage layer.
 *   • CONFLICTING ACTIVE CLAIMS ARE PREVENTED — `coordination_id` is UNIQUE and the writer inserts ON CONFLICT DO
 *     NOTHING; a repeat by the SAME operator returns the existing id (idempotent), an attempt by a DIFFERENT operator
 *     returns NULL (refused). Two operators can never both hold the same item.
 *   • OPERATOR IDENTITY, A TIMESTAMP AND A CLAIM EVENT ARE RECORDED — the ledger row is the event: `operator_id` NOT
 *     NULL, a denormalised `operator_email`, and `claimed_at`. The runtime threads the authenticated operator's id +
 *     email straight into the write.
 *   • THE AUDIT IS APPEND-ONLY — RLS-enabled with NO policies, UPDATE/DELETE rejected by triggers even for
 *     service_role, a SECURITY DEFINER writer granted only to service_role, `status` CHECK-pinned to 'claimed', and a
 *     CHECK that pins (claim_type, claim_outcome) to the EXACT deterministic fold — so a claim can never be silently
 *     rewritten or erased, and no row can record a non-deterministic claim.
 *   • NO EXECUTION PATH IS INTRODUCED — neither the core nor the runtime names any other engine writer, any engine
 *     execution function, any tenant-table write, or any R46 non-goal token (assign / dispatch / notify / schedule /
 *     enqueue / retry / promote / complete / close). The runtime SWALLOWS a failed write (returns a result, never
 *     throws) and orchestrates no re-attempt (conflict prevention is NOT retry).
 *   • IT IS A DISTINCT GRAIN — the claim is at the COORDINATION grain (`coordination_id`); it never touches R14's
 *     conversation-grain assignee (`receptionist_conversations.assignee_id`), so the two never collide.
 *
 * The engine's runtime behaviour is pinned against real Postgres in
 * __tests__/integration/receptionist/conversation-claim-pipeline.test.ts, and the pure core's resolution exhaustively
 * in __tests__/receptionist/conversation-claim.test.ts. This tier is HERMETIC — a filesystem scan over
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

const CORE = "lib/receptionist/conversation-claim.ts";
const RUNTIME = "server/services/receptionist-claim.ts";
const MIGRATION = "supabase/migrations/20260907000000_receptionist_conversation_claims.sql";
const COORDINATIONS_MIGRATION =
  "supabase/migrations/20260905000000_receptionist_conversation_coordinations.sql";

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

/** The claim ledger's write primitive — the function an auditor would call to file a claim. */
const WRITE_FN = /\brecord_receptionist_conversation_claim\b/;

/** The runtime entry point — the ONE governed mechanism that records an operator claim. */
const CLAIM_ENTRY = /export async function claimConversationWork\(/;

/** The pure resolver — the single source of truth for what a well-formed claim looks like. */
const RESOLVE_ENTRY = /export function resolveClaim\(/;

/** The R36 coordinations base table — the authority the writer guards a claim against. */
const COORDINATIONS_TABLE = /\breceptionist_conversation_coordinations\b/;

/** Every engine EXECUTION function (deriving/performing runtimes + resolvers) — a claim names none of them. */
const ENGINE_EXECUTION_FNS =
  /\b(?:fulfilApprovedBooking|verifyApprovedFulfilment|recoverVerifiedFulfilment|resolveConversationCompletion|governConversationLifecycle|orchestrateConversationLifecycle|coordinateConversationLifecycle|resolveConversationCoordination|resolveFulfilment|resolveVerification|resolveRecovery|resolveResolution|resolveLifecycle|resolveOrchestration|resolveCoordination)\b/;

/** The R46 explicit non-goals as SOURCE tokens — a claim records ownership; it acts on nothing. */
const NON_GOAL_TOKENS = [
  /\bassign\w*/i,
  /\bdispatch\w*/i,
  /\bnotif\w*/i, // notify / notification
  /\bschedul\w*/i, // schedule / scheduling
  /\benqueue\w*/i,
  /\bretr(?:y|ies)\b/i,
  /\bpromot\w*/i, // customer promotion
  /\bcomplet\w*/i, // work completion
  /\bclos(?:e|ing|ed|ure)\b/i, // conversation closing
] as const;

// =====================================================================
// 0. The core, the ledger and the runtime all ship, with their single entry points.
// =====================================================================

describe("receptionist claim — the capability ships", () => {
  it(`ships the append-only claim ledger migration ${MIGRATION}`, () => {
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
    expect(code).toMatch(RESOLVE_ENTRY);
    expect(code).toMatch(/export function isClaimDecided\(/);
  });

  it("the server runtime exports the single claim entry point", () => {
    expect(codeOf(read(RUNTIME))).toMatch(CLAIM_ENTRY);
  });
});

// =====================================================================
// 1. SINGLE WRITE PATH — exactly one module writes the ledger; the resolver and entry point are each defined once.
// =====================================================================

describe("receptionist claim — exactly one module records a claim", () => {
  const writers = walkSources(SOURCE_ROOTS)
    .filter((full) => WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();
  const entryDefiners = walkSources(SOURCE_ROOTS)
    .filter((full) => CLAIM_ENTRY.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();
  const resolverDefiners = walkSources(SOURCE_ROOTS)
    .filter((full) => RESOLVE_ENTRY.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the ONLY module that names the ledger write primitive is the claim server runtime", () => {
    // If this list ever grows, a second claim-write path (or a bypass) has appeared.
    expect(writers).toEqual([RUNTIME]);
  });

  it("the runtime entry point claimConversationWork is DEFINED in exactly one module — the runtime", () => {
    expect(entryDefiners).toEqual([RUNTIME]);
  });

  it("the resolver resolveClaim is DEFINED in exactly one module — the pure core", () => {
    // No feature implements independent claim-shaping logic: the single source of truth is exported once and consumed.
    expect(resolverDefiners).toEqual([CORE]);
  });

  it("no app/ route, action, or component records a claim directly", () => {
    expect(writers.filter((p) => p.startsWith("app/"))).toEqual([]);
  });

  it("no other server/ module records a claim directly", () => {
    expect(writers.filter((p) => p !== RUNTIME && p.startsWith("server/"))).toEqual([]);
  });
});

// =====================================================================
// 2. The pure core is PURE, IMPORT-FREE and MODEL-FREE — it DERIVES, it persists and records nothing.
// =====================================================================

describe("receptionist claim — the pure core is pure, import-free and model-free", () => {
  const pcode = codeOf(read(CORE));

  it("imports NOTHING — a claim is a shape validation over opaque ids; it needs no other module", () => {
    expect(importSpecifiers(pcode)).toEqual([]);
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

  it("names NO ledger primitive — the pure core reaches no writer", () => {
    expect(pcode).not.toMatch(WRITE_FN);
    expect(pcode.match(/record_receptionist_conversation_\w+/g)).toBeNull();
  });

  it("the claim vocabulary is EXACTLY {claim_conversation_work} ⇒ {work_claimed}", () => {
    expect(pcode).toMatch(/CLAIM_TYPES\s*=\s*\[\s*"claim_conversation_work"\s*\]/);
    expect(pcode).toMatch(/ClaimOutcome\s*=\s*"work_claimed"/);
  });
});

// =====================================================================
// 3. The Coordination Engine remains AUTHORITATIVE — the claim guards against a REAL coordination, deriving none.
// =====================================================================

describe("receptionist claim — the Coordination Engine stays authoritative", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));
  const sql = sqlCodeOf(read(MIGRATION));

  it("the R36 coordinations base table ships (the authority the claim is guarded against)", () => {
    expect(existsSync(resolve(ROOT, COORDINATIONS_MIGRATION)), COORDINATIONS_MIGRATION).toBe(true);
  });

  it("the core derives NO coordination — it validates the shape of the request and stops", () => {
    // It names no coordination resolver and asserts no coordination exists — that is the writer's guard.
    expect(pcode).not.toMatch(ENGINE_EXECUTION_FNS);
    expect(pcode).not.toMatch(COORDINATIONS_TABLE);
  });

  it("the runtime SELECTs no coordination itself — it defers the authority guard to the writer", () => {
    // No `.from(...)` at all: the runtime never reads the coordinations ledger; the SECURITY DEFINER writer does.
    expect(rcode).not.toMatch(/\.from\(/);
    expect(rcode).not.toMatch(COORDINATIONS_TABLE);
    expect(rcode).not.toMatch(ENGINE_EXECUTION_FNS);
  });

  it("the writer REFUSES a claim whose coordination is not a REAL row in the claiming organisation", () => {
    // The coordination-authority + organisation-isolation gate: `exists (... coordinations c where c.id = ... and
    // c.org_id = ...)` — a claim can only be filed against a coordination the org actually owns.
    expect(sql).toMatch(/from public\.receptionist_conversation_coordinations c/i);
    expect(sql).toMatch(/c\.id\s*=\s*p_coordination_id/i);
    expect(sql).toMatch(/c\.org_id\s*=\s*p_org_id/i);
    expect(sql).toMatch(/names no coordination in this organisation/i);
  });
});

// =====================================================================
// 4. ORGANISATION ISOLATION — the core demands an org, the ledger requires one, the guard is org-scoped.
// =====================================================================

describe("receptionist claim — organisation isolation is preserved", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));
  const sql = sqlCodeOf(read(MIGRATION));

  it("the core's FIRST gate demands an organisation — a request without one names no claim", () => {
    expect(pcode).toMatch(
      /if \(!isNonEmpty\(request\.org_id\)\) return abstain\("missing_organisation"\)/,
    );
  });

  it("the runtime scopes the write by the org from the DECISION (never from client input)", () => {
    expect(rcode).toMatch(/p_org_id:\s*decision\.org_id/);
  });

  it("the ledger's org_id is NOT NULL — a claim is ALWAYS org-scoped", () => {
    expect(sql).toMatch(/org_id\s+uuid\s+not null/i);
  });

  it("the writer's coordination guard is ORG-SCOPED — the cross-tenant claim is refused structurally", () => {
    expect(sql).toMatch(/c\.org_id\s*=\s*p_org_id/i);
  });
});

// =====================================================================
// 5. CONFLICTING ACTIVE CLAIMS ARE PREVENTED — UNIQUE coordination + ON CONFLICT DO NOTHING; same/different operator.
// =====================================================================

describe("receptionist claim — conflicting active claims are prevented by construction", () => {
  const rcode = codeOf(read(RUNTIME));
  const sql = sqlCodeOf(read(MIGRATION));

  it("coordination_id is UNIQUE — at most one active claim per coordinated item", () => {
    expect(sql).toMatch(
      /constraint receptionist_conversation_claims_coordination_unique unique \(coordination_id\)/i,
    );
  });

  it("the writer inserts ON CONFLICT (coordination_id) DO NOTHING", () => {
    expect(sql).toMatch(/on conflict \(coordination_id\) do nothing/i);
  });

  it("same operator ⇒ idempotent (existing id); DIFFERENT operator ⇒ refused (NULL) — no second claim is written", () => {
    // On conflict the writer resolves the existing operator: a different operator returns NULL WITHOUT writing.
    expect(sql).toMatch(/v_existing_operator\s+is distinct from\s+p_operator_id/i);
    expect(sql).toMatch(/return null/i);
  });

  it("the runtime maps the refusal to already_claimed and a recorded claim to claimed", () => {
    expect(rcode).toMatch(/if \(!data\) return \{ resolution: "already_claimed" \}/);
    expect(rcode).toMatch(/resolution: "claimed"/);
  });
});

// =====================================================================
// 6. OPERATOR IDENTITY, A TIMESTAMP and A CLAIM EVENT are recorded — the ledger row IS the event.
// =====================================================================

describe("receptionist claim — records operator identity, a timestamp and the claim event", () => {
  const rcode = codeOf(read(RUNTIME));
  const sql = sqlCodeOf(read(MIGRATION));

  it("the ledger records WHO — operator_id NOT NULL plus a denormalised operator_email", () => {
    expect(sql).toMatch(/operator_id\s+uuid\s+not null/i);
    expect(sql).toMatch(/operator_email\s+text/i);
  });

  it("the ledger records WHEN — claimed_at defaults to now()", () => {
    expect(sql).toMatch(/claimed_at\s+timestamptz\s+not null\s+default\s+now\(\)/i);
  });

  it("the runtime threads the authenticated operator's id and email into the write", () => {
    expect(rcode).toMatch(/p_operator_id:\s*decision\.operator\.id/);
    expect(rcode).toMatch(/p_operator_email:\s*decision\.operator\.email/);
  });

  it("the writer REQUIRES the org, coordination and operator — a claim always records who took it", () => {
    expect(sql).toMatch(
      /p_org_id is null or p_coordination_id is null or p_operator_id is null/i,
    );
  });
});

// =====================================================================
// 7. The AUDIT is APPEND-ONLY, service-role-only and DETERMINISTIC — a claim can never be rewritten or erased.
// =====================================================================

describe("receptionist claim — the ledger is append-only, service-role-only and deterministic", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("creates the receptionist_conversation_claims table", () => {
    expect(sql).toMatch(/create table if not exists public\.receptionist_conversation_claims/i);
  });

  it("captures the anchors, the operator, the operation, the status and the timestamps", () => {
    for (const column of [
      "org_id",
      "coordination_id",
      "conversation_id",
      "correlation_id",
      "operator_id",
      "operator_email",
      "claim_type",
      "claim_outcome",
      "status",
      "metadata",
      "claimed_at",
      "created_at",
    ]) {
      expect(sql, `column ${column}`).toMatch(new RegExp(`\\b${column}\\b`));
    }
  });

  it("bounds the claim type and outcome to their vocabularies {claim_conversation_work} / {work_claimed}", () => {
    expect(sql).toMatch(/check\s*\(\s*claim_type\s+in\s*\(\s*'claim_conversation_work'\s*\)\s*\)/i);
    expect(sql).toMatch(/check\s*\(\s*claim_outcome\s+in\s*\(\s*'work_claimed'\s*\)\s*\)/i);
  });

  it("HELD BY CONSTRUCTION — status is CHECK-pinned to the single value 'claimed'", () => {
    expect(sql).toMatch(/status\s+text\s+not null\s+default\s+'claimed'/i);
    expect(sql).toMatch(/check\s*\(\s*status\s*=\s*'claimed'\s*\)/i);
  });

  it("DETERMINISTIC BY CONSTRUCTION — a CHECK pins (claim_type, claim_outcome) to the exact fold", () => {
    expect(sql).toMatch(/constraint receptionist_conversation_claims_outcome_fold check/i);
    expect(sql).toMatch(/claim_type = 'claim_conversation_work' and claim_outcome = 'work_claimed'/i);
  });

  it("enables RLS with NO policies — service-role / SECURITY DEFINER only", () => {
    expect(sql).toMatch(
      /alter table public\.receptionist_conversation_claims enable row level security/i,
    );
    expect(sql).not.toMatch(/create policy[\s\S]*?on public\.receptionist_conversation_claims/i);
  });

  it("is APPEND-ONLY — UPDATE and DELETE are rejected by triggers (the audit can never be rewritten or erased)", () => {
    expect(sql).toMatch(
      /create or replace function public\.receptionist_conversation_claims_block_mutation\(/i,
    );
    expect(sql).toMatch(/raise exception[\s\S]*?append-only[\s\S]*?tg_op/i);
    expect(sql).toMatch(/errcode\s*=\s*'restrict_violation'/i);
    expect(sql).toMatch(
      /create trigger receptionist_conversation_claims_no_update\s+before update on public\.receptionist_conversation_claims/i,
    );
    expect(sql).toMatch(
      /create trigger receptionist_conversation_claims_no_delete\s+before delete on public\.receptionist_conversation_claims/i,
    );
  });

  it("writes only through a SECURITY DEFINER primitive granted only to service_role", () => {
    expect(sql).toMatch(/create or replace function public\.record_receptionist_conversation_claim\(/i);
    expect(sql).toMatch(/returns uuid/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = ''/i);
    expect(sql).toMatch(/insert into public\.receptionist_conversation_claims/i);
    expect(sql).toMatch(/revoke all on function[\s\S]*?from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*?to service_role/i);
  });

  it("the write primitive re-validates the (type, outcome) fold (belt-and-braces with the table CHECK)", () => {
    expect(sql).toMatch(/does not match the deterministic fold/i);
  });
});

// =====================================================================
// 8. NO EXECUTION PATH is introduced — the claim records ownership; it assigns, dispatches and completes nothing.
// =====================================================================

describe("receptionist claim — no execution path is introduced", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("neither the core nor the runtime names any OTHER engine writer — the only writer is the claim primitive", () => {
    // The runtime names EXACTLY one record_receptionist_conversation_* token — the claim writer; the core names none.
    expect([...new Set(rcode.match(/record_receptionist_conversation_\w+/g) ?? [])]).toEqual([
      "record_receptionist_conversation_claim",
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

  it("neither the core nor the runtime names an R46 non-goal token (assign/dispatch/notify/schedule/…/close)", () => {
    for (const token of NON_GOAL_TOKENS) {
      expect(pcode, `core must not name ${token}`).not.toMatch(token);
      expect(rcode, `runtime must not name ${token}`).not.toMatch(token);
    }
  });

  it("the runtime writes NO tenant row and reaches no transport / calendar / quote / generation path", () => {
    // A claim touches NO tenant table (no `.from(...)`), and reaches no business-execution surface.
    expect(rcode).not.toMatch(/\.from\(/);
    expect(rcode).not.toMatch(/\bleads\b/);
    expect(rcode).not.toMatch(/customers/);
    expect(rcode).not.toMatch(/calendar/i);
    expect(rcode).not.toMatch(/\bquote\b/i);
    expect(rcode).not.toMatch(/transport/i);
    expect(rcode).not.toMatch(/generateConversationResponse/);
  });

  it("the runtime writes ONLY the one internal row — the claim ledger, through the write primitive", () => {
    expect(rcode).toMatch(WRITE_FN);
  });

  it("CONFLICT PREVENTION, NOT RETRY — it names no re-attempt orchestration", () => {
    expect(rcode).not.toMatch(/setTimeout/);
    expect(rcode).not.toMatch(/setInterval/);
    expect(rcode).not.toMatch(/backoff/i);
  });

  it("SWALLOWS a failed write — it never THROWS (a claim attempt can never crash the surface)", () => {
    expect(rcode).not.toMatch(/\bthrow\b/);
    expect(rcode).toMatch(/console\.error/);
  });

  it("is server-only — it is the ONE place a claim is durably recorded", () => {
    expect(importSpecifiers(rcode)).toContain("server-only");
  });

  it("reaches no model — a claim is not a generation", () => {
    const specs = importSpecifiers(rcode);
    expect(specs.some((s) => s.startsWith("@/lib/ai/"))).toBe(false);
  });
});

// =====================================================================
// 9. A DISTINCT GRAIN — the claim is at the coordination grain; it never touches R14's conversation-grain assignee.
// =====================================================================

describe("receptionist claim — a distinct grain, no collision with R14", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));
  const sql = sqlCodeOf(read(MIGRATION));

  it("names NO conversation-grain assignee — R46 claims at the coordination grain", () => {
    for (const code of [pcode, rcode, sql]) {
      expect(code).not.toMatch(/\bassignee_id\b/i);
    }
  });

  it("the ledger never touches R14's receptionist_conversations table — it references coordinations only", () => {
    // `receptionist_conversations` (the R14 conversation table) is distinct from
    // `receptionist_conversation_coordinations` (the R36 base) and `receptionist_conversation_claims` (this ledger).
    expect(sql).not.toMatch(/\breceptionist_conversations\b/);
    expect(sql).toMatch(COORDINATIONS_TABLE);
  });
});

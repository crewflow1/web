import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONVERSATION ACTION ENGINE governance invariants
 * (the AI Receptionist Programme, R27 — CONVERSATION ACTION ENGINE).
 *
 * R17–R25 built the DERIVING stack; R26 added the OUTCOME ENGINE — the first layer that ACTS on a satisfied
 * goal, RESOLVING an internal OUTCOME and RECORDING it. R27 is the NEXT layer: it CONVERTS the resolved
 * outcome into an internal business action PROPOSAL and PREPARES it. Its law is exact — "the Action Engine
 * prepares work; it does not execute work. It may create INTERNAL actions; it must NOT execute EXTERNAL
 * business actions automatically, it must keep the Outcome Engine AUTHORITATIVE, and it must NEVER bypass
 * Policy, Audit, Human Review or Transport." This suite proves that contract as a matter of SOURCE, not
 * discipline — the house bar of tool-registry-describes-not-authorises.test.ts:
 *
 *   • SINGLE WRITE PATH — across all non-test source (app/, server/, lib/), the action ledger's write
 *     primitive (`record_receptionist_conversation_action`) is named by EXACTLY ONE module: the action
 *     server runtime. No other file can prepare an action, so there is no second write path.
 *   • THE PURE CORE IS PURE & MODEL-FREE — it reaches no server / policy / IO / model / clock / RNG, and its
 *     only imports are the adjacent TYPE surfaces, the ONE R20 validity predicate, and the R26 outcome
 *     predicate it CONSUMES. It RESOLVES; it persists nothing.
 *   • THE OUTCOME ENGINE STAYS AUTHORITATIVE — the core CONSUMES the resolved outcome (imports
 *     `isActionableOutcome`, defers on it FIRST) and NEVER re-derives it (it never names `resolveOutcome`);
 *     its goal→action map is DISJOINT from the R26 goal→outcome map, so the two engines never contend.
 *   • IT PREPARES AN INTERNAL ACTION — IT EXECUTES NO EXTERNAL ACTION — the action vocabulary is exactly
 *     {prepare_booking}; a callback is an OUTCOME (not an action) and quote maps to NO action (explicit
 *     non-goal); neither the core nor the runtime reaches a transport, a provider or a generator, and the
 *     runtime writes NO tenant row at all (no lead reflection, no customer promotion) — the ledger IS the
 *     exposure.
 *   • THE PERSIST IS BEST-EFFORT — the runtime SWALLOWS a failed write (returns null), it never THROWS —
 *     a durable, audited confirmation is never undone by a bookkeeping write. And the runtime NEVER generates
 *     the confirmation — no model, no reply pipeline.
 *   • THE LEDGER IS APPEND-ONLY, SERVICE-ROLE-ONLY AND NON-EXECUTING — RLS-enabled with no policies,
 *     UPDATE/DELETE rejected by triggers, a SECURITY DEFINER writer granted only to service_role, and its
 *     `status` CHECK-pinned to the single value 'prepared' so a row can NEVER claim an external action.
 *   • THE RUNTIME PREPARES ALONGSIDE — NOT INSTEAD OF — THE AUDITED REPLY — the canonical service runs the
 *     UNCHANGED dispatch (generate → enforce → audit → route), records the outcome, THEN prepares the action,
 *     gated on a real audited dispatch; R27 adds no second reply, generation or transport path.
 *
 * The engine's runtime behaviour is pinned against real Postgres in
 * __tests__/integration/receptionist/conversation-action-pipeline.test.ts, and the pure core's resolution
 * exhaustively in __tests__/receptionist/conversation-action.test.ts. This tier is HERMETIC — a filesystem
 * scan over comment-stripped source — so the prose documenting the contract can neither satisfy a positive
 * match nor trip a negative.
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

const CORE = "lib/receptionist/conversation-action.ts";
const RUNTIME = "server/services/receptionist-action.ts";
const SERVICE = "server/services/receptionist.ts";
const MIGRATION = "supabase/migrations/20260827000000_receptionist_conversation_actions.sql";
const OUTCOME_CORE = "lib/receptionist/conversation-outcome.ts";

/** The action ledger's write primitive — the function an auditor would call to prepare a row. */
const WRITE_FN = /\brecord_receptionist_conversation_action\b/;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

// =====================================================================
// 0. The engine, the ledger and the runtime all ship, and the service integrates them.
// =====================================================================

describe("receptionist action — the engine ships and is wired", () => {
  it(`ships the append-only action ledger migration ${MIGRATION}`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION)), MIGRATION).toBe(true);
  });

  it(`ships the pure core ${CORE}`, () => {
    expect(existsSync(resolve(ROOT, CORE)), CORE).toBe(true);
  });

  it(`ships the server runtime ${RUNTIME}`, () => {
    expect(existsSync(resolve(ROOT, RUNTIME)), RUNTIME).toBe(true);
  });

  it("the pure core exports the single resolution entry point", () => {
    const code = codeOf(read(CORE));
    expect(code).toMatch(/export function resolveAction\(/);
    expect(code).toMatch(/export function isActionableAction\(/);
  });

  it("the server runtime exports the single prepare entry point", () => {
    expect(codeOf(read(RUNTIME))).toMatch(/export async function recordConversationAction\(/);
  });

  it("the canonical service resolves the action and prepares it", () => {
    const specs = importSpecifiers(codeOf(read(SERVICE)));
    expect(specs).toContain("@/lib/receptionist/conversation-action");
    expect(specs).toContain("@/server/services/receptionist-action");
  });
});

// =====================================================================
// 1. SINGLE WRITE PATH — exactly one module names the action ledger write primitive.
// =====================================================================

describe("receptionist action — exactly one module writes the ledger", () => {
  const writers = walkSources(SOURCE_ROOTS)
    .filter((full) => WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the ONLY module that names the ledger write primitive is the action server runtime", () => {
    // If this list ever grows, a second action-write path (or a bypass) has appeared.
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
// 2. The pure core is PURE and MODEL-FREE — it RESOLVES, it persists nothing.
// =====================================================================

describe("receptionist action — the pure core is pure and model-free", () => {
  const pcode = codeOf(read(CORE));

  it("is a shared pure module (NOT server-only — the runtime and tests import it)", () => {
    expect(importSpecifiers(pcode)).not.toContain("server-only");
  });

  it("its only imports are the adjacent layer TYPES, the ONE R20 validity predicate and the R26 outcome predicate", () => {
    // The goal and strategy are TYPE-only imports; the information import is the ONE shared validity value
    // plus a type; the outcome import is the predicate it CONSUMES (isActionableOutcome) plus a type. No other
    // import is permitted — and crucially it imports NO resolver from any layer.
    expect(pcode).toMatch(/import type \{\s*ConversationGoal\s*\} from "@\/lib\/receptionist\/conversation-goal"/);
    expect(pcode).toMatch(
      /import type \{\s*ConversationStrategy\s*\} from "@\/lib\/receptionist\/conversation-strategy"/,
    );
    expect(pcode).toMatch(/isValidFieldValue/);
    expect(pcode).toMatch(/isActionableOutcome/);
    expect(importSpecifiers(pcode).sort()).toEqual(
      [
        "@/lib/receptionist/conversation-goal",
        "@/lib/receptionist/conversation-information",
        "@/lib/receptionist/conversation-outcome",
        "@/lib/receptionist/conversation-strategy",
      ].sort(),
    );
  });

  it("DUPLICATES NOTHING beneath it — it re-derives no outcome, strategy, goal, gap, information or intent", () => {
    // It consumes ALREADY-derived observations; it names none of the resolvers/extractors/detectors — and,
    // most importantly, it NEVER re-resolves the outcome (it CONSUMES the R26 resolution, keeping the Outcome
    // Engine authoritative and ensuring no duplicate outcome-resolution logic exists).
    expect(pcode).not.toMatch(/\bresolveOutcome\b/);
    expect(pcode).not.toMatch(/\bresolveStrategy\b/);
    expect(pcode).not.toMatch(/\bresolveGoal\b/);
    expect(pcode).not.toMatch(/\bdetectGap\b/);
    expect(pcode).not.toMatch(/\bextractInformation\b/);
    expect(pcode).not.toMatch(/\bresolveConversationIntent\b/);
    expect(pcode).not.toMatch(/assembleConversationContext/);
  });

  it("touches no I/O and calls no model — it resolves, it does not generate or persist", () => {
    expect(pcode).not.toMatch(/createAdminClient/);
    expect(pcode).not.toMatch(/supabase/i);
    expect(pcode).not.toMatch(/\bfetch\(/);
    expect(pcode).not.toMatch(/@\/lib\/ai\//);
    expect(pcode).not.toMatch(/Anthropic/);
  });

  it("has no clock and no RNG (a resolved action is reconstructable)", () => {
    expect(pcode).not.toMatch(/Math\.random/);
    expect(pcode).not.toMatch(/Date\.now/);
    expect(pcode).not.toMatch(/new Date\(/);
  });
});

// =====================================================================
// 3. The Outcome Engine remains AUTHORITATIVE — the action CONSUMES it and DEFERS to it.
// =====================================================================

describe("receptionist action — the Outcome Engine stays authoritative", () => {
  const pcode = codeOf(read(CORE));
  const ocode = codeOf(read(OUTCOME_CORE));
  const scode = codeOf(read(SERVICE));

  it("CONVERTS the resolved outcome — resolveAction takes the outcome as its FIRST input and defers on it", () => {
    // The first gate stands down when the Outcome Engine already resolved an actionable outcome.
    expect(pcode).toMatch(/if \(isActionableOutcome\(outcome\)\) return abstain\("outcome_resolved"\)/);
  });

  it("NEVER re-derives the outcome — it names isActionableOutcome but not resolveOutcome", () => {
    expect(pcode).toMatch(/isActionableOutcome/);
    expect(pcode).not.toMatch(/\bresolveOutcome\b/);
  });

  it("the goal→action map is DISJOINT from the R26 goal→outcome map (no goal has both)", () => {
    // Source-level proof of the partition: a callback is an OUTCOME (arrange_callback → callback / no action);
    // a booking is an ACTION (arrange_booking → prepare_booking / no outcome). The two engines never contend.
    expect(pcode).toMatch(/arrange_booking:\s*"prepare_booking"/);
    expect(pcode).toMatch(/arrange_callback:\s*null/);
    expect(ocode).toMatch(/arrange_callback:\s*"callback"/);
    expect(ocode).toMatch(/arrange_booking:\s*null/);
  });

  it("the service resolves the action FROM the outcome (it consumes the R26 result)", () => {
    expect(scode).toMatch(/resolveAction\(\s*outcome,/);
  });
});

// =====================================================================
// 4. It PREPARES an INTERNAL action — it EXECUTES NO EXTERNAL business action.
// =====================================================================

describe("receptionist action — internal actions only, no external business action", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("the action vocabulary is EXACTLY {prepare_booking} — booking-execution / quote action types are absent", () => {
    expect(pcode).toMatch(/ACTION_TYPES\s*=\s*\[\s*"prepare_booking"\s*\]/);
    // A callback is an OUTCOME, not an action; quote is an EXPLICIT R27 non-goal — both map to NO action.
    expect(pcode).toMatch(/arrange_callback:\s*null/);
    expect(pcode).toMatch(/provide_quote:\s*null/);
  });

  it("neither the core nor the runtime reaches a reply / transport / generation path", () => {
    for (const code of [pcode, rcode]) {
      expect(code).not.toMatch(/dispatchReceptionistReply/);
      expect(code).not.toMatch(/record_ai_reply_transport/);
      expect(code).not.toMatch(/generateConversationResponse/);
      expect(code).not.toMatch(/transportReply/);
    }
  });

  it("the runtime writes NO tenant row — no lead reflection, no customer promotion (the ledger IS the exposure)", () => {
    // Unlike the R26 outcome runtime (which reflected onto the lead), a prepared booking touches NO tenant
    // table: no `.from(...)` at all, no lead write, no customers. Preparing-toward-execution is a non-goal.
    expect(rcode).not.toMatch(/\.from\(/);
    expect(rcode).not.toMatch(/customers/);
    expect(rcode).not.toMatch(/\bleads\b/);
    expect(rcode).not.toMatch(/contact_phone/);
  });

  it("the runtime writes ONLY the one internal row — the action ledger, through the write primitive", () => {
    expect(rcode).toMatch(WRITE_FN);
  });
});

// =====================================================================
// 5. The persist is BEST-EFFORT — it never gates the turn, and it never generates the confirmation.
// =====================================================================

describe("receptionist action — the persist is best-effort, the confirmation is not generated here", () => {
  const rcode = codeOf(read(RUNTIME));

  it("SWALLOWS a failed write — it never THROWS (contrast the mandatory reply audit)", () => {
    // A durable, audited confirmation is never undone because a bookkeeping row could not be filed.
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

  it("is server-only — it is the ONE place a resolved action is durably prepared", () => {
    expect(importSpecifiers(rcode)).toContain("server-only");
  });
});

// =====================================================================
// 6. The migration installs an APPEND-ONLY, service-role-only, NON-EXECUTING ledger.
// =====================================================================

describe("receptionist action — the ledger is append-only, service-role-only and non-executing", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("creates the receptionist_conversation_actions table", () => {
    expect(sql).toMatch(/create table if not exists public\.receptionist_conversation_actions/i);
  });

  it("captures the anchors, the action type, its payload, the status and the metadata", () => {
    for (const column of [
      "org_id",
      "conversation_id",
      "enquiry_id",
      "lead_id",
      "customer_ref",
      "correlation_id",
      "action_type",
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

  it("bounds the action type to the vocabulary {prepare_booking}", () => {
    expect(sql).toMatch(/check\s*\(\s*action_type\s+in\s*\(\s*'prepare_booking'\s*\)\s*\)/i);
  });

  it("NON-EXECUTING BY CONSTRUCTION — status is CHECK-pinned to the single value 'prepared'", () => {
    // The load-bearing R27 storage law: a row can NEVER claim an automatic external business action.
    expect(sql).toMatch(/status\s+text\s+not null\s+default\s+'prepared'/i);
    expect(sql).toMatch(/check\s*\(\s*status\s*=\s*'prepared'\s*\)/i);
  });

  it("bounds the callback number to the E.164 shape and the postcode to its shape in DDL", () => {
    expect(sql).toMatch(/phone_number\s+text\s+check\s*\([\s\S]*?\+\\d\{10,15\}/i);
    expect(sql).toMatch(/postcode\s+text\s+check\s*\([\s\S]*?A-Z/i);
  });

  it("enables RLS with NO policies — service-role / SECURITY DEFINER only", () => {
    expect(sql).toMatch(
      /alter table public\.receptionist_conversation_actions enable row level security/i,
    );
    expect(sql).not.toMatch(/create policy[\s\S]*?on public\.receptionist_conversation_actions/i);
  });

  it("is APPEND-ONLY — UPDATE and DELETE are rejected by triggers", () => {
    expect(sql).toMatch(
      /create or replace function public\.receptionist_conversation_actions_block_mutation\(/i,
    );
    expect(sql).toMatch(/raise exception[\s\S]*?append-only[\s\S]*?tg_op/i);
    expect(sql).toMatch(/errcode\s*=\s*'restrict_violation'/i);
    expect(sql).toMatch(
      /create trigger receptionist_conversation_actions_no_update\s+before update on public\.receptionist_conversation_actions/i,
    );
    expect(sql).toMatch(
      /create trigger receptionist_conversation_actions_no_delete\s+before delete on public\.receptionist_conversation_actions/i,
    );
  });

  it("writes only through a SECURITY DEFINER primitive granted only to service_role", () => {
    expect(sql).toMatch(/create or replace function public\.record_receptionist_conversation_action\(/i);
    expect(sql).toMatch(/returns uuid/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = ''/i);
    expect(sql).toMatch(/insert into public\.receptionist_conversation_actions/i);
    expect(sql).toMatch(/revoke all on function[\s\S]*?from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*?to service_role/i);
  });

  it("REQUIRES a job type plus a well-formed postcode and E.164 number for a prepare_booking", () => {
    expect(sql).toMatch(/p_action_type\s*=\s*'prepare_booking'[\s\S]*?\+\\d\{10,15\}/i);
    expect(sql).toMatch(/p_action_type\s*=\s*'prepare_booking'[\s\S]*?p_job_type is null/i);
  });
});

// =====================================================================
// 7. The runtime prepares ALONGSIDE — not instead of — the audited reply.
// =====================================================================

describe("receptionist action — prepared alongside the audited reply, never bypassing the pipeline", () => {
  const scode = codeOf(read(SERVICE));

  it("runs the UNCHANGED dispatch, records the outcome, THEN prepares the action — in that order", () => {
    // The confirmation is produced and audited by the canonical dispatch; the outcome is recorded, then the
    // action is prepared AFTER both, so the record can never precede or replace the reply.
    expect(scode).toMatch(
      /const dispatch = await dispatchReceptionistReply\([\s\S]{0,1200}recordConversationAction\(/,
    );
    expect(scode).toMatch(/recordConversationOutcome\([\s\S]{0,1200}recordConversationAction\(/);
  });

  it("prepares ONLY for an actionable action on a REAL audited dispatch (idempotent on retries)", () => {
    // Gated on the actionable predicate AND a non-null correlation id — a duplicate dispatch (null
    // correlation) prepares no second action.
    expect(scode).toMatch(/isActionableAction\(action\)/);
    expect(scode).toMatch(/dispatch\.correlation_id\s*!==\s*null/);
  });

  it("threads the action to the dispatch's correlation id — so it joins the confirmation audit and the outcome", () => {
    expect(scode).toMatch(/correlation_id:\s*dispatch\.correlation_id/);
  });

  it("surfaces the action on the turn result without a second reply/generation/transport path", () => {
    expect(scode).toMatch(/action_recorded:/);
    expect(scode).toMatch(/action_id:/);
    // The reply pipeline is still delegated WHOLE to the ONE canonical dispatch — no second send here.
    expect(scode).toMatch(/dispatchReceptionistReply\(input, assembledContext, responseSpec\)/);
  });
});

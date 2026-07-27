import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONVERSATION OUTCOME ENGINE governance invariants
 * (the AI Receptionist Programme, R26 — CONVERSATION OUTCOME ENGINE).
 *
 * R17–R25 built the DERIVING stack (state, intent, goal, information, gap, strategy, prompt, response,
 * generation) — every layer OBSERVES, DERIVES or WORDS; none ACTS. R26 is the FIRST layer that ACTS on a
 * satisfied goal: it RESOLVES an internal OUTCOME and RECORDS it. Its law is exact — "the Outcome Engine may
 * create INTERNAL outcomes; it must NOT execute EXTERNAL business actions automatically, and it must NEVER
 * bypass Policy, Audit, Human Review or Transport." This suite proves that contract as a matter of SOURCE,
 * not discipline — the house bar of tool-registry-describes-not-authorises.test.ts:
 *
 *   • SINGLE WRITE PATH — across all non-test source (app/, server/, lib/), the outcome ledger's write
 *     primitive (`record_receptionist_conversation_outcome`) is named by EXACTLY ONE module: the outcome
 *     server runtime. No other file can file an outcome, so there is no second write path.
 *   • THE PURE CORE IS PURE & MODEL-FREE — it reaches no server / policy / IO / model / clock / RNG, and its
 *     only imports are the adjacent TYPE surfaces plus the ONE R20 validity predicate. It RESOLVES; it
 *     persists nothing.
 *   • IT RESOLVES AN INTERNAL OUTCOME — IT EXECUTES NO EXTERNAL ACTION — the outcome vocabulary is exactly
 *     {callback}; booking and quote map to NO outcome (explicit non-goals); neither the core nor the runtime
 *     reaches a transport, a provider, a generator, or promotes a lead to a customer.
 *   • THE PERSIST IS BEST-EFFORT — the runtime SWALLOWS a failed write (returns null), it never THROWS —
 *     a durable, audited confirmation is never undone by a bookkeeping write (contrast the MANDATORY reply
 *     audit, which throws). And the runtime NEVER generates the confirmation — no model, no reply pipeline.
 *   • THE LEDGER IS APPEND-ONLY, SERVICE-ROLE-ONLY AND NON-EXECUTING — RLS-enabled with no policies,
 *     UPDATE/DELETE rejected by triggers, a SECURITY DEFINER writer granted only to service_role, and its
 *     `status` CHECK-pinned to the single value 'recorded' so a row can NEVER claim an external action.
 *   • THE RUNTIME RECORDS ALONGSIDE — NOT INSTEAD OF — THE AUDITED REPLY — the canonical service runs the
 *     UNCHANGED dispatch (generate → enforce → audit → route) and records the outcome AFTER it, gated on a
 *     real audited dispatch; R26 adds no second reply, generation or transport path.
 *
 * The engine's runtime behaviour (deterministic resolution; a callback recorded and joined to its
 * confirmation audit; append-only; RLS; non-executing status) is pinned against real Postgres in
 * __tests__/integration/receptionist/conversation-outcome-pipeline.test.ts, and the pure core's resolution
 * exhaustively in __tests__/receptionist/conversation-outcome.test.ts. This tier is HERMETIC — a filesystem
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

const CORE = "lib/receptionist/conversation-outcome.ts";
const RUNTIME = "server/services/receptionist-outcome.ts";
const SERVICE = "server/services/receptionist.ts";
const MIGRATION = "supabase/migrations/20260826000000_receptionist_conversation_outcomes.sql";

/** The outcome ledger's write primitive — the function an auditor would call to file a row. */
const WRITE_FN = /\brecord_receptionist_conversation_outcome\b/;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

// =====================================================================
// 0. The engine, the ledger and the runtime all ship, and the service integrates them.
// =====================================================================

describe("receptionist outcome — the engine ships and is wired", () => {
  it(`ships the append-only outcome ledger migration ${MIGRATION}`, () => {
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
    expect(code).toMatch(/export function resolveOutcome\(/);
    expect(code).toMatch(/export function isActionableOutcome\(/);
  });

  it("the server runtime exports the single record entry point", () => {
    expect(codeOf(read(RUNTIME))).toMatch(/export async function recordConversationOutcome\(/);
  });

  it("the canonical service resolves the outcome and records it", () => {
    const specs = importSpecifiers(codeOf(read(SERVICE)));
    expect(specs).toContain("@/lib/receptionist/conversation-outcome");
    expect(specs).toContain("@/server/services/receptionist-outcome");
  });
});

// =====================================================================
// 1. SINGLE WRITE PATH — exactly one module names the outcome ledger write primitive.
// =====================================================================

describe("receptionist outcome — exactly one module writes the ledger", () => {
  const writers = walkSources(SOURCE_ROOTS)
    .filter((full) => WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the ONLY module that names the ledger write primitive is the outcome server runtime", () => {
    // If this list ever grows, a second outcome-write path (or a bypass) has appeared.
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

describe("receptionist outcome — the pure core is pure and model-free", () => {
  const pcode = codeOf(read(CORE));

  it("is a shared pure module (NOT server-only — the runtime and tests import it)", () => {
    expect(importSpecifiers(pcode)).not.toContain("server-only");
  });

  it("its only imports are the adjacent layer TYPES plus the ONE R20 validity predicate", () => {
    // The goal and strategy are TYPE-only imports (it consumes their vocabulary, never their resolvers);
    // the information import is the ONE shared validity value plus a type. No other import is permitted.
    expect(pcode).toMatch(/import type \{\s*ConversationGoal\s*\} from "@\/lib\/receptionist\/conversation-goal"/);
    expect(pcode).toMatch(
      /import type \{\s*ConversationStrategy\s*\} from "@\/lib\/receptionist\/conversation-strategy"/,
    );
    expect(pcode).toMatch(/isValidFieldValue/);
    expect(importSpecifiers(pcode).sort()).toEqual(
      [
        "@/lib/receptionist/conversation-goal",
        "@/lib/receptionist/conversation-information",
        "@/lib/receptionist/conversation-strategy",
      ].sort(),
    );
  });

  it("DUPLICATES NOTHING beneath it — it re-derives no strategy, goal, gap, information or intent", () => {
    // It consumes ALREADY-derived observations; it names none of the resolvers/extractors/detectors.
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

  it("has no clock and no RNG (a resolved outcome is reconstructable)", () => {
    expect(pcode).not.toMatch(/Math\.random/);
    expect(pcode).not.toMatch(/Date\.now/);
    expect(pcode).not.toMatch(/new Date\(/);
  });
});

// =====================================================================
// 3. It RESOLVES an INTERNAL outcome — it EXECUTES NO EXTERNAL business action.
// =====================================================================

describe("receptionist outcome — internal outcomes only, no external business action", () => {
  const pcode = codeOf(read(CORE));
  const rcode = codeOf(read(RUNTIME));

  it("the outcome vocabulary is EXACTLY {callback} — booking / quote outcome types are absent", () => {
    expect(pcode).toMatch(/OUTCOME_TYPES\s*=\s*\[\s*"callback"\s*\]/);
    // Booking and quote are EXPLICIT R26 non-goals — their goals map to NO outcome.
    expect(pcode).toMatch(/arrange_booking:\s*null/);
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

  it("the runtime NEVER promotes a lead to a customer (an explicit R26 non-goal)", () => {
    // It reflects onto the EXISTING lead row only; it never touches the customers table.
    expect(rcode).not.toMatch(/customers/);
    expect(rcode).not.toMatch(/\.from\(["']customers["']\)/);
  });

  it("the runtime writes only the two internal rows — the outcome ledger and the lead reflection", () => {
    expect(rcode).toMatch(WRITE_FN);
    expect(rcode).toMatch(/\.from\("leads"\)/);
  });
});

// =====================================================================
// 4. The persist is BEST-EFFORT — it never gates the turn, and it never generates the confirmation.
// =====================================================================

describe("receptionist outcome — the persist is best-effort, the confirmation is not generated here", () => {
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

  it("is server-only — it is the ONE place a resolved outcome is durably recorded", () => {
    expect(importSpecifiers(rcode)).toContain("server-only");
  });
});

// =====================================================================
// 5. The migration installs an APPEND-ONLY, service-role-only, NON-EXECUTING ledger.
// =====================================================================

describe("receptionist outcome — the ledger is append-only, service-role-only and non-executing", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("creates the receptionist_conversation_outcomes table", () => {
    expect(sql).toMatch(/create table if not exists public\.receptionist_conversation_outcomes/i);
  });

  it("captures the anchors, the outcome type, its payload, the status and the metadata", () => {
    for (const column of [
      "org_id",
      "conversation_id",
      "enquiry_id",
      "lead_id",
      "customer_ref",
      "correlation_id",
      "outcome_type",
      "phone_number",
      "status",
      "metadata",
      "created_at",
    ]) {
      expect(sql, `column ${column}`).toMatch(new RegExp(`\\b${column}\\b`));
    }
  });

  it("bounds the outcome type to the vocabulary {callback}", () => {
    expect(sql).toMatch(/check\s*\(\s*outcome_type\s+in\s*\(\s*'callback'\s*\)\s*\)/i);
  });

  it("NON-EXECUTING BY CONSTRUCTION — status is CHECK-pinned to the single value 'recorded'", () => {
    // The load-bearing R26 storage law: a row can NEVER claim an automatic external business action.
    expect(sql).toMatch(/status\s+text\s+not null\s+default\s+'recorded'/i);
    expect(sql).toMatch(/check\s*\(\s*status\s*=\s*'recorded'\s*\)/i);
  });

  it("bounds the callback number to the E.164 shape in DDL", () => {
    expect(sql).toMatch(/phone_number\s+text\s+check\s*\([\s\S]*?\+\\d\{10,15\}/i);
  });

  it("enables RLS with NO policies — service-role / SECURITY DEFINER only", () => {
    expect(sql).toMatch(
      /alter table public\.receptionist_conversation_outcomes enable row level security/i,
    );
    expect(sql).not.toMatch(/create policy[\s\S]*?on public\.receptionist_conversation_outcomes/i);
  });

  it("is APPEND-ONLY — UPDATE and DELETE are rejected by triggers", () => {
    expect(sql).toMatch(
      /create or replace function public\.receptionist_conversation_outcomes_block_mutation\(/i,
    );
    expect(sql).toMatch(/raise exception[\s\S]*?append-only[\s\S]*?tg_op/i);
    expect(sql).toMatch(/errcode\s*=\s*'restrict_violation'/i);
    expect(sql).toMatch(
      /create trigger receptionist_conversation_outcomes_no_update\s+before update on public\.receptionist_conversation_outcomes/i,
    );
    expect(sql).toMatch(
      /create trigger receptionist_conversation_outcomes_no_delete\s+before delete on public\.receptionist_conversation_outcomes/i,
    );
  });

  it("writes only through a SECURITY DEFINER primitive granted only to service_role", () => {
    expect(sql).toMatch(/create or replace function public\.record_receptionist_conversation_outcome\(/i);
    expect(sql).toMatch(/returns uuid/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = ''/i);
    expect(sql).toMatch(/insert into public\.receptionist_conversation_outcomes/i);
    expect(sql).toMatch(/revoke all on function[\s\S]*?from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*?to service_role/i);
  });

  it("REQUIRES a well-formed E.164 number for a callback in the write primitive", () => {
    expect(sql).toMatch(/p_outcome_type\s*=\s*'callback'[\s\S]*?\+\\d\{10,15\}/i);
  });
});

// =====================================================================
// 6. The runtime records ALONGSIDE — not instead of — the audited reply.
// =====================================================================

describe("receptionist outcome — recorded alongside the audited reply, never bypassing the pipeline", () => {
  const scode = codeOf(read(SERVICE));

  it("runs the UNCHANGED dispatch, THEN records the outcome — in that order", () => {
    // The confirmation is produced and audited by the canonical dispatch (generate → enforce → audit →
    // route); the outcome is recorded AFTER it, so the record can never precede or replace the reply.
    expect(scode).toMatch(/const dispatch = await dispatchReceptionistReply\([\s\S]{0,700}recordConversationOutcome\(/);
  });

  it("records ONLY for an actionable outcome on a REAL audited dispatch (idempotent on retries)", () => {
    // Gated on the actionable predicate AND a non-null correlation id — a duplicate dispatch (null
    // correlation) files no second outcome.
    expect(scode).toMatch(/isActionableOutcome\(outcome\)/);
    expect(scode).toMatch(/dispatch\.correlation_id\s*!==\s*null/);
  });

  it("threads the outcome to the dispatch's correlation id — so it joins the confirmation audit", () => {
    expect(scode).toMatch(/correlation_id:\s*dispatch\.correlation_id/);
  });

  it("surfaces the outcome on the turn result without a second reply/generation/transport path", () => {
    expect(scode).toMatch(/outcome_recorded:/);
    expect(scode).toMatch(/outcome_id:/);
    // The reply pipeline is still delegated WHOLE to the ONE canonical dispatch — no second send here.
    expect(scode).toMatch(/dispatchReceptionistReply\(input, assembledContext, responseSpec\)/);
  });
});

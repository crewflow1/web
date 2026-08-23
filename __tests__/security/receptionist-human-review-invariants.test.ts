import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — HUMAN HANDOFF & REPLY REVIEW INBOX enforcement invariants
 * (the AI Receptionist Programme, R14 — human handoff & reply review inbox).
 *
 * R3's policy defers every `review` reply to a human ("the AI drafts, a HUMAN sends"); R4 files it
 * as an audit row (verdict='review', allowed=false) that then STOPS at the deny-by-default gate.
 * R14 completes that half — an inbox surfaces the held reply, a human owns it, reviews the
 * reconstructed conversation, optionally edits, and SENDS through the EXISTING pipeline, or
 * dismisses. The directive's law is absolute: R14 must be ADDITIVE — "no reply may bypass the
 * existing policy, audit or transport architecture", "do not create a second messaging pipeline",
 * "do not duplicate conversation reconstruction", and "the Reply Review Inbox must become the
 * canonical consumer of the conversation engine". This suite proves that law as a matter of SOURCE,
 * not discipline (the house bar of the R6 live-execution invariants):
 *
 *   • ONE SEND SEAM, STILL GATED BY POLICY + AUDIT — the human send `dispatchHumanReviewedReply`
 *     RE-EVALUATES the policy over the (possibly edited) text and files a MANDATORY audit through
 *     the SAME `writeReplyAudit` primitive BEFORE it ever reaches `transportReply`. A prohibited
 *     `block` returns refused (the blocked reason, no transport) — never sent, not even by a human.
 *   • CAPTIVE — `dispatchHumanReviewedReply` is named by EXACTLY TWO modules: the canonical service
 *     that DEFINES it and the review orchestration service that CONSUMES it. No route, action, or
 *     component can reach the send seam directly.
 *   • THE ORCHESTRATION OPENS NO NEW DOOR — the review service reaches NO provider factory, NO
 *     vendor send, and NO transport/audit write primitive of its own; its ONLY send path is the one
 *     seam. It is not a second pipeline.
 *   • THE CANONICAL CONSUMER — the review service reconstructs a held reply's conversation ONLY
 *     through R11's `reconstructConversation`; it re-implements no reconstruction (never touches the
 *     timeline view or the message table).
 *   • THE ACTION LAYER IS THIN — the HQ actions reach a send ONLY through the orchestration service
 *     (`resolveReviewSend` / `resolveReviewDismiss`), never a lower-level send primitive.
 *   • THE SUBSTRATE IS HQ-SEALED — the review queue is a `security_invoker` projection filtered to
 *     `verdict = 'review'` (so allow/block replies can never surface), granted to service_role only;
 *     the resolution ledger is RLS-with-zero-policies, APPEND-ONLY (update/delete rejected), written
 *     through a single service_role-only primitive.
 *
 * The OFF/ON runtime behaviour (review enters the inbox; allow bypasses; edits audited; sends
 * transported; block refused; dismiss; terminal resolution; org-scoped ownership) is pinned against
 * real Postgres in __tests__/integration/receptionist/review-inbox-pipeline.test.ts. This tier is
 * HERMETIC — a filesystem scan over comment-stripped source — so the prose documenting the contract
 * can neither satisfy a positive match nor trip a negative.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip block + line comments so only executable TS source is matched. */
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `://` in URLs)
}

/** Strip SQL comments (`-- line` and `/* block *​/`) so migration prose can't satisfy a match. */
function sqlCodeOf(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "");
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

const SERVICE = "server/services/receptionist.ts";
const REVIEW_SERVICE = "server/services/receptionist-review.ts";
const REVIEW_ACTIONS = "app/admin/ai-receptionist/review/actions.ts";
const CONV_READS = "server/services/receptionist-conversation-reads.ts";
const MIGRATION = "supabase/migrations/20260821000000_receptionist_human_review_inbox.sql";

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

/** The human-reviewed send seam — the ONE door a human decision reaches a send through. */
const HUMAN_SEND = /\bdispatchHumanReviewedReply\b/;
/** The R11 canonical reconstruction — the ONE way to rebuild a conversation. */
const RECONSTRUCT = /\breconstructConversation\b/;
/** The timeline view + message table R11 reads — the review service must touch NEITHER. */
const TIMELINE_VIEW = /receptionist_conversation_timeline/;
const MESSAGE_TABLE = /receptionist_messages/;

// =====================================================================
// 0. The human-reviewed send seam ships — policy + audit BEFORE transport, block refused.
// =====================================================================

describe("receptionist human review — the send seam re-enforces policy and audits before transport", () => {
  const code = codeOf(read(SERVICE));
  // Bound assertions to the seam's own body — from its `export` to the NEXT top-level `export` —
  // so markers that recur elsewhere (the autonomous dispatchReply also calls transportReply) can't
  // leak into an ordering/negative check.
  const seamStart = code.indexOf("export async function dispatchHumanReviewedReply(");
  const seamEnd = code.indexOf("\nexport ", seamStart + 1);
  const seam = code.slice(seamStart, seamEnd === -1 ? undefined : seamEnd);

  it("exports dispatchHumanReviewedReply — the single human-reviewed send seam", () => {
    expect(seamStart).toBeGreaterThan(-1);
  });

  it("RE-EVALUATES the policy over the human's (possibly edited) text", () => {
    expect(seam).toMatch(/enforceReceptionistReply\(/);
  });

  it("files a MANDATORY audit through the SAME writeReplyAudit primitive BEFORE any transport", () => {
    expect(seam).toMatch(/writeReplyAudit\([\s\S]*?transportReply\(/);
  });

  it("the seam NEVER writes an audit or transport with a raw insert — only the shared primitives", () => {
    expect(seam).not.toMatch(/\.insert\(/);
    // The seam does not reach the transport/audit RPCs directly; it goes through the helpers that do.
    expect(seam).not.toMatch(/record_ai_reply_transport/);
    expect(seam).not.toMatch(/record_ai_reply_audit/);
  });

  it("REFUSES a block: verdict=block, allowed=false, blocked reason, and no transport in that branch", () => {
    // The block branch returns the blocked failure reason with attempted:false…
    expect(seam).toMatch(
      /automaticVerdict === "block"[\s\S]*?verdict:\s*"block"[\s\S]*?allowed:\s*false[\s\S]*?failure_reason:\s*HUMAN_REVIEWED_BLOCKED_REASON/,
    );
    // …and it returns BEFORE the transport call (the block branch's return precedes transportReply).
    const blockAt = seam.search(/automaticVerdict === "block"/);
    const transportAt = seam.search(/await transportReply\(/);
    expect(blockAt).toBeGreaterThan(-1);
    expect(transportAt).toBeGreaterThan(blockAt);
  });

  it("the cleared send is idempotent on the held reply and stamped with the human-reviewed producer", () => {
    expect(seam).toMatch(
      /transportReply\(\{[\s\S]*?dedup_key:\s*input\.review_audit_id[\s\S]*?producer:\s*HUMAN_REVIEWED_PRODUCER/,
    );
  });
});

// =====================================================================
// 1. CAPTIVE — the human send is named by exactly the service + the orchestration service.
// =====================================================================

describe("receptionist human review — the send seam is captive", () => {
  const reachers = walkSources(SOURCE_ROOTS)
    .filter((full) => HUMAN_SEND.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("dispatchHumanReviewedReply is named by EXACTLY TWO modules — the service (defines) + the orchestration (consumes)", () => {
    // If this list ever grows, a third surface can reach the human send around the orchestration.
    expect(reachers).toEqual([SERVICE, REVIEW_SERVICE].sort());
  });

  it("no app/ route, action, or component reaches the send seam directly", () => {
    expect(reachers.filter((p) => p.startsWith("app/"))).toEqual([]);
  });
});

// =====================================================================
// 2. NO NEW DOOR — the orchestration opens no provider / transport / audit path of its own.
// =====================================================================

describe("receptionist human review — the orchestration opens no new send door", () => {
  const code = codeOf(read(REVIEW_SERVICE));

  it("reaches NO provider factory and NO vendor send", () => {
    expect(code).not.toMatch(/getSmsProvider\s*\(/);
    expect(code).not.toMatch(/provider\.send\s*\(/);
  });

  it("writes NO transport and NO audit of its own — those live behind the one seam", () => {
    expect(code).not.toMatch(/transportReply\s*\(/);
    expect(code).not.toMatch(/recordTransport\s*\(/);
    expect(code).not.toMatch(/record_ai_reply_transport/);
    expect(code).not.toMatch(/record_ai_reply_audit/);
  });

  it("its ONLY send path is the canonical human-reviewed seam", () => {
    expect(code).toMatch(HUMAN_SEND);
    expect(importSpecifiers(code)).toContain("@/server/services/receptionist");
    // No vendor SDK, no direct comms provider import.
    expect(importSpecifiers(code)).not.toContain("twilio");
    expect(importSpecifiers(code).some((s) => /comms\/providers\//.test(s))).toBe(false);
  });
});

// =====================================================================
// 3. CANONICAL CONSUMER — reconstruction is delegated to R11, never re-implemented.
// =====================================================================

describe("receptionist human review — the inbox is the canonical consumer of the conversation engine", () => {
  const code = codeOf(read(REVIEW_SERVICE));

  it("reconstructs a held reply's conversation THROUGH reconstructConversation", () => {
    expect(code).toMatch(RECONSTRUCT);
    expect(importSpecifiers(code)).toContain(
      "@/server/services/receptionist-conversation-reads",
    );
  });

  it("re-implements NO reconstruction — never touches the timeline view or the message table", () => {
    expect(code).not.toMatch(TIMELINE_VIEW);
    expect(code).not.toMatch(MESSAGE_TABLE);
  });

  it("the reconstruction itself remains captive to the R11 read model", () => {
    // The timeline view is read in exactly one module — the R11 read model — not the inbox.
    const timelineReaders = walkSources(SOURCE_ROOTS)
      .filter((full) => TIMELINE_VIEW.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(timelineReaders).toEqual([CONV_READS]);
  });
});

// =====================================================================
// 4. THIN ACTIONS — the HQ actions reach a send only through the orchestration service.
// =====================================================================

describe("receptionist human review — the action layer is thin", () => {
  const code = codeOf(read(REVIEW_ACTIONS));

  it("sends/dismisses ONLY through the orchestration service", () => {
    expect(code).toMatch(/resolveReviewSend\(/);
    expect(code).toMatch(/resolveReviewDismiss\(/);
  });

  it("reaches NO send seam, provider or transport primitive directly", () => {
    expect(code).not.toMatch(HUMAN_SEND);
    expect(code).not.toMatch(/getSmsProvider\s*\(/);
    expect(code).not.toMatch(/transportReply\s*\(/);
    expect(code).not.toMatch(/record_ai_reply_transport/);
  });
});

// =====================================================================
// 5. HQ-SEALED SUBSTRATE — the queue projection and the resolution ledger, in the migration.
// =====================================================================

describe("receptionist human review — the review queue is a service_role-only projection of held replies", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("is a security_invoker view (inherits the caller's RLS — no ambient elevation)", () => {
    expect(sql).toMatch(
      /create or replace view public\.receptionist_review_queue\s+with \(security_invoker = true\)/,
    );
  });

  it("projects ONLY held replies — filtered to verdict = 'review' (allow/block never surface)", () => {
    expect(sql).toMatch(/where\s+a\.verdict\s*=\s*'review'/);
  });

  it("is granted to service_role ONLY (revoked from every JWT role first)", () => {
    expect(sql).toMatch(
      /revoke all on public\.receptionist_review_queue from public, anon, authenticated, service_role/,
    );
    expect(sql).toMatch(/grant select on public\.receptionist_review_queue to service_role/);
  });
});

describe("receptionist human review — the resolution ledger is RLS-sealed and append-only", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("enables RLS on the resolution ledger with ZERO policies (deny by default)", () => {
    expect(sql).toMatch(
      /alter table public\.receptionist_review_resolutions enable row level security/,
    );
    // The whole migration creates no policy at all — RLS-with-zero-policies is deny-by-default.
    expect(sql).not.toMatch(/create\s+policy/i);
  });

  it("is APPEND-ONLY — update AND delete are rejected by triggers", () => {
    expect(sql).toMatch(/before update on public\.receptionist_review_resolutions/);
    expect(sql).toMatch(/before delete on public\.receptionist_review_resolutions/);
    expect(sql).toMatch(/is append-only/);
  });

  it("is written through a single service_role-only primitive", () => {
    expect(sql).toMatch(
      /grant execute on function public\.record_receptionist_review_resolution\([\s\S]*?\)\s*to service_role/,
    );
    expect(sql).toMatch(
      /revoke all on function public\.record_receptionist_review_resolution\([\s\S]*?\)\s*from public, anon, authenticated/,
    );
  });

  it("resolution is TERMINAL — a unique index makes a held reply resolvable exactly once", () => {
    expect(sql).toMatch(
      /unique index[\s\S]*?on public\.receptionist_review_resolutions \(review_audit_id\)/,
    );
  });
});

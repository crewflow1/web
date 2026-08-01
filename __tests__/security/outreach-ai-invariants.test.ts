import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * CrewFlow HQ — Outreach AI security invariants
 * (CEO Directive 010, Phase 1 — Infrastructure Reuse Audit).
 *
 * Outreach AI is the first AI employee whose output is meant to reach a CUSTOMER.
 * That makes its trust boundary different from its siblings:
 *
 *   • Research AI is read+draft and gated (requires_approval=true), but its
 *     drafts are internal preparation; Lead Qualification AI is autonomous
 *     (requires_approval=false) but only ever makes an internal, reversible
 *     classification. Outreach AI is the case both were careful to avoid: it
 *     prepares words a human may then send to a prospect. So the V1 safety story
 *     is the strictest one the programme has: Draft → Human Review → Approval →
 *     Send. There is NO autonomous customer communication.
 *
 * Phase 1 shipped the reuse audit's output — the seed migration that registers the
 * employee and its honest provenance source, reusing everything else. Phase 4 adds
 * the RUNNER: it binds the inert `generate_email` task type to a handler and drives
 * it through the canonical runner SDK (server/sdk/tasks.ts) — the SAME governed,
 * observable lifecycle Research AI and Lead Qualification AI already run on. This
 * suite pins BOTH the migration's contract AND the runner's trust boundary, against
 * SOURCE TEXT. The migration checks run over `exec` (SQL with `--` comments
 * stripped); the TS checks run over `code` (TS with `//` + block comments stripped)
 * — so the prose that DOCUMENTS the contract can neither satisfy a positive match
 * nor trip a negative one.
 *
 * The load-bearing runner facts these pin, and what breaks if one silently flips:
 *   • EXECUTION STAYS LOCKED — the runner imports no Executor, calls no apply/execute,
 *     and flips no execution env (CREWFLOW_EXECUTOR_SHADOW). This train moves the
 *     employee onto the shared LIFECYCLE only; it adds NO autonomous behaviour.
 *   • The one AI call routes through the GOVERNED Draft Engine (generateDraft →
 *     invokeWithGovernor), never a direct provider SDK — so a vendor key alone can
 *     never bypass the £100/month ceiling.
 *   • The runner is server-only, reaches the DB through the service-role admin client,
 *     never reads a tenant CRM table, and never touches the spine truth log.
 *   • The execution layer is the GENERIC Task Engine — enqueue through the service
 *     path, run through the runner SDK, no hand-rolled queue, no raw hq_ai_tasks write.
 *   • The cron drain is secret-gated AND registered in vercel.json.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// Strip SQL line comments (-- … EOL).
function execOf(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

// Strip TS block + line comments so a negative match can't be tripped by prose in a
// doc comment, while preserving the `://` of any URL.
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const MIGRATION = "supabase/migrations/20260729000000_outreach_ai_employee.sql";
const RUNNER = "server/services/hq-outreach.ts";
const DRAFT_ENGINE = "server/services/hq-drafts.ts";
const CRON_ROUTE = "app/api/cron/outreach-drain/route.ts";
const VERCEL = "vercel.json";

// Tenant / customer-facing tables the HQ prospect engine must never read.
const TENANT_TABLES = [
  "organizations",
  "organisations",
  "customers",
  "leads",
  "jobs",
  "quotes",
  "invoices",
] as const;

// =====================================================================
// 0. The migration ships and stays Foundation-safe (no new attack surface),
//    and records the reuse audit: it mints NO new work-kind vocabulary.
// =====================================================================

describe("outreach-ai — the employee migration adds work, not a new data surface", () => {
  it(`${MIGRATION} exists`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION))).toBe(true);
  });

  const exec = execOf(read(MIGRATION));

  it("adds the Outreach AI employee to the existing ai_employees table", () => {
    expect(exec).toMatch(/insert\s+into\s+public\.ai_employees/i);
    expect(exec).toMatch(/'outreach-ai'/);
  });

  it("seeds its honest provenance source slug (so outreach events are not mislabelled)", () => {
    expect(exec).toMatch(/insert\s+into\s+public\.hq_sales_sources/i);
    expect(exec).toMatch(/'ai_outreach'/);
  });

  it("REUSES the inert generate_email task type — it mints no new work-kind vocabulary", () => {
    // The reuse decision, pinned: the migration inserts NO task type at all (it
    // reuses the foundation's `generate_email`), and in particular never mints
    // the parallel `draft_outreach` slug the audit considered and rejected. The
    // assertion targets the quoted SLUG literal — distinct from the descriptive
    // `draft_outreach_email` tool name, which legitimately drafts (never sends).
    expect(exec).not.toMatch(/insert\s+into\s+public\.hq_sales_task_types/i);
    expect(exec).not.toMatch(/'draft_outreach'/);
  });

  it("creates NO new table (it reuses the Directive-004 hq_sales_* family wholesale)", () => {
    expect(exec).not.toMatch(/create\s+table/i);
  });

  it("declares NO policy and NO escalation surface (no SECURITY DEFINER, no dynamic SQL)", () => {
    expect(exec).not.toMatch(/create\s+policy/i);
    expect(exec).not.toMatch(/security\s+definer/i);
    expect(exec).not.toMatch(/\bexecute\s+format\(/i);
    expect(exec).not.toMatch(/\bexecute\s+'/i);
  });

  it("is idempotent — re-running never clobbers operator edits", () => {
    expect(exec).toMatch(/on\s+conflict\s*\(slug\)\s*do\s+nothing/i);
  });
});

// =====================================================================
// 1. The V1 safety contract — Draft → Human Review → Approval → Send.
//    The load-bearing invariant: this employee is gated and carries NO send.
// =====================================================================
//
// Outreach AI's drafts can reach a customer, so the only thing standing between
// a draft and a prospect is a human approval. Two facts make that true and must
// never silently flip: requires_approval=true (a human gates every draft), and a
// scope set that GRANTS no 'send' (sending is never an employee capability in V1
// — it is a separate, human-recorded act). If approval flipped to false, or a
// 'send'/'delete'/'write' scope ever appeared, the V1 safety story would be void.

describe("outreach-ai — the V1 safety contract is pinned in the permission grant", () => {
  const exec = execOf(read(MIGRATION));

  it("is gated — requires_approval=true (no autonomous customer communication in V1)", () => {
    expect(exec).toMatch(/"requires_approval":\s*true/);
  });

  it("is permitted to execute, but ONLY within read/draft/memory scopes", () => {
    expect(exec).toMatch(/"can_execute":\s*true/);
    // The exact, complete scope set — read, draft, remember. Nothing more.
    expect(exec).toMatch(/"scopes":\s*\["read","draft","memory"\]/);
  });

  it("the grant structurally excludes send and every irreversible scope", () => {
    // Sending is human-gated, never an employee scope; the grant must also never
    // silently acquire the ability to delete or write.
    const grant = exec.match(/"scopes":\s*\[[^\]]*\]/)?.[0] ?? "";
    expect(grant).not.toMatch(/"send"/);
    expect(grant).not.toMatch(/"delete"/);
    expect(grant).not.toMatch(/"write"/);
  });
});

// =====================================================================
// 2. A model IS wired — drafting outreach prose is generative.
//    (The exact inverse of Lead Qualification AI, which is deterministic.)
// =====================================================================

describe("outreach-ai — the employee is generative (a model is wired)", () => {
  const exec = execOf(read(MIGRATION));

  it("wires a model provider + name (anthropic / claude-haiku-4-5) — not NULL", () => {
    expect(exec).toMatch(/'anthropic'/);
    expect(exec).toMatch(/'claude-haiku-4-5'/);
    // …and is NOT the deterministic null,null shape that Lead Qualification uses.
    expect(exec).not.toMatch(/\bnull,\s*null,/i);
  });
});

// =====================================================================
// 3. Registration facts — the employee lands in the right place, idle.
// =====================================================================

describe("outreach-ai — the employee is registered correctly", () => {
  const exec = execOf(read(MIGRATION));

  it("joins the sales department with an organisation-wide memory scope, idle", () => {
    expect(exec).toMatch(/'sales'/);
    expect(exec).toMatch(/'organization'/);
    expect(exec).toMatch(/'idle'/);
  });
});

// =====================================================================
// 4. The runner obeys its trust boundary — server-only, service-role, decoupled,
//    and routes AI ONLY through the governed Draft Engine (Phase 4).
// =====================================================================

describe("outreach-ai — the runner obeys its trust boundary", () => {
  const raw = read(RUNNER);
  const code = codeOf(raw);

  it("is a server-only module (cannot be pulled into a client bundle)", () => {
    expect(raw).toMatch(/^import "server-only";/m);
  });

  it("reaches the database through the service-role admin client", () => {
    expect(code).toMatch(/createAdminClient/);
  });

  it("NEVER reads a tenant CRM table (the prospect engine never touches customer data)", () => {
    for (const tenant of TENANT_TABLES) {
      expect(code).not.toMatch(
        new RegExp(`(\\.from\\(|table<[^>]*>\\()\\s*["'\`]${tenant}\\b`, "i"),
      );
    }
  });

  it("NEVER touches the spine truth log (hq_events is the spine's; outreach has its own timeline)", () => {
    expect(code).not.toMatch(/hq_events/);
  });

  it("routes AI ONLY through the GOVERNED Draft Engine (generateDraft) — never a direct provider SDK", () => {
    // The one generative call goes through hq-drafts.generateDraft, which is the
    // single place invokeWithGovernor gates the spend. The runner must not reach a
    // vendor SDK or the raw text provider itself — that is precisely the bypass the
    // governance closure exists to remove.
    expect(code).toMatch(
      /import\s*\{[^}]*\bgenerateDraft\b[^}]*\}\s*from\s*["']@\/server\/services\/hq-drafts["']/,
    );
    expect(code).toMatch(/\bgenerateDraft\s*\(/);
    expect(code).not.toMatch(/@anthropic-ai/);
    expect(code).not.toMatch(/\bgetTextProvider\b/);
    expect(code).not.toMatch(/from\s*["']openai["']/);
  });
});

describe("outreach-ai — the Draft Engine it delegates to is the governor boundary", () => {
  const code = codeOf(read(DRAFT_ENGINE));

  it("routes every model call through invokeWithGovernor (the £100/month ceiling)", () => {
    expect(code).toMatch(/invokeWithGovernor\(/);
  });

  it("degrades to the deterministic draft when the governed leg cannot spend (DARK-safe)", () => {
    // No provider / no budget-org / budget refusal / duplicate all fall back to the
    // deterministic leg — so an unbound tier COMPLETES the run, never fails it.
    expect(code).toMatch(/fallbackBuilt\(/);
    expect(code).toMatch(/"deterministic"/);
  });
});

// =====================================================================
// 5. EXECUTION STAYS LOCKED — the train adds NO autonomous behaviour. The runner
//    and the cron never touch the executor and never flip an execution env.
// =====================================================================

describe("outreach-ai — execution stays LOCKED (no Executor, no execution env flip)", () => {
  for (const file of [RUNNER, CRON_ROUTE]) {
    const code = codeOf(read(file));

    it(`${file} imports NO executor and calls no apply/execute`, () => {
      expect(code).not.toMatch(/from\s*["']@\/server\/sdk\/executor["']/);
      expect(code).not.toMatch(/\bExecutor\b/);
      expect(code).not.toMatch(/\.apply\s*\(/);
      expect(code).not.toMatch(/\.execute\s*\(/);
    });

    it(`${file} flips NO execution env (never references CREWFLOW_EXECUTOR_SHADOW)`, () => {
      expect(code).not.toMatch(/CREWFLOW_EXECUTOR_SHADOW/);
    });
  }
});

// =====================================================================
// 6. The execution layer runs on the GENERIC Task Engine, not a bespoke queue
//    (Directive #012 / D-02). Outreach's work is ENQUEUED through the sanctioned
//    service path and RUN through the canonical runner SDK — every claim /
//    heartbeat / checkpoint / completion / failure / retry is the engine's.
// =====================================================================

describe("outreach-ai — the execution layer runs on the generic Task Engine", () => {
  const code = codeOf(read(RUNNER));

  it("ENQUEUES through the sanctioned service path (enqueueTask), never a hand-rolled queue insert", () => {
    expect(code).toMatch(
      /import\s*\{[^}]*\benqueueTask\b[^}]*\}\s*from\s*["']@\/server\/services\/hq-tasks["']/,
    );
    expect(code).toMatch(/\benqueueTask\s*\(/);
  });

  it("EXECUTES through the canonical runner SDK — register + claim-one + drain (server/sdk/tasks)", () => {
    expect(code).toMatch(/from\s*["']@\/server\/sdk\/tasks["']/);
    expect(code).toMatch(/\bregisterTaskHandler\s*\(/);
    expect(code).toMatch(/\brunReadyTask\s*\(/);
    expect(code).toMatch(/\bdrainTaskType\s*\(/);
  });

  it("REUSES the reserved generate_email task type — it mints no new work-kind vocabulary", () => {
    expect(code).toMatch(/OUTREACH_TASK_TYPE\s*=\s*["']generate_email["']/);
  });

  it("owns no queue table — never names the retired bespoke hq_sales_ai_tasks", () => {
    expect(code).not.toMatch(/hq_sales_ai_tasks/);
  });

  it("never raw-writes the generic queue — mutations go through the entry points; only reads are direct", () => {
    const oneLine = code.replace(/\s+/g, " ");
    expect(oneLine).not.toMatch(
      /\.from\(\s*["'`]hq_ai_tasks["'`](\s+as\s+never)?\s*\)\s*\.(insert|update|delete|upsert)\b/,
    );
  });
});

// =====================================================================
// 7. The cron drain is secret-gated AND registered in vercel.json.
// =====================================================================

describe("outreach-ai — the cron drain is secret-gated and scheduled", () => {
  const code = codeOf(read(CRON_ROUTE));

  it("requires the cron secret and answers 401 otherwise", () => {
    expect(code).toMatch(/isCronAuthorised\(request\)/);
    expect(code).toMatch(/status:\s*401/);
  });

  it("drains through the runner-backed service entry point (drainOutreachTasks)", () => {
    expect(code).toMatch(/\bdrainOutreachTasks\s*\(/);
  });

  it("is registered in vercel.json so it actually runs", () => {
    const vercel = JSON.parse(read(VERCEL)) as { crons: Array<{ path: string; schedule: string }> };
    const entry = vercel.crons.find((c) => c.path === "/api/cron/outreach-drain");
    expect(entry, "outreach-drain missing from vercel.json crons").toBeTruthy();
    // The sibling drains (research / qualification) run every 5 minutes; match them.
    expect(entry?.schedule).toBe("*/5 * * * *");
  });
});

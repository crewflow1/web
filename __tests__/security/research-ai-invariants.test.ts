import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * CrewFlow HQ — Company Research AI security invariants
 * (CEO Directive 005, the first operational AI employee; hardened under
 * Directive 003 to the six-gate bar — Module 2).
 *
 * Research AI is the engine that brings the inert Directive-004 hq_sales_*
 * schema to life. The data surface itself is pinned by the Module-1 invariants
 * (RLS:hq, zero policies, no escalation, tenant-decoupled); THIS suite pins the
 * trust boundary of the EXECUTION layer that the runner adds on top. Like the
 * other security suites it has no database here (the live RLS denial + the live
 * run are proven in the integration tier), so it pins the contract against
 * SOURCE TEXT. These are the assertions that, if they ever silently flipped,
 * would be a hole:
 *   • the migration growing a new table / policy / escalation surface, or the
 *     employee losing its requires_approval / read-draft-only permission set;
 *   • the runner reading a tenant CRM table, touching the spine truth log, or
 *     being importable into a client bundle;
 *   • the fetch layer losing its SSRF guard (private-host block, redirect
 *     re-check, body size cap) or starting to write (non-GET);
 *   • the model layer throwing instead of degrading to null without a key;
 *   • an /admin/research route or action escaping the Super-Admin allowlist, or
 *     the gate announcing the surface's existence with a 403 instead of a 404;
 *   • a run kicker / poller accepting an unvalidated id, or the cron drain
 *     losing its secret;
 *   • the execution layer regressing off the generic Task Engine (Directive
 *     #012 / D-02) — research hand-rolling a queue insert or its own stuck-
 *     detection instead of enqueueing through the service path and running
 *     through the canonical runner SDK.
 *
 * The migration checks run over `exec` (SQL with `--` comments stripped); the
 * TS checks run over `code` (TS with `//` + block comments stripped) — so the
 * prose that DOCUMENTS the contract (e.g. a header naming a tenant table while
 * describing the decoupling rule) can never satisfy a positive match or trip a
 * negative one.
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

// Strip TS block + line comments so a negative match can't be tripped by prose
// in a doc comment, while preserving the `://` of any URL.
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// The module's source files.
const MIGRATION = "supabase/migrations/20260718000000_research_ai_employee.sql";
const RUNNER = "server/services/hq-research.ts";
const FETCH = "server/services/research-fetch.ts";
const LLM = "server/services/research-llm.ts";
const RUN_ROUTE = "app/api/admin/research/run/route.ts";
const STATE_ROUTE = "app/api/admin/research/state/[taskId]/route.ts";
const CRON_ROUTE = "app/api/cron/research-drain/route.ts";
const ACTIONS = "app/admin/research/actions.ts";
const ADMIN_LAYOUT = "app/admin/layout.tsx";

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
// 0. The migration ships and stays Foundation-safe (no new attack surface)
// =====================================================================

describe("research-ai — the employee migration adds work, not a new data surface", () => {
  it(`${MIGRATION} exists`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION))).toBe(true);
  });

  const exec = execOf(read(MIGRATION));

  it("adds the Research AI employee to the existing ai_employees table", () => {
    expect(exec).toMatch(/insert\s+into\s+public\.ai_employees/i);
    expect(exec).toMatch(/'research-ai'/);
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
// 1. Read + draft only — pinned in the employee's permission grant
// =====================================================================

describe("research-ai — the employee is read + draft only at the permission layer", () => {
  const exec = execOf(read(MIGRATION));

  it("requires human approval for any outbound artifact (requires_approval)", () => {
    expect(exec).toMatch(/"requires_approval":\s*true/);
  });

  it("is permitted to execute work but only within read/research/draft/score/memory scopes", () => {
    expect(exec).toMatch(/"can_execute":\s*true/);
    // The exact, complete scope set — which structurally excludes a send or a
    // delete scope. Drafting outreach is `draft`, never `send`.
    expect(exec).toMatch(/"scopes":\s*\["read","research","draft","score","memory"\]/);
  });
});

// =====================================================================
// 2. The runner obeys its trust boundary — server-only, service-role, decoupled
// =====================================================================

describe("research-ai — the runner obeys its trust boundary", () => {
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

  it("NEVER touches the spine truth log (hq_events is the spine's; research has its own timeline)", () => {
    expect(code).not.toMatch(/hq_events/);
  });

  it("attributes every AI-authored artifact as generated_by='ai' (traceability)", () => {
    expect(code).toMatch(/generatedBy:\s*"ai"/);
  });
});

// =====================================================================
// 3. The fetch layer is SSRF-hardened and read-only
// =====================================================================

describe("research-ai — the fetch layer is SSRF-hardened and reads only", () => {
  const raw = read(FETCH);
  const code = codeOf(raw);

  it("is a server-only module", () => {
    expect(raw).toMatch(/^import "server-only";/m);
  });

  it("refuses non-public hosts (localhost, RFC-1918, link-local, .internal/.local)", () => {
    expect(code).toMatch(/function\s+isPrivateHost/);
    expect(code).toMatch(/"localhost"/);
    expect(code).toMatch(/169.*254/); // link-local 169.254/16
    expect(code).toMatch(/\.internal/);
  });

  it("re-checks the host on every redirect hop (a redirect can never land private)", () => {
    expect(code).toMatch(/redirected-to-private/);
  });

  it("caps the response body so a hostile page cannot exhaust memory", () => {
    expect(code).toMatch(/MAX_BODY_BYTES/);
  });

  it("reads only — it issues GETs and never a write method", () => {
    expect(code).toMatch(/method:\s*["']GET["']/);
    expect(code).not.toMatch(/method:\s*["']POST["']/i);
    expect(code).not.toMatch(/method:\s*["']PUT["']/i);
    expect(code).not.toMatch(/method:\s*["']DELETE["']/i);
  });
});

// =====================================================================
// 4. The model layer degrades gracefully — null without a key, never a throw
// =====================================================================

describe("research-ai — the model layer degrades gracefully (no key ⇒ deterministic)", () => {
  const raw = read(LLM);
  const code = codeOf(raw);

  it("is a server-only module", () => {
    expect(raw).toMatch(/^import "server-only";/m);
  });

  it("returns null when no model can be reached (the runner then goes deterministic)", () => {
    // The gate is now ACTIVATION, checked before any key is read. The old
    // `if (!anthropicKey && !openaiKey) return null` was satisfied by a
    // credential alone, so a key on a deploy ran both research calls — 2,800 and
    // 3,200 output tokens on the `complex` class — with no £100/month ceiling and
    // no ledger row. The key check survives one layer down, inside the governed
    // provider leg, where it can no longer be the only thing standing between a
    // credential and a bill.
    expect(code).toMatch(/if\s*\(!isTierActivated\(\"high\"\)\)\s*return null;/);
    expect(code).toMatch(/if\s*\(!budgetOrgId\)\s*return null;/);
    expect(code).toMatch(/if\s*\(!anthropicKey\s*&&\s*!openaiKey\)/);
    expect(code).toMatch(/export function researchAiEnabled/);
  });

  it("both research calls are GOVERNED, under SEPARATE feature keys", () => {
    // Separate keys so the HQ per-feature cost rollup can tell the analysis pass
    // from the sales-prep pass; they are distinct prompts with distinct spend.
    expect(code).toMatch(/invokeWithGovernor\(/);
    expect(code).toMatch(/callJson\(\s*"research\.analysis"/);
    expect(code).toMatch(/callJson\(\s*"research\.sales_prep"/);
    // The vendor FALLBACK stays INSIDE one governed call: an Anthropic attempt
    // that fails and an OpenAI attempt that succeeds are one unit of work against
    // the budget, and reserving twice would double-count the claim.
    const governed = code.slice(code.indexOf("async function callJson("));
    expect((governed.match(/invokeWithGovernor\(/g) ?? []).length).toBe(1);
  });
});

// =====================================================================
// 5. The HTTP surface is HQ-gated (404, not 403) with validated input
// =====================================================================

describe("research-ai — the run + state routes are Super-Admin gated with non-disclosure", () => {
  for (const route of [RUN_ROUTE, STATE_ROUTE]) {
    const code = codeOf(read(route));

    it(`${route} authenticates and reduces to the isSuperAdminEmail allowlist`, () => {
      expect(code).toMatch(/requireUser\(\)/);
      expect(code).toMatch(/isSuperAdminEmail/);
    });

    it(`${route} answers 404 for a non-allowlisted caller and NEVER 403`, () => {
      expect(code).toMatch(/status:\s*404/);
      expect(code).not.toMatch(/403/);
    });

    it(`${route} validates the task id as a UUID before use`, () => {
      expect(code).toMatch(/UUID_RE/);
      expect(code).toMatch(/status:\s*400/);
    });
  }
});

describe("research-ai — the cron drain is secret-gated", () => {
  const code = codeOf(read(CRON_ROUTE));

  it("requires the cron secret and answers 401 otherwise", () => {
    expect(code).toMatch(/isCronAuthorised\(request\)/);
    expect(code).toMatch(/status:\s*401/);
  });
});

// =====================================================================
// 6. The server actions re-check the allowlist and audit the launch
// =====================================================================

describe("research-ai — the launcher actions re-check the allowlist (defence in depth)", () => {
  const raw = read(ACTIONS);
  const code = codeOf(raw);

  it("is a server action module", () => {
    expect(raw).toMatch(/^"use server";/m);
  });

  it("re-checks isSuperAdminEmail and bounces a non-admin (never trusts the layout alone)", () => {
    expect(code).toMatch(/isSuperAdminEmail/);
    expect(code).toMatch(/redirect\(/);
  });

  it("audits every launch to the admin activity log", () => {
    expect(code).toMatch(/recordAdminActivity/);
  });
});

// =====================================================================
// 7. The whole surface inherits the single HQ gate (404, not 403)
// =====================================================================

describe("research-ai — /admin/research inherits the single HQ chokepoint", () => {
  it("the admin layout (parent of every /admin/research route) gates on requireHqPage()", () => {
    // Every app/admin/research/** page is a child of app/admin/layout.tsx, so
    // the layout's gate is the single chokepoint for the Research AI UI.
    expect(read(ADMIN_LAYOUT)).toMatch(/await requireHqPage\(\)/);
  });
});

// =====================================================================
// 8. The execution layer runs on the GENERIC Task Engine, not a bespoke queue
//    (CEO Directive #012 / D-02, PR-E). Research-ai's work is ENQUEUED through
//    the sanctioned service path and RUN through the canonical runner SDK, so
//    every claim / heartbeat / checkpoint / completion / failure / retry is the
//    engine's — the runner hand-rolls no queue and no stuck-detection of its own.
//    (The global operator "AI Task Queue" view stays on hq_sales_ai_tasks until
//    PR-G; this pins only research-ai's OWN execution path.)
// =====================================================================

describe("research-ai — the execution layer runs on the generic Task Engine (Directive #012 / D-02, PR-E)", () => {
  const raw = read(RUNNER);
  const code = codeOf(raw);

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

  it("binds to the durable task_type contract the engine drains on — research_company", () => {
    expect(code).toMatch(/RESEARCH_TASK_TYPE\s*=\s*["']research_company["']/);
  });

  it("RETIRES the bespoke stuck-detection — STUCK_RUNNING_MS is gone (leases + reaper + engine retry replace it)", () => {
    expect(code).not.toMatch(/STUCK_RUNNING_MS/);
  });

  it("sheds its old bespoke queue entirely — never names hq_sales_ai_tasks (it owns no queue table)", () => {
    expect(code).not.toMatch(/hq_sales_ai_tasks/);
  });

  it("never raw-writes the generic queue either — mutations go through the entry points; only reads are direct", () => {
    const oneLine = code.replace(/\s+/g, " ");
    expect(oneLine).not.toMatch(
      /\.from\(\s*["'`]hq_ai_tasks["'`](\s+as\s+never)?\s*\)\s*\.(insert|update|delete|upsert)\b/,
    );
  });
});

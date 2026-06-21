import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * CrewFlow HQ — Lead Qualification AI security invariants
 * (CEO Directive 003, Module 3 of the HQ Sales programme — the decision-maker).
 *
 * Module 2 (Research AI) scores a company but deliberately leaves it at
 * status='new'. Module 3 makes the qualify/disqualify CALL — and that call gates
 * a company's place in the pipeline, so it is the most safety-sensitive surface
 * the programme has shipped. The Module-1 invariants pin the data surface (RLS:hq,
 * zero policies, tenant-decoupled); the Module-2 invariants pin the Research
 * execution layer. THIS suite pins the trust boundary of the QUALIFICATION
 * execution layer, which differs from Research in two deliberate, dangerous-if-
 * silently-flipped ways:
 *
 *   • it is AUTONOMOUS (requires_approval=false) — so the safety story is no
 *     longer "a human approves before send"; it is "the autonomy is bounded in
 *     code to an internal, reversible classification". These assertions pin that
 *     boundary: tight scopes, a transition guarded by status==='new', a target
 *     that can only ever be a qualification status, and NO send/draft/delete/$.
 *   • it is DETERMINISTIC (no LLM) — the directive's "no black box" bar. These
 *     assertions pin that there is no model wired (NULL provider, no anthropic/
 *     openai anywhere in the path) and that the rubric is a pure, side-effect-free
 *     module with no clock/RNG in the decision.
 *
 * Like the sibling suites it has no database here (the live RLS denial + the live
 * autonomous run are proven in the integration tier); it pins the contract
 * against SOURCE TEXT. The migration checks run over `exec` (SQL with `--`
 * comments stripped); the TS checks run over `code` (TS with `//` + block
 * comments stripped) — so the prose that DOCUMENTS the contract can never satisfy
 * a positive match nor trip a negative one.
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
const MIGRATION = "supabase/migrations/20260721000000_lead_qualification_employee.sql";
const RUNNER = "server/services/hq-qualification.ts";
const CRITERIA = "lib/qualification/criteria.ts";
const MODEL = "lib/qualification/model.ts";
const RUN_ROUTE = "app/api/admin/qualification/run/route.ts";
const STATE_ROUTE = "app/api/admin/qualification/state/[taskId]/route.ts";
const CRON_ROUTE = "app/api/cron/qualification-drain/route.ts";
const ACTIONS = "app/admin/qualification/actions.ts";
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

// Pipeline statuses the qualifier must NEVER skip ahead into. A qualify/disqualify
// call only ever moves a lead OUT of 'new' to a qualification status — never into
// outreach or beyond (that would be the autonomy overreaching its remit).
const FORWARD_STATUSES = [
  "outreach_ready",
  "contacted",
  "replied",
  "demo_booked",
  "won",
  "lost",
] as const;

// =====================================================================
// 0. The migration ships and stays Foundation-safe (no new attack surface)
// =====================================================================

describe("lead-qualification — the employee migration adds work, not a new data surface", () => {
  it(`${MIGRATION} exists`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION))).toBe(true);
  });

  const exec = execOf(read(MIGRATION));

  it("adds the Lead Qualification AI employee to the existing ai_employees table", () => {
    expect(exec).toMatch(/insert\s+into\s+public\.ai_employees/i);
    expect(exec).toMatch(/'lead-qualification'/);
  });

  it("seeds only existing lookups — a task_type and a timeline source, no data table", () => {
    expect(exec).toMatch(/insert\s+into\s+public\.hq_sales_task_types/i);
    expect(exec).toMatch(/'qualify_company'/);
    expect(exec).toMatch(/insert\s+into\s+public\.hq_sales_sources/i);
    expect(exec).toMatch(/'ai_qualification'/);
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
// 1. Bounded autonomy — pinned in the employee's permission grant
// =====================================================================
//
// The deliberate divergence from Research AI: this employee acts WITHOUT a human
// approval gate. That is only safe because its scopes are correspondingly tight
// (read + score + qualify — an internal classification) and structurally exclude
// every irreversible/outbound capability. If requires_approval ever flips back to
// true that's a (safe) behaviour change; if the SCOPES ever widen to send/draft/
// delete/memory while approval stays off, that's a hole. Both are pinned.

describe("lead-qualification — the employee's autonomy is bounded by a tight scope set", () => {
  const exec = execOf(read(MIGRATION));

  it("acts autonomously (requires_approval=false) — the call IS the module", () => {
    expect(exec).toMatch(/"requires_approval":\s*false/);
  });

  it("is permitted to execute, but ONLY within read/score/qualify scopes", () => {
    expect(exec).toMatch(/"can_execute":\s*true/);
    // The exact, complete scope set — an internal classification, nothing more.
    expect(exec).toMatch(/"scopes":\s*\["read","score","qualify"\]/);
  });

  it("the grant structurally excludes every outbound / irreversible scope", () => {
    // The autonomy must never silently acquire the ability to contact, draft,
    // delete, or remember — those would make an un-gated employee dangerous.
    const grant = exec.match(/"scopes":\s*\[[^\]]*\]/)?.[0] ?? "";
    expect(grant).not.toMatch(/"send"/);
    expect(grant).not.toMatch(/"draft"/);
    expect(grant).not.toMatch(/"delete"/);
    expect(grant).not.toMatch(/"memory"/);
    expect(grant).not.toMatch(/"write"/);
  });
});

// =====================================================================
// 2. No black box — the migration wires NO model (deterministic by construction)
// =====================================================================

describe("lead-qualification — the employee is deterministic (no model is wired)", () => {
  const exec = execOf(read(MIGRATION));

  it("pins model_provider + model_name to NULL — this employee has no model", () => {
    expect(exec).toMatch(/model_provider,\s*model_name/i); // declared in the column list
    expect(exec).toMatch(/\bnull,\s*null,/); // …and supplied as NULL, NULL
  });

  it("references NO LLM provider anywhere (the rubric is the whole arbiter)", () => {
    expect(exec).not.toMatch(/anthropic/i);
    expect(exec).not.toMatch(/openai/i);
  });
});

// =====================================================================
// 3. The runner obeys its trust boundary — server-only, service-role, decoupled,
//    model-free, and bounded in its one autonomous action.
// =====================================================================

describe("lead-qualification — the runner obeys its trust boundary", () => {
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

  it("NEVER touches the spine truth log (hq_events is the spine's; qualification has its own timeline)", () => {
    expect(code).not.toMatch(/hq_events/);
  });

  it("attributes every verdict honestly — its own source slug + the employee id", () => {
    expect(code).toMatch(/QUALIFICATION_SOURCE\s*=\s*"ai_qualification"/);
    expect(code).toMatch(/ai_employee_id:\s*employeeId/);
  });

  it("imports NO model layer — no research-llm, no anthropic/openai (proves no black box)", () => {
    // The runner may import the qualification *model* (types) and *criteria*
    // (the pure rubric), but never an LLM client. A provider name appearing here
    // would mean a model had crept into a path the directive requires be
    // reconstructable from named rules.
    expect(code).not.toMatch(/research-llm/);
    expect(code).not.toMatch(/anthropic/i);
    expect(code).not.toMatch(/openai/i);
  });

  it("its one autonomous write is GUARDED — it transitions only a still-'new' company", () => {
    expect(code).toMatch(/company\.status === "new"/);
    // …and only ever to the rubric's recommended status — never a hardcoded
    // forward jump into outreach/won/etc.
    expect(code).toMatch(/setCompanyStatus\(\s*companyId,\s*verdict\.recommendedStatus/);
    for (const forward of FORWARD_STATUSES) {
      expect(code).not.toMatch(
        new RegExp(`setCompanyStatus\\([^)]*["'\`]${forward}\\b`, "i"),
      );
    }
  });

  it("never sends, never deletes, never moves money (an internal classification only)", () => {
    expect(code).not.toMatch(/\.delete\(/);
    expect(code).not.toMatch(/sendEmail|sendMessage|nodemailer|resend|sgMail/i);
    expect(code).not.toMatch(/stripe|payment|charge|refund/i);
  });
});

// =====================================================================
// 4. The rubric is a pure, deterministic module — the whole arbiter
// =====================================================================

describe("lead-qualification — the criteria rubric is pure and deterministic", () => {
  const raw = read(CRITERIA);
  const code = codeOf(raw);

  it("is NOT server-only — it is a shared pure module (UI + tests import it too)", () => {
    // Match the import statement against comment-stripped code: the header
    // documents the rule ("NO … server-only imports"), which must not trip it.
    expect(code).not.toMatch(/import "server-only"/);
  });

  it("touches no I/O — no admin client, no supabase, no network", () => {
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/supabase/i);
    expect(code).not.toMatch(/\bfetch\(/);
  });

  it("has no clock and no RNG in the decision (the same inputs always decide the same)", () => {
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/Date\.now/);
    expect(code).not.toMatch(/new Date\(/);
  });

  it("pins the qualification thresholds as named, exported constants", () => {
    expect(code).toMatch(/export const QUALIFY_THRESHOLD = 60;/);
    expect(code).toMatch(/export const DISQUALIFY_FLOOR = 30;/);
    expect(code).toMatch(/export const EVIDENCE_FLOOR = 25;/);
  });

  it("makes territory the ONLY hard gate — a confident overseas read disqualifies", () => {
    expect(code).toMatch(/territory === "overseas"/);
    expect(code).toMatch(/decision = "disqualified"/);
  });
});

describe("lead-qualification — the recommended-status mapping bounds the autonomy", () => {
  const code = codeOf(read(MODEL));

  it("can only ever recommend a qualification status (or nothing) — never a forward jump", () => {
    // The TYPE itself is the proof: a transition target is qualified|disqualified|
    // null and nothing else, so the runner physically cannot route a lead into
    // outreach/won by following the rubric.
    expect(code).toMatch(
      /type RecommendedStatus = "qualified" \| "disqualified" \| null;/,
    );
    expect(code).toMatch(/function recommendedStatusFor/);
    // review recommends nothing → the lead is held at 'new' for a human.
    expect(code).toMatch(/return null;/);
  });
});

// =====================================================================
// 5. The HTTP surface is HQ-gated (404, not 403) with validated input
// =====================================================================

describe("lead-qualification — the run + state routes are Super-Admin gated with non-disclosure", () => {
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

describe("lead-qualification — the cron drain is secret-gated", () => {
  const code = codeOf(read(CRON_ROUTE));

  it("requires the cron secret and answers 401 otherwise", () => {
    expect(code).toMatch(/isCronAuthorised\(request\)/);
    expect(code).toMatch(/status:\s*401/);
  });
});

// =====================================================================
// 6. The server actions re-check the allowlist and audit the launch
// =====================================================================

describe("lead-qualification — the launcher actions re-check the allowlist (defence in depth)", () => {
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

describe("lead-qualification — /admin/qualification inherits the single HQ chokepoint", () => {
  it("the admin layout (parent of every /admin/qualification route) gates on requireHqPage()", () => {
    // Every app/admin/qualification/** page is a child of app/admin/layout.tsx,
    // so the layout's gate is the single chokepoint for the Qualification AI UI.
    expect(read(ADMIN_LAYOUT)).toMatch(/await requireHqPage\(\)/);
  });
});

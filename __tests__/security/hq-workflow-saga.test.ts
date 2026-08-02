import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * CrewFlow HQ — Workflow-Saga security source-contracts (the cross-department task
 * GRAPH). The runtime behaviour is proven against real Postgres in
 * __tests__/integration/workflow-saga; these pin the load-bearing rules at the source
 * so a regression fails CI.
 *
 * The foundation is ADDITIVE over the shipped Task Engine + Decision Centre: two HQ
 * tables (hq_workflow_sagas, hq_saga_steps) + an append-only immutable event child
 * (hq_saga_events), all RLS:hq (enabled, zero policies → service-role only), reusing
 * the hq_decisions child-table idiom. The deterministic core is pure; the AI-assisted
 * decomposition is a DARK seam that honours the governance-closure ratchet (no new
 * governor TIER key). Steps dispatch HQ tasks ONLY through the Task-Engine authority.
 *
 * SQL checks run over `exec` (-- comments stripped); TS checks run over `code`
 * (comments stripped) so prose can neither satisfy a positive match nor trip a
 * negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

function codeOf(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
function execOf(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const MIGRATION = "supabase/migrations/20261104000000_hq_workflow_sagas.sql";
const MODEL = "lib/hq/workflow/model.ts";
const DECOMPOSE = "lib/hq/workflow/decompose.ts";
const AI_SEAM = "lib/hq/workflow/ai-decompose.ts";
const SERVICE = "server/services/hq-workflow.ts";
const ACTIONS = "app/admin/workflow-sagas/actions.ts";
const LIST_PAGE = "app/admin/workflow-sagas/page.tsx";
const DETAIL_PAGE = "app/admin/workflow-sagas/[id]/page.tsx";

const mig = read(MIGRATION);
const exec = execOf(mig);

const SAGA_STATUSES = ["planned", "running", "blocked", "done", "abandoned"];
const STEP_STATUSES = ["pending", "running", "blocked", "done", "skipped", "failed"];
const TABLES = ["hq_workflow_sagas", "hq_saga_steps", "hq_saga_events"];

// =====================================================================
// 1. The migration is ADDITIVE and HQ-GLOBAL (#456: never blends tenants).
// =====================================================================

describe("workflow-saga migration — additive, HQ-global, no tenant scoping", () => {
  it("creates the three tables idempotently", () => {
    for (const t of TABLES) {
      expect(exec, `${t} must be created if not exists`).toMatch(
        new RegExp(`create table if not exists public\\.${t}`),
      );
    }
  });

  it("carries NO org_id / tenant column (HQ-global admin data only, #456)", () => {
    // A saga is HQ infrastructure; blending an org column would invite tenant data in.
    expect(exec).not.toMatch(/\borg_id\b/);
    expect(exec).not.toMatch(/organization_id|organisation_id/);
  });

  it("drops no durable object (only `drop trigger if exists` for idempotency)", () => {
    expect(exec).not.toMatch(/drop\s+(table|function|type|index)/i);
  });

  it("constrains saga + step status to exactly their CHECK vocabularies", () => {
    for (const s of SAGA_STATUSES) {
      expect(exec, `saga status ${s}`).toMatch(new RegExp(`'${s}'`));
    }
    for (const s of STEP_STATUSES) {
      expect(exec, `step status ${s}`).toMatch(new RegExp(`'${s}'`));
    }
  });
});

// =====================================================================
// 2. All three tables are RLS:hq — enabled, ZERO policies, no JWT grants.
// =====================================================================

describe("workflow-saga migration — RLS:hq (service-role only)", () => {
  it("enables RLS on every table", () => {
    for (const t of TABLES) {
      expect(exec, `${t} RLS`).toMatch(
        new RegExp(`alter table public\\.${t}\\s+enable row level security`),
      );
    }
  });

  it("creates NO policy and GRANTs no table rights to a JWT role", () => {
    expect(exec).not.toMatch(/create policy/i);
    for (const t of TABLES) {
      expect(exec).not.toMatch(
        new RegExp(`grant\\s+(select|insert|update|delete|all)\\s+on\\s+(table\\s+)?public\\.${t}`, "i"),
      );
    }
  });
});

// =====================================================================
// 3. The event log is append-only + immutable (mirrors hq_decision_events).
// =====================================================================

describe("workflow-saga migration — hq_saga_events is append-only and immutable", () => {
  it("blocks UPDATE and DELETE even under service-role", () => {
    expect(exec).toMatch(/create or replace function public\.hq_saga_events_block_mutation\(\)/);
    expect(exec).toMatch(/hq_saga_events is append-only/);
    expect(exec).toMatch(/before update on public\.hq_saga_events/);
    expect(exec).toMatch(/before delete on public\.hq_saga_events/);
  });

  it("appends one event per transition via AFTER triggers (transactional outbox)", () => {
    for (const emit of ["hq_workflow_sagas_emit", "hq_saga_steps_emit"]) {
      expect(exec).toMatch(new RegExp(`create or replace function public\\.${emit}\\(\\)`));
    }
    expect(exec).toMatch(/after insert on public\.hq_workflow_sagas/);
    expect(exec).toMatch(/after update on public\.hq_workflow_sagas/);
    expect(exec).toMatch(/after insert on public\.hq_saga_steps/);
    expect(exec).toMatch(/after update on public\.hq_saga_steps/);
    expect(exec).toMatch(/insert into public\.hq_saga_events/);
  });

  it("the emitters are SECURITY DEFINER with a pinned empty search_path", () => {
    for (const emit of ["hq_workflow_sagas_emit", "hq_saga_steps_emit"]) {
      expect(exec).toMatch(
        new RegExp(`create or replace function public\\.${emit}\\(\\)[\\s\\S]{0,120}security definer`),
      );
    }
    expect(exec).toMatch(/set search_path = ''/);
  });

  it("provenance is write-once, enforced by a guard no caller can bypass", () => {
    expect(exec).toMatch(/created_by \/ created_at are write-once/);
    expect(exec).toMatch(/saga_id \/ ordinal \/ created_at are write-once/);
  });
});

// =====================================================================
// 4. The saga↔step↔task linkage is relational and safe.
// =====================================================================

describe("workflow-saga migration — the graph edges are relational", () => {
  it("a step FK-links its saga (cascade) and optionally a task (set null)", () => {
    expect(exec).toMatch(/saga_id\s+uuid\s+not null references public\.hq_workflow_sagas\(id\) on delete cascade/);
    expect(exec).toMatch(/hq_ai_task_id\s+uuid\s+references public\.hq_ai_tasks\(id\) on delete set null/);
  });

  it("a saga optionally links its source decision (set null)", () => {
    expect(exec).toMatch(/decision_id\s+uuid\s+references public\.hq_decisions\(id\) on delete set null/);
  });

  it("one step per ordinal per saga, and no self-dependency", () => {
    expect(exec).toMatch(/unique \(saga_id, ordinal\)/);
    expect(exec).toMatch(/depends_on_ordinal is distinct from ordinal/);
  });
});

// =====================================================================
// 5. The pure model + deterministic decomposition are PURE.
// =====================================================================

describe("workflow model + decompose — pure, deterministic (no wall clock)", () => {
  for (const lib of [MODEL, DECOMPOSE]) {
    const code = codeOf(read(lib));
    it(`${lib} imports neither server-only nor a supabase client`, () => {
      expect(code).not.toMatch(/import\s+["']server-only["']/);
      expect(code).not.toMatch(/from\s+["']@\/lib\/supabase/);
    });
    it(`${lib} reads no wall clock (Date.now / new Date()) — now is injected`, () => {
      expect(code).not.toMatch(/Date\.now\(\)/);
      expect(code).not.toMatch(/new Date\(\s*\)/);
    });
    it(`${lib} constructs no AI SDK and reads no vendor credential`, () => {
      expect(code).not.toMatch(/@anthropic-ai\/sdk|\bnew\s+Anthropic\b|\bnew\s+OpenAI\b/);
      expect(code).not.toMatch(/process\.env\.(ANTHROPIC_API_KEY|OPENAI_API_KEY)/);
    });
  }
});

// =====================================================================
// 6. The AI decomposition seam is DARK and honours the governance ratchet.
// =====================================================================

describe("ai-decompose — dark seam, no unbound governor TIER key", () => {
  const code = codeOf(read(AI_SEAM));

  it("gates on tier ACTIVATION before any work (not a bare credential)", () => {
    expect(code).toMatch(/isInferenceTierActivated/);
    // The activation gate must come BEFORE the provider is opened.
    const idxGate = code.indexOf("isInferenceTierActivated()");
    const idxProvider = code.indexOf("getTextProvider(");
    expect(idxGate).toBeGreaterThan(-1);
    expect(idxProvider).toBeGreaterThan(-1);
    expect(idxGate).toBeLessThan(idxProvider);
  });

  it("reaches the model ONLY through the shared door + the governor", () => {
    expect(code).toMatch(/getTextProvider/);
    expect(code).toMatch(/invokeWithGovernor/);
    // It constructs NO SDK and reads NO credential — the door/governor own that,
    // so it never joins the closure ratchet's SDK/credential allowlists.
    expect(code).not.toMatch(/@anthropic-ai\/sdk|\bnew\s+Anthropic\b|\bnew\s+OpenAI\b/);
    expect(code).not.toMatch(/process\.env\.(ANTHROPIC_API_KEY|OPENAI_API_KEY)/);
  });

  it("invokes a registered FEATURE key on an EXISTING task class (no new tier)", () => {
    expect(code).toMatch(/"hq\.saga_decomposition"/);
    expect(code).toMatch(/"complex"/);
  });

  it("re-validates every model proposal against the pure model (no malformed saga)", () => {
    expect(code).toMatch(/validateStepGraph/);
  });

  it("the feature key is registered as `complex` and adds NO new tier", () => {
    const registry = codeOf(read("lib/ai/governor/registry.ts"));
    expect(registry).toMatch(/"hq\.saga_decomposition"/);
    // No new AI_TIER: the tier list stays cheap/mid/high/embedding.
    expect(registry).toMatch(/AI_TIERS = \["cheap", "mid", "high", "embedding"\]/);
  });
});

// =====================================================================
// 7. The service is super-admin gated and dispatches ONLY via the authority.
// =====================================================================

describe("hq-workflow service — gated, and never bypasses the Task Engine", () => {
  const raw = read(SERVICE);
  const code = codeOf(raw);

  it("is server-only and uses the service-role admin client", () => {
    expect(raw).toMatch(/server-only/);
    expect(code).toMatch(/createAdminClient/);
  });

  it("gates every mutation on isSuperAdminEmail (the request-path HQ gate)", () => {
    expect(code).toMatch(/isSuperAdminEmail/);
    expect(code).toMatch(/function actorGate/);
  });

  it("creates + stages tasks through the Task-Engine authority, never a bare write", () => {
    expect(code).toMatch(/enqueueTask/);
    expect(code).toMatch(/setTaskStage/);
    // NEVER a raw insert/update/delete/upsert on hq_ai_tasks (the spine invariant).
    expect(code).not.toMatch(
      /\.from\(\s*["'`]hq_ai_tasks["'`][\s\S]{0,60}\.(insert|update|delete|upsert)\b/,
    );
  });

  it("reads fail LOUDLY (readFailure), never a silent empty state", () => {
    expect(code).toMatch(/readFailure/);
  });

  it("derives progress from the model, never fabricating it", () => {
    expect(code).toMatch(/deriveSagaStatus/);
    expect(code).toMatch(/stepStatusForTask/);
  });
});

// =====================================================================
// 8. No app/server code raw-writes hq_ai_tasks behind the authority's back.
// =====================================================================

describe("workflow-saga — the saga surface never raw-writes hq_ai_tasks", () => {
  const rawWrite = /\.from\(\s*["'`]hq_ai_tasks["'`]\s*\)\s*\.(insert|update|delete|upsert)\b/;
  for (const f of [SERVICE, ACTIONS, LIST_PAGE, DETAIL_PAGE]) {
    it(`${f} does not raw-write hq_ai_tasks`, () => {
      const normalized = read(f).replace(/\s+/g, " ");
      expect(rawWrite.test(normalized)).toBe(false);
    });
  }
});

// =====================================================================
// 9. Both pages stay behind the single HQ gate and never inject HTML.
// =====================================================================

describe("workflow-saga pages — gated by requireHqPage, no dangerouslySetInnerHTML", () => {
  it("the /admin layout gates on requireHqPage", () => {
    const layout = codeOf(read("app/admin/layout.tsx"));
    expect(layout).toMatch(/await\s+requireHqPage\(\)/);
  });
  for (const page of [LIST_PAGE, DETAIL_PAGE]) {
    it(`${page} calls requireHqPage and never uses dangerouslySetInnerHTML`, () => {
      const code = codeOf(read(page));
      expect(code).toMatch(/requireHqPage/);
      expect(code).not.toMatch(/dangerouslySetInnerHTML/);
    });
  }
});

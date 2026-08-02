import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * CrewFlow HQ — Task Pipeline security source-contracts (the Product-pipeline + the
 * Boardroom card gap). The runtime behaviour is proven against real Postgres in
 * __tests__/integration/task-pipeline; these pin the load-bearing rules at the source
 * so a regression fails CI.
 *
 * The migration is ADDITIVE over the shipped Task Engine: a nullable pipeline_stage
 * column (every existing row stays valid), an append-only immutable stage-event child
 * (RLS:hq — enabled, zero policies → service-role only; block-mutation UPDATE/DELETE),
 * and a single SECURITY DEFINER stage-mover — reusing the hq_decisions child-table
 * idiom. The base engine guard is NOT redefined here.
 *
 * SQL checks run over `exec` (-- comments stripped) so prose that DOCUMENTS the
 * contract can neither satisfy a positive match nor trip a negative one; TS checks run
 * over `code` (comments stripped) for the same reason.
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

const MIGRATION = "supabase/migrations/20261094000000_hq_task_pipeline.sql";
const LIB = "lib/hq/boardroom-cards.ts";
const SERVICE = "server/services/hq-task-pipeline.ts";
const LIST_PAGE = "app/admin/ai-boardroom/page.tsx";
const DETAIL_PAGE = "app/admin/ai-boardroom/[slug]/page.tsx";

const mig = read(MIGRATION);
const exec = execOf(mig);

const STAGES = [
  "idea",
  "research",
  "specification",
  "design",
  "engineering",
  "testing",
  "documentation",
  "marketing",
  "sales",
  "deployment",
  "review",
];

// =====================================================================
// 1. The column is ADDITIVE and NON-BREAKING — nullable, un-defaulted, CHECKed.
// =====================================================================

describe("task pipeline migration — pipeline_stage is additive and non-breaking", () => {
  it("adds the column idempotently and does NOT force a default on existing rows", () => {
    expect(exec).toMatch(/alter table public\.hq_ai_tasks\s+add column if not exists pipeline_stage text/);
    // No NOT NULL and no DEFAULT on the new column — every existing row stays valid.
    expect(exec).not.toMatch(/pipeline_stage text[^;]*not null/i);
    expect(exec).not.toMatch(/pipeline_stage text[^;]*default/i);
  });

  it("constrains the stage to null OR exactly the eleven Master-Plan stages", () => {
    expect(exec).toMatch(/pipeline_stage is null or pipeline_stage in \(/);
    for (const s of STAGES) {
      expect(exec, `stage ${s} must be in the CHECK`).toMatch(new RegExp(`'${s}'`));
    }
  });

  it("does NOT redefine the base engine guard (minimal blast radius)", () => {
    // pipeline_stage is neither a write-once identity column nor a status column, so the
    // shipped guard already permits it on a non-terminal row — no widening needed.
    expect(exec).not.toMatch(/create or replace function public\.hq_ai_tasks_guard\(\)/);
  });

  it("drops no table/function/type/index (only `drop trigger if exists` for idempotency)", () => {
    // `drop trigger if exists` immediately followed by a recreate is the standard
    // idempotency idiom (mirrors hq_decisions) — it removes no durable object.
    expect(exec).not.toMatch(/drop\s+(table|function|type|index)/i);
  });
});

// =====================================================================
// 2. The stage-event child is RLS:hq — enabled, ZERO policies.
// =====================================================================

describe("task pipeline migration — hq_ai_task_stage_events is RLS:hq (service-role only)", () => {
  it("enables RLS on the child table", () => {
    expect(exec).toMatch(/alter table public\.hq_ai_task_stage_events\s+enable row level security/);
  });

  it("creates NO policy and GRANTs no table rights to a JWT role", () => {
    expect(exec).not.toMatch(/create policy/i);
    expect(exec).not.toMatch(/grant\s+(select|insert|update|delete|all)\s+on\s+(table\s+)?public\.hq_ai_task_stage_events/i);
  });
});

// =====================================================================
// 3. The stage history is append-only + immutable.
// =====================================================================

describe("task pipeline migration — the stage history is append-only and immutable", () => {
  it("blocks UPDATE and DELETE even under service-role", () => {
    expect(exec).toMatch(/create or replace function public\.hq_ai_task_stage_events_block_mutation\(\)/);
    expect(exec).toMatch(/hq_ai_task_stage_events is append-only/);
    expect(exec).toMatch(/before update on public\.hq_ai_task_stage_events/);
    expect(exec).toMatch(/before delete on public\.hq_ai_task_stage_events/);
  });

  it("appends one history row per stage transition via an AFTER trigger (transactional outbox)", () => {
    expect(exec).toMatch(/create or replace function public\.hq_ai_task_stage_emit\(\)/);
    expect(exec).toMatch(/after insert on public\.hq_ai_tasks/);
    expect(exec).toMatch(/after update on public\.hq_ai_tasks/);
    expect(exec).toMatch(/insert into public\.hq_ai_task_stage_events/);
    // Only emits when the stage actually MOVES — the existing create/claim/complete
    // paths (which never touch pipeline_stage) stay silent.
    expect(exec).toMatch(/new\.pipeline_stage is distinct from old\.pipeline_stage/);
  });

  it("the emitter is SECURITY DEFINER with a pinned empty search_path", () => {
    expect(exec).toMatch(/create or replace function public\.hq_ai_task_stage_emit\(\)[\s\S]{0,200}security definer/);
    expect(exec).toMatch(/set search_path = ''/);
  });
});

// =====================================================================
// 4. The stage-mover is the ONE sanctioned write path — hardened.
// =====================================================================

describe("task pipeline migration — hq_ai_task_set_stage is hardened (service-role only)", () => {
  it("is SECURITY DEFINER with a pinned empty search_path", () => {
    expect(exec).toMatch(
      /create or replace function public\.hq_ai_task_set_stage\s*\([\s\S]*?\)[\s\S]{0,400}security definer[\s\S]{0,120}set search_path = ''/,
    );
  });

  it("refuses to move a terminal task (only active statuses are updatable)", () => {
    expect(exec).toMatch(/status in \('pending','running','blocked','claimed','waiting_approval','verifying'\)/);
    expect(exec).toMatch(/not_updatable/);
  });

  it("EXECUTE is revoked from public/anon/authenticated and granted only to service_role", () => {
    expect(exec).toMatch(
      /revoke all on function public\.hq_ai_task_set_stage\(uuid, text\) from public, anon, authenticated/,
    );
    expect(exec).toMatch(/grant execute on function public\.hq_ai_task_set_stage\(uuid, text\) to service_role/);
    expect(exec).not.toMatch(/grant\s+execute[^;]*\bto\s+[^;]*\b(anon|authenticated)\b/i);
  });
});

// =====================================================================
// 5. The read-model is a PURE, deterministic, honest projection.
// =====================================================================

describe("boardroom-cards lib — pure, deterministic, insufficient-not-green", () => {
  const code = codeOf(read(LIB));
  it("is server/client-safe — imports neither server-only nor a supabase client", () => {
    expect(code).not.toMatch(/import\s+["']server-only["']/);
    expect(code).not.toMatch(/from\s+["']@\/lib\/supabase/);
  });
  it("injects `now` rather than reading the wall clock (deterministic)", () => {
    expect(code).not.toMatch(/Date\.now\(\)/);
    expect(code).not.toMatch(/new Date\(\s*\)/);
  });
  it("carries the honest insufficient state (never a green conjured from absent data)", () => {
    expect(code).toMatch(/level: "insufficient"/);
  });
});

// =====================================================================
// 6. The service READS only — it never raw-writes the queue.
// =====================================================================

describe("hq-task-pipeline service — read-only projection over hq_ai_tasks", () => {
  const raw = read(SERVICE);
  const code = codeOf(raw);
  it("is service-role only (server-only, admin client)", () => {
    expect(raw).toMatch(/server-only/);
    expect(code).toMatch(/createAdminClient/);
  });
  it("never mutates hq_ai_tasks (no insert/update/delete/upsert)", () => {
    expect(code).not.toMatch(/\.from\(\s*["'`]hq_ai_tasks["'`][\s\S]{0,40}\.(insert|update|delete|upsert)\b/);
  });
});

// =====================================================================
// 7. No application code raw-writes pipeline_stage behind the function's back.
//    (Re-pins the queue-write invariant for the new column across app/ + server/.)
// =====================================================================

describe("task pipeline — the queue is written ONLY through the SECURITY DEFINER functions", () => {
  function walk(dir: string, acc: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
        walk(p, acc);
      } else if (/\.(ts|tsx)$/.test(name)) {
        acc.push(p);
      }
    }
    return acc;
  }

  it("no file under app/ or server/ calls .from('hq_ai_tasks').{insert|update|delete|upsert}", () => {
    const offenders: string[] = [];
    const rawWrite = /\.from\(\s*["'`]hq_ai_tasks["'`]\s*\)\s*\.(insert|update|delete|upsert)\b/;
    for (const dir of ["app", "server"]) {
      for (const file of walk(resolve(ROOT, dir))) {
        const normalized = readFileSync(file, "utf8").replace(/\s+/g, " ");
        if (rawWrite.test(normalized)) offenders.push(relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

// =====================================================================
// 8. Both boardroom pages stay behind the single HQ gate.
// =====================================================================

describe("ai-boardroom pages — gated by requireHqPage via the /admin layout", () => {
  it("the /admin layout gates on requireHqPage (the boardroom lives under it)", () => {
    const layout = codeOf(read("app/admin/layout.tsx"));
    expect(layout).toMatch(/requireHqPage/);
    expect(layout).toMatch(/await\s+requireHqPage\(\)/);
  });
  for (const page of [LIST_PAGE, DETAIL_PAGE]) {
    it(`${page} renders the boardroom cards and never uses dangerouslySetInnerHTML`, () => {
      const code = codeOf(read(page));
      expect(code).toMatch(/_cards/);
      expect(code).not.toMatch(/dangerouslySetInnerHTML/);
    });
  }
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HQ_CADENCES } from "@/lib/hq/cadence/catalogue";

/**
 * HQ cadence clock (20261108) — trust-boundary proofs.
 *
 * Hermetic (filesystem scans + the pure catalogue), per the security tier. Pins
 * the properties a later edit could quietly drop:
 *   1. RLS:hq on BOTH tables — RLS enabled, ZERO policies, no JWT grant, HQ-global
 *      (no org_id) — cadences are never tenant-visible.
 *   2. DARK BY DEFAULT — column default false, every seeded row enabled=false.
 *   3. The tick REUSES the one shared evaluator (computeNextRun) — no second cron
 *      parser is defined in the service.
 *   4. The claim is an OPTIMISTIC next_run_at CAS (single-fire under concurrency).
 *   5. The tick ROUTES to the EXISTING HQ authorities (no re-implemented drains).
 *   6. The tick cron is CRON_SECRET-gated; the write path is super-admin gated.
 *   7. The run-log is append-only (UPDATE/DELETE blocked even under service-role).
 *   8. The migration seed key set matches the code catalogue.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG = "supabase/migrations/20261108000000_hq_ai_schedules.sql";
const SVC = "server/services/hq-cadence.ts";
const CRON = "app/api/cron/hq-cadence-tick/route.ts";
const ACTIONS = "app/admin/hq-cadence/actions.ts";
const CATALOGUE = "lib/hq/cadence/catalogue.ts";

/** Strip SQL line comments so NEGATIVE assertions test EXECUTABLE statements. */
const sqlOnly = (s: string) =>
  s
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

/** Strip TS/JS comments, for source contracts about real code. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const sql = sqlOnly(read(MIG));
const TABLES = ["hq_ai_schedules", "hq_ai_schedule_runs"];

// ---------------------------------------------------------------------------
// 1. RLS:hq — enabled, ZERO policies, no JWT grant, HQ-global (no org_id)
// ---------------------------------------------------------------------------

describe("RLS:hq — service-role only, HQ-global", () => {
  it("enables RLS on both tables", () => {
    for (const t of TABLES) {
      expect(sql, `${t} RLS`).toMatch(
        new RegExp(`alter table public\\.${t} enable row level security`, "i"),
      );
    }
  });

  it("creates NO policy and GRANTs no table rights to a JWT role", () => {
    expect(sql).not.toMatch(/create policy/i);
    for (const t of TABLES) {
      expect(sql).not.toMatch(
        new RegExp(`grant\\s+(select|insert|update|delete|all)\\s+on\\s+(table\\s+)?public\\.${t}`, "i"),
      );
    }
  });

  it("is HQ-global — neither table carries an org_id (#456)", () => {
    expect(sql).not.toMatch(/org_id/i);
    expect(sql).not.toMatch(/references public\.organizations/i);
  });

  it("cadence_key is unique + write-once, and additive/idempotent", () => {
    expect(sql).toMatch(/cadence_key\s+text\s+not null\s+unique/i);
    expect(sql).toMatch(/cadence_key is distinct from old\.cadence_key/i);
    expect(sql).toMatch(/create table if not exists public\.hq_ai_schedules/i);
    expect(sql).toMatch(/create table if not exists public\.hq_ai_schedule_runs/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Dark by default
// ---------------------------------------------------------------------------

describe("dark by default", () => {
  it("the enabled column defaults to false", () => {
    expect(sql).toMatch(/enabled\s+boolean\s+not null\s+default false/i);
  });

  it("every seeded cadence is enabled=false", () => {
    // The single seed INSERT lists (cadence_key, cron_expr, enabled, description);
    // every values-row must carry the literal `false`.
    const seed = sql.match(/insert into public\.hq_ai_schedules[\s\S]*?on conflict/i)?.[0] ?? "";
    expect(seed).toBeTruthy();
    const rows = seed.match(/\(\s*'[^']+'\s*,\s*'[^']+'\s*,\s*(true|false)/gi) ?? [];
    expect(rows.length).toBe(HQ_CADENCES.length);
    for (const r of rows) expect(r.toLowerCase()).toContain("false");
    expect(seed).not.toMatch(/,\s*true\s*,/i);
  });

  it("enabling is opt-in — pausing nulls next_run_at so no stale occurrence fires", () => {
    const svc = codeOf(read(SVC));
    expect(svc).toMatch(/enabled \? computeNextRun\(def\.cronExpr, now\)\.toISOString\(\) : null/);
  });
});

// ---------------------------------------------------------------------------
// 3. Reuse the one shared evaluator — no second cron parser
// ---------------------------------------------------------------------------

describe("reuses computeNextRun (no second cron evaluator)", () => {
  const svc = read(SVC);
  const svcCode = codeOf(svc);

  it("imports computeNextRun from the shared lib/automation/cron", () => {
    expect(svc).toMatch(/from "@\/lib\/automation\/cron"/);
    expect(svcCode).toMatch(/computeNextRun\(/);
  });

  it("does NOT re-implement a cron parser locally", () => {
    expect(svcCode).not.toMatch(/function computeNextRun/);
    expect(svcCode).not.toMatch(/function parseCron/);
    expect(svcCode).not.toMatch(/getUTCMinutes\(\)/);
  });
});

// ---------------------------------------------------------------------------
// 4. The claim is an optimistic next_run_at CAS
// ---------------------------------------------------------------------------

describe("the tick claim is optimistic (single-fire under concurrency)", () => {
  const svc = codeOf(read(SVC));

  it("advances next_run_at only where the observed value still matches", () => {
    expect(svc).toMatch(
      /\.update\(\{ next_run_at[\s\S]*?\.eq\("id", row\.id\)[\s\S]*?\.eq\("next_run_at", row\.next_run_at\)/,
    );
    expect(svc).toMatch(/claim_lost/);
  });

  it("only enabled, due cadences are scanned", () => {
    expect(svc).toMatch(/\.eq\("enabled", true\)[\s\S]*?\.lte\("next_run_at", nowIso\)/);
  });
});

// ---------------------------------------------------------------------------
// 5. Routes to the EXISTING HQ authorities — no re-implemented side effect
// ---------------------------------------------------------------------------

describe("dispatch routes to the existing HQ authorities", () => {
  const svc = read(SVC);

  it("imports every legacy drain the cadences model", () => {
    expect(svc).toMatch(/drainResearchTasks/);
    expect(svc).toMatch(/drainQualificationTasks/);
    expect(svc).toMatch(/drainOutreachTasks/);
    expect(svc).toMatch(/drainNotificationEmailQueue/);
    expect(svc).toMatch(/drainDueSchedules/);
  });

  it("the CADENCE_DISPATCH map binds each cadence to its authority", () => {
    const code = codeOf(svc);
    expect(code).toMatch(/CADENCE_DISPATCH[\s\S]*?"research-drain"[\s\S]*?drainResearchTasks/);
    expect(code).toMatch(/"notifications-drain"[\s\S]*?drainNotificationEmailQueue/);
    expect(code).toMatch(/"automation-schedules-drain"[\s\S]*?drainDueSchedules/);
  });
});

// ---------------------------------------------------------------------------
// 6. The tick cron is CRON_SECRET-gated; the write path is super-admin gated
// ---------------------------------------------------------------------------

describe("the tick cron + write path are gated", () => {
  it("the tick route refuses unless isCronAuthorised (Bearer CRON_SECRET)", () => {
    const cron = read(CRON);
    expect(cron).toMatch(/isCronAuthorised\(request\)/);
    expect(cron).toMatch(/status: 401/);
    expect(cron).toMatch(/withCronTelemetry\("hq-cadence-tick"/);
  });

  it("the service gates every enable/pause on isSuperAdminEmail", () => {
    const svc = codeOf(read(SVC));
    expect(svc).toMatch(/if \(!isSuperAdminEmail\(actor\.email\)\)[\s\S]*?forbidden/);
  });

  it("the admin action re-checks super-admin before calling the service", () => {
    const a = codeOf(read(ACTIONS));
    expect(a).toMatch(/isSuperAdminEmail\(user\.email\)/);
    expect(a).toMatch(/setCadenceEnabled\(/);
  });
});

// ---------------------------------------------------------------------------
// 7. The run-log is append-only + immutable
// ---------------------------------------------------------------------------

describe("hq_ai_schedule_runs is append-only", () => {
  it("blocks UPDATE and DELETE even under service-role", () => {
    expect(sql).toMatch(/create or replace function public\.hq_ai_schedule_runs_block_mutation\(\)/);
    expect(sql).toMatch(/hq_ai_schedule_runs is append-only/);
    expect(sql).toMatch(/before update on public\.hq_ai_schedule_runs/);
    expect(sql).toMatch(/before delete on public\.hq_ai_schedule_runs/);
  });
});

// ---------------------------------------------------------------------------
// 8. The migration seed matches the code catalogue
// ---------------------------------------------------------------------------

describe("the migration seed and the code catalogue agree", () => {
  it("every catalogue cadence_key is seeded (and vice versa)", () => {
    const cat = read(CATALOGUE);
    const seed = sql.match(/insert into public\.hq_ai_schedules[\s\S]*?on conflict/i)?.[0] ?? "";
    for (const c of HQ_CADENCES) {
      expect(seed, `seed missing ${c.key}`).toContain(`'${c.key}'`);
      expect(seed, `seed cron mismatch ${c.key}`).toContain(`'${c.cronExpr}'`);
      expect(cat, `catalogue missing ${c.key}`).toContain(c.key);
    }
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * OFFLINE WRITE EXPANSION 2 (train "offl") — security contracts for the two new
 * verticals, delay_event.create and site_report.create (both DRAFT creates).
 *
 * The FOUNDATION (queue, envelope, dispatch ordering, diary core) is pinned by
 * __tests__/security/offline-write-queue.test.ts and the Train-5 additions by
 * offline-write-expansion.test.ts; both are deliberately untouched. This file
 * pins what THIS train added:
 *
 *   1. The new cores are exactly as privileged as the online forms — tenant
 *      client, RLS, active-org pin, session-attributed authorship — and, unlike
 *      the material-request core, make NO remote (RPC) call at all.
 *   2. Only the DRAFT is ever written; no lifecycle provenance is forged.
 *   3. The online actions no longer own an insert — one core, two entry points.
 *   4. Migration 20261101 is additive-only and touches no policy/function/grant/
 *      FK/trigger, and records WHY the attestation verticals were rejected.
 */

const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sql = (s: string) => s.replace(/--.*$/gm, "");

const root = join(__dirname, "..", "..");
const delayCoreSrc = readFileSync(
  join(root, "server/services/delay-event-writes.ts"),
  "utf8",
);
const reportCoreSrc = readFileSync(
  join(root, "server/services/site-report-writes.ts"),
  "utf8",
);
const delayActionsSrc = readFileSync(join(root, "app/(app)/delays/actions.ts"), "utf8");
const reportActionsSrc = readFileSync(
  join(root, "app/(app)/site-reports/actions.ts"),
  "utf8",
);
const migration = readFileSync(
  join(root, "supabase/migrations/20261101000000_offline_write_expansion_2.sql"),
  "utf8",
);

// ── the new cores are not privileged writes ──────────────────────────────────
describe("expansion-2 cores — exactly as privileged as the online forms", () => {
  it("no service-role client anywhere in the new write path", () => {
    for (const [name, src] of [
      ["delay-event-writes.ts", delayCoreSrc],
      ["site-report-writes.ts", reportCoreSrc],
      ["delays/actions.ts", delayActionsSrc],
      ["site-reports/actions.ts", reportActionsSrc],
    ] as const) {
      expect(src, name).not.toMatch(/createAdminClient|supabase\/admin/);
      expect(src, name).not.toMatch(/SERVICE_ROLE|service_role/);
    }
  });

  it("neither new core makes ANY remote (RPC) call — no allocator, no SECURITY DEFINER surface", () => {
    for (const [name, src] of [
      ["delay-event-writes.ts", delayCoreSrc],
      ["site-report-writes.ts", reportCoreSrc],
    ] as const) {
      expect(code(src), name).not.toMatch(/\.rpc\(/);
    }
  });

  it("both cores write through the tenant client under RLS", () => {
    for (const src of [delayCoreSrc, reportCoreSrc]) {
      expect(src).toMatch(/const tenant = await createClient\(\)/);
      expect(src).toMatch(/import \{ createClient \} from "@\/lib\/supabase\/server"/);
    }
    expect(delayCoreSrc).toMatch(/tenant\.from\("delay_events" as never\)/);
    expect(reportCoreSrc).toMatch(/tenant\.from\("site_reports" as never\)/);
  });

  it("authorship is the SESSION user on every new insert, never queue content", () => {
    expect(delayCoreSrc).toMatch(/created_by: args\.user\.id/);
    expect(reportCoreSrc).toMatch(/prepared_by: args\.user\.id/);
    for (const src of [delayCoreSrc, reportCoreSrc]) {
      expect(code(src)).not.toMatch(/(created_by|prepared_by|reported_by):\s*(item|input|args\.input)\./);
    }
  });

  it("every insert and every lookup in the new cores is ACTIVE-ORG pinned", () => {
    // delay core: job guard + duplicate lookup
    expect(
      [...code(delayCoreSrc).matchAll(/\.eq\("org_id", orgId\)/g)].length,
    ).toBeGreaterThanOrEqual(2);
    // report core: key-first lookup, job guard, number count, winner re-read
    expect(
      [...code(reportCoreSrc).matchAll(/\.eq\("org_id", orgId\)/g)].length,
    ).toBeGreaterThanOrEqual(4);
    for (const src of [delayCoreSrc, reportCoreSrc]) {
      expect(src).toMatch(/org_id: orgId/);
    }
  });

  it("lifecycle state is server-pinned: both born 'draft', and NO provenance is forged", () => {
    const OUTCOMES = ["accepted", "duplicate", "rejected", "retry"];
    const rowStatuses = (src: string) =>
      [...code(src).matchAll(/status:\s*["'`]([a-z_]+)["'`]/g)]
        .map((m) => m[1]!)
        .filter((s) => !OUTCOMES.includes(s));
    expect(rowStatuses(delayCoreSrc)).toEqual(["draft"]);
    expect(rowStatuses(reportCoreSrc)).toEqual(["draft"]);
    // the delay-event lifecycle provenance is NEVER written from here
    expect(code(delayCoreSrc)).not.toMatch(/recorded_at:|recorded_by:|withdrawn_at:|withdrawn_by:/);
    // the site-report lifecycle provenance is NEVER written from here
    expect(code(reportCoreSrc)).not.toMatch(/issued_at:|approved_at:|approved_by:|snapshot:/);
  });

  it("the delay-event core guards the job FK and classifies its 23505 by RE-READING THE KEY", () => {
    expect(delayCoreSrc).toMatch(/reason: "job_missing"/);
    // duplicate is decided by the key, never by sniffing a constraint name
    expect(code(delayCoreSrc)).not.toMatch(/constraint|uidx/i);
    expect(delayCoreSrc).toMatch(/\.eq\("client_write_key", clientKey\)/);
  });

  it("the site-report core is KEY-FIRST so a replay does not re-gather sources", () => {
    const src = code(reportCoreSrc);
    const keyLookup = src.indexOf('.eq("client_write_key", clientKey)');
    const gather = src.indexOf("gatherReportSources("); // the CALL, not the import
    const insert = src.indexOf(".insert(");
    expect(keyLookup).toBeGreaterThan(-1);
    expect(keyLookup).toBeLessThan(gather);
    expect(keyLookup).toBeLessThan(insert);
  });

  it("permanent-code classification is SHARED with the foundation, not forked", () => {
    for (const src of [delayCoreSrc, reportCoreSrc]) {
      expect(src).toMatch(/OFFLINE_PERMANENT_CODES\[error\.code\]/);
      expect(src).toMatch(/OFFLINE_UNIQUE_VIOLATION/);
      // no second allowlist is declared in the new modules
      expect(code(src)).not.toMatch(/PERMANENT_CODES\s*[:=]\s*\{/);
    }
  });

  it("the online actions no longer own an insert — one core, two entry points", () => {
    const createDelay = delayActionsSrc.slice(
      delayActionsSrc.indexOf("export async function createDelayEvent"),
      delayActionsSrc.indexOf("export async function updateDelayEvent"),
    );
    expect(createDelay).toMatch(/createDelayEventDraftRecord\(/);
    expect(code(createDelay)).not.toMatch(/\.insert\(/);

    const createReport = reportActionsSrc.slice(
      reportActionsSrc.indexOf("export async function createSiteReport"),
      reportActionsSrc.indexOf("export async function updateReportContent"),
    );
    expect(createReport).toMatch(/createSiteReportDraftRecord\(/);
    expect(code(createReport)).not.toMatch(/\.insert\(/);
  });
});

// ── migration 20261101 ────────────────────────────────────────────────────────
describe("migration 20261101 — additive, policy-free, teardown-safe", () => {
  it("is additive only: no drop/truncate/delete, no table, no policy, no grant, no trigger", () => {
    const s = sql(migration);
    expect(s).not.toMatch(/drop table|drop column|truncate|delete from/i);
    expect(s).not.toMatch(/create table/i);
    expect(s).not.toMatch(/create policy|drop policy|disable row level security/i);
    expect(s).not.toMatch(/\bgrant\b/i);
    expect(s).not.toMatch(/create trigger/i);
  });

  it("adds NO new function, no SECURITY DEFINER, no new FK and no RESTRICT", () => {
    const s = sql(migration);
    expect(s).not.toMatch(/create (or replace )?function/i);
    expect(s).not.toMatch(/security definer/i);
    expect(s).not.toMatch(/references/i);
    expect(s).not.toMatch(/on delete restrict|on update restrict/i);
  });

  it("both idempotency indexes are org-scoped and partial, matching the foundation", () => {
    for (const table of ["delay_events", "site_reports"]) {
      expect(migration).toMatch(
        new RegExp(
          `create unique index if not exists ${table}_client_write_key_uidx\\s*\\n\\s*on public\\.${table} \\(org_id, client_write_key\\)\\s*\\n\\s*where client_write_key is not null`,
        ),
      );
      expect(migration).toMatch(
        new RegExp(`add column if not exists client_write_key uuid`),
      );
    }
    expect(migration).toMatch(/add column if not exists offline_authored_at/);
  });

  it("records WHY the attestation verticals were rejected, next to the decision", () => {
    // The swap is a product/evidence decision; a reviewer must find the reasoning
    // where the schema change lives, not in a chat log.
    expect(migration).toMatch(/acknowledged_at/);
    expect(migration).toMatch(/inspection_signoffs/);
    expect(migration).toMatch(/recorded_at/);
    // and why the highest-field-value candidate (progress) was NOT enabled
    expect(migration.toLowerCase()).toMatch(/upsert/);
  });
});

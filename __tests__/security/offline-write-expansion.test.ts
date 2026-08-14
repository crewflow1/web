import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * OFFLINE WRITE EXPANSION (Train 5) — security contracts for the two new
 * verticals, snag.create and material_request.create (draft).
 *
 * __tests__/security/offline-write-queue.test.ts pins the FOUNDATION (queue,
 * envelope, dispatch ordering, diary core) and is deliberately untouched; this
 * file pins what the expansion added:
 *
 *   1. The new cores are exactly as privileged as the online forms — tenant
 *      client, RLS, active-org pin, session-attributed authorship. The ONE
 *      remote call the material-request core makes is the pre-existing
 *      read-only number allocator the online action always used.
 *   2. The material-request replay protocol cannot lie: a number race is a
 *      retry (never "duplicate"), and "duplicate" is only reachable after the
 *      lines are known to exist.
 *   3. Migration 20261083 is additive-only and touches no policy, function,
 *      grant or FK.
 *   4. The offline identity handed to BOTH new forms is the server-resolved
 *      session, and every queue failure mode has a user-facing message.
 */

const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sql = (s: string) => s.replace(/--.*$/gm, "");

const root = join(__dirname, "..", "..");
const writesSrc = readFileSync(
  join(root, "server/services/offline-writes.ts"),
  "utf8",
);
const mrCoreSrc = readFileSync(
  join(root, "server/services/material-request-writes.ts"),
  "utf8",
);
const snagActionsSrc = readFileSync(join(root, "app/(app)/snags/actions.ts"), "utf8");
const mrActionsSrc = readFileSync(
  join(root, "app/(app)/materials/requests/actions.ts"),
  "utf8",
);
const snagFormSrc = readFileSync(join(root, "app/(app)/snags/_form.tsx"), "utf8");
const snagNewPageSrc = readFileSync(
  join(root, "app/(app)/snags/new/page.tsx"),
  "utf8",
);
const mrFormSrc = readFileSync(
  join(root, "app/(app)/materials/requests/_request-form.tsx"),
  "utf8",
);
const mrNewPageSrc = readFileSync(
  join(root, "app/(app)/materials/requests/new/page.tsx"),
  "utf8",
);
const outboxSrc = readFileSync(
  join(root, "app/(app)/_components/offline-outbox.tsx"),
  "utf8",
);
const queueSrc = readFileSync(join(root, "lib/offline/write-queue.ts"), "utf8");
const migration = readFileSync(
  join(root, "supabase/migrations/20261083000000_offline_write_expansion.sql"),
  "utf8",
);

// ── the new cores are not privileged writes ──────────────────────────────────
describe("expansion cores — exactly as privileged as the online forms", () => {
  it("no service-role client anywhere in the new write path", () => {
    for (const [name, src] of [
      ["material-request-writes.ts", mrCoreSrc],
      ["snags/actions.ts", snagActionsSrc],
      ["materials/requests/actions.ts", mrActionsSrc],
    ] as const) {
      expect(src, name).not.toMatch(/createAdminClient|supabase\/admin/);
      expect(src, name).not.toMatch(/SERVICE_ROLE|service_role/);
    }
  });

  it("the material-request core's ONLY remote call is the pre-existing number allocator", () => {
    // Executing code only — the comments explain the allocator by name too.
    const calls = [...code(mrCoreSrc).matchAll(/\.rpc\(\s*"([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    expect(calls).toEqual(["next_material_request_number"]);
    // and it is invoked on the TENANT client with the ACTIVE org
    expect(mrCoreSrc).toMatch(/\{ target_org: orgId \}/);
  });

  it("the migration adds no function of its own — the allocator predates it (20261066)", () => {
    expect(sql(migration)).not.toMatch(/create (or replace )?function/i);
    expect(sql(migration)).not.toMatch(/security definer/i);
  });

  it("both cores write through the tenant client under RLS", () => {
    expect(writesSrc).toMatch(/tenant\.from\("snags" as never\)/);
    expect(mrCoreSrc).toMatch(/const tenant = await createClient\(\)/);
    expect(mrCoreSrc).toMatch(
      /import \{ createClient \} from "@\/lib\/supabase\/server"/,
    );
  });

  it("authorship is the SESSION user on every new insert, never queue content", () => {
    expect(writesSrc).toMatch(/reported_by: args\.user\.id/);
    expect(mrCoreSrc).toMatch(/requested_by: args\.user\.id/);
    expect(mrCoreSrc).toMatch(/created_by: args\.user\.id/);
    for (const src of [writesSrc, mrCoreSrc]) {
      expect(code(src)).not.toMatch(/(reported_by|requested_by|created_by):\s*item\./);
    }
  });

  it("every insert and every lookup in the new cores is ACTIVE-ORG pinned", () => {
    expect(mrCoreSrc).toMatch(/org_id: orgId/);
    // key lookup, job guard, winner lookup, lines probe, stock probe
    expect(
      [...code(mrCoreSrc).matchAll(/\.eq\("org_id", orgId\)/g)].length,
    ).toBeGreaterThanOrEqual(4);
    // the snag core's job guard, assignee guard and duplicate lookup
    const snagCore = writesSrc.slice(writesSrc.indexOf("export async function createSnagRecord"));
    expect(
      [...code(snagCore).matchAll(/\.eq\("org_id", orgId\)/g)].length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("lifecycle state is server-pinned: snags born 'open', requests born 'draft', nothing else ever written", () => {
    // `status:` also names the OUTCOME envelope; filter those to leave only
    // what is written INTO a database row.
    // "conflict" is the offline-UPDATE outcome envelope status (added with the
    // conflict-resolution milestone); like the others it names a RESULT, never a
    // row status written to the database.
    const OUTCOMES = ["accepted", "duplicate", "rejected", "retry", "conflict"];
    const rowStatuses = (src: string) =>
      [...code(src).matchAll(/status:\s*["'`]([a-z_]+)["'`]/g)]
        .map((m) => m[1]!)
        .filter((s) => !OUTCOMES.includes(s));
    const snagCore = writesSrc.slice(
      writesSrc.indexOf("export async function createSnagRecord"),
      writesSrc.indexOf("QueuedWriteEnvelope"),
    );
    expect(rowStatuses(snagCore)).toEqual(["open"]);
    expect(rowStatuses(mrCoreSrc)).toEqual(["draft"]);
    // and no forged provenance
    expect(code(mrCoreSrc)).not.toMatch(/submitted_at:|decided_at:|decided_by:/);
  });

  it("the snag core guards BOTH unguarded FKs: job (cross-org) and assignee (membership)", () => {
    const snagCore = writesSrc.slice(writesSrc.indexOf("export async function createSnagRecord"));
    expect(snagCore).toMatch(/reason: "job_missing"/);
    expect(snagCore).toMatch(/reason: "assignee_missing"/);
    expect(snagCore).toMatch(/from\("memberships" as never\)/);
    // the guards run BEFORE the insert
    expect(snagCore.indexOf('reason: "assignee_missing"')).toBeLessThan(
      snagCore.indexOf('tenant.from("snags" as never)'),
    );
  });

  it("the online actions no longer own an insert — one core, two entry points", () => {
    const createSnag = snagActionsSrc.slice(
      snagActionsSrc.indexOf("export async function createSnag"),
      snagActionsSrc.indexOf("export async function updateSnagStatus"),
    );
    expect(createSnag).toMatch(/createSnagRecord\(/);
    expect(code(createSnag)).not.toMatch(/\.insert\(/);
    const createMr = mrActionsSrc.slice(
      mrActionsSrc.indexOf("export async function createMaterialRequest"),
      mrActionsSrc.indexOf("async function submitRequestRow"),
    );
    expect(createMr).toMatch(/createMaterialRequestDraftRecord\(/);
    expect(code(createMr)).not.toMatch(/\.insert\(/);
    expect(code(createMr)).not.toMatch(/\.rpc\(/); // the allocator moved into the core
  });
});

// ── the replay protocol cannot lie ───────────────────────────────────────────
describe("material request replay — key-first with line recovery, honestly reported", () => {
  it("the key lookup comes FIRST, before allocation and before any insert", () => {
    const src = code(mrCoreSrc);
    const keyLookup = src.indexOf('.eq("client_write_key", clientKey)');
    const rpc = src.indexOf(".rpc(");
    const insert = src.indexOf(".insert(");
    expect(keyLookup).toBeGreaterThan(-1);
    expect(keyLookup).toBeLessThan(rpc);
    expect(keyLookup).toBeLessThan(insert);
  });

  it("a header 23505 is disambiguated by RE-READING THE KEY, never by sniffing the message", () => {
    expect(code(mrCoreSrc)).not.toMatch(/constraint|uidx|_key['"`]?\s*\)/i);
    expect(mrCoreSrc).toMatch(/reason: "number_conflict"/);
    // the number race is a RETRY — the one wrong answer here is "duplicate"
    expect(mrCoreSrc).toMatch(
      /\{ status: "retry", reason: "number_conflict" \}/,
    );
  });

  it('"duplicate" is only ever said when the LINES are known to exist', () => {
    // ensureLines: the probe error retries; zero lines inserts; only a found
    // line (or a lines-race 23505) may answer duplicate.
    const ensure = mrCoreSrc.slice(mrCoreSrc.indexOf("async function ensureLines"));
    expect(ensure).toMatch(/status: "retry", reason: probeErr\.code \?\? "lines_probe_failed"/);
    const src = code(mrCoreSrc);
    const dupSites = [...src.matchAll(/status: "duplicate"/g)];
    expect(dupSites.length).toBe(2); // ensureLines' found-branch + the lines-race branch
    for (const m of dupSites) {
      expect(
        m.index! > src.indexOf("async function ensureLines"),
        "a duplicate answer outside the lines-aware half of the protocol",
      ).toBe(true);
    }
  });

  it("the recovery path re-runs the stock-item guard before inserting lines", () => {
    const ensure = mrCoreSrc.slice(
      mrCoreSrc.indexOf("async function ensureLines"),
      mrCoreSrc.indexOf("async function insertLines"),
    );
    expect(ensure).toMatch(/checkStockItems/);
  });

  it("the stock-item guard: only a SUCCESSFUL read of nothing rejects; a failed read retries", () => {
    const guard = mrCoreSrc.slice(mrCoreSrc.indexOf("async function checkStockItems"));
    expect(guard).toMatch(/\.eq\("org_id", orgId\)/);
    expect(guard).toMatch(/isStockModuleAbsent\(error\)/);
    expect(guard).toMatch(/status: "retry", reason: error\.code \?\? "stock_item_lookup_failed"/);
    expect(guard.indexOf('status: "retry"')).toBeLessThan(
      guard.indexOf('reason: "stock_item_missing"'),
    );
  });

  it("permanent-code classification is SHARED with the foundation, not forked", () => {
    expect(writesSrc).toMatch(/export const OFFLINE_PERMANENT_CODES/);
    expect(mrCoreSrc).toMatch(/OFFLINE_PERMANENT_CODES\[error\.code\]/);
    // and no second allowlist is declared in the new module
    expect(code(mrCoreSrc)).not.toMatch(/PERMANENT_CODES\s*[:=]\s*\{/);
  });
});

// ── migration 20261083 ───────────────────────────────────────────────────────
describe("migration 20261083 — additive, policy-free, teardown-safe", () => {
  it("is additive only: no drop/truncate/delete, no table, no policy, no grant, no trigger", () => {
    const s = sql(migration);
    expect(s).not.toMatch(/drop table|drop column|truncate|delete from/i);
    expect(s).not.toMatch(/create table/i);
    expect(s).not.toMatch(/create policy|drop policy|disable row level security/i);
    expect(s).not.toMatch(/\bgrant\b/i);
    expect(s).not.toMatch(/create trigger/i);
  });

  it("adds NO new foreign key and no RESTRICT (the 20261052 cascade lesson)", () => {
    expect(sql(migration)).not.toMatch(/references/i);
    expect(sql(migration)).not.toMatch(/on delete restrict|on update restrict/i);
  });

  it("both idempotency indexes are org-scoped and partial, matching the foundation", () => {
    for (const table of ["snags", "material_requests"]) {
      expect(migration).toMatch(
        new RegExp(
          `create unique index if not exists ${table}_client_write_key_uidx\\s*\\n\\s*on public\\.${table} \\(org_id, client_write_key\\)\\s*\\n\\s*where client_write_key is not null`,
        ),
      );
    }
  });

  it("the lines index closes the recovery race and is re-runnable", () => {
    expect(migration).toMatch(
      /create unique index if not exists material_request_lines_request_sort_uidx\s*\n\s*on public\.material_request_lines \(material_request_id, sort_order\)/,
    );
    expect(migration).toMatch(/add column if not exists client_write_key uuid/);
  });

  it("records WHY the toolbox-ack vertical was rejected, next to the decision", () => {
    // The swap is a product/evidence decision; a reviewer must find the
    // reasoning where the schema change lives, not in a chat log.
    expect(migration).toMatch(/acknowledged_at/);
    expect(migration).toMatch(/tg_safety_ack_validate/);
  });
});

// ── the forms and the outbox ─────────────────────────────────────────────────
describe("expansion forms — server-resolved identity, loud failures, honest wording", () => {
  it("both new pages hand the form the SERVER-resolved session identity", () => {
    expect(snagNewPageSrc).toMatch(
      /offline=\{\{ userId: user\.id, orgId: ctx\.org\.id \}\}/,
    );
    expect(mrNewPageSrc).toMatch(
      /offline=\{\{ userId: user\.id, orgId: ctx\.org\.id \}\}/,
    );
    for (const src of [snagFormSrc, mrFormSrc]) {
      expect(src).not.toMatch(/readOfflineIdentity/);
    }
  });

  it("every EnqueueError has a user-facing message in BOTH new forms", () => {
    const errors = [...queueSrc.matchAll(/^\s*\| "(\w+)" \/\//gm)].map((m) => m[1]!);
    expect(errors.length).toBeGreaterThan(5);
    for (const [name, src] of [
      ["snags/_form.tsx", snagFormSrc],
      ["materials _request-form.tsx", mrFormSrc],
    ] as const) {
      for (const e of errors) {
        expect(src, `${name}: EnqueueError "${e}" has no user-facing message`).toContain(
          `${e}:`,
        );
      }
    }
  });

  it('both forms say "Saved on this device", never a bare "Saved"/"Sent"', () => {
    for (const src of [snagFormSrc, mrFormSrc]) {
      expect(src).toMatch(/Saved on this device/);
    }
    // the request form is additionally honest that the sync result is a DRAFT
    expect(mrFormSrc).toMatch(/draft/i);
  });

  it("photos stay excluded offline, and the snag form says so", () => {
    expect(snagFormSrc).toMatch(/Photos need a connection/);
  });

  it("the offline branch only intercepts when offline; online posts go to the server action untouched", () => {
    for (const src of [snagFormSrc, mrFormSrc]) {
      expect(src).toMatch(/if \(online\) return;/);
      expect(src).toMatch(/e\.preventDefault\(\)/);
      expect(src).toMatch(/navigator\.onLine/);
    }
  });

  it("the outbox can explain every NEW rejection reason and render structured recovery text", () => {
    expect(outboxSrc).toMatch(/assignee_missing:/);
    expect(outboxSrc).toMatch(/stock_item_missing:/);
    expect(outboxSrc).toMatch(/formatRecoverField/);
  });
});

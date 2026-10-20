import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Data-API grant guard — Supabase "new tables not auto-exposed" change (30 Oct 2026).
 *
 * WHAT CHANGED (verified against supabase.com/changelog #45329). Supabase used to
 * run `alter default privileges in schema public grant all on tables to anon,
 * authenticated` so every new public table was reachable through the Data API
 * (PostgREST) the moment it was created. From 30 Oct 2026 that auto-grant is
 * removed for ALL existing projects: a new public table gets NO client grant, so
 * PostgREST rejects the request with 42501 BEFORE RLS is even consulted. Existing
 * tables keep their grants and are unaffected — so this is NOT a retroactive
 * break, it is a forward-looking trap for the NEXT table CrewFlow ships.
 *
 * WHY A STATIC GUARD, NOT THE CONFIG FLAG. The `[api] auto_expose_new_tables`
 * config key (CLI ≥2.102.0) is a NEW-PROJECT aid and is scheduled for removal on
 * the change date itself. It is also unsafe for CrewFlow's local stack: `supabase
 * start` recreates EVERY table from the migrations, so setting it false would
 * strip the auto-grant from the ~340 existing tables that rely on it and break
 * their RLS tests with 42501. The durable, stack-independent protection is to
 * require every NEW client-facing table migration to carry its own explicit
 * GRANT — exactly as Supabase's own migration example now shows — and to fail CI
 * if one forgets. This complements the live-ACL sweep in
 * __tests__/integration/rls/audit-log-grant-lockdown.test.ts (which proves
 * REVOKES held); this proves future GRANTS are present.
 *
 * THE RULE. For every migration newer than the baseline below: if it CREATES a
 * public table that also gets a policy reachable by a client role (anon /
 * authenticated), the SAME migration must GRANT that privilege to that role on
 * that table — or opt the table out with a `data-api:exempt:<table>` marker
 * comment (for a table that is deliberately service-role-only despite a policy).
 * Existing migrations (≤ baseline) are grandfathered: their tables predate the
 * change and keep their grants.
 */

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");

// The newest migration version present when this guard shipped. Every migration
// at or before this is grandfathered (its table was auto-granted before 30 Oct
// and keeps that grant). The guard enforces only on migrations added AFTER it.
const BASELINE_VERSION = "20261230000000";

const CLIENT_ROLES = ["anon", "authenticated"] as const;
type ClientRole = (typeof CLIENT_ROLES)[number];

/** Strip SQL line comments so detection runs on the EXECUTABLE statements only. */
const sqlOnly = (src: string): string =>
  src
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

const bare = (name: string): string =>
  name.replace(/^public\./i, "").replace(/"/g, "").toLowerCase();

/** Tables CREATE-d in this migration (bare, lowercased). Only new tables matter. */
function createdTables(sql: string): Set<string> {
  const out = new Set<string>();
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?("?(?:public\.)?[a-z0-9_"]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const g = m[1];
    if (g) out.add(bare(g));
  }
  return out;
}

/** Parse a comma role list ("anon, authenticated", 'public', '"authenticated"'). */
function parseRoles(list: string): string[] {
  return list
    .split(",")
    .map((r) => r.trim().replace(/"/g, "").toLowerCase())
    .filter(Boolean);
}

/**
 * Policies in this migration that are reachable by a client role, as a map
 * table -> set of client roles. A policy with no `to` clause defaults to PUBLIC
 * (every role), so it is treated as reaching both client roles.
 */
function clientPoliciesByTable(sql: string): Map<string, Set<ClientRole>> {
  const out = new Map<string, Set<ClientRole>>();
  const re = /create\s+policy[\s\S]*?;/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const block = m[0];
    if (!block) continue;
    const onMatch = /\bon\s+("?(?:public\.)?[a-z0-9_"]+)/i.exec(block);
    const onName = onMatch?.[1];
    if (!onName) continue;
    const table = bare(onName);
    const toMatch = /\bto\s+([a-z0-9_,\s"]+?)(?:\busing\b|\bwith\s+check\b|;)/i.exec(block);
    const roles = toMatch?.[1] ? parseRoles(toMatch[1]) : ["public"];
    const reaches = new Set<ClientRole>();
    for (const r of roles) {
      if (r === "public") CLIENT_ROLES.forEach((cr) => reaches.add(cr));
      else if (r === "anon" || r === "authenticated") reaches.add(r);
    }
    if (reaches.size === 0) continue; // service_role-only policy: not client-reachable
    const existing = out.get(table) ?? new Set<ClientRole>();
    reaches.forEach((r) => existing.add(r));
    out.set(table, existing);
  }
  return out;
}

/** (table, role) grants present in this migration, plus blanket all-tables grants. */
function grants(sql: string): { byTable: Map<string, Set<string>>; blanket: Set<string> } {
  const byTable = new Map<string, Set<string>>();
  const blanket = new Set<string>();
  // grant ... on all tables in schema public to <roles>
  const allRe = /grant\s+[\s\S]*?\s+on\s+all\s+tables\s+in\s+schema\s+public\s+to\s+([a-z0-9_,\s"]+?);/gi;
  let a: RegExpExecArray | null;
  while ((a = allRe.exec(sql)) !== null) {
    const rl = a[1];
    if (rl) parseRoles(rl).forEach((r) => blanket.add(r));
  }
  // grant ... on [table] public.<t> to <roles>
  const tblRe = /grant\s+[\s\S]*?\s+on\s+(?:table\s+)?("?(?:public\.)?[a-z0-9_"]+)\s+to\s+([a-z0-9_,\s"]+?);/gi;
  let t: RegExpExecArray | null;
  while ((t = tblRe.exec(sql)) !== null) {
    const tbl = t[1];
    const rl = t[2];
    if (!tbl || !rl) continue;
    const table = bare(tbl);
    if (table === "all") continue;
    const set = byTable.get(table) ?? new Set<string>();
    parseRoles(rl).forEach((r) => set.add(r));
    byTable.set(table, set);
  }
  return { byTable, blanket };
}

export type UnsafeFinding = { table: string; role: ClientRole };

/**
 * A new table is unsafe iff it is CREATEd here, gets a client-reachable policy
 * for role R, and has neither a per-table GRANT to R nor a blanket GRANT to R in
 * the same migration — and is not explicitly exempted. Pure + exported so the
 * self-tests below prove it is non-vacuous.
 */
export function detectUnsafeClientTables(rawSql: string): UnsafeFinding[] {
  const exempt = new Set<string>();
  const exRe = /data-api:exempt:([a-z0-9_]+)/gi; // scan RAW (marker lives in a comment)
  let e: RegExpExecArray | null;
  while ((e = exRe.exec(rawSql)) !== null) {
    const g = e[1];
    if (g) exempt.add(g.toLowerCase());
  }

  const sql = sqlOnly(rawSql);
  const created = createdTables(sql);
  const policies = clientPoliciesByTable(sql);
  const { byTable, blanket } = grants(sql);

  const findings: UnsafeFinding[] = [];
  for (const [table, roles] of policies) {
    if (!created.has(table)) continue; // existing table: keeps its pre-30-Oct grant
    if (exempt.has(table)) continue;
    for (const role of roles) {
      if (blanket.has(role)) continue;
      if (byTable.get(table)?.has(role)) continue;
      findings.push({ table, role });
    }
  }
  return findings;
}

const versionOf = (file: string): string => file.slice(0, 14);

describe("Supabase 30-Oct Data-API grant guard", () => {
  it("every migration newer than the baseline grants client roles explicitly", () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && /^\d{14}/.test(f))
      .filter((f) => versionOf(f) > BASELINE_VERSION)
      .sort();

    const problems: string[] = [];
    for (const f of files) {
      const unsafe = detectUnsafeClientTables(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"));
      for (const u of unsafe) {
        problems.push(
          `${f}: new table public.${u.table} has a policy for '${u.role}' but no ` +
            `'grant ... on ${u.table} to ${u.role}' in the same migration. After ` +
            `30 Oct 2026 Supabase no longer auto-exposes new public tables, so ` +
            `${u.role} would get 42501. Add the explicit grant (Supabase's own ` +
            `migration pattern) or a 'data-api:exempt:${u.table}' marker if the ` +
            `table is deliberately service-role-only.`,
        );
      }
    }

    expect(problems, problems.join("\n")).toEqual([]);
  });

  // ── Non-vacuity: prove the detector actually flags and clears. ──
  it("FLAGS a new client table that relies on the vanishing auto-grant", () => {
    const sql = `
      create table public.widgets (id uuid primary key, org_id uuid not null);
      alter table public.widgets enable row level security;
      create policy "members read widgets" on public.widgets
        for select to authenticated using (org_id in (select org_id from memberships));
    `;
    expect(detectUnsafeClientTables(sql)).toEqual([{ table: "widgets", role: "authenticated" }]);
  });

  it("CLEARS a new client table that carries its explicit grant", () => {
    const sql = `
      create table public.widgets (id uuid primary key, org_id uuid not null);
      grant select on public.widgets to authenticated;
      alter table public.widgets enable row level security;
      create policy "members read widgets" on public.widgets
        for select to authenticated using (org_id in (select org_id from memberships));
    `;
    expect(detectUnsafeClientTables(sql)).toEqual([]);
  });

  it("CLEARS a service-role-only new table (policy not reachable by a client)", () => {
    const sql = `
      create table public.audit (id uuid primary key);
      alter table public.audit enable row level security;
      create policy "svc only" on public.audit for all to service_role using (true);
    `;
    expect(detectUnsafeClientTables(sql)).toEqual([]);
  });

  it("CLEARS a policy added to a PRE-EXISTING table (not created here)", () => {
    const sql = `
      create policy "members read jobs" on public.jobs
        for select to authenticated using (true);
    `;
    expect(detectUnsafeClientTables(sql)).toEqual([]);
  });

  it("honours an explicit data-api:exempt marker", () => {
    const sql = `
      -- data-api:exempt:internal_queue  (service-role-only despite the policy)
      create table public.internal_queue (id uuid primary key);
      create policy "p" on public.internal_queue for select to authenticated using (true);
    `;
    expect(detectUnsafeClientTables(sql)).toEqual([]);
  });

  it("a blanket all-tables grant satisfies the rule", () => {
    const sql = `
      create table public.widgets (id uuid primary key);
      grant select on all tables in schema public to authenticated;
      create policy "p" on public.widgets for select to authenticated using (true);
    `;
    expect(detectUnsafeClientTables(sql)).toEqual([]);
  });
});

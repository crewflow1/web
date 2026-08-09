import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * SHARED org-scoped table derivation for the active-org guards.
 *
 * A table is "org-scoped" if a migration creates it with an `org_id` column or
 * adds one later. Deriving this from the migrations (the source of truth),
 * rather than hard-coding, means a NEW org-scoped table is protected the moment
 * its migration lands — no guard edit required.
 *
 * WHY THIS IS SHARED (anti-drift): both the write-pin guard
 * (active-org-write-pin-guard.test.ts) and the read-pin guard
 * (active-org-read-pin-guard.test.ts) key their entire signal off this set. They
 * previously each carried their own copy of the regex, and the write guard's
 * copy matched ONLY unquoted identifiers — so since C40 it SILENTLY did not
 * cover by-id writes to the baseline's quoted-identifier tables
 * (`create table … public."quotes" (`, `"customers"`, `"leads"`, …), i.e. the
 * highest-value org-scoped rows in the schema. Factoring the hardened,
 * quoted-identifier-aware derivation into one place means the two guards can
 * never drift apart again.
 *
 * The `"?` around the identifier is the fix: it matches both
 * `create table public.foo (` and `create table public."foo" (`.
 */
export function deriveOrgScopedTables(migrationsDir?: string): Set<string> {
  const root = resolve(__dirname, "..", "..");
  const dir = migrationsDir ?? join(root, "supabase/migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const set = new Set<string>();
  for (const f of files) {
    const sql = readFileSync(join(dir, f), "utf8");
    const createRe =
      /create table (?:if not exists )?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(([\s\S]*?)\n\);/gi;
    let m: RegExpExecArray | null;
    while ((m = createRe.exec(sql))) {
      const table = m[1] ?? "";
      const body = m[2] ?? "";
      if (table && /\borg_id\b/.test(body)) set.add(table);
    }
    const alterRe =
      /alter table (?:only )?(?:public\.)?"?([a-z_][a-z0-9_]*)"?[\s\S]{0,120}?add column (?:if not exists )?org_id/gi;
    let m2: RegExpExecArray | null;
    while ((m2 = alterRe.exec(sql))) {
      if (m2[1]) set.add(m2[1]);
    }
  }
  return set;
}

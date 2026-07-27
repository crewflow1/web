import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guard for the storage-mutation lockdown (20261032) against the
 * company-logo feature (20261041).
 *
 * WHY THIS EXISTS: 20261032000000_storage_evidence_mutation_lockdown.sql
 * deliberately dropped every `authenticated` INSERT/UPDATE/DELETE policy on
 * storage.objects so byte mutation is SERVICE-ROLE-ONLY. The first draft of the
 * company-logo migration re-created admin insert/update/delete policies for the
 * new `company-logos` bucket, silently reverting that lockdown for a bucket the
 * app never writes with a tenant JWT. These tests make that regression — and
 * any future repeat of it, in ANY migration — a hard CI failure.
 *
 * Source-contract only (CI has no database), matching the style of
 * storage-evidence-wave.test.ts and storage-owned-path.test.ts.
 */

const root = join(__dirname, "..", "..");
const MIGRATIONS = join(root, "supabase", "migrations");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const LOCKDOWN_VERSION = "20261032000000";
const LOGO_MIGRATION = "20261041000000_company_logo_storage.sql";
const LOGO_BUCKET = "company-logos";

/** Roles that a tenant-issued JWT can act as. `public` covers PG's TO-less default. */
const TENANT_ROLES = new Set(["authenticated", "anon", "public"]);
const WRITE_VERBS = ["insert", "update", "delete"] as const;

/**
 * Strip `--` comments so prose ABOUT the removed policies (the migrations are
 * heavily commented, deliberately) can never be mistaken for live DDL.
 * Quote-aware so a `--` inside a string literal or policy name survives.
 */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      let quoted: '"' | "'" | null = null;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quoted) {
          if (ch === quoted) quoted = null;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quoted = ch;
          continue;
        }
        if (ch === "-" && line[i + 1] === "-") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

type StoragePolicy = {
  file: string;
  name: string;
  /** Effective verbs. A policy with no FOR clause is FOR ALL in Postgres. */
  verbs: string[];
  /** Effective roles. A policy with no TO clause is TO PUBLIC in Postgres. */
  roles: string[];
  text: string;
};

/** Every CREATE POLICY ... ON storage.objects across every migration file. */
function storagePolicies(): StoragePolicy[] {
  const found: StoragePolicy[] = [];
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = stripComments(readFileSync(join(MIGRATIONS, file), "utf8"));
    // Statement-level split: policy DDL spans multiple lines in this repo, and
    // `on storage.objects` is often on a different line to `create policy`.
    for (const chunk of sql.split(";")) {
      const text = chunk.trim().replace(/\s+/g, " ");
      if (!/^create\s+policy/i.test(text)) continue;
      if (!/\bon\s+storage\.objects\b/i.test(text)) continue;

      const name = /^create\s+policy\s+"([^"]+)"/i.exec(text)?.[1] ?? "(unnamed)";
      const verb = /\bfor\s+(all|select|insert|update|delete)\b/i
        .exec(text)?.[1]
        ?.toLowerCase();
      const verbs =
        !verb || verb === "all" ? ["select", ...WRITE_VERBS] : [verb];
      const roleClause = /\bto\s+([a-z_,\s]+?)\s*(?:using\b|with\s+check\b|$)/i
        .exec(text)?.[1]
        ?.toLowerCase();
      const roles = roleClause
        ? roleClause.split(",").map((r) => r.trim()).filter(Boolean)
        : ["public"];

      found.push({ file, name, verbs, roles, text });
    }
  }
  return found;
}

const policies = storagePolicies();
const grantsToTenant = (p: StoragePolicy) =>
  p.roles.some((r) => TENANT_ROLES.has(r));
const isWrite = (p: StoragePolicy) =>
  p.verbs.some((v) => (WRITE_VERBS as readonly string[]).includes(v));

describe("parser self-check (these tests must not pass vacuously)", () => {
  it("finds the real historical storage.objects policies", () => {
    // If the parser or the comment-stripper ever breaks, it would find nothing
    // and every invariant below would pass for the wrong reason. Pin known-real
    // policies from pre-lockdown migrations, incl. one written on a single line
    // (blueprints) and one split across lines (job-docs).
    expect(policies.length).toBeGreaterThanOrEqual(15);
    const byName = new Map(policies.map((p) => [p.name, p]));

    const blueprintInsert = byName.get("blueprints: members can insert");
    expect(blueprintInsert, "blueprints insert policy must be parsed").toBeDefined();
    expect(blueprintInsert?.verbs).toEqual(["insert"]);
    expect(blueprintInsert?.roles).toEqual(["authenticated"]);

    const jobDocsRead = byName.get("job-docs: members can read");
    expect(jobDocsRead, "job-docs read policy must be parsed").toBeDefined();
    expect(jobDocsRead?.verbs).toEqual(["select"]);
    expect(jobDocsRead?.roles).toEqual(["authenticated"]);

    // And the classifier must actually classify: pre-lockdown migrations DID
    // create tenant write policies, so a non-empty set proves isWrite works.
    expect(policies.filter((p) => isWrite(p) && grantsToTenant(p)).length)
      .toBeGreaterThan(0);
  });

  it("reads a migration set that actually contains the logo + lockdown files", () => {
    const files = readdirSync(MIGRATIONS);
    expect(files, "logo migration must exist at the post-prod version").toContain(
      LOGO_MIGRATION,
    );
    expect(
      files.some((f) => f.startsWith(LOCKDOWN_VERSION)),
      "lockdown migration must still be present",
    ).toBe(true);
    // The old, pre-reconciliation filename must be gone (it sorted behind the
    // applied prod tip and would never run).
    expect(files).not.toContain("20260712000000_company_logo_storage.sql");
  });
});

describe("company-logos never grants tenant-JWT access to storage.objects", () => {
  const logoPolicies = policies.filter((p) => p.text.includes(`'${LOGO_BUCKET}'`));

  it("no migration creates an INSERT/UPDATE/DELETE policy for company-logos", () => {
    const offenders = logoPolicies
      .filter((p) => isWrite(p) && grantsToTenant(p))
      .map((p) => `${p.file}: "${p.name}" [${p.verbs}] to ${p.roles}`);
    expect(
      offenders,
      "byte mutation on company-logos must stay service-role-only (20261032 lockdown); " +
        "server/services/company-logo.ts already uploads via createAdminClient()",
    ).toEqual([]);
  });

  it("no migration creates ANY storage.objects policy for company-logos", () => {
    // Reads are service-minted signed URLs (authorised by signature, not RLS),
    // so even a SELECT policy is unnecessary — same posture as portal-uploads.
    const offenders = logoPolicies.map((p) => `${p.file}: "${p.name}"`);
    expect(offenders).toEqual([]);
  });

  it("the logo migration still creates the private bucket it is responsible for", () => {
    // Proves the two assertions above are not passing because the migration
    // stopped doing its job.
    const mig = read(`supabase/migrations/${LOGO_MIGRATION}`);
    expect(mig).toMatch(/insert\s+into\s+storage\.buckets/i);
    expect(mig).toMatch(
      /'company-logos'\s*,\s*'company-logos'\s*,\s*false/i,
    );
  });
});

describe("the 20261032 mutation lockdown is never reverted by a later migration", () => {
  it("no migration at or after the lockdown grants tenant writes on any bucket", () => {
    const offenders = policies
      .filter((p) => {
        const version = p.file.slice(0, 14);
        return version >= LOCKDOWN_VERSION && isWrite(p) && grantsToTenant(p);
      })
      .map((p) => `${p.file}: "${p.name}" [${p.verbs}] to ${p.roles}`);
    expect(
      offenders,
      "storage.objects byte mutation is service-role-only from 20261032 onwards",
    ).toEqual([]);
  });
});

describe("app contract: the logo feature needs no tenant storage policy", () => {
  const svc = read("server/services/company-logo.ts");

  it("every storage call in the logo service is made on a service-role client", () => {
    const receivers = [...svc.matchAll(/(\w+)\s*\.\s*storage\b/g)].map((m) => m[1]);
    expect(receivers.length, "expected storage calls to exist").toBeGreaterThan(0);
    // `admin` = createAdminClient(); `client` = admin ?? createAdminClient().
    expect([...new Set(receivers)].sort()).toEqual(["admin", "client"]);
    expect(svc).toMatch(/const\s+admin\s*=\s*createAdminClient\(\)/);
    expect(svc).toMatch(/const\s+client\s*=\s*admin\s*\?\?\s*createAdminClient\(\)/);
  });

  it("the tenant (RLS) client is used for DB rows only, never for storage bytes", () => {
    expect(svc).toMatch(/const\s+tenant\s*=\s*await\s+createClient\(\)/);
    expect(svc).not.toMatch(/tenant\s*\.\s*storage/);
  });

  it("reads are served as service-minted signed URLs, not tenant reads", () => {
    expect(svc).toMatch(/createSignedUrl\(/);
    expect(svc).not.toMatch(/getPublicUrl\(/);
  });

  it("uploads and removals go through the admin client", () => {
    expect(svc).toMatch(/admin\s*\.\s*storage\s*[\s\S]{0,80}?\.upload\(/);
    expect(svc).toMatch(/admin\s*\.\s*storage\s*[\s\S]{0,80}?\.remove\(/);
  });
});

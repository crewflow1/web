import { expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import {
  readEmployeeGrantTokens,
  resolveAuthorityFromRegistry,
  resolveServedCapabilityView,
  type CatalogueReadClient,
  type GrantReadClient,
  type LegacyEmployee,
} from "@/server/sdk/registry-parity";

/**
 * The Capability Registry — LR5.2 (Migrate the Legacy Read Paths) real-Postgres behaviour proof.
 *
 * CEO Directive #015 / D-05. ADR: docs/bible/decisions/0010-capability-registry.md.
 * Governing standards (Kernel Contract Map §2): the Read Migration Rule (24th — "no read path
 * should be removed until all remaining consumers have been identified, migrated, and
 * INDEPENDENTLY VALIDATED"), the Single Source of Authority Rule (13th), the Behaviour
 * Preservation Rule (15th) and — this increment (LR5.4B, the FINAL removal) — the Data Removal
 * Rule (26th) and the Legacy Independence Rule (28th): the migration the 24th rule required is
 * what made the legacy authority columns safe to DROP, which LR5.4B has now done. The registry is
 * the SOLE source of served authority; the automatic fail-safe is the default-deny FLOOR.
 *
 * The security tier pins the LR5.2 CONTRACT against source text (the admin surfaces no longer
 * read the now-removed `ai_employees.tools_allowed` / `permissions` columns). This tier proves the
 * BEHAVIOUR that text can't — that the two migrated read seams resolve correctly against a live
 * registry:
 *
 *   {@link resolveServedCapabilityView} (the AI Boardroom page's editor pre-fill + permissions
 *   panel) —
 *     1. FAITHFUL — every employee is served the REGISTRY (`source: "registry"`); the served
 *        tokens equal what the pure resolver composes from the grants; the served approval stance
 *        equals the composed stance; and the tools/scopes split PARTITIONS the served tokens (their
 *        union is the token set; they are disjoint). LR5.4B removed the legacy baseline, so this is
 *        the registry-native replacement for the old legacy comparison.
 *     2. KIND-FAITHFUL — the split matches the catalogue ground truth: a token shown under
 *        Scopes is catalogue `kind = 'scope'`; everything else is a tool. This is the same
 *        partition the authoring RPC applies, so the admin display agrees with what authoring
 *        records.
 *     3. FAIL-SAFE — a subject the registry is silent about (no grant) is served the default-deny
 *        FLOOR view (no tokens, an empty split, the locked approval stance), never stranded, never
 *        a broken page. LR5.4B replaced the retained legacy view with the safe floor.
 *
 *   {@link readEmployeeGrantTokens} (the authoring audit's before-snapshot) —
 *     4. EMPLOYEE GRANT — returns exactly the employee-scoped grant's stored token set
 *        (sorted-distinct), matching the raw `hq_capability_grants` row — the symmetric
 *        before-image of the set the authoring RPC replaces.
 *     5. NO GRANT → [] — a subject with no employee grant (a fresh author / backfill gap)
 *        snapshots the empty set, never throws.
 *
 * LR5.3 (the Rollback Independence Rule) retired the rollback control: resolveServedCapabilityView
 * no longer takes a `control` opt, and the floor view is reached only through the automatic
 * fail-safe (a registry read error or a subject the registry is silent about), never an operator
 * switch.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED
 * loudly in CI if the database is missing.
 *
 * ai_employees / hq_capability_grants / hq_capabilities are service-role-only HQ internals not
 * in the generated Database types, so — like the R1/R2/R3/R4 suites — the typed client is cast
 * to the minimal surface exercised here.
 */

type QueryResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<QueryResult<T>>;
type Filterable<T> = Term<T> & {
  eq(column: string, value: unknown): Filterable<T>;
  select(columns?: string): Filterable<T>;
};
type DbClient = {
  from(table: string): { select(columns?: string): Filterable<Record<string, unknown>[]> };
};

const svc = (): DbClient => serviceClient() as unknown as DbClient;
const grantClient = (): GrantReadClient => serviceClient() as unknown as GrantReadClient;
const catalogueClient = (): CatalogueReadClient =>
  serviceClient() as unknown as CatalogueReadClient;
// LR5.4B dropped ai_employees.tools_allowed / permissions / memory_scope; the resolver reads only
// the subject's slug + department to query the registry.
const EMP_COLUMNS = "slug, department";

/** Coerce a raw ai_employees row into the LegacyEmployee shape the bridge reads. */
function toLegacy(r: Record<string, unknown>): LegacyEmployee {
  return {
    slug: r.slug as string,
    department: (r.department as string | null) ?? null,
  };
}

/** The live roster, in the LegacyEmployee shape (asserts the fetch succeeds). */
async function roster(): Promise<LegacyEmployee[]> {
  const res = await svc().from("ai_employees").select(EMP_COLUMNS);
  expect(res.error, res.error?.message).toBeNull();
  return ((res.data ?? []) as Record<string, unknown>[]).map(toLegacy);
}

/** Order-insensitive string-array equality. */
function sortedEq(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

/**
 * The employee-scoped grant's stored tokens (sorted-distinct), read straight from
 * `hq_capability_grants` — the ground truth {@link readEmployeeGrantTokens} must reproduce.
 * `null` when the employee has no grant.
 */
async function rawEmployeeGrantTokens(slug: string): Promise<string[] | null> {
  const res = await svc()
    .from("hq_capability_grants")
    .select("tokens")
    .eq("scope_level", "employee")
    .eq("scope_key", slug);
  expect(res.error, res.error?.message).toBeNull();
  const row = (res.data ?? [])[0];
  if (!row) return null;
  const tokens = ((row.tokens as string[] | null) ?? []).filter(
    (t): t is string => typeof t === "string" && t.length > 0,
  );
  return [...new Set(tokens)].sort();
}

/** The catalogue kind for each requested token (absent tokens omitted). */
async function kindMap(tokens: readonly string[]): Promise<Map<string, string>> {
  if (tokens.length === 0) return new Map();
  const res = await catalogueClient()
    .from("hq_capabilities")
    .select("token, kind")
    .in("token", [...tokens]);
  expect(res.error, res.error?.message).toBeNull();
  return new Map((res.data ?? []).map((r) => [r.token, r.kind] as const));
}

describeIntegration("Capability Registry · LR5.2 served capability view (D-05)", () => {
  it("serves the REGISTRY view, FAITHFULLY projecting the composed tokens + approval stance and a clean tools/scopes partition for every employee", async () => {
    const emps = await roster();
    expect(emps.length, "the seeded roster must be present").toBeGreaterThan(0);

    const gc = grantClient();
    const cc = catalogueClient();
    const drift: string[] = [];
    for (const emp of emps) {
      const view = await resolveServedCapabilityView(emp, {
        client: gc,
        catalogue: cc,
      });
      if (view.source !== "registry") {
        drift.push(`${emp.slug}: served ${view.source}, not registry`);
        continue;
      }
      // With the legacy columns gone there is no baseline to compare against; the view must
      // FAITHFULLY project what the pure resolver composes from the grants (the registry-native
      // replacement for the old legacy comparison).
      const resolved = await resolveAuthorityFromRegistry(gc, {
        slug: emp.slug,
        department: emp.department,
      });
      // Token parity with the composed registry authority.
      if (!sortedEq(view.tokens, resolved.tokens)) {
        drift.push(`${emp.slug}: served tokens diverge from the composed registry tokens`);
      }
      // Approval-stance parity (the migrated permissions panel) with the composed stance.
      if (view.requiresApproval !== resolved.requiresApproval) {
        drift.push(`${emp.slug}: requiresApproval diverges from the composed registry stance`);
      }
      // The split PARTITIONS the served tokens: union equals the set …
      if (!sortedEq([...view.toolsAllowed, ...view.scopes], view.tokens)) {
        drift.push(`${emp.slug}: tools ∪ scopes ≠ tokens (not a partition)`);
      }
      // … and the two halves are DISJOINT.
      const overlap = view.toolsAllowed.filter((t) => view.scopes.includes(t));
      if (overlap.length) drift.push(`${emp.slug}: tool/scope overlap [${overlap.join(", ")}]`);
    }
    expect(drift, `LR5.2 view out of projection: ${drift.join(" | ")}`).toHaveLength(0);
  });

  it("splits the served set FAITHFULLY to the catalogue — Scopes are kind 'scope', everything else is a tool", async () => {
    const emps = await roster();
    const gc = grantClient();
    const cc = catalogueClient();
    const drift: string[] = [];
    let classified = 0;
    for (const emp of emps) {
      const view = await resolveServedCapabilityView(emp, {
        client: gc,
        catalogue: cc,
      });
      if (view.source !== "registry") continue;
      const kinds = await kindMap(view.tokens);
      for (const t of view.scopes) {
        classified++;
        if (kinds.get(t) !== "scope") {
          drift.push(`${emp.slug}: scope '${t}' is catalogue kind ${kinds.get(t) ?? "absent"}`);
        }
      }
      for (const t of view.toolsAllowed) {
        classified++;
        // A tool may be 'tool_permission', a forward-compat 'api_scope', or absent — never 'scope'.
        if (kinds.get(t) === "scope") {
          drift.push(`${emp.slug}: tool '${t}' is catalogue kind 'scope' (mis-split)`);
        }
      }
    }
    expect(drift, `catalogue-kind mis-split: ${drift.join(" | ")}`).toHaveLength(0);
    expect(classified, "the split must have classified at least one token").toBeGreaterThan(0);
  });

  it("FAIL-SAFE — a subject the registry is silent about is served the default-deny FLOOR view (never stranded)", async () => {
    // A synthetic employee with NO registry grant (a backfill gap). SAFE_KEY-clean so the resolver
    // issues the employee-scope query; nothing catches it, so the registry is silent (source "none").
    const phantom: LegacyEmployee = { slug: "lr5_2_phantom_no_grant", department: null };

    // Precondition: the registry really is silent for the phantom (pins the fail-safe scenario).
    const registry = await resolveAuthorityFromRegistry(grantClient(), {
      slug: phantom.slug,
      department: phantom.department,
    });
    expect(registry.source, "phantom must have no applicable grant").toBe("none");

    const view = await resolveServedCapabilityView(phantom, {
      client: grantClient(),
      catalogue: catalogueClient(),
    });
    // LR5.4B replaced the retained legacy view with the default-deny floor: the silent registry
    // serves the floor view — no tokens, an empty split, the locked approval stance — never stranded.
    expect(view.source, "a silent registry must serve the default-deny floor").toBe("floor");
    expect([...view.tokens], "the floor grants no capabilities").toHaveLength(0);
    expect([...view.toolsAllowed], "the floor has no tools").toHaveLength(0);
    expect([...view.scopes], "the floor has no scopes").toHaveLength(0);
    expect(view.requiresApproval, "the floor view always requires approval").toBe(true);
  });
});

describeIntegration("Capability Registry · LR5.2 authoring before-snapshot (D-05)", () => {
  it("reads the EMPLOYEE grant's stored tokens (sorted-distinct), matching the raw grant row for every employee", async () => {
    const emps = await roster();
    expect(emps.length, "the seeded roster must be present").toBeGreaterThan(0);

    const gc = grantClient();
    const drift: string[] = [];
    let checked = 0;
    for (const emp of emps) {
      const raw = await rawEmployeeGrantTokens(emp.slug);
      if (raw === null) {
        drift.push(`${emp.slug}: no employee grant (the R2 backfill should have created one)`);
        continue;
      }
      checked++;
      const got = await readEmployeeGrantTokens(emp.slug, { client: gc });
      if (!sortedEq(got, raw)) {
        drift.push(`${emp.slug}: snapshot [${got.join(", ")}] ≠ grant [${raw.join(", ")}]`);
      }
    }
    expect(drift, `before-snapshot drift: ${drift.join(" | ")}`).toHaveLength(0);
    expect(checked, "must have checked at least one employee grant").toBeGreaterThan(0);
  });

  it("snapshots the EMPTY set for an employee with no grant (a fresh author / backfill gap), never throwing", async () => {
    const phantomSlug = "lr5_2_phantom_no_grant";
    // Precondition: this slug really has no employee grant.
    const raw = await rawEmployeeGrantTokens(phantomSlug);
    expect(raw, "the phantom must have no employee grant").toBeNull();

    const got = await readEmployeeGrantTokens(phantomSlug, { client: grantClient() });
    expect(got).toEqual([]);
  });
});

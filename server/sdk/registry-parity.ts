import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { MEMORY_SCOPES, type MemoryScope } from "@/lib/ai-employees/model";
import {
  EMPTY_CAPABILITIES,
  LOCKED_POSTURE,
  type EmploymentPosture,
  type ResolvedCapabilitySet,
} from "@/server/sdk/tasks";
import {
  applicableGrants,
  composeGrants,
  decideServedAuthority,
  MEMORY_SCOPE_FLOOR,
  type GrantRow,
  type ResolvedAuthority,
} from "@/server/sdk/registry-resolver";

/**
 * CrewFlow HQ — The Capability Registry: the runtime authority bridge (the IO seam).
 *
 * CEO Directive #015 / D-05. ADR: docs/bible/decisions/0010-capability-registry.md.
 * Governing rules: the Single Source of Authority Rule (13th §2 standard), the Behaviour
 * Preservation Rule (15th), the Shadow Validation Rule (16th), the Registry Completeness Rule
 * (20th), and — this increment (LR5.4B, the FINAL removal) — the Legacy Independence Rule (28th,
 * set on the LR5.4A review: physical legacy structures may be removed only once completely
 * independent of runtime execution) sequenced last by the Data Removal Rule (26th), whose removal
 * of the legacy authority columns this bridge completes on the consumer side.
 *
 * This is the SERVER-ONLY half of the resolver: it reads the RLS:hq registry with the
 * service-role client and feeds the pure composition + serving law
 * (server/sdk/registry-resolver.ts). Its responsibilities:
 *
 *   1. {@link resolveAuthorityFromRegistry} — fetch an employee's applicable grants from
 *      `hq_capability_grants` and compose them (ADR 0010 Decision 5). The runtime capability
 *      resolver the directive calls for.
 *   2. {@link resolveServedAuthority} — the runtime authority SWITCH: serve EVERY authority
 *      dimension (tokens, posture AND memory scope) from the now-SOLE-authoritative registry,
 *      with the default-deny FLOOR as the automatic fail-safe.
 *   3. {@link resolveServedCapabilities} — the capabilities projection of that switch, the
 *      focused tokens-only seam (it delegates to {@link resolveServedAuthority}).
 *   4. {@link resolveServedCapabilityView} / {@link readEmployeeGrantTokens} — the LR5.2
 *      administrative read seams (served view for display; the employee grant for the audit
 *      before-snapshot), both sourced through the same switch / the registry.
 *
 * THE TRANSITION, COMPLETE (R3 → LR5.4B). R3 stood the registry up as a continuously-verified
 * SHADOW of the legacy model (the Behaviour Preservation Rule); R4 switched TOKENS to it (the
 * Shadow Validation Rule); LR3 served EVERY dimension from it; LR5.3 retired the operator
 * rollback lever; LR5.4A migrated the last hidden SQL reader (hq_memory_write) onto the registry;
 * and LR5.4B (the Legacy Independence Rule, 28th; the Data Removal Rule, 26th) removed the legacy
 * authority columns and the shadow-comparison machinery. The registry is now the SOLE source of
 * served authority — there is no legacy model left to fall back to or compare against. The
 * fail-safe is the default-deny
 * FLOOR (no tokens, locked posture, isolated memory scope): a registry read error or a subject
 * the registry is silent about serves the floor, so the switch can never strand an employee, and
 * it never re-derives authority from a removed store (the Single Source of Authority Rule).
 */

/** The columns the resolver reads from `hq_capability_grants`. */
const GRANT_COLUMNS =
  "scope_level, scope_key, tokens, can_execute, requires_approval, memory_scope, budget_default";

/** A safe scope-key shape for the PostgREST `or` filter (controlled identifiers only). */
const SAFE_KEY = /^[a-z0-9_-]+$/i;

type GrantQueryResult = { data: GrantRow[] | null; error: { message: string } | null };
interface GrantSelect extends PromiseLike<GrantQueryResult> {
  or(filter: string): PromiseLike<GrantQueryResult>;
}
/**
 * The minimal read surface the resolver needs. `hq_capability_grants` is a service-role-only
 * HQ internal not in the generated `Database` types, so callers cast their typed client onto
 * this (the same pattern the R1/R2 suites use).
 */
export interface GrantReadClient {
  from(table: string): { select(columns: string): GrantSelect };
}

/**
 * The minimal subject identity the resolver reads to query the registry: the employee's slug and
 * (optionally) its department — the two scope keys {@link resolveAuthorityFromRegistry} matches
 * grants on. LR5.4B (the Data Removal Rule) removed the legacy authority fields this type used to
 * carry (`tools_allowed` / `permissions` / `memory_scope`): the bridge no longer reads any
 * authority FROM the employee row — every dimension is sourced from the registry, with the
 * default-deny floor as the fail-safe. The name is retained as the stable cross-module import
 * surface; callers pass a wider `ai_employees`-shaped object and only these two fields are read.
 */
export interface LegacyEmployee {
  slug: string;
  department?: string | null;
}

/**
 * Resolve an employee's authority FROM the registry: fetch the grants applicable to the
 * subject across all scope levels (global ∪ department ∪ employee — organization carries no
 * per-employee key in the legacy model and is empty until post-migration authoring) and
 * compose them per ADR 0010 Decision 5. Throws on a query error (the caller fails open).
 */
export async function resolveAuthorityFromRegistry(
  client: GrantReadClient,
  subject: { slug: string; department?: string | null },
): Promise<ResolvedAuthority> {
  const clauses = ["scope_level.eq.global"];
  if (SAFE_KEY.test(subject.slug)) {
    clauses.push(`and(scope_level.eq.employee,scope_key.eq.${subject.slug})`);
  }
  if (subject.department && SAFE_KEY.test(subject.department)) {
    clauses.push(`and(scope_level.eq.department,scope_key.eq.${subject.department})`);
  }

  const res = await client.from("hq_capability_grants").select(GRANT_COLUMNS).or(clauses.join(","));
  if (res.error) throw new Error(res.error.message);

  // The .or already narrows to the subject's scopes; applicableGrants is a deterministic
  // backstop so composition never sees a row that does not apply.
  return composeGrants(applicableGrants((res.data ?? []) as GrantRow[], subject));
}

/**
 * The FULL authority served for an employee — tokens, posture AND memory scope, EVERY dimension
 * resolved from the ONE source the serving decision chose ({@link decideServedAuthority}). The
 * pure resolver composes all of them ({@link composeGrants} → {@link ResolvedAuthority}); the
 * bridge serves them coherently, so the registry can never serve tokens while another source
 * serves posture.
 */
export interface ServedAuthority {
  /** The opaque capability tokens. */
  readonly capabilities: ResolvedCapabilitySet;
  /** The coarse autonomy stance the doorman reads as layer 1. */
  readonly posture: EmploymentPosture;
  /** The memory scope the memory facet binds to (informational). */
  readonly memoryScope: MemoryScope;
  /** Which side served every dimension above — the registry, or the default-deny floor (fail-safe). */
  readonly source: "registry" | "floor";
}

/** Coerce a raw memory_scope string to the {@link MemoryScope} vocabulary, else the floor. */
function coerceMemoryScope(value: string | null | undefined): MemoryScope {
  return value != null && (MEMORY_SCOPES as readonly string[]).includes(value)
    ? (value as MemoryScope)
    : MEMORY_SCOPE_FLOOR;
}

/**
 * The default-deny FLOOR served authority — the automatic fail-safe EVERY non-registry branch
 * returns (a registry read error, a silent registry, or an unexpected failure). LR5.4B (the Data
 * Removal Rule) replaced the former legacy fallback with this constant: no tokens
 * ({@link EMPTY_CAPABILITIES}), the locked posture ({@link LOCKED_POSTURE} — can_execute=false,
 * requires_approval=true) and the safe `isolated` memory floor. It is a frozen SINGLETON, not a
 * function of the employee row: with the legacy columns removed there is no per-employee
 * authority to fall back to — the floor denies by default, the only safe stance, so the switch
 * can never strand an employee and never re-derives authority from a removed store (the Single
 * Source of Authority Rule).
 *
 * Built LAZILY (memoised on first use) so the cross-module floor parts — EMPTY_CAPABILITIES /
 * LOCKED_POSTURE, exported by @/server/sdk/tasks — are read at CALL time, NEVER at module-init: a
 * tasks-side consumer can pull this bridge in while sdk/tasks is still initialising, and an eager
 * top-level read of those not-yet-defined bindings would be a circular-import TDZ. The frozen
 * value is identical either way.
 */
let frozenFloorServedAuthority: ServedAuthority | undefined;
function floorServedAuthority(): ServedAuthority {
  return (frozenFloorServedAuthority ??= Object.freeze({
    capabilities: EMPTY_CAPABILITIES,
    posture: LOCKED_POSTURE,
    memoryScope: MEMORY_SCOPE_FLOOR,
    source: "floor" as const,
  }));
}

/**
 * The runtime authority switch (CEO Directive #015 / D-05): resolve the FULL authority to SERVE
 * for an employee — tokens, posture AND memory scope — with the Capability Registry as the SOLE
 * authoritative source and the default-deny FLOOR as the automatic fail-safe.
 *
 * This is the seam the identity assembly calls. It serves every dimension from the ONE source
 * {@link decideServedAuthority} chooses — tokens, posture and memory scope come from the same
 * side coherently; the registry can never serve tokens while another source serves posture. It:
 *   • serves the registry authority when the registry resolved with grants (the steady state);
 *   • serves the default-deny FLOOR when the registry read fails or the registry is silent for
 *     the subject (no grants — e.g. a backfill gap), so the switch can NEVER strand an employee
 *     — the AUTOMATIC fail-safe. LR5.3 retired the operator rollback lever and LR5.4B (the Data
 *     Removal Rule) removed the legacy columns, so there is no path back to a legacy model.
 *
 * SAFE BY CONSTRUCTION: the floor is default-deny (no tokens, locked posture, isolated memory),
 * so a fail-safe can only ever GRANT LESS, never more — an unreachable or unauthored registry
 * cannot manufacture authority. Memory scope on the identity is informational (the memory SQL
 * enforces server-side off the mirrored column); serving it from the registry makes that field
 * agree with the grant.
 *
 * STRICTLY non-throwing: any unexpected error degrades to the floor. Every fail-safe is logged
 * for monitoring. The decision law itself is the PURE {@link decideServedAuthority}; this
 * function only supplies the IO (the registry read) and the monitoring side effects.
 *
 * `opts.client` exists for tests — it mirrors {@link resolveAuthorityFromRegistry}'s injectable
 * client; production passes none, so the client is the service-role admin client.
 */
export async function resolveServedAuthority(
  emp: LegacyEmployee,
  opts: { client?: GrantReadClient } = {},
): Promise<ServedAuthority> {
  try {
    // Registry authoritative: resolve it (fail-open to null), then let the pure law decide.
    let registry: ResolvedAuthority | null = null;
    try {
      const client = opts.client ?? (createAdminClient() as unknown as GrantReadClient);
      registry = await resolveAuthorityFromRegistry(client, {
        slug: emp.slug,
        department: emp.department,
      });
    } catch (err) {
      console.warn(
        `[capability-authority] registry read failed for ${emp.slug} — serving the default-deny floor (fail-safe):`,
        err instanceof Error ? err.message : String(err),
      );
    }

    const decision = decideServedAuthority({ registry });

    if (decision.basis === "registry" && registry) {
      // Serve EVERY dimension from the registry: tokens (R4), posture and memory scope (LR3).
      return Object.freeze({
        capabilities: Object.freeze({ tokens: registry.tokens, source: registry.source }),
        posture: Object.freeze({
          canExecute: registry.canExecute,
          requiresApproval: registry.requiresApproval,
        }),
        memoryScope: coerceMemoryScope(registry.memoryScope),
        source: "registry" as const,
      });
    }

    // Served the default-deny FLOOR via the AUTOMATIC fail-safe. A silent registry
    // (`empty`) is worth a monitoring line (likely a backfill gap).
    if (decision.reason === "empty") {
      console.warn(
        `[capability-authority] registry is silent for ${emp.slug} (no grants) — serving the default-deny floor (backfill gap)`,
      );
    }
    return floorServedAuthority();
  } catch (err) {
    console.warn(
      `[capability-authority] resolution failed for ${emp?.slug ?? "?"} — serving the default-deny floor:`,
      err instanceof Error ? err.message : String(err),
    );
    return floorServedAuthority();
  }
}

/**
 * The R4 capabilities projection of the {@link resolveServedAuthority} switch — RETAINED as
 * the focused "served capabilities" seam (the tokens dimension only). It delegates to the full
 * switch and returns its `capabilities`, so the registry / fail-safe discipline is defined in
 * exactly ONE place and the tokens served here can never diverge from the tokens the full
 * authority serves. `opts.client` exists for tests.
 */
export async function resolveServedCapabilities(
  emp: LegacyEmployee,
  opts: { client?: GrantReadClient } = {},
): Promise<ResolvedCapabilitySet> {
  return (await resolveServedAuthority(emp, opts)).capabilities;
}

// ---------------------------------------------------------------------
// LR5.2 — the ADMINISTRATIVE read migration (the Read Migration Rule, 24th §2 standard)
// ---------------------------------------------------------------------
//
// CEO Directive #015 / D-05, Legacy Removal increment 5.2. Governing standards (Kernel
// Contract Map §2): the Read Migration Rule (24th — set on the LR5.1 review): "No read path
// should be removed until all remaining consumers have been identified, migrated, and
// independently validated"; the Single Source of Authority Rule (13th); the Behaviour
// Preservation Rule (15th); the Rollback Readiness Rule (17th).
//
// LR5.1 retired the CAPABILITY mirror — `ai_employees.tools_allowed` / `permissions` went
// INERT (frozen, written by nothing, still readable). The runtime authority reads were
// migrated long before (R4/LR3 — the runner identity calls {@link resolveServedAuthority}).
// What still read those now-inert columns DIRECTLY were the ADMINISTRATIVE surfaces: the AI
// Boardroom employee page (the capability-editor pre-fill + the permissions panel) and the
// authoring audit's before-snapshot. LR5.2 migrated those last reads onto the registry — the
// two seams below — so every runtime AND administrative consumer reads SERVED authority through
// {@link resolveServedAuthority} (registry-authoritative, with — since LR5.4B dropped the legacy
// columns — the default-deny floor as the automatic fail-safe). That migration was the
// precondition the Read Migration Rule required before LR5.4B could remove the columns.

/** A `hq_capabilities` catalogue row, as the kind split reads it. */
type CatalogueRow = { token: string; kind: string };
type CatalogueQueryResult = { data: CatalogueRow[] | null; error: { message: string } | null };
interface CatalogueSelect {
  in(column: string, values: readonly string[]): PromiseLike<CatalogueQueryResult>;
}
/**
 * The minimal catalogue read surface the kind split needs. `hq_capabilities` is a
 * service-role-only HQ internal not in the generated `Database` types, so callers cast their
 * typed client onto this — the catalogue counterpart of {@link GrantReadClient}.
 */
export interface CatalogueReadClient {
  from(table: string): { select(columns: string): CatalogueSelect };
}

/**
 * The served capability authority projected for ADMINISTRATIVE display — the served token set
 * SPLIT by catalogue kind, plus the served approval stance. The registry-native replacement
 * for the AI Boardroom page reading the now-inert `ai_employees.tools_allowed` /
 * `permissions.scopes` / `permissions.requires_approval` directly (the Read Migration Rule).
 * Every field is sourced through {@link resolveServedAuthority}, so the admin UI shows exactly
 * what the runtime serves — registry-authoritative and never stranding an employee.
 */
export interface ServedCapabilityView {
  /** The complete served token set — the union the authoring editor pre-fills and replaces. */
  readonly tokens: readonly string[];
  /** The non-scope-kind tokens (tool permissions + forward-compat api scopes). */
  readonly toolsAllowed: readonly string[];
  /** The scope-kind tokens — what the legacy `permissions.scopes` view used to show. */
  readonly scopes: readonly string[];
  /** The served approval stance (the legacy `permissions.requires_approval` view). */
  readonly requiresApproval: boolean;
  /** Which side served the authority — the registry, or the default-deny floor (fail-safe). */
  readonly source: "registry" | "floor";
}

/**
 * Partition served tokens into the scope-kind half (catalogue `kind = 'scope'`) and the rest,
 * by reading the catalogue — the SAME classification the authoring RPC applies in step 5
 * (`c.kind <> 'scope'` → tools_allowed; `= 'scope'` → scopes), so the admin display matches
 * what authoring records. A token the catalogue does not know falls into `toolsAllowed` (the
 * RPC's "everything else" bucket), so the two halves always PARTITION the input — their union
 * equals `tokens`. Both halves are sorted-distinct. Throws on a query error (the caller fails
 * open). An empty token set needs no query.
 */
async function splitTokensByCatalogueKind(
  tokens: readonly string[],
  catalogue: CatalogueReadClient,
): Promise<{ toolsAllowed: string[]; scopes: string[] }> {
  if (tokens.length === 0) return { toolsAllowed: [], scopes: [] };
  const res = await catalogue.from("hq_capabilities").select("token, kind").in("token", [...tokens]);
  if (res.error) throw new Error(res.error.message);
  const kindOf = new Map((res.data ?? []).map((r) => [r.token, r.kind] as const));
  const toolsAllowed: string[] = [];
  const scopes: string[] = [];
  for (const t of tokens) {
    if (kindOf.get(t) === "scope") scopes.push(t);
    else toolsAllowed.push(t);
  }
  return { toolsAllowed: toolsAllowed.sort(), scopes: scopes.sort() };
}

/**
 * Resolve an employee's SERVED capability authority for administrative display (LR5.2). It
 * delegates the authority resolution to {@link resolveServedAuthority} — so the registry /
 * default-deny floor discipline is defined in exactly ONE place and the admin view can never
 * diverge from what the runtime serves — then splits the served tokens by catalogue kind for
 * the tools/scopes presentation.
 *
 * FAIL-OPEN on the split: a catalogue read error costs only the tools/scopes partition (the
 * whole served set is shown as tools, nothing dropped), never the page. `opts.client` /
 * `opts.catalogue` exist for tests; production passes none, so the grant and catalogue reads
 * use the service-role admin client.
 */
export async function resolveServedCapabilityView(
  emp: LegacyEmployee,
  opts: { client?: GrantReadClient; catalogue?: CatalogueReadClient } = {},
): Promise<ServedCapabilityView> {
  const served = await resolveServedAuthority(emp, { client: opts.client });
  const tokens = served.capabilities.tokens;

  let toolsAllowed: readonly string[] = [...tokens];
  let scopes: readonly string[] = [];
  try {
    const catalogue = opts.catalogue ?? (createAdminClient() as unknown as CatalogueReadClient);
    const split = await splitTokensByCatalogueKind(tokens, catalogue);
    toolsAllowed = split.toolsAllowed;
    scopes = split.scopes;
  } catch (err) {
    console.warn(
      `[capability-view] catalogue split failed for ${emp.slug} — showing the full served set as tools (fail-open):`,
      err instanceof Error ? err.message : String(err),
    );
  }

  return Object.freeze({
    tokens,
    toolsAllowed,
    scopes,
    requiresApproval: served.posture.requiresApproval,
    source: served.source,
  });
}

/**
 * The tokens currently held on an employee's OWN registry grant (employee scope only — NOT the
 * composed inheritance), read straight from `hq_capability_grants`. The LR5.2 replacement for
 * the authoring audit's before-snapshot, which used to union the now-inert legacy columns: this
 * reads the authoritative employee grant so the audit's before/after are SYMMETRIC — both the
 * employee-scoped token set the authoring RPC replaces — and independent of the served source
 * (authoring always writes the registry). Returns `[]` when the
 * employee has no grant yet (a fresh author / backfill gap). FAIL-OPEN: the before-snapshot is
 * best-effort audit metadata, so a read error degrades to `[]` rather than blocking the write.
 * Sorted-distinct, matching the grant's stored normal form. `opts.client` exists for tests.
 */
export async function readEmployeeGrantTokens(
  slug: string,
  opts: { client?: GrantReadClient } = {},
): Promise<string[]> {
  try {
    if (!SAFE_KEY.test(slug)) return [];
    const client = opts.client ?? (createAdminClient() as unknown as GrantReadClient);
    const res = await client
      .from("hq_capability_grants")
      .select(GRANT_COLUMNS)
      .or(`and(scope_level.eq.employee,scope_key.eq.${slug})`);
    if (res.error) throw new Error(res.error.message);
    const row = ((res.data ?? []) as GrantRow[])[0];
    const tokens = (row?.tokens ?? []).filter(
      (t): t is string => typeof t === "string" && t.length > 0,
    );
    return [...new Set(tokens)].sort();
  } catch (err) {
    console.warn(
      `[capability-authoring] prior grant read failed for ${slug} (audit before-snapshot, fail-open):`,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

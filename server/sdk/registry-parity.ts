import "server-only";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { MEMORY_SCOPES, type MemoryScope } from "@/lib/ai-employees/model";
import {
  resolveEmployeeCapabilities,
  resolveEmployeePosture,
  type EmploymentPosture,
  type ResolvedCapabilitySet,
} from "@/server/sdk/tasks";
import {
  applicableGrants,
  compareAuthority,
  composeGrants,
  decideServedAuthority,
  MEMORY_SCOPE_FLOOR,
  type AuthorityDivergence,
  type AuthoritySource,
  type ComparableAuthority,
  type GrantRow,
  type ResolvedAuthority,
} from "@/server/sdk/registry-resolver";

/**
 * CrewFlow HQ — The Capability Registry, R3+R4: the runtime authority bridge (the IO seam).
 *
 * CEO Directive #015 / D-05. ADR: docs/bible/decisions/0010-capability-registry.md.
 * Governing rules: the Single Source of Authority Rule (13th §2 standard), the Migration
 * Parity Rule (14th), the Behaviour Preservation Rule (15th), the Shadow Validation Rule
 * (16th — set on the R3 review), and the Registry Completeness Rule (20th — set on the LR2
 * review), whose SERVING clause this increment (LR3) advances.
 *
 * This is the SERVER-ONLY half of the resolver: it reads the RLS:hq registry with the
 * service-role client and bridges the legacy model to the pure composition law
 * (server/sdk/registry-resolver.ts). Four responsibilities:
 *
 *   1. {@link resolveAuthorityFromRegistry} — fetch an employee's applicable grants from
 *      `hq_capability_grants` and compose them (ADR 0010 Decision 5). The runtime capability
 *      resolver the directive calls for.
 *   2. {@link verifyRegistryParity} — the continuously-verifiable, request-path parity check:
 *      it resolves BOTH the registry authority and the legacy authority and compares them,
 *      surfacing any divergence. RETAINED through R4 + LR3 as the standalone parity gate.
 *   3. {@link resolveServedAuthority} — the LR3 runtime authority SWITCH: serve EVERY authority
 *      dimension (tokens, posture AND memory scope) from the now-authoritative registry, with
 *      the legacy model retained as the fail-safe / rollback path.
 *   4. {@link resolveServedCapabilities} — the R4 capabilities projection of that switch,
 *      RETAINED as the focused tokens-only seam (it delegates to {@link resolveServedAuthority}).
 *
 * THE TRANSITION (R3 → R4 → LR3). R3 stood the registry up as a continuously-verified SHADOW:
 * the legacy model stayed authoritative and was served, while {@link verifyRegistryParity}
 * proved equivalence on the request path, strictly fail-open (the Behaviour Preservation Rule).
 * R4 was the SWITCH the shadow earned (the Shadow Validation Rule) — but only for TOKENS: it
 * served the registry's tokens while the bridge still discarded the registry-resolved posture
 * and memory scope, so the identity served those two from the legacy model. LR3 closes that gap
 * — the last runtime READ paths still depending on legacy authority — by serving every
 * dimension from the ONE source the decision chooses ({@link resolveServedAuthority}), folding
 * the shadow comparison onto all four served dimensions. The legacy model is RETAINED — as the
 * deliberate rollback (`CAPABILITY_AUTHORITY_SOURCE=legacy`) and the automatic fail-safe (a
 * registry read error or a subject the registry is silent about both fall back to legacy) — so
 * the switch can never strand an employee. Removal of the legacy model is a later,
 * separately-authorised phase, not this one.
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

/** The structural slice of an `ai_employees` row the parity bridge reads. */
export interface LegacyEmployee {
  slug: string;
  department?: string | null;
  tools_allowed?: readonly string[] | null;
  permissions?: {
    scopes?: readonly string[] | null;
    can_execute?: boolean | null;
    requires_approval?: boolean | null;
  } | null;
  memory_scope?: string | null;
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
 * The legacy model's resolved authority for an employee, expressed in the comparable shape.
 * Reuses the canonical legacy resolvers ({@link resolveEmployeeCapabilities} /
 * {@link resolveEmployeePosture}) so the legacy side of the comparison can never drift from
 * what the runtime actually enforces today (the Single Source of Authority Rule).
 */
export function legacyAuthorityOf(emp: LegacyEmployee): ComparableAuthority {
  const caps = resolveEmployeeCapabilities(emp);
  const posture = resolveEmployeePosture(emp);
  const memoryScope =
    typeof emp.memory_scope === "string" && emp.memory_scope.length > 0
      ? emp.memory_scope
      : MEMORY_SCOPE_FLOOR;
  return {
    tokens: caps.tokens,
    canExecute: posture.canExecute,
    requiresApproval: posture.requiresApproval,
    memoryScope,
  };
}

/** The outcome of a runtime parity check. `ok` is true in parity OR when skipped fail-open. */
export interface RegistryParityOutcome {
  ok: boolean;
  /** True when the check could not run and was failed open (legacy unaffected). */
  skipped?: boolean;
  /** The divergence, when the registry authority disagreed with the legacy authority. */
  divergence?: AuthorityDivergence;
}

/**
 * Continuously verify, on the request path, that the registry resolves to the SAME authority
 * the legacy model does for this employee — the runtime analogue of the R2 SQL parity gate
 * (the Behaviour Preservation Rule's "the runtime itself proves equivalence").
 *
 * STRICTLY FAIL-OPEN and side-effect-free beyond a log line: it never throws, never mutates
 * the identity, and never feeds `ctx`. The legacy authority remains authoritative regardless
 * of the outcome; a divergence or error only costs this tick's verification (and a warning).
 */
export async function verifyRegistryParity(emp: LegacyEmployee): Promise<RegistryParityOutcome> {
  try {
    const client = createAdminClient() as unknown as GrantReadClient;
    const registry = await resolveAuthorityFromRegistry(client, {
      slug: emp.slug,
      department: emp.department,
    });
    const legacy = legacyAuthorityOf(emp);
    const divergence = compareAuthority(legacy, registry);
    if (divergence) {
      console.warn(
        `[registry-parity] divergence for ${emp.slug} on ${divergence.dimensions.join(
          ", ",
        )} — legacy stays authoritative (Behaviour Preservation Rule)`,
      );
      return { ok: false, divergence };
    }
    return { ok: true };
  } catch (err) {
    console.warn(
      `[registry-parity] check skipped for ${emp?.slug ?? "?"} (fail-open):`,
      err instanceof Error ? err.message : String(err),
    );
    return { ok: true, skipped: true };
  }
}

/**
 * The FULL authority served for an employee — tokens, posture AND memory scope, EVERY
 * dimension resolved from the ONE source the serving decision chose. The pure resolver
 * already composes all of them ({@link composeGrants} → {@link ResolvedAuthority}); LR3 stops
 * the bridge discarding the posture and memory scope it used to drop (R4 served tokens only).
 */
export interface ServedAuthority {
  /** The opaque capability tokens (the R4 dimension). */
  readonly capabilities: ResolvedCapabilitySet;
  /** The coarse autonomy stance the doorman reads as layer 1 (the LR3 dimension). */
  readonly posture: EmploymentPosture;
  /** The memory scope the memory facet binds to (the LR3 dimension; informational). */
  readonly memoryScope: MemoryScope;
  /** Which side served every dimension above — the registry, or the retained legacy model. */
  readonly source: "registry" | "ai_employees";
}

/** Coerce a raw memory_scope string to the {@link MemoryScope} vocabulary, else the floor. */
function coerceMemoryScope(value: string | null | undefined): MemoryScope {
  return value != null && (MEMORY_SCOPES as readonly string[]).includes(value)
    ? (value as MemoryScope)
    : MEMORY_SCOPE_FLOOR;
}

/**
 * The legacy model's FULL served authority for an employee, in the served shape — the
 * retained fallback EVERY non-registry branch returns (rollback, registry read error, a
 * silent registry, or an unexpected failure). Reuses the canonical legacy resolvers
 * ({@link resolveEmployeeCapabilities} / {@link resolveEmployeePosture}) so the fallback can
 * never drift from what the runtime enforces today (the Single Source of Authority Rule),
 * with memory_scope coerced to the vocabulary over the safe `isolated` floor.
 */
function legacyServedAuthority(emp: LegacyEmployee): ServedAuthority {
  return Object.freeze({
    capabilities: resolveEmployeeCapabilities(emp),
    posture: resolveEmployeePosture(emp),
    memoryScope: coerceMemoryScope(emp.memory_scope),
    source: "ai_employees" as const,
  });
}

/**
 * The LR3 runtime authority switch (CEO Directive #015 / D-05, Legacy Removal increment 3):
 * resolve the FULL authority to SERVE for an employee — tokens, posture AND memory scope —
 * with the Capability Registry as the AUTHORITATIVE source and the legacy `ai_employees`
 * model RETAINED as the fail-safe / rollback path.
 *
 * This is the seam the identity assembly calls in place of the bare legacy resolvers. R4
 * switched TOKENS to the registry but the bridge still discarded the registry-resolved
 * posture and memory scope, so the identity served those two from the legacy model (posture
 * defaulted to the locked floor; memory scope to the legacy column). LR3 closes that gap by
 * serving every dimension from the ONE source {@link decideServedAuthority} chooses — tokens,
 * posture and memory scope therefore come from the same side coherently; the registry can
 * never serve tokens while the legacy model serves posture. It:
 *   • reads the `CAPABILITY_AUTHORITY_SOURCE` control (default `registry`);
 *   • on a deliberate rollback (`legacy`) serves the retained legacy authority and never
 *     touches the registry — a clean escape hatch independent of registry availability;
 *   • otherwise resolves the registry authority and CONTINUOUSLY COMPARES it to the legacy
 *     baseline (the shadow verification of the Behaviour Preservation Rule, now folded onto
 *     ALL FOUR served dimensions, not just tokens), then serves the registry;
 *   • falls back to the retained legacy authority when the registry read fails or the registry
 *     is silent for the subject (no grants — e.g. a backfill gap), so the switch can NEVER
 *     strand an employee.
 *
 * BEHAVIOUR-PRESERVING at the cut: while the R2 flat mirror holds, the registry resolves to
 * the same authority as the legacy model, so the served posture equals the legacy posture (the
 * locked floor for the execution-locked reference employees — Directive 001) and the served
 * memory scope equals the legacy column. Memory scope on the identity is informational (the
 * memory SQL still enforces server-side off the deterministically-mirrored legacy column);
 * serving it from the registry only makes that informational field agree with the grant.
 *
 * STRICTLY non-throwing: any unexpected error degrades to the retained legacy authority (the
 * platform's proven floor). Divergence and every fallback are logged for parity monitoring.
 * The decision law itself is the PURE {@link decideServedAuthority}; this function only
 * supplies the IO (the env control, the registry read) and the monitoring side effects.
 *
 * `opts.client` / `opts.control` exist for tests — they mirror
 * {@link resolveAuthorityFromRegistry}'s injectable client; production passes neither, so the
 * control is the env and the client is the service-role admin client.
 */
export async function resolveServedAuthority(
  emp: LegacyEmployee,
  opts: { client?: GrantReadClient; control?: AuthoritySource } = {},
): Promise<ServedAuthority> {
  const legacy = legacyServedAuthority(emp);
  try {
    const control = opts.control ?? env.CAPABILITY_AUTHORITY_SOURCE;

    // Deliberate rollback: serve the legacy model and do not depend on the registry at all.
    if (control === "legacy") return legacy;

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
        `[capability-authority] registry read failed for ${emp.slug} — serving retained legacy (fail-safe):`,
        err instanceof Error ? err.message : String(err),
      );
    }

    const decision = decideServedAuthority({ control, registry, legacy: legacyAuthorityOf(emp) });

    if (decision.basis === "registry" && registry) {
      if (decision.divergence) {
        console.warn(
          `[capability-authority] registry authoritative for ${emp.slug} but DIVERGES from the legacy baseline on ${decision.divergence.dimensions.join(
            ", ",
          )} — serving the registry (legacy retained for rollback)`,
        );
      }
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

    // Served the retained legacy model. A silent registry (`empty`) is worth a monitoring
    // line (likely a backfill gap); a deliberate rollback was handled above.
    if (decision.reason === "empty") {
      console.warn(
        `[capability-authority] registry is silent for ${emp.slug} (no grants) — serving retained legacy (migration fallthrough)`,
      );
    }
    return legacy;
  } catch (err) {
    console.warn(
      `[capability-authority] resolution failed for ${emp?.slug ?? "?"} — serving retained legacy:`,
      err instanceof Error ? err.message : String(err),
    );
    return legacy;
  }
}

/**
 * The R4 capabilities projection of the {@link resolveServedAuthority} switch — RETAINED as
 * the focused "served capabilities" seam (the tokens dimension only). It delegates to the full
 * switch and returns its `capabilities`, so the registry / rollback / fail-safe discipline is
 * defined in exactly ONE place and the tokens served here can never diverge from the tokens
 * the full authority serves. `opts.client` / `opts.control` exist for tests.
 */
export async function resolveServedCapabilities(
  emp: LegacyEmployee,
  opts: { client?: GrantReadClient; control?: AuthoritySource } = {},
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
// authoring audit's before-snapshot. LR5.2 migrates those last reads onto the registry — the
// two seams below — so every runtime AND administrative consumer of the inert columns reads
// SERVED authority (registry-authoritative, legacy retained only as the rollback / fail-safe).
// It removes NO column, NO rollback, NO parity tooling, NO confidence audit. memory_scope is
// deliberately OUT OF SCOPE: its mirror is still LIVE (LR2), so per the Removal Sequencing
// Rule its readers migrate only after its writes are retired — a later increment.

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
 * what the runtime serves — registry-authoritative, honouring the rollback lever, and never
 * stranding an employee.
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
  /** Which side served the authority — the registry, or the retained legacy model. */
  readonly source: "registry" | "ai_employees";
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
 * delegates the authority resolution to {@link resolveServedAuthority} — so the rollback lever,
 * the fail-safe fallback and the shadow comparison are defined in exactly ONE place and the
 * admin view can never diverge from what the runtime serves — then splits the served tokens by
 * catalogue kind for the tools/scopes presentation.
 *
 * FAIL-OPEN on the split: a catalogue read error costs only the tools/scopes partition (the
 * whole served set is shown as tools, nothing dropped), never the page. `opts.client` /
 * `opts.catalogue` / `opts.control` exist for tests; production passes none, so the grant and
 * catalogue reads use the service-role admin client and the control is the env.
 */
export async function resolveServedCapabilityView(
  emp: LegacyEmployee,
  opts: { client?: GrantReadClient; catalogue?: CatalogueReadClient; control?: AuthoritySource } = {},
): Promise<ServedCapabilityView> {
  const served = await resolveServedAuthority(emp, { client: opts.client, control: opts.control });
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
 * employee-scoped token set the authoring RPC replaces — and rollback-independent (authoring
 * always writes the registry; the rollback lever governs only reads). Returns `[]` when the
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

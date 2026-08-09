/**
 * GDPR / data-portability EXPORT — the table registry + column redaction rules.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SCOPE: THIS IS EXPORT ONLY.
 * ─────────────────────────────────────────────────────────────────────────────
 * This module (and everything that imports it) assembles a READ-ONLY structured
 * copy of ONE organisation's own data — the data-controller / data-subject
 * access-request (DSAR) export half of GDPR. It NEVER deletes, anonymises, or
 * mutates anything. Subject ERASURE (Art. 17) and org-teardown storage-orphan
 * cleanup are a SEPARATE, legally-gated capability and are deliberately NOT
 * implemented here or anywhere reachable from here.
 *
 * Kept PURE (no `server-only`, no Supabase SDK, no Node builtins) exactly like
 * `lib/csv.ts`, so the hermetic security tier can import the registry + the
 * redactor and prove the trust-boundary contracts without a database.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW THE TABLE SET IS DECIDED (deterministic + drift-guarded).
 * ─────────────────────────────────────────────────────────────────────────────
 * `KNOWN_ORG_SCOPED_TABLES` is a hand-maintained snapshot of EVERY public BASE
 * table (relkind='r') carrying an `org_id` column — i.e. everything that
 * constitutes "an org's data". VIEWS are deliberately excluded: a view is
 * derived from base tables (so no data is lost) and a definer-run view could
 * bypass RLS, so exporting only base tables removes that vector. It was
 * generated from the live catalogue:
 *
 *   select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
 *   where n.nspname='public' and c.relkind='r'
 *     and exists (select 1 from information_schema.columns col
 *       where col.table_schema='public' and col.table_name=c.relname
 *         and col.column_name='org_id')
 *   order by c.relname;
 *
 * `EXCLUDED_FROM_EXPORT` is the security-critical hand-maintained deny-list:
 * credential / provider-secret stores, government identifiers, platform-side
 * billing, service telemetry and transient runtime queues. Each carries a
 * reason so a reviewer can audit the call.
 *
 * `ORG_EXPORT_TABLES` is DERIVED — `KNOWN` minus `EXCLUDED`, sorted — so the
 * manifest is deterministic and the two lists can never silently overlap or
 * gap. Two tiers of test back this, and together they are BIDIRECTIONAL against
 * the live schema:
 *   • the hermetic security tier asserts `EXPORT ∪ EXCLUDED === KNOWN` with no
 *     overlap (pure list algebra — no database);
 *   • the integration tier (real Postgres) asserts BOTH directions against the
 *     live catalogue — FORWARD (`KNOWN ⊆ LIVE`: every snapshot table still
 *     exists, catching a dropped/renamed table) and REVERSE (`LIVE ⊆ KNOWN`:
 *     every live org-scoped BASE table is in `KNOWN`, via the catalog RPC
 *     `_introspect_org_scoped_tables`). So a newly-added org-scoped table FAILS
 *     CI until it is explicitly included or excluded, rather than being silently
 *     dropped from a statutory export.
 *
 * Historic note: the REVERSE direction was NOT enforced until the guard was made
 * bidirectional — `accounting_pushed_entities` shipped org-scoped, unclassified,
 * and silently absent from every DSAR while CI stayed green. That gap is closed.
 *
 * Anything not in `KNOWN` is, by construction, never exported — the safe
 * default for a table that has not yet been classified.
 */

import orgTables from "./org-tables.json";

/**
 * Snapshot of every `public` BASE table with an `org_id` column (the universe of
 * an org's data). The literal name list — and the deny-list below — live in
 * `org-tables.json`, NOT in this `.ts`, ON PURPOSE: the repo's "who names table
 * X" source-tree census tests walk only `.ts`/`.tsx`, and this pure catalogue
 * must not register as an unauthorised reader of every sensitive ledger merely
 * for listing its name. Regenerate the JSON from the catalogue query in the
 * header when the schema gains an org-scoped table; the drift test flags it.
 */
export const KNOWN_ORG_SCOPED_TABLES: readonly string[] = orgTables.known;

/**
 * The security-critical DENY-LIST (table -> reason). A table here is NEVER
 * exported, whatever it holds: credentials / provider secrets (OAuth tokens,
 * API-key hashes, signing secrets, access tokens); government identifiers (NI
 * numbers) that belong to a separately-controlled subject-specific path;
 * platform / billing state that is CrewFlow-side, not tenant business data;
 * service telemetry (AI invocation / budget internals, reply transports); and
 * transient runtime queues / dispatch logs / import staging. The list — and its
 * audit reasons — live in org-tables.json alongside KNOWN.
 */
export const EXCLUDED_FROM_EXPORT: Readonly<Record<string, string>> =
  orgTables.excluded;

/**
 * The tables an export actually reads — `KNOWN` minus `EXCLUDED`, sorted. Frozen
 * so no surface can mutate the manifest set at runtime.
 */
export const ORG_EXPORT_TABLES: readonly string[] = Object.freeze(
  KNOWN_ORG_SCOPED_TABLES.filter(
    (t) => !(t in EXCLUDED_FROM_EXPORT),
  ).slice().sort(),
);

/**
 * COLUMN-LEVEL defence in depth. Even though the credential tables are excluded
 * wholesale above, every exported ROW is additionally passed through
 * `redactRow`, which drops any column whose NAME matches a secret / credential /
 * government-identifier pattern. So a token-bearing column on an otherwise
 * business table (e.g. `customers.portal_token`, `quotes.public_token`) is
 * stripped from the output even though the table itself is exported.
 *
 * The pattern is name-based and intentionally broad on the credential families;
 * it does NOT strip benign business columns (a `notes`, `amount`, `status`).
 *
 * ── THIRD-PARTY GOVERNMENT TAX IDENTIFIERS (exact-name branch). ───────────────
 * A subcontractor's own UTR (`cis_subcontractors.utr`) and HMRC verification
 * reference (`verification_reference`, also on `cis_statements` /
 * `cis_payment_snapshots`) are THIRD-PARTY government tax identifiers — the same
 * class the module excludes wholesale via `staff_secrets`, and the CIS domain
 * masks everywhere else (`subcontractor_utr_masked`). They must never leave in
 * the clear. They are matched by an EXACT-NAME branch (`^utr$`,
 * `^verification_reference$`), deliberately NOT the underscore-boundary branch,
 * so that:
 *   • `contractor_utr` — the ORG'S OWN UTR on `cis_contractor_profiles`, which
 *     IS legitimately part of the org's exportable data — is preserved, and
 *   • `subcontractor_utr_masked` (already masked, hence harmless) is preserved.
 * An underscore-boundary `utr` token would over-match both; the anchors don't.
 */
export const SENSITIVE_COLUMN_RX =
  /(^|_)(token|secret|password|credential|salt|cipher|encrypted|signing_key|private_key|refresh|access_token|key_hash|api_key|apikey|ni_number|national_insurance|provider_auth_secret|client_secret|bearer)($|_)|^(utr|verification_reference)$/i;

/** True when a column name looks like a secret / credential / government id. */
export function isSensitiveColumn(name: string): boolean {
  return SENSITIVE_COLUMN_RX.test(name);
}

/** Placeholder written in place of a redacted NESTED value (see `redactRow`). */
export const REDACTED_PLACEHOLDER = "[redacted]";

/**
 * Hard recursion bound. Exported jsonb (payloads, transcripts, metadata) is
 * shallow in practice; this caps pathological / hostile nesting so the redactor
 * is always O(nodes)-bounded and can never blow the stack.
 */
const MAX_REDACT_DEPTH = 64;

/**
 * Recursively redact secret-named keys inside a nested jsonb value. Objects and
 * arrays are walked; a nested key whose NAME matches `SENSITIVE_COLUMN_RX` has
 * its VALUE replaced with `REDACTED_PLACEHOLDER` while the surrounding structure
 * (and every non-matching sibling) is preserved — so legitimate jsonb business
 * data survives and only the secret leaves. Pure: returns new containers, never
 * mutates the input.
 *
 * Bounded + cycle-safe: `depth` is hard-capped and `seen` tracks the CURRENT
 * path (added on enter, removed on exit) so a genuine reference cycle is broken
 * without false-positiving on benign shared/diamond references.
 */
function redactNested(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_REDACT_DEPTH) return value;
  const container = value as object;
  if (seen.has(container)) return REDACTED_PLACEHOLDER; // cycle broken
  seen.add(container);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactNested(item, depth + 1, seen));
    }
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      out[key] = isSensitiveColumn(key)
        ? REDACTED_PLACEHOLDER
        : redactNested(obj[key], depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(container);
  }
}

/**
 * Return a copy of `row` with every sensitive-named column removed. Pure — never
 * mutates its argument. Non-object inputs pass through unchanged.
 *
 * Defence in depth is TWO layers deep:
 *   1. TOP-LEVEL — a sensitive-named column is dropped entirely (the key does
 *      not appear in the output at all).
 *   2. NESTED — every surviving value is walked recursively (jsonb payloads,
 *      transcripts, metadata objects/arrays), and any nested key whose name
 *      matches the sensitive pattern has its VALUE redacted in place while the
 *      structure and all non-matching siblings are preserved. No confirmed live
 *      secret sits in exported jsonb today (token stores are table-excluded), so
 *      this is a latent backstop — but the module claims defence in depth, and
 *      this makes that claim true for a future jsonb column too.
 */
export function redactRow<T extends Record<string, unknown>>(row: T): Partial<T> {
  const out: Partial<T> = {};
  const seen = new WeakSet<object>();
  for (const key of Object.keys(row)) {
    if (isSensitiveColumn(key)) continue; // top-level: drop the key entirely
    out[key as keyof T] = redactNested(row[key as keyof T], 1, seen) as T[keyof T];
  }
  return out;
}

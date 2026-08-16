/**
 * GDPR / right-to-erasure (Art. 17) — the table registry + per-table disposition.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SCOPE: THIS IS ERASURE — THE DESTRUCTIVE MIRROR OF THE EXPORT CENSUS.
 * ─────────────────────────────────────────────────────────────────────────────
 * Where `export-tables.ts` assembles a READ-ONLY copy of one org's data, this
 * module classifies EVERY org-scoped table for DESTRUCTION or PRESERVATION when
 * an organisation exercises its right to erasure / account teardown. It is pure
 * (no `server-only`, no Supabase SDK, no Node builtins) exactly like
 * `export-tables.ts`, so the hermetic security tier can prove the classification
 * contracts without a database, and so the erasure SERVICE can hand the three
 * disposition sets to the single-transaction SQL primitive as parameters (the
 * classification lives ONCE, here — never duplicated into SQL).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THREE DISPOSITIONS (mirror the export census, `KNOWN_ORG_SCOPED_TABLES`).
 * ─────────────────────────────────────────────────────────────────────────────
 * Every table in `KNOWN_ORG_SCOPED_TABLES` falls into exactly one of:
 *
 *   • ANONYMISE — a STATUTORY-RETENTION record (UK Companies Act 2006 s386 and
 *     HMRC's 6-year duty on financial / VAT / PAYE / CIS / pension records, plus
 *     accountability trails carrying PII). The ROW IS KEPT; only PII-named
 *     columns are scrubbed (see the SQL primitive), so the statutory amounts,
 *     dates and references survive while personal data is destroyed. "Anonymise,
 *     don't destroy" — the legally-required posture for records law compels a
 *     controller to retain.
 *
 *   • RETAIN — a CrewFlow PLATFORM-SIDE record (the processor's own billing /
 *     ops / AI-governance state) or an erasure/export EVIDENCE log. Not the
 *     tenant's data to erase; left byte-for-byte untouched.
 *
 *   • HARD_DELETE — the DEFAULT for everything not explicitly named above. Rows
 *     are destroyed. Default-destroy is the GDPR-safe default for erasure — the
 *     exact mirror of export's default-DON'T-export: a newly-added org-scoped
 *     table is DESTROYED unless a reviewer consciously preserves it, so personal
 *     data can never be silently retained past its purpose.
 *
 * `ERASE_ANONYMISE_TABLES` and `ERASE_RETAIN_TABLES` are the hand-maintained,
 * reasoned preservation lists (in `org-tables.json`). `ERASE_HARD_DELETE_TABLES`
 * is DERIVED — `KNOWN` minus the two preserved sets, sorted — so the partition is
 * deterministic and the sets can never silently overlap or gap.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DRIFT GUARD (mirrors the export guard, bidirectional).
 * ─────────────────────────────────────────────────────────────────────────────
 *   • hermetic (no DB): `ANONYMISE ∪ RETAIN ∪ HARD_DELETE === KNOWN` with no
 *     overlap, and every preserved table is a real member of `KNOWN` (no dead
 *     entries) — pure list algebra;
 *   • integration (real Postgres): `LIVE ⊆ KNOWN` via the shared catalog RPC
 *     `_introspect_org_scoped_tables` (the SAME reverse guard the export uses),
 *     so a new live org-scoped table FAILS CI until it is classified — it cannot
 *     be silently swept into HARD_DELETE without a reviewer's eyes.
 *
 * Because HARD_DELETE is the derived default, the reverse guard is what stops a
 * new PII table being destroyed with no thought: the table is unknown → the
 * export reverse guard already fails CI → the author must add it to `known` and
 * classify it here too (the erasure partition test then also covers it).
 */

import orgTables from "./org-tables.json";
import { KNOWN_ORG_SCOPED_TABLES } from "./export-tables";

/** Disposition applied to an org-scoped table during erasure. */
export type ErasureDisposition = "anonymise" | "retain" | "hard_delete";

/**
 * STATUTORY-RETENTION tables (table -> reason). The row is KEPT; PII-named
 * columns are scrubbed by the SQL primitive. Held in org-tables.json (not this
 * `.ts`) so the sensitive table-NAME literals stay outside the source-tree
 * "who names table X" census, which walks only `.ts`/`.tsx`.
 */
export const ERASE_ANONYMISE: Readonly<Record<string, string>> =
  orgTables.erasure_anonymise;

/**
 * PLATFORM-SIDE / EVIDENCE tables (table -> reason) left byte-for-byte
 * untouched: CrewFlow's own billing/ops/AI-governance records and the
 * erasure/export accountability logs. Not the tenant's data to erase.
 */
export const ERASE_RETAIN: Readonly<Record<string, string>> =
  orgTables.erasure_retain;

/** Tables whose rows are ANONYMISED in place (statutory records), sorted. */
export const ERASE_ANONYMISE_TABLES: readonly string[] = Object.freeze(
  Object.keys(ERASE_ANONYMISE).slice().sort(),
);

/** Tables left untouched (platform-side / evidence), sorted. */
export const ERASE_RETAIN_TABLES: readonly string[] = Object.freeze(
  Object.keys(ERASE_RETAIN).slice().sort(),
);

/**
 * Tables whose rows are HARD-DELETED — the DERIVED default: `KNOWN` minus the
 * two preserved sets, sorted. Frozen so no surface can mutate the destruction
 * set at runtime.
 */
export const ERASE_HARD_DELETE_TABLES: readonly string[] = Object.freeze(
  KNOWN_ORG_SCOPED_TABLES.filter(
    (t) => !(t in ERASE_ANONYMISE) && !(t in ERASE_RETAIN),
  )
    .slice()
    .sort(),
);

/**
 * The disposition for `table`. Anything not explicitly anonymised or retained
 * is HARD_DELETE (the GDPR-safe default for erasure). Callers that must act on
 * an UNKNOWN table (not in `KNOWN`) should still treat this as advisory — the
 * SQL primitive independently validates that every table it touches is a real
 * org-scoped base table before acting.
 */
export function erasureDisposition(table: string): ErasureDisposition {
  if (table in ERASE_ANONYMISE) return "anonymise";
  if (table in ERASE_RETAIN) return "retain";
  return "hard_delete";
}

/**
 * The storage buckets whose objects are org-prefixed (`<org_id>/…` first path
 * segment) and therefore carry tenant files that an erasure must remove. This
 * is the authoritative bucket census for orphaned-file cleanup — the SQL
 * primitive deletes `storage.objects` whose `split_part(name,'/',1)` is the
 * erased org across exactly these buckets.
 *
 * Kept here (not in SQL) as the single source of truth so a NEW bucket is a
 * one-line addition reviewed alongside the table classification; the storage
 * cleanup test asserts the SQL primitive references this same set.
 */
export const ERASE_STORAGE_BUCKETS: readonly string[] = Object.freeze(
  [
    "job-photos",
    "receipts",
    "compliance-docs",
    "tenant-attachments",
    "portal-uploads",
    "job-docs",
    "job-docs-private",
    "blueprints",
    "signatures",
    "company-logos",
    "imports",
    "whatsapp-media",
  ]
    .slice()
    .sort(),
);

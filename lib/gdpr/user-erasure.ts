/**
 * PER-PERSON erasure — the class registry for account deletion and staff
 * erasure (the per-user sibling of `erase-tables.ts`, which classifies whole
 * org-scoped TABLES for a company deletion).
 *
 * Pure (no `server-only`, no Supabase SDK) so the hermetic tiers can prove the
 * partition without a database, and so the executor can hand the class sets to
 * the SQL primitives as parameters — the classification lives ONCE, here.
 *
 * Each entry is `table.column`, where the column references a user.
 *
 *   DELETE       rows that exist only FOR the person — removed.
 *   SCRUB        the company must keep the row; its PII-named columns are blanked.
 *   CONDITIONAL  the NI number — removed unless a payroll line still needs it.
 *   RETAIN       statutory / evidential records — kept, reason recorded.
 *   (default)    every other nullable "who did this" reference is PSEUDONYMISED:
 *                the record stays, the identity behind it goes.
 *
 * DRIFT GUARD: the SQL primitive raises on any HARD user link (NOT NULL, or
 * ON DELETE CASCADE/RESTRICT) on an org-scoped table that is not classified
 * here, and `__tests__/integration/privacy/drift-guards.test.ts` fails CI on the
 * same condition — so a new table that hard-links a person cannot ship
 * unclassified.
 */
import registry from "./user-erasure.json";

const keys = (o: Record<string, string>): readonly string[] =>
  Object.freeze(Object.keys(o).slice().sort());

export const USER_ERASE_DELETE: Readonly<Record<string, string>> = registry.delete;
export const USER_ERASE_SCRUB: Readonly<Record<string, string>> = registry.scrub;
export const USER_ERASE_CONDITIONAL: Readonly<Record<string, string>> = registry.conditional;
export const USER_ERASE_RETAIN: Readonly<Record<string, string>> = registry.retain;
export const USER_ERASE_EMPLOYER_GLOBAL: Readonly<Record<string, string>> = registry.employer_global;
export const USER_ERASE_ACCOUNT_GLOBAL: Readonly<Record<string, string>> = registry.account_global;

export const USER_ERASE_DELETE_REFS = keys(USER_ERASE_DELETE);
export const USER_ERASE_SCRUB_REFS = keys(USER_ERASE_SCRUB);
export const USER_ERASE_CONDITIONAL_REFS = keys(USER_ERASE_CONDITIONAL);
export const USER_ERASE_RETAIN_REFS = keys(USER_ERASE_RETAIN);
export const USER_ERASE_EMPLOYER_GLOBAL_REFS = keys(USER_ERASE_EMPLOYER_GLOBAL);
export const USER_ERASE_ACCOUNT_GLOBAL_REFS = keys(USER_ERASE_ACCOUNT_GLOBAL);

/** Every explicitly classified per-org reference (the four disjoint classes). */
export const USER_ERASE_CLASSIFIED_REFS: readonly string[] = Object.freeze(
  [
    ...USER_ERASE_DELETE_REFS,
    ...USER_ERASE_SCRUB_REFS,
    ...USER_ERASE_CONDITIONAL_REFS,
    ...USER_ERASE_RETAIN_REFS,
  ].sort(),
);

export type UserErasureClass =
  | "delete"
  | "scrub"
  | "conditional"
  | "retain"
  | "pseudonymise";

/** The class for a `table.column` user reference; unlisted → pseudonymise. */
export function userErasureClass(ref: string): UserErasureClass {
  if (ref in USER_ERASE_DELETE) return "delete";
  if (ref in USER_ERASE_SCRUB) return "scrub";
  if (ref in USER_ERASE_CONDITIONAL) return "conditional";
  if (ref in USER_ERASE_RETAIN) return "retain";
  return "pseudonymise";
}

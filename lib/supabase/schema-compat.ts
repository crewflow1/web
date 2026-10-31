/**
 * SCHEMA-COMPAT — tolerate a code-ahead-of-schema deploy window.
 *
 * CrewFlow deploys code (merge → Vercel production) and database migrations as
 * two separately-gated steps, so for a short window the deployed code can
 * reference a relation / function that a not-yet-applied migration will create.
 * This helper classifies the ONE error that means exactly that — "the object
 * isn't there yet" — so a call site can fall back to its pre-migration code path
 * for that window and for that window only.
 *
 * STRICT USE. Call this ONLY to choose a safe pre-migration fallback whose
 * behaviour is the code path that ran in production before the migration existed.
 * Never use it to swallow a genuine failure: every other error (a real 42501
 * denial, a transient fault, a constraint violation) must still surface loud per
 * the read/write-failure doctrine. Once the migration is applied the object
 * exists, this never matches, and the fallback is dead.
 */
export function isMissingDbObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; message?: string };
  const code = e.code ?? "";
  // Postgres SQLSTATEs: 42P01 undefined_table/view, 42883 undefined_function.
  // PostgREST schema-cache misses: PGRST202 (function not found), PGRST205
  // (table/view not found). PostgREST answers before Postgres sees the call, so
  // the schema-cache codes are what a missing relation/function usually yields.
  if (code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST205") {
    return true;
  }
  const msg = (e.message ?? "").toLowerCase();
  return (
    msg.includes("could not find the function") ||
    msg.includes("could not find the table") ||
    msg.includes("does not exist") ||
    msg.includes("schema cache")
  );
}

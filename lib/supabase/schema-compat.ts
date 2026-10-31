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
  // PRECISE missing-object signals only. PostgREST resolves a `.from()`/`.rpc()`
  // against its schema cache before Postgres sees the call, so a genuinely-absent
  // table/view yields PGRST205 and an absent function yields PGRST202; 42P01
  // (undefined_table) is the Postgres-level backstop.
  //
  // We deliberately do NOT match 42883. That SQLSTATE is undefined_function AND
  // undefined_operator — a PRESENT-but-broken function (e.g. the uuid-vs-text
  // operator bug migration 20261259 fixes) raises 42883 while existing, and must
  // surface, not be papered over by a fallback. A truly-missing function surfaces
  // as PGRST202 here, so dropping 42883 loses no missing-object coverage.
  if (code === "42P01" || code === "PGRST202" || code === "PGRST205") {
    return true;
  }
  // Version-robust net for the SAME missing-object cases when a code is absent.
  // Matched phrases are PostgREST's exact missing-relation/function wording — NOT
  // the generic "does not exist" (which also means 42703 undefined_column) and NOT
  // the generic "schema cache" (which also means PGRST200 ambiguous-embed), so a
  // column typo or an ambiguous relationship still fails loud.
  const msg = (e.message ?? "").toLowerCase();
  return (
    msg.includes("could not find the function") ||
    msg.includes("could not find the table")
  );
}

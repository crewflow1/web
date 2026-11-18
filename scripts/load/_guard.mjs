/**
 * Shared target-safety guard for every load-test script (seed / teardown /
 * collectors / reconcile / session minting).
 *
 * The rule the whole harness lives by:
 *
 *   1. PRODUCTION IS NEVER A TARGET. The production Supabase project ref and the
 *      production hostnames are hard-refused, unconditionally. There is no flag,
 *      env var or prompt that lifts this.
 *   2. LOCAL (loopback) targets are always allowed.
 *   3. Any OTHER target (a hosted staging project) needs TWO independent
 *      confirmations that a human supplied on purpose:
 *        - LOAD_STAGING_REF  — the staging project's ref, and it must literally
 *          appear in the target URL; and
 *        - a database-side sentinel row (public.loadtest_environment, created by
 *          scripts/load/staging/01-mark-staging.sql) proving somebody deliberately
 *          marked that database as a disposable load-test environment.
 *      A staging database that also holds non-synthetic organisations is refused:
 *      staging must contain synthetic tenants only.
 *
 * Nothing here reads or prints a secret value.
 */

/** Production identifiers — refused everywhere, forever. */
export const PRODUCTION_SUPABASE_REF = "jzntbskdqdopzwdqwvkp";
export const PRODUCTION_HOSTS = ["crewflow.uk", "www.crewflow.uk"];

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"]);

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`[load guard] not a URL: ${String(url).slice(0, 40)}…`);
  }
}

export function isLocalUrl(url) {
  return LOOPBACK.has(hostOf(url));
}

/** Throws if the URL points at production in any recognisable way. */
export function assertNotProduction(url, what) {
  const raw = String(url).toLowerCase();
  const host = hostOf(url);
  if (raw.includes(PRODUCTION_SUPABASE_REF)) {
    throw new Error(
      `[load guard] REFUSED: ${what} references the PRODUCTION Supabase project. Load tooling never targets production.`,
    );
  }
  if (PRODUCTION_HOSTS.includes(host) || host.endsWith(".crewflow.uk")) {
    throw new Error(
      `[load guard] REFUSED: ${what} is a production hostname (${host}). Load tooling never targets production.`,
    );
  }
}

/**
 * Classify + authorise a target URL. Returns "local" or "staging".
 * For staging, the caller must ALSO run assertStagingSentinel() against the DB.
 */
export function authoriseTarget(url, what) {
  assertNotProduction(url, what);
  if (isLocalUrl(url)) return "local";
  const ref = (process.env.LOAD_STAGING_REF ?? "").trim().toLowerCase();
  if (!ref) {
    throw new Error(
      `[load guard] REFUSED: ${what} is not local and LOAD_STAGING_REF is not set. ` +
        `Set LOAD_STAGING_REF to the STAGING project ref to confirm the target on purpose.`,
    );
  }
  if (ref === PRODUCTION_SUPABASE_REF) {
    throw new Error("[load guard] REFUSED: LOAD_STAGING_REF is the production ref.");
  }
  if (!String(url).toLowerCase().includes(ref)) {
    throw new Error(
      `[load guard] REFUSED: ${what} does not contain LOAD_STAGING_REF — the URL and the confirmed staging ref disagree.`,
    );
  }
  return "staging";
}

/**
 * SQL that proves the connected database was deliberately marked as a
 * disposable load-test environment and holds synthetic tenants only.
 * Run via psql with ON_ERROR_STOP; raises on violation.
 */
export function stagingSentinelSql(tag, stagingRef = process.env.LOAD_STAGING_REF ?? "") {
  const ref = String(stagingRef).trim().toLowerCase();
  if (!/^[a-z0-9]{8,40}$/.test(ref) || ref === PRODUCTION_SUPABASE_REF) {
    throw new Error("[load guard] REFUSED: a staging sentinel check needs a valid, non-production LOAD_STAGING_REF.");
  }
  return `
do $guard$
declare
  v_marked boolean := false;
  v_foreign integer;
begin
  if to_regclass('public.loadtest_environment') is not null then
    execute 'select exists (select 1 from public.loadtest_environment where is_disposable is true and staging_ref = ''${ref}'')' into v_marked;
  end if;
  if not v_marked then
    raise exception 'load guard: this database is not marked as the disposable load-test environment for LOAD_STAGING_REF (run scripts/load/staging/01-mark-staging.sql against STAGING first)';
  end if;
  select count(*) into v_foreign from public.organizations where slug not like 'lt-%';
  if v_foreign > 0 then
    raise exception 'load guard: % non-synthetic organisation(s) present — staging must contain synthetic tenants only', v_foreign;
  end if;
end
$guard$;
`;
}

/** Tags are embedded in slugs/emails/ids — keep them boring. */
export function assertTag(tag) {
  if (!/^[a-z0-9]{2,12}$/.test(tag)) {
    throw new Error(`[load guard] --tag must match ^[a-z0-9]{2,12}$ (got "${tag}")`);
  }
  return tag;
}

/** Minimal `--key value` / `--key=value` / `--flag` parser. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

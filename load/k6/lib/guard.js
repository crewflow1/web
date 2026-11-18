// load/k6/lib/guard.js — target safety for the k6 side of the harness.
//
// PURE: no k6 imports, no globals. config.js calls it in every VU's init
// context (so a mis-pointed run dies before a single request), and the unit
// tests in __tests__/load/guard.test.ts import it directly under Node.
//
// Rules (mirrors scripts/load/_guard.mjs for the Node-side tooling):
//   1. PRODUCTION IS NEVER A TARGET. The production Supabase project ref and the
//      production hostnames are refused unconditionally — no flag lifts this.
//   2. Loopback app + loopback Supabase → "local".
//   3. Anything else needs TWO operator confirmations naming the target on
//      purpose: LOAD_STAGING_HOST must equal the BASE_URL host, and
//      LOAD_STAGING_REF must appear in the SUPABASE_URL host. A mixed target
//      (local app, remote DB or the reverse) is treated as non-local.
//   4. setup() additionally proves the APP talks to the same (guarded) Supabase
//      project as SUPABASE_URL (sessionProofVerdict below), so a staging URL in
//      k6's env cannot disguise an app deployment wired to another database.

export const PRODUCTION_SUPABASE_REF = "jzntbskdqdopzwdqwvkp";
export const PRODUCTION_HOSTS = ["crewflow.uk", "www.crewflow.uk"];
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]", "::1", "host.docker.internal"];

export function hostOf(url) {
  const m = /^https?:\/\/([^/:?#]+|\[[^\]]+\])(?::\d+)?(?:[/?#]|$)/i.exec(String(url || ""));
  if (!m) throw new Error(`[load guard] not an http(s) URL: ${String(url).slice(0, 60)}`);
  return m[1].toLowerCase();
}

export function isProductionHost(host) {
  return PRODUCTION_HOSTS.indexOf(host) !== -1 || host.endsWith(".crewflow.uk");
}

/**
 * Classify a (BASE_URL, SUPABASE_URL) pair. Returns "local" | "staging" or
 * throws. `env` carries LOAD_STAGING_HOST / LOAD_STAGING_REF.
 */
export function classifyTarget(baseUrl, supabaseUrl, env) {
  const e = env || {};
  const appHost = hostOf(baseUrl);
  const dbHost = hostOf(supabaseUrl);
  const all = `${baseUrl} ${supabaseUrl}`.toLowerCase();
  if (all.indexOf(PRODUCTION_SUPABASE_REF) !== -1 || isProductionHost(appHost) || isProductionHost(dbHost)) {
    throw new Error("[load guard] REFUSED: target is PRODUCTION. Load tests never run against production.");
  }
  if (LOOPBACK.indexOf(appHost) !== -1 && LOOPBACK.indexOf(dbHost) !== -1) return "local";
  const stagingHost = String(e.LOAD_STAGING_HOST || "").trim().toLowerCase();
  const stagingRef = String(e.LOAD_STAGING_REF || "").trim().toLowerCase();
  if (!stagingHost || !stagingRef) {
    throw new Error("[load guard] REFUSED: non-local target requires LOAD_STAGING_HOST and LOAD_STAGING_REF.");
  }
  if (stagingRef === PRODUCTION_SUPABASE_REF || stagingRef.indexOf(PRODUCTION_SUPABASE_REF) !== -1) {
    throw new Error("[load guard] REFUSED: LOAD_STAGING_REF is the production ref.");
  }
  if (!/^[a-z0-9]{8,40}$/.test(stagingRef)) {
    throw new Error("[load guard] REFUSED: LOAD_STAGING_REF must be a bare Supabase project ref.");
  }
  if (appHost !== stagingHost) throw new Error("[load guard] REFUSED: BASE_URL host does not match LOAD_STAGING_HOST.");
  if (dbHost.split(".")[0] !== stagingRef) {
    throw new Error("[load guard] REFUSED: SUPABASE_URL host does not start with LOAD_STAGING_REF.");
  }
  return "staging";
}

/**
 * Proof that the APP is wired to the guarded Supabase project (setup() runs it
 * before any load). setup() mints a session for one synthetic user straight
 * from SUPABASE_URL's Auth (a URL classifyTarget has already cleared), stores it
 * in the `sb-<ref>-auth-token` cookie named for THAT project, and requests an
 * authenticated page from the app with redirects off. Only an app built against
 * the same project accepts that cookie AND can render the seeded tenant's
 * marker; an app wired to any other project (production included) sees no
 * session and bounces to /login. The app's Supabase URL is server-only (it is
 * not inlined into client bundles), so this round trip is the proof.
 * @param res { status, body, location }
 * @returns {{ ok: boolean, reason: string }}
 */
export function sessionProofVerdict(res, marker) {
  if (!res) return { ok: false, reason: "no response" };
  if (String(res.body || "").indexOf(PRODUCTION_SUPABASE_REF) !== -1) {
    return { ok: false, reason: "the app's response references the PRODUCTION Supabase project" };
  }
  if (res.status !== 200) {
    const where = res.location ? ` → ${String(res.location).slice(0, 60)}` : "";
    return { ok: false, reason: `the app did not accept a session minted by SUPABASE_URL (HTTP ${res.status}${where}) — it is wired to another Supabase project, or the dataset is not seeded` };
  }
  if (!marker || String(res.body || "").indexOf(marker) === -1) {
    return { ok: false, reason: "the app accepted the session but did not render the seeded tenant's marker — wrong database or unseeded" };
  }
  return { ok: true, reason: "app accepted a session minted by SUPABASE_URL and rendered the seeded tenant" };
}

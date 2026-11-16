// load/k6/lib/config.js — environment, target safety, persona mix, stage profiles.
//
// Everything a run needs comes from environment variables so the same scripts
// drive the local harness-validation pass and (once the founder approves and
// supplies a staging project) the staged runs. NOTHING here targets production:
// the guard below refuses the production host and project ref unconditionally.

export const BASE_URL = (__ENV.BASE_URL || "http://localhost:3104").replace(/\/+$/, "");
export const SUPABASE_URL = (__ENV.SUPABASE_URL || "http://127.0.0.1:54321").replace(/\/+$/, "");
export const ANON_KEY = __ENV.SUPABASE_ANON_KEY || "";
export const STAGE = __ENV.STAGE || "smoke";
export const TAG = __ENV.LOAD_TAG || "lt1";
export const MANIFEST_PATH = __ENV.MANIFEST || `../.manifest/${TAG}.json`;
export const ACTIONS_PATH = __ENV.ACTIONS || "../.manifest/actions.json";
/** Multiplies every think time. 1 = realistic pacing; <1 compresses a short local pass. */
export const THINK_SCALE = Number(__ENV.THINK_SCALE || "1");
/** Fraction of responses whose body is scanned for a foreign-tenant marker. */
export const SCAN_RATE = Number(__ENV.SCAN_RATE || "1");
/** Next <Link> prefetch requests issued after each page navigation. */
export const PREFETCH_PER_NAV = Number(__ENV.PREFETCH_PER_NAV || "4");
/** Site-photo upload size. Real phone photos are 2–4 MB; keep small locally. */
export const PHOTO_KB = Number(__ENV.PHOTO_KB || "150");
/** "app" = sign in through the product's own server action (real path);
 *  "gotrue" = password grant straight to Supabase Auth, cookie built client-side. */
export const LOGIN_MODE = __ENV.LOGIN_MODE || "app";
export const ALLOW_SHARED_USERS = __ENV.ALLOW_SHARED_USERS === "1";

const PRODUCTION_REF = "jzntbskdqdopzwdqwvkp";
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"];

function hostOf(url) {
  const m = /^https?:\/\/([^/:]+|\[[^\]]+\])(?::\d+)?/i.exec(url);
  if (!m) throw new Error(`[load guard] not an http(s) URL: ${url}`);
  return m[1].toLowerCase();
}

/**
 * Target safety. Runs in the init context of every VU, so a mis-pointed run
 * dies before a single request is sent.
 *   - production host / production project ref  → refused, no override exists;
 *   - loopback                                   → allowed;
 *   - anything else                              → allowed only when the operator
 *     has named it on purpose: LOAD_STAGING_HOST must equal the BASE_URL host and
 *     LOAD_STAGING_REF must appear in SUPABASE_URL.
 * The second interlock is structural: every authenticated persona signs in as a
 * `…@loadtest.crewflow.invalid` user that exists only in a seeded staging/local
 * database, so setup() aborts on any environment that was not seeded for this.
 */
export function assertSafeTarget() {
  const appHost = hostOf(BASE_URL);
  const dbHost = hostOf(SUPABASE_URL);
  const all = `${BASE_URL} ${SUPABASE_URL}`.toLowerCase();
  if (all.includes(PRODUCTION_REF) || appHost === "crewflow.uk" || appHost.endsWith(".crewflow.uk")) {
    throw new Error("[load guard] REFUSED: target is PRODUCTION. Load tests never run against production.");
  }
  const appLocal = LOOPBACK.includes(appHost);
  const dbLocal = LOOPBACK.includes(dbHost);
  if (appLocal && dbLocal) return "local";
  const stagingHost = (__ENV.LOAD_STAGING_HOST || "").toLowerCase();
  const stagingRef = (__ENV.LOAD_STAGING_REF || "").toLowerCase();
  if (!stagingHost || !stagingRef) {
    throw new Error("[load guard] REFUSED: non-local target requires LOAD_STAGING_HOST and LOAD_STAGING_REF.");
  }
  if (stagingRef === PRODUCTION_REF) throw new Error("[load guard] REFUSED: LOAD_STAGING_REF is the production ref.");
  if (appHost !== stagingHost) throw new Error("[load guard] REFUSED: BASE_URL host does not match LOAD_STAGING_HOST.");
  if (!SUPABASE_URL.toLowerCase().includes(stagingRef)) {
    throw new Error("[load guard] REFUSED: SUPABASE_URL does not contain LOAD_STAGING_REF.");
  }
  return "staging";
}

export const TARGET_KIND = assertSafeTarget();

/** Shared synthetic password. Local default mirrors scripts/load/seed.mjs. */
export const PASSWORD = __ENV.LOAD_USER_PASSWORD || (TARGET_KIND === "local" ? "Loadtest-Local-Only-1!" : "");
if (!PASSWORD) throw new Error("LOAD_USER_PASSWORD is required for a non-local target.");

// ── persona mix ──────────────────────────────────────────────────────────────
// Slots per 1,000 concurrently active users. A trades ERP is dominated by field
// operatives on phones; office users are fewer but do the write-heavy work.
export const PERSONA_SLOTS = [
  ["hq", 2], //         CrewFlow HQ operators (super-admin console)
  ["public", 98], //    unauthenticated prospects on a tenant's enquiry form
  ["owner", 120], //    owners / directors: dashboards, reports, lists
  ["office", 200], //   office admins: quotes, invoices, scheduling, rota
  ["staff", 580], //    field staff: my day, assigned jobs, clock, RAMS, photos
];
export const SLOTS_TOTAL = PERSONA_SLOTS.reduce((a, [, n]) => a + n, 0);

/**
 * Deterministic VU → (persona, ordinal) assignment.
 * VU ids (exec.vu.idInTest) are 1..N and globally unique across distributed
 * generators. Slots are visited with a stride coprime to 1000 so the mix is
 * right at every point of the ramp, and the ordinal is contiguous per persona —
 * so each VU owns exactly one seeded user and no two VUs ever share a session.
 */
const STRIDE = 387;
const slotPersona = [];
for (const [name, n] of PERSONA_SLOTS) for (let i = 0; i < n; i++) slotPersona.push(name);
const perBlock = {};
const ordinalAt = new Array(SLOTS_TOTAL);
const personaAt = new Array(SLOTS_TOTAL);
for (let pos = 0; pos < SLOTS_TOTAL; pos++) {
  const p = slotPersona[(pos * STRIDE) % SLOTS_TOTAL];
  personaAt[pos] = p;
  ordinalAt[pos] = perBlock[p] || 0;
  perBlock[p] = (perBlock[p] || 0) + 1;
}
export function assignVu(vuId) {
  const zero = vuId - 1;
  const block = Math.floor(zero / SLOTS_TOTAL);
  const pos = zero % SLOTS_TOTAL;
  const persona = personaAt[pos];
  return { persona, ordinal: block * perBlock[persona] + ordinalAt[pos] };
}
/** How many VUs of each persona exist when `vus` VUs are active. */
export function personaCounts(vus) {
  const out = {};
  for (const [name] of PERSONA_SLOTS) out[name] = 0;
  for (let id = 1; id <= vus; id++) out[assignVu(id).persona]++;
  return out;
}

// ── stage profiles ───────────────────────────────────────────────────────────
// `ramp` is a list of [duration, targetVUs]. Every staged run ends with a
// RECOVERY phase (drop to 20% and hold) so "does it come back after saturation"
// is measured, not assumed. Durations are deliberately long at the top end:
// connection pools, GoTrue and the function fleet need minutes to reach a
// steady state, and a 60-second "50k" spike proves nothing.
const steps = (target, n, rampEach, holdEach) => {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push([rampEach, Math.round((target * i) / n)]);
    if (i < n) out.push([holdEach, Math.round((target * i) / n)]);
  }
  return out;
};
const withRecovery = (ramp, target, hold, recover) => [
  ...ramp,
  [hold, target],
  ["2m", Math.round(target * 0.2)],
  [recover, Math.round(target * 0.2)],
  ["1m", 0],
];

export const STAGES = {
  // harness validation only — a laptop, a shared local database
  smoke: { vus: 12, ramp: [["20s", 12], ["90s", 12], ["10s", 0]], p95: 4000, errRate: 0.05 },
  local: { vus: 30, ramp: [["45s", 30], ["3m", 30], ["15s", 0]], p95: 4000, errRate: 0.05 },
  // staged runs — staging only, each needs explicit founder approval (COST-AND-APPROVAL.md)
  "100": { vus: 100, ramp: withRecovery([["2m", 100]], 100, "10m", "3m"), p95: 1500, errRate: 0.01 },
  "500": { vus: 500, ramp: withRecovery([["5m", 500]], 500, "15m", "4m"), p95: 2000, errRate: 0.01 },
  "2000": { vus: 2000, ramp: withRecovery(steps(2000, 4, "3m", "3m"), 2000, "20m", "5m"), p95: 2500, errRate: 0.01 },
  "5000": { vus: 5000, ramp: withRecovery(steps(5000, 5, "3m", "4m"), 5000, "20m", "5m"), p95: 3000, errRate: 0.01 },
  "10000": { vus: 10000, ramp: withRecovery(steps(10000, 5, "4m", "5m"), 10000, "20m", "8m"), p95: 3000, errRate: 0.01 },
  "25000": { vus: 25000, ramp: withRecovery(steps(25000, 5, "5m", "6m"), 25000, "20m", "10m"), p95: 3000, errRate: 0.01 },
  "50000": { vus: 50000, ramp: withRecovery(steps(50000, 10, "4m", "5m"), 50000, "30m", "10m"), p95: 3000, errRate: 0.01 },
};

export function stageProfile() {
  const s = STAGES[STAGE];
  if (!s) throw new Error(`Unknown STAGE "${STAGE}". One of: ${Object.keys(STAGES).join(", ")}`);
  if (TARGET_KIND === "local" && s.vus > 200 && __ENV.ALLOW_BIG_LOCAL !== "1") {
    throw new Error(`STAGE ${STAGE} (${s.vus} VUs) is a staging profile; a local run above 200 VUs measures the laptop, not the system.`);
  }
  return s;
}

/**
 * Thresholds + automatic abort conditions. A run that trips an abort stops
 * itself: continuing to push load into a system that is already failing only
 * produces noise (and, on metered infrastructure, cost).
 */
export function thresholds(profile) {
  return {
    // Tenant isolation is binary: ONE foreign marker ends the run immediately.
    tenant_isolation_violations: [{ threshold: "count==0", abortOnFail: true, delayAbortEval: "0s" }],
    // Sessions dying means the harness is no longer measuring the product.
    auth_bounces: [{ threshold: "rate<0.02", abortOnFail: true, delayAbortEval: "60s" }],
    server_errors: [
      { threshold: `rate<${profile.errRate}` },
      { threshold: "rate<0.10", abortOnFail: true, delayAbortEval: "60s" },
    ],
    http_req_failed: [
      { threshold: `rate<${profile.errRate * 2}` },
      { threshold: "rate<0.15", abortOnFail: true, delayAbortEval: "60s" },
    ],
    "http_req_duration{kind:page}": [
      { threshold: `p(95)<${profile.p95}` },
      { threshold: `p(95)<${profile.p95 * 4}`, abortOnFail: true, delayAbortEval: "120s" },
    ],
    "http_req_duration{kind:action}": [{ threshold: `p(95)<${profile.p95}` }],
    "http_req_duration{kind:api}": [{ threshold: `p(95)<${Math.round(profile.p95 * 0.75)}` }],
    business_errors: [{ threshold: "rate<0.05" }],
    checks: [{ threshold: "rate>0.95" }],
  };
}

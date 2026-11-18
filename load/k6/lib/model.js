// load/k6/lib/model.js — the load MODEL: persona mix, stage profiles, phases,
// thresholds. PURE (no k6 imports) so __tests__/load/model.test.ts can check it.
//
// THREE DIFFERENT NUMBERS — never conflate them:
//
//   concurrent sessions  = signed-in people with the app open at the same time.
//                          In k6 this is the number of VUs: each VU owns one
//                          seeded identity, signs in, and works through tasks
//                          separated by human think time. "50k users" means this.
//   requests per second  = the request ARRIVAL rate those sessions generate
//                          (k6 `http_reqs` rate). With realistic think time a
//                          session issues a request every several seconds, so
//                          RPS is a small fraction of sessions.
//   active requests      = requests IN FLIGHT at one instant (what occupies
//                          function instances, PostgREST pool slots and DB
//                          backends). Little's law: in-flight = RPS × mean
//                          latency. k6 cannot observe this directly; the summary
//                          derives it from the measured RPS and latency.
//
// A profile is defined in SESSIONS (closed model, ramping VUs) because that is
// the business question ("can N people use it at once?"). RPS and in-flight
// requests are MEASURED outputs; the per-session request rate measured at
// THINK_SCALE=1 is the multiplier that turns a session target into an RPS
// expectation for the staging plan. Compressing think time (THINK_SCALE<1)
// makes each VU behave like several people — a stress tool, not a user count.

// ── persona mix ──────────────────────────────────────────────────────────────
// Slots per 1,000 concurrently active users. A trades ERP is dominated by field
// operatives on phones; office users are fewer but do the write-heavy work.
export const PERSONA_SLOTS = [
  ["hq", 2], //         CrewFlow HQ operators (super-admin console)
  ["public", 98], //    unauthenticated prospects on a tenant's enquiry page
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

// ── durations ────────────────────────────────────────────────────────────────
export function parseDuration(d) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(String(d));
  if (!m) throw new Error(`bad duration "${d}"`);
  const n = Number(m[1]);
  return m[2] === "ms" ? n / 1000 : m[2] === "s" ? n : m[2] === "m" ? n * 60 : n * 3600;
}

// ── stage profiles ───────────────────────────────────────────────────────────
// `ramp` is a list of [duration, targetSessions]. Every STAGING profile ends
// with a RECOVERY phase (drop to 20% and hold) so "does it come back after
// saturation" is measured, not assumed. Durations are deliberately long at the
// top end: connection pools, Auth and the function fleet need minutes to reach
// a steady state, and a 60-second "50k" spike proves nothing.
// Login is paced by the ramp itself: 50k sessions over the 40-minute stepped
// ramp is ~21 sign-ins/s on average — the Auth (GoTrue) rate limits and the
// product's per-identity limiter must be sized/raised on STAGING for that.
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

// p95/p99 are server TTLB budgets in ms for page renders (actions share p95);
// errRate is the 5xx / transport-failure budget. Staging budgets are the gate
// criteria in docs/engineering/STAGING-AND-LOAD-PLAN.md §6.
export const STAGES = {
  // ── LOCAL (laptop + shared local Supabase): harness validation + a baseline
  //    that says NOTHING about hosted capacity.
  smoke: { target: "local", vus: 12, ramp: [["20s", 12], ["90s", 12], ["10s", 0]], p95: 4000, p99: 8000, errRate: 0.05 },
  local: { target: "local", vus: 100, ramp: [["60s", 100], ["4m", 100], ["15s", 0]], p95: 4000, p99: 8000, errRate: 0.05 },
  // ── STAGING ONLY — each run needs explicit founder approval (cost) and the
  //    gate before it to have passed. Never run these locally.
  "100": { target: "staging", vus: 100, ramp: withRecovery([["2m", 100]], 100, "10m", "3m"), p95: 1500, p99: 3000, errRate: 0.01 },
  "500": { target: "staging", vus: 500, ramp: withRecovery([["5m", 500]], 500, "15m", "4m"), p95: 2000, p99: 4000, errRate: 0.01 },
  "1k": { target: "staging", vus: 1000, ramp: withRecovery(steps(1000, 2, "4m", "3m"), 1000, "15m", "4m"), p95: 2000, p99: 4000, errRate: 0.01 },
  "5k": { target: "staging", vus: 5000, ramp: withRecovery(steps(5000, 5, "3m", "4m"), 5000, "20m", "5m"), p95: 2500, p99: 5000, errRate: 0.01 },
  "10k": { target: "staging", vus: 10000, ramp: withRecovery(steps(10000, 5, "4m", "5m"), 10000, "20m", "8m"), p95: 3000, p99: 6000, errRate: 0.01 },
  "25k": { target: "staging", vus: 25000, ramp: withRecovery(steps(25000, 5, "5m", "6m"), 25000, "20m", "10m"), p95: 3000, p99: 6000, errRate: 0.01 },
  "50k": { target: "staging", vus: 50000, ramp: withRecovery(steps(50000, 10, "4m", "5m"), 50000, "30m", "10m"), p95: 3000, p99: 6000, errRate: 0.01 },
};

/** Hard ceiling for a local run: above this a laptop measures itself. */
export const LOCAL_MAX_VUS = 200;

export function stageProfile(stage, targetKind, allowBigLocal) {
  const s = STAGES[stage];
  if (!s) throw new Error(`Unknown STAGE "${stage}". One of: ${Object.keys(STAGES).join(", ")}`);
  if (targetKind === "local" && s.vus > LOCAL_MAX_VUS && !allowBigLocal) {
    throw new Error(`STAGE ${stage} (${s.vus} sessions) is a staging profile; a local run above ${LOCAL_MAX_VUS} VUs measures the laptop, not the system.`);
  }
  return s;
}

// ── phases ───────────────────────────────────────────────────────────────────
// Every request is tagged with the phase it ran in, so the summary can report
// PEAK (steady state at the top) and RECOVERY separately from ramp noise.
export function phasesOf(profile) {
  const out = [];
  let t = 0;
  let prev = 0;
  let seenPeak = false;
  for (const [dur, target] of profile.ramp) {
    const len = parseDuration(dur);
    let name;
    if (target > prev) name = "ramp";
    else if (target === prev && target === profile.vus) name = "peak";
    else if (target === prev && target > 0) name = seenPeak ? "recovery" : "step";
    else if (target === 0) name = "end";
    else name = "drain";
    if (name === "peak") seenPeak = true;
    out.push({ name, fromS: t, toS: t + len, startVUs: prev, endVUs: target });
    t += len;
    prev = target;
  }
  return out;
}

export function phaseAt(phases, elapsedS) {
  for (const p of phases) if (elapsedS < p.toS) return p.name;
  return "end";
}

/** Seconds spent in a named phase (for steady-state RPS = count / seconds). */
export function phaseSeconds(phases, name) {
  return phases.filter((p) => p.name === name).reduce((a, p) => a + (p.toS - p.fromS), 0);
}

export function totalSeconds(profile) {
  return profile.ramp.reduce((a, [d]) => a + parseDuration(d), 0);
}

// ── thresholds ───────────────────────────────────────────────────────────────
export const REQUEST_KINDS = ["page", "action", "api", "upload", "auth", "prefetch", "canary"];
export const REPORTED_PHASES = ["peak", "recovery"];

/**
 * Thresholds + automatic abort conditions. A run that trips an abort stops
 * itself: continuing to push load into a system that is already failing only
 * produces noise (and, on metered infrastructure, cost). Entries whose only
 * purpose is to make k6 keep a tagged sub-metric for the summary use a
 * condition that cannot fail (`max>=0`, `count>=0`).
 */
export function thresholdsFor(profile) {
  const t = {
    // Tenant isolation is binary: ONE foreign marker ends the run immediately.
    tenant_isolation_violations: [{ threshold: "count==0", abortOnFail: true, delayAbortEval: "0s" }],
    // A cross-tenant canary probe that is NOT refused is the same failure.
    canary_leaks: [{ threshold: "count==0", abortOnFail: true, delayAbortEval: "0s" }],
    // Sessions dying means the harness is no longer measuring the product.
    auth_bounces: [{ threshold: "rate<0.02", abortOnFail: true, delayAbortEval: "60s" }],
    login_failures: ["count>=0"],
    other_redirects: ["count>=0"],
    server_errors: [
      { threshold: `rate<${profile.errRate}` },
      { threshold: "rate<0.10", abortOnFail: true, delayAbortEval: "60s" },
    ],
    http_req_failed: [
      { threshold: `rate<${profile.errRate * 2}` },
      { threshold: "rate<0.15", abortOnFail: true, delayAbortEval: "60s" },
    ],
    http_req_duration: ["max>=0"],
    "http_req_duration{kind:page}": [
      { threshold: `p(95)<${profile.p95}` },
      { threshold: `p(99)<${profile.p99}` },
      { threshold: `p(95)<${profile.p95 * 4}`, abortOnFail: true, delayAbortEval: "120s" },
    ],
    "http_req_duration{kind:action}": [{ threshold: `p(95)<${profile.p95}` }],
    "http_req_duration{kind:api}": [{ threshold: `p(95)<${Math.round(profile.p95 * 0.75)}` }],
    business_errors: [{ threshold: "rate<0.05" }],
    checks: [{ threshold: "rate>0.95" }],
    http_reqs: ["count>=0"],
  };
  for (const k of REQUEST_KINDS) {
    if (!t[`http_req_duration{kind:${k}}`]) t[`http_req_duration{kind:${k}}`] = ["max>=0"];
    t[`http_reqs{kind:${k}}`] = ["count>=0"];
  }
  for (const ph of REPORTED_PHASES) {
    t[`http_req_duration{phase:${ph}}`] = ["max>=0"];
    t[`http_req_duration{phase:${ph},kind:page}`] = ["max>=0"];
    t[`http_reqs{phase:${ph}}`] = ["count>=0"];
    t[`server_errors{phase:${ph}}`] = ["rate>=0"];
  }
  return t;
}

// ── Little's law ─────────────────────────────────────────────────────────────
/**
 * Turn measured numbers into the three-number model.
 *   sessions        concurrent signed-in VUs during the window
 *   requests        HTTP requests completed in the window
 *   seconds         window length
 *   meanLatencyMs   mean request duration in the window
 */
export function loadModel({ sessions, requests, seconds, meanLatencyMs }) {
  const rps = seconds > 0 ? requests / seconds : 0;
  return {
    concurrentSessions: sessions,
    rps,
    inFlightRequests: (rps * meanLatencyMs) / 1000,
    requestsPerSessionPerMinute: sessions > 0 ? (rps * 60) / sessions : 0,
  };
}

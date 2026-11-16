// load/k6/scenarios/mixed.js — THE entry scenario: the full persona mix.
//
//   STAGE=smoke k6 run load/k6/scenarios/mixed.js          (local; see scripts/load/run-local.sh)
//   STAGE=local THINK_SCALE=1 …                             (local baseline, 100 sessions)
//   STAGE=1k|5k|10k|25k|50k …                               (STAGING ONLY — founder-approved; refused locally)
//
// Model (./../lib/model.js): one VU = one concurrent signed-in session that
// owns one seeded identity and works through tasks with human think time.
// Requests/s and in-flight requests are measured outputs, reported separately
// by handleSummary (../lib/summary.js) as JSON + markdown.
//
// Safety, in order: (1) config.js refuses production / unconfirmed targets in
// the init context of every VU; (2) setup() proves the app accepts a session
// minted by the guarded SUPABASE_URL and renders a seeded synthetic tenant
// (guard.sessionProofVerdict) — anything else aborts before load starts;
// (3) every sign-in is a `@loadtest.crewflow.invalid` identity.
import exec from "k6/execution";
import http from "k6/http";
import { sleep } from "k6";
import {
  ALLOW_SHARED_USERS, BASE_URL, STAGE, TARGET_KIND, THINK_SCALE,
  assignVu, personaCounts, phaseAt, phasesOf, stageProfile, thresholds,
} from "../lib/config.js";
import { ACTION_KEYS, buildIdOf, discoverFromChunks, initialActions } from "../lib/actions.js";
import { POOL, actionMap, foreignOrg, identityFor, ltId, manifest, orgs } from "../lib/data.js";
import { sessionProofVerdict } from "../lib/guard.js";
import { canaryProbe, consumeBounce, think } from "../lib/http.js";
import { makeSession, passwordGrant, setSessionCookie } from "../lib/session.js";
import { buildReport } from "../lib/summary.js";
import { hq } from "../personas/hq.js";
import { office } from "../personas/office.js";
import { owner } from "../personas/owner.js";
import { publicVisitor } from "../personas/public.js";
import { staff } from "../personas/staff.js";

const profile = stageProfile();
const phases = phasesOf(profile);
const CANARY_RATE = Number(__ENV.CANARY_RATE || "0.03");
const RESULTS_DIR = __ENV.RESULTS_DIR || "";

export const options = {
  scenarios: {
    sessions: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: profile.ramp.map(([duration, target]) => ({ duration, target })),
      gracefulRampDown: "30s",
      gracefulStop: "30s",
    },
  },
  thresholds: thresholds(profile),
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
  setupTimeout: "180s",
  teardownTimeout: "60s",
  userAgent: "crewflow-load-harness/1 (k6)",
  tags: { stage: STAGE, target: TARGET_KIND },
};

const PERSONAS = { owner, office, staff, hq, public: publicVisitor };
// Sign-in cadence per persona: [min, max] tasks per "shift" before signing out and back in.
const SHIFT = { owner: [15, 40], office: [20, 50], staff: [15, 45], hq: [10, 30] };

export function setup() {
  const startedAt = new Date().toISOString();
  // 0. identity pools must cover the peak — two VUs sharing one user would
  //    share a session and trip the per-identity auth limiter.
  const need = personaCounts(profile.vus);
  for (const p in need) {
    if (need[p] > POOL[p] && !ALLOW_SHARED_USERS) {
      exec.test.abort(`[setup] persona ${p} needs ${need[p]} identities at peak but the dataset has ${POOL[p]} — seed more orgs/staff (or ALLOW_SHARED_USERS=1)`);
    }
  }
  // 1. liveness
  const health = http.get(`${BASE_URL}/api/health`, { tags: { name: "setup:health", kind: "setup" } });
  if (health.status !== 200) exec.test.abort(`[setup] ${BASE_URL}/api/health → ${health.status}`);

  // 2. action ids — unauthenticated discovery first (sign-in lives on /login)
  const actions = initialActions();
  const login = http.get(`${BASE_URL}/login`, { headers: { Accept: "text/html" }, redirects: 0, tags: { name: "setup:login", kind: "setup" } });
  const servedBuild = buildIdOf(login.body);
  const manifestFresh = !!actionMap.buildId && actionMap.buildId === servedBuild;
  if (!manifestFresh) for (const k in actions) actions[k] = null; // stale build manifest → never guess
  const named = discoverFromChunks(login.body, { Accept: "*/*" });
  for (const k in ACTION_KEYS) {
    const exportName = ACTION_KEYS[k].split("#")[1];
    if (!actions[k] && named[exportName]) actions[k] = named[exportName];
  }

  // 3. the app must accept a session minted by the GUARDED Supabase project
  //    and render the seeded synthetic tenant — else abort before any load.
  const org = orgs[0];
  const proofId = identityFor("owner", 0);
  const session = passwordGrant(proofId.email);
  if (!session) exec.test.abort(`[setup] synthetic sign-in failed at SUPABASE_URL for ${proofId.email} — is tag ${manifest.tag} seeded?`);
  setSessionCookie(session);
  const dash = http.get(`${BASE_URL}/dashboard`, { headers: { Accept: "text/html" }, redirects: 0, tags: { name: "setup:proof", kind: "setup" } });
  const verdict = sessionProofVerdict({ status: dash.status, body: dash.body, location: dash.headers.Location }, org.marker);
  if (!verdict.ok) exec.test.abort(`[setup] ${verdict.reason}`);
  http.cookieJar().clear(BASE_URL);

  const resolved = {};
  for (const k in actions) resolved[k] = !!actions[k];
  console.log(`[setup] target=${TARGET_KIND} stage=${STAGE} build=${servedBuild} manifest=${manifestFresh ? "fresh" : "stale/absent"} actions=${JSON.stringify(resolved)} proof=ok`);
  return {
    actions,
    runId: Math.floor(Date.now() / 1000).toString(36),
    startedAt,
    app: { url: BASE_URL, buildId: servedBuild },
    resolved,
  };
}

let ctx = null;
let session = null;

export default function (data) {
  if (!ctx) {
    const { persona, ordinal } = assignVu(exec.vu.idInTest);
    const identity = identityFor(persona, ordinal);
    ctx = {
      persona,
      identity,
      org: identity.org,
      // HQ legitimately sees every tenant; the public persona adopts the tenant it visits.
      marker: persona === "hq" || persona === "public" ? null : identity.org.marker,
      actions: data.actions,
      state: {},
      vu: exec.vu.idInTest,
      runId: data.runId,
    };
    if (persona !== "public") session = makeSession(identity, SHIFT[persona][0], SHIFT[persona][1]);
    // stagger first actions so a ramp step is not one synchronized login storm
    sleep(Math.random() * 5 * THINK_SCALE);
  }
  const tags = exec.vu.metrics.tags;
  tags.phase = phaseAt(phases, (Date.now() - exec.scenario.startTime) / 1000);
  tags.persona = ctx.persona;

  if (session && !session.ensure(ctx.actions)) {
    think(20, 40); // could not sign in (limiter / failure) — back off like a person would
    return;
  }
  PERSONAS[ctx.persona](ctx);
  if (session && ctx.marker && Math.random() < CANARY_RATE) canaryProbe(ctx, foreignOrg(ctx.org), ltId);
  if (session && consumeBounce()) {
    session.invalidate();
    ctx.state.landed = false;
  }
}

export function handleSummary(data) {
  const setup = data.setup_data || {};
  const { json, markdown } = buildReport(data, {
    stage: STAGE,
    profile,
    phases,
    targetKind: TARGET_KIND,
    thinkScale: THINK_SCALE,
    tag: manifest.tag,
    app: setup.app,
    startedAt: setup.startedAt,
    personaMixAtPeak: personaCounts(profile.vus),
    notes: setup.resolved ? `Server actions resolved: ${Object.keys(setup.resolved).filter((k) => setup.resolved[k]).join(", ") || "none"}; unresolved flows fall back to browsing: ${Object.keys(setup.resolved).filter((k) => !setup.resolved[k]).join(", ") || "none"}.` : "",
  });
  const out = { stdout: markdown + "\n" };
  if (RESULTS_DIR) {
    out[`${RESULTS_DIR}/k6-summary.json`] = JSON.stringify(json, null, 2);
    out[`${RESULTS_DIR}/k6-summary.md`] = markdown;
    out[`${RESULTS_DIR}/k6-raw-summary.json`] = JSON.stringify(data);
  }
  return out;
}

// load/k6/lib/summary.js — handleSummary → machine JSON + human markdown.
//
// PURE (no k6 imports): the entry script's handleSummary passes k6's summary
// `data` object plus run metadata; __tests__/load/summary.test.ts feeds it a
// fixture. The report separates the three numbers the model distinguishes
// (concurrent sessions / RPS / in-flight requests — see ./model.js) and never
// extrapolates: it reports what this run measured, under the stated target.
import { REQUEST_KINDS, loadModel, phaseSeconds, totalSeconds } from "./model.js";

const r1 = (n) => (n === undefined || n === null || Number.isNaN(n) ? null : Math.round(n * 10) / 10);
const pct = (n) => (n === undefined || n === null ? "—" : `${(n * 100).toFixed(2)}%`);
const ms = (n) => (n === undefined || n === null ? "—" : `${Math.round(n)}`);

function m(data, key) {
  return (data.metrics && data.metrics[key]) || null;
}
function v(data, key, stat) {
  const x = m(data, key);
  return x && x.values && x.values[stat] !== undefined ? x.values[stat] : null;
}
function trend(data, key) {
  const x = m(data, key);
  if (!x || !x.values) return null;
  const s = x.values;
  return { count: null, avg: r1(s.avg), p50: r1(s.med), p90: r1(s["p(90)"]), p95: r1(s["p(95)"]), p99: r1(s["p(99)"]), max: r1(s.max) };
}

/** Thresholds that failed (k6 marks each with ok:false). */
export function failedThresholds(data) {
  const out = [];
  for (const key in data.metrics || {}) {
    const th = data.metrics[key].thresholds || {};
    for (const cond in th) if (th[cond] && th[cond].ok === false) out.push(`${key}: ${cond}`);
  }
  return out.sort();
}

/**
 * @param data k6 summary data
 * @param meta { stage, profile, phases, targetKind, thinkScale, tag, app, startedAt, personaMixAtPeak, notes }
 */
export function buildReport(data, meta) {
  const profile = meta.profile;
  const runSeconds = data.state && data.state.testRunDurationMs ? data.state.testRunDurationMs / 1000 : totalSeconds(profile);
  const peakSeconds = phaseSeconds(meta.phases, "peak");
  const recoverySeconds = phaseSeconds(meta.phases, "recovery");
  const sessionsPeak = v(data, "vus_max", "max") || v(data, "vus", "max") || profile.vus;

  const whole = loadModel({
    sessions: sessionsPeak,
    requests: v(data, "http_reqs", "count") || 0,
    seconds: runSeconds,
    meanLatencyMs: v(data, "http_req_duration", "avg") || 0,
  });
  const peak = peakSeconds > 0
    ? loadModel({
      sessions: profile.vus,
      requests: v(data, "http_reqs{phase:peak}", "count") || 0,
      seconds: peakSeconds,
      meanLatencyMs: v(data, "http_req_duration{phase:peak}", "avg") || 0,
    })
    : null;

  const kinds = {};
  for (const k of REQUEST_KINDS) {
    const t = trend(data, `http_req_duration{kind:${k}}`);
    const c = v(data, `http_reqs{kind:${k}}`, "count");
    if (t && c) kinds[k] = Object.assign(t, { count: c });
  }

  const json = {
    schema: "crewflow-load-summary/1",
    stage: meta.stage,
    target: meta.targetKind,
    app: meta.app || null,
    tag: meta.tag,
    thinkScale: meta.thinkScale,
    startedAt: meta.startedAt || null,
    runSeconds: r1(runSeconds),
    profile: { sessions: profile.vus, ramp: profile.ramp, p95BudgetMs: profile.p95, p99BudgetMs: profile.p99, errRateBudget: profile.errRate },
    personaMixAtPeak: meta.personaMixAtPeak || null,
    model: {
      note: "sessions = concurrent signed-in VUs; rps = request arrival rate; inFlight = Little's law (rps × mean latency), derived not observed",
      wholeRun: { peakSessions: sessionsPeak, rps: r1(whole.rps), inFlightRequests: r1(whole.inFlightRequests), requestsPerSessionPerMinute: r1(whole.requestsPerSessionPerMinute) },
      peakPhase: peak && { sessions: peak.concurrentSessions, seconds: peakSeconds, rps: r1(peak.rps), inFlightRequests: r1(peak.inFlightRequests), requestsPerSessionPerMinute: r1(peak.requestsPerSessionPerMinute) },
    },
    latencyMs: {
      all: trend(data, "http_req_duration"),
      peak: trend(data, "http_req_duration{phase:peak}"),
      peakPages: trend(data, "http_req_duration{phase:peak,kind:page}"),
      recovery: recoverySeconds > 0 ? trend(data, "http_req_duration{phase:recovery}") : null,
      byKind: kinds,
      login: trend(data, "login_duration"),
    },
    errors: {
      httpReqFailedRate: v(data, "http_req_failed", "rate"),
      serverErrorRate: v(data, "server_errors", "rate"),
      serverErrorRatePeak: v(data, "server_errors{phase:peak}", "rate"),
      authBounceRate: v(data, "auth_bounces", "rate"),
      businessErrorRate: v(data, "business_errors", "rate"),
      checksPassRate: v(data, "checks", "rate"),
      rateLimited: v(data, "rate_limited", "count") || 0,
      otherRedirects: v(data, "other_redirects", "count") || 0,
      logins: v(data, "logins", "count") || 0,
      loginFailures: v(data, "login_failures", "count") || 0,
    },
    isolation: {
      scans: v(data, "tenant_isolation_scans", "count") || 0,
      violations: v(data, "tenant_isolation_violations", "count") || 0,
      canaryProbes: v(data, "canary_probes", "count") || 0,
      canaryRefused: v(data, "canary_refused", "count") || 0,
      canaryLeaks: v(data, "canary_leaks", "count") || 0,
    },
    writes: { confirmed: v(data, "writes_ok", "count") || 0, unknown: v(data, "writes_unknown", "count") || 0 },
    iterations: v(data, "iterations", "count") || 0,
    failedThresholds: failedThresholds(data),
  };
  json.verdict = json.isolation.violations > 0 || json.isolation.canaryLeaks > 0
    ? "FAIL (tenant isolation)"
    : json.failedThresholds.length > 0
      ? "FAIL (thresholds)"
      : "PASS";

  return { json, markdown: toMarkdown(json, meta) };
}

function toMarkdown(j, meta) {
  const L = [];
  L.push(`# Load run — stage \`${j.stage}\` (${j.target}) — ${j.verdict}`);
  L.push("");
  if (j.target === "local") {
    L.push("> LOCAL RUN: one laptop serving Next.js, the whole Supabase stack, AND the load generator over loopback. It validates the harness and exposes local bottlenecks. It says **nothing** about hosted capacity (Vercel ↔ Supabase), and nothing about 50k concurrent users.");
    L.push("");
  }
  L.push(`- app: ${j.app ? `${j.app.url} (build ${j.app.buildId || "?"})` : "?"} · tag \`${j.tag}\` · think-time scale ${j.thinkScale} · run ${j.runSeconds}s · started ${j.startedAt || "?"}`);
  L.push(`- profile: ${j.profile.sessions} sessions; ramp ${j.profile.ramp.map(([d, t]) => `${d}→${t}`).join(", ")}`);
  if (j.personaMixAtPeak) L.push(`- persona mix at peak: ${Object.entries(j.personaMixAtPeak).map(([k, n]) => `${k} ${n}`).join(" · ")}`);
  L.push("");
  L.push("## Load model (three different numbers)");
  L.push("");
  L.push("| window | concurrent sessions (VUs) | requests/s (arrival) | in-flight requests (derived: RPS × mean latency) | requests per session per minute |");
  L.push("|---|---|---|---|---|");
  const w = j.model.wholeRun;
  L.push(`| whole run (incl. ramps) | peak ${w.peakSessions} | ${w.rps} | ${w.inFlightRequests} | ${w.requestsPerSessionPerMinute} |`);
  if (j.model.peakPhase) {
    const p = j.model.peakPhase;
    L.push(`| peak hold (${p.seconds}s) | ${p.sessions} | ${p.rps} | ${p.inFlightRequests} | ${p.requestsPerSessionPerMinute} |`);
  }
  L.push("");
  if (j.thinkScale !== 1) {
    L.push(`> Think time was scaled ×${j.thinkScale}: each VU behaved like ~${r1(1 / j.thinkScale)} people. Use the THINK_SCALE=1 run's requests-per-session figure for capacity planning, not this one.`);
    L.push("");
  }
  L.push("## Latency (server TTLB, ms)");
  L.push("");
  L.push("| slice | count | avg | p50 | p95 | p99 | max |");
  L.push("|---|---|---|---|---|---|---|");
  const row = (name, t, count) => t && L.push(`| ${name} | ${count ?? "—"} | ${ms(t.avg)} | ${ms(t.p50)} | ${ms(t.p95)} | ${ms(t.p99)} | ${ms(t.max)} |`);
  row("all requests", j.latencyMs.all, null);
  row("peak hold — all", j.latencyMs.peak, null);
  row("peak hold — pages", j.latencyMs.peakPages, null);
  row("recovery hold", j.latencyMs.recovery, null);
  for (const k in j.latencyMs.byKind) row(`kind: ${k}`, j.latencyMs.byKind[k], j.latencyMs.byKind[k].count);
  row("sign-in (end to end)", j.latencyMs.login, j.errors.logins);
  L.push("");
  L.push("## Errors, isolation, writes");
  L.push("");
  const e = j.errors;
  L.push(`- transport/HTTP failures ${pct(e.httpReqFailedRate)} · 5xx ${pct(e.serverErrorRate)} (peak ${pct(e.serverErrorRatePeak)}) · auth bounces ${pct(e.authBounceRate)} · business errors ${pct(e.businessErrorRate)} · checks passed ${pct(e.checksPassRate)}`);
  L.push(`- sign-ins ${e.logins} ok / ${e.loginFailures} failed · 429 rate-limited responses ${e.rateLimited} (measured, not failures) · non-auth redirects ${e.otherRedirects} (targets in k6.log)`);
  const i = j.isolation;
  L.push(`- tenant isolation: **${i.violations} violations** in ${i.scans} scanned responses · cross-tenant canaries ${i.canaryRefused}/${i.canaryProbes} refused, **${i.canaryLeaks} leaks**`);
  L.push(`- writes confirmed ${j.writes.confirmed} · outcome unknown ${j.writes.unknown} · iterations ${j.iterations}`);
  L.push("");
  L.push(j.failedThresholds.length ? `**Failed thresholds:** ${j.failedThresholds.map((t) => `\`${t}\``).join(", ")}` : "All thresholds passed.");
  if (meta.notes) {
    L.push("");
    L.push(meta.notes);
  }
  L.push("");
  return L.join("\n");
}

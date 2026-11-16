// load/k6/lib/http.js — request wrappers, metrics and the tenant-isolation scan.
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { BASE_URL, PREFETCH_PER_NAV, SCAN_RATE, THINK_SCALE } from "./config.js";

// ── metrics ──────────────────────────────────────────────────────────────────
/** A response for tenant A contained tenant B's marker. Must stay at zero. */
export const isolationViolations = new Counter("tenant_isolation_violations");
/** Bodies actually scanned (so "0 violations" is reported against a denominator). */
export const isolationScans = new Counter("tenant_isolation_scans");
/** An authenticated request was bounced to /login (session lost). */
export const authBounces = new Rate("auth_bounces");
/** 5xx from the app. */
export const serverErrors = new Rate("server_errors");
/** A request the product refused for a business reason we did not expect. */
export const businessErrors = new Rate("business_errors");
/** 429s, by endpoint tag — rate-limiter behaviour is a result, not a failure. */
export const rateLimited = new Counter("rate_limited");
/** Confirmed writes, by `write` tag — reconciled against the database afterwards. */
export const writesOk = new Counter("writes_ok");
/** Writes whose outcome the client could not confirm (timeout / 5xx). */
export const writesUnknown = new Counter("writes_unknown");
/** Cross-tenant canary probes sent / correctly refused. */
export const canaryProbes = new Counter("canary_probes");
export const canaryRefused = new Counter("canary_refused");
/** Uncompressed response size per endpoint. */
export const bodyBytes = new Trend("response_bytes");
/** Upload bytes accepted by Storage (through the app). */
export const uploadBytes = new Counter("upload_bytes");

// 3xx are normal (auth redirects are checked explicitly); 429 is measured, not failed.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 404, 409, 422, 429));

const MARKER_RE = /ltm_[0-9a-f]{12}/g;

/**
 * Tenant-isolation scan. Every seeded tenant's customer / job / quote / lead /
 * RAMS text carries that tenant's marker; a marker other than the caller's own
 * appearing in ANY response the caller receives is a cross-tenant read.
 */
export function scanIsolation(res, ownMarker, name) {
  if (!ownMarker || typeof res.body !== "string" || res.body.length === 0) return true;
  isolationScans.add(1);
  const found = res.body.match(MARKER_RE);
  if (!found) return true;
  for (let i = 0; i < found.length; i++) {
    if (found[i] !== ownMarker) {
      isolationViolations.add(1, { name });
      console.error(`TENANT ISOLATION VIOLATION on ${name}: saw ${found[i]}, own marker ${ownMarker}`);
      return false;
    }
  }
  return true;
}

function baseHeaders(extra) {
  return Object.assign({ "Accept-Encoding": "gzip", "User-Agent": "crewflow-load-harness/1 (k6)" }, extra || {});
}

function account(res, name, ctx, { authed = true } = {}) {
  serverErrors.add(res.status >= 500 || res.status === 0, { name });
  if (res.status === 429) rateLimited.add(1, { name });
  if (authed) {
    const loc = res.headers["Location"] || "";
    authBounces.add((res.status === 307 || res.status === 302) && loc.indexOf("/login") !== -1, { name });
  }
  if (typeof res.body === "string") bodyBytes.add(res.body.length, { name });
  if (ctx && ctx.marker && Math.random() < SCAN_RATE) scanIsolation(res, ctx.marker, name);
}

/**
 * Full document navigation (what the browser does on first load / hard nav),
 * or — with rsc:true — the RSC fetch a client-side <Link> navigation makes.
 * Both run the same middleware + server render; the RSC payload is smaller.
 */
export function page(ctx, path, name, opts) {
  const o = opts || {};
  const headers = baseHeaders(o.rsc ? { RSC: "1", Accept: "text/x-component" } : { Accept: "text/html" });
  const url = BASE_URL + path + (o.rsc ? (path.indexOf("?") === -1 ? "?" : "&") + "_rsc=" + rscToken() : "");
  const res = http.get(url, { headers, redirects: 0, tags: { name, kind: "page" } });
  account(res, name, ctx, o);
  check(res, { [`${name} 200`]: (r) => r.status === 200 });
  return res;
}

/** Background prefetches Next issues for visible <Link>s after a navigation. */
export function prefetch(ctx, paths) {
  const n = Math.min(PREFETCH_PER_NAV, paths.length);
  if (n <= 0) return;
  const reqs = [];
  for (let i = 0; i < n; i++) {
    reqs.push([
      "GET",
      BASE_URL + paths[i] + "?_rsc=" + rscToken(),
      null,
      { headers: baseHeaders({ RSC: "1", "Next-Router-Prefetch": "1", Accept: "text/x-component" }), redirects: 0, tags: { name: "prefetch", kind: "prefetch" } },
    ]);
  }
  const out = http.batch(reqs);
  for (let i = 0; i < out.length; i++) account(out[i], "prefetch", null);
}

export function apiGet(ctx, path, name, opts) {
  const res = http.get(BASE_URL + path, { headers: baseHeaders({ Accept: "application/json" }), redirects: 0, tags: { name, kind: "api" } });
  account(res, name, ctx, opts);
  check(res, { [`${name} 200`]: (r) => r.status === 200 });
  return res;
}

export function apiJson(ctx, method, path, body, name, opts) {
  const res = http.request(method, BASE_URL + path, JSON.stringify(body), {
    headers: baseHeaders(Object.assign({ "Content-Type": "application/json", Accept: "application/json", Origin: BASE_URL }, (opts && opts.headers) || {})),
    redirects: 0,
    tags: { name, kind: "api" },
  });
  account(res, name, ctx, opts);
  return res;
}

let rscSeq = 0;
function rscToken() {
  rscSeq = (rscSeq + 1) % 1e9;
  return rscSeq.toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

/** Human think time, uniformly in [min,max] seconds, scaled by THINK_SCALE. */
export function think(min, max) {
  sleep((min + Math.random() * (max - min)) * THINK_SCALE);
}

export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Weighted choice: [[weight, fn], …] */
export function weighted(table) {
  let total = 0;
  for (let i = 0; i < table.length; i++) total += table[i][0];
  let r = Math.random() * total;
  for (let i = 0; i < table.length; i++) {
    r -= table[i][0];
    if (r < 0) return table[i][1];
  }
  return table[table.length - 1][1];
}

/** Extract unique `/prefix/<uuid>` links from an HTML or RSC body. */
export function links(body, prefix) {
  if (typeof body !== "string") return [];
  const re = new RegExp(prefix.replace(/\//g, "\\/") + "\\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", "g");
  const seen = {};
  const out = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    if (!seen[m[1]]) {
      seen[m[1]] = true;
      out.push(m[1]);
    }
  }
  return out;
}

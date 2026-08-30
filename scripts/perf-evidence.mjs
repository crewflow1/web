#!/usr/bin/env node
/**
 * perf-evidence.mjs — honest local performance-evidence harness (L12).
 *
 * Measures server response time (TTLB of the full body) for a fixed set of
 * authenticated SSR pages and API routes against a LOCAL production build
 * (`next start` on :3000) backed by the LOCAL Supabase stack, using the seeded
 * Harrison & Cole rehearsal org.
 *
 * Method per route:
 *   - 1 recorded COLD request (first hit after server start = route-module
 *     compile/instantiation + connection setup),
 *   - 2 further un-recorded warmups,
 *   - 20 timed sequential requests (WARM, concurrency 1),
 *   - 20 timed requests through a 5-wide worker pool (WARM, concurrency 5).
 * Reports p50/p95/p99/max (nearest-rank on sorted samples) + non-200 counts.
 *
 * Auth: GoTrue password grant against the local stack, then the session is
 * encoded into the @supabase/ssr cookie format exactly the way
 * e2e/global-setup.ts mints Playwright storageState — cookie name
 * `sb-<first-hostname-label>-auth-token`, value `base64-` + base64url(JSON of
 * the session), chunked at 3180 chars (`.0`, `.1`, ... suffixes) — so the app
 * middleware accepts it and authenticated SSR pages actually render.
 *
 * Zero dependencies: Node 18+ global fetch + timers only. Read-only GETs; the
 * script mutates nothing. Refuses non-local targets.
 *
 * Usage:
 *   node scripts/perf-evidence.mjs            # markdown table to stdout
 *   PERF_JSON=/path/out.json node scripts/perf-evidence.mjs   # + raw JSON
 */

import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const BASE_URL = process.env.PERF_BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.PERF_EMAIL ?? "hc-owner@crewflow.test";
const PASSWORD = process.env.PERF_PASSWORD ?? "HC-rehearsal-2026!";
const WARMUPS_AFTER_COLD = 2;
const SEQ_SAMPLES = 20;
const CONC_SAMPLES = 20;
const CONCURRENCY = 5;

// ---- safety: local-only ----------------------------------------------------
for (const u of [BASE_URL]) {
  const h = new URL(u).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(h)) {
    console.error(`refusing non-local target ${u}`);
    process.exit(1);
  }
}

// ---- env (local Supabase creds from .env.local, overridable) ----------------
function loadEnvLocal() {
  const out = {};
  try {
    for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* fall through to process.env */
  }
  return out;
}
const envFile = loadEnvLocal();
const SUPABASE_URL =
  process.env.SUPABASE_URL ?? envFile.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? envFile.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!ANON_KEY) {
  console.error("no anon key (set SUPABASE_ANON_KEY or provide .env.local)");
  process.exit(1);
}
{
  const h = new URL(SUPABASE_URL).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(h)) {
    console.error(`refusing non-local Supabase ${SUPABASE_URL}`);
    process.exit(1);
  }
}

// ---- auth: password grant → @supabase/ssr chunked cookie --------------------
async function signIn() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`sign-in failed (${res.status}): ${await res.text()}`);
  return res.json(); // { access_token, refresh_token, expires_at, user, ... }
}

/** base64url without padding — mirrors @supabase/ssr's encoder. */
function base64url(str) {
  return Buffer.from(str, "utf8").toString("base64url");
}

/**
 * Mirrors @supabase/ssr createChunks (utils/chunker.js, MAX_CHUNK_SIZE=3180):
 * single cookie `<key>` if the URI-encoded value fits, else `<key>.0`, `<key>.1`…
 * base64url has no %-escapes so slicing is byte-simple, but we keep the same
 * encodeURIComponent-length rule for fidelity.
 */
function cookieChunks(key, value, chunkSize = 3180) {
  if (encodeURIComponent(value).length <= chunkSize) return [[key, value]];
  const chunks = [];
  let rest = value;
  while (rest.length > 0) {
    // base64url alphabet is URI-safe: encoded length == raw length
    chunks.push(rest.slice(0, chunkSize));
    rest = rest.slice(chunkSize);
  }
  return chunks.map((v, i) => [`${key}.${i}`, v]);
}

function mintCookieHeader(session) {
  const label = new URL(SUPABASE_URL).hostname.split(".")[0]; // "127" locally
  const key = `sb-${label}-auth-token`;
  const value = `base64-${base64url(JSON.stringify(session))}`;
  return cookieChunks(key, value)
    .map(([n, v]) => `${n}=${v}`)
    .join("; ");
}

// ---- measurement -------------------------------------------------------------
async function timedFetch(url, cookie) {
  const t0 = performance.now();
  let status = 0;
  try {
    const res = await fetch(url, {
      redirect: "manual", // a 30x on an authed page means auth failed — surface it
      headers: cookie ? { cookie } : {},
    });
    status = res.status;
    await res.arrayBuffer(); // TTLB: drain the full body
  } catch {
    status = -1; // network / server error
  }
  return { ms: performance.now() - t0, status };
}

function pct(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}
function stats(samples) {
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  return {
    n: samples.length,
    p50: pct(sorted, 50),
    p95: pct(sorted, 95),
    p99: pct(sorted, 99),
    max: sorted[sorted.length - 1] ?? NaN,
    mean: sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1),
    errors: samples.filter((s) => s.status !== 200).length,
    statuses: [...new Set(samples.map((s) => s.status))],
  };
}

async function pool(n, tasks) {
  const results = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < tasks.length) {
        const t = tasks[i++];
        results.push(await t());
      }
    }),
  );
  return results;
}

async function measureRoute(route) {
  const url = `${BASE_URL}${route.path}`;
  const cookie = route.auth ? route.cookie : undefined;

  const cold = await timedFetch(url, cookie);
  for (let i = 0; i < WARMUPS_AFTER_COLD; i++) await timedFetch(url, cookie);

  const seq = [];
  for (let i = 0; i < SEQ_SAMPLES; i++) seq.push(await timedFetch(url, cookie));

  const conc = await pool(
    CONCURRENCY,
    Array.from({ length: CONC_SAMPLES }, () => () => timedFetch(url, cookie)),
  );

  return { ...route, cold, seq: stats(seq), conc: stats(conc) };
}

// ---- routes -------------------------------------------------------------------
const PAGES = ["/dashboard", "/jobs", "/invoices", "/customers", "/me", "/reports", "/health-safety"];
const APIS = [
  { path: "/api/health", auth: false },
  { path: "/api/search?q=fitz", auth: true },
  { path: "/api/reports", auth: true },
];

// ---- main ----------------------------------------------------------------------
const f = (x) => (Number.isFinite(x) ? x.toFixed(0) : "—");

async function main() {
  // server up?
  const ping = await timedFetch(`${BASE_URL}/api/health`);
  if (ping.status === -1) {
    console.error(`no server at ${BASE_URL} — run \`npm run build && npm run start\` first`);
    process.exit(1);
  }

  const session = await signIn();
  const cookie = mintCookieHeader(session);

  // verify auth actually renders SSR (not a redirect to /login)
  const authCheck = await fetch(`${BASE_URL}/dashboard`, { redirect: "manual", headers: { cookie } });
  await authCheck.arrayBuffer();
  if (authCheck.status !== 200) {
    console.error(`auth check failed: /dashboard returned ${authCheck.status} (expected 200). Cookie minting or seed is wrong — aborting rather than measuring redirects.`);
    process.exit(1);
  }

  const routes = [
    ...PAGES.map((p) => ({ path: p, kind: "page", auth: true, cookie })),
    ...APIS.map((a) => ({ ...a, kind: "api", cookie })),
  ];

  const results = [];
  for (const r of routes) {
    process.stderr.write(`measuring ${r.path} ...\n`);
    results.push(await measureRoute(r));
  }

  // markdown
  console.log(`| route | kind | cold (ms) | warm seq p50/p95/p99/max (ms) | warm c=5 p50/p95/p99/max (ms) | non-200 |`);
  console.log(`|---|---|---|---|---|---|`);
  for (const r of results) {
    const errs = r.seq.errors + r.conc.errors;
    const errNote = errs === 0 ? "0/40" : `**${errs}/40** (${[...new Set([...r.seq.statuses, ...r.conc.statuses])].join(",")})`;
    console.log(
      `| \`${r.path}\` | ${r.kind} | ${f(r.cold.ms)} | ${f(r.seq.p50)} / ${f(r.seq.p95)} / ${f(r.seq.p99)} / ${f(r.seq.max)} | ${f(r.conc.p50)} / ${f(r.conc.p95)} / ${f(r.conc.p99)} / ${f(r.conc.max)} | ${errNote} |`,
    );
  }

  if (process.env.PERF_JSON) {
    const clean = results.map(({ cookie: _c, ...r }) => r);
    writeFileSync(process.env.PERF_JSON, JSON.stringify({ base: BASE_URL, when: new Date().toISOString(), results: clean }, null, 2));
    process.stderr.write(`raw JSON → ${process.env.PERF_JSON}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

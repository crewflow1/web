#!/usr/bin/env node
/**
 * perf-fanout.mjs — DB query-fan-out evidence harness (sibling of perf-evidence.mjs).
 *
 * Answers "how many DB round-trips does each journey make", so a performance PR
 * can prove BEFORE → AFTER on query COUNT (the dominant prod-latency driver:
 * query volume × Vercel↔Supabase RTT — see PERFORMANCE-BASELINE-2026-10-22.md).
 *
 * Method per route: reset pg_stat_statements, issue ONE authenticated request
 * against a LOCAL production build (`next start` on :3000) backed by the LOCAL
 * Supabase CLI stack, then read back the PostgREST data-query count + the tables
 * hit + the GoTrue auth-verify count.
 *
 * Read-only: issues GETs and resets/reads pg_stat_statements (a counters view) —
 * it mutates no application data. Refuses non-local targets. Auth cookie minted
 * exactly as perf-evidence.mjs / e2e/global-setup.ts do.
 *
 * Requires the local Supabase CLI stack (Postgres reached via
 *   docker exec $PG_CONTAINER psql   (default container supabase_db_crewflow)).
 *
 * Usage:
 *   npm run build && npm run start           # in another shell
 *   SUPABASE_ANON_KEY=... node scripts/perf-fanout.mjs
 *   PG_CONTAINER=supabase_db_myproj PERF_ROUTES=/dashboard,/jobs node scripts/perf-fanout.mjs
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const BASE_URL = process.env.PERF_BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.PERF_EMAIL ?? "hc-owner@crewflow.test";
const PASSWORD = process.env.PERF_PASSWORD ?? "HC-rehearsal-2026!";
const PG_CONTAINER = process.env.PG_CONTAINER ?? "supabase_db_crewflow";

// ---- safety: local-only (mirror perf-evidence.mjs) --------------------------
const assertLocal = (u, what) => {
  const h = new URL(u).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(h)) {
    console.error(`refusing non-local ${what}: ${u}`);
    process.exit(1);
  }
};
assertLocal(BASE_URL, "target");

function loadEnvLocal() {
  const out = {};
  try {
    for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* fall through to process.env */ }
  return out;
}
const envFile = loadEnvLocal();
const SUPABASE_URL = process.env.SUPABASE_URL ?? envFile.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? envFile.NEXT_PUBLIC_SUPABASE_ANON_KEY;
assertLocal(SUPABASE_URL, "Supabase");
if (!ANON_KEY) { console.error("no anon key (set SUPABASE_ANON_KEY or provide .env.local)"); process.exit(1); }

// ---- auth: password grant → @supabase/ssr chunked cookie --------------------
const session = await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: "POST", headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
}).catch(() => ({ json: async () => ({}) }))).json();
if (!session.access_token) { console.error("sign-in failed — is the local stack up and seeded?"); process.exit(1); }
const label = new URL(SUPABASE_URL).hostname.split(".")[0];
const value = `base64-${Buffer.from(JSON.stringify(session), "utf8").toString("base64url")}`;
const cookieChunks = (key, v, sz = 3180) => {
  if (encodeURIComponent(v).length <= sz) return [[key, v]];
  const out = []; let rest = v;
  while (rest.length) { out.push(rest.slice(0, sz)); rest = rest.slice(sz); }
  return out.map((c, i) => [`${key}.${i}`, c]);
};
const cookie = cookieChunks(`sb-${label}-auth-token`, value).map(([n, v]) => `${n}=${v}`).join("; ");

// ---- DB counters via the local Supabase CLI Postgres container --------------
const psql = (sql) => {
  try {
    return execSync(`docker exec -i ${PG_CONTAINER} psql -U postgres -d postgres -t -A -F'|'`, { input: sql }).toString().trim();
  } catch (e) {
    console.error(`psql via 'docker exec ${PG_CONTAINER}' failed — is the local Supabase stack running? Set PG_CONTAINER to override.`);
    throw e;
  }
};

// ---- measurement ------------------------------------------------------------
const ping = await fetch(`${BASE_URL}/api/health`).catch(() => null);
if (!ping) { console.error(`no server at ${BASE_URL} — run \`npm run build && npm run start\` first`); process.exit(1); }
const authChk = await fetch(`${BASE_URL}/dashboard`, { redirect: "manual", headers: { cookie } });
await authChk.arrayBuffer();
if (authChk.status !== 200) { console.error(`auth check: /dashboard -> ${authChk.status} (expected 200). Cookie/seed wrong — aborting.`); process.exit(1); }

const routes = (process.env.PERF_ROUTES ?? "/dashboard,/jobs,/invoices,/customers,/quotes,/reports,/leads,/health-safety,/me,/api/search?q=fitz").split(",");
console.log(`# DB fan-out — ${new Date().toISOString()} — ${BASE_URL}`);
console.log(`| route | data round-trips | distinct | db exec (ms) | auth verifies | top tables (table×calls) |`);
console.log(`|---|---|---|---|---|---|`);
for (const r of routes) {
  psql("select pg_stat_statements_reset();");
  const res = await fetch(BASE_URL + r, { redirect: "manual", headers: { cookie } });
  await res.arrayBuffer();
  const dq = psql("select coalesce(sum(calls),0)||'|'||count(*)||'|'||round(coalesce(sum(total_exec_time),0)::numeric,1) from pg_stat_statements where query ilike '%pgrst_source%';");
  const authv = psql("select coalesce(sum(calls),0) from pg_stat_statements s join pg_roles r on r.oid=s.userid where r.rolname='supabase_auth_admin';");
  const tables = psql("select string_agg(t||'×'||c, ', ' order by c desc) from (select substring(query from 'FROM \"public\".\"([a-z_]+)\"') t, sum(calls) c from pg_stat_statements where query ilike '%pgrst_source%' group by 1 order by 2 desc limit 8) x;");
  const [calls, distinct, ms] = dq.split("|");
  console.log(`| \`${r}\` [${res.status}] | ${calls} | ${distinct} | ${ms} | ${authv} | ${tables ?? ""} |`);
}

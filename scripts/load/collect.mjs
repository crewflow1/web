#!/usr/bin/env node
/**
 * scripts/load/collect.mjs — out-of-band collector for a load run.
 *
 *   node scripts/load/collect.mjs --out <dir> [--interval 3] [--next-pid <pid>] [--containers a,b]
 *   (stops on SIGINT / SIGTERM, then writes collector.json + collector.md)
 *
 * Samples, every --interval seconds:
 *   - Postgres connections from pg_stat_activity: total, active, idle-in-transaction,
 *     waiting on a lock, broken down by role + application (the number to watch:
 *     the app reaches Postgres only through PostgREST's pool — see
 *     docs/connection-pooling-and-scale.md);
 *   - LOCAL ONLY: `docker stats` CPU / memory for the Supabase containers and
 *     `ps` CPU / RSS for the Next.js server process.
 * And once at the end: the pg_stat_statements DELTA over the run (snapshot at
 * start, diff at end — the shared database's statistics are never reset), top
 * statements by total execution time.
 *
 * Read-only: only SELECTs against catalog/statistics views. Target-guarded
 * (production refused) via ./_guard.mjs; no secret is read or printed.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { authoriseTarget, parseArgs } from "./_guard.mjs";

const LOCAL_DB = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const args = parseArgs(process.argv.slice(2));
const dbUrl = String(args.db ?? process.env.LOAD_DATABASE_URL ?? process.env.DB_URL ?? LOCAL_DB);
const target = authoriseTarget(dbUrl, "database URL");
const outDir = resolve(String(args.out ?? "load/results/collector"));
const intervalMs = Math.max(1, Number(args.interval ?? 3)) * 1000;
const nextPid = args["next-pid"] ? Number(args["next-pid"]) : null;
const containers = String(args.containers ?? "supabase_db_crewflow,supabase_rest_crewflow,supabase_auth_crewflow,supabase_kong_crewflow,supabase_storage_crewflow")
  .split(",").map((s) => s.trim()).filter(Boolean);
mkdirSync(outDir, { recursive: true });
const samplesFile = resolve(outDir, "collector-samples.jsonl");
writeFileSync(samplesFile, "");

function psqlJson(sql) {
  const r = spawnSync("psql", [dbUrl, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || "").slice(0, 400)}`);
  return JSON.parse(r.stdout.trim() || "null");
}

const ACTIVITY_SQL = `
select json_build_object(
  'total', count(*),
  'active', count(*) filter (where state = 'active'),
  'idle_in_tx', count(*) filter (where state like 'idle in transaction%'),
  'lock_wait', count(*) filter (where wait_event_type = 'Lock'),
  'max_connections', current_setting('max_connections')::int,
  'by', coalesce((select json_object_agg(k, n) from (
           select coalesce(usename, '(bg)') || '/' || coalesce(nullif(split_part(application_name, ' ', 1), ''), '-') || '/' || coalesce(state, '-') as k, count(*) as n
           from pg_stat_activity where pid <> pg_backend_pid() group by 1) x), '{}'::json)
) from pg_stat_activity where pid <> pg_backend_pid();`;

const STATEMENTS_SQL = `
select coalesce(json_agg(json_build_object('id', queryid::text, 'calls', calls, 'total', total_exec_time, 'rows', rows, 'q', left(regexp_replace(query, '\\s+', ' ', 'g'), 160))), '[]'::json)
from pg_stat_statements where dbid = (select oid from pg_database where datname = current_database());`;

function hasStatements() {
  try {
    return psqlJson("select to_json(exists (select 1 from pg_extension where extname = 'pg_stat_statements'))") === true;
  } catch {
    return false;
  }
}

function dockerStats() {
  if (target !== "local" || containers.length === 0) return null;
  const r = spawnSync("docker", ["stats", "--no-stream", "--format", "{{json .}}", ...containers], { encoding: "utf8", timeout: 15000 });
  if (r.status !== 0) return null;
  const out = {};
  for (const line of r.stdout.trim().split("\n")) {
    try {
      const j = JSON.parse(line);
      out[j.Name.replace(/^supabase_/, "").replace(/_crewflow$/, "")] = { cpu: parseFloat(j.CPUPerc), mem: j.MemUsage.split(" / ")[0] };
    } catch { /* skip */ }
  }
  return out;
}

function nextStats() {
  if (!nextPid) return null;
  // Next spawns a child `next-server` process; sum the tree rooted at the pid.
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,%cpu=,rss="], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const rows = r.stdout.trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
  const tree = new Set([nextPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of rows) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); grew = true; }
  }
  let cpu = 0, rss = 0;
  for (const [pid, , c, k] of rows) if (tree.has(pid)) { cpu += c; rss += k; }
  return { cpu, rssMb: Math.round(rss / 1024) };
}

const statementsOn = hasStatements();
const before = statementsOn ? psqlJson(STATEMENTS_SQL) : [];
const startedAt = new Date().toISOString();
const samples = [];
let stopping = false;

function sample() {
  const s = { t: new Date().toISOString() };
  try { s.pg = psqlJson(ACTIVITY_SQL); } catch (e) { s.pgError = String(e.message).slice(0, 200); }
  s.docker = dockerStats();
  s.next = nextStats();
  samples.push(s);
  appendFileSync(samplesFile, JSON.stringify(s) + "\n");
}

function maxOf(fn) {
  let m = null;
  for (const s of samples) {
    const x = fn(s);
    if (typeof x === "number" && !Number.isNaN(x) && (m === null || x > m)) m = x;
  }
  return m;
}
function avgOf(fn) {
  const xs = samples.map(fn).filter((x) => typeof x === "number" && !Number.isNaN(x));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function finish() {
  if (stopping) return;
  stopping = true;
  const after = statementsOn ? psqlJson(STATEMENTS_SQL) : [];
  const prev = new Map(before.map((r) => [r.id, r]));
  const delta = after
    .map((r) => {
      const p = prev.get(r.id);
      return { calls: r.calls - (p ? p.calls : 0), totalMs: r.total - (p ? p.total : 0), rows: r.rows - (p ? p.rows : 0), q: r.q };
    })
    .filter((r) => r.calls > 0)
    .sort((a, b) => b.totalMs - a.totalMs);
  const totalCalls = delta.reduce((a, r) => a + r.calls, 0);
  const totalMs = delta.reduce((a, r) => a + r.totalMs, 0);

  const containerNames = new Set();
  for (const s of samples) for (const k of Object.keys(s.docker || {})) containerNames.add(k);
  const containerCpu = {};
  for (const k of containerNames) {
    containerCpu[k] = { maxCpuPct: maxOf((s) => s.docker?.[k]?.cpu), avgCpuPct: avgOf((s) => s.docker?.[k]?.cpu) };
  }
  const pgKeys = new Set();
  for (const s of samples) for (const k of Object.keys(s.pg?.by || {})) pgKeys.add(k);
  const byMax = {};
  for (const k of pgKeys) byMax[k] = maxOf((s) => s.pg?.by?.[k]);

  const summary = {
    schema: "crewflow-load-collector/1",
    target,
    startedAt,
    endedAt: new Date().toISOString(),
    samples: samples.length,
    intervalS: intervalMs / 1000,
    postgres: {
      maxConnections: samples.find((s) => s.pg)?.pg.max_connections ?? null,
      peakTotal: maxOf((s) => s.pg?.total),
      peakActive: maxOf((s) => s.pg?.active),
      avgActive: avgOf((s) => s.pg?.active),
      peakIdleInTx: maxOf((s) => s.pg?.idle_in_tx),
      peakLockWait: maxOf((s) => s.pg?.lock_wait),
      peakByRoleAppState: byMax,
    },
    containers: containerCpu,
    next: nextPid ? { maxCpuPct: maxOf((s) => s.next?.cpu), avgCpuPct: avgOf((s) => s.next?.cpu), maxRssMb: maxOf((s) => s.next?.rssMb) } : null,
    statements: statementsOn ? { calls: totalCalls, totalExecMs: Math.round(totalMs), top: delta.slice(0, 15).map((r) => ({ ...r, totalMs: Math.round(r.totalMs), meanMs: Math.round((r.totalMs / r.calls) * 100) / 100 })) } : null,
  };
  writeFileSync(resolve(outDir, "collector.json"), JSON.stringify(summary, null, 2));
  writeFileSync(resolve(outDir, "collector.md"), toMarkdown(summary));
  console.error(`[collect] ${samples.length} samples → ${outDir}`);
  process.exit(0);
}

function toMarkdown(s) {
  const L = ["## Server-side signals (collector)", ""];
  const p = s.postgres;
  L.push(`- Postgres connections (pg_stat_activity, sampled every ${s.intervalS}s, ${s.samples} samples): peak total **${p.peakTotal}** of max_connections ${p.maxConnections}; peak active ${p.peakActive} (avg ${p.avgActive === null ? "—" : p.avgActive.toFixed(1)}); peak idle-in-transaction ${p.peakIdleInTx}; peak lock-waiters ${p.peakLockWait}.`);
  const top = Object.entries(p.peakByRoleAppState).sort((a, b) => b[1] - a[1]).slice(0, 8);
  L.push(`- peak by role/application/state: ${top.map(([k, n]) => `\`${k}\` ${n}`).join(" · ")}`);
  if (Object.keys(s.containers).length) {
    L.push(`- container CPU (docker stats; 100% = one core): ${Object.entries(s.containers).map(([k, c]) => `${k} max ${c.maxCpuPct?.toFixed(0)}% / avg ${c.avgCpuPct?.toFixed(0)}%`).join(" · ")}`);
  }
  if (s.next) L.push(`- Next.js server process tree: CPU max ${s.next.maxCpuPct?.toFixed(0)}% / avg ${s.next.avgCpuPct?.toFixed(0)}% (100% = one core), RSS max ${s.next.maxRssMb} MB`);
  if (s.statements) {
    L.push(`- pg_stat_statements delta over the run: ${s.statements.calls} statements, ${s.statements.totalExecMs} ms total execution.`);
    L.push("");
    L.push("| calls | total ms | mean ms | rows | statement (truncated) |");
    L.push("|---|---|---|---|---|");
    for (const r of s.statements.top) L.push(`| ${r.calls} | ${r.totalMs} | ${r.meanMs} | ${r.rows} | \`${r.q.replace(/\|/g, "\\|").replace(/`/g, "'")}\` |`);
  }
  L.push("");
  return L.join("\n");
}

process.on("SIGINT", finish);
process.on("SIGTERM", finish);
sample();
const timer = setInterval(() => { if (!stopping) sample(); }, intervalMs);
if (args.duration) setTimeout(() => { clearInterval(timer); finish(); }, Number(args.duration) * 1000);

#!/usr/bin/env node
/**
 * scripts/load/trace-summary.mjs — per-route outbound fan-out from a trace.
 *
 *   node scripts/load/trace-summary.mjs <trace.jsonl> [--actions load/k6/.manifest/actions.json]
 *
 * Input: the JSON lines written by scripts/load/trace-fetch.cjs during a run.
 * Output (stdout, markdown): per normalised route — requests, server ms
 * p50/p95, and the MEAN number of Supabase round-trips each request made
 * (auth / rest / storage). Round-trips per request × the app↔database RTT is
 * the latency the same code pays once the app and the database are in
 * different data centres — invisible on loopback, dominant in production.
 * Pure file processing: no network, no database.
 */
import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "./_guard.mjs";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Pure: normalise a request path for grouping. Exported for tests. */
export function routeKey(row, actionNames) {
  const path = String(row.path || "").replace(UUID, "[id]").replace(/\/l\/[a-z0-9-]+$/, "/l/[slug]");
  if (row.action) return `ACTION ${actionNames[row.action] || row.action.slice(0, 8)} @ ${path}`;
  return `${row.method} ${path}${row.rsc ? " (rsc)" : ""}`;
}

export function pctl(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args._[0];
  if (!file) throw new Error("usage: trace-summary.mjs <trace.jsonl>");
  let actionNames = {};
  try {
    const m = JSON.parse(readFileSync(String(args.actions ?? "load/k6/.manifest/actions.json"), "utf8"));
    for (const [ref, id] of Object.entries(m.actions || {})) actionNames[id] = ref.split("#")[1];
  } catch { actionNames = {}; }

  const groups = new Map();
  let total = 0;
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.startsWith('{"t":"in"')) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    total++;
    const k = routeKey(r, actionNames);
    const g = groups.get(k) || { n: 0, ms: [], out: 0, auth: 0, rest: 0, storage: 0, s5xx: 0 };
    g.n++;
    g.ms.push(r.ms);
    g.out += r.out; g.auth += r.auth; g.rest += r.rest; g.storage += r.storage;
    if (r.status >= 500) g.s5xx++;
    groups.set(k, g);
  }
  const rows = [...groups.entries()].sort((a, b) => b[1].n - a[1].n);
  const L = ["## Outbound fan-out per route (server-side trace)", ""];
  const allOut = rows.reduce((a, [, g]) => a + g.out, 0);
  L.push(`${total} inbound requests traced; ${allOut} outbound Supabase calls (${total ? (allOut / total).toFixed(1) : 0} per request on average).`);
  L.push("");
  L.push("| route | requests | server p50 ms | server p95 ms | Supabase calls / req (auth · rest · storage) | 5xx |");
  L.push("|---|---|---|---|---|---|");
  for (const [k, g] of rows.slice(0, 30)) {
    const s = g.ms.sort((a, b) => a - b);
    const per = (x) => (x / g.n).toFixed(1);
    L.push(`| \`${k}\` | ${g.n} | ${Math.round(pctl(s, 50))} | ${Math.round(pctl(s, 95))} | ${per(g.out)} (${per(g.auth)} · ${per(g.rest)} · ${per(g.storage)}) | ${g.s5xx} |`);
  }
  L.push("");
  process.stdout.write(L.join("\n"));
}

if (process.argv[1] && process.argv[1].endsWith("trace-summary.mjs")) {
  main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
}

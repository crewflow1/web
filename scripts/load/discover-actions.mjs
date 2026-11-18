#!/usr/bin/env node
/**
 * scripts/load/discover-actions.mjs — map server-action source references to
 * the build-specific action ids, from the build's OWN manifest.
 *
 *   node scripts/load/discover-actions.mjs [--next .next] [--out load/k6/.manifest/actions.json]
 *
 * Reads `.next/server/server-reference-manifest.json` (Next 15 records
 * `filename` + `exportedName` per action id) and `.next/BUILD_ID`, and writes
 * { buildId, actions: { "<file>#<export>": "<id>" } }. The k6 setup() only
 * trusts this map when its buildId equals the build the target is serving;
 * otherwise it discards it and falls back to HTTP discovery (never guesses).
 * Reads local build output only — no network, no database.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./_guard.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = parseArgs(process.argv.slice(2));
const nextDir = resolve(REPO, String(args.next ?? ".next"));
const out = resolve(REPO, String(args.out ?? "load/k6/.manifest/actions.json"));

/** Pure: manifest JSON → { "<file>#<export>": id }. Exported for tests. */
export function actionsFromManifest(manifest) {
  const map = {};
  for (const layer of ["node", "edge"]) {
    for (const [id, entry] of Object.entries(manifest?.[layer] ?? {})) {
      if (entry && entry.filename && entry.exportedName) map[`${entry.filename}#${entry.exportedName}`] = id;
    }
  }
  return map;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(resolve(nextDir, "server", "server-reference-manifest.json"), "utf8"));
  const buildId = readFileSync(resolve(nextDir, "BUILD_ID"), "utf8").trim();
  const actions = actionsFromManifest(manifest);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ buildId, generatedAt: new Date().toISOString(), actions }, null, 1));
  console.log(JSON.stringify({ buildId, actions: Object.keys(actions).length, out }));
}

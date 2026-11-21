#!/usr/bin/env node
/**
 * Per-installed-instance view of `npm audit --json` output.
 *
 * `npm audit` reports a vulnerability NODE per package name with the union range of every advisory;
 * a package can appear "vulnerable" there because an old advisory range overlaps some other
 * version. This script re-evaluates each advisory range against each version actually present in
 * package-lock.json, so we can say which advisories genuinely apply to which installed copy,
 * who pulls that copy in (shortest dependency chain from the root), and whether it is prod or dev.
 *
 * Usage: node scripts/compliance/audit-summary.mjs <audit.json> [--out file.json]
 * Needs `semver` (already a transitive dependency; resolved from node_modules).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(path.join(process.cwd(), "package.json"));
const semver = require("semver");

const auditFile = process.argv[2];
const outIdx = process.argv.indexOf("--out");
const audit = JSON.parse(fs.readFileSync(auditFile, "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));

// instances by name
const inst = new Map();
for (const [k, v] of Object.entries(lock.packages)) {
  if (!k) continue;
  const name = k.split("node_modules/").pop();
  (inst.get(name) || inst.set(name, []).get(name)).push({ path: k, version: v.version, dev: !!v.dev, devOptional: !!v.devOptional, optional: !!v.optional, deps: { ...v.dependencies, ...v.optionalDependencies } });
}
// resolve a dependency edge from a package path (node resolution through nested node_modules)
function resolveDep(fromPath, dep) {
  let base = fromPath;
  while (true) {
    const cand = (base ? base + "/" : "") + "node_modules/" + dep;
    if (lock.packages[cand]) return cand;
    if (!base) return null;
    const i = base.lastIndexOf("/node_modules/");
    base = i >= 0 ? base.slice(0, i) : "";
  }
}
// shortest chain from root to a path (BFS, prod edges first = regular deps of root)
const root = lock.packages[""];
const parents = new Map();
const q = [];
for (const d of Object.keys({ ...root.dependencies, ...root.devDependencies })) { const p = resolveDep("", d); if (p && !parents.has(p)) { parents.set(p, ""); q.push(p); } }
while (q.length) {
  const cur = q.shift();
  const v = lock.packages[cur];
  for (const d of Object.keys({ ...v.dependencies, ...v.optionalDependencies })) {
    const p = resolveDep(cur, d);
    if (p && !parents.has(p)) { parents.set(p, cur); q.push(p); }
  }
}
const short = (p) => p.split("node_modules/").pop();
function chain(p) { const out = []; let c = p; while (c) { out.unshift(short(c) + "@" + lock.packages[c].version); c = parents.get(c); } return out.join(" > "); }
const scopeOf = (i) => (i.dev ? "dev" : i.devOptional ? "dev-optional" : i.optional ? "prod-optional" : "prod");

const results = [];
for (const [name, v] of Object.entries(audit.vulnerabilities)) {
  const advisories = v.via.filter((x) => typeof x === "object");
  for (const i of inst.get(name) || []) {
    const hit = advisories.filter((a) => { try { return semver.satisfies(i.version, a.range, { includePrerelease: true }); } catch { return false; } });
    if (!hit.length) continue;
    results.push({
      package: name, version: i.version, path: i.path, scope: scopeOf(i), direct: Object.keys({ ...root.dependencies, ...root.devDependencies }).includes(name) && i.path === "node_modules/" + name,
      severity: ["critical", "high", "moderate", "low"].find((s) => hit.some((a) => a.severity === s)),
      advisories: hit.map((a) => ({ ghsa: (a.url || "").split("/").pop(), title: a.title, severity: a.severity, range: a.range })),
      chain: parents.has(i.path) ? chain(i.path) : "(unreachable from root in lock graph)",
      fix: typeof v.fixAvailable === "object" ? `${v.fixAvailable.name}@${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? " (semver-major)" : ""}` : String(v.fixAvailable),
    });
  }
}
const rank = { critical: 0, high: 1, moderate: 2, low: 3 };
results.sort((a, b) => rank[a.severity] - rank[b.severity] || a.package.localeCompare(b.package));
if (outIdx > 0) fs.writeFileSync(process.argv[outIdx + 1], JSON.stringify(results, null, 1) + "\n");
const t = {};
for (const r of results) t[`${r.scope}:${r.severity}`] = (t[`${r.scope}:${r.severity}`] || 0) + 1;
console.log("instances with >=1 applicable advisory:", results.length, t);
for (const r of results) console.log(r.severity.toUpperCase().padEnd(8), r.scope.padEnd(13), `${r.package}@${r.version}`.padEnd(34), `[${r.advisories.length} adv]`, "fix:", r.fix, "\n          via:", r.chain);

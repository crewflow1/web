#!/usr/bin/env node
/**
 * Heuristic: which npm packages can reach the BROWSER bundle?
 *
 * Method (static, no build):
 *  1. Parse every .ts/.tsx/.js/.mjs under app/ components/ lib/ + root client entry files.
 *  2. Seeds = files with a top-of-file "use client" directive, plus sentry.client.config.ts /
 *     instrumentation-client.* . Follow relative and "@/" imports transitively (a module imported
 *     by a client module is bundled to the client, even without its own directive).
 *  3. Collect bare-specifier package imports from that closure ("direct client packages").
 *  4. Expand through package-lock `dependencies` (not peers/optional-only) to get the client closure.
 *
 * It over-approximates (a shared lib file imported by a client file may import server-only things that
 * `server-only` would block at build time) and cannot see dynamic string imports. Treat "client-reachable"
 * as "assume it ships to browsers" and "no" as "server/build only, unless proven otherwise".
 * A real `next build` bundle analysis is the authoritative check.
 *
 * Output: docs/compliance/client-bundle-trace.json
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const SRC_DIRS = ["app", "components", "lib", "server", "hooks", "emails"];
const EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
const files = new Map(); // abs -> {src, imports[], client}
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (EXT.includes(path.extname(e.name)) && !/\.(test|spec)\./.test(e.name)) files.set(p, null);
  }
}
for (const d of SRC_DIRS) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));
for (const f of ["sentry.client.config.ts", "instrumentation-client.ts", "instrumentation.ts"]) {
  const p = path.join(root, f); if (fs.existsSync(p)) files.set(p, null);
}
const importRe = /(?:import|export)\s+(?!type\s)(?:[^'"()]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
for (const f of files.keys()) {
  const src = fs.readFileSync(f, "utf8");
  const head = src.slice(0, 400);
  const client = /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*["']use client["']/.test(head);
  const imports = [];
  let m; importRe.lastIndex = 0;
  while ((m = importRe.exec(src))) imports.push(m[1] || m[2] || m[3]);
  files.set(f, { client, imports });
}
function resolveLocal(from, spec) {
  let base;
  if (spec.startsWith("@/")) base = path.join(root, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  const cands = [base, ...EXT.map((e) => base + e), ...EXT.map((e) => path.join(base, "index" + e))];
  return cands.find((c) => files.has(c)) || null;
}
const pkgName = (s) => (s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]);
const isBare = (s) => !s.startsWith(".") && !s.startsWith("@/") && !s.startsWith("node:") && !s.startsWith("/");

const seeds = [...files.entries()].filter(([f, v]) => v.client || /sentry\.client\.config|instrumentation-client/.test(f)).map(([f]) => f);
const seen = new Set(seeds), queue = [...seeds], direct = new Map(); // pkg -> first file
while (queue.length) {
  const f = queue.pop();
  for (const s of files.get(f).imports) {
    if (isBare(s)) { const n = pkgName(s); if (!direct.has(n)) direct.set(n, path.relative(root, f)); continue; }
    const r = resolveLocal(f, s);
    if (r && !seen.has(r)) { seen.add(r); queue.push(r); }
  }
}
// Expand via lockfile
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const byName = new Map();
for (const [k, v] of Object.entries(lock.packages)) { if (!k) continue; const n = k.split("node_modules/").pop(); (byName.get(n) || byName.set(n, []).get(n)).push({ k, v }); }
const closure = new Set(), q2 = [...direct.keys()];
while (q2.length) {
  const n = q2.pop(); if (closure.has(n)) continue; closure.add(n);
  for (const { v } of byName.get(n) || []) for (const d of Object.keys(v.dependencies || {})) q2.push(d);
}
const out = {
  note: "Heuristic static trace; see scripts/compliance/client-bundle-trace.mjs header for method and limits.",
  clientSeedFiles: seeds.length, clientReachableLocalFiles: seen.size,
  directClientPackages: Object.fromEntries([...direct].sort()),
  clientClosurePackages: [...closure].sort(),
};
fs.writeFileSync(path.join(root, "docs/compliance/client-bundle-trace.json"), JSON.stringify(out, null, 1) + "\n");
console.log({ seeds: seeds.length, localFiles: seen.size, directPkgs: direct.size, closure: closure.size });
console.log([...direct.keys()].sort().join(", "));

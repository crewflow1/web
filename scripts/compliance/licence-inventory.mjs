#!/usr/bin/env node
/**
 * Licence inventory for every package in package-lock.json (direct + transitive).
 *
 * Sources, in order of trust, for each package:
 *   1. the package's own package.json  (node_modules/<path>)   -> "declared"
 *   2. LICENSE / COPYING / NOTICE files shipped in the package -> "text" (fingerprinted)
 *   3. the `license` field npm recorded in package-lock.json   -> "lock"
 * The three are cross-checked; any disagreement is flagged (never silently resolved).
 *
 * If a package is not installed in this tree (platform-specific optionals, or a partial
 * node_modules clone) a fallback tree may be given with --fallback <dir>; versions must match.
 *
 * Usage: node scripts/compliance/licence-inventory.mjs [--fallback <dir>] [--out <dir>]
 * Output: <out>/licence-inventory.csv  and  <out>/licence-inventory.json
 *
 * No dependencies; read-only against node_modules.
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const root = process.cwd();
const outDir = path.resolve(opt("--out", "docs/compliance"));
const fallback = opt("--fallback", null) && path.resolve(opt("--fallback"));

const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const directProd = new Set(Object.keys(rootPkg.dependencies || {}));
const directDev = new Set(Object.keys(rootPkg.devDependencies || {}));

// ---- SPDX helpers ---------------------------------------------------------
const PERMISSIVE = new Set([
  "MIT", "MIT-0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "BSD-3-Clause-Clear", "0BSD", "Apache-2.0", "Zlib", "Unlicense", "CC0-1.0",
  "BlueOak-1.0.0", "Python-2.0", "PSF-2.0", "CC-BY-4.0", "CC-BY-3.0", "WTFPL", "X11", "BSD-1-Clause", "Artistic-2.0", "Unicode-3.0",
  "Unicode-DFS-2016", "MIT-CMU", "NCSA", "OFL-1.1", "JSON", "HPND", "ISC-Style", "Apache-1.1", "BSD*", "AFL-2.1", "AFL-3.0", "LicenseRef-MIT-Like",
]);
const WEAK = [/^MPL-/, /^LGPL-/, /^EPL-/, /^CDDL-/, /^CPL-/, /^OSL-/, /^EUPL-/, /^MS-RL/, /^Ms-RL/];
const STRONG = [/^GPL-/, /^AGPL-/, /^SSPL-/, /^GPL$/, /^AGPL$/];
const NONCOM = [/^CC-BY-NC/, /^CC-BY-ND/, /^BUSL-/, /^Elastic/, /^PolyForm/, /^Commons-Clause/, /^SEE LICENSE/i, /^Sustainable/, /^FSL-/, /^Confluent/, /^BSL/];

function normaliseId(s) {
  s = String(s).trim();
  const m = {
    "Apache 2.0": "Apache-2.0", "Apache2": "Apache-2.0", "Apache-2": "Apache-2.0", "Apache License 2.0": "Apache-2.0", "Apache License, Version 2.0": "Apache-2.0",
    "BSD": "BSD*", "MIT License": "MIT", "The MIT License": "MIT", "Simplified BSD": "BSD-2-Clause", "New BSD": "BSD-3-Clause",
    "GPL-2.0": "GPL-2.0-only", "GPL-3.0": "GPL-3.0-only", "LGPL-2.1": "LGPL-2.1-only", "LGPL-3.0": "LGPL-3.0-only", "AGPL-3.0": "AGPL-3.0-only",
  };
  return m[s] || s;
}
function classifyId(id) {
  const base = id.replace(/\+$/, "").replace(/-or-later$|-only$/, (x) => x);
  if (PERMISSIVE.has(id) || PERMISSIVE.has(base)) return "permissive";
  if (WEAK.some((r) => r.test(id))) return "weak-copyleft";
  if (STRONG.some((r) => r.test(id))) return "strong-copyleft";
  if (NONCOM.some((r) => r.test(id))) return "non-commercial/source-available";
  return "unknown/custom";
}
const RANK = { permissive: 0, "weak-copyleft": 1, "strong-copyleft": 2, "non-commercial/source-available": 3, "unknown/custom": 4 };
/** Parse an SPDX-ish expression. OR = licensee may pick (take best); AND = all apply (take worst). */
function classifyExpr(expr) {
  if (!expr) return { cls: "unknown/custom", dual: false, chosen: "" };
  let e = String(expr).trim();
  if (/^SEE LICENSE IN/i.test(e) || /^UNLICENSED$/i.test(e)) return { cls: "unknown/custom", dual: false, chosen: e };
  e = e.replace(/^\((.*)\)$/, "$1");
  // tokenise respecting parens (depth-1 only is enough for npm data; handle nesting recursively)
  function parse(s) {
    s = s.trim();
    // split on top-level OR
    const split = (str, kw) => {
      const parts = []; let depth = 0, cur = "";
      const toks = str.split(/(\s+|\(|\))/).filter((t) => t !== "");
      for (const t of toks) {
        if (t === "(") { depth++; cur += t; } else if (t === ")") { depth--; cur += t; }
        else if (depth === 0 && t === kw) { parts.push(cur.trim()); cur = ""; }
        else cur += t;
      }
      parts.push(cur.trim());
      return parts;
    };
    const ors = split(s, "OR");
    if (ors.length > 1) {
      const rs = ors.map(parse);
      rs.sort((a, b) => RANK[a.cls] - RANK[b.cls]);
      return { cls: rs[0].cls, dual: true, chosen: rs[0].chosen };
    }
    const ands = split(s, "AND");
    if (ands.length > 1) {
      const rs = ands.map(parse);
      rs.sort((a, b) => RANK[b.cls] - RANK[a.cls]);
      return { cls: rs[0].cls, dual: rs.some((r) => r.dual), chosen: rs.map((r) => r.chosen).join(" AND ") };
    }
    let t = s.replace(/^\((.*)\)$/, "$1");
    if (t !== s) return parse(t);
    const id = normaliseId(t.replace(/\s+WITH\s+.*/, ""));
    return { cls: classifyId(id), dual: false, chosen: id };
  }
  return parse(e);
}

// ---- licence-text fingerprinting -----------------------------------------
const FP = [
  ["Apache-2.0", /Apache License[\s\S]{0,80}Version 2\.0/i],
  ["AGPL-3.0", /GNU AFFERO GENERAL PUBLIC LICENSE/i],
  ["LGPL", /GNU (LESSER|LIBRARY) GENERAL PUBLIC LICENSE/i],
  ["GPL", /GNU GENERAL PUBLIC LICENSE/i],
  ["MPL-2.0", /Mozilla Public License[\s\S]{0,40}2\.0/i],
  ["EPL", /Eclipse Public License/i],
  ["CC-BY-4.0", /Creative Commons Attribution 4\.0/i],
  ["CC0-1.0", /CC0 1\.0 Universal|Creative Commons Zero/i],
  ["Unlicense", /This is free and unencumbered software released into the public domain/i],
  ["0BSD", /Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted\.(?![\s\S]{0,80}provided)/i],
  ["ISC", /Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted, provided/i],
  ["BSD-3-Clause", /Redistribution and use in source and binary forms[\s\S]{0,900}Neither the name/i],
  ["BSD-2-Clause", /Redistribution and use in source and binary forms/i],
  ["MIT", /Permission is hereby granted, free of charge, to any person obtaining a copy/i],
  ["Zlib", /This software is provided 'as-is', without any express or implied warranty/i],
  ["BlueOak-1.0.0", /Blue Oak Model License/i],
  ["Python-2.0", /PYTHON SOFTWARE FOUNDATION LICENSE/i],
  ["OFL-1.1", /SIL OPEN FONT LICENSE/i],
  ["JSON", /The Software shall be used for Good, not Evil/i],
  ["WTFPL", /DO WHAT THE FUCK YOU WANT/i],
  ["CC-BY-NC", /NonCommercial/],
  ["BUSL", /Business Source License/i],
  ["Commons-Clause", /Commons Clause/i],
  ["Elastic", /Elastic License/i],
  ["PolyForm", /PolyForm/i],
  ["Proprietary", /all rights reserved/i],
];
function fingerprint(text) {
  const hits = [];
  text = text.replace(/\s+/g, " ");
  for (const [id, re] of FP) if (re.test(text)) hits.push(id);
  // GPL fingerprint also hits LGPL/AGPL text; keep most specific
  // "All rights reserved" appears in copyright lines of permissive licences too: only meaningful alone.
  if (hits.length > 1) return hits.filter((h) => h !== "Proprietary");
  return hits;
}
const LIC_FILE = /^(licen[cs]e|licen[cs]e[-_.].*|copying|copying[-_.].*|unlicen[cs]e|notice|notice[-_.].*|patents)(\.(md|txt|markdown))?$/i;

function findDir(relPath, version) {
  const a = path.join(root, relPath);
  if (fs.existsSync(path.join(a, "package.json"))) return { dir: a, src: "worktree" };
  if (fallback) {
    const b = path.join(fallback, relPath.replace(/^node_modules\//, "node_modules/"));
    const bp = path.join(b, "package.json");
    if (fs.existsSync(bp)) {
      try { if (JSON.parse(fs.readFileSync(bp, "utf8")).version === version) return { dir: b, src: "fallback-tree" }; } catch {}
    }
  }
  return null;
}
const nameOf = (rel) => rel.split("node_modules/").pop();

let clientClosure = new Set(), clientDirect = {};
try {
  const t = JSON.parse(fs.readFileSync(path.join(outDir, "client-bundle-trace.json"), "utf8"));
  clientClosure = new Set(t.clientClosurePackages); clientDirect = t.directClientPackages;
} catch { console.warn("no client-bundle-trace.json; run client-bundle-trace.mjs first for the client column"); }
const rows = [];
for (const [rel, v] of Object.entries(lock.packages)) {
  if (!rel) continue;
  const name = v.name || nameOf(rel);
  const where = findDir(rel, v.version);
  let pj = null, files = [], texts = [], hasNotice = false, noticeFiles = [];
  if (where) {
    try { pj = JSON.parse(fs.readFileSync(path.join(where.dir, "package.json"), "utf8")); } catch {}
    try {
      files = fs.readdirSync(where.dir).filter((f) => LIC_FILE.test(f) && fs.statSync(path.join(where.dir, f)).isFile());
    } catch {}
    for (const f of files) {
      if (/^notice/i.test(f)) { hasNotice = true; noticeFiles.push(f); }
      if (/^(patents)/i.test(f)) continue;
      try { texts.push(fs.readFileSync(path.join(where.dir, f), "utf8").slice(0, 20000)); } catch {}
    }
  }
  let declared = "";
  if (pj) {
    if (typeof pj.license === "string") declared = pj.license;
    else if (pj.license && pj.license.type) declared = pj.license.type;
    else if (Array.isArray(pj.licenses)) declared = pj.licenses.map((l) => l.type || l).join(" OR ");
  }
  const lockLic = v.license ? (typeof v.license === "string" ? v.license : JSON.stringify(v.license)) : "";
  const fp = texts.length ? [...new Set(texts.flatMap(fingerprint))] : [];
  let effective = declared || lockLic;
  const textOnly = !effective && fp.length === 1 ? fp[0] : "";
  if (textOnly) effective = textOnly;
  const { cls, dual, chosen } = classifyExpr(effective);

  const flags = [];
  if (!where) flags.push("not-installed-locally(lock-only)");
  if (!declared && !lockLic) flags.push("NO-LICENCE-FIELD" + (textOnly ? `(classified from LICENSE text: ${textOnly})` : ""));
  else if (!effective) flags.push("NO-LICENCE-FIELD");
  if (/^SEE LICENSE IN/i.test(effective)) flags.push("see-license-in");
  if (dual) flags.push("dual/multi-licensed");
  if (declared && lockLic && declared !== lockLic) flags.push(`declared!=lock(${lockLic})`);
  if (where && !files.some((f) => !/^notice|^patents/i.test(f))) flags.push("no-LICENSE-file-shipped");
  if (where && fp.length) {
    // does the text agree with the declared id family?
    const famOf = (id) => id.replace(/-(only|or-later)$/, "").replace(/-[0-9.]+$/, "").replace(/^(BSD).*/, "BSD").replace(/^(GPL|LGPL|AGPL).*/, "$1").replace(/^CC-BY.*/, "CC-BY");
    const declFams = new Set(effective.replace(/[()]/g, " ").split(/\s+(?:OR|AND)\s+/).map((s) => famOf(normaliseId(s.trim().replace(/\s+WITH.*/, "")))));
    const textFams = new Set(fp.map(famOf));
    const overlap = [...textFams].some((t) => declFams.has(t));
    if (!overlap && cls === "permissive" && fp.some((x) => ["GPL", "LGPL", "AGPL-3.0", "CC-BY-NC", "BUSL", "Commons-Clause", "Elastic", "PolyForm", "Proprietary", "MPL-2.0", "EPL"].includes(x)))
      flags.push(`TEXT-DISAGREES(text looks like ${fp.join("+")})`);
    else if (!overlap) flags.push(`text-fingerprint-differs(${fp.join("+")})`);
  }
  if (hasNotice) flags.push("ships-NOTICE-file");
  if (/Apache-2\.0/.test(effective)) flags.push("apache-2.0");

  const scope = v.dev ? "dev" : v.devOptional ? "dev-optional" : v.optional ? "prod-optional" : "prod";
  rows.push({
    name, version: v.version, scope,
    direct: rel.split("node_modules/").length === 2 && (directProd.has(name) || directDev.has(name)) ? (directProd.has(name) ? "direct-prod" : "direct-dev") : "transitive",
    declared_license: declared, lock_license: lockLic, text_fingerprint: fp.join("+"),
    effective_license: effective, class: cls, dual: dual ? "yes" : "", chosen_option: chosen,
    license_files: files.join("|"), notice_files: noticeFiles.join("|"),
    source: where ? where.src : "lock-only", repository: (pj && (typeof pj.repository === "string" ? pj.repository : pj.repository?.url)) || "",
    client_bundle: scope === "dev" ? "no(dev)" : clientDirect[name] ? "direct-client-import" : clientClosure.has(name) ? "client-transitive" : "server/build-only",
    resolved: v.resolved || "", path: rel, flags: flags.join("; "),
  });
}
rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const cols = Object.keys(rows[0]);
const esc = (s) => { s = String(s ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "licence-inventory.csv"), [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n");
fs.writeFileSync(path.join(outDir, "licence-inventory.json"), JSON.stringify(rows, null, 1) + "\n");

const tally = {};
for (const r of rows) { const k = `${r.scope}|${r.class}`; tally[k] = (tally[k] || 0) + 1; }
console.log("packages:", rows.length);
console.log(tally);
console.log("lock-only (not inspected on disk):", rows.filter((r) => r.source === "lock-only").length);

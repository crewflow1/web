#!/usr/bin/env node
// Emits the markdown comparison tables from results/latest.json (+ stt-latest.json)
// for pasting into docs/ai/benchmark/REPORT.md. Deterministic; no model calls.
//
//   node scripts/benchmark/gen-report.mjs

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const R = join(__dirname, "results");

function load(f) {
  const p = join(R, f);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}
const num = (x, d = 2) => (x == null ? "—" : Number(x).toFixed(d));
const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);

// Thresholds for the per-workload recommendation.
function recommend(w) {
  if (w.errorRate >= 0.5) return "FAIL — KEEP HOSTED";
  const q = w.avgQuality;
  const fw = w.fallbackWorthyRate;
  const schemaOk = w.schemaComplianceRate == null || w.schemaComplianceRate >= 0.9;
  if (q >= 0.8 && fw <= 0.1 && schemaOk) return "PASS FOR LOCAL";
  if (q >= 0.6 && fw <= 0.35) return "PASS WITH HOSTED FALLBACK";
  return "FAIL — KEEP HOSTED";
}

const text = load("latest.json");
const stt = load("stt-latest.json");

let out = "";

if (text) {
  out += `_Source: results snapshot ${text.finishedAt || text.startedAt}. Host: ${text.host}. Repeats: ${text.repeats}._\n\n`;

  // Per (model × workload) master table
  out += `### Per model × workload\n\n`;
  out += `| Model | Licence | Workload | Tier→hosted | Quality | Schema | TTFT (ms) | Total (ms) | tok/s | RAM (MB) | Fallback-worthy | Rec |\n`;
  out += `|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const m of text.textModels) {
    for (const w of m.workloads) {
      out += `| ${m.model} | ${m.licence} | ${w.workload} | ${w.tier}→${w.productionModel} | ${num(w.avgQuality)} | ${w.schemaComplianceRate == null ? "n/a" : pct(w.schemaComplianceRate)} | ${num(w.medFirstTokenMs, 0)} | ${num(w.medTotalMs, 0)} | ${num(w.medTokensPerSec, 1)} | ${w.memoryMb ?? "—"} | ${pct(w.fallbackWorthyRate)} | ${recommend(w)} |\n`;
    }
  }

  // Per-workload best-model summary
  out += `\n### Best local model per workload\n\n`;
  out += `| Workload | Tier→hosted | Best local model | Quality | Schema | tok/s | Recommendation |\n`;
  out += `|---|---|---|---|---|---|---|\n`;
  const workloadNames = [...new Set(text.textModels.flatMap((m) => m.workloads.map((w) => w.workload)))];
  for (const wn of workloadNames) {
    let best = null;
    for (const m of text.textModels) {
      const w = m.workloads.find((x) => x.workload === wn);
      if (!w) continue;
      // prefer commercially-safe models when within 0.05 quality
      const score = w.avgQuality - (m.commercialSafe ? 0 : 0.05);
      if (!best || score > best.score) best = { m, w, score };
    }
    if (best)
      out += `| ${wn} | ${best.w.tier}→${best.w.productionModel} | ${best.m.model} (${best.m.licence}) | ${num(best.w.avgQuality)} | ${best.w.schemaComplianceRate == null ? "n/a" : pct(best.w.schemaComplianceRate)} | ${num(best.w.medTokensPerSec, 1)} | ${recommend(best.w)} |\n`;
  }

  // Embeddings
  if (text.embeddings?.length) {
    out += `\n### Embeddings — retrieval quality (synthetic corpus, k=3)\n\n`;
    out += `| Model | Licence | Dim | P@3 | Recall@3 | MRR | Mean first-rel rank | ms/text | RAM (MB) |\n`;
    out += `|---|---|---|---|---|---|---|---|---|\n`;
    for (const e of text.embeddings) {
      if (e.error) {
        out += `| ${e.model} | — | — | error: ${e.error} | | | | | |\n`;
        continue;
      }
      const mt = e.metrics;
      out += `| ${e.model} | ${e.licence} | ${e.dimension} | ${num(mt.precisionAtK)} | ${num(mt.recallAtK)} | ${num(mt.mrr)} | ${num(mt.meanFirstRelevantRank)} | ${num(e.perTextMs, 1)} | ${e.memoryMb ?? "—"} |\n`;
    }
    const b = text.embeddings[0]?.baseline;
    if (b)
      out += `| **${b.provider}/${b.model}** (production, NOT run) | — | ${b.dimension} | not measured — hosted; see note | | | | | |\n`;
  }

  if (text.notRun?.length) {
    out += `\n### Not run here\n\n`;
    for (const n of text.notRun) out += `- \`${n.model}\`: ${n.reason}\n`;
  }
}

if (stt) {
  out += `\n### Speech-to-text (whisper.cpp, synthetic voice notes)\n\n`;
  out += `| Model | Licence | Avg WER | Median real-time factor | Notes |\n`;
  out += `|---|---|---|---|---|\n`;
  for (const m of stt.models || []) {
    out += `| ${m.model} | ${m.licence} | ${num(m.avgWer, 3)} | ${m.medRealtimeFactor ?? "—"}x | lower WER better; RTF>1 = faster than real time |\n`;
  }
  if (stt.notRun?.length)
    for (const n of stt.notRun) out += `| ${n.model || "whisper"} | — | — | — | not run: ${n.reason} |\n`;
  const b = stt.productionBaseline;
  if (b) out += `| **${b.provider}/${b.model}** (production, NOT run) | — | not measured | — | hosted baseline |\n`;
}

console.log(out);

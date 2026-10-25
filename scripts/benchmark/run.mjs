#!/usr/bin/env node
// CrewFlow LOCAL AI benchmark harness — RESEARCH ONLY.
//
// Runs local Ollama models against synthetic, anonymised CrewFlow-shaped
// fixtures across 10 text/JSON workloads + an embedding retrieval workload,
// records quality / schema-compliance / latency / tokens-per-sec / memory /
// fallback-worthy-failure, and emits results JSON for the report.
//
// NO production connection. NO real data. NO hosted API is called (the
// production Claude/OpenAI baseline is referenced for comparison only).
//
// Usage:
//   node scripts/benchmark/run.mjs                 # full run, all models
//   node scripts/benchmark/run.mjs --models phi4-mini,qwen3:4b
//   node scripts/benchmark/run.mjs --workloads 03-invoice-extraction
//   node scripts/benchmark/run.mjs --repeats 3     # latency repeats (median)
//   node scripts/benchmark/run.mjs --dry-run       # no Ollama; validate fixtures

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TEXT_MODELS, EMBED_MODELS, productionModelForTier } from "./config.mjs";
import { isUp, listModels, chat, embed, psMemory, ollamaHost } from "./lib/ollama.mjs";
import { scoreText, scoreJson, retrievalMetrics } from "./lib/score.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "fixtures");
const SCHEMA_DIR = join(__dirname, "schemas");
const RESULTS_DIR = join(__dirname, "results");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const DRY = process.argv.includes("--dry-run");
const REPEATS = Number(arg("repeats", 1));
const MODEL_FILTER = arg("models") ? String(arg("models")).split(",") : null;
const WORKLOAD_FILTER = arg("workloads") ? String(arg("workloads")).split(",") : null;

function median(xs) {
  const a = xs.filter((x) => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const mb = (bytes) => (bytes == null ? null : Math.round(bytes / 1048576));

function loadFixtures() {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ file: f, data: JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) }))
    .filter((x) => !WORKLOAD_FILTER || WORKLOAD_FILTER.some((w) => x.file.includes(w)));
}

async function runTextWorkload(model, fixture) {
  const { data } = fixture;
  const itemResults = [];
  for (const item of data.items) {
    const attempts = [];
    let lastOut = "";
    let lastScore = null;
    let error = null;
    for (let r = 0; r < REPEATS; r++) {
      try {
        const res = await chat({ model: model.id, system: data.system, prompt: item.input });
        lastOut = res.text;
        attempts.push(res);
      } catch (e) {
        error = e.message;
        break;
      }
    }
    if (!error) {
      lastScore =
        data.mode === "json"
          ? scoreJson(lastOut, loadSchema(data.schema), item.expected)
          : scoreText(lastOut, item.rubric);
    }
    itemResults.push({
      id: item.id,
      error,
      firstTokenMs: median(attempts.map((a) => a.firstTokenMs)),
      totalMs: median(attempts.map((a) => a.totalMs)),
      tokensPerSec: median(attempts.map((a) => a.tokensPerSec)),
      outputTokens: attempts.at(-1)?.outputTokens ?? null,
      score: lastScore,
      sample: lastOut.slice(0, 280),
    });
  }
  const mem = await psMemory(model.id);
  const ok = itemResults.filter((r) => !r.error && r.score);
  return {
    workload: data.workload,
    mode: data.mode,
    tier: data.tier,
    productionModel: productionModelForTier(data.tier),
    memoryMb: mb(mem?.sizeBytes),
    vramMb: mb(mem?.sizeVramBytes),
    avgQuality: ok.length ? avg(ok.map((r) => r.score.quality)) : 0,
    schemaComplianceRate:
      data.mode === "json" && ok.length
        ? avg(ok.map((r) => (r.score.schemaValid ? 1 : 0)))
        : null,
    medFirstTokenMs: median(itemResults.map((r) => r.firstTokenMs)),
    medTotalMs: median(itemResults.map((r) => r.totalMs)),
    medTokensPerSec: median(itemResults.map((r) => r.tokensPerSec)),
    fallbackWorthyRate: itemResults.length
      ? avg(itemResults.map((r) => (r.error || r.score?.fallbackWorthy ? 1 : 0)))
      : 1,
    errorRate: avg(itemResults.map((r) => (r.error ? 1 : 0))),
    items: itemResults,
  };
}

const schemaCache = {};
function loadSchema(name) {
  if (!name) return null;
  if (!schemaCache[name])
    schemaCache[name] = JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8"));
  return schemaCache[name];
}
const avg = (xs) => (xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)) : 0);

async function runEmbeddings(fixtures) {
  const emb = fixtures.find((f) => f.data.workload === "embeddings");
  if (!emb) return [];
  const { corpus, queries, productionBaseline } = emb.data;
  const results = [];
  for (const model of EMBED_MODELS) {
    if (MODEL_FILTER && !MODEL_FILTER.includes(model.id)) continue;
    try {
      const corpusEmb = await embed({ model: model.id, input: corpus.map((c) => c.text) });
      const queryEmb = await embed({ model: model.id, input: queries.map((q) => q.text) });
      const metrics = retrievalMetrics({
        queries,
        queryVecs: queryEmb.vectors,
        corpusIds: corpus.map((c) => c.id),
        corpusVecs: corpusEmb.vectors,
        k: 3,
      });
      const mem = await psMemory(model.id);
      results.push({
        model: model.id,
        label: model.label,
        licence: model.licence,
        commercialSafe: model.commercialSafe,
        dimension: corpusEmb.dimension,
        corpusEmbedMs: Math.round(corpusEmb.ms),
        perTextMs: Number((corpusEmb.ms / corpus.length).toFixed(1)),
        memoryMb: mb(mem?.sizeBytes),
        metrics,
        baseline: productionBaseline,
      });
    } catch (e) {
      results.push({ model: model.id, error: e.message });
    }
  }
  return results;
}

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fixtures = loadFixtures();
  // transcription is handled by run-stt.mjs; embeddings handled separately below.
  const textFixtures = fixtures.filter(
    (f) => f.data.workload !== "embeddings" && f.data.workload !== "transcription"
  );

  const up = DRY ? false : await isUp();
  const installed = up ? await listModels() : [];
  console.log(`Ollama host: ${ollamaHost()}  up=${up}  installed=${installed.length}`);

  const run = {
    startedAt: new Date().toISOString(),
    host: ollamaHost(),
    ollamaUp: up,
    repeats: REPEATS,
    installedModels: installed,
    environment: {
      note: "Benchmarked on Moe's Mac (local dev machine) — NOT production infrastructure.",
    },
    textModels: [],
    embeddings: [],
    notRun: [],
  };

  const normInstalled = (id) =>
    installed.includes(id) || installed.includes(`${id}:latest`) || installed.some((m) => m.startsWith(id + ":"));

  for (const model of TEXT_MODELS) {
    if (MODEL_FILTER && !MODEL_FILTER.includes(model.id)) continue;
    if (DRY || !up || !normInstalled(model.id)) {
      run.notRun.push({ model: model.id, reason: DRY ? "dry-run" : !up ? "ollama not running" : "model not installed (requires local execution)" });
      continue;
    }
    console.log(`\n== ${model.label} (${model.id}) ==`);
    const workloads = [];
    for (const fx of textFixtures) {
      process.stdout.write(`  ${fx.data.workload} ... `);
      const wr = await runTextWorkload(model, fx);
      workloads.push(wr);
      console.log(
        `q=${wr.avgQuality} tok/s=${wr.medTokensPerSec?.toFixed(1) ?? "-"} ttft=${wr.medFirstTokenMs?.toFixed(0) ?? "-"}ms fw=${(wr.fallbackWorthyRate * 100).toFixed(0)}%`
      );
    }
    run.textModels.push({
      model: model.id,
      label: model.label,
      params: model.params,
      licence: model.licence,
      commercialSafe: model.commercialSafe,
      notes: model.notes,
      workloads,
    });
  }

  if (!DRY && up) run.embeddings = await runEmbeddings(fixtures);
  else for (const m of EMBED_MODELS) run.notRun.push({ model: m.id, reason: DRY ? "dry-run" : "ollama not running" });

  run.finishedAt = new Date().toISOString();
  const outPath = join(RESULTS_DIR, "latest.json");
  writeFileSync(outPath, JSON.stringify(run, null, 2));
  console.log(`\nResults written: ${outPath}`);
  console.log(`Fixtures: ${fixtures.length} files. Text models run: ${run.textModels.length}. Embedding models run: ${run.embeddings.length}. Not run: ${run.notRun.length}.`);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});

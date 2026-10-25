#!/usr/bin/env node
// STT benchmark — drives whisper.cpp (whisper-cli) over synthetic audio.
// RESEARCH ONLY. Audio is TTS-generated (macOS `say`), no real voice/data.
//
// Measures per model: word error rate (WER) vs the reference transcript,
// transcription wall-time, and real-time factor (audio_seconds / wall_seconds).
//
// Usage:
//   bash scripts/benchmark/gen-audio.sh      # once, to make audio/*.wav
//   node scripts/benchmark/run-stt.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIO = join(__dirname, "audio");
const MODELS_DIR = join(__dirname, "models");
const RESULTS_DIR = join(__dirname, "results");

const WHISPER_BIN = process.env.WHISPER_BIN || "whisper-cli";
const MODELS = [
  { id: "whisper.cpp tiny.en", file: "ggml-tiny.en.bin" },
  { id: "whisper.cpp base.en", file: "ggml-base.en.bin" },
];

function normalise(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Levenshtein over word tokens → WER.
function wer(ref, hyp) {
  const r = normalise(ref).split(" ");
  const h = normalise(hyp).split(" ");
  const dp = Array.from({ length: r.length + 1 }, () => new Array(h.length + 1).fill(0));
  for (let i = 0; i <= r.length; i++) dp[i][0] = i;
  for (let j = 0; j <= h.length; j++) dp[0][j] = j;
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      dp[i][j] =
        r[i - 1] === h[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return { wer: dp[r.length][h.length] / r.length, refWords: r.length };
}

function audioSeconds(wav) {
  try {
    const out = execFileSync("afinfo", [wav], { encoding: "utf8" });
    const m = out.match(/estimated duration:\s*([\d.]+)/i);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function transcribe(modelPath, wav) {
  const started = performance.now();
  // -nt = no timestamps, -np = no progress prints; text goes to stdout
  const out = execFileSync(
    WHISPER_BIN,
    ["-m", modelPath, "-f", wav, "-nt", "-np", "-l", "en"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  );
  return { text: out.trim(), ms: performance.now() - started };
}

function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fx = JSON.parse(readFileSync(join(__dirname, "fixtures", "12-stt-transcripts.json"), "utf8"));
  const run = {
    startedAt: new Date().toISOString(),
    productionBaseline: fx.productionBaseline,
    whisperBin: WHISPER_BIN,
    models: [],
    notRun: [],
  };

  let binOk = true;
  try {
    execFileSync(WHISPER_BIN, ["--help"], { stdio: "ignore" });
  } catch {
    binOk = false;
  }
  if (!binOk) {
    run.notRun.push({ reason: "whisper-cli not found (requires local execution)" });
    finish(run);
    return;
  }

  for (const model of MODELS) {
    const modelPath = join(MODELS_DIR, model.file);
    if (!existsSync(modelPath)) {
      run.notRun.push({ model: model.id, reason: `model file missing: ${model.file}` });
      continue;
    }
    const items = [];
    for (const it of fx.items) {
      const wav = join(AUDIO, `${it.id}.wav`);
      if (!existsSync(wav)) {
        items.push({ id: it.id, error: "audio missing (run gen-audio.sh)" });
        continue;
      }
      try {
        const { text, ms } = transcribe(modelPath, wav);
        const w = wer(it.reference, text);
        const audioSec = audioSeconds(wav);
        items.push({
          id: it.id,
          wer: Number(w.wer.toFixed(3)),
          refWords: w.refWords,
          wallMs: Math.round(ms),
          audioSec,
          realtimeFactor: audioSec ? Number((audioSec / (ms / 1000)).toFixed(2)) : null,
          hypothesis: text.slice(0, 200),
        });
      } catch (e) {
        items.push({ id: it.id, error: e.message.slice(0, 160) });
      }
    }
    const ok = items.filter((i) => i.wer != null);
    run.models.push({
      model: model.id,
      file: model.file,
      licence: "MIT (whisper.cpp) + MIT (OpenAI Whisper weights)",
      avgWer: ok.length ? Number((ok.reduce((a, b) => a + b.wer, 0) / ok.length).toFixed(3)) : null,
      medRealtimeFactor: ok.length
        ? ok.map((i) => i.realtimeFactor).sort((a, b) => a - b)[Math.floor(ok.length / 2)]
        : null,
      items,
    });
  }
  finish(run);
}

function finish(run) {
  run.finishedAt = new Date().toISOString();
  const out = join(RESULTS_DIR, "stt-latest.json");
  writeFileSync(out, JSON.stringify(run, null, 2));
  console.log("STT results:", out);
  for (const m of run.models) console.log(`  ${m.model}: avgWER=${m.avgWer} rtf=${m.medRealtimeFactor}x`);
  if (run.notRun.length) console.log("  not run:", JSON.stringify(run.notRun));
}

main();

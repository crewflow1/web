// Minimal Ollama HTTP client for the benchmark harness.
// Research-only. Talks to a LOCAL Ollama instance (default 127.0.0.1:11434).
// No external network, no production connection.

const HOST = process.env.OLLAMA_HOST?.startsWith("http")
  ? process.env.OLLAMA_HOST
  : `http://${process.env.OLLAMA_HOST || "127.0.0.1:11434"}`;

export function ollamaHost() {
  return HOST;
}

export async function isUp() {
  try {
    const r = await fetch(`${HOST}/api/version`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function listModels() {
  try {
    const r = await fetch(`${HOST}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.models || []).map((m) => m.name);
  } catch {
    return [];
  }
}

// Returns loaded-model memory footprint (bytes) as reported by Ollama, if loaded.
export async function psMemory(model) {
  try {
    const r = await fetch(`${HOST}/api/ps`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = await r.json();
    const entry = (j.models || []).find((m) => m.name === model || m.model === model);
    if (!entry) return null;
    return { sizeBytes: entry.size ?? null, sizeVramBytes: entry.size_vram ?? null };
  } catch {
    return null;
  }
}

/**
 * Streamed chat completion with timing instrumentation.
 * Measures real wall-clock time-to-first-token plus Ollama's own eval metrics.
 */
export async function chat({ model, system, prompt, options = {}, timeoutMs = 120000 }) {
  const body = {
    model,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: prompt },
    ],
    stream: true,
    // num_predict caps output length so a verbose model cannot run away:
    // production always bounds output, and uncapped generation makes
    // latency / tokens-per-sec incomparable across models. 768 is ample for
    // our <=220-word text outputs and the invoice JSON.
    options: { temperature: 0.2, num_predict: 768, ...options },
  };

  const started = performance.now();
  let firstTokenAt = null;
  let text = "";
  let metrics = {};

  const res = await fetch(`${HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => "");
    throw new Error(`ollama chat HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const piece = obj.message?.content ?? "";
      if (piece) {
        if (firstTokenAt === null) firstTokenAt = performance.now();
        text += piece;
      }
      if (obj.done) {
        metrics = {
          totalDurationMs: (obj.total_duration ?? 0) / 1e6,
          loadDurationMs: (obj.load_duration ?? 0) / 1e6,
          promptEvalCount: obj.prompt_eval_count ?? 0,
          promptEvalDurationMs: (obj.prompt_eval_duration ?? 0) / 1e6,
          evalCount: obj.eval_count ?? 0,
          evalDurationMs: (obj.eval_duration ?? 0) / 1e6,
        };
      }
    }
  }

  const ended = performance.now();
  const tokensPerSec =
    metrics.evalCount && metrics.evalDurationMs
      ? metrics.evalCount / (metrics.evalDurationMs / 1000)
      : null;

  return {
    text,
    firstTokenMs: firstTokenAt !== null ? firstTokenAt - started : null,
    totalMs: ended - started,
    tokensPerSec,
    outputTokens: metrics.evalCount || null,
    promptTokens: metrics.promptEvalCount || null,
    raw: metrics,
  };
}

export async function embed({ model, input, timeoutMs = 60000 }) {
  const started = performance.now();
  const res = await fetch(`${HOST}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`ollama embed HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const j = await res.json();
  const vectors = j.embeddings || (j.embedding ? [j.embedding] : []);
  return { vectors, ms: performance.now() - started, dimension: vectors[0]?.length ?? 0 };
}

// Benchmark configuration: model registry + production baseline mapping.
// Licence notes are from each model's public model card as of 2026-10.
// commercialSafe=false means DO NOT ship to production without a licence review.

export const TEXT_MODELS = [
  {
    id: "phi4-mini",
    label: "Phi-4-mini (3.8B)",
    params: "3.8B",
    licence: "MIT",
    commercialSafe: true,
    notes: "Microsoft. MIT is clean for commercial use.",
  },
  {
    id: "phi3.5",
    label: "Phi-3.5-mini (3.8B)",
    params: "3.8B",
    licence: "MIT",
    commercialSafe: true,
    notes: "Microsoft. Fallback if phi4-mini unavailable.",
  },
  {
    id: "qwen3:4b",
    label: "Qwen3 4B",
    params: "4B",
    licence: "Apache-2.0",
    commercialSafe: true,
    notes: "Alibaba. Qwen3 line is Apache-2.0.",
  },
  {
    id: "qwen2.5:3b",
    label: "Qwen2.5 3B",
    params: "3B",
    licence: "Qwen Research License (NOT Apache)",
    commercialSafe: false,
    notes:
      "Qwen2.5 3B & 72B ship under the Qwen licence, not Apache-2.0 (unlike the other Qwen2.5 sizes). Commercial use is permitted under conditions but it is NOT a clean MIT/Apache grant — flag for legal review before production. Benchmarked for reference only.",
  },
];

export const EMBED_MODELS = [
  {
    id: "nomic-embed-text",
    label: "nomic-embed-text v1.5",
    licence: "Apache-2.0",
    commercialSafe: true,
    mtebNote:
      "MTEB English avg ~62 (public leaderboard, 2024-25). 768-d. Long-context (8k) capable.",
  },
  {
    id: "bge-m3",
    label: "BGE-M3",
    licence: "MIT",
    commercialSafe: true,
    mtebNote:
      "BAAI. Strong multilingual retrieval; MTEB-reputable. 1024-d dense (also sparse/colbert modes, unused here).",
  },
];

// Production baseline this benchmark is implicitly compared against.
// These are NOT called by the harness.
export const PRODUCTION = {
  text: {
    cheap: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
    mid: { provider: "anthropic", model: "claude-sonnet-5" },
    high: { provider: "anthropic", model: "claude-opus-5" },
  },
  embedding: { provider: "openai", model: "text-embedding-3-small", dimension: 1536 },
  transcription: { provider: "openai", model: "whisper-1" },
};

// Map a workload's declared tier to the production model it would otherwise hit.
export function productionModelForTier(tier) {
  return PRODUCTION.text[tier]?.model ?? "(unmapped)";
}

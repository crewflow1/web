import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { textCostUsd } from "@/lib/ai/text/cost";
import { getTextProvider, isTextConfigured } from "@/lib/ai/text";
import { createAnthropicTextProvider } from "@/lib/ai/text/anthropic";
import { createOpenAiTextProvider } from "@/lib/ai/text/openai";

/**
 * Shared Memory — text-generation provider abstraction (Volume X §9/§11; CEO
 * Directive 009 Module 1, PR5c).
 *
 * The CEO's "plug-in, never a dependency" rule lives on two seams, both proven
 * here WITHOUT a database or a live API — exactly as the embedding seam is:
 *   - the FACTORY returns `null` when nothing is configured (graceful
 *     degradation — LLM-assisted reducers off, every other lifecycle reducer
 *     unaffected);
 *   - the PROVIDER throws on a vendor failure (so the worker, not the provider,
 *     owns skip / retry / backoff).
 * Plus the pure cost helper that makes every AI action measurable.
 */

// Both SDKs are dynamically imported by the providers; mock them so generate()
// is deterministic and never touches the network.
const { anthropicCreate, openaiCreate } = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  openaiCreate: vi.fn(),
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: anthropicCreate },
  })),
}));
vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: openaiCreate } },
  })),
}));

// =====================================================================
// 1. Cost — observability, never a correctness gate
// =====================================================================

describe("textCostUsd — provider pricing metadata, input/output split", () => {
  it("prices the Version-1 model (claude-haiku-4-5 @ $1/$5 per Mtok)", () => {
    expect(
      textCostUsd({ provider: "anthropic", model: "claude-haiku-4-5" }, { inputTokens: 1_000_000, outputTokens: 0 }),
    ).toBeCloseTo(1, 10);
    expect(
      textCostUsd({ provider: "anthropic", model: "claude-haiku-4-5" }, { inputTokens: 0, outputTokens: 1_000_000 }),
    ).toBeCloseTo(5, 10);
    expect(
      textCostUsd({ provider: "anthropic", model: "claude-haiku-4-5" }, { inputTokens: 500_000, outputTokens: 200_000 }),
    ).toBeCloseTo(0.5 + 1, 10);
  });

  it("prices the OpenAI fallback (gpt-4o-mini @ $0.15/$0.60 per Mtok)", () => {
    expect(
      textCostUsd({ provider: "openai", model: "gpt-4o-mini" }, { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBeCloseTo(0.75, 10);
  });

  it("returns null for an unknown model — cost unknown, never blocks generation", () => {
    expect(
      textCostUsd({ provider: "acme", model: "mystery-llm" }, { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBeNull();
  });

  it("is zero for zero tokens on a known model", () => {
    expect(
      textCostUsd({ provider: "anthropic", model: "claude-haiku-4-5" }, { inputTokens: 0, outputTokens: 0 }),
    ).toBe(0);
  });
});

// =====================================================================
// 2. Factory — the graceful-degradation seam (configuration only)
// =====================================================================

describe("getTextProvider — null when unconfigured, provider when configured", () => {
  const ENV = ["MEMORY_TEXT_PROVIDER", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.clearAllMocks();
  });

  it("returns null when no provider key is set (graceful degradation)", () => {
    expect(getTextProvider()).toBeNull();
    expect(isTextConfigured()).toBe(false);
  });

  it("auto-prefers Anthropic when its key is present", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const p = getTextProvider();
    expect(p?.info.provider).toBe("anthropic");
    expect(p?.info.model).toBe("claude-haiku-4-5");
    expect(isTextConfigured()).toBe(true);
  });

  it("auto-falls back to OpenAI when only its key is present", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const p = getTextProvider();
    expect(p?.info.provider).toBe("openai");
    expect(p?.info.model).toBe("gpt-4o-mini");
  });

  it("auto prefers Anthropic over OpenAI when BOTH keys are present", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-test";
    expect(getTextProvider()?.info.provider).toBe("anthropic");
  });

  it("honours an explicit provider name, case/space-insensitively", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.MEMORY_TEXT_PROVIDER = "  OpenAI  ";
    expect(getTextProvider()?.info.provider).toBe("openai");
  });

  it("returns null for a named provider whose key is missing", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.MEMORY_TEXT_PROVIDER = "anthropic"; // no anthropic key
    expect(getTextProvider()).toBeNull();
  });

  it("treats none/off/disabled/empty as explicitly off, even with a key set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    for (const off of ["none", "off", "disabled", ""]) {
      process.env.MEMORY_TEXT_PROVIDER = off;
      expect(getTextProvider()).toBeNull();
    }
  });

  it("degrades (null) on an unknown provider name — never throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.MEMORY_TEXT_PROVIDER = "totally-made-up";
    expect(() => getTextProvider()).not.toThrow();
    expect(getTextProvider()).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// =====================================================================
// 3. Anthropic provider.generate() — mocked SDK, deterministic
// =====================================================================

describe("Anthropic provider.generate — text, tokens, options, failure", () => {
  const provider = createAnthropicTextProvider("sk-ant-test");

  afterEach(() => vi.clearAllMocks());

  it("returns an empty result for a blank prompt WITHOUT touching the network", async () => {
    const out = await provider.generate("   ");
    expect(out).toEqual({ text: "", model: "claude-haiku-4-5", inputTokens: 0, outputTokens: 0 });
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  it("concatenates text blocks, trims, and reports billed tokens", async () => {
    anthropicCreate.mockResolvedValue({
      model: "claude-haiku-4-5",
      content: [
        { type: "text", text: "A short " },
        { type: "text", text: "summary.  " },
      ],
      usage: { input_tokens: 120, output_tokens: 8 },
    });
    const out = await provider.generate("summarise this");
    expect(out.text).toBe("A short summary.");
    expect(out.inputTokens).toBe(120);
    expect(out.outputTokens).toBe(8);
  });

  it("forwards system, maxTokens, temperature and the abort signal", async () => {
    anthropicCreate.mockResolvedValue({
      model: "claude-haiku-4-5",
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const ctrl = new AbortController();
    await provider.generate("p", { system: "be terse", maxTokens: 256, temperature: 0.2, signal: ctrl.signal });
    expect(anthropicCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-haiku-4-5",
        max_tokens: 256,
        temperature: 0.2,
        system: "be terse",
        messages: [{ role: "user", content: "p" }],
      }),
      expect.objectContaining({ signal: ctrl.signal }),
    );
  });

  it("propagates a rate-limit error (the worker, not the provider, retries)", async () => {
    anthropicCreate.mockRejectedValue(new Error("429 Too Many Requests"));
    await expect(provider.generate("x")).rejects.toThrow(/429/);
  });
});

// =====================================================================
// 4. OpenAI provider.generate() — mocked SDK, deterministic
// =====================================================================

describe("OpenAI provider.generate — text, tokens, options, failure", () => {
  const provider = createOpenAiTextProvider("sk-test");

  afterEach(() => vi.clearAllMocks());

  it("returns an empty result for a blank prompt WITHOUT touching the network", async () => {
    const out = await provider.generate("");
    expect(out).toEqual({ text: "", model: "gpt-4o-mini", inputTokens: 0, outputTokens: 0 });
    expect(openaiCreate).not.toHaveBeenCalled();
  });

  it("returns the trimmed message content and billed tokens", async () => {
    openaiCreate.mockResolvedValue({
      model: "gpt-4o-mini",
      choices: [{ message: { content: "  A short summary.  " } }],
      usage: { prompt_tokens: 100, completion_tokens: 6 },
    });
    const out = await provider.generate("summarise this");
    expect(out.text).toBe("A short summary.");
    expect(out.inputTokens).toBe(100);
    expect(out.outputTokens).toBe(6);
  });

  it("prepends the system message and forwards the abort signal", async () => {
    openaiCreate.mockResolvedValue({
      model: "gpt-4o-mini",
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const ctrl = new AbortController();
    await provider.generate("p", { system: "be terse", maxTokens: 256, signal: ctrl.signal });
    expect(openaiCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o-mini",
        max_tokens: 256,
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "p" },
        ],
      }),
      expect.objectContaining({ signal: ctrl.signal }),
    );
  });

  it("handles a null/empty completion as empty text (no throw)", async () => {
    openaiCreate.mockResolvedValue({
      model: "gpt-4o-mini",
      choices: [{ message: { content: null } }],
      usage: { prompt_tokens: 5, completion_tokens: 0 },
    });
    const out = await provider.generate("x");
    expect(out.text).toBe("");
    expect(out.inputTokens).toBe(5);
  });

  it("propagates an invalid-API-key error (no silent swallow)", async () => {
    openaiCreate.mockRejectedValue(new Error("401 Incorrect API key provided"));
    await expect(provider.generate("x")).rejects.toThrow(/401/);
  });
});

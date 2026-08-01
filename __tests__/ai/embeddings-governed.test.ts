import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * THE GOVERNED EMBEDDING DOOR — unit proof of lib/ai/embeddings/governed.ts.
 *
 * `governedEmbed` is the ONE call path a paid embedding may take, and it holds
 * two promises at once that this file pins independently:
 *
 *   1. PAID providers go through `invokeWithGovernor` under the `embedding`
 *      task class — the wrapper's arguments (feature key, class, org, the
 *      NUL-joined dedupe identity) are the contract the reservation SQL bills
 *      against, so each is asserted by value.
 *   2. The DETERMINISTIC provider is exempt BY THE PROVIDER'S OWN TAG — it runs
 *      as a direct call (`governed: false`) and the governor is never invoked.
 *      A caller cannot opt into the exemption.
 *
 * The governor itself is mocked here (its refusal/dedupe/dark behaviour has its
 * own suites); this file proves the DOOR maps outcomes without loss: blocked and
 * duplicate become `refused` with the reason preserved, a provider throw becomes
 * `unavailable` with the message, and nothing — not even the deterministic
 * provider — is called for an empty batch.
 */

const { getProviderMock, embedMock, invokeMock } = vi.hoisted(() => ({
  getProviderMock: vi.fn(),
  embedMock: vi.fn(),
  invokeMock: vi.fn(),
}));

vi.mock("@/lib/ai/embeddings", () => ({
  getEmbeddingProvider: getProviderMock,
}));
vi.mock("@/lib/ai/governor", () => ({
  invokeWithGovernor: invokeMock,
}));

import { governedEmbed } from "@/lib/ai/embeddings/governed";

const ORG = "00000000-0000-4000-8000-0000000000cf";
const NUL = String.fromCharCode(0);

function vec(dim: number, mark = 0.1): number[] {
  return Array.from({ length: dim }, () => mark);
}

function setProvider(provider: string, model = "text-embedding-3-small"): void {
  getProviderMock.mockReturnValue({
    info: { provider, model, dimension: 4, version: `${provider}:${model}:d4:v1` },
    embed: embedMock,
  });
}

/** Make the governor run the caller's fn and report a live (non-dark) run. */
function governorRuns(): void {
  invokeMock.mockImplementation(
    async (_feature: string, _cls: string, fn: () => Promise<{ value: unknown }>) => {
      const call = await fn();
      return { status: "ran", value: call.value, budget: "allowed", recorded: true, dark: false };
    },
  );
}

beforeEach(() => {
  getProviderMock.mockReset();
  embedMock.mockReset();
  invokeMock.mockReset();
});

// =====================================================================
// No provider / empty input — nothing is called, ever
// =====================================================================

describe("governedEmbed — degenerate inputs never reach a network or a ledger", () => {
  it("no provider → unavailable; the governor is never consulted", async () => {
    getProviderMock.mockReturnValue(null);
    const out = await governedEmbed({ texts: ["a"], feature: "memory.embedding_query", orgId: ORG });
    expect(out.status).toBe("unavailable");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(embedMock).not.toHaveBeenCalled();
  });

  it("empty texts → embedded [] with zero tokens; NEITHER the provider NOR the governor runs", async () => {
    for (const provider of ["openai", "deterministic"]) {
      setProvider(provider);
      const out = await governedEmbed({
        texts: [],
        feature: "memory.embedding_write",
        orgId: ORG,
      });
      expect(out.status).toBe("embedded");
      if (out.status === "embedded") {
        expect(out.vectors).toEqual([]);
        expect(out.tokens).toBe(0);
      }
    }
    expect(embedMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

// =====================================================================
// The deterministic exemption — direct call, governor untouched
// =====================================================================

describe("governedEmbed — the deterministic exemption is the provider's tag, not a caller choice", () => {
  it("deterministic provider embeds DIRECTLY: governor never invoked, governed:false", async () => {
    setProvider("deterministic", "hash-v1");
    embedMock.mockResolvedValue({ vectors: [vec(4)], model: "hash-v1", dimension: 4, tokens: 3 });

    const out = await governedEmbed({
      texts: ["hello"],
      feature: "memory.embedding_write",
      orgId: ORG,
    });

    expect(out.status).toBe("embedded");
    if (out.status === "embedded") {
      expect(out.governed).toBe(false);
      expect(out.vectors).toEqual([vec(4)]);
      expect(out.tokens).toBe(3);
    }
    // THE exemption pin: zero governor contact for zero-cost compute.
    expect(invokeMock).not.toHaveBeenCalled();
    expect(embedMock).toHaveBeenCalledWith(["hello"], undefined);
  });

  it("forwards the abort signal on the exempt path too", async () => {
    setProvider("deterministic", "hash-v1");
    embedMock.mockResolvedValue({ vectors: [vec(4)], model: "hash-v1", dimension: 4, tokens: 3 });
    const ctrl = new AbortController();

    await governedEmbed({
      texts: ["x"],
      feature: "memory.embedding_query",
      orgId: ORG,
      signal: ctrl.signal,
    });

    expect(embedMock).toHaveBeenCalledWith(["x"], { signal: ctrl.signal });
  });
});

// =====================================================================
// The paid path — through the governor, with the exact contract
// =====================================================================

describe("governedEmbed — a paid provider spends ONLY through invokeWithGovernor", () => {
  it("passes the feature key, the 'embedding' task class, org/user, and the NUL-joined dedupe identity", async () => {
    setProvider("openai");
    governorRuns();
    embedMock.mockResolvedValue({
      vectors: [vec(4, 0.1), vec(4, 0.2)],
      model: "text-embedding-3-small",
      dimension: 4,
      tokens: 12,
    });

    const out = await governedEmbed({
      texts: ["alpha", "beta"],
      feature: "memory.embedding_write",
      orgId: ORG,
      userId: "user-1",
    });

    expect(out.status).toBe("embedded");
    if (out.status === "embedded") {
      expect(out.governed).toBe(true);
      expect(out.vectors).toHaveLength(2);
      expect(out.tokens).toBe(12);
    }
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [feature, taskClass, , opts] = invokeMock.mock.calls[0]!;
    expect(feature).toBe("memory.embedding_write");
    expect(taskClass).toBe("embedding");
    expect(opts).toMatchObject({ orgId: ORG, userId: "user-1" });
    // The dedupe identity joins on U+0000 so ["a b"] and ["a","b"] cannot
    // collide into one hash. Runtime bytes, not the source spelling.
    expect(opts.dedupeContent).toBe(`alpha${NUL}beta`);
    expect(opts.dedupeContent).toContain(NUL);
  });

  it("reports usage on the vendor's billing shape: input tokens only, output 0", async () => {
    setProvider("openai");
    let capturedUsage: Record<string, unknown> | null = null;
    invokeMock.mockImplementation(
      async (
        _f: string,
        _c: string,
        fn: () => Promise<{ value: unknown; usage: Record<string, unknown> }>,
      ) => {
        const call = await fn();
        capturedUsage = call.usage;
        return { status: "ran", value: call.value, budget: "allowed", recorded: true, dark: false };
      },
    );
    embedMock.mockResolvedValue({
      vectors: [vec(4)],
      model: "text-embedding-3-small",
      dimension: 4,
      tokens: 77,
    });

    await governedEmbed({ texts: ["x"], feature: "memory.embedding_query", orgId: ORG });

    expect(capturedUsage).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
      inputTokens: 77,
      outputTokens: 0,
    });
  });

  it("forwards the abort signal into the governed provider call", async () => {
    setProvider("openai");
    governorRuns();
    embedMock.mockResolvedValue({
      vectors: [vec(4)],
      model: "text-embedding-3-small",
      dimension: 4,
      tokens: 1,
    });
    const ctrl = new AbortController();

    await governedEmbed({
      texts: ["x"],
      feature: "memory.embedding_query",
      orgId: ORG,
      signal: ctrl.signal,
    });

    expect(embedMock).toHaveBeenCalledWith(["x"], { signal: ctrl.signal });
  });

  it("a DARK governor run (tier unbound) is reported as governed:false, honestly", async () => {
    setProvider("openai");
    invokeMock.mockImplementation(
      async (_f: string, _c: string, fn: () => Promise<{ value: unknown }>) => {
        const call = await fn();
        return { status: "ran", value: call.value, budget: "allowed", recorded: false, dark: true };
      },
    );
    embedMock.mockResolvedValue({
      vectors: [vec(4)],
      model: "text-embedding-3-small",
      dimension: 4,
      tokens: 1,
    });

    const out = await governedEmbed({ texts: ["x"], feature: "memory.embedding_write", orgId: ORG });

    expect(out.status).toBe("embedded");
    if (out.status === "embedded") expect(out.governed).toBe(false);
  });
});

// =====================================================================
// Outcome mapping — refusals and failures keep their reasons
// =====================================================================

describe("governedEmbed — refusal and failure map without losing the reason", () => {
  beforeEach(() => setProvider("openai"));

  it("blocked (ceiling) → refused, reason preserved verbatim", async () => {
    invokeMock.mockResolvedValue({ status: "blocked", reason: "monthly ceiling reached" });
    const out = await governedEmbed({ texts: ["x"], feature: "memory.embedding_write", orgId: ORG });
    expect(out).toEqual({ status: "refused", reason: "monthly ceiling reached" });
    expect(embedMock).not.toHaveBeenCalled();
  });

  it("duplicate → refused with the 'duplicate_' prefix so callers can tell the two apart", async () => {
    invokeMock.mockResolvedValue({
      status: "duplicate",
      contentHash: "a".repeat(64),
      reason: "in_flight",
    });
    const out = await governedEmbed({ texts: ["x"], feature: "memory.embedding_query", orgId: ORG });
    expect(out).toEqual({ status: "refused", reason: "duplicate_in_flight" });
  });

  it("a provider/governor throw → unavailable, and it CARRIES the reason", async () => {
    invokeMock.mockRejectedValue(new Error("429 rate limited"));
    const out = await governedEmbed({ texts: ["x"], feature: "memory.embedding_write", orgId: ORG });
    expect(out.status).toBe("unavailable");
    if (out.status === "unavailable") expect(out.reason).toBe("429 rate limited");
  });

  it("a non-Error throw is still stringified into the reason", async () => {
    invokeMock.mockRejectedValue("socket hang up");
    const out = await governedEmbed({ texts: ["x"], feature: "memory.embedding_write", orgId: ORG });
    expect(out).toEqual({ status: "unavailable", reason: "socket hang up" });
  });
});

// =====================================================================
// The source file itself — the ESCAPE, never a raw NUL byte
// =====================================================================

describe("lib/ai/embeddings/governed.ts source hygiene", () => {
  const ROOT = resolve(__dirname, "..", "..");
  const raw = readFileSync(resolve(ROOT, "lib/ai/embeddings/governed.ts"));

  it("contains NO raw 0x00 byte anywhere — the house rule", () => {
    expect(raw.includes(0)).toBe(false);
  });

  it("the dedupe join is written as the \\u0000 ESCAPE (grep-visible, byte-identical at runtime)", () => {
    const text = raw.toString("utf8");
    expect(text).toContain('.join("\\u0000")');
    // And the escape genuinely produces the NUL byte the identity relies on.
    expect(JSON.parse('"\\u0000"')).toBe(NUL);
  });
});

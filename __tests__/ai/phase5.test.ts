import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AI_FORBIDDEN_ACTIONS,
  aiDisclosure,
  isAiConfigured,
  validateAiResponse,
} from "@/lib/ai/safety";

/**
 * Phase 5 — AI Layer verification.
 *
 * Pins the safety contract + question-box wiring + fallback paths.
 * The actual LLM calls aren't tested at runtime (they need a real
 * API key); we test the deterministic fallback + the response
 * validator + the safety guarantees.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const SAFETY = read("lib/ai/safety.ts");
const HANDLER = read("server/services/ai-question.ts");
const ROUTE = read("app/api/ai/question/route.ts");
const QBOX = read("app/(app)/insights/_question-box.tsx");
const INSIGHTS = read("app/(app)/insights/page.tsx");

// =====================================================================
// 1. AI safety contract
// =====================================================================

describe("Phase 5 — AI safety contract", () => {
  it("AI_FORBIDDEN_ACTIONS lists every directive prohibition", () => {
    expect(AI_FORBIDDEN_ACTIONS.length).toBeGreaterThanOrEqual(5);
    const joined = AI_FORBIDDEN_ACTIONS.join(" ").toLowerCase();
    expect(joined).toMatch(/invoice|quote|job/);
    expect(joined).toMatch(/email/);
    expect(joined).toMatch(/delete/);
    expect(joined).toMatch(/billing|payment/);
    expect(joined).toMatch(/impersonate/);
  });

  it("aiDisclosure copy emphasises read-only + confidence", () => {
    const d = aiDisclosure().toLowerCase();
    expect(d).toMatch(/read-only/);
    expect(d).toMatch(/confidence/);
  });

  it("isAiConfigured reads ANTHROPIC_API_KEY / OPENAI_API_KEY", () => {
    // Function is environment-dependent — assert it returns a boolean.
    expect(typeof isAiConfigured()).toBe("boolean");
    // The source explicitly checks both keys.
    expect(SAFETY).toMatch(/ANTHROPIC_API_KEY/);
    expect(SAFETY).toMatch(/OPENAI_API_KEY/);
  });

  it("validateAiResponse rejects missing/malformed shapes", () => {
    expect(validateAiResponse(null)).toBeNull();
    expect(validateAiResponse({})).toBeNull();
    expect(validateAiResponse({ answer: "" })).toBeNull();
    expect(validateAiResponse({ answer: 42 })).toBeNull();
    const valid = validateAiResponse({
      answer: "Hi",
      confidence: "high",
      sources: [{ label: "Invoices" }],
      generated_by: "anthropic",
    });
    expect(valid).not.toBeNull();
    expect(valid?.answer).toBe("Hi");
    expect(valid?.confidence).toBe("high");
  });

  it("validateAiResponse clamps unknown confidence values to 'medium'", () => {
    const r = validateAiResponse({ answer: "x", confidence: "bogus" });
    expect(r?.confidence).toBe("medium");
  });

  it("validateAiResponse defaults generated_by='deterministic' when unknown", () => {
    const r = validateAiResponse({ answer: "x" });
    expect(r?.generated_by).toBe("deterministic");
  });

  it("validateAiResponse filters bad source entries", () => {
    const r = validateAiResponse({
      answer: "x",
      sources: [{ label: "OK" }, null, { not_label: 1 }],
    });
    expect(r?.sources.length).toBe(1);
    expect(r?.sources[0]?.label).toBe("OK");
  });
});

// =====================================================================
// 2. askAi handler — system prompt + slim snapshot + fallback
// =====================================================================

describe("Phase 5 — askAi handler", () => {
  it("system prompt embeds the AI_FORBIDDEN_ACTIONS list", () => {
    expect(HANDLER).toMatch(/AI_FORBIDDEN_ACTIONS/);
    expect(HANDLER).toMatch(/STRICT RULES/);
  });

  it("requires structured JSON response (answer/confidence/sources)", () => {
    expect(HANDLER).toMatch(/"answer":/);
    expect(HANDLER).toMatch(/"confidence":/);
    expect(HANDLER).toMatch(/"sources":/);
  });

  it("falls back to deterministic answer when no model door is open", () => {
    // The gate USED to be `if (!isAiConfigured())` — a bare vendor-key check.
    // It is now the model door itself (`getTextProvider()`, which requires the
    // governor to be activated), because a key with no bound cost tier is not
    // permission to spend. The fallback it degrades to is unchanged.
    expect(HANDLER).toMatch(/const provider = getTextProvider\(\)/);
    expect(HANDLER).toMatch(/if \(!provider \|\| !isSupportedProvider/);
    expect(HANDLER).toMatch(/deterministicAnswer/);
    expect(HANDLER).not.toMatch(/if \(!isAiConfigured\(\)\)/);
  });

  it("deterministic fallback handles 'overdue' + 'focus' + generic queries", () => {
    expect(HANDLER).toMatch(/q\.includes\("overdue"\)/);
    expect(HANDLER).toMatch(/q\.includes\("focus"\)/);
  });

  it("slim snapshot never includes PII (no email/phone/name fields)", () => {
    const slimBlock =
      HANDLER.match(/type SlimSnapshot = \{[\s\S]*?\};/)?.[0] ?? "";
    expect(slimBlock).not.toMatch(/email/);
    expect(slimBlock).not.toMatch(/phone/);
    // counts.customers IS a number, never names — the literal "name"
    // shouldn't appear as a field.
    expect(slimBlock).not.toMatch(/\bname:/);
  });

  it("never throws — wraps every LLM call in try/catch", () => {
    expect(HANDLER).toMatch(/catch \(err\) \{[\s\S]*ai-question/);
  });

  it("uses AbortSignal.timeout to cap LLM cost on a single request", () => {
    expect(HANDLER).toMatch(/AbortSignal\.timeout\(ANSWER_TIMEOUT_MS\)/);
  });
});

// =====================================================================
// 3. API route
// =====================================================================

describe("Phase 5 — /api/ai/question route", () => {
  it("is auth-gated by requireOrgContext", () => {
    expect(ROUTE).toMatch(/requireOrgContext/);
  });

  it("validates the request with zod (min 3, max 500 chars)", () => {
    expect(ROUTE).toMatch(/z\.object/);
    expect(ROUTE).toMatch(/\.min\(3/);
    expect(ROUTE).toMatch(/\.max\(500/);
  });

  it("returns 422 on bad input + 500 on internal error", () => {
    expect(ROUTE).toMatch(/status: 422/);
    expect(ROUTE).toMatch(/status: 500/);
  });

  it("scopes by ctx.org.id (no cross-org leak)", () => {
    expect(ROUTE).toMatch(/orgId: ctx\.org\.id/);
  });
});

// =====================================================================
// 4. Question box client UI
// =====================================================================

describe("Phase 5 — QuestionBox client component", () => {
  it("is a client component", () => {
    expect(QBOX).toMatch(/^"use client"/);
  });

  it("POSTs to /api/ai/question", () => {
    expect(QBOX).toMatch(/\/api\/ai\/question/);
    expect(QBOX).toMatch(/method: "POST"/);
  });

  it("renders confidence + source pills + generated_by attribution", () => {
    expect(QBOX).toMatch(/confidence:/);
    expect(QBOX).toMatch(/response\.sources\.map/);
    expect(QBOX).toMatch(/via \{response\.generated_by\}/);
  });

  it("shows AI configured badge based on prop", () => {
    expect(QBOX).toMatch(/aiConfigured/);
    expect(QBOX).toMatch(/AI active/);
    expect(QBOX).toMatch(/Deterministic only/);
  });

  it("declares the read-only disclosure", () => {
    expect(QBOX).toMatch(/Read-only/);
  });

  it("offers sample questions the directive named", () => {
    expect(QBOX).toMatch(/What should I focus on this week\?/);
    expect(QBOX).toMatch(/Which customers owe me money\?/);
  });
});

// =====================================================================
// 5. Wired into /insights
// =====================================================================

describe("Phase 5 — /insights wires the QuestionBox", () => {
  it("imports QuestionBox + the activation predicate", () => {
    expect(INSIGHTS).toMatch(/QuestionBox/);
    expect(INSIGHTS).toMatch(/isInferenceTierActivated/);
  });

  it("renders <QuestionBox/> with the aiConfigured prop, driven by ACTIVATION", () => {
    // The badge must state what the answer box will actually do. It used to read
    // `isAiConfigured()` — "a vendor key exists" — which is a different question
    // from the one `askAi` decides on, so a deploy with a key and no bound cost
    // tier promised an AI answer and returned the deterministic one.
    expect(INSIGHTS).toMatch(
      /<QuestionBox aiConfigured=\{isInferenceTierActivated\(\)\}/,
    );
    expect(INSIGHTS).not.toMatch(/aiConfigured=\{isAiConfigured\(\)\}/);
  });
});

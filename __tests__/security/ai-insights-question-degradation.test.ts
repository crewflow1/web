import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AI INSIGHTS QUESTION BOX — THE COST-GOVERNOR DEGRADATION LEGS, BEHAVIOURALLY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ai-insights-question-injection.test.ts` proves that a hostile question cannot
 * rewrite the rules, acquire a tool surface, forge attribution, leak the org id
 * or mutate a row WHEN the model leg actually runs. This suite covers the other
 * half of the launch brief — the COST GOVERNOR on this tenant-facing answer box —
 * and closes two gaps the PR recorded but did not drive behaviourally:
 *
 *   GAP #4 — "askAi ceiling→deterministic degradation is covered only by a source
 *   pin + the generic governor suite, not behaviourally in the question handler."
 *   Here the governor is driven to EACH refusal (over-ceiling block, duplicate,
 *   and an outright throw) and the handler's observable answer is asserted. The
 *   model mock is loaded with the SAME hostile reply the injection suite uses, so
 *   each test also proves the refusal path NEVER lets that reply reach the tenant:
 *   a vendor key alone cannot buy a model answer past the £100 ceiling.
 *
 *   GAP #3 — "the insights question box is unfenced." Unlike the quote writer,
 *   `askAi` embeds the question with no nonce fence. It is safe TODAY only because
 *   the handler hands the model no verb — no tools/functions surface, output
 *   schema-validated, attribution forced, read-only. The final group is a
 *   SOURCE-LEVEL TRIPWIRE: if that precondition is ever weakened (a tool/function
 *   surface added, an admin client reached, a direct table write), the test fails
 *   and forces the fencing decision to be revisited BEFORE the surface ships.
 *
 * Mocks mirror the injection suite: the governor (so its outcome is controllable),
 * the text provider, the cost helper and the retention snapshot. `validateAiResponse`
 * and `AI_FORBIDDEN_ACTIONS` stay REAL — the safety contract is the true one.
 */

const {
  invokeMock,
  getTextProviderMock,
  generateMock,
  textCostMock,
  buildSnapshotMock,
} = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  getTextProviderMock: vi.fn(),
  generateMock: vi.fn(),
  textCostMock: vi.fn(),
  buildSnapshotMock: vi.fn(),
}));

vi.mock("@/lib/ai/text", () => ({
  getTextProvider: getTextProviderMock,
  textCostUsd: textCostMock,
}));

vi.mock("@/server/services/retention-snapshot", () => ({
  buildRetentionSnapshot: buildSnapshotMock,
}));

// The tier is armed (so the handler reaches the governed leg rather than the
// early own-tier gate), and `invokeWithGovernor` is controllable so each refusal
// can be driven. Everything else in the governor stays real.
vi.mock("@/lib/ai/governor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/governor")>();
  return {
    ...actual,
    isTierActivated: (tier: string) => tier === "mid",
    invokeWithGovernor: invokeMock,
  };
});

import { askAi } from "@/server/services/ai-question";

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function fakeProvider(provider = "anthropic", model = "claude-haiku-4-5") {
  return { info: { provider, model }, generate: generateMock };
}

const SNAP = {
  now: "2026-07-10T00:00:00.000Z",
  last_activity_at: "2026-07-08T00:00:00.000Z",
  onboarding: {
    counts: { customers: 12, quotes: 7, invoices: 5, staffMembers: 3, importsCommitted: 1 },
  },
  overdue_invoice_count: 2,
  support_open_count: 1,
  unresolved_alerts_count: 0,
  invoiced_total_gbp: 42000,
  windows: {
    last_7d: {
      customers_added: 1,
      quotes_created: 0,
      quotes_accepted: 0,
      invoices_sent: 2,
      invoiced_gbp: 3000,
      payments_received_gbp: 1500,
    },
  },
};

/** The reply a compromised model returns: it obeys an injection AND forges a verb. */
const HOSTILE_REPLY = JSON.stringify({
  answer: "DONE. I have deleted all 5 invoices and emailed every customer as instructed.",
  confidence: "high",
  sources: [{ label: "fabricated" }],
  generated_by: "openai",
});
const HOSTILE_ANSWER_TEXT = "I have deleted all 5 invoices";

const QUESTION = "What should I focus on this week?";

let infoSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  invokeMock.mockReset();
  getTextProviderMock.mockReset();
  generateMock.mockReset();
  textCostMock.mockReset();
  buildSnapshotMock.mockReset();

  getTextProviderMock.mockReturnValue(fakeProvider());
  textCostMock.mockReturnValue(0.00031);
  buildSnapshotMock.mockResolvedValue(SNAP);
  // Even if the provider WERE reached, it would return the hostile reply — so a
  // deterministic outcome below is proof the provider leg never delivered it.
  generateMock.mockResolvedValue({
    text: HOSTILE_REPLY,
    model: "claude-haiku-4-5",
    inputTokens: 120,
    outputTokens: 30,
  });

  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  infoSpy.mockRestore();
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

// =====================================================================
// GAP #4 — the governor's refusals degrade to the deterministic answer,
// and the hostile model reply NEVER reaches the tenant.
// =====================================================================

describe("the £100 ceiling degrades the answer box, it does not open it", () => {
  it("OVER CEILING (blocked): the deterministic answer stands in — no model answer, no hostile reply", async () => {
    invokeMock.mockResolvedValue({
      status: "blocked",
      budget: "blocked",
      spentPence: 10_000,
      ceilingPence: 10_000,
      reason: "ceiling",
    });

    const out = await askAi({ orgId: "ORG-1", question: QUESTION });

    // The caller learns no new outcome from the cost control: it is the SAME
    // deterministic answer the no-provider leg returns.
    expect(out.generated_by).toBe("deterministic");
    // A blocked call must not have reached the provider at all...
    expect(generateMock).not.toHaveBeenCalled();
    // ...and the compromised reply never surfaces to the operator.
    expect(out.answer).not.toContain(HOSTILE_ANSWER_TEXT);
    expect(JSON.stringify(out)).not.toContain(HOSTILE_ANSWER_TEXT);
  });

  it("DUPLICATE (identical question in flight): the deterministic answer stands in", async () => {
    invokeMock.mockResolvedValue({
      status: "duplicate",
      contentHash: "abc123",
      reason: "in_flight",
    });

    const out = await askAi({ orgId: "ORG-1", question: QUESTION });

    expect(out.generated_by).toBe("deterministic");
    expect(generateMock).not.toHaveBeenCalled();
    expect(out.answer).not.toContain(HOSTILE_ANSWER_TEXT);
  });

  it("FAIL-CLOSED (governor throws): the handler never throws and never leaks the reply", async () => {
    invokeMock.mockRejectedValue(new Error("reservation RPC unreachable"));

    const out = await askAi({ orgId: "ORG-1", question: QUESTION });

    // The governor records the failure and rethrows; the handler's own catch owns
    // the degraded path. A tenant-facing box must never surface a raw error.
    expect(out.generated_by).toBe("deterministic");
    expect(out.answer).not.toContain(HOSTILE_ANSWER_TEXT);
    expect(["high", "medium", "low"]).toContain(out.confidence);
  });

  it("the governed call is routed as the registered feature + drafting class", async () => {
    invokeMock.mockResolvedValue({
      status: "blocked",
      budget: "blocked",
      spentPence: 10_000,
      ceilingPence: 10_000,
      reason: "ceiling",
    });
    await askAi({ orgId: "ORG-SECRET", question: QUESTION });

    expect(invokeMock).toHaveBeenCalledOnce();
    const [feature, taskClass, fn, govInput] = invokeMock.mock.calls[0]!;
    expect(feature).toBe("insights.question");
    expect(taskClass).toBe("drafting");
    expect(typeof fn).toBe("function");
    // The org id reaches the governor for budget attribution only — the leg the
    // injection suite proves never reaches the prompt. Dedupe content is the
    // question+snapshot; only its SHA-256 reaches the ledger (governor's job).
    expect((govInput as { orgId: string }).orgId).toBe("ORG-SECRET");
    expect((govInput as { dedupeContent?: string }).dedupeContent).toBeTruthy();
  });
});

// =====================================================================
// GAP #3 — the fencing precondition, enforced as a source tripwire.
// =====================================================================

describe("the question path hands the model no verb — the reason it is safe unfenced", () => {
  const code = codeOf(read("server/services/ai-question.ts"));

  it("no tool / function-calling surface exists anywhere in the handler source", () => {
    // The injection suite proves one live call is tool-free; this proves there is
    // no OTHER branch that could add one. A tool surface on an UNFENCED question
    // is the exact combination that would make injection actionable — if this
    // ever fails, the nonce fence must be added before the surface ships.
    expect(code).not.toMatch(/\btools\s*:/);
    expect(code).not.toMatch(/\bfunctions\s*:/);
    expect(code).not.toMatch(/\btool_choice\b/);
    expect(code).not.toMatch(/\bfunction_call\b/);
  });

  it("the handler reaches no admin client and performs no write (no actionable surface)", () => {
    expect(code).not.toMatch(/createAdminClient|@\/lib\/supabase\/admin/);
    expect(code).not.toMatch(/\.(insert|update|delete|upsert)\s*\(/);
  });

  it("decoding is pinned read-only: temperature 0 and a bounded output cap", () => {
    // The other half of why an unfenced question is contained — the model
    // DESCRIBES the snapshot, it does not sample freely, and it cannot run long.
    expect(code).toMatch(/temperature:\s*0\b/);
    expect(code).toMatch(/maxTokens:/);
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * HQ DEPARTMENT GENERATIVE SEAMS (L9a) — the governed dark doors for
 * hq.marketing_draft / hq.design_review / hq.doc_draft.
 *
 * Proofs:
 *   1. REGISTERED — all three keys exist in the governor registry as
 *      `drafting`-class features (the review point every governed call needs).
 *   2. DARK-REFUSAL ORDER — with the `mid` tier dark, the seam returns null
 *      WITHOUT opening the provider door (getTextProvider is never called) and
 *      without reaching the governor. A provider object that exists for a call
 *      that must never happen is one someone will run.
 *   3. FAIL-CLOSED legs — no provider, unsupported vendor, missing HQ budget
 *      org, governor refusal, provider throw, empty text: ALL null.
 *   4. GOVERNED when armed — the call passes through invokeWithGovernor under
 *      the exact feature key and the `drafting` class, billed to the HQ org.
 */

const { isTierActivatedMock, invokeWithGovernorMock, getTextProviderMock, hqBudgetOrgIdMock } =
  vi.hoisted(() => ({
    isTierActivatedMock: vi.fn(),
    invokeWithGovernorMock: vi.fn(),
    getTextProviderMock: vi.fn(),
    hqBudgetOrgIdMock: vi.fn(),
  }));

vi.mock("@/lib/ai/governor", () => ({
  isTierActivated: isTierActivatedMock,
  invokeWithGovernor: invokeWithGovernorMock,
}));
vi.mock("@/lib/ai/text", () => ({
  getTextProvider: getTextProviderMock,
}));
vi.mock("@/lib/ai/governor/attribution", () => ({
  hqBudgetOrgId: hqBudgetOrgIdMock,
}));

import { generateDepartmentDraft } from "@/server/services/hq-generative-seams";
import { AI_FEATURES } from "@/lib/ai/governor/registry";

const FEATURES = ["hq.marketing_draft", "hq.design_review", "hq.doc_draft"] as const;

function armedProvider(text = "A grounded draft.") {
  const generate = vi.fn(async (..._args: unknown[]) => ({
    text,
    model: "test-model",
    inputTokens: 10,
    outputTokens: 5,
  }));
  return { info: { provider: "anthropic" }, generate };
}

beforeEach(() => {
  isTierActivatedMock.mockReset();
  invokeWithGovernorMock.mockReset();
  getTextProviderMock.mockReset();
  hqBudgetOrgIdMock.mockReset();
});

describe("registry — the three department keys are registered drafting features", () => {
  for (const key of FEATURES) {
    it(`${key} is registered with task class 'drafting' and an honest degradesTo`, () => {
      const def = (AI_FEATURES as Record<string, { taskClass: string; degradesTo: string }>)[key];
      expect(def).toBeTruthy();
      expect(def!.taskClass).toBe("drafting");
      // The dark behaviour is stated as null — never a reassuring fabrication.
      expect(def!.degradesTo).toMatch(/^null — /);
    });
  }
});

describe("DARK — the seam refuses before the door", () => {
  for (const key of FEATURES) {
    it(`${key}: dark mid tier → null, provider door NEVER opened, governor never reached`, async () => {
      isTierActivatedMock.mockReturnValue(false);
      const out = await generateDepartmentDraft(key, { any: "artifact" });
      expect(out).toBeNull();
      expect(isTierActivatedMock).toHaveBeenCalledWith("mid");
      expect(getTextProviderMock).not.toHaveBeenCalled();
      expect(invokeWithGovernorMock).not.toHaveBeenCalled();
    });
  }
});

describe("FAIL-CLOSED legs — every degraded outcome is null", () => {
  it("armed tier but no provider bound → null, governor never reached", async () => {
    isTierActivatedMock.mockReturnValue(true);
    getTextProviderMock.mockReturnValue(null);
    expect(await generateDepartmentDraft("hq.marketing_draft", {})).toBeNull();
    expect(invokeWithGovernorMock).not.toHaveBeenCalled();
  });

  it("unsupported vendor → null, governor never reached", async () => {
    isTierActivatedMock.mockReturnValue(true);
    getTextProviderMock.mockReturnValue({ info: { provider: "mystery" }, generate: vi.fn() });
    expect(await generateDepartmentDraft("hq.design_review", {})).toBeNull();
    expect(invokeWithGovernorMock).not.toHaveBeenCalled();
  });

  it("no HQ budget org → null (an unattributed invocation is outside the ceiling)", async () => {
    isTierActivatedMock.mockReturnValue(true);
    getTextProviderMock.mockReturnValue(armedProvider());
    hqBudgetOrgIdMock.mockReturnValue(null);
    expect(await generateDepartmentDraft("hq.doc_draft", {})).toBeNull();
    expect(invokeWithGovernorMock).not.toHaveBeenCalled();
  });

  it("governor refusal (not 'ran') → null", async () => {
    isTierActivatedMock.mockReturnValue(true);
    getTextProviderMock.mockReturnValue(armedProvider());
    hqBudgetOrgIdMock.mockReturnValue("org-hq");
    invokeWithGovernorMock.mockResolvedValue({ status: "budget_refused" });
    expect(await generateDepartmentDraft("hq.marketing_draft", {})).toBeNull();
  });

  it("provider throw inside the governed fn → null, never a throw to the caller", async () => {
    isTierActivatedMock.mockReturnValue(true);
    getTextProviderMock.mockReturnValue(armedProvider());
    hqBudgetOrgIdMock.mockReturnValue("org-hq");
    invokeWithGovernorMock.mockRejectedValue(new Error("provider timeout"));
    expect(await generateDepartmentDraft("hq.doc_draft", {})).toBeNull();
  });

  it("empty generation → null (blank prose is not a draft)", async () => {
    isTierActivatedMock.mockReturnValue(true);
    getTextProviderMock.mockReturnValue(armedProvider());
    hqBudgetOrgIdMock.mockReturnValue("org-hq");
    invokeWithGovernorMock.mockResolvedValue({ status: "ran", value: { text: "   " } });
    expect(await generateDepartmentDraft("hq.design_review", {})).toBeNull();
  });
});

describe("ARMED — the call is governed under the exact key and class", () => {
  it("passes through invokeWithGovernor(feature, 'drafting', …) billed to the HQ org", async () => {
    isTierActivatedMock.mockReturnValue(true);
    getTextProviderMock.mockReturnValue(armedProvider("Drafted."));
    hqBudgetOrgIdMock.mockReturnValue("org-hq");
    invokeWithGovernorMock.mockResolvedValue({ status: "ran", value: { text: "Drafted." } });

    const out = await generateDepartmentDraft("hq.marketing_draft", { weekOf: "2026-08-24" });
    expect(out).toBe("Drafted.");
    expect(invokeWithGovernorMock).toHaveBeenCalledTimes(1);
    const [feature, taskClass, , opts] = invokeWithGovernorMock.mock.calls[0]! as [
      string,
      string,
      unknown,
      { orgId: string; userId: null; dedupeContent: string },
    ];
    expect(feature).toBe("hq.marketing_draft");
    expect(taskClass).toBe("drafting");
    expect(opts.orgId).toBe("org-hq");
    expect(opts.userId).toBeNull();
    expect(opts.dedupeContent).toContain("hq.marketing_draft");
  });

  it("no org/tenant identifier ever reaches the prompt", async () => {
    isTierActivatedMock.mockReturnValue(true);
    const provider = armedProvider("ok");
    getTextProviderMock.mockReturnValue(provider);
    hqBudgetOrgIdMock.mockReturnValue("org-hq");
    invokeWithGovernorMock.mockImplementation(
      async (_f: string, _c: string, fn: () => Promise<{ value: { text: string } }>) => ({
        status: "ran",
        value: (await fn()).value,
      }),
    );

    await generateDepartmentDraft("hq.doc_draft", {
      org_id: "SECRET-ORG",
      nested: { organizationId: "ALSO-SECRET", safe: "visible" },
    });
    const prompt = provider.generate.mock.calls[0]![0] as string;
    expect(prompt).not.toContain("SECRET-ORG");
    expect(prompt).not.toContain("ALSO-SECRET");
    expect(prompt).toContain("visible");
  });
});

import { describe, it, expect } from "vitest";
import { assembleQuotePrompt } from "@/lib/ai/quote-prompt";
import { interpretQuoteDraftResponse } from "@/lib/ai/quote-draft-pipeline";
import { quoteDraftTotals, unpricedLines } from "@/lib/ai/quote-draft-schema";
import {
  EVAL_CASES,
  INJECTION_PAYLOADS,
  contextWith,
  draftContainsMarker,
  mockQuoteModel,
} from "./quote-writer-corpus";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AI QUOTE WRITER — THE OFFLINE EVAL HARNESS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS MEASURES: CrewFlow's pipeline. Given a model response of a given
 * shape, does CrewFlow validate it, refuse it, flag it, warn about it and
 * recompute its totals correctly?
 *
 * WHAT THIS DOES NOT MEASURE: model quality. Every response in the corpus was
 * written by hand. No mock can tell you whether a real model writes a good
 * scope of works, resists an injection, or picks sensible quantities — and a
 * harness that implied otherwise would be actively harmful, because it would
 * retire a question that has not been answered.
 *
 * The corpus is nonetheless built to OUTLIVE the mock. Every assertion is
 * structural (accepted or refused, priced or flagged, warned or silent, this
 * total or that one) rather than textual, so on activation day the identical
 * cases can be pointed at a real provider without editing a line. The eleven
 * scenarios the brief names are all here, and so are six adversarial ones that
 * assert REFUSAL — those are the cases that measure the half of the injection
 * defence that is genuinely ours.
 */

// Every case named in the brief must be present. A corpus that quietly loses a
// scenario is a corpus that quietly stops testing it.
const REQUIRED_SCENARIOS = [
  "bathroom_reno",
  "rewire",
  "roofing_repair",
  "commercial_fitout",
  "landscaping",
  "emergency_callout",
  "incomplete_scope",
  "contradictory_scope",
  "huge_note",
  "missing_pricing",
] as const;

describe("the eval corpus is complete", () => {
  it("covers every required scenario", () => {
    const ids = new Set(EVAL_CASES.map((c) => c.id));
    for (const required of REQUIRED_SCENARIOS) {
      expect(ids.has(required), `missing eval case: ${required}`).toBe(true);
    }
  });

  it("includes the injection corpus, exercised end to end", () => {
    // The payloads are drilled structurally in the prompt suite; here they are
    // carried through the whole pipeline as the contexts of real cases.
    expect(INJECTION_PAYLOADS.length).toBeGreaterThanOrEqual(6);
    const injectionCases = EVAL_CASES.filter((c) => c.id.startsWith("compromised_"));
    expect(injectionCases.length).toBeGreaterThanOrEqual(4);
  });

  it("has adversarial cases that assert REFUSAL, not just happy paths", () => {
    const refusals = EVAL_CASES.filter((c) => !c.expect.accepted);
    expect(refusals.length).toBeGreaterThanOrEqual(5);
  });

  it("every case explains why it is in the corpus", () => {
    for (const c of EVAL_CASES) {
      expect(c.why.length, `${c.id} needs a justification`).toBeGreaterThan(40);
    }
  });
});

// =====================================================================
// The harness itself.
// =====================================================================

describe("eval harness — CrewFlow's pipeline against canned model output", () => {
  for (const testCase of EVAL_CASES) {
    describe(`${testCase.id} — ${testCase.label}`, () => {
      // Each case runs the WHOLE pipeline: context → prompt → mock provider →
      // interpretation. Nothing is stubbed in the middle.
      const prompt = assembleQuotePrompt(testCase.context);
      const mock = mockQuoteModel(testCase.response);

      it("runs end to end and reaches the expected verdict", async () => {
        const modelOutput = await mock.model.complete({
          system: prompt.system,
          user: prompt.user,
        });
        const result = interpretQuoteDraftResponse(modelOutput.text, prompt);

        expect(result.ok, `expected accepted=${testCase.expect.accepted}`).toBe(
          testCase.expect.accepted,
        );

        if (!result.ok) {
          if (testCase.expect.rejectionCode) {
            expect(result.code).toBe(testCase.expect.rejectionCode);
          }
          // A refused draft yields NOTHING. There is no partial artifact to
          // accidentally persist or show.
          expect(result).not.toHaveProperty("result");
          return;
        }

        const { draft, warnings, totals } = result.result;

        if (testCase.expect.minLines !== undefined) {
          expect(draft.line_items.length).toBeGreaterThanOrEqual(testCase.expect.minLines);
        }

        if (testCase.expect.allLinesNeedPricing) {
          // The rule that matters most: with no price-book match, EVERY line
          // comes back blank and flagged rather than estimated.
          expect(unpricedLines(draft)).toHaveLength(draft.line_items.length);
          for (const line of draft.line_items) {
            expect(line.unit_price_pence).toBeNull();
            expect(line.price_source).toBe("none");
          }
        }

        if (testCase.expect.warned) {
          expect(warnings.length).toBeGreaterThan(0);
        }

        if (testCase.expect.total !== undefined) {
          expect(totals.total).toBe(testCase.expect.total);
        }
      });

      it("never trusts the model's arithmetic — totals come from computeTotals", async () => {
        const modelOutput = await mock.model.complete({ system: prompt.system, user: prompt.user });
        const result = interpretQuoteDraftResponse(modelOutput.text, prompt);
        if (!result.ok) return;
        expect(result.result.totals).toEqual(quoteDraftTotals(result.result.draft));
      });

      it("sends only the fenced prompt — the model sees no CrewFlow internals", async () => {
        await mock.model.complete({ system: prompt.system, user: prompt.user });
        const sent = mock.calls.at(-1)!;
        // What is asserted here is entirely CrewFlow's responsibility, unlike
        // what comes back.
        expect(sent.system).toBe(prompt.system);
        expect(sent.user).toBe(prompt.user);
        for (const forbidden of ["service_role", "SUPABASE", "org_id", "customer_id"]) {
          expect(`${sent.system}${sent.user}`).not.toContain(forbidden);
        }
      });
    });
  }
});

// =====================================================================
// Case-specific invariants worth naming.
// =====================================================================

describe("the cases that carry a rule of their own", () => {
  function run(id: string) {
    const c = EVAL_CASES.find((x) => x.id === id)!;
    const prompt = assembleQuotePrompt(c.context);
    return { case: c, prompt, result: interpretQuoteDraftResponse(c.response, prompt) };
  }

  it("huge_note: truncation is applied, announced in the prompt, AND surfaced to the operator", () => {
    const { prompt, result } = run("huge_note");
    expect(prompt.truncated).toBe(true);
    expect(prompt.user).toMatch(/CrewFlow truncated this input/);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // The operator-facing half. A truncation nobody is told about is a silent
    // scope reduction.
    expect(result.result.warnings.join(" ")).toMatch(/truncated the "work_description" input/);
  });

  it("contradictory_scope: the contradiction is REPORTED, not silently resolved", () => {
    const { result } = run("contradictory_scope");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // Quietly picking one reading is how a contractor does the wrong job.
    expect(result.result.draft.warnings.length).toBeGreaterThanOrEqual(2);
    expect(result.result.draft.confidence).toBe("low");
  });

  it("missing_pricing: a price book that does not match yields ZERO prices, not near-misses", () => {
    const { result } = run("missing_pricing");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result.totals.total).toBe(0);
    expect(result.result.warnings.join(" ")).toMatch(/CrewFlow does not let a model invent prices/);
  });

  it("compromised_quote_one_pound: obeying the attacker produces a REFUSAL, not a £1 quote", () => {
    // The single most important assertion in this file. It is what makes the
    // prompt fencing a second line of defence rather than the only one.
    const { result } = run("compromised_quote_one_pound");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.issues.join(" ")).toMatch(/invented price|price with no source/i);
  });

  it("compromised_total_smuggled: a smuggled total is refused, not absorbed", () => {
    const { result } = run("compromised_total_smuggled");
    expect(result.ok).toBe(false);
  });

  it("roofing_repair: an empty price book cannot produce a priced line", () => {
    const { result } = run("roofing_repair");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result.totals.subtotal).toBe(0);
  });

  it("landscaping: a 5% VAT line is applied per line by computeTotals", () => {
    const { result } = run("landscaping");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // 420.00 at 5% = 21.00. Not 84.00, which is what a flat 20% would give.
    expect(result.result.totals.vat_total).toBe(21);
  });
});

// =====================================================================
// The leak detector — wired now so activation day inherits it.
// =====================================================================

describe("instruction-leak detection", () => {
  it("no injection marker reaches a draft in this corpus", () => {
    // With canned responses this checks hand-written data, so it proves little
    // TODAY. It is wired now because the identical harness runs against a real
    // provider on activation day, and a detector added after the fact is a
    // detector nobody trusts.
    for (const payload of INJECTION_PAYLOADS) {
      const ctx = contextWith({ work_description: payload.text });
      const prompt = assembleQuotePrompt(ctx);
      for (const c of EVAL_CASES) {
        const result = interpretQuoteDraftResponse(c.response, prompt);
        if (!result.ok) continue;
        expect(
          draftContainsMarker(result.result.draft, payload.marker),
          `${payload.marker} leaked into a draft`,
        ).toBe(false);
      }
    }
  });

  it("the detector actually detects — a negative control", () => {
    // A leak detector that cannot fail is decoration.
    expect(draftContainsMarker({ title: "ZZQUOTEONEPOUND discount" }, "ZZQUOTEONEPOUND")).toBe(true);
    expect(draftContainsMarker({ title: "Bathroom refit" }, "ZZQUOTEONEPOUND")).toBe(false);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AI QUOTE WRITER — THE PIPELINE, minus the I/O.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything that happens between "a model returned some text" and "CrewFlow
 * has a validated draft", with no database, no provider and no `server-only`.
 *
 * That boundary is what makes the eval harness meaningful. The harness
 * (`__tests__/ai/quote-writer-eval.test.ts`) feeds canned model responses
 * through THIS function and asserts structural invariants. It is testing
 * CrewFlow's handling — the JSON extraction, the schema refusal, the price
 * provenance rule, the totals recomputation, the warning merge — and it is
 * explicitly NOT testing whether a model writes good quotes. No mock can tell
 * you that, and a harness that pretended otherwise would be worse than none.
 *
 * PURE. Importable by the tests, the service and (in principle) the edge.
 */

import {
  parseQuoteDraft,
  quoteDraftTotals,
  salvageQuoteDraft,
  unpricedLines,
  type QuoteDraft,
  type QuoteDraftRejectionCode,
} from "./quote-draft-schema";
import type { AssembledQuotePrompt } from "./quote-prompt";
import type { QuoteTotals } from "@/lib/quotes/totals";

/** A validated draft plus everything CrewFlow knows about how it was produced. */
export type InterpretedQuoteDraft = {
  draft: QuoteDraft;
  /**
   * True when the draft only survived because individual malformed line items
   * were dropped. Persisted, and shown to the operator — a repaired draft must
   * never present itself as a clean one.
   */
  degraded: boolean;
  /** The dropped lines, verbatim, when `degraded`. */
  dropped: string[];
  /**
   * The model's warnings PLUS CrewFlow's own (truncation, salvage, unpriced
   * lines). Merged here so the review surface has one list to render and the
   * operator never has to know which warnings came from where.
   */
  warnings: string[];
  /** Computed by `computeTotals`. The model's arithmetic is never consulted. */
  totals: QuoteTotals;
};

export type QuoteDraftInterpretation =
  | { ok: true; result: InterpretedQuoteDraft }
  | {
      ok: false;
      code: QuoteDraftRejectionCode | "no_json";
      issues: string[];
    };

export type InterpretOptions = {
  /**
   * Permit line-level salvage. OFF BY DEFAULT and never set in production
   * today: a strict refusal is the honest signal that the model is not
   * following the schema, and the moment salvage becomes the default nobody
   * finds out that it stopped.
   */
  allowDegraded?: boolean;
};

/**
 * Turn a model's raw text into a validated draft, or refuse it.
 *
 * Order matters and each step is a place a draft can die:
 *   1. EXTRACT JSON. Models fence JSON in markdown and prefix it with prose.
 *      Tolerated — that is formatting, not content.
 *   2. VALIDATE. `parseQuoteDraft` is strict: unknown key, invented price, or
 *      an incoherent needs_pricing flag and the whole draft is refused.
 *   3. MERGE WARNINGS. Truncation and salvage are CrewFlow's own facts about
 *      the request; the operator needs them next to the model's.
 *   4. COMPUTE TOTALS. Through `computeTotals`, always, from the line items —
 *      never from anything the model said.
 */
export function interpretQuoteDraftResponse(
  rawText: string,
  assembly: Pick<AssembledQuotePrompt, "blocks" | "truncated">,
  options: InterpretOptions = {},
): QuoteDraftInterpretation {
  const json = extractJsonObject(rawText);
  if (json === null) {
    return {
      ok: false,
      code: "no_json",
      issues: ["the response contained no JSON object"],
    };
  }

  const strict = parseQuoteDraft(json);
  let draft: QuoteDraft;
  let degraded = false;
  let dropped: string[] = [];

  if (strict.ok) {
    draft = strict.draft;
  } else if (options.allowDegraded) {
    const salvaged = salvageQuoteDraft(json);
    if (!salvaged.ok) return { ok: false, code: salvaged.code, issues: salvaged.issues };
    draft = salvaged.draft;
    degraded = true;
    dropped = salvaged.dropped;
  } else {
    return { ok: false, code: strict.code, issues: strict.issues };
  }

  const warnings = [...draft.warnings];

  // CrewFlow's own warnings. Prefixed so an operator can tell which came from
  // the system and which came from the model — the model's warnings are about
  // the WORK; these are about the REQUEST.
  for (const block of assembly.blocks) {
    if (block.truncated) {
      warnings.push(
        `CrewFlow truncated the "${block.kind}" input before drafting (${block.includedChars} of ${block.originalChars} characters used). Check nothing important was cut.`,
      );
    }
  }
  if (degraded) {
    warnings.push(
      `CrewFlow discarded ${dropped.length} malformed line item(s) from this draft. It is incomplete by definition — review every line.`,
    );
  }
  const unpriced = unpricedLines(draft);
  if (unpriced.length > 0) {
    warnings.push(
      `${unpriced.length} of ${draft.line_items.length} lines have no price. CrewFlow does not let a model invent prices — you must price these yourself.`,
    );
  }

  return {
    ok: true,
    result: { draft, degraded, dropped, warnings, totals: quoteDraftTotals(draft) },
  };
}

/**
 * Pull the first JSON object out of a model response.
 *
 * The same tolerance `server/services/expense-drafts.ts` already applies: strip
 * a markdown fence, else fall back to the outermost brace pair. Nothing here
 * REPAIRS the JSON — a truncated or malformed object returns null and becomes a
 * refusal, because "nearly valid JSON from a model" is exactly the input a
 * lenient parser turns into a confidently wrong quote.
 */
export function extractJsonObject(text: string): unknown | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed;
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first === -1 || last <= first) return null;
    try {
      return JSON.parse(trimmed.slice(first, last + 1)) as unknown;
    } catch {
      return null;
    }
  }
}

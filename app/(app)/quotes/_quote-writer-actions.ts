"use server";

/**
 * AI Quote Writer — the server actions the review surface calls.
 *
 * Three verbs and no more: DRAFT, APPLY, DISCARD.
 *
 * Note what is absent, and note that its absence is structural rather than
 * disciplined. This module imports nothing from `./actions` — not `createQuote`,
 * not `requestQuoteApproval`, and above all not `sendQuote`. `applyQuoteDraft`
 * returns LINE ITEMS to the browser; the operator then presses Save in the
 * ordinary builder, and every existing control (validation, the approval gate,
 * the send gate, the accepted-quote freeze) applies to the result exactly as it
 * does to a hand-typed quote, because nothing about the result is special.
 *
 * EVENT-DRIVEN. `draftQuoteAction` is reachable only from a form submission — a
 * person pressing a button. It is never called from a render path, which is the
 * governor's one cost rule that no wrapper can enforce on a caller's behalf.
 */

import {
  applyQuoteDraft,
  discardQuoteDraft,
  generateQuoteDraft,
  type GenerateQuoteDraftOutcome,
} from "@/server/services/ai-quote-writer";
import type { LineItem } from "@/lib/quotes/schema";

export async function draftQuoteAction(input: {
  quoteId?: string | null;
  leadId?: string | null;
}): Promise<GenerateQuoteDraftOutcome> {
  return generateQuoteDraft({ quoteId: input.quoteId ?? null, leadId: input.leadId ?? null });
}

export async function applyQuoteDraftAction(
  draftId: string,
  edited: unknown,
): Promise<{ ok: true; lineItems: LineItem[] } | { ok: false; error: string }> {
  return applyQuoteDraft(draftId, edited);
}

export async function discardQuoteDraftAction(
  draftId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return discardQuoteDraft(draftId);
}

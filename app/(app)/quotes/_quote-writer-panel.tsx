"use client";

/**
 * AI Quote Writer — the review surface, mounted inside the quote builder.
 *
 * TODAY THIS RENDERS A SWITCHED-OFF NOTICE, and getting that notice right is
 * most of this component's job. The failure mode it exists to prevent is the
 * #433 one: a screen that offers a capability the build does not contain, so an
 * operator clicks and nothing happens and they conclude the product is broken.
 *
 * The dark copy therefore says four true things, in the order an operator cares
 * about them:
 *   1. Your quote works exactly as it always has. (Nothing has changed for you.)
 *   2. AI drafting is BUILT and switched OFF. (Not broken. Not coming. Off.)
 *   3. Nothing is sent to any third party. (The question they actually have.)
 *   4. What is missing, for owners and admins who need to act on it.
 *
 * When it IS activated, this becomes the review surface: the draft's scope,
 * assumptions, exclusions and warnings, with every unpriced line flagged, and
 * two buttons — Apply and Discard. Apply hands LINE ITEMS to the builder's own
 * state. It does not create a quote, and there is no path from here to sending
 * one: the operator continues through the ordinary Save button.
 */

import { useState, useTransition } from "react";
import type { LineItem } from "@/lib/quotes/schema";
import type { QuoteWriterReadiness } from "@/lib/ai/quote-writer-readiness";
import { quoteWriterStatusLine } from "@/lib/ai/quote-writer-readiness";
import type { QuoteDraft } from "@/lib/ai/quote-draft-schema";
import { toQuoteLineItems } from "@/lib/ai/quote-draft-schema";
import {
  applyQuoteDraftAction,
  discardQuoteDraftAction,
  draftQuoteAction,
} from "./_quote-writer-actions";

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

export type QuoteWriterPanelProps = {
  readiness: QuoteWriterReadiness;
  /** True for owners/admins — only they see the activation checklist. */
  canSeeBlockers?: boolean;
  /** What this draft would be about. At least one is required to generate. */
  anchor?: { quoteId?: string | null; leadId?: string | null };
  /** An open draft already on record, if any. */
  initialDraft?: { id: string; draft: QuoteDraft; degraded: boolean } | null;
  /** Hands the applied lines to the builder's own state. */
  onApplyLineItems?: (items: LineItem[]) => void;
};

export function QuoteWriterPanel({
  readiness,
  canSeeBlockers = false,
  anchor,
  initialDraft = null,
  onApplyLineItems,
}: QuoteWriterPanelProps) {
  if (!readiness.available) {
    return <DarkNotice readiness={readiness} canSeeBlockers={canSeeBlockers} />;
  }
  return (
    <ActiveSurface
      anchor={anchor}
      initialDraft={initialDraft}
      onApplyLineItems={onApplyLineItems}
    />
  );
}

// ---------------------------------------------------------------------------
// The state that ships today.
// ---------------------------------------------------------------------------

function DarkNotice({
  readiness,
  canSeeBlockers,
}: {
  readiness: QuoteWriterReadiness;
  canSeeBlockers: boolean;
}) {
  return (
    <section
      className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm"
      aria-label="AI quote drafting status"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-900">AI quote drafting</h2>
        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700">
          Off
        </span>
      </div>
      <p className="mt-2 text-slate-600">{quoteWriterStatusLine(readiness)}</p>
      {canSeeBlockers && readiness.blockers.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-800">
            What would need to happen to switch it on
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-500">
            {readiness.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          {readiness.ungovernedCredentialRisk ? (
            <p className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
              An AI provider credential is present in this environment while no model is
              connected. That combination is worth resolving either way — connect a model
              deliberately, or remove the credential.
            </p>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The state that ships on activation. Unreachable until a model is bound.
// ---------------------------------------------------------------------------

type Status =
  | { kind: "idle" }
  | { kind: "error"; message: string }
  | { kind: "draft"; id: string; draft: QuoteDraft; degraded: boolean };

function ActiveSurface({
  anchor,
  initialDraft,
  onApplyLineItems,
}: {
  anchor?: { quoteId?: string | null; leadId?: string | null };
  initialDraft: { id: string; draft: QuoteDraft; degraded: boolean } | null;
  onApplyLineItems?: (items: LineItem[]) => void;
}) {
  const [status, setStatus] = useState<Status>(
    initialDraft
      ? { kind: "draft", id: initialDraft.id, draft: initialDraft.draft, degraded: initialDraft.degraded }
      : { kind: "idle" },
  );
  const [pending, startTransition] = useTransition();

  const canGenerate = Boolean(anchor?.quoteId || anchor?.leadId);

  function generate() {
    startTransition(async () => {
      const outcome = await draftQuoteAction({
        quoteId: anchor?.quoteId ?? null,
        leadId: anchor?.leadId ?? null,
      });
      switch (outcome.status) {
        case "created":
          setStatus({
            kind: "draft",
            id: outcome.draftId,
            draft: outcome.draft,
            degraded: outcome.degraded,
          });
          return;
        case "unavailable":
          setStatus({ kind: "error", message: "AI drafting is not switched on." });
          return;
        case "blocked":
          setStatus({
            kind: "error",
            message: `This month's AI budget is used up (${GBP.format(
              outcome.spentPence / 100,
            )} of ${GBP.format(outcome.ceilingPence / 100)}). Write the quote as usual.`,
          });
          return;
        case "duplicate":
          setStatus({
            kind: "error",
            message: "Nothing has changed since the last draft, so no new one was generated.",
          });
          return;
        case "rejected":
          setStatus({
            kind: "error",
            message: "The draft came back malformed and was rejected. Nothing was saved.",
          });
          return;
        default:
          setStatus({ kind: "error", message: "Drafting failed. Write the quote as usual." });
      }
    });
  }

  function apply(id: string, draft: QuoteDraft) {
    startTransition(async () => {
      const result = await applyQuoteDraftAction(id, draft);
      if (!result.ok) {
        setStatus({ kind: "error", message: "Couldn't apply the draft." });
        return;
      }
      onApplyLineItems?.(result.lineItems);
      setStatus({ kind: "idle" });
    });
  }

  function discard(id: string) {
    startTransition(async () => {
      await discardQuoteDraftAction(id);
      setStatus({ kind: "idle" });
    });
  }

  return (
    <section
      className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm"
      aria-label="AI quote drafting"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">AI quote drafting</h2>
        {status.kind !== "draft" ? (
          <button
            type="button"
            onClick={generate}
            disabled={pending || !canGenerate}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {pending ? "Drafting…" : "Draft a scope of works"}
          </button>
        ) : null}
      </div>

      <p className="mt-1 text-xs text-slate-500">
        A draft is a starting point, never a quote. You review and price every line, and
        nothing reaches your customer until you send it yourself.
      </p>

      {status.kind === "error" ? (
        <p role="alert" className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {status.message}
        </p>
      ) : null}

      {status.kind === "draft" ? (
        <DraftReview
          draft={status.draft}
          degraded={status.degraded}
          pending={pending}
          onApply={() => apply(status.id, status.draft)}
          onDiscard={() => discard(status.id)}
        />
      ) : null}
    </section>
  );
}

function DraftReview({
  draft,
  degraded,
  pending,
  onApply,
  onDiscard,
}: {
  draft: QuoteDraft;
  degraded: boolean;
  pending: boolean;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const lines = toQuoteLineItems(draft);
  const unpriced = draft.line_items.filter((l) => l.needs_pricing).length;

  return (
    <div className="mt-4 space-y-4">
      <div>
        <h3 className="font-semibold text-slate-900">{draft.title}</h3>
        <p className="mt-1 whitespace-pre-line text-slate-600">{draft.scope_summary}</p>
      </div>

      {/* Warnings go ABOVE the lines. A warning under a plausible-looking quote
          is a warning nobody reads. */}
      {degraded || draft.warnings.length > 0 ? (
        <ul className="space-y-1 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {degraded ? (
            <li className="font-semibold">
              This draft is incomplete — CrewFlow discarded malformed lines from it.
            </li>
          ) : null}
          {draft.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}

      {unpriced > 0 ? (
        <p className="text-xs font-medium text-slate-700">
          {unpriced} of {draft.line_items.length} lines have no price. CrewFlow never lets a
          model invent one — price them yourself after applying.
        </p>
      ) : null}

      <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
        {draft.line_items.map((line, i) => (
          <li key={i} className="flex items-baseline justify-between gap-3 px-3 py-2">
            <span className="text-slate-800">
              {line.qty} {line.unit} · {line.description}
            </span>
            <span className="shrink-0 text-xs font-medium text-slate-600">
              {line.unit_price_pence === null ? (
                <span className="text-amber-700">needs pricing</span>
              ) : (
                GBP.format(lines[i]?.unit_price ?? 0)
              )}
            </span>
          </li>
        ))}
      </ul>

      {draft.assumptions.length > 0 ? (
        <Bullets title="Assumptions" items={draft.assumptions} />
      ) : null}
      {draft.exclusions.length > 0 ? (
        <Bullets title="Exclusions" items={draft.exclusions} />
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onApply}
          disabled={pending}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
        >
          Apply to this quote
        </button>
        <button
          type="button"
          onClick={onDiscard}
          disabled={pending}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          Discard
        </button>
      </div>
    </div>
  );
}

function Bullets({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h4>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-slate-600">
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

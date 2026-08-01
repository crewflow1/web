import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import {
  computeActivitySummary,
  computeLeadInsights,
} from "@/lib/ai/aggregates";
import { resolveInsightNarrative } from "@/server/services/ai-insights";
import { loadCompanySignals } from "@/server/services/intelligence";
import { InsightsSection } from "../dashboard/_insights";
import { CompanySignals } from "./_company-signals";
import { QuestionBox } from "./_question-box";
import { isGovernorActivated } from "@/lib/ai/governor/readiness";

/**
 * /insights — AI Analysis (tenant-side).
 *
 * The Dashboard renders the same `<InsightsSection/>` inline so the
 * operator sees the at-a-glance signals as part of their day. This
 * dedicated route exists because the CEO directive wants a separate,
 * always-on analytical surface:
 *
 *   • Read-only — AI never changes business data.
 *   • Visible only in the tenant app (NOT in HQ).
 *   • Surfaces deterministic signals as the authoritative source, then
 *     overlays an LLM narrative on the activity payload's `summary` slot
 *     via `resolveInsightNarrative` — generated ONLY through the shared
 *     provider abstraction (`lib/ai/text`), cached, cost-recorded, and
 *     gracefully null when no provider is configured. The prose only ever
 *     describes the deterministic facts; it never computes or invents them.
 *
 * The page intentionally keeps the same component as the dashboard's
 * inline panel — single source of truth, no drift. Future expansion
 * (revenue opportunities, staff inefficiencies, pricing suggestions,
 * forecasts) bolts onto this page without touching dashboard layout.
 */

export const dynamic = "force-dynamic";

export default async function InsightsPage() {
  const { ctx } = await requireOrgContext();

  const [activity, leads, companySignals] = await Promise.all([
    computeActivitySummary(ctx.org.id, 30),
    computeLeadInsights(ctx.org.id, 90),
    // Deterministic company signals — no model anywhere in this section.
    // Group failures are isolated inside the loader: a failed read renders an
    // explicit error card, never an empty metric.
    loadCompanySignals(ctx.org.id),
  ]);

  // Overlay the LLM narrative on the ACTIVITY payload. The deterministic
  // aggregates above stay the authoritative source of every number the UI
  // renders; this only fills the prose `summary` slot, and only when a provider
  // is configured (else null → deterministic-only, exactly as before). Reaches
  // a model solely through the shared abstraction, cached + cost-recorded.
  const { summary } = await resolveInsightNarrative({
    orgId: ctx.org.id,
    kind: "activity",
    windowDays: 30,
    payload: activity,
  });
  const activityWithNarrative = { ...activity, summary };

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-bold text-slate-900">AI Insights</h1>
          <Link
            href="/dashboard"
            className="text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            ← Back to dashboard
          </Link>
        </div>
        <p className="max-w-2xl text-sm text-slate-600">
          Analytical signals derived from your live data — quote pipeline
          health, lead conversion, staff throughput, stalled actions.
          Insights only. Nothing here changes a record, sends a message,
          or moves money — that&apos;s always your call.
        </p>
      </header>

      <section className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 text-sm text-amber-900">
        <p className="font-medium">Read-only by design.</p>
        <p className="mt-1 text-xs">
          We treat AI as a second pair of eyes, not a co-pilot at the
          wheel. The signals below are derived deterministically (and,
          when the prose layer is enabled, summarised by an LLM with
          guardrails). Your business data is the source of truth — not
          the model.
        </p>
      </section>

      {/*
        The badge must state what the ANSWER BOX will actually do. It used to
        read `isAiConfigured()` — "a vendor key exists" — which was a different
        question from the one `askAi` decides on, so a deploy with a key and no
        bound cost tier would promise an AI answer and return the deterministic
        one. `isGovernorActivated()` is the same predicate the handler's model
        door uses, so the badge and the behaviour cannot disagree.
      */}
      <QuestionBox aiConfigured={isGovernorActivated()} />

      <InsightsSection activity={activityWithNarrative} leads={leads} />

      {/*
        COMPANY SIGNALS — the deterministic intelligence layer (Train 6).
        Composes existing authorities only (rota/time, invoices, the progress
        series, the retention register, aged debtors, job budgets, material
        fulfilment, snags). Every card labels itself FACT/DERIVED/HEURISTIC
        with a plain-English basis; nothing generative touches this section.
      */}
      <CompanySignals view={companySignals} />

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">
          What gets surfaced here?
        </h2>
        <ul className="mt-3 space-y-2 text-sm text-slate-700">
          <li>
            <strong>Quote pipeline:</strong> conversion %, median time-to-
            accept, stalled sends.
          </li>
          <li>
            <strong>Invoices:</strong> overdue-30d list (already visible on
            /invoices?status=overdue but lifted here for review).
          </li>
          <li>
            <strong>Leads:</strong> sources by volume, conversion by source,
            no-touch list.
          </li>
          <li>
            <strong>Staff throughput:</strong> jobs completed leaderboard.
          </li>
          <li className="text-slate-500">
            Coming next: revenue opportunities · pricing suggestions ·
            forecasts. Tied to the dashboard&apos;s sparklines so trends
            stay one source.
          </li>
        </ul>
      </section>
    </div>
  );
}

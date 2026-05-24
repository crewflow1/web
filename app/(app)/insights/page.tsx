import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import {
  computeActivitySummary,
  computeLeadInsights,
} from "@/lib/ai/aggregates";
import { InsightsSection } from "../dashboard/_insights";
import { QuestionBox } from "./_question-box";
import { isAiConfigured } from "@/lib/ai/safety";

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
 *   • Surfaces deterministic signals today; the prose layer in
 *     `lib/ai/types::ActivitySummaryResponse.summary` is wired and
 *     will fill in when ANTHROPIC_API_KEY is configured.
 *
 * The page intentionally keeps the same component as the dashboard's
 * inline panel — single source of truth, no drift. Future expansion
 * (revenue opportunities, staff inefficiencies, pricing suggestions,
 * forecasts) bolts onto this page without touching dashboard layout.
 */

export const dynamic = "force-dynamic";

export default async function InsightsPage() {
  const { ctx } = await requireOrgContext();

  const [activity, leads] = await Promise.all([
    computeActivitySummary(ctx.org.id, 30),
    computeLeadInsights(ctx.org.id, 90),
  ]);

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

      <QuestionBox aiConfigured={isAiConfigured()} />

      <InsightsSection activity={activity} leads={leads} />

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

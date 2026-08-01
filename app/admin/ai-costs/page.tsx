import { requireHqPage } from "@/server/auth/hq";
import {
  buildAiCostSnapshot,
  buildAiCostTrend,
  type AiCostOrgRow,
  type AiCostTrend,
} from "@/server/services/ai-cost-snapshot";
import { formatPence } from "@/lib/ai/governor";
import { AI_FEATURE_KEYS, AI_FEATURES, AI_TIERS, TIER_MODEL } from "@/lib/ai/governor/registry";
import type { BudgetStatus } from "@/lib/ai/governor/policy";

/**
 * /admin/ai-costs — HQ AI spend governance.
 *
 * The operator answer to four questions, in the order they get asked:
 *   1. Can anything spend money right now?  (activation — dark today)
 *   2. What has the estate spent this month, against the £100/org ceiling?
 *   3. Which orgs are near it, over it, or spending anomalously?
 *   4. Which capability is the money going to?
 *
 * A sibling of /admin/ops rather than a section inside it: Ops answers "is the
 * plumbing healthy", which is a different question from "is the spend under
 * control", and mixing a per-tenant money table into a system-health page makes
 * both harder to read. Same conventions throughout — no client JS,
 * force-dynamic, HQ-gated at the layout with a defence-in-depth check here.
 *
 * While the governor is dark every figure below is zero, and that is the point:
 * the measurement surface exists BEFORE the spend does.
 */

export const dynamic = "force-dynamic";

const STATUS_PILL: Record<BudgetStatus, string> = {
  allowed: "border-emerald-200 bg-emerald-50 text-emerald-800",
  warn_50: "border-amber-200 bg-amber-50 text-amber-900",
  warn_80: "border-orange-200 bg-orange-50 text-orange-900",
  blocked: "border-red-200 bg-red-50 text-red-800",
};

const STATUS_LABEL: Record<BudgetStatus, string> = {
  allowed: "ok",
  warn_50: "50%+",
  warn_80: "80%+",
  blocked: "blocked",
};

export default async function AiCostsPage() {
  await requireHqPage();

  const snap = await buildAiCostSnapshot();
  const trend = await buildAiCostTrend();
  const { readiness } = snap;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-slate-900">AI costs</h1>
        <p className="text-sm text-slate-600">
          Budget month {snap.month} (Europe/London) · hard ceiling{" "}
          {formatPence(snap.ceilingPence)} per org per month · as of{" "}
          {new Date(snap.generatedAt).toLocaleString("en-GB")}
        </p>
      </header>

      {/* 1. Activation — the honest headline, first. */}
      <section
        className={`rounded-xl border p-5 shadow-sm ${
          readiness.activated
            ? "border-emerald-200 bg-emerald-50"
            : "border-slate-300 bg-slate-100"
        }`}
        role="status"
      >
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">
          Provider activation
        </p>
        <p className="mt-1 text-xl font-bold text-slate-900">
          {readiness.activated ? "Active" : "Dark — no model bound"}
        </p>
        <p className="mt-2 max-w-3xl text-sm text-slate-700">
          {readiness.activated
            ? "Governed calls can reach a provider. Every one is recorded below."
            : "No cost tier maps to a model in this build, so no governed call can reach a provider and the ledger is empty by construction. Setting a vendor credential alone cannot change this."}
        </p>

        {/*
          This warning existed because seven call sites gated on a bare vendor
          key, so a credential on a deploy could reach a provider while no tier
          was bound — spend with no ceiling and no ledger row. Every provider
          door now requires governor ACTIVATION, so the flag is derived from
          `AI_UNGOVERNED_INFERENCE_ENTRY_POINTS` (zero, and pinned there by the
          security ratchet) and no longer fires on a credential alone. It is kept
          rather than deleted so that raising that count — the only honest way to
          add such a path again — turns the warning back on by itself.
        */}
        {readiness.ungovernedCredentialRisk ? (
          <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs font-medium text-amber-900">
            A vendor credential is present ({readiness.credentialsPresent.join(", ")}) while no
            tier is bound, AND this build contains an inference path that gates on a bare key
            check rather than on governor activation. That path could reach a provider without
            passing the ceiling or the ledger. Either bind the tier or remove the credential.
          </p>
        ) : null}
        {readiness.credentialsPresent.length > 0 && !readiness.anyTierBound ? (
          <p className="mt-3 rounded-md border border-slate-300 bg-white p-3 text-xs text-slate-700">
            A vendor credential is present ({readiness.credentialsPresent.join(", ")}) while no
            tier is bound. This is <strong>not</strong> ungoverned spend — every provider door
            (lib/ai/text, lib/ai/vision) requires a bound cost tier, so the credential switches
            nothing on. It is reported because it is an activation half-done: either bind a tier
            deliberately, or remove the credential. Embeddings are the one exception and are
            governed separately.
          </p>
        ) : null}

        <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {AI_TIERS.map((tier) => {
            const binding = TIER_MODEL[tier];
            return (
              <div key={tier} className="rounded-md border border-slate-200 bg-white px-3 py-2">
                <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  {tier} tier
                </dt>
                <dd className="mt-0.5 font-mono text-xs text-slate-800">
                  {binding ? `${binding.provider} · ${binding.model}` : "unbound"}
                </dd>
              </div>
            );
          })}
        </dl>

        {readiness.blockers.length > 0 ? (
          <details className="mt-4 text-xs">
            <summary className="cursor-pointer font-medium text-slate-700">
              Activation checklist ({readiness.blockers.length})
            </summary>
            <ul className="mt-2 space-y-1 text-slate-700">
              {readiness.blockers.map((b) => (
                <li key={b} className="font-mono text-[11px]">
                  · {b}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      {/* 2. This month, estate-wide. */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">This month</h2>
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-6">
          <Kpi label="Committed spend" value={formatPence(snap.totalPence)} />
          {/* IN FLIGHT is not spend — it is budget claimed by calls that have
              not settled. It is shown beside the committed figure because the
              ceiling is enforced against the SUM, so a page that showed only
              committed spend would report headroom an org does not have. */}
          <Kpi
            label="In flight"
            value={formatPence(snap.totalReservedPence)}
            tone={snap.totalReservedPence > 0 ? "amber" : undefined}
          />
          <Kpi label="Invocations" value={String(snap.totalInvocations)} />
          <Kpi
            label="Failures"
            value={String(snap.totalFailures)}
            tone={snap.totalFailures > 0 ? "amber" : undefined}
          />
          <Kpi
            label="Orgs blocked"
            value={String(snap.blockedOrgs.length)}
            tone={snap.blockedOrgs.length > 0 ? "red" : undefined}
          />
          <Kpi
            label="Spike flags"
            value={String(snap.spikingOrgs.length)}
            tone={snap.spikingOrgs.length > 0 ? "amber" : undefined}
          />
        </dl>
        {/* THE CALIBRATION ALARM. A settled claim that cost more than it
            reserved is the one way committed spend can pass the ceiling, so it
            is stated rather than left to be inferred from a total. */}
        {snap.totalOverruns > 0 ? (
          <p className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-xs font-medium text-red-900">
            {snap.totalOverruns} settled call{snap.totalOverruns === 1 ? "" : "s"} cost MORE than the
            budget reserved for {snap.totalOverruns === 1 ? "it" : "them"}. The ceiling holds exactly
            only while a call&rsquo;s real cost stays within its reservation, so the worst-case token
            envelope on the bound model (<code>reserveInputTokens</code> /{" "}
            <code>reserveOutputTokens</code> in lib/ai/governor/registry.ts) is too small and should
            be raised.
          </p>
        ) : null}
      </section>

      {/* 2b. The trend — month over month, so a slow creep is visible before a spike is. */}
      <TrendSection trend={trend} activated={readiness.activated} />

      {/* 3. By org. */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <header className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-slate-900">By organisation</h2>
          <p className="text-[11px] text-slate-500">
            % of ceiling counts committed spend AND in-flight claims · spike = more than 3× that
            org&rsquo;s own trailing average
          </p>
        </header>
        {snap.byOrg.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">
            No AI spend recorded this month.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Organisation</th>
                  <th className="px-3 py-2 text-right">Committed</th>
                  <th className="px-3 py-2 text-right">In flight</th>
                  <th className="px-3 py-2 text-right">% of ceiling</th>
                  <th className="px-3 py-2 text-right">Calls</th>
                  <th className="px-3 py-2 text-right">Fails</th>
                  <th className="px-3 py-2 text-right">Trailing avg</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {snap.byOrg.map((o) => (
                  <OrgRow key={o.orgId} org={o} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 4. By feature. */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <header className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-slate-900">By feature</h2>
          <p className="text-[11px] text-slate-500">
            {AI_FEATURE_KEYS.length} governed capabilities
          </p>
        </header>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Capability</th>
                <th className="px-3 py-2">Class</th>
                <th className="px-3 py-2 text-right">Spend</th>
                <th className="px-3 py-2 text-right">Calls</th>
                <th className="px-3 py-2 text-right">Fails</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {/* Every REGISTERED capability, whether or not it spent anything —
                  a governed feature showing zero is information, not an
                  absence. Rows are joined to the month's totals by key. */}
              {AI_FEATURE_KEYS.map((key) => {
                const def = AI_FEATURES[key];
                const row = snap.byFeature.find((f) => f.feature === key);
                return (
                  <tr key={key}>
                    <td className="px-3 py-2">
                      <p className="font-medium text-slate-800">{def.label}</p>
                      <p className="font-mono text-[10px] text-slate-500">{key}</p>
                    </td>
                    <td className="px-3 py-2 text-slate-600">{def.taskClass}</td>
                    <td className="px-3 py-2 text-right font-medium text-slate-800">
                      {formatPence(row?.spentPence ?? 0)}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-600">
                      {row?.invocations ?? 0}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-600">{row?.failures ?? 0}</td>
                  </tr>
                );
              })}
              {/* Anything in the ledger that is no longer registered. */}
              {snap.byFeature
                .filter((f) => !(AI_FEATURE_KEYS as readonly string[]).includes(f.feature))
                .map((f) => (
                  <tr key={f.feature} className="bg-amber-50/50">
                    <td className="px-3 py-2">
                      <p className="font-medium text-amber-900">{f.label}</p>
                      <p className="font-mono text-[10px] text-amber-700">{f.feature}</p>
                    </td>
                    <td className="px-3 py-2 text-amber-800">—</td>
                    <td className="px-3 py-2 text-right font-medium text-amber-900">
                      {formatPence(f.spentPence)}
                    </td>
                    <td className="px-3 py-2 text-right text-amber-800">{f.invocations}</td>
                    <td className="px-3 py-2 text-right text-amber-800">{f.failures}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/** Integer pence as a SIGNED delta, e.g. `+£1.20`, `−£0.30`, `£0.00`. Display only. */
function formatDeltaPence(pence: number): string {
  if (!Number.isFinite(pence) || pence === 0) return "£0.00";
  const sign = pence > 0 ? "+" : "−"; // real minus sign, not a hyphen
  return `${sign}${formatPence(Math.abs(pence))}`;
}

function TrendSection({ trend, activated }: { trend: AiCostTrend; activated: boolean }) {
  // The bar is scaled to the window's PEAK so the tallest month fills the track;
  // it is decorative (aria-hidden) because every figure is also stated as text,
  // so the view never depends on colour or length to be read.
  const scale = trend.peakPence > 0 ? trend.peakPence : 1;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-base font-semibold text-slate-900">
          Spend trend — last {trend.windowMonths} months
        </h2>
        <p className="text-[11px] text-slate-500">
          Europe/London budget months · committed spend only · as of{" "}
          {new Date(trend.generatedAt).toLocaleString("en-GB")}
        </p>
      </header>

      {/* THE HONEST EMPTY STATE. While the governor is dark every month below is
          £0.00 by construction, so the trend says so plainly and points back at
          the activation block rather than drawing a flat line that looks like a
          reading. The zero series is still rendered beneath it: the measurement
          surface exists BEFORE the spend does, which is the whole point. */}
      {!trend.hasAnySpend ? (
        <p
          className="mt-4 rounded-md border border-slate-300 bg-slate-100 p-3 text-xs text-slate-700"
          role="status"
        >
          No spend yet — AI is dark{activated ? "" : " (no tier bound)"}. Every month below is{" "}
          {formatPence(0)} by construction, because no governed call can reach a provider until a
          cost tier is bound to a model. See <strong>Provider activation</strong> above.
        </p>
      ) : (
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi label={`${trend.windowMonths}-month total`} value={formatPence(trend.totalPence)} />
          <Kpi label="Peak month" value={formatPence(trend.peakPence)} />
          <Kpi label="Months with spend" value={`${trend.monthsWithSpend}/${trend.windowMonths}`} />
          <Kpi
            label="This month"
            value={formatPence(trend.months[trend.months.length - 1]?.totalPence ?? 0)}
          />
        </dl>
      )}

      {/* The series. An ordered list, oldest → newest, one row per month. Each
          row states its month, its committed spend and its month-over-month
          change as TEXT; the bar merely echoes the number. Readable at 375px. */}
      <ol
        className="mt-5 space-y-2"
        aria-label={`Monthly AI committed spend, ${trend.months[0]?.label ?? ""} to ${
          trend.months[trend.months.length - 1]?.label ?? ""
        }`}
      >
        {trend.months.map((m) => {
          const widthPct = m.totalPence > 0 ? Math.max(2, (m.totalPence / scale) * 100) : 0;
          return (
            <li key={m.month} className="text-sm">
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className={`font-medium ${m.isCurrent ? "text-slate-900" : "text-slate-700"}`}
                >
                  {m.label}
                  {m.isCurrent ? (
                    <span className="ml-1 text-[10px] font-normal uppercase tracking-wide text-slate-500">
                      current
                    </span>
                  ) : null}
                </span>
                <span className="flex items-baseline gap-2">
                  <span className="font-mono text-slate-800">{formatPence(m.totalPence)}</span>
                  {m.deltaPence !== null && m.deltaPence !== 0 ? (
                    <span
                      className={`font-mono text-[11px] ${
                        m.deltaPence > 0 ? "text-amber-700" : "text-emerald-700"
                      }`}
                    >
                      {formatDeltaPence(m.deltaPence)}
                    </span>
                  ) : (
                    <span className="font-mono text-[11px] text-slate-400">—</span>
                  )}
                </span>
              </div>
              <div
                aria-hidden
                className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
              >
                <div
                  className={`h-full rounded-full ${m.isCurrent ? "bg-slate-700" : "bg-slate-400"}`}
                  style={{ width: `${widthPct}%` }}
                />
              </div>
            </li>
          );
        })}
      </ol>

      {/* Per-capability contribution over the SAME window — surfaced only when
          something actually spent, so the dark build shows no empty table. */}
      {trend.byFeature.some((f) => f.spentPence > 0) ? (
        <div className="mt-6">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">
            By capability, over the window
          </h3>
          <ul className="mt-2 space-y-1 text-sm">
            {trend.byFeature
              .filter((f) => f.spentPence > 0)
              .map((f) => (
                <li key={f.feature} className="flex items-baseline justify-between gap-2">
                  <span className="text-slate-700">
                    {f.label}
                    <span className="ml-1 font-mono text-[10px] text-slate-400">{f.feature}</span>
                  </span>
                  <span className="font-mono text-slate-800">{formatPence(f.spentPence)}</span>
                </li>
              ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function OrgRow({ org }: { org: AiCostOrgRow }) {
  return (
    <tr className={org.status === "blocked" ? "bg-red-50/50" : undefined}>
      <td className="px-3 py-2">
        <p className="font-medium text-slate-800">{org.orgName}</p>
        <p className="font-mono text-[10px] text-slate-500">{org.orgId}</p>
      </td>
      <td className="px-3 py-2 text-right font-medium text-slate-800">
        {formatPence(org.spentPence)}
      </td>
      <td
        className={`px-3 py-2 text-right ${
          org.reservedPence > 0 ? "font-medium text-amber-800" : "text-slate-400"
        }`}
      >
        {formatPence(org.reservedPence)}
        {org.liveReservations > 0 ? (
          <span className="ml-1 text-[10px] text-amber-700">({org.liveReservations})</span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-right text-slate-600">{org.percentOfCeiling}%</td>
      <td className="px-3 py-2 text-right text-slate-600">{org.invocations}</td>
      <td className="px-3 py-2 text-right text-slate-600">{org.failures}</td>
      <td className="px-3 py-2 text-right text-slate-500">
        {formatPence(Math.round(org.trailingAveragePence))}
      </td>
      <td className="px-3 py-2">
        <span
          className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_PILL[org.status]}`}
        >
          {STATUS_LABEL[org.status]}
        </span>
        {org.spiking ? (
          <span className="ml-1 inline-block rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-900">
            spike
          </span>
        ) : null}
      </td>
    </tr>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "amber" | "red";
}) {
  const toneClass =
    tone === "red"
      ? "border-red-200 bg-red-50 text-red-900"
      : tone === "amber"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : "border-slate-200 bg-slate-50 text-slate-900";
  return (
    <div className={`rounded-md border px-3 py-2 ${toneClass}`}>
      <dt className="text-[11px] font-medium uppercase tracking-wide opacity-70">{label}</dt>
      <dd className="mt-0.5 text-lg font-bold">{value}</dd>
    </div>
  );
}

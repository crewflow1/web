import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../_components/empty-state";
import { listRiskAssessments } from "./_data";
import { HealthSafetySignals } from "./_hs-signals";
import { buildHealthSafetySnapshot } from "@/server/services/health-safety-snapshot";
import { buildHealthSafetySignals } from "@/lib/health-safety/signals";
import {
  overallRiskBand,
  RISK_BAND_META,
  type RaStatus,
  type RiskBand,
} from "@/lib/health-safety/rams";

const RA_FILTERS = [
  { key: "all", label: "All" },
  { key: "draft", label: "Draft" },
  { key: "issued", label: "Issued" },
  { key: "archived", label: "Superseded / withdrawn" },
] as const;
type RaFilter = (typeof RA_FILTERS)[number]["key"];

/**
 * /health-safety — the RAMS register (Risk Assessment & Method Statement).
 *
 * One row per risk assessment, from draft to issued and on to superseded /
 * withdrawn. The list itself is a single org-scoped read via the data layer;
 * the worst-risk band per row needs the hazard scores, so those are pulled in
 * ONE further batched query (never per-row) and grouped in memory.
 */

const RA_STATUS_LABELS: Record<RaStatus, string> = {
  draft: "Draft",
  issued: "Issued",
  superseded: "Superseded",
  withdrawn: "Withdrawn",
};

const RA_STATUS_STYLES: Record<RaStatus, string> = {
  draft: "bg-slate-100 text-slate-700",
  issued: "bg-emerald-100 text-emerald-800",
  superseded: "bg-amber-100 text-amber-800",
  withdrawn: "bg-slate-100 text-slate-600", // slate-600, not 500: AA contrast on slate-100
};

/** Band → pill classes. Colour reinforces the label text; it never stands alone. */
const BAND_STYLES: Record<RiskBand, string> = {
  low: "bg-emerald-100 text-emerald-800",
  medium: "bg-amber-100 text-amber-800",
  high: "bg-orange-100 text-orange-800",
  critical: "bg-red-100 text-red-800",
};

const ERROR_MAP: Record<string, string> = {
  bad_id: "That risk assessment reference was invalid.",
  not_found: "That risk assessment no longer exists.",
  not_editable: "That risk assessment can no longer be edited.",
  numbering_failed: "Couldn't allocate a reference number. Try again.",
};

const SAVED_MAP: Record<string, string> = {
  updated: "Risk assessment saved.",
  issued: "Risk assessment issued.",
  superseded: "Risk assessment superseded.",
  withdrawn: "Risk assessment withdrawn.",
  hazard: "Hazard added.",
  hazard_removed: "Hazard removed.",
};

type HazardBandRow = {
  risk_assessment_id: string;
  likelihood: number;
  severity: number;
  residual_likelihood: number | null;
  residual_severity: number | null;
};

type SP = Promise<{ saved?: string; error?: string; status?: string }>;

export default async function HealthSafetyPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;

  const [rows, snapshot] = await Promise.all([
    listRiskAssessments(ctx.org.id),
    buildHealthSafetySnapshot(ctx.org.id),
  ]);
  const signals = buildHealthSafetySignals(snapshot);

  const filter: RaFilter = (RA_FILTERS.find((f) => f.key === sp.status)?.key ?? "all");
  const visibleRows = rows.filter((r) =>
    filter === "all"
      ? true
      : filter === "archived"
        ? r.status === "superseded" || r.status === "withdrawn"
        : r.status === filter,
  );

  // Worst-risk band per RA needs the hazard scores, which the list read omits.
  // Pull them for every listed RA in a single org-scoped query and group in
  // memory — one extra query total, never one per row.
  const scoredIds = rows.filter((r) => r.hazard_count > 0).map((r) => r.id);
  const bandByRa = new Map<string, RiskBand>();
  if (scoredIds.length > 0) {
    const supabase = await createClient();
    const { data: hazardRows, error: hazardRowsError } = await (
      supabase.from("risk_assessment_hazards" as never) as unknown as {
        select: (c: string) => {
          in: (
            k: string,
            v: string[],
          ) => Promise<{ data: HazardBandRow[] | null; error: SupabaseReadError | null }>;
        };
      }
    )
      .select(
        "risk_assessment_id, likelihood, severity, residual_likelihood, residual_severity",
      )
      .in("risk_assessment_id", scoredIds);
    // A failed read here would render "No hazards yet" against assessments that
    // HAVE hazards — a false claim about safety data, so fail the page instead.
    if (hazardRowsError) throw readFailure("health-safety register: hazard bands", hazardRowsError);

    const grouped = new Map<string, HazardBandRow[]>();
    for (const h of hazardRows ?? []) {
      const arr = grouped.get(h.risk_assessment_id) ?? [];
      arr.push(h);
      grouped.set(h.risk_assessment_id, arr);
    }
    for (const [raId, hs] of grouped) {
      const band = overallRiskBand(
        hs.map((h) => ({
          likelihood: h.likelihood,
          severity: h.severity,
          residualLikelihood: h.residual_likelihood,
          residualSeverity: h.residual_severity,
        })),
      );
      if (band) bandByRa.set(raId, band);
    }
  }

  const errorMessage = sp.error
    ? (ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error))
    : null;
  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;

  const issuedCount = rows.filter((r) => r.status === "issued").length;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Health &amp; safety</h1>
          <p className="mt-1 text-sm text-slate-600">
            Risk assessments &amp; method statements. Draft the assessment, log
            every hazard with its controls, then issue it as a frozen record for
            the site.
          </p>
        </div>
        <Link
          href="/health-safety/new"
          className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
        >
          + New risk assessment
        </Link>
      </header>

      <nav
        aria-label="Health and safety sections"
        className="flex flex-wrap gap-2 text-sm"
      >
        <span
          aria-current="page"
          className="inline-flex min-h-[44px] items-center rounded-md bg-slate-100 px-3 font-medium text-slate-900"
        >
          Risk assessments
        </span>
        <Link
          href="/health-safety/permits"
          className="inline-flex min-h-[44px] items-center rounded-md px-3 font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
        >
          Permits to work
        </Link>
        <Link
          href="/health-safety/worker-links"
          className="inline-flex min-h-[44px] items-center rounded-md px-3 font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
        >
          Worker sign-off links
        </Link>
      </nav>

      <HealthSafetySignals signals={signals} />

      {errorMessage ? (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}
      {savedMessage ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {savedMessage}
        </div>
      ) : null}

      {rows.length > 0 ? (
        <nav aria-label="Filter risk assessments" className="flex flex-wrap gap-2 text-sm">
          {RA_FILTERS.map((f) => {
            const active = f.key === filter;
            const count =
              f.key === "all"
                ? rows.length
                : f.key === "archived"
                  ? rows.filter((r) => r.status === "superseded" || r.status === "withdrawn").length
                  : rows.filter((r) => r.status === f.key).length;
            return (
              <Link
                key={f.key}
                href={f.key === "all" ? "/health-safety" : `/health-safety?status=${f.key}`}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-[44px] items-center rounded-full px-3.5 font-medium ${
                  active ? "bg-slate-900 text-white" : "border border-slate-200 text-slate-700 hover:bg-slate-50"
                }`}
              >
                {/* Solid tones, never opacity-*: the blended count fell below WCAG AA 4.5:1. */}
                {f.label}{" "}
                <span className={`ml-1 ${active ? "text-slate-300" : "text-slate-600"}`}>
                  {count}
                </span>
              </Link>
            );
          })}
        </nav>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="🦺"
            title="No risk assessments yet"
            body="Every task with a real hazard needs a RAMS before work starts. Draft your first one — capture the activity, assess each hazard on a 5×5 matrix, then issue it to the site."
            primary={{
              href: "/health-safety/new",
              label: "New risk assessment",
            }}
          />
        </div>
      ) : visibleRows.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">
          No matching risk assessments in this view.
        </p>
      ) : (
        <ul className="space-y-3">
          {visibleRows.map((row) => {
            const status = row.status as RaStatus;
            const band = bandByRa.get(row.id) ?? null;
            const bandMeta = band ? RISK_BAND_META[band] : null;
            return (
              <li
                key={row.id}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-mono font-medium text-slate-500">
                        {row.reference ?? "Draft"}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 font-medium ${RA_STATUS_STYLES[status]}`}
                      >
                        {RA_STATUS_LABELS[status]}
                      </span>
                      {bandMeta ? (
                        <span
                          className={`rounded-full px-2 py-0.5 font-medium ${BAND_STYLES[band!]}`}
                        >
                          {bandMeta.label} risk
                        </span>
                      ) : (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
                          No hazards yet
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 text-sm font-medium text-slate-900">
                      {row.title}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-slate-600">
                      {row.activity}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                      <span>
                        {row.hazard_count} hazard
                        {row.hazard_count === 1 ? "" : "s"}
                      </span>
                      {row.location ? <span>📍 {row.location}</span> : null}
                      <span>Created {row.created_at.slice(0, 10)}</span>
                    </div>
                  </div>
                  <Link
                    href={`/health-safety/${row.id}`}
                    className="inline-flex min-h-[44px] items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
                  >
                    {status === "draft" ? "Open draft" : "View"}
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {rows.length > 0 ? (
        <p className="text-xs text-slate-500">
          Showing {visibleRows.length} of {rows.length} risk assessment
          {rows.length === 1 ? "" : "s"} · {issuedCount} issued.
        </p>
      ) : null}
    </div>
  );
}

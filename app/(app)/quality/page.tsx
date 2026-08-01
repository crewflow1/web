import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../_components/empty-state";
import { listPlans, type PlanListItem } from "./_data";
import {
  ITP_STATUS_LABELS,
  completionPercent,
  isFullyAccepted,
  type ItpStatus,
} from "@/lib/quality/itp";

/**
 * /quality — the works quality register (Inspection & Test Plans).
 *
 * The question this page answers, in one glance: WHERE ARE WE BLOCKED. Open hold
 * points lead, before the list, because a hold point is a point past which work
 * must not proceed — everything else on the page is detail.
 *
 * It is a WARN surface only. Nothing here disables or refuses any action; see
 * lib/quality/itp.ts holdPointWarnings for why blocking real site work on
 * software state is a business decision, not a trigger.
 *
 * Two bounded reads via the data layer (plans + the DB progress read-model),
 * both ACTIVE-org pinned, both loud on failure — an empty register on a failed
 * read would claim "no outstanding hold points", which is a control failing
 * open.
 */

const FILTERS = [
  { key: "open", label: "Open hold points" },
  { key: "current", label: "Current" },
  { key: "draft", label: "Draft" },
  { key: "archived", label: "Superseded / withdrawn" },
  { key: "all", label: "All" },
] as const;
type Filter = (typeof FILTERS)[number]["key"];

const STATUS_STYLES: Record<ItpStatus, string> = {
  draft: "bg-slate-100 text-slate-700",
  issued: "bg-emerald-100 text-emerald-800",
  superseded: "bg-amber-100 text-amber-800",
  withdrawn: "bg-slate-100 text-slate-600", // slate-600, not 500: AA contrast on slate-100
};

const ERROR_MAP: Record<string, string> = {
  bad_id: "That inspection plan reference was invalid.",
  not_found: "That inspection plan no longer exists.",
  not_editable: "That inspection plan can no longer be edited (an issued plan is frozen).",
  not_issued: "Sign-offs can only be recorded against an issued plan.",
  issue_failed: "Couldn't issue the plan. Try again.",
  duplicate_item_number: "That item number is already used in this plan.",
  already_signed_off: "That item already has a sign-off. Void it before recording a new one.",
};

const SAVED_MAP: Record<string, string> = {
  created: "Inspection plan created.",
  updated: "Inspection plan saved.",
  issued: "Inspection plan issued.",
  withdrawn: "Inspection plan withdrawn.",
  item_added: "Inspection item added.",
  item_removed: "Inspection item removed.",
  signed_off: "Sign-off recorded.",
  voided: "Sign-off voided. Record the re-inspection when the works are corrected.",
};

type SP = Promise<{ saved?: string; error?: string; filter?: string }>;

function matches(p: PlanListItem, filter: Filter): boolean {
  switch (filter) {
    case "open":
      return p.status === "issued" && p.progress.openHoldItemNumber !== null;
    case "current":
      return p.status === "issued";
    case "draft":
      return p.status === "draft";
    case "archived":
      return p.status === "superseded" || p.status === "withdrawn";
    default:
      return true;
  }
}

export default async function QualityRegisterPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const rows = await listPlans(ctx.org.id);

  const filter: Filter = FILTERS.find((f) => f.key === sp.filter)?.key ?? "all";
  const visible = rows.filter((r) => matches(r, filter));

  const blocked = rows.filter((r) => matches(r, "open"));
  const totalOpenHoldPoints = blocked.reduce((n, r) => n + r.progress.openHoldPoints, 0);
  const breaches = rows.filter((r) => r.progress.holdPointBreaches > 0);

  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error)) : null;
  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Works quality</h1>
          <p className="mt-1 text-sm text-slate-600">
            Inspection &amp; test plans — the proof the works were built to
            specification. Draft the plan, list every check in order, flag the
            hold points, then issue it before work starts.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/quality/ncrs"
            className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Non-conformance
          </Link>
          <Link
            href="/quality/templates"
            className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Templates
          </Link>
          <Link
            href="/quality/new"
            className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
          >
            + New inspection plan
          </Link>
        </div>
      </header>

      {/* OPEN HOLD POINTS LEAD. This is the one thing a QS or clerk of works
          asks first, so it is above the register, not a column inside it. */}
      {blocked.length > 0 ? (
        <section
          aria-labelledby="quality-holds-heading"
          className="rounded-xl border border-red-200 bg-red-50 p-5 shadow-sm"
        >
          <h2 id="quality-holds-heading" className="text-sm font-semibold text-red-900">
            {totalOpenHoldPoints} hold point{totalOpenHoldPoints === 1 ? "" : "s"} outstanding
            {" "}across {blocked.length} plan{blocked.length === 1 ? "" : "s"}
          </h2>
          <p className="mt-1 text-xs text-red-800">
            Work should not proceed past an open hold point until it has been
            inspected and accepted. CrewFlow records this — it does not stop
            anyone working.
          </p>
          <ul className="mt-3 space-y-2">
            {blocked.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/quality/${p.id}`}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-red-200 bg-white px-3 py-2.5 text-sm transition hover:bg-red-50/60"
                >
                  <span className="font-mono text-xs font-medium text-slate-600">
                    {p.reference ?? "Draft"}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium text-slate-900">
                    {p.work_package}
                  </span>
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">
                    Hold at item {p.progress.openHoldItemNumber}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : rows.some((r) => r.status === "issued") ? (
        <section className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 shadow-sm">
          <p className="text-sm font-medium text-emerald-900">
            No hold points outstanding on any current plan.
          </p>
        </section>
      ) : null}

      {breaches.length > 0 ? (
        <section
          aria-labelledby="quality-breach-heading"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 shadow-sm"
        >
          <h2 id="quality-breach-heading" className="text-sm font-semibold text-amber-900">
            {breaches.length} plan{breaches.length === 1 ? " has" : "s have"} a sign-off recorded
            past an open hold point
          </h2>
          <p className="mt-1 text-xs text-amber-800">
            Later work was inspected while an earlier hold point was still open.
            Review the sequence before handover.
          </p>
        </section>
      ) : null}

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
        <nav aria-label="Filter inspection plans" className="flex flex-wrap gap-2 text-sm">
          {FILTERS.map((f) => {
            const active = f.key === filter;
            const count = rows.filter((r) => matches(r, f.key)).length;
            return (
              <Link
                key={f.key}
                href={f.key === "all" ? "/quality" : `/quality?filter=${f.key}`}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-[44px] items-center rounded-full px-3.5 font-medium ${
                  active
                    ? "bg-slate-900 text-white"
                    : "border border-slate-200 text-slate-700 hover:bg-slate-50"
                }`}
              >
                {/* Solid tones, never opacity-*: a blended count falls below AA. */}
                {f.label}{" "}
                <span className={`ml-1 ${active ? "text-slate-300" : "text-slate-600"}`}>
                  {count}
                </span>
              </Link>
            );
          })}
        </nav>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {rows.length === 0 ? (
          <EmptyState
            icon="📋"
            title="No inspection plans yet"
            body="An inspection & test plan is how you prove the works were built right — the ordered list of checks, what acceptable means for each, and which ones work must not pass until they're signed off."
            primary={{ href: "/quality/new", label: "Create the first plan" }}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon="🔍"
            title="Nothing matches that filter"
            body="Try another filter, or view all plans."
            primary={{ href: "/quality", label: "View all" }}
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {visible.map((p) => {
              const pc = completionPercent(p.progress);
              const accepted = isFullyAccepted(p.progress);
              return (
                <li key={p.id}>
                  <Link
                    href={`/quality/${p.id}`}
                    className="block px-4 py-4 transition hover:bg-slate-50 sm:px-5"
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-mono text-xs font-medium text-slate-600">
                        {p.reference ?? "Draft"}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
                        {p.work_package}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[p.status]}`}
                      >
                        {ITP_STATUS_LABELS[p.status]}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-sm text-slate-600">{p.title}</p>
                    <dl className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
                      {p.jobLabel ? (
                        <div>
                          <dt className="sr-only">Job</dt>
                          <dd>{p.jobLabel}</dd>
                        </div>
                      ) : null}
                      <div>
                        <dt className="sr-only">Checks</dt>
                        <dd>
                          {p.progress.signedOffItems}/{p.progress.totalItems} check
                          {p.progress.totalItems === 1 ? "" : "s"} signed off
                          {p.progress.totalItems > 0 ? ` · ${pc}%` : ""}
                        </dd>
                      </div>
                      {p.progress.holdPointItems > 0 ? (
                        <div>
                          <dt className="sr-only">Hold points</dt>
                          <dd>
                            {p.progress.holdPointItems} hold point
                            {p.progress.holdPointItems === 1 ? "" : "s"}
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {p.progress.openHoldItemNumber !== null && p.status === "issued" ? (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">
                          Hold at item {p.progress.openHoldItemNumber}
                        </span>
                      ) : null}
                      {p.progress.failedItems > 0 ? (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                          {p.progress.failedItems} failed
                        </span>
                      ) : null}
                      {p.progress.holdPointBreaches > 0 ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                          {p.progress.holdPointBreaches} out of sequence
                        </span>
                      ) : null}
                      {accepted && p.status === "issued" ? (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                          All checks accepted
                        </span>
                      ) : null}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

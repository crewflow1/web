import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../_components/empty-state";
import { listDelayEvents, type DelayListItem } from "./_data";
import {
  DELAY_CATEGORY_LABELS,
  DELAY_STATUS_LABELS,
  isDelayCategory,
  type DelayEventStatus,
} from "@/lib/eot/lifecycle";

/**
 * /delays — the Delays & EOT register.
 *
 * The question this page answers: WHAT HAS STOPPED WORK, and is the evidence
 * for it in order. Delay events are the raw material of a future extension-
 * of-time claim, so the register leads with what is still OPEN (ongoing
 * stoppages) and what is still a DRAFT (written up but not yet formally
 * recorded — carrying no evidential weight until it is).
 *
 * Read-only compose over the _data layer: ACTIVE-org pinned, loud on failure
 * (a rejected read must never render as "this business has no delays").
 */

const FILTERS = [
  { key: "ongoing", label: "Ongoing" },
  { key: "recorded", label: "Recorded" },
  { key: "draft", label: "Draft" },
  { key: "withdrawn", label: "Withdrawn" },
  { key: "all", label: "All" },
] as const;
type Filter = (typeof FILTERS)[number]["key"];

const STATUS_STYLES: Record<DelayEventStatus, string> = {
  draft: "bg-slate-100 text-slate-700",
  recorded: "bg-emerald-100 text-emerald-800",
  withdrawn: "bg-slate-100 text-slate-600", // slate-600, not 500: AA contrast on slate-100
};

const ERROR_MAP: Record<string, string> = {
  bad_id: "That delay event reference was invalid.",
  not_found: "That delay event no longer exists.",
  not_editable: "That delay event can no longer be edited (a recorded event is frozen).",
  nothing_to_complete: "Nothing to complete — add an end date or a working-days figure.",
};

const SAVED_MAP: Record<string, string> = {
  created: "Delay event drafted.",
  updated: "Delay event saved.",
  recorded: "Delay event recorded. It is now frozen evidence — withdraw it if it was wrong.",
  withdrawn: "Delay event withdrawn. It stays visible as a retracted record.",
  completed: "Delay event completed.",
};

type SP = Promise<{ saved?: string; error?: string; filter?: string }>;

function matches(e: DelayListItem, filter: Filter): boolean {
  switch (filter) {
    case "ongoing":
      return e.status === "recorded" && e.ended_on === null;
    case "recorded":
      return e.status === "recorded";
    case "draft":
      return e.status === "draft";
    case "withdrawn":
      return e.status === "withdrawn";
    default:
      return true;
  }
}

export default async function DelaysRegisterPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const rows = await listDelayEvents(ctx.org.id);

  const filter: Filter = FILTERS.find((f) => f.key === sp.filter)?.key ?? "all";
  const visible = rows.filter((r) => matches(r, filter));

  const ongoing = rows.filter((r) => matches(r, "ongoing"));
  const drafts = rows.filter((r) => r.status === "draft");
  const recorded = rows.filter((r) => r.status === "recorded");
  const claimedDays = recorded.reduce((n, r) => n + (r.working_days_lost ?? 0), 0);

  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error)) : null;
  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Delays &amp; EOT</h1>
          <p className="mt-1 text-sm text-slate-600">
            The evidence log behind any future extension-of-time claim. Record what
            stopped the work while it is fresh, link the diary page that proves it,
            and let the pack show what is still missing.
          </p>
        </div>
        <Link
          href="/delays/new"
          className="inline-flex min-h-[44px] items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          Log a delay
        </Link>
      </header>

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
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {savedMessage}
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Recorded</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{recorded.length}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Ongoing</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{ongoing.length}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Drafts</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{drafts.length}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Days claimed
            </p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{claimedDays}</p>
            <p className="text-[11px] text-slate-500">recorded events, as claimed</p>
          </div>
        </div>
      ) : null}

      <nav aria-label="Filter delay events" className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={f.key === "all" ? "/delays" : `/delays?filter=${f.key}`}
            aria-current={filter === f.key ? "page" : undefined}
            className={`rounded-full px-3 py-1.5 text-sm ${
              filter === f.key
                ? "bg-slate-900 font-medium text-white"
                : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      {visible.length === 0 ? (
        <EmptyState
          title={rows.length === 0 ? "No delays logged yet" : "Nothing matches this filter"}
          body={
            rows.length === 0
              ? "When weather, an instruction or a third party stops work, log it here the same day — contemporaneous records are what an extension-of-time claim stands on."
              : "Try another filter."
          }
        />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
          {visible.map((e) => (
            <li key={e.id}>
              <Link href={`/delays/${e.id}`} className="block px-4 py-3 hover:bg-slate-50">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-medium text-slate-900">
                    {isDelayCategory(e.category)
                      ? DELAY_CATEGORY_LABELS[e.category]
                      : e.category}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[e.status]}`}
                  >
                    {DELAY_STATUS_LABELS[e.status]}
                  </span>
                  {e.status === "recorded" && e.ended_on === null ? (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                      Ongoing
                    </span>
                  ) : null}
                  <span className="ml-auto text-xs text-slate-500">
                    {e.started_on}
                    {e.ended_on ? ` → ${e.ended_on}` : " → ongoing"}
                  </span>
                </div>
                <p className="mt-1 truncate text-sm text-slate-600">{e.description}</p>
                <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
                  {e.jobLabel ? <span>{e.jobLabel}</span> : null}
                  <span>
                    {e.working_days_lost !== null
                      ? `${e.working_days_lost} working day${e.working_days_lost === 1 ? "" : "s"} claimed`
                      : "days lost not yet claimed"}
                  </span>
                  {e.diary_entry_id ? <span>diary linked</span> : null}
                  {e.variation_quote_id ? <span>variation linked</span> : null}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

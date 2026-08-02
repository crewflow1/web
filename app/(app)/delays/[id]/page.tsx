import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgContext } from "@/server/auth/session";
import {
  getDelayEvent,
  listDiaryOptionsForJob,
  listVariationOptionsForJob,
} from "../_data";
import {
  closeDelayEvent,
  recordDelayEvent,
  updateDelayEvent,
  withdrawDelayEvent,
} from "../actions";
import { DelayEventFields, hintClass, inputClass, labelClass } from "../_form-fields";
import {
  DELAY_CATEGORY_LABELS,
  DELAY_STATUS_LABELS,
  isDelayCategory,
  openCompletions,
} from "@/lib/eot/lifecycle";

/**
 * /delays/[id] — one delay event.
 *
 * The page renders WHAT THE LIFECYCLE ALLOWS and nothing more:
 *   draft      the full edit form + "Record" (draft → recorded).
 *   recorded   a frozen read-only record + "Withdraw", plus the write-once
 *              completion form for whichever of ended_on / working_days_lost
 *              is still open (NULL → value only; the DB refuses the rest).
 *   withdrawn  the frozen record, plainly marked as retracted.
 *
 * ACTIVE-org pinned via the data layer: an event in a non-active org is
 * indistinguishable from a missing one (notFound).
 */

type Params = Promise<{ id: string }>;
type SP = Promise<{ saved?: string; error?: string }>;

const SAVED_MAP: Record<string, string> = {
  created: "Delay event drafted. Link its evidence, then record it.",
  updated: "Delay event saved.",
  recorded: "Delay event recorded. It is now frozen evidence — withdraw it if it was wrong.",
  withdrawn: "Delay event withdrawn. It stays visible as a retracted record.",
  completed: "Delay event completed.",
};

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{value}</dd>
    </div>
  );
}

export default async function DelayEventPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SP;
}) {
  const { ctx } = await requireOrgContext();
  const { id } = await params;
  const sp = await searchParams;

  const event = await getDelayEvent(ctx.org.id, id);
  if (!event) notFound();

  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;
  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;

  const categoryLabel = isDelayCategory(event.category)
    ? DELAY_CATEGORY_LABELS[event.category]
    : event.category;

  const completions = openCompletions({
    status: event.status,
    endedOn: event.ended_on,
    workingDaysLost: event.working_days_lost,
  });
  const canComplete = completions.endedOn || completions.workingDaysLost;

  const [diaryOptions, variationOptions] =
    event.status === "draft"
      ? await Promise.all([
          listDiaryOptionsForJob(ctx.org.id, event.job_id),
          listVariationOptionsForJob(ctx.org.id, event.job_id),
        ])
      : [null, null];

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/delays" className="hover:text-slate-900">
          Delays &amp; EOT
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">{categoryLabel}</span>
      </nav>

      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{categoryLabel} delay</h1>
          <p className="mt-1 text-sm text-slate-600">
            {event.jobLabel ?? "Job"} · {event.started_on}
            {event.ended_on ? ` → ${event.ended_on}` : " → ongoing"}
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
            event.status === "recorded"
              ? "bg-emerald-100 text-emerald-800"
              : event.status === "withdrawn"
                ? "bg-slate-100 text-slate-600"
                : "bg-slate-100 text-slate-700"
          }`}
        >
          {DELAY_STATUS_LABELS[event.status]}
        </span>
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

      {event.status === "withdrawn" ? (
        <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          This event was withdrawn{event.withdrawn_at ? ` on ${event.withdrawn_at.slice(0, 10)}` : ""}.
          It no longer forms part of the evidence pack, but the record it retracted stays
          visible below — evidence is retracted in the open, never erased.
        </p>
      ) : null}

      {event.status === "draft" ? (
        <>
          <form
            action={updateDelayEvent}
            className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
          >
            <input type="hidden" name="id" value={event.id} />
            <input type="hidden" name="jobId" value={event.job_id} />
            <DelayEventFields
              defaults={{
                category: event.category,
                startedOn: event.started_on,
                endedOn: event.ended_on,
                workingDaysLost: event.working_days_lost,
                description: event.description,
                diaryEntryId: event.diary_entry_id,
                variationQuoteId: event.variation_quote_id,
                weatherDistrict: event.weather_district,
              }}
              diaryOptions={diaryOptions}
              variationOptions={variationOptions}
            />
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="submit"
                className="inline-flex min-h-[44px] items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50"
              >
                Save draft
              </button>
            </div>
          </form>

          <form
            action={recordDelayEvent}
            className="rounded-xl border border-emerald-200 bg-emerald-50 p-5"
          >
            <input type="hidden" name="id" value={event.id} />
            <p className="text-sm font-medium text-emerald-900">Ready to record?</p>
            <p className="mt-1 text-xs text-emerald-800">
              Recording freezes this event as evidence: after that it can only be
              completed (end date / days claimed, once each) or withdrawn — never
              edited. Save any changes above first.
            </p>
            <button
              type="submit"
              className="mt-3 inline-flex min-h-[44px] items-center rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
            >
              Record delay event
            </button>
          </form>
        </>
      ) : (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Meta label="Category" value={categoryLabel} />
            <Meta
              label="Dates"
              value={`${event.started_on} → ${event.ended_on ?? "ongoing"}`}
            />
            <Meta
              label="Working days lost (claimed)"
              value={
                event.working_days_lost !== null
                  ? String(event.working_days_lost)
                  : "not yet claimed"
              }
            />
            <Meta
              label="Recorded"
              value={event.recorded_at ? event.recorded_at.slice(0, 10) : "—"}
            />
            <Meta
              label="Site diary entry"
              value={event.diary_entry_id ? "linked" : "not linked"}
            />
            <Meta
              label="Variation"
              value={event.variation_quote_id ? "linked" : "not linked"}
            />
            {event.weather_district ? (
              <Meta label="Postcode district" value={event.weather_district} />
            ) : null}
          </dl>
          <div className="mt-4 border-t border-slate-100 pt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              What happened
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">
              {event.description}
            </p>
          </div>
        </section>
      )}

      {event.status === "recorded" && canComplete ? (
        <form
          action={closeDelayEvent}
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <input type="hidden" name="id" value={event.id} />
          <h2 className="text-base font-semibold text-slate-900">Complete the record</h2>
          <p className="text-xs text-slate-500">
            Each field can be set once, then it is frozen with the rest of the record.
          </p>
          {completions.endedOn ? (
            <div>
              <label htmlFor="endedOn" className={labelClass}>
                Ended on
              </label>
              <input id="endedOn" name="endedOn" type="date" className={inputClass} />
            </div>
          ) : null}
          {completions.workingDaysLost ? (
            <div>
              <label htmlFor="workingDaysLost" className={labelClass}>
                Working days lost (your claim)
              </label>
              <input
                id="workingDaysLost"
                name="workingDaysLost"
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                className={inputClass}
              />
              <p className={hintClass}>Your assessment, not a calculation.</p>
            </div>
          ) : null}
          <button
            type="submit"
            className="inline-flex min-h-[44px] items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            Save completion
          </button>
        </form>
      ) : null}

      {event.status === "recorded" ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Contractual notice</h2>
          <p className="mt-1 text-xs text-slate-600">
            Generate a draft notice of delay from this recorded event — the parties, dates,
            cause and linked evidence, filled only from what is on the record. Fields the
            record doesn&apos;t hold (contract reference, clause, completion date) print as{" "}
            <span className="font-medium">[not specified]</span> for you to complete. It is a
            draft for review, not a determination of entitlement.
          </p>
          <a
            href={`/api/delays/${event.id}/notice/pdf`}
            className="mt-3 inline-flex min-h-[44px] items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50"
          >
            Generate EOT notice (PDF)
          </a>
        </section>
      ) : null}

      {event.status === "recorded" ? (
        <form
          action={withdrawDelayEvent}
          className="rounded-xl border border-amber-200 bg-amber-50 p-5"
        >
          <input type="hidden" name="id" value={event.id} />
          <p className="text-sm font-medium text-amber-900">Withdraw this event?</p>
          <p className="mt-1 text-xs text-amber-800">
            Withdrawal retracts it from the evidence pack without erasing it. The
            record stays visible, marked withdrawn. This cannot be undone — log a new
            event if the delay was real after all.
          </p>
          <button
            type="submit"
            className="mt-3 inline-flex min-h-[44px] items-center rounded-md border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100"
          >
            Withdraw
          </button>
        </form>
      ) : null}

      <p className="text-xs text-slate-500">
        The full evidence pack for this job —{" "}
        <Link href={`/jobs/${event.job_id}`} className="underline hover:text-slate-800">
          open the job
        </Link>{" "}
        and see the Delays &amp; EOT panel.
      </p>
    </div>
  );
}

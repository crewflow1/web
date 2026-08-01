import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { loadEotEvidencePack } from "@/server/services/eot-pack";
import { DELAY_STATUS_LABELS } from "@/lib/eot/lifecycle";

/**
 * Job Delays & EOT panel — the per-job evidence position on the job hub.
 * Shape and contract follow _job-quality.tsx exactly.
 *
 * Reads via server/services/eot-pack.ts: ACTIVE-org pinned (RLS is the outer
 * boundary, not the scope: `current_org_ids()` spans every org a dual-org
 * member belongs to).
 *
 * LOUD READ, panel-scoped. This panel's whole job is to say whether the
 * evidence for a future extension-of-time claim is in order, so an empty
 * render on a FAILED read would assert "no delays, nothing missing" — a
 * control failing open on an evidence surface. It renders an EXPLICIT error
 * block instead, never the quiet nothing.
 *
 * Renders nothing when the job genuinely has no delay events.
 */

export async function JobDelaysSection({ jobId }: { jobId: string }) {
  const { ctx } = await requireOrgContext();
  const { pack, failed } = await loadEotEvidencePack(ctx.org.id, jobId);

  if (failed) {
    return (
      <section className="rounded-xl border border-red-200 bg-red-50 p-6 shadow-sm">
        <h2 className="text-base font-semibold text-red-800">Delays &amp; EOT</h2>
        <p className="mt-1 text-sm text-red-700">
          Couldn&apos;t load the delay evidence for this job. This panel is NOT saying
          there are no delays — refresh to try again.
        </p>
      </section>
    );
  }

  const totalEvents =
    pack.recordedEventCount + pack.draftEventCount + pack.withdrawnEventCount;
  if (totalEvents === 0) return null;

  const ongoing = pack.categories
    .flatMap((c) => c.events)
    .filter((e) => e.endedOn === null).length;

  return (
    <section
      aria-labelledby="job-delays-heading"
      className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="job-delays-heading" className="text-base font-semibold text-slate-900">
          Delays &amp; EOT
        </h2>
        <span className="text-xs text-slate-500">
          {pack.recordedEventCount} recorded
          {pack.draftEventCount > 0 ? ` · ${pack.draftEventCount} draft` : ""}
          {pack.withdrawnEventCount > 0 ? ` · ${pack.withdrawnEventCount} withdrawn` : ""}
        </span>
      </div>

      {ongoing > 0 ? (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
          {ongoing} delay{ongoing === 1 ? "" : "s"} still ongoing on this job.
        </p>
      ) : null}

      {pack.categories.length > 0 ? (
        <ul className="mt-4 divide-y divide-slate-100 text-sm">
          {pack.categories.map((block) => (
            <li key={block.category} className="flex flex-wrap items-center gap-x-2 py-2.5">
              <span className="min-w-0 flex-1 truncate text-slate-800">{block.label}</span>
              <span className="text-xs text-slate-600">
                {block.events.length} event{block.events.length === 1 ? "" : "s"}
              </span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                {block.claimedWorkingDaysLost} day
                {block.claimedWorkingDaysLost === 1 ? "" : "s"} claimed
                {block.unquantifiedEvents > 0 ? ` (+${block.unquantifiedEvents} unquantified)` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-slate-600">
          No recorded delay events yet — only {DELAY_STATUS_LABELS.draft.toLowerCase()}/
          {DELAY_STATUS_LABELS.withdrawn.toLowerCase()} ones exist. Evidence starts when
          an event is recorded.
        </p>
      )}

      {pack.gaps.length > 0 ? (
        <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-xs font-semibold text-slate-700">
            Evidence gaps ({pack.gaps.length})
          </p>
          <ul className="mt-1 list-inside list-disc text-xs text-slate-600">
            {pack.gaps.slice(0, 4).map((g, i) => (
              <li key={`${g.kind}-${g.eventId ?? "job"}-${i}`}>{g.message}</li>
            ))}
            {pack.gaps.length > 4 ? <li>…and {pack.gaps.length - 4} more.</li> : null}
          </ul>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <Link
          href={`/delays/new?jobId=${jobId}`}
          className="font-medium text-slate-900 underline hover:text-slate-700"
        >
          Log a delay
        </Link>
        <Link href="/delays" className="text-slate-600 underline hover:text-slate-900">
          Open the register
        </Link>
        {pack.recordedEventCount > 0 ? (
          <a
            href={`/api/jobs/${jobId}/eot-pack/pdf`}
            className="text-slate-600 underline hover:text-slate-900"
          >
            Evidence pack (PDF)
          </a>
        ) : null}
      </div>
    </section>
  );
}

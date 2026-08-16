import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { loadJobForOrg } from "@/lib/jobs/load";
import { loadJobSiteTimelineStrict } from "@/server/services/job-site-hub";
import { SITE_EVENT_KIND_META } from "@/lib/site-ops/timeline";
import { EmptyState } from "../../../_components/empty-state";
import { TimelineDayGroups } from "../_timeline-feed";

export const dynamic = "force-dynamic";

export const metadata = { title: "Site timeline · CrewFlow" };

/**
 * /jobs/[id]/timeline — the full site works timeline for one job.
 *
 * The chronological record of everything that happened on this site: diary,
 * delays, snags, toolbox talks, RAMS + permits, plant inspections, site reports,
 * drawing revisions and uploads — assembled from the existing registers, newest
 * first. The job page carries a compact preview of the same feed; this is the
 * complete view.
 *
 * A read-model, not a new store: every row already lives in a vertical that owns
 * it and links back there. Ordering/labelling is the pure composer
 * (lib/site-ops/timeline.ts); the reads are org-pinned + job-pinned, fully paged
 * (F-1) and LOUD (loadJobSiteTimelineStrict throws rather than render an empty
 * feed on a failed read).
 *
 * ORG-PINNED: loadJobForOrg constrains the job to the active org, so another
 * org's job (that a dual-org member could also see under RLS) is indistinguishable
 * from a missing one — the timeline reads are pinned to the same org id.
 */
export default async function JobTimelinePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const job = await loadJobForOrg<{
    id: string;
    customer: { name: string } | { name: string }[] | null;
  }>(supabase, id, ctx.org.id, "id, customer:customers ( name )");
  if (!job) notFound();

  const customer = Array.isArray(job.customer) ? job.customer[0] : job.customer;
  const jobLabel = customer?.name ?? "Job";

  const { events, total } = await loadJobSiteTimelineStrict(ctx.org.id, job.id);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
        <Link href="/jobs" className="hover:text-slate-900">
          Jobs
        </Link>
        <span aria-hidden>/</span>
        <Link href={`/jobs/${job.id}`} className="truncate hover:text-slate-900">
          {jobLabel}
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Timeline</span>
      </nav>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">Site timeline</h1>
        <p className="mt-1 text-sm text-slate-600">
          Everything that happened on this job, newest first — diary, delays,
          snags, safety, reports, drawings and uploads. Each entry links back to
          the record that owns it.
        </p>
      </header>

      {events.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="🗓️"
            title="Nothing recorded yet"
            body="As you log diary entries, snags, delays, safety talks, reports and drawings against this job, they appear here as one chronological record."
            primary={{ href: `/jobs/${job.id}`, label: "Back to the job" }}
          />
        </div>
      ) : (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <p className="mb-4 text-xs text-slate-500">
            {total} {total === 1 ? "event" : "events"}
          </p>
          <TimelineDayGroups events={events} />
        </section>
      )}

      <p className="text-xs text-slate-500">
        Kinds shown:{" "}
        {Object.values(SITE_EVENT_KIND_META)
          .map((m) => m.label)
          .join(" · ")}
        .
      </p>
    </div>
  );
}

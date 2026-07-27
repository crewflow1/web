import Link from "next/link";
import { listBlueprints } from "@/server/services/blueprints";

/**
 * Compact "Drawings" teaser on the job page — count + a link to the dedicated
 * /jobs/[id]/blueprints register. Its OWN fetch + one mount line, kept out of the
 * job page's Promise.all so it never blocks first paint (the job page is already
 * large). The register itself is the wide, full experience.
 */
export async function JobBlueprintsPanel({ jobId }: { jobId: string }) {
  const blueprints = await listBlueprints(jobId);
  const withCurrent = blueprints.filter((b) => b.current_version != null).length;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Drawings</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {blueprints.length === 0
              ? "No drawings yet — keep the site team on the current revision."
              : `${blueprints.length} drawing${blueprints.length === 1 ? "" : "s"}${withCurrent < blueprints.length ? " · some awaiting a file" : ""}.`}
          </p>
        </div>
        <Link href={`/jobs/${jobId}/blueprints`} className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800">
          {blueprints.length === 0 ? "Add drawings" : "View drawings"}
        </Link>
      </div>
    </section>
  );
}

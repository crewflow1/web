import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { listWorkerLinks, listJobOptions, type WorkerLinkRow } from "./_data";
import { IssueWorkerLinkForm } from "./_issue-form";
import { RevokeForm } from "./_revoke-form";
import { issueWorkerLink, revokeWorkerLink } from "./actions";

/**
 * /health-safety/worker-links — issue and revoke external-worker H&S sign-off
 * links. A link is scoped to ONE job; the worker who opens it can read and sign
 * that job's issued RAMS, permits and toolbox talks, and nothing else. The
 * plaintext token is shown ONCE at creation and stored only as a hash.
 */

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" });

const STATE_STYLES: Record<WorkerLinkRow["state"], string> = {
  live: "bg-emerald-100 text-emerald-800",
  expired: "bg-slate-100 text-slate-600",
  revoked: "bg-red-100 text-red-800",
};
const STATE_LABEL: Record<WorkerLinkRow["state"], string> = {
  live: "Live",
  expired: "Expired",
  revoked: "Revoked",
};

export default async function WorkerLinksPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const [links, jobs] = await Promise.all([
    listWorkerLinks(ctx.org.id),
    listJobOptions(ctx.org.id),
  ]);

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-6">
      <div>
        <Link href="/health-safety" className="text-xs text-slate-500 hover:text-slate-900">
          ← Health &amp; Safety
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">Worker sign-off links</h1>
        <p className="mt-1 text-sm text-slate-600">
          Give a subcontractor or external operative a secure link to read and sign this
          job&apos;s risk assessments, permits and toolbox talks. No login required; links
          expire and can be revoked at any time.
        </p>
      </div>

      {sp.saved === "revoked" ? (
        <div role="status" className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          Link revoked. It can no longer be used to reach any documents.
        </div>
      ) : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Issue a new link</h2>
        <p className="mt-1 text-sm text-slate-600">The link is a one-time secret — copy it as soon as it&apos;s created.</p>
        <div className="mt-4">
          <IssueWorkerLinkForm action={issueWorkerLink} jobs={jobs} />
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-900">Issued links</h2>
        </div>
        {links.length === 0 ? (
          <p className="px-6 py-8 text-sm text-slate-500">No worker links issued yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {links.map((l) => (
              <li key={l.id} className="flex flex-wrap items-start justify-between gap-3 px-6 py-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-900">{l.workerName}</span>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATE_STYLES[l.state]}`}>
                      {STATE_LABEL[l.state]}
                    </span>
                  </div>
                  <p className="mt-0.5 text-sm text-slate-600">
                    {l.workerCompany ? `${l.workerCompany} · ` : ""}
                    {l.jobLabel}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {l.state === "revoked" && l.revokedAt
                      ? `Revoked ${dateFmt.format(new Date(l.revokedAt))}`
                      : `Expires ${dateFmt.format(new Date(l.expiresAt))}`}
                    {" · "}
                    {l.signedCount} signed
                    {l.lastUsedAt ? ` · last opened ${dateFmt.format(new Date(l.lastUsedAt))}` : ""}
                  </p>
                </div>
                {l.state === "live" ? <RevokeForm action={revokeWorkerLink} tokenId={l.id} /> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

import Link from "next/link";
import { loadCustomerByPortalToken } from "../../_helpers";
import { listPortalPhotos } from "../../_photos";
import { PortalShell } from "../_shell";
import { InvalidLinkPage } from "@/app/_components/invalid-link";

export const metadata = { title: "Photos · CrewFlow" };

/**
 * Customer portal — Photos.
 *
 * ONLY photos published to this customer: attachment ids frozen inside their
 * own PUBLISHED site-report snapshots (see _photos.ts for the full scoping
 * chain). This page takes no id parameter of any kind — there is nothing for
 * a crafted URL to vary — and every image src is a short-lived signed URL
 * derived server-side from a verified attachment row.
 */
export default async function PortalPhotosPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) return <InvalidLinkPage kind="portal" />;
  const { customer, org } = loaded;

  const groups = await listPortalPhotos(customer.id, customer.org_id);

  return (
    <PortalShell customer={customer} org={org} token={token} active="photos">
      <header className="space-y-1">
        <h2 className="text-xl font-bold text-slate-900">Photos</h2>
        <p className="text-sm text-slate-600">
          Site photos {org.name} has shared with you through progress reports.
        </p>
      </header>

      {groups.length === 0 ? (
        <section className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <p className="text-3xl">📷</p>
          <p className="mt-2 text-sm font-medium text-slate-900">
            No photos shared yet
          </p>
          <p className="mt-1 text-xs text-slate-500">
            When {org.name} publishes a progress report that includes site
            photos, they&apos;ll appear here.
          </p>
        </section>
      ) : (
        groups.map((g) => (
          <section
            key={g.report_id}
            className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">
                {g.report_title}
              </h3>
              <span className="text-[11px] text-slate-500">
                {g.report_number ? `${g.report_number} · ` : ""}
                {g.published_on ? `Shared ${g.published_on}` : ""}
              </span>
            </div>
            <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {g.photos.map((p, i) => (
                <li key={p.id}>
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block overflow-hidden rounded-lg border border-slate-200"
                  >
                    {/* Signed URLs expire in seconds — next/image's cached
                        optimiser would re-fetch after expiry and 400. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={p.url}
                      alt={`Site photo ${i + 1} from ${g.report_title}`}
                      loading="lazy"
                      className="aspect-square w-full object-cover"
                    />
                  </a>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] text-slate-500">
              <Link
                href={`/customer-portal/${token}/reports/${g.report_id}`}
                className="font-medium text-slate-700 underline decoration-slate-300 underline-offset-2 hover:text-slate-900"
              >
                View the report these photos came from →
              </Link>
            </p>
          </section>
        ))
      )}
    </PortalShell>
  );
}

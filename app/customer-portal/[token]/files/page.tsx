import { loadCustomerByPortalToken } from "../../_helpers";
import {
  listCustomerFiles,
  customerFileSignedUrl,
} from "../../_customer-files";
import { uploadCustomerFile } from "../../_customer-file-action";
import { PortalShell } from "../_shell";
import { InvalidLinkPage } from "@/app/_components/invalid-link";

/**
 * Customer portal — "Send us a file".
 *
 * A general upload surface (not tied to an invoice) plus a read-back of the
 * files this customer has already sent. Both the list and the per-file view link
 * are scoped by customer_id + org_id + kind (listCustomerFiles /
 * customerFileSignedUrl), so a customer only ever sees their OWN submissions.
 */

const DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const ERRORS: Record<string, string> = {
  no_file: "Please choose a file to upload.",
  file_too_large: "That file is over the 10 MB limit.",
  bad_file_type: "Only PDF, JPG, PNG, WebP or HEIC files are accepted.",
  invalid_token: "Your link is no longer valid — please ask for a new one.",
  upload_failed: "The upload didn't complete. Please try again.",
  record_failed: "We couldn't save that file. Please try again.",
};

function humanSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function PortalFilesPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { token } = await params;
  const { error, saved } = await searchParams;
  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) return <InvalidLinkPage kind="portal" />;
  const { customer, org } = loaded;

  const files = await listCustomerFiles(customer.id, customer.org_id);
  const withUrls = await Promise.all(
    files.map(async (f) => ({
      ...f,
      url: await customerFileSignedUrl(f.id, customer.id, customer.org_id),
    })),
  );

  const errorMsg = error ? (ERRORS[error] ?? error) : null;

  return (
    <PortalShell customer={customer} org={org} token={token} active="files">
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold text-slate-900">Send us a file</h2>
        <p className="mt-1 text-sm text-slate-500">
          Share a document or photo with {org.name} — a spec, a signed form, or a
          site photo. PDF, JPG, PNG, WebP or HEIC, up to 10 MB.
        </p>

        {saved ? (
          <p className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">
            Thanks — your file was sent to {org.name}.
          </p>
        ) : null}
        {errorMsg ? (
          <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-800">
            {errorMsg}
          </p>
        ) : null}

        <form action={uploadCustomerFile} className="mt-4 space-y-3">
          <input type="hidden" name="token" value={token} />
          <div>
            <label htmlFor="file" className="block text-xs font-medium text-slate-700">
              File
            </label>
            <input
              id="file"
              name="file"
              type="file"
              required
              accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif"
              className="mt-1 block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-slate-800"
            />
          </div>
          <div>
            <label htmlFor="notes" className="block text-xs font-medium text-slate-700">
              Note (optional)
            </label>
            <textarea
              id="notes"
              name="notes"
              rows={2}
              maxLength={500}
              placeholder="Anything we should know about this file?"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </div>
          <button
            type="submit"
            className="inline-flex min-h-[44px] items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
          >
            Send file
          </button>
        </form>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold text-slate-900">
          Files you&apos;ve sent
        </h2>
        {withUrls.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            You haven&apos;t sent any files yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {withUrls.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-900">
                    {f.filename}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {DATE.format(new Date(f.uploaded_at))}
                    {humanSize(f.size_bytes) ? ` · ${humanSize(f.size_bytes)}` : ""}
                  </p>
                  {f.notes ? (
                    <p className="mt-1 text-xs text-slate-600">{f.notes}</p>
                  ) : null}
                </div>
                {f.url ? (
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    View
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </PortalShell>
  );
}

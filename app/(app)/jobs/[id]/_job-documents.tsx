import {
  listJobDocuments,
  listJobDocumentVersions,
  JOB_DOC_TYPES,
  JOB_DOC_ALLOWED_MIME,
  JOB_DOC_MAX_BYTES,
  type JobDocumentRow,
  type JobDocumentVersionRow,
} from "@/server/services/job-documents";
import { requireOrgContext } from "@/server/auth/session";
import { NewDocumentForm, DocumentRow } from "./_job-documents-client";

/**
 * P4 Job Documents — server panel (PR-B).
 *
 * Server component mounted on the Job Detail page. It fetches the document
 * rows + their version history server-side (so the list is correct on every
 * load and after revalidatePath) and renders two areas:
 *
 *   • Staff documents   — team-wide; everyone can list/upload/version/complete.
 *   • Private documents  — owner/admin get full access; staff get a write-only
 *                          drop box (upload, no read).
 *
 * SECURITY (hard requirement): "staff must never receive private document data
 * in the payload." We enforce that by gating the FETCH, not just the render —
 * see `privateDocs` below. This is defence-in-depth on top of the service's
 * RLS, which already returns [] to staff for private docs.
 *
 * The service module is `server-only`; its runtime constants (allowed MIME
 * list, max size, doc types) are resolved here and handed to the client form
 * as props so they never get pulled into the client bundle.
 */

const ACCEPT = Array.from(JOB_DOC_ALLOWED_MIME).join(",");
const DOC_TYPES: readonly string[] = [...JOB_DOC_TYPES];

type DocWithVersions = {
  doc: JobDocumentRow;
  versions: JobDocumentVersionRow[];
};

async function loadArea(
  jobId: string,
  area: "staff" | "private",
): Promise<DocWithVersions[]> {
  const docs = await listJobDocuments(jobId, area);
  return Promise.all(
    docs.map(async (doc) => ({
      doc,
      versions: await listJobDocumentVersions(doc.id),
    })),
  );
}

export async function JobDocumentsPanel({
  jobId,
  canViewPrivate,
}: {
  jobId: string;
  canViewPrivate: boolean;
}) {
  // Auth gate for the panel itself (redirects guests). The service functions
  // below re-derive org/role too, so this never widens access.
  await requireOrgContext();

  const staff = await loadArea(jobId, "staff");

  // SECURITY: when the viewer can't see private docs we never even call
  // listJobDocuments(.., "private") — so no private row is ever serialised
  // into the staff RSC payload. Do NOT "optimise" this into an
  // always-fetch-then-hide; the gate must stay on the fetch.
  const privateDocs = canViewPrivate ? await loadArea(jobId, "private") : null;

  return (
    <>
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">
          Staff documents
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Certificates, test sheets and reports for this job. Visible to the
          whole team.
        </p>

        {staff.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No documents yet.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {staff.map(({ doc, versions }) => (
              <DocumentRow
                key={doc.id}
                doc={doc}
                versions={versions}
                jobId={jobId}
                accept={ACCEPT}
                maxBytes={JOB_DOC_MAX_BYTES}
                canDelete={canViewPrivate}
              />
            ))}
          </ul>
        )}

        <div className="mt-4 border-t border-slate-100 pt-4">
          <h3 className="text-sm font-semibold text-slate-800">
            Add a document
          </h3>
          <NewDocumentForm
            jobId={jobId}
            visibility="staff"
            docTypes={DOC_TYPES}
            accept={ACCEPT}
            maxBytes={JOB_DOC_MAX_BYTES}
          />
        </div>
      </section>

      <section className="rounded-xl border border-amber-200 bg-amber-50/40 p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-slate-900">
            Private documents
          </h2>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
            Office only
          </span>
        </div>

        {canViewPrivate ? (
          <>
            <p className="mt-1 text-sm text-slate-600">
              Owner and admins only. The team can drop files here but can’t see
              what’s inside.
            </p>

            {privateDocs && privateDocs.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">No documents yet.</p>
            ) : (
              <ul className="mt-4 space-y-3">
                {(privateDocs ?? []).map(({ doc, versions }) => (
                  <DocumentRow
                    key={doc.id}
                    doc={doc}
                    versions={versions}
                    jobId={jobId}
                    accept={ACCEPT}
                    maxBytes={JOB_DOC_MAX_BYTES}
                    canDelete
                  />
                ))}
              </ul>
            )}

            <div className="mt-4 border-t border-amber-200 pt-4">
              <h3 className="text-sm font-semibold text-slate-800">
                Add a private document
              </h3>
              <NewDocumentForm
                jobId={jobId}
                visibility="private"
                docTypes={DOC_TYPES}
                accept={ACCEPT}
                maxBytes={JOB_DOC_MAX_BYTES}
              />
            </div>
          </>
        ) : (
          // Staff drop box: upload-only. No list is fetched or rendered, so the
          // team never receives private document data.
          <>
            <p className="mt-1 text-sm text-slate-600">
              Send a file straight to the office. Once sent it’s hidden from the
              team — only the owner and admins can open it.
            </p>
            <NewDocumentForm
              jobId={jobId}
              visibility="private"
              docTypes={DOC_TYPES}
              accept={ACCEPT}
              maxBytes={JOB_DOC_MAX_BYTES}
              dropbox
            />
          </>
        )}
      </section>
    </>
  );
}

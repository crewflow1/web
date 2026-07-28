import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { loadJobForOrg } from "@/lib/jobs/load";
import { ConfirmForm } from "@/components/forms/ConfirmForm";
import { CertificateForm } from "./_form";
import { issueCertificate, publishCertificate, withdrawCertificate } from "./actions";
import {
  CERT_STATUS_LABELS,
  CERT_STATUS_STYLES,
  type CertContent,
  type CertStatus,
} from "@/lib/completion-certificates/schema";

const ERROR_COPY: Record<string, string> = {
  denied: "Only owners/admins can manage completion certificates.",
  not_completed: "Mark the job complete before issuing a certificate.",
  incomplete: "The draft is missing required details.",
  already_issued: "This certificate has already been issued.",
  create_failed: "Couldn't create the certificate. Try again.",
  issue_failed: "Couldn't issue the certificate. Try again.",
};
const SAVED_COPY: Record<string, string> = {
  created: "Draft certificate created.",
  issued: "Certificate issued.",
  published: "Published to the customer portal.",
  withdrawn: "Withdrawn from the customer portal.",
};

type CertRow = {
  id: string;
  status: string;
  certificate_number: string;
  completion_date: string;
  content: CertContent | null;
  portal_published_at: string | null;
  portal_withdrawn_at: string | null;
  issued_at: string | null;
};

export default async function JobCertificatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { id } = await params;
  const { error, saved } = await searchParams;

  const { ctx } = await requireOrgContext();
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  const supabase = await createClient();

  const jobRow = await loadJobForOrg<{
    id: string;
    status: string;
    customer_id: string | null;
  }>(supabase, id, ctx.org.id, "id, status, customer_id");
  if (!jobRow) notFound();

  const { data: cert } = await (
    supabase.from("completion_certificates" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          order: (k: string, o: { ascending: boolean }) => { limit: (n: number) => { maybeSingle: () => Promise<{ data: CertRow | null }> } };
        };
      };
    }
  )
    .select("id, status, certificate_number, completion_date, content, portal_published_at, portal_withdrawn_at, issued_at")
    .eq("job_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const status = (cert?.status ?? null) as CertStatus | null;
  const published = Boolean(cert?.portal_published_at && !cert?.portal_withdrawn_at);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href={`/jobs/${id}`} className="hover:text-slate-900">Job</Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Completion certificate</span>
      </div>

      {error ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {ERROR_COPY[error] ?? "Something went wrong."}
        </div>
      ) : null}
      {saved ? (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {SAVED_COPY[saved] ?? "Saved."}
        </div>
      ) : null}

      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Completion certificate</h1>
          <p className="mt-0.5 text-sm text-slate-500">Practical Completion Certificate for this job.</p>
        </div>
        {status ? (
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${CERT_STATUS_STYLES[status]}`}>
            {CERT_STATUS_LABELS[status]}
          </span>
        ) : null}
      </header>

      {!cert ? (
        jobRow.status !== "completed" ? (
          <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
            Mark the job <strong>complete</strong> to issue a completion certificate.
          </section>
        ) : !isAdmin ? (
          <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
            No certificate yet. An owner or admin can issue one.
          </section>
        ) : (
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-base font-semibold text-slate-900">Issue a completion certificate</h2>
            <CertificateForm jobId={id} defaults={{ defects_liability_months: 12 }} />
          </section>
        )
      ) : (
        <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Number</dt>
              <dd className="font-medium text-slate-900">{cert.certificate_number}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Practical completion</dt>
              <dd className="font-medium text-slate-900">{cert.completion_date}</dd>
            </div>
          </dl>
          {cert.content?.works_description ? (
            <p className="whitespace-pre-wrap border-t border-slate-100 pt-3 text-sm text-slate-600">
              {cert.content.works_description}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
            <a
              href={`/api/completion-certificates/${cert.id}/pdf`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Download completion certificate ${cert.certificate_number} (PDF, opens in a new tab)`}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              {status === "draft" ? "Preview PDF" : "Download PDF"}
            </a>

            {isAdmin && status === "draft" ? (
              <ConfirmForm
                action={issueCertificate.bind(null, id, cert.id)}
                confirm="Issue this certificate? Once issued its content is frozen."
              >
                <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800">
                  Issue certificate
                </button>
              </ConfirmForm>
            ) : null}

            {isAdmin && status === "issued" ? (
              published ? (
                <form action={withdrawCertificate.bind(null, id, cert.id)}>
                  <button type="submit" className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
                    Withdraw from portal
                  </button>
                </form>
              ) : (
                <form action={publishCertificate.bind(null, id, cert.id)}>
                  <button type="submit" className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">
                    Publish to customer portal
                  </button>
                </form>
              )
            ) : null}

            {status === "issued" ? (
              <span className="text-xs text-slate-500">
                {published ? "Visible to the customer in their portal." : "Not yet shared with the customer."}
              </span>
            ) : null}
          </div>
        </section>
      )}
    </div>
  );
}

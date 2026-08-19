import { loadWorkerSession } from "../_loader";
import { loadWorkerMaterials, type WorkerMaterial } from "../_materials";
import { acknowledgeAsWorker } from "./actions";
import { InvalidLinkPage } from "@/app/_components/invalid-link";
import { SignaturePad } from "@/app/_components/signature-pad";
import { ACK_SUBJECT_LABELS, ackStatement } from "@/lib/health-safety/acknowledgements";

/**
 * External worker H&S sign-off portal.
 *
 * Reached via the opaque /worker-portal/<token> link. The route is public in
 * middleware so an anonymous worker hits it without a redirect. ALL access is
 * gated by loadWorkerSession — the single authority — and every material read is
 * scoped to the token's own org + job. No login, no session, no membership.
 */

const SUBJECT_ORDER: Record<WorkerMaterial["subjectType"], number> = {
  risk_assessment: 0,
  permit_to_work: 1,
  toolbox_talk: 2,
};

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

type SP = Promise<{ error?: string; saved?: string }>;

export default async function WorkerPortalPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: SP;
}) {
  const { token } = await params;
  const sp = await searchParams;

  const session = await loadWorkerSession(token);
  if (!session) return <InvalidLinkPage kind="portal" />;

  const materials = await loadWorkerMaterials(
    session.token.org_id,
    session.token.job_id,
    session.token.id,
  );
  materials.sort(
    (a, b) => SUBJECT_ORDER[a.subjectType] - SUBJECT_ORDER[b.subjectType] || a.reference.localeCompare(b.reference),
  );

  const outstanding = materials.filter((m) => !m.acknowledged).length;
  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;
  const justSigned = sp.saved === "signed";

  const jobLabel = session.job.customer_name
    ? `${session.job.customer_name}`
    : "Assigned job";

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-8">
      <div className="mx-auto max-w-3xl space-y-6">
        {/* Header / brand */}
        <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Health &amp; Safety sign-off
              </div>
              <h1 className="mt-1 text-2xl font-bold text-slate-900">{jobLabel}</h1>
              <p className="mt-1 text-sm text-slate-600">
                From <span className="font-medium text-slate-900">{session.org.name}</span>
                {session.job.scheduled_date
                  ? ` · Scheduled ${dateFmt.format(new Date(session.job.scheduled_date))}`
                  : ""}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                For {session.token.worker_name}
                {session.token.worker_company ? ` · ${session.token.worker_company}` : ""}
              </p>
            </div>
            {session.org.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={session.org.logo_url}
                alt={`${session.org.name} logo`}
                className="h-12 w-auto shrink-0 object-contain"
              />
            ) : null}
          </div>
          <p className="mt-4 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Read each document below and sign to confirm you understand it before
            starting work. Your name, the time, and your device are recorded as an
            immutable safety record. This link expires on{" "}
            {dateFmt.format(new Date(session.token.expires_at))}.
          </p>
        </header>

        {errorMessage ? (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMessage}
          </div>
        ) : null}
        {justSigned ? (
          <div role="status" className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
            <strong>Signed.</strong> Your acknowledgement has been recorded.
            {outstanding > 0 ? ` ${outstanding} document${outstanding === 1 ? "" : "s"} still to sign.` : " Everything on this job is signed off — thank you."}
          </div>
        ) : null}

        {materials.length === 0 ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
            There are no health &amp; safety documents to sign for this job yet.
            {session.org.phone ? ` If you were expecting some, call ${session.org.name} on ${session.org.phone}.` : ""}
          </section>
        ) : (
          <ul className="space-y-4">
            {materials.map((m) => (
              <li
                key={`${m.subjectType}:${m.subjectId}`}
                className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 bg-slate-50 px-6 py-4">
                  <div className="min-w-0">
                    <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                      {ACK_SUBJECT_LABELS[m.subjectType]} · {m.reference}
                    </div>
                    <h2 className="mt-1 text-base font-semibold text-slate-900">{m.title}</h2>
                    {m.meta ? <p className="mt-0.5 text-sm text-slate-600">{m.meta}</p> : null}
                  </div>
                  {m.acknowledged ? (
                    <span className="shrink-0 rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-800">
                      Signed{m.acknowledgedAt ? ` ${dateFmt.format(new Date(m.acknowledgedAt))}` : ""}
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800">
                      Awaiting signature
                    </span>
                  )}
                </div>

                {m.acknowledged ? (
                  <div className="px-6 py-4 text-sm text-slate-600">
                    You have confirmed you read and understood this {ACK_SUBJECT_LABELS[m.subjectType]}.
                  </div>
                ) : (
                  <form action={acknowledgeAsWorker.bind(null, token)} className="space-y-3 px-6 py-5">
                    <input type="hidden" name="subjectType" value={m.subjectType} />
                    <input type="hidden" name="subjectId" value={m.subjectId} />
                    <input type="hidden" name="subjectVersion" value={m.reference} />
                    <p className="text-sm text-slate-700">{ackStatement(m.subjectType, m.reference)}</p>
                    <div>
                      <label htmlFor={`name-${m.subjectId}`} className="block text-sm font-medium text-slate-800">
                        Your full name (this is your signature)
                      </label>
                      <input
                        id={`name-${m.subjectId}`}
                        type="text"
                        name="signedName"
                        required
                        placeholder="e.g. Alex Smith"
                        autoComplete="name"
                        className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-lg focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                        style={{ fontFamily: 'ui-serif, Georgia, "Times New Roman", serif', fontStyle: "italic" }}
                      />
                    </div>
                    <SignaturePad
                      name="signatureDataUrl"
                      label="Draw your signature (optional)"
                      hint="Optional — adds a handwritten signature image alongside your typed name."
                    />
                    <button
                      type="submit"
                      className="rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
                    >
                      Sign &amp; confirm
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}

        <footer className="pt-4 text-center text-xs text-slate-600">Powered by CrewFlow</footer>
      </div>
    </div>
  );
}

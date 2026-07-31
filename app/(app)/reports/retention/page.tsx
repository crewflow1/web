import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgContext } from "@/server/auth/session";
import { buildRetentionRegisterView } from "@/server/services/retention-register";
import {
  RETENTION_LINE_STATE_LABEL,
  retentionClaimableNow,
  type CompletionSource,
  type RetentionLineState,
  type RetentionRegisterLine,
} from "@/lib/commercial/retention-register";
import { formatGbp } from "@/lib/money";
import { formatDateShortUK } from "@/lib/time/format";
import { Badge, StatTile, Table, THead, TBody, TR, TH, TD, type Tone } from "@/components/ui";
import { EmptyState } from "../../_components/empty-state";

export const dynamic = "force-dynamic";

export const metadata = { title: "Retention register · CrewFlow" };

/**
 * /reports/retention — THE RETENTION REGISTER.
 *
 * Every pound of retention the business is owed, across every job, with the
 * contractual date entitling each release. This is the page a contractor prints
 * and takes to a client meeting, so it leads with the money that is claimable
 * NOW and names the evidence — a certificate number where one exists.
 *
 * Read-only. Staff are redirected: retention is a commercial holdback and the
 * rate, certified base and moiety split are operator-side facts, exactly as
 * every other retention surface treats them.
 */

const STATE_TONE: Record<RetentionLineState, Tone> = {
  overdue: "red",
  due: "amber",
  held: "blue",
  awaiting_completion: "slate",
  released: "emerald",
};

/** How much weight the date carries. Never dress up a typed-in date as evidence. */
const SOURCE_NOTE: Record<CompletionSource, string> = {
  certificate: "Certified",
  job: "Job record",
  none: "Not set",
};

/**
 * What backs this line's date. Named once and rendered in BOTH the wide layout
 * and the phone fallback, so the two can never disagree about the evidence.
 */
function evidenceNote(line: RetentionRegisterLine): string {
  if (line.completionSource === "certificate" && line.certificateNumber) {
    return `Certified · ${line.certificateNumber}`;
  }
  return SOURCE_NOTE[line.completionSource];
}

function DateCell({ line }: { line: RetentionRegisterLine }) {
  if (!line.dueDate) {
    return <span className="text-slate-500">No completion date</span>;
  }
  return (
    <span className="whitespace-nowrap">
      {line.dueFrom ? "from " : ""}
      {formatDateShortUK(`${line.dueDate}T00:00:00Z`)}
      {line.daysPastDue != null ? (
        <span className="block text-xs text-slate-500">
          {line.daysPastDue} {line.daysPastDue === 1 ? "day" : "days"} ago
        </span>
      ) : null}
    </span>
  );
}

export default async function RetentionRegisterPage() {
  const { ctx } = await requireOrgContext();
  if (ctx.membership.role === "staff") redirect("/me");

  const { register, asAtIso, loadError } = await buildRetentionRegisterView(ctx.org.id);
  const t = register.totals;
  const claimable = retentionClaimableNow(t);
  const outstandingLines = register.lines.filter((l) => l.state !== "released");

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Link href="/reports" className="hover:text-slate-900">
            Reports
          </Link>
          <span aria-hidden>/</span>
          <span className="text-slate-900">Retention register</span>
        </div>
        <h1 className="text-2xl font-bold text-slate-900">Retention register</h1>
        <p className="max-w-3xl text-sm text-slate-600">
          Every retention holdback across every job, and the contractual date that entitles its
          release. Retention accrues on the ex-VAT certified value at each job&rsquo;s contract
          rate; the first moiety falls due at Practical Completion and the balance at the end of
          the defects-liability period.{" "}
          <span className="whitespace-nowrap">As at {formatDateShortUK(`${asAtIso}T00:00:00Z`)}.</span>
        </p>
      </header>

      {loadError ? (
        <div
          role="alert"
          className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          We couldn&rsquo;t load the whole register just now, so the figures below may be
          incomplete. Please refresh — don&rsquo;t take these numbers into a meeting until this
          banner has gone.
        </div>
      ) : null}

      <section aria-label="Retention summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Claimable now"
          value={formatGbp(claimable)}
          tone={claimable > 0 ? "amber" : "slate"}
          hint={`${t.lineCountByState.overdue + t.lineCountByState.due} ${
            t.lineCountByState.overdue + t.lineCountByState.due === 1 ? "release" : "releases"
          } due or overdue`}
        />
        <StatTile
          label="Overdue for release"
          value={formatGbp(t.outstandingByState.overdue)}
          tone={t.outstandingByState.overdue > 0 ? "red" : "slate"}
          hint={`${t.jobsOverdueCount} ${t.jobsOverdueCount === 1 ? "job" : "jobs"} past completion`}
        />
        <StatTile
          label="Still held"
          value={formatGbp(t.held)}
          hint={`across ${t.jobsHoldingCount} ${t.jobsHoldingCount === 1 ? "job" : "jobs"}`}
        />
        <StatTile
          label="Released to date"
          value={formatGbp(t.released)}
          tone={t.released > 0 ? "emerald" : "slate"}
          hint={`of ${formatGbp(t.accrued)} withheld`}
        />
      </section>

      <section
        aria-labelledby="register-heading"
        className="rounded-xl border border-slate-200 bg-white shadow-sm"
      >
        <div className="border-b border-slate-100 p-4">
          <h2 id="register-heading" className="text-sm font-semibold text-slate-900">
            Outstanding retention ({outstandingLines.length})
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Worst first. A release is only called <strong>overdue</strong> once Practical
            Completion has passed — the defects moiety is due <em>from</em> its date, because the
            certificate of making good can legitimately slip.
          </p>
        </div>

        {outstandingLines.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="No retention outstanding"
              body={
                t.jobCount === 0
                  ? "None of your jobs carry a retention percentage yet. Set one on a job's commercial tab and every certified invoice will start accruing retention automatically."
                  : "Every pound of retention on your jobs has been released. It will reappear here as soon as new work is certified."
              }
            />
          </div>
        ) : (
          <Table>
            <THead>
              <TR hover={false}>
                <TH>Job</TH>
                <TH hideBelow="md">Release stage</TH>
                <TH hideBelow="lg">Entitling date</TH>
                <TH numeric>Outstanding</TH>
                <TH>State</TH>
              </TR>
            </THead>
            <TBody>
              {outstandingLines.map((line) => (
                <TR key={line.id}>
                  <TD>
                    <Link href={line.href} className="font-medium text-slate-900 hover:underline">
                      {line.customerName ?? "Unnamed customer"}
                    </Link>
                    <span className="block text-xs text-slate-500">
                      {line.jobLabel ?? "No site recorded"}
                      {line.ratePercent > 0 ? ` · ${line.ratePercent}% retention` : ""}
                    </span>
                    {/* The stage repeats on phones, where its own column is hidden. */}
                    <span className="mt-0.5 block text-xs text-slate-500 md:hidden">
                      {line.moietyLabel}
                    </span>
                  </TD>
                  <TD muted hideBelow="md">
                    {line.moietyLabel}
                    <span className="block text-xs text-slate-500">
                      {formatGbp(line.amount)} of this stage
                    </span>
                  </TD>
                  <TD muted hideBelow="lg">
                    <DateCell line={line} />
                    <span className="block text-xs text-slate-500">{evidenceNote(line)}</span>
                  </TD>
                  <TD numeric className="font-semibold text-slate-900">
                    {formatGbp(line.remaining)}
                  </TD>
                  <TD>
                    <Badge tone={STATE_TONE[line.state]}>
                      {RETENTION_LINE_STATE_LABEL[line.state]}
                    </Badge>
                    {/* On phones the date column is hidden. Both halves of it come
                        back here, INCLUDING the evidence: the certificate number is
                        the whole argument, and a builder standing on site making
                        that argument is the likeliest reader of the phone layout. */}
                    <span className="mt-1 block text-xs text-slate-500 lg:hidden">
                      <DateCell line={line} />
                      <span className="block">{evidenceNote(line)}</span>
                    </span>
                  </TD>
                </TR>
              ))}
              <TR hover={false} className="bg-slate-50 font-semibold">
                <TD>Total outstanding</TD>
                <TD hideBelow="md" />
                <TD hideBelow="lg" />
                <TD numeric className="text-slate-900">
                  {formatGbp(t.held)}
                </TD>
                <TD />
              </TR>
            </TBody>
          </Table>
        )}
      </section>

      <section aria-labelledby="evidence-heading" className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 id="evidence-heading" className="text-sm font-semibold text-slate-900">
          What the dates come from
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          Where a job has an <strong>issued Practical Completion Certificate</strong>, its frozen
          completion date governs both releases and the row shows the certificate number — that is
          the document to put in front of the client. Otherwise the date on the job record is used
          and shown as such: still useful for planning, but not evidence. A job with retention and
          no completion date anywhere is listed as{" "}
          <em>{RETENTION_LINE_STATE_LABEL.awaiting_completion}</em> rather than being given an
          invented deadline.
        </p>
        <p className="mt-2 text-xs text-slate-500">
          Retention figures are ex-VAT — VAT is never retained. Outstanding retention here always
          equals accrued less released on the retention ledger, so this register cannot disagree
          with a job&rsquo;s own retention panel.
        </p>
      </section>
    </div>
  );
}

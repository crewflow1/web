import Link from "next/link";
import {
  Building2,
  FileText,
  Mail,
  ShieldCheck,
  Target,
  Users,
} from "lucide-react";
import { employeeBandLabel, type DecisionMaker } from "@/lib/research/model";
import { formatGbp } from "@/lib/sales/model";
import type { ResearchReportView } from "@/server/services/hq-research";
import {
  ChipList,
  Fact,
  FactorRow,
  Panel,
  ScoreDial,
  Tile,
} from "../_components";

/**
 * Research AI — the completed intelligence report (CEO Directive 005).
 *
 * The destination of a finished run and the hand-off to Sales AI: the
 * transparent score, the full company profile, the decision makers, the
 * cold-call brief, and the DRAFT outreach (clearly never-sent). Everything
 * shown is something the runner actually produced; unknowns are honest blanks.
 */

const SENIORITY_LABEL: Record<DecisionMaker["seniority"], string> = {
  c_level: "C-level",
  director: "Director",
  manager: "Manager",
  other: "Other",
  unknown: "Unknown",
};

export function ResearchReport({ report }: { report: ResearchReportView }) {
  const intel = report.intelligence;
  const s = report.summary;
  const known = report.scoreFactors.filter((f) => f.known).length;

  return (
    <div className="space-y-6">
      {/* Headline: score + summary */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <ScoreDial
            score={s?.score ?? null}
            band={s?.scoreBand ?? null}
            confidence={s?.confidence ?? null}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:col-span-2">
          <Tile label="Decision makers" value={`${s?.decisionMakers ?? report.decisionMakers.length}`} />
          <Tile label="Technologies" value={`${s?.technologies ?? 0}`} />
          <Tile label="Pain points" value={`${s?.painPoints ?? intel?.painPoints.length ?? 0}`} />
          <Tile label="Factors known" value={`${known}/${report.scoreFactors.length}`} accent />
        </div>
      </div>

      {report.status === "failed" && report.error ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          Research failed: {report.error}
        </p>
      ) : null}

      {/* Transparent score — "no black box" */}
      {report.scoreFactors.length ? (
        <Panel
          title="Why this score"
          subtitle="Every factor, its contribution, and the evidence behind it — scored on known signals only"
          action={
            <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800/80 px-2.5 py-1 text-[11px] font-medium text-slate-300 ring-1 ring-inset ring-slate-700">
              <Target className="h-3.5 w-3.5" aria-hidden />
              10-factor model
            </span>
          }
        >
          <div className="divide-y divide-slate-800/70">
            {report.scoreFactors.map((f) => (
              <FactorRow key={f.key} factor={f} />
            ))}
          </div>
        </Panel>
      ) : null}

      {/* Company intelligence */}
      {intel ? (
        <Panel
          title="Company intelligence"
          subtitle="Built from real public sources"
          action={
            <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800/80 px-2.5 py-1 text-[11px] font-medium text-slate-300 ring-1 ring-inset ring-slate-700">
              <Building2 className="h-3.5 w-3.5" aria-hidden />
              Profile
            </span>
          }
        >
          {intel.overview ? (
            <p className="mb-4 text-sm leading-relaxed text-slate-300">{intel.overview}</p>
          ) : null}

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <dl>
              <Fact label="Industry" value={intel.industry} />
              <Fact label="Construction sector" value={intel.constructionSector} />
              <Fact label="Geographic coverage" value={intel.geographicCoverage} />
              <Fact
                label="Employees (est.)"
                value={intel.employeeEstimate != null ? employeeBandLabel(intel.employeeEstimate) : null}
              />
              <Fact
                label="Years trading"
                value={intel.yearsTrading != null ? `${intel.yearsTrading}` : null}
              />
              <Fact
                label="Revenue (est.)"
                value={intel.revenueEstimateGbp != null ? formatGbp(intel.revenueEstimateGbp) : null}
              />
              <Fact
                label="Software spend (est.)"
                value={
                  intel.estimatedSoftwareSpendGbp != null
                    ? formatGbp(intel.estimatedSoftwareSpendGbp)
                    : null
                }
              />
              <Fact
                label="Website quality"
                value={intel.websiteQualityScore != null ? `${intel.websiteQualityScore}/100` : null}
              />
              <Fact
                label="Digital maturity"
                value={intel.digitalMaturityScore != null ? `${intel.digitalMaturityScore}/100` : null}
              />
            </dl>

            <div className="space-y-4">
              <Field label="Services">
                <ChipList items={intel.services} empty="Not stated" />
              </Field>
              <Field label="Specialisms">
                <ChipList items={intel.specialisms} tone="indigo" empty="Not stated" />
              </Field>
              <Field label="Software detected">
                <ChipList items={intel.softwareUsed} tone="slate" empty="None detected" />
              </Field>
              <Field label="Locations">
                <ChipList items={intel.locations} empty="Not stated" />
              </Field>
            </div>
          </div>

          {(intel.painPoints.length || intel.buyingSignals.length || intel.growthIndicators.length) ? (
            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Pain points">
                <ChipList items={intel.painPoints} tone="amber" empty="None identified" />
              </Field>
              <Field label="Buying signals">
                <ChipList items={intel.buyingSignals} tone="emerald" empty="None identified" />
              </Field>
              <Field label="Growth indicators">
                <ChipList items={intel.growthIndicators} tone="emerald" empty="None identified" />
              </Field>
            </div>
          ) : null}
        </Panel>
      ) : null}

      {/* Decision makers */}
      <Panel
        title="Decision makers"
        subtitle="Only ever from a real source — never invented"
        action={
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800/80 px-2.5 py-1 text-[11px] font-medium text-slate-300 ring-1 ring-inset ring-slate-700">
            <Users className="h-3.5 w-3.5" aria-hidden />
            {report.decisionMakers.length}
          </span>
        }
      >
        {report.decisionMakers.length === 0 ? (
          <p className="text-sm text-slate-500">
            None identified from public sources — an honest unknown, not a guess.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {report.decisionMakers.map((dm, i) => (
              <li
                key={`${dm.fullName}-${i}`}
                className="rounded-xl border border-slate-800 bg-slate-900/60 p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-white">{dm.fullName}</p>
                    {dm.title ? <p className="text-xs text-slate-400">{dm.title}</p> : null}
                  </div>
                  <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-300 ring-1 ring-inset ring-slate-700">
                    {SENIORITY_LABEL[dm.seniority]}
                  </span>
                </div>
                {dm.reasoning ? (
                  <p className="mt-2 text-xs leading-relaxed text-slate-500">{dm.reasoning}</p>
                ) : null}
                {dm.email || dm.linkedinUrl ? (
                  <p className="mt-2 truncate text-[11px] text-slate-500">
                    {dm.email ?? dm.linkedinUrl}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* Sales brief */}
      {report.brief ? <BriefPanel brief={report.brief} /> : null}

      {/* Outreach drafts */}
      {report.drafts ? <DraftsPanel drafts={report.drafts} /> : null}

      {/* Hand-off */}
      {report.companyId ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <ShieldCheck className="h-4 w-4 text-emerald-400" aria-hidden />
            Saved to the company record, contacts, and Shared Memory — every
            item audited and ready for Sales AI.
          </div>
          <Link
            href={`/admin/sales/companies/${report.companyId}`}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500"
          >
            Open in Sales AI →
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      {children}
    </div>
  );
}

function BriefPanel({ brief }: { brief: import("@/lib/research/model").SalesBrief }) {
  return (
    <Panel
      title="Sales brief"
      subtitle="A human's cold-call / first-meeting prep — drafted, never executed"
      action={
        <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800/80 px-2.5 py-1 text-[11px] font-medium text-slate-300 ring-1 ring-inset ring-slate-700">
          <FileText className="h-3.5 w-3.5" aria-hidden />
          Brief
        </span>
      }
    >
      <div className="space-y-4">
        {brief.bestAngle ? (
          <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/[0.06] p-4">
            <p className="text-[11px] font-medium uppercase tracking-wide text-indigo-300">
              Best angle
            </p>
            <p className="mt-1 text-sm text-slate-200">{brief.bestAngle}</p>
          </div>
        ) : null}
        {brief.valueProposition ? (
          <Field label="Value proposition">
            <p className="text-sm text-slate-300">{brief.valueProposition}</p>
          </Field>
        ) : null}
        {brief.coldCallOpener ? (
          <Field label="Cold-call opener">
            <p className="text-sm text-slate-300">{brief.coldCallOpener}</p>
          </Field>
        ) : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Discovery questions">
            <NumberedList items={brief.discoveryQuestions} />
          </Field>
          <Field label="Meeting agenda">
            <NumberedList items={brief.meetingAgenda} />
          </Field>
        </div>
        {brief.likelyObjections.length ? (
          <Field label="Likely objections & responses">
            <ul className="space-y-2">
              {brief.likelyObjections.map((obj, i) => (
                <li key={i} className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
                  <p className="text-sm font-medium text-slate-200">{obj}</p>
                  {brief.objectionResponses[i] ? (
                    <p className="mt-1 text-xs text-slate-500">{brief.objectionResponses[i]}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </Field>
        ) : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {brief.recommendedModules.length ? (
            <Field label="Recommended modules">
              <ChipList items={brief.recommendedModules} tone="indigo" />
            </Field>
          ) : null}
          {brief.bestTimeToCall ? (
            <Field label="Best time to call">
              <p className="text-sm text-slate-300">{brief.bestTimeToCall}</p>
            </Field>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

function DraftsPanel({ drafts }: { drafts: import("@/lib/research/model").CommsDrafts }) {
  const items: Array<{ label: string; subject?: string; body: string }> = [
    { label: "Cold email", subject: drafts.coldEmailSubject, body: drafts.coldEmail },
    { label: "LinkedIn message", body: drafts.linkedinMessage },
    { label: "Follow-up email", body: drafts.followUpEmail },
    { label: "Voicemail script", body: drafts.voicemailScript },
    { label: "First-call opening", body: drafts.firstCallOpening },
    { label: "Demo confirmation", body: drafts.demoConfirmation },
  ].filter((d) => d.body && d.body.trim());

  if (!items.length) return null;

  return (
    <Panel
      title="Outreach drafts"
      subtitle="Drafted for a human to review and send — Research AI never sends anything"
      action={
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-300 ring-1 ring-inset ring-amber-400/30">
          <Mail className="h-3.5 w-3.5" aria-hidden />
          Draft only · approval required
        </span>
      }
    >
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {items.map((d) => (
          <div key={d.label} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              {d.label}
            </p>
            {d.subject ? (
              <p className="mt-1 text-sm font-medium text-slate-200">{d.subject}</p>
            ) : null}
            <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-slate-400">
              {d.body}
            </p>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function NumberedList({ items }: { items: string[] }) {
  if (!items.length) return <p className="text-xs text-slate-500">—</p>;
  return (
    <ol className="space-y-1.5">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2 text-sm text-slate-300">
          <span className="select-none text-xs font-semibold text-slate-600">{i + 1}.</span>
          <span>{it}</span>
        </li>
      ))}
    </ol>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Brain,
  Building2,
  CalendarClock,
  ExternalLink,
  Facebook,
  Instagram,
  Landmark,
  Lightbulb,
  Linkedin,
  Mail,
  Pencil,
  Phone,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { loadCompanyDetail } from "@/server/services/hq-sales";
import { listAiEmployees } from "@/server/services/ai-employees";
import type { AiEmployee } from "@/lib/ai-employees/model";
import {
  EVENT_DIRECTIONS,
  GENERATED_BY,
  INTERACTION_EVENT_TYPES,
  PIPELINE_STATUSES,
  RISK_LEVELS,
  RISK_LABELS,
  SENIORITIES,
  SENIORITY_LABELS,
  STATUS_LABELS,
  DIRECTION_LABELS,
  EVENT_LABELS,
  departmentLabel,
  employeeBandLabel,
  formatGbp,
  likelihoodLabel,
  relativeTime,
  riskLabel,
  seniorityLabel,
  type SalesContact,
  type SalesRecommendation,
  type SalesResearchReport,
} from "@/lib/sales/model";
import {
  Banner,
  Chip,
  EmptyState,
  Field,
  KV,
  Pill,
  ScorePill,
  Section,
  StatusPill,
  Tile,
  TimelineItem,
} from "../../_components";
import {
  inputCls,
  likelihoodPill,
  riskPill,
  selectCls,
  textareaCls,
} from "../../_styles";
import {
  addContactAction,
  addRecommendationAction,
  addResearchAction,
  deleteContactAction,
  logInteractionAction,
  promoteResearchAction,
  setCompanyStatusAction,
} from "../../actions";

/**
 * Sales AI — company detail (CEO Directive 003, Phase 1).
 *
 * The single 360° record the directive specifies: company intelligence,
 * decision-maker contacts, permanent AI research reports, AI
 * recommendations, and the full chronological contact timeline — each
 * with inline, audited operator actions. Research can be promoted into
 * the Shared Memory Engine so findings become reusable company knowledge.
 */

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;
type SP = Promise<{ saved?: string; error?: string }>;

export default async function CompanyDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SP;
}) {
  const { id } = await params;
  const sp = await searchParams;

  const detail = await loadCompanyDetail(id);
  if (!detail) notFound();

  const { company: c, contacts, research, recommendations, timeline } = detail;
  const employees = await listAiEmployees();

  const saved = sp.saved ? prettySaved(sp.saved) : null;
  const errorMsg = sp.error ? decodeURIComponent(sp.error) : null;
  const activeReco = recommendations.find((r) => r.status === "active") ?? null;
  const pastRecos = recommendations.filter((r) => r.id !== activeReco?.id);

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      <div className="space-y-5 p-5 sm:p-7">
        {/* Breadcrumb */}
        <p className="text-sm text-slate-500">
          <Link href="/admin/sales" className="hover:text-slate-300">
            Sales AI
          </Link>{" "}
          /{" "}
          <Link href="/admin/sales/companies" className="hover:text-slate-300">
            Companies
          </Link>{" "}
          / <span className="text-slate-300">{c.name}</span>
        </p>

        {errorMsg ? <Banner kind="error">{errorMsg}</Banner> : null}
        {saved ? <Banner kind="success">{saved}</Banner> : null}

        {/* Header */}
        <header className="relative overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
                <Building2 className="h-6 w-6" strokeWidth={1.75} aria-hidden />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill status={c.status} />
                  <ScorePill score={c.ai_qualification_score} prefix="AI" />
                  {c.crm_score != null ? (
                    <ScorePill score={c.crm_score} prefix="CRM" />
                  ) : null}
                </div>
                <h1 className="mt-2 text-2xl font-bold tracking-tight text-white">
                  {c.name}
                </h1>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-400">
                  {c.industry ? <span>{c.industry}</span> : null}
                  {c.county || c.region ? (
                    <span>{c.county ?? c.region}</span>
                  ) : null}
                  {c.website ? (
                    <a
                      href={c.website}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300"
                    >
                      {c.domain ?? c.website}
                      <ExternalLink className="h-3 w-3" aria-hidden />
                    </a>
                  ) : null}
                </p>
              </div>
            </div>
            <Link
              href={`/admin/sales/companies/${c.id}/edit`}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              Edit
            </Link>
          </div>

          {/* Quick status change */}
          <form
            action={setCompanyStatusAction}
            className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-800 pt-4"
          >
            <input type="hidden" name="id" value={c.id} />
            <label className="text-[11px] font-medium text-slate-400">
              Move stage
              <select name="status" defaultValue={c.status} className={`${selectCls} mt-1`}>
                {PIPELINE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              Update status
            </button>
          </form>
        </header>

        {/* Intelligence tiles */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label="Industry" value={c.industry ?? "—"} />
          <Tile label="Employees" value={employeeBandLabel(c.employee_count)} sub={c.employee_count ? `${c.employee_count} staff` : undefined} />
          <Tile label="Turnover" value={formatGbp(c.annual_turnover_gbp)} />
          <Tile label="Est. deal value" value={formatGbp(c.estimated_deal_value_gbp)} accent />
          <Tile label="Source" value={c.source.replace(/_/g, " ")} />
          <Tile label="Last researched" value={c.last_researched_at ? relativeTime(c.last_researched_at) : "Never"} />
        </div>

        {/* Summary + intelligence panel */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-4">
            <Section title="Summary">
              {c.summary ? (
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-300">
                  {c.summary}
                </p>
              ) : (
                <p className="text-sm text-slate-500">No summary yet.</p>
              )}
            </Section>

            {/* Contacts */}
            <Section
              title="Decision makers"
              subtitle={`${contacts.length} ${contacts.length === 1 ? "contact" : "contacts"}`}
            >
              {contacts.length === 0 ? (
                <p className="text-sm text-slate-500">No contacts yet.</p>
              ) : (
                <ul className="space-y-2">
                  {contacts.map((ct) => (
                    <ContactRow key={ct.id} contact={ct} companyId={c.id} />
                  ))}
                </ul>
              )}
              <AddContactForm companyId={c.id} />
            </Section>
          </div>

          {/* Intelligence KV */}
          <Section title="Company intelligence">
            <div className="-mt-2">
              <KV label="Website">
                {c.website ? (
                  <a
                    href={c.website}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-indigo-400 hover:text-indigo-300"
                  >
                    {c.domain ?? c.website}
                  </a>
                ) : (
                  "—"
                )}
              </KV>
              <KV label="Industry">{c.industry ?? "—"}</KV>
              <KV label="Location">{c.location ?? "—"}</KV>
              <KV label="County">{c.county ?? "—"}</KV>
              <KV label="Region">{c.region ?? "—"}</KV>
              <KV label="Country">{c.country}</KV>
              <KV label="Email">
                {c.primary_email ? (
                  <a href={`mailto:${c.primary_email}`} className="text-indigo-400 hover:text-indigo-300">
                    {c.primary_email}
                  </a>
                ) : (
                  "—"
                )}
              </KV>
              <KV label="Phone">{c.primary_phone ?? "—"}</KV>
              <KV label="Socials">
                <span className="inline-flex items-center gap-2">
                  <SocialLink href={c.linkedin_url} label="LinkedIn">
                    <Linkedin className="h-4 w-4" aria-hidden />
                  </SocialLink>
                  <SocialLink href={c.instagram_url} label="Instagram">
                    <Instagram className="h-4 w-4" aria-hidden />
                  </SocialLink>
                  <SocialLink href={c.facebook_url} label="Facebook">
                    <Facebook className="h-4 w-4" aria-hidden />
                  </SocialLink>
                  {!c.linkedin_url && !c.instagram_url && !c.facebook_url ? "—" : null}
                </span>
              </KV>
              <KV label="Companies House">
                {c.companies_house_url ? (
                  <a
                    href={c.companies_house_url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300"
                  >
                    <Landmark className="h-3.5 w-3.5" aria-hidden />
                    {c.companies_house_number ?? "View"}
                  </a>
                ) : (
                  c.companies_house_number ?? "—"
                )}
              </KV>
              <KV label="Assigned to">{c.assigned_to_email ?? "Unassigned"}</KV>
              <KV label="Added">{relativeTime(c.created_at)}</KV>
            </div>

            {c.website_technology.length > 0 ? (
              <div className="mt-3 border-t border-slate-800 pt-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  Website technology
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {c.website_technology.map((t) => (
                    <Chip key={t}>{t}</Chip>
                  ))}
                </div>
              </div>
            ) : null}

            {c.tags.length > 0 ? (
              <div className="mt-3 border-t border-slate-800 pt-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  Tags
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {c.tags.map((t) => (
                    <Link
                      key={t}
                      href={`/admin/sales/companies?tag=${encodeURIComponent(t)}`}
                      className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400 ring-1 ring-inset ring-slate-700 transition hover:bg-slate-700"
                    >
                      #{t}
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
          </Section>
        </div>

        {/* Research */}
        <Section
          title="AI research reports"
          subtitle="Stored permanently. Promote a report to make its findings reusable company knowledge."
          action={
            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              {research.length}
            </span>
          }
        >
          {research.length === 0 ? (
            <p className="text-sm text-slate-500">No research yet.</p>
          ) : (
            <ul className="space-y-4">
              {research.map((r) => (
                <ResearchReportView
                  key={r.id}
                  report={r}
                  companyId={c.id}
                  employee={r.ai_employee_id ? employeeById(employees, r.ai_employee_id) : null}
                />
              ))}
            </ul>
          )}
          <AddResearchForm companyId={c.id} employees={employees} />
        </Section>

        {/* Recommendations */}
        <Section
          title="AI recommendations"
          subtitle="What to do next — why they buy, key features, objections, pricing, timing, follow-up."
          action={
            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
              <Lightbulb className="h-3.5 w-3.5" aria-hidden />
              {recommendations.length}
            </span>
          }
        >
          {activeReco ? (
            <RecommendationView
              reco={activeReco}
              active
              employee={activeReco.ai_employee_id ? employeeById(employees, activeReco.ai_employee_id) : null}
            />
          ) : (
            <p className="text-sm text-slate-500">No recommendation yet.</p>
          )}
          {pastRecos.length > 0 ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-medium text-slate-400 hover:text-slate-200">
                {pastRecos.length} superseded {pastRecos.length === 1 ? "recommendation" : "recommendations"}
              </summary>
              <ul className="mt-3 space-y-4">
                {pastRecos.map((r) => (
                  <RecommendationView
                    key={r.id}
                    reco={r}
                    employee={r.ai_employee_id ? employeeById(employees, r.ai_employee_id) : null}
                  />
                ))}
              </ul>
            </details>
          ) : null}
          <AddRecommendationForm companyId={c.id} employees={employees} />
        </Section>

        {/* Timeline */}
        <Section
          title="Contact timeline"
          subtitle="Every interaction, AI action, and lifecycle marker — newest first."
        >
          <LogInteractionForm companyId={c.id} contacts={contacts} />
          {timeline.length === 0 ? (
            <EmptyState message="No timeline events yet." />
          ) : (
            <ul className="relative mt-4">
              {timeline.map((e) => (
                <TimelineItem key={e.id} event={e} />
              ))}
            </ul>
          )}
        </Section>

        {/* Footer meta */}
        <p className="text-[11px] text-slate-600">
          Created {c.created_at.slice(0, 16).replace("T", " ")}
          {c.created_by_email ? ` by ${c.created_by_email}` : ""} · Updated{" "}
          {c.updated_at.slice(0, 16).replace("T", " ")} · ID {c.id}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Helpers + sub-views.
// ---------------------------------------------------------------------

function employeeById(employees: AiEmployee[], id: string): AiEmployee | null {
  return employees.find((e) => e.id === id) ?? null;
}

function SocialLink({
  href,
  label,
  children,
}: {
  href: string | null;
  label: string;
  children: React.ReactNode;
}) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      title={label}
      aria-label={label}
      className="text-slate-400 transition hover:text-indigo-300"
    >
      {children}
    </a>
  );
}

function AiAttribution({
  generatedBy,
  model,
  employee,
}: {
  generatedBy: string;
  model: string | null;
  employee: AiEmployee | null;
}) {
  if (generatedBy !== "ai") {
    return <Chip>Human-authored</Chip>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Pill className="bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
        <Sparkles className="mr-1 h-3 w-3" aria-hidden /> AI
      </Pill>
      {employee ? (
        <Chip>{employee.name}</Chip>
      ) : null}
      {model ? <Chip>{model}</Chip> : null}
    </span>
  );
}

function ContactRow({
  contact: ct,
  companyId,
}: {
  contact: SalesContact;
  companyId: string;
}) {
  return (
    <li className="flex items-start justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-slate-200">{ct.full_name}</span>
          {ct.is_primary ? (
            <Pill className="bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30">
              Primary
            </Pill>
          ) : null}
          <Chip>{seniorityLabel(ct.seniority)}</Chip>
          {ct.is_decision_maker ? <Chip>Decision maker</Chip> : null}
        </div>
        {ct.title ? <p className="mt-0.5 text-xs text-slate-400">{ct.title}</p> : null}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          {ct.email ? (
            <a href={`mailto:${ct.email}`} className="inline-flex items-center gap-1 hover:text-indigo-300">
              <Mail className="h-3 w-3" aria-hidden /> {ct.email}
            </a>
          ) : null}
          {ct.phone ? (
            <span className="inline-flex items-center gap-1">
              <Phone className="h-3 w-3" aria-hidden /> {ct.phone}
            </span>
          ) : null}
          {ct.linkedin_url ? (
            <a
              href={ct.linkedin_url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="inline-flex items-center gap-1 hover:text-indigo-300"
            >
              <Linkedin className="h-3 w-3" aria-hidden /> LinkedIn
            </a>
          ) : null}
        </div>
        {ct.notes ? (
          <p className="mt-1.5 whitespace-pre-wrap text-xs text-slate-400">{ct.notes}</p>
        ) : null}
      </div>
      <form action={deleteContactAction}>
        <input type="hidden" name="id" value={ct.id} />
        <input type="hidden" name="company_id" value={companyId} />
        <button
          type="submit"
          aria-label={`Remove ${ct.full_name}`}
          className="rounded-md border border-slate-800 p-1.5 text-slate-500 transition hover:border-red-500/40 hover:text-red-300"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      </form>
    </li>
  );
}

function ResearchReportView({
  report: r,
  companyId,
  employee,
}: {
  report: SalesResearchReport;
  companyId: string;
  employee: AiEmployee | null;
}) {
  return (
    <li className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Pill className={likelihoodPill(r.likelihood_band)}>
            {likelihoodLabel(r.likelihood_band)}
            {r.likelihood_score != null ? ` · ${r.likelihood_score}` : ""}
          </Pill>
          <Pill className={riskPill(r.risk_level)}>{riskLabel(r.risk_level)}</Pill>
          <AiAttribution generatedBy={r.generated_by} model={r.model} employee={employee} />
        </div>
        <span className="text-[11px] text-slate-500">{relativeTime(r.created_at)}</span>
      </div>

      {r.summary ? (
        <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">
          {r.summary}
        </p>
      ) : null}

      {r.pain_points.length > 0 ? (
        <ReportBlock title="Pain points">
          <ul className="list-disc space-y-0.5 pl-4 text-sm text-slate-300">
            {r.pain_points.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </ReportBlock>
      ) : null}

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {r.best_angle ? <ReportBlock title="Best angle">{r.best_angle}</ReportBlock> : null}
        {r.opening_line ? <ReportBlock title="Opening line">{r.opening_line}</ReportBlock> : null}
        {r.recommended_follow_up ? (
          <ReportBlock title="Recommended follow-up">{r.recommended_follow_up}</ReportBlock>
        ) : null}
        {r.risk_assessment ? <ReportBlock title="Risk assessment">{r.risk_assessment}</ReportBlock> : null}
        {r.estimated_software_spend_gbp != null ? (
          <ReportBlock title="Est. software spend">
            {formatGbp(r.estimated_software_spend_gbp)}
            {r.estimated_spend_note ? ` — ${r.estimated_spend_note}` : ""}
          </ReportBlock>
        ) : null}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-slate-800 pt-3">
        {r.memory_id ? (
          <Link
            href={`/admin/memory/${r.memory_id}`}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-300 hover:text-emerald-200"
          >
            <Brain className="h-3.5 w-3.5" aria-hidden />
            In Shared Memory
          </Link>
        ) : (
          <form action={promoteResearchAction}>
            <input type="hidden" name="report_id" value={r.id} />
            <input type="hidden" name="company_id" value={companyId} />
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              <Brain className="h-3.5 w-3.5" aria-hidden />
              Promote to Shared Memory
            </button>
          </form>
        )}
        {r.authored_by_email ? (
          <span className="text-[10px] text-slate-600">{r.authored_by_email}</span>
        ) : null}
      </div>
    </li>
  );
}

function RecommendationView({
  reco: r,
  active,
  employee,
}: {
  reco: SalesRecommendation;
  active?: boolean;
  employee: AiEmployee | null;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {active ? (
            <Pill className="bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30">
              Active
            </Pill>
          ) : (
            <Chip>Superseded</Chip>
          )}
          <AiAttribution generatedBy={r.generated_by} model={r.model} employee={employee} />
        </div>
        <span className="text-[11px] text-slate-500">{relativeTime(r.created_at)}</span>
      </div>

      {r.why_buy ? (
        <ReportBlock title="Why they buy">{r.why_buy}</ReportBlock>
      ) : null}

      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {r.key_features.length > 0 ? (
          <ReportBlock title="Key features">
            <ul className="list-disc space-y-0.5 pl-4 text-sm text-slate-300">
              {r.key_features.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </ReportBlock>
        ) : null}
        {r.likely_objections.length > 0 ? (
          <ReportBlock title="Likely objections">
            <ul className="list-disc space-y-0.5 pl-4 text-sm text-slate-300">
              {r.likely_objections.map((o, i) => (
                <li key={i}>{o}</li>
              ))}
            </ul>
          </ReportBlock>
        ) : null}
        {r.recommended_pricing || r.recommended_price_gbp != null ? (
          <ReportBlock title="Recommended pricing">
            {r.recommended_plan ? `${r.recommended_plan} · ` : ""}
            {r.recommended_price_gbp != null ? formatGbp(r.recommended_price_gbp) : ""}
            {r.recommended_pricing ? ` ${r.recommended_pricing}` : ""}
          </ReportBlock>
        ) : null}
        {r.best_salesperson ? (
          <ReportBlock title="Best salesperson">{r.best_salesperson}</ReportBlock>
        ) : null}
        {r.best_time_to_call ? (
          <ReportBlock title="Best time to call">{r.best_time_to_call}</ReportBlock>
        ) : null}
        {r.follow_up_schedule ? (
          <ReportBlock title="Follow-up schedule">{r.follow_up_schedule}</ReportBlock>
        ) : null}
      </div>
    </div>
  );
}

function ReportBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3 first:mt-0">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
        {title}
      </p>
      <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">
        {children}
      </div>
    </div>
  );
}

// --- Inline add forms (collapsed by default) -------------------------

function Disclosure({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <details className="mt-4 rounded-lg border border-slate-800 bg-slate-900/40">
      <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-xs font-semibold text-indigo-300 hover:text-indigo-200">
        <Plus className="h-3.5 w-3.5" aria-hidden />
        {label}
      </summary>
      <div className="border-t border-slate-800 p-4">{children}</div>
    </details>
  );
}

function EmployeeSelect({ employees }: { employees: AiEmployee[] }) {
  return (
    <Field label="Attributed AI employee" hint="only used when authored by AI">
      <select name="ai_employee_id" defaultValue="" className={selectCls}>
        <option value="">— None —</option>
        {employees.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name} ({departmentLabel(e.department)})
          </option>
        ))}
      </select>
    </Field>
  );
}

function AddContactForm({ companyId }: { companyId: string }) {
  return (
    <Disclosure label="Add contact">
      <form action={addContactAction} className="space-y-3">
        <input type="hidden" name="company_id" value={companyId} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Full name">
            <input name="full_name" type="text" required maxLength={200} className={inputCls} />
          </Field>
          <Field label="Title">
            <input name="title" type="text" maxLength={200} placeholder="Managing Director" className={inputCls} />
          </Field>
          <Field label="Seniority">
            <select name="seniority" defaultValue="unknown" className={selectCls}>
              {SENIORITIES.map((s) => (
                <option key={s} value={s}>
                  {SENIORITY_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Email">
            <input name="email" type="text" maxLength={320} className={inputCls} />
          </Field>
          <Field label="Phone">
            <input name="phone" type="text" maxLength={60} className={inputCls} />
          </Field>
          <Field label="LinkedIn URL">
            <input name="linkedin_url" type="text" maxLength={500} className={inputCls} />
          </Field>
        </div>
        <Field label="Notes">
          <textarea name="notes" rows={2} maxLength={4000} className={textareaCls} />
        </Field>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" name="is_primary" className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-indigo-500 focus:ring-indigo-500" />
            Primary contact
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" name="is_decision_maker" defaultChecked className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-indigo-500 focus:ring-indigo-500" />
            Decision maker
          </label>
          <button
            type="submit"
            className="ml-auto rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
          >
            Add contact
          </button>
        </div>
      </form>
    </Disclosure>
  );
}

function AddResearchForm({
  companyId,
  employees,
}: {
  companyId: string;
  employees: AiEmployee[];
}) {
  return (
    <Disclosure label="Add research report">
      <form action={addResearchAction} className="space-y-3">
        <input type="hidden" name="company_id" value={companyId} />
        <Field label="Company summary">
          <textarea name="summary" rows={3} maxLength={8000} className={textareaCls} />
        </Field>
        <Field label="Pain points" hint="one per line">
          <textarea name="pain_points" rows={3} className={textareaCls} placeholder={"Manual scheduling eats admin time\nNo single view of jobs"} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Likelihood score" hint="0–100">
            <input name="likelihood_score" type="number" min={0} max={100} className={inputCls} />
          </Field>
          <Field label="Est. software spend" hint="£">
            <input name="estimated_software_spend_gbp" type="number" min={0} className={inputCls} />
          </Field>
          <Field label="Risk level">
            <select name="risk_level" defaultValue="medium" className={selectCls}>
              {RISK_LEVELS.map((r) => (
                <option key={r} value={r}>
                  {RISK_LABELS[r]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Spend rationale">
          <input name="estimated_spend_note" type="text" maxLength={2000} className={inputCls} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Best angle">
            <textarea name="best_angle" rows={2} maxLength={4000} className={textareaCls} />
          </Field>
          <Field label="Suggested opening line">
            <textarea name="opening_line" rows={2} maxLength={2000} className={textareaCls} />
          </Field>
          <Field label="Recommended follow-up">
            <textarea name="recommended_follow_up" rows={2} maxLength={4000} className={textareaCls} />
          </Field>
          <Field label="Risk assessment">
            <textarea name="risk_assessment" rows={2} maxLength={4000} className={textareaCls} />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Authored by">
            <select name="generated_by" defaultValue="human" className={selectCls}>
              {GENERATED_BY.map((g) => (
                <option key={g} value={g}>
                  {g === "ai" ? "AI" : "Human"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model" hint="for AI reports">
            <input name="model" type="text" maxLength={120} placeholder="claude-…" className={inputCls} />
          </Field>
          <EmployeeSelect employees={employees} />
        </div>
        <button
          type="submit"
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
        >
          Save research report
        </button>
      </form>
    </Disclosure>
  );
}

function AddRecommendationForm({
  companyId,
  employees,
}: {
  companyId: string;
  employees: AiEmployee[];
}) {
  return (
    <Disclosure label="Add recommendation">
      <form action={addRecommendationAction} className="space-y-3">
        <input type="hidden" name="company_id" value={companyId} />
        <Field label="Why they buy">
          <textarea name="why_buy" rows={2} maxLength={4000} className={textareaCls} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Key features" hint="one per line">
            <textarea name="key_features" rows={3} className={textareaCls} />
          </Field>
          <Field label="Likely objections" hint="one per line">
            <textarea name="likely_objections" rows={3} className={textareaCls} />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Recommended plan">
            <input name="recommended_plan" type="text" maxLength={120} placeholder="Pro" className={inputCls} />
          </Field>
          <Field label="Recommended price" hint="£/mo">
            <input name="recommended_price_gbp" type="number" min={0} className={inputCls} />
          </Field>
          <Field label="Best salesperson">
            <input name="best_salesperson" type="text" maxLength={200} className={inputCls} />
          </Field>
        </div>
        <Field label="Pricing notes">
          <input name="recommended_pricing" type="text" maxLength={2000} className={inputCls} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Best time to call">
            <input name="best_time_to_call" type="text" maxLength={500} placeholder="Weekday mornings" className={inputCls} />
          </Field>
          <Field label="Follow-up schedule">
            <input name="follow_up_schedule" type="text" maxLength={4000} placeholder="Day 1 email · Day 3 call · Day 7 LinkedIn" className={inputCls} />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Authored by">
            <select name="generated_by" defaultValue="human" className={selectCls}>
              {GENERATED_BY.map((g) => (
                <option key={g} value={g}>
                  {g === "ai" ? "AI" : "Human"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model" hint="for AI">
            <input name="model" type="text" maxLength={120} className={inputCls} />
          </Field>
          <EmployeeSelect employees={employees} />
        </div>
        <button
          type="submit"
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
        >
          Save recommendation
        </button>
      </form>
    </Disclosure>
  );
}

function LogInteractionForm({
  companyId,
  contacts,
}: {
  companyId: string;
  contacts: SalesContact[];
}) {
  return (
    <Disclosure label="Log interaction">
      <form action={logInteractionAction} className="space-y-3">
        <input type="hidden" name="company_id" value={companyId} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Type">
            <select name="event_type" defaultValue="note" className={selectCls}>
              {INTERACTION_EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {EVENT_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Direction">
            <select name="direction" defaultValue="outbound" className={selectCls}>
              {EVENT_DIRECTIONS.map((d) => (
                <option key={d} value={d}>
                  {DIRECTION_LABELS[d]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Contact" hint="optional">
            <select name="contact_id" defaultValue="" className={selectCls}>
              <option value="">— None —</option>
              {contacts.map((ct) => (
                <option key={ct.id} value={ct.id}>
                  {ct.full_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="When" hint="defaults to now">
            <input name="occurred_at" type="datetime-local" className={inputCls} />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Subject">
            <input name="subject" type="text" maxLength={300} className={inputCls} />
          </Field>
          <Field label="Outcome" hint="e.g. replied / no answer">
            <input name="outcome" type="text" maxLength={80} className={inputCls} />
          </Field>
        </div>
        <Field label="Notes">
          <textarea name="body" rows={3} maxLength={20000} className={textareaCls} />
        </Field>
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
        >
          <CalendarClock className="h-3.5 w-3.5" aria-hidden />
          Log interaction
        </button>
      </form>
    </Disclosure>
  );
}

function prettySaved(saved: string): string {
  switch (saved) {
    case "created":
      return "Company created.";
    case "updated":
      return "Company updated.";
    case "status":
      return "Pipeline status updated.";
    case "contact":
      return "Contact added.";
    case "contact_removed":
      return "Contact removed.";
    case "research":
      return "Research report saved.";
    case "recommendation":
      return "Recommendation saved.";
    case "logged":
      return "Interaction logged.";
    case "promoted":
      return "Research promoted to Shared Memory.";
    default:
      return "Saved.";
  }
}

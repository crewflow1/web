import Link from "next/link";
import { IconTile } from "@/components/ui";
import { notFound } from "next/navigation";
import { pill } from "@/components/ui/tokens";
import {
  Brain,
  Building2,
  CalendarClock,
  ExternalLink,
  Facebook,
  Gauge,
  HeartHandshake,
  Instagram,
  Landmark,
  Lightbulb,
  Linkedin,
  ListChecks,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Plus,
  Share2,
  Sparkles,
  Target,
  Trash2,
} from "lucide-react";
import {
  listChannelTypes,
  listTaskTypes,
  loadCompanyDetail,
} from "@/server/services/hq-sales";
import { listAiEmployees } from "@/server/services/ai-employees";
import type { AiEmployee } from "@/lib/ai-employees/model";
import {
  AI_TASK_PRIORITIES,
  AI_TASK_PRIORITY_LABELS,
  CHANNEL_STATUSES,
  EVENT_DIRECTIONS,
  GENERATED_BY,
  INTELLIGENCE_SCORE_FIELDS,
  INTERACTION_EVENT_TYPES,
  PIPELINE_STATUSES,
  RISK_LEVELS,
  RISK_LABELS,
  SENIORITIES,
  SENIORITY_LABELS,
  STATUS_LABELS,
  DIRECTION_LABELS,
  EVENT_LABELS,
  aiTaskPriorityLabel,
  departmentLabel,
  employeeBandLabel,
  formatGbp,
  isPromotableOutcome,
  likelihoodLabel,
  relativeTime,
  riskLabel,
  seniorityLabel,
  type SalesAiTask,
  type SalesChannel,
  type SalesChannelType,
  type SalesContact,
  type SalesLocation,
  type SalesRecommendation,
  type SalesResearchReport,
  type SalesTaskType,
} from "@/lib/sales/model";
import {
  buildIntelligenceProfile,
  relationshipBandLabel,
  type IntelligenceFactor,
  type LikelihoodToBuy,
  type RelationshipBand,
  type RelationshipScore,
} from "@/lib/sales/intelligence";
import {
  AiTaskStatusPill,
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
  addChannelAction,
  addContactAction,
  addLocationAction,
  addRecommendationAction,
  addResearchAction,
  deleteChannelAction,
  deleteContactAction,
  enqueueAiTaskAction,
  logInteractionAction,
  promoteOutcomeAction,
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

  const {
    company: c,
    contacts,
    locations,
    channels,
    research,
    recommendations,
    timeline,
    tasks,
  } = detail;
  const [employees, channelTypes, taskTypes] = await Promise.all([
    listAiEmployees(),
    listChannelTypes(),
    listTaskTypes(),
  ]);
  const channelTypeBySlug = new Map(channelTypes.map((t) => [t.slug, t]));

  const saved = sp.saved ? prettySaved(sp.saved) : null;
  const errorMsg = sp.error ? decodeURIComponent(sp.error) : null;
  const activeReco = recommendations.find((r) => r.status === "active") ?? null;
  const pastRecos = recommendations.filter((r) => r.id !== activeReco?.id);

  // Derived AI Company Intelligence (Directive 004, Phase 4) — relationship
  // score, likelihood-to-buy composite + reasoning, profile completeness.
  // Pure read of already-loaded data: no extra query, no schema change.
  const profile = buildIntelligenceProfile({ company: c, timeline });

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      <div className="space-y-5 p-5 sm:p-7">
        {/* Breadcrumb */}
        <p className="text-sm text-slate-500">
          <Link href="/admin/sales" className="transition-colors hover:text-slate-300">
            Sales AI
          </Link>{" "}
          /{" "}
          <Link href="/admin/sales/companies" className="transition-colors hover:text-slate-300">
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
              <IconTile size="lg" className="shrink-0">
                <Building2 className="h-6 w-6" strokeWidth={1.75} aria-hidden />
              </IconTile>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill status={c.status} />
                  <ScorePill score={c.ai_qualification_score} prefix="AI" />
                  {c.crm_score != null ? (
                    <ScorePill score={c.crm_score} prefix="CRM" />
                  ) : null}
                  <Pill className={likelihoodPill(profile.likelihood.band)}>
                    {profile.likelihood.score != null
                      ? `${profile.likelihood.score} · `
                      : ""}
                    {likelihoodLabel(profile.likelihood.band)} to buy
                  </Pill>
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
                      className="inline-flex items-center gap-1 text-indigo-400 transition-colors hover:text-indigo-300"
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

        {/* AI intelligence profile — derived synthesis (Directive 004, Phase 4) */}
        <Section
          title="AI intelligence profile"
          subtitle="Synthesised from the AI qualification score, the enrichment signals and the full contact history. Explainable — every contributing factor is shown, and nothing is invented."
          action={
            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
              <Brain className="h-3.5 w-3.5" aria-hidden />
              Intelligence
            </span>
          }
        >
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <IntelGauge
              icon={<Target className="h-3.5 w-3.5" aria-hidden />}
              title="Likelihood to buy"
              value={profile.likelihood.score}
              arc={likelihoodArc(profile.likelihood.band)}
              pill={
                <Pill className={likelihoodPill(profile.likelihood.band)}>
                  {likelihoodLabel(profile.likelihood.band)}
                </Pill>
              }
              caption="Composite of fit, engagement and momentum"
            />
            <IntelGauge
              icon={<HeartHandshake className="h-3.5 w-3.5" aria-hidden />}
              title="Relationship"
              value={profile.relationship.score}
              arc={relationshipArc(profile.relationship.band)}
              pill={
                <Pill className={relationshipPillClass(profile.relationship.band)}>
                  {relationshipBandLabel(profile.relationship.score)}
                </Pill>
              }
              caption={relationshipCaption(profile.relationship)}
            />
            <IntelGauge
              icon={<Gauge className="h-3.5 w-3.5" aria-hidden />}
              title="Profile completeness"
              value={profile.completeness.pct}
              unit="%"
              arc="rgb(129,140,248)"
              pill={
                <Pill className={pill("indigo")}>
                  {profile.completeness.present}/{profile.completeness.total} signals
                </Pill>
              }
              caption={
                profile.completeness.missing.length === 0
                  ? "Fully enriched"
                  : `Missing: ${profile.completeness.missing.slice(0, 3).join(", ")}${
                      profile.completeness.missing.length > 3 ? "…" : ""
                    }`
              }
            />
          </div>

          {/* AI reasoning — the ordered factors behind the composite. */}
          <div className="mt-4 border-t border-slate-800 pt-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              AI reasoning
            </p>
            <ul className="mt-2.5 space-y-2.5">
              {profile.likelihood.factors.map((f) => (
                <FactorRow key={f.key} factor={f} />
              ))}
            </ul>
          </div>
        </Section>

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

            {/* Locations */}
            <Section
              title="Locations"
              subtitle={`${locations.length} ${locations.length === 1 ? "site" : "sites"} — multiple offices, depots, sites.`}
              action={
                <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
                  <MapPin className="h-3.5 w-3.5" aria-hidden />
                  {locations.length}
                </span>
              }
            >
              {locations.length === 0 ? (
                <p className="text-sm text-slate-500">No locations yet.</p>
              ) : (
                <ul className="space-y-2">
                  {locations.map((loc) => (
                    <LocationRow key={loc.id} location={loc} />
                  ))}
                </ul>
              )}
              <AddLocationForm companyId={c.id} employees={employees} />
            </Section>

            {/* Channels — multiple phones / emails / LinkedIn / socials */}
            <Section
              title="Contact channels"
              subtitle={`${channels.length} ${channels.length === 1 ? "channel" : "channels"} — every phone, email, LinkedIn and social account.`}
              action={
                <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
                  <Share2 className="h-3.5 w-3.5" aria-hidden />
                  {channels.length}
                </span>
              }
            >
              {channels.length === 0 ? (
                <p className="text-sm text-slate-500">No channels yet.</p>
              ) : (
                <ul className="space-y-2">
                  {channels.map((ch) => (
                    <ChannelRow
                      key={ch.id}
                      channel={ch}
                      companyId={c.id}
                      typeLabel={
                        channelTypeBySlug.get(ch.channel_type)?.label ??
                        ch.channel_type
                      }
                    />
                  ))}
                </ul>
              )}
              <AddChannelForm
                companyId={c.id}
                channelTypes={channelTypes}
                contacts={contacts}
                locations={locations}
                employees={employees}
              />
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
                    className="text-indigo-400 transition-colors hover:text-indigo-300"
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
                  <a href={`mailto:${c.primary_email}`} className="text-indigo-400 transition-colors hover:text-indigo-300">
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
                    className="inline-flex items-center gap-1 text-indigo-400 transition-colors hover:text-indigo-300"
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

        {/* Company Intelligence — reserved signals (Directive 003) */}
        <Section
          title="Company intelligence signals"
          subtitle="Reserved enrichment signals — populated automatically by future autonomous research. Nothing is invented; empty means not yet enriched."
          action={
            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
              <Gauge className="h-3.5 w-3.5" aria-hidden />
              Intelligence
            </span>
          }
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Tile label="Revenue est." value={formatGbp(c.revenue_estimate_gbp)} />
            <Tile
              label="Software spend est."
              value={formatGbp(c.estimated_software_spend_gbp)}
            />
            <Tile
              label="Fleet size"
              value={c.fleet_size != null ? c.fleet_size.toLocaleString() : "—"}
            />
            <Tile
              label="Staff size"
              value={c.staff_size != null ? c.staff_size.toLocaleString() : "—"}
            />
            <Tile
              label="Construction sector"
              value={c.construction_sector ?? "—"}
            />
            <Tile
              label="AI qualification"
              value={c.ai_qualification_score != null ? c.ai_qualification_score : "—"}
              accent
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {INTELLIGENCE_SCORE_FIELDS.map((f) => (
              <span key={f.key} className="inline-flex items-center gap-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  {f.label}
                </span>
                <ScorePill score={c[f.key]} />
              </span>
            ))}
          </div>

          {c.software_used.length > 0 ? (
            <div className="mt-3 border-t border-slate-800 pt-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                Software in use
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {c.software_used.map((s) => (
                  <Chip key={s}>{s}</Chip>
                ))}
              </div>
            </div>
          ) : null}
        </Section>

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
              <summary className="cursor-pointer text-xs font-medium text-slate-400 transition-colors hover:text-slate-200">
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

        {/* AI task queue — foundation for autonomous workers */}
        <Section
          title="AI task queue"
          subtitle="Work scheduled for the autonomous sales engine. No worker runs yet — this is the durable, audited foundation."
          action={
            <Link
              href="/admin/sales/tasks"
              className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-300 ring-1 ring-inset ring-indigo-400/30 transition hover:bg-indigo-500/20"
            >
              <ListChecks className="h-3.5 w-3.5" aria-hidden />
              {tasks.length} · Open queue
            </Link>
          }
        >
          {tasks.length === 0 ? (
            <p className="text-sm text-slate-500">No tasks scheduled.</p>
          ) : (
            <ul className="space-y-2">
              {tasks.map((t) => (
                <TaskRow key={t.id} task={t} />
              ))}
            </ul>
          )}
          <EnqueueTaskForm
            companyId={c.id}
            taskTypes={taskTypes}
            contacts={contacts}
            employees={employees}
          />
        </Section>

        {/* Timeline */}
        <Section
          title="Contact timeline"
          subtitle="Every interaction, AI action, and lifecycle marker — newest first. Winning outcomes can be promoted into Shared Memory."
        >
          <LogInteractionForm companyId={c.id} contacts={contacts} />
          {timeline.length === 0 ? (
            <EmptyState message="No timeline events yet." />
          ) : (
            <ul className="relative mt-4">
              {timeline.map((e) => (
                <TimelineItem
                  key={e.id}
                  event={e}
                  promoteSlot={
                    isPromotableOutcome(e.event_type) ? (
                      e.memory_id ? (
                        <Link
                          href={`/admin/memory/${e.memory_id}`}
                          className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-300 transition-colors hover:text-emerald-200"
                        >
                          <Brain className="h-3.5 w-3.5" aria-hidden />
                          In Shared Memory
                        </Link>
                      ) : (
                        <form action={promoteOutcomeAction}>
                          <input type="hidden" name="event_id" value={e.id} />
                          <input type="hidden" name="company_id" value={c.id} />
                          <button
                            type="submit"
                            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-slate-200 transition hover:bg-slate-800"
                          >
                            <Brain className="h-3.5 w-3.5" aria-hidden />
                            Promote to Shared Memory
                          </button>
                        </form>
                      )
                    ) : null
                  }
                />
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

// ---------------------------------------------------------------------
// AI intelligence profile — gauges + reasoning (Directive 004, Phase 4).
// Server components, no client JS: the rings are pure conic-gradient CSS.
// ---------------------------------------------------------------------

function IntelGauge({
  icon,
  title,
  value,
  arc,
  pill,
  caption,
  unit,
}: {
  icon: React.ReactNode;
  title: string;
  value: number | null;
  arc: string;
  pill: React.ReactNode;
  caption: string;
  unit?: string;
}) {
  const pctVal = value == null ? 0 : Math.max(0, Math.min(100, value));
  const deg = (pctVal / 100) * 360;
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4 text-center">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {icon}
        {title}
      </div>
      <div
        className="relative flex items-center justify-center rounded-full"
        style={{
          width: 112,
          height: 112,
          background: `conic-gradient(${arc} ${deg}deg, rgba(148,163,184,0.14) ${deg}deg 360deg)`,
        }}
      >
        <div
          className="flex flex-col items-center justify-center rounded-full bg-slate-950"
          style={{ width: 84, height: 84 }}
        >
          <span className="text-2xl font-bold tabular-nums text-white">
            {value == null ? "—" : value}
            {value != null && unit ? (
              <span className="text-sm text-slate-400">{unit}</span>
            ) : null}
          </span>
        </div>
      </div>
      {pill}
      <p className="text-[11px] leading-snug text-slate-500">{caption}</p>
    </div>
  );
}

function FactorRow({ factor }: { factor: IntelligenceFactor }) {
  const dot =
    factor.tone === "positive"
      ? "bg-emerald-400"
      : factor.tone === "negative"
        ? "bg-red-400"
        : "bg-amber-400";
  const valCls =
    factor.tone === "positive"
      ? "text-emerald-300"
      : factor.tone === "negative"
        ? "text-red-300"
        : "text-amber-300";
  return (
    <li className="flex items-center gap-3">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-slate-200">
            {factor.label}
          </span>
          <span className={`text-xs font-bold tabular-nums ${valCls}`}>
            {factor.value}
          </span>
        </div>
        <p className="truncate text-[11px] text-slate-500">{factor.detail}</p>
      </div>
      <div className="hidden w-24 shrink-0 sm:block">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
          <div
            className="h-full rounded-full bg-gradient-to-r from-indigo-500/70 to-emerald-500/70"
            style={{ width: `${Math.max(0, Math.min(100, factor.value))}%` }}
          />
        </div>
      </div>
    </li>
  );
}

function likelihoodArc(band: LikelihoodToBuy["band"]): string {
  switch (band) {
    case "very_high":
      return "rgb(52,211,153)";
    case "high":
      return "rgb(56,189,248)";
    case "medium":
      return "rgb(251,191,36)";
    default:
      return "rgb(148,163,184)";
  }
}

function relationshipArc(band: RelationshipBand): string {
  switch (band) {
    case "strong":
      return "rgb(52,211,153)";
    case "engaged":
      return "rgb(56,189,248)";
    case "warming":
      return "rgb(251,191,36)";
    default:
      return "rgb(148,163,184)";
  }
}

function relationshipPillClass(band: RelationshipBand): string {
  switch (band) {
    case "strong":
      return pill("emerald");
    case "engaged":
      return pill("sky");
    case "warming":
      return pill("amber");
    default:
      return pill("muted");
  }
}

function relationshipCaption(rel: RelationshipScore): string {
  if (rel.touches === 0) return "No contact logged yet";
  const parts = [
    `${rel.touches} ${rel.touches === 1 ? "touch" : "touches"}`,
    rel.twoWay ? "two-way" : "one-way",
  ];
  if (rel.lastTouchAt) parts.push(`last ${relativeTime(rel.lastTouchAt)}`);
  return parts.join(" · ");
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
      <Pill className={pill("indigo")}>
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
            <Pill className={pill("amber")}>
              Primary
            </Pill>
          ) : null}
          <Chip>{seniorityLabel(ct.seniority)}</Chip>
          {ct.is_decision_maker ? <Chip>Decision maker</Chip> : null}
        </div>
        {ct.title ? <p className="mt-0.5 text-xs text-slate-400">{ct.title}</p> : null}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          {ct.email ? (
            <a href={`mailto:${ct.email}`} className="inline-flex items-center gap-1 transition-colors hover:text-indigo-300">
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
              className="inline-flex items-center gap-1 transition-colors hover:text-indigo-300"
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

function LocationRow({ location: loc }: { location: SalesLocation }) {
  const line = [
    loc.address_line1,
    loc.address_line2,
    loc.city,
    loc.county ?? loc.region,
    loc.postcode,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <li className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <MapPin className="h-3.5 w-3.5 text-slate-500" aria-hidden />
        <span className="font-medium text-slate-200">
          {loc.label ?? loc.city ?? "Location"}
        </span>
        {loc.is_headquarters ? (
          <Pill className={pill("amber")}>
            HQ
          </Pill>
        ) : null}
        {loc.is_primary && !loc.is_headquarters ? <Chip>Primary</Chip> : null}
      </div>
      {line ? (
        <p className="mt-1 text-xs text-slate-400">
          {line}
          {loc.country && loc.country !== "United Kingdom" ? `, ${loc.country}` : ""}
        </p>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        {loc.phone ? (
          <span className="inline-flex items-center gap-1">
            <Phone className="h-3 w-3" aria-hidden /> {loc.phone}
          </span>
        ) : null}
        {loc.latitude != null && loc.longitude != null ? (
          <span className="tabular-nums">
            {loc.latitude.toFixed(4)}, {loc.longitude.toFixed(4)}
          </span>
        ) : null}
      </div>
      {loc.notes ? (
        <p className="mt-1.5 whitespace-pre-wrap text-xs text-slate-400">{loc.notes}</p>
      ) : null}
    </li>
  );
}

function ChannelRow({
  channel: ch,
  companyId,
  typeLabel,
}: {
  channel: SalesChannel;
  companyId: string;
  typeLabel: string;
}) {
  return (
    <li className="flex items-start justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Chip>{typeLabel}</Chip>
          <span className="break-all font-medium text-slate-200">{ch.value}</span>
          {ch.is_primary ? (
            <Pill className={pill("amber")}>
              Primary
            </Pill>
          ) : null}
          {ch.is_verified ? (
            <Pill className={pill("emerald")}>
              Verified
            </Pill>
          ) : null}
          {ch.status !== "active" ? <Chip>{ch.status}</Chip> : null}
        </div>
        {ch.label ? (
          <p className="mt-0.5 text-xs text-slate-400">{ch.label}</p>
        ) : null}
      </div>
      <form action={deleteChannelAction}>
        <input type="hidden" name="id" value={ch.id} />
        <input type="hidden" name="company_id" value={companyId} />
        <button
          type="submit"
          aria-label={`Remove ${ch.value}`}
          className="rounded-md border border-slate-800 p-1.5 text-slate-500 transition hover:border-red-500/40 hover:text-red-300"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      </form>
    </li>
  );
}

function TaskRow({ task: t }: { task: SalesAiTask }) {
  return (
    <li className="flex items-start justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-slate-200">
            {t.task_type.replace(/_/g, " ")}
          </span>
          <AiTaskStatusPill status={t.status} />
          <Chip>{aiTaskPriorityLabel(t.priority)}</Chip>
          {t.retry_count > 0 ? (
            <Chip>
              retry {t.retry_count}/{t.max_retries}
            </Chip>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
          {t.scheduled_at ? (
            <span>Scheduled {relativeTime(t.scheduled_at)}</span>
          ) : (
            <span>Queued {relativeTime(t.created_at)}</span>
          )}
          {t.error_message ? (
            <span className="text-red-300">{t.error_message}</span>
          ) : null}
        </div>
      </div>
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
            className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-300 transition-colors hover:text-emerald-200"
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
            <Pill className={pill("emerald")}>
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
      <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-xs font-semibold text-indigo-300 transition-colors hover:text-indigo-200">
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

function AuthorshipFields({ employees }: { employees: AiEmployee[] }) {
  return (
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
        <input name="model" type="text" maxLength={120} placeholder="claude-…" className={inputCls} />
      </Field>
      <EmployeeSelect employees={employees} />
    </div>
  );
}

function AddLocationForm({
  companyId,
  employees,
}: {
  companyId: string;
  employees: AiEmployee[];
}) {
  return (
    <Disclosure label="Add location">
      <form action={addLocationAction} className="space-y-3">
        <input type="hidden" name="company_id" value={companyId} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Label" hint="e.g. Head office, North depot">
            <input name="label" type="text" maxLength={120} className={inputCls} />
          </Field>
          <Field label="Phone">
            <input name="phone" type="text" maxLength={60} className={inputCls} />
          </Field>
          <Field label="Address line 1">
            <input name="address_line1" type="text" maxLength={300} className={inputCls} />
          </Field>
          <Field label="Address line 2">
            <input name="address_line2" type="text" maxLength={300} className={inputCls} />
          </Field>
          <Field label="Town / city">
            <input name="city" type="text" maxLength={160} className={inputCls} />
          </Field>
          <Field label="County">
            <input name="county" type="text" maxLength={160} className={inputCls} />
          </Field>
          <Field label="Region">
            <input name="region" type="text" maxLength={160} className={inputCls} />
          </Field>
          <Field label="Postcode">
            <input name="postcode" type="text" maxLength={32} className={inputCls} />
          </Field>
          <Field label="Country">
            <input name="country" type="text" maxLength={120} defaultValue="United Kingdom" className={inputCls} />
          </Field>
        </div>
        <Field label="Notes">
          <textarea name="notes" rows={2} maxLength={4000} className={textareaCls} />
        </Field>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" name="is_primary" className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-indigo-500 focus:ring-indigo-500" />
            Primary site
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" name="is_headquarters" className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-indigo-500 focus:ring-indigo-500" />
            Headquarters
          </label>
        </div>
        <AuthorshipFields employees={employees} />
        <button
          type="submit"
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
        >
          Add location
        </button>
      </form>
    </Disclosure>
  );
}

function AddChannelForm({
  companyId,
  channelTypes,
  contacts,
  locations,
  employees,
}: {
  companyId: string;
  channelTypes: SalesChannelType[];
  contacts: SalesContact[];
  locations: SalesLocation[];
  employees: AiEmployee[];
}) {
  return (
    <Disclosure label="Add channel">
      <form action={addChannelAction} className="space-y-3">
        <input type="hidden" name="company_id" value={companyId} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Channel type">
            <select name="channel_type" defaultValue={channelTypes[0]?.slug ?? ""} className={selectCls}>
              {channelTypes.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Value" hint="number / email / URL">
            <input name="value" type="text" required maxLength={500} className={inputCls} />
          </Field>
          <Field label="Label" hint="optional">
            <input name="label" type="text" maxLength={120} className={inputCls} />
          </Field>
          <Field label="Status">
            <select name="status" defaultValue="active" className={selectCls}>
              {CHANNEL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Linked contact" hint="optional">
            <select name="contact_id" defaultValue="" className={selectCls}>
              <option value="">— None —</option>
              {contacts.map((ct) => (
                <option key={ct.id} value={ct.id}>
                  {ct.full_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Linked location" hint="optional">
            <select name="location_id" defaultValue="" className={selectCls}>
              <option value="">— None —</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.label ?? loc.city ?? loc.postcode ?? "Location"}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" name="is_primary" className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-indigo-500 focus:ring-indigo-500" />
            Primary
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" name="is_verified" className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-indigo-500 focus:ring-indigo-500" />
            Verified
          </label>
        </div>
        <AuthorshipFields employees={employees} />
        <button
          type="submit"
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
        >
          Add channel
        </button>
      </form>
    </Disclosure>
  );
}

function EnqueueTaskForm({
  companyId,
  taskTypes,
  contacts,
  employees,
}: {
  companyId: string;
  taskTypes: SalesTaskType[];
  contacts: SalesContact[];
  employees: AiEmployee[];
}) {
  return (
    <Disclosure label="Schedule AI task">
      <form action={enqueueAiTaskAction} className="space-y-3">
        <input type="hidden" name="company_id" value={companyId} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Task type">
            <select name="task_type" defaultValue={taskTypes[0]?.slug ?? ""} className={selectCls}>
              {taskTypes.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select name="priority" defaultValue="normal" className={selectCls}>
              {AI_TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {AI_TASK_PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Scheduled for" hint="optional">
            <input name="scheduled_at" type="datetime-local" className={inputCls} />
          </Field>
          <Field label="Max retries" hint="0–10">
            <input name="max_retries" type="number" min={0} max={10} defaultValue={3} className={inputCls} />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="For contact" hint="optional">
            <select name="contact_id" defaultValue="" className={selectCls}>
              <option value="">— None —</option>
              {contacts.map((ct) => (
                <option key={ct.id} value={ct.id}>
                  {ct.full_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Assign AI employee" hint="optional">
            <select name="assigned_ai_employee_id" defaultValue="" className={selectCls}>
              <option value="">— Unassigned —</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} ({departmentLabel(e.department)})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Dedupe key" hint="optional — prevents duplicates">
            <input name="dedupe_key" type="text" maxLength={200} className={inputCls} />
          </Field>
        </div>
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
        >
          <ListChecks className="h-3.5 w-3.5" aria-hidden />
          Schedule task
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
    case "location":
      return "Location added.";
    case "channel":
      return "Channel added.";
    case "channel_removed":
      return "Channel removed.";
    case "task":
      return "AI task scheduled.";
    case "research":
      return "Research report saved.";
    case "recommendation":
      return "Recommendation saved.";
    case "logged":
      return "Interaction logged.";
    case "promoted":
      return "Promoted to Shared Memory.";
    default:
      return "Saved.";
  }
}

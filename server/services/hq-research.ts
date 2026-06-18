import "server-only";

/**
 * CrewFlow HQ — Research AI runner (CEO Directive 005, the execution engine).
 *
 * This is the worker that brings the inert Directive-004 schema to life. It
 * owns NO tables of its own: it claims a `research_company` task off the
 * existing AI task queue, drives the lifecycle (Queued → Running → Researching
 * → Analysing → Scoring → Reasoning → Completed/Failed), and persists every
 * artifact through the existing Sales-AI writers (hq-sales.ts) and Shared
 * Memory bridge. Each step is mirrored to the permanent company timeline
 * (Phase 9) and to the task's `result` jsonb so the live UI can poll progress.
 *
 * Honesty + safety (Directive 005):
 *   • Read + draft only. It fetches PUBLIC signals, analyses them, scores
 *     transparently, and writes INTERNAL research artifacts + DRAFT outreach.
 *     It never contacts a prospect, never sends, never moves money.
 *   • Never invents data. When the website is unreachable or a provider key is
 *     absent, the run still completes honestly with "unknown" fields, a
 *     low-confidence score, and `deterministic` provenance — degradation is a
 *     first-class path, not a crash.
 *   • Every figure is traceable: artifacts carry generated_by='ai', the model
 *     used, and the Research AI employee id; every step is a timeline row.
 *
 * Performance: the route that calls runResearchTask sets maxDuration=60 and
 * checkpoints after every step, so a cold task is resumable and a cron drain
 * can re-run anything left stuck in 'running'.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import {
  computeRelationshipScore,
} from "@/lib/sales/intelligence";
import {
  clampScore,
  likelihoodBandFromScore,
  scoreBand,
  scoreBandLabel,
  type SalesCompany,
  type SalesContact,
  type SalesTimelineEvent,
} from "@/lib/sales/model";
import {
  applyStep,
  emptyIntelligence,
  initialSteps,
  RESEARCH_STEP_LABEL,
  type CommsDrafts,
  type CompanyIntelligence,
  type DecisionMaker,
  type ResearchPhase,
  type ResearchProvenance,
  type ResearchRunState,
  type ResearchRunSummary,
  type ResearchStepKey,
  type ResearchStepState,
  type SalesBrief,
} from "@/lib/research/model";
import { scoreCompany, type ResearchScoreFactor } from "@/lib/research/score";
import {
  analysisHasContent,
  type AnalysisPromptInput,
  type SalesPromptInput,
} from "@/lib/research/prompts";
import {
  formatCompaniesHouseFacts,
  gatherSiteContent,
  lookupCompaniesHouse,
  normaliseCompanyNumber,
  yearsTradingFrom,
  type CompaniesHouseFacts,
  type SiteContent,
} from "@/server/services/research-fetch";
import {
  researchAiEnabled,
  runResearchAnalysis,
  runResearchSalesPrep,
} from "@/server/services/research-llm";
import { listAiEmployees } from "@/server/services/ai-employees";
import {
  addContact,
  addRecommendation,
  addResearchReport,
  createCompany,
  getCompany,
  promoteResearchToMemory,
  recordTimelineEvent,
  type WriteResult,
} from "@/server/services/hq-sales";
import { normaliseUrl } from "@/lib/research/extract";

const RESEARCH_AI_SLUG = "research-ai";
/** A task left 'running' longer than this is presumed dead → re-claimable. */
const STUCK_RUNNING_MS = 5 * 60 * 1000;

type Actor = { id: string | null; email: string | null };
const SYSTEM_ACTOR: Actor = { id: null, email: null };

// ---------------------------------------------------------------------
// Minimal typed access to hq_sales_ai_tasks (the runner's only direct table).
// Mirrors the cast shim used across hq-sales.ts — a typing convenience, not
// duplicated business logic.
// ---------------------------------------------------------------------

type AdminClient = ReturnType<typeof createAdminClient>;
type DbList<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
interface TaskQuery<T> extends DbList<T> {
  select(columns: string): TaskQuery<T>;
  insert(payload: unknown): TaskQuery<T>;
  update(payload: unknown): TaskQuery<T>;
  eq(column: string, value: unknown): TaskQuery<T>;
  in(column: string, values: ReadonlyArray<unknown>): TaskQuery<T>;
  lt(column: string, value: unknown): TaskQuery<T>;
  order(column: string, options?: { ascending?: boolean }): TaskQuery<T>;
  limit(count: number): TaskQuery<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: { message: string } | null }>;
}
function tasks<T>(admin: AdminClient): TaskQuery<T> {
  return admin.from("hq_sales_ai_tasks" as never) as unknown as TaskQuery<T>;
}

type TaskRow = {
  id: string;
  company_id: string | null;
  task_type: string;
  status: string;
  retry_count: number;
  max_retries: number;
  payload: Record<string, unknown> | null;
  result: ResearchResult | null;
  created_by_email: string | null;
  started_at: string | null;
};

const TASK_RUN_COLUMNS =
  "id, company_id, task_type, status, retry_count, max_retries, payload, result, created_by_email, started_at";

// ---------------------------------------------------------------------
// The task `result` jsonb the live UI polls. Bounded by construction.
// ---------------------------------------------------------------------

type ResearchResult = {
  phase: ResearchPhase;
  steps: ResearchStepState[];
  summary: ResearchRunSummary | null;
  provenance: ResearchProvenance | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  pagesFetched: string[];
  intelligence: CompanyIntelligence | null;
  decisionMakers: DecisionMaker[];
  scoreFactors: ResearchScoreFactor[];
  brief: SalesBrief | null;
  drafts: CommsDrafts | null;
};

function freshResult(): ResearchResult {
  return {
    phase: "running",
    steps: initialSteps(),
    summary: null,
    provenance: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    pagesFetched: [],
    intelligence: null,
    decisionMakers: [],
    scoreFactors: [],
    brief: null,
    drafts: null,
  };
}

// ---------------------------------------------------------------------
// Research AI employee id — resolved once, cached for the process.
// ---------------------------------------------------------------------

let cachedEmployeeId: string | null | undefined;
async function researchEmployeeId(): Promise<string | null> {
  if (cachedEmployeeId !== undefined) return cachedEmployeeId;
  const employees = await listAiEmployees();
  cachedEmployeeId = employees.find((e) => e.slug === RESEARCH_AI_SLUG)?.id ?? null;
  return cachedEmployeeId;
}

// ---------------------------------------------------------------------
// Enqueue — the entry points the UI/action use.
// ---------------------------------------------------------------------

export type StartResearchInput = {
  /** Existing company to research, OR omit and pass identity to create one. */
  companyId?: string | null;
  name?: string | null;
  website?: string | null;
  companiesHouseNumber?: string | null;
};

export type StartResearchResult =
  | { ok: true; companyId: string; taskId: string }
  | { ok: false; error: string };

/**
 * Resolve (or create) the target company, then enqueue a research_company task
 * assigned to Research AI. Returns the ids so the caller can route to the live
 * run view. Creating a company from a bare URL/name is allowed — that's a
 * record, not fabricated activity.
 */
export async function startResearch(
  input: StartResearchInput,
  actor: Actor,
): Promise<StartResearchResult> {
  const admin = createAdminClient();
  let companyId = input.companyId ?? null;

  if (!companyId) {
    const name = (input.name ?? "").trim();
    const website = input.website ? normaliseUrl(input.website) : null;
    if (!name && !website) {
      return { ok: false, error: "Provide a company name or website to research." };
    }
    const created = await createCompany(
      {
        name: name || website || "Unnamed company",
        summary: "",
        website,
        industry: null,
        employeeCount: null,
        annualTurnoverGbp: null,
        location: null,
        region: null,
        county: null,
        country: "United Kingdom",
        primaryEmail: null,
        primaryPhone: null,
        linkedinUrl: null,
        instagramUrl: null,
        facebookUrl: null,
        companiesHouseUrl: null,
        companiesHouseNumber: normaliseCompanyNumber(input.companiesHouseNumber),
        websiteTechnology: [],
        crmScore: null,
        aiQualificationScore: null,
        estimatedDealValueGbp: null,
        status: "new",
        source: "ai_research",
        assignedToEmail: null,
        tags: [],
        revenueEstimateGbp: null,
        growthScore: null,
        constructionSector: null,
        softwareUsed: [],
        estimatedSoftwareSpendGbp: null,
        fleetSize: null,
        staffSize: null,
        websiteQualityScore: null,
        marketingQualityScore: null,
        hiringActivityScore: null,
        digitalMaturityScore: null,
      },
      actor,
    );
    if (!created.ok) return { ok: false, error: created.error };
    companyId = created.id;
  }

  const employeeId = await researchEmployeeId();
  const { data, error } = await tasks<{ id: string }>(admin)
    .insert({
      company_id: companyId,
      task_type: "research_company",
      status: "pending",
      priority: "high",
      retry_count: 0,
      max_retries: 2,
      assigned_ai_employee_id: employeeId,
      payload: input.companiesHouseNumber
        ? { companies_house_number: normaliseCompanyNumber(input.companiesHouseNumber) }
        : null,
      source: "manual",
      created_by_email: actor.email,
    })
    .select("id")
    .maybeSingle();

  if (error || !data) {
    console.error("[hq-research] enqueue failed", error);
    return { ok: false, error: error?.message ?? "Could not enqueue research." };
  }

  await recordTimelineEvent({
    company_id: companyId,
    event_type: "task_scheduled",
    actor_email: actor.email,
    ai_employee_id: employeeId,
    body: "Research AI task scheduled.",
    metadata: { task_id: data.id, task_type: "research_company" },
  });

  return { ok: true, companyId, taskId: data.id };
}

// ---------------------------------------------------------------------
// Claim / checkpoint / finish.
// ---------------------------------------------------------------------

async function claimTask(admin: AdminClient, taskId: string): Promise<TaskRow | null> {
  const nowIso = new Date().toISOString();
  // Conditional update: only succeeds if the row is still pending (or stuck).
  const { data } = await tasks<TaskRow>(admin)
    .update({ status: "running", started_at: nowIso })
    .eq("id", taskId)
    .in("status", ["pending"])
    .select(TASK_RUN_COLUMNS);
  const claimed = Array.isArray(data) ? data[0] : null;
  if (claimed) return claimed;
  return null;
}

async function checkpoint(
  admin: AdminClient,
  taskId: string,
  result: ResearchResult,
): Promise<void> {
  const { error } = await tasks(admin).update({ result }).eq("id", taskId);
  if (error) console.error("[hq-research] checkpoint failed", error);
}

// ---------------------------------------------------------------------
// The pipeline.
// ---------------------------------------------------------------------

export type RunOutcome =
  | { ok: true; taskId: string; status: "completed"; score: number | null }
  | { ok: true; taskId: string; status: "skipped" }
  | { ok: false; taskId: string; status: "failed"; error: string };

export async function runResearchTask(taskId: string): Promise<RunOutcome> {
  const admin = createAdminClient();

  const claimed = await claimTask(admin, taskId);
  if (!claimed) {
    // Already running/finished, or cancelled — nothing to do (idempotent).
    return { ok: true, taskId, status: "skipped" };
  }

  const actor: Actor = { id: null, email: claimed.created_by_email };
  const companyId = claimed.company_id;
  const result = freshResult();

  // A step helper bound to this run: mutate result, persist, log timeline.
  const setStep = async (
    key: ResearchStepKey,
    status: ResearchStepState["status"],
    detail: string | null,
  ) => {
    result.steps = applyStep(result.steps, key, status, detail);
    await checkpoint(admin, taskId, result);
  };
  const setPhase = async (phase: ResearchPhase) => {
    result.phase = phase;
    await checkpoint(admin, taskId, result);
  };

  try {
    if (!companyId) throw new Error("Research task has no company.");
    const company = await getCompany(companyId);
    if (!company) throw new Error("Company not found for research task.");

    const employeeId = await researchEmployeeId();
    const aiActor = { generatedBy: "ai" as const, aiEmployeeId: employeeId };

    await recordTimelineEvent({
      company_id: companyId,
      event_type: "task_started",
      ai_employee_id: employeeId,
      source: "ai_research",
      body: `Research AI started analysing ${company.name}.`,
      metadata: { task_id: taskId },
    });

    // ---- PHASE: Researching -----------------------------------------
    await setPhase("researching");

    const site = await researchWebsite(company, result, setStep, employeeId);
    const ch = await researchCompaniesHouse(company, claimed, result, setStep, employeeId);

    // ---- PHASE: Analysing -------------------------------------------
    await setPhase("analysing");
    const { intelligence, provenance } = await analyse(
      company,
      site,
      ch,
      result,
      setStep,
      employeeId,
    );
    result.intelligence = intelligence;
    result.provenance = provenance;

    const decisionMakers = await identifyDecisionMakers(
      companyId,
      intelligence,
      ch,
      actor,
      result,
      setStep,
      employeeId,
    );
    result.decisionMakers = decisionMakers;

    // ---- PHASE: Scoring ---------------------------------------------
    await setPhase("scoring");
    const detectedTech = site?.signals?.technologies.map((t) => t.name) ?? [];
    const relationshipScore = await loadRelationshipScore(admin, companyId);
    const score = scoreCompany({
      intelligence,
      decisionMakers,
      detectedTechnologies: detectedTech,
      location: company.location ?? company.region ?? null,
      relationshipScore,
    });
    result.scoreFactors = score.factors;

    await persistEnrichment(admin, company, intelligence, site, score.overall, ch, detectedTech);

    await setStep(
      "score",
      "done",
      score.overall == null
        ? "Not enough signal to score"
        : `${score.overall}/100 · ${score.bandLabel} · ${score.confidence}% confidence`,
    );
    await recordTimelineEvent({
      company_id: companyId,
      event_type: "scored",
      ai_employee_id: employeeId,
      source: "ai_research",
      body:
        score.overall == null
          ? "AI score: insufficient data (honest unknown)."
          : `AI buying score calculated: ${score.overall}/100 (${score.bandLabel}).`,
      metadata: { score: score.overall, band: score.band, confidence: score.confidence },
    });

    // ---- PHASE: Reasoning -------------------------------------------
    await setPhase("reasoning");

    // The durable research report (folds intelligence + score together).
    const reportId = await writeResearchReport(
      companyId,
      company,
      intelligence,
      score.overall,
      score.factors,
      provenance,
      aiActor,
      actor,
    );

    const { brief, drafts } = await reasonSalesPrep(
      company,
      intelligence,
      decisionMakers,
      score.overall,
      score.factors,
      provenance,
      aiActor,
      actor,
      result,
      setStep,
      employeeId,
    );
    result.brief = brief;
    result.drafts = drafts;

    // Shared Memory (Phase 7) — promote the report so every AI can reuse it.
    await setStep("memory", "active", "Storing in Shared Memory…");
    if (reportId) {
      const mem = await promoteResearchToMemory(reportId, actor);
      await setStep(
        "memory",
        mem.ok ? "done" : "skipped",
        mem.ok ? "Findings stored in Shared Memory" : "Memory engine unavailable",
      );
    } else {
      await setStep("memory", "skipped", "No report to store");
    }

    // ---- PHASE: Completed -------------------------------------------
    const summary: ResearchRunSummary = {
      score: score.overall,
      scoreBand: score.bandLabel,
      likelihoodBand: likelihoodBandFromScore(score.overall),
      decisionMakers: decisionMakers.length,
      technologies: detectedTech.length,
      painPoints: intelligence.painPoints.length,
      confidence: intelligence.confidence ?? score.confidence,
      generatedBy: provenance,
    };
    result.summary = summary;
    result.phase = "completed";
    result.finishedAt = new Date().toISOString();
    result.steps = applyStep(result.steps, "completed", "done", "Research complete");

    await tasks(admin)
      .update({
        status: "completed",
        finished_at: result.finishedAt,
        result,
        error_message: null,
      })
      .eq("id", taskId);

    await recordTimelineEvent({
      company_id: companyId,
      event_type: "task_completed",
      ai_employee_id: employeeId,
      source: "ai_research",
      body: `Research complete — ${
        score.overall == null ? "score unknown" : `${score.overall}/100 (${score.bandLabel})`
      }, ${decisionMakers.length} decision maker${decisionMakers.length === 1 ? "" : "s"}.`,
      metadata: { task_id: taskId, score: score.overall, provenance },
    });

    return { ok: true, taskId, status: "completed", score: score.overall };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[hq-research] run failed", { taskId, error });
    result.phase = "failed";
    result.error = error;
    result.finishedAt = new Date().toISOString();
    await tasks(admin)
      .update({
        status: "failed",
        finished_at: result.finishedAt,
        error_message: error.slice(0, 4000),
        result,
        retry_count: claimed.retry_count + 1,
      })
      .eq("id", taskId);
    if (companyId) {
      await recordTimelineEvent({
        company_id: companyId,
        event_type: "task_failed",
        source: "ai_research",
        body: `Research failed: ${error}`,
        metadata: { task_id: taskId },
      });
    }
    return { ok: false, taskId, status: "failed", error };
  }
}

type SetStep = (
  key: ResearchStepKey,
  status: ResearchStepState["status"],
  detail: string | null,
) => Promise<void>;

// ---------------------------------------------------------------------
// Phase: Researching — website.
// ---------------------------------------------------------------------

async function researchWebsite(
  company: SalesCompany,
  result: ResearchResult,
  setStep: SetStep,
  employeeId: string | null,
): Promise<SiteContent | null> {
  const target = company.website || (company.domain ? `https://${company.domain}` : null);
  if (!target) {
    await setStep("website", "skipped", "No website on record");
    await setStep("technology", "skipped", "No website to scan");
    await setStep("contacts", "skipped", "No website to scan");
    return null;
  }

  await setStep("website", "active", `Fetching ${target}…`);
  const site = await gatherSiteContent(target);
  result.pagesFetched = site.pagesFetched;

  if (!site.ok || !site.signals) {
    await setStep("website", "failed", `Could not fetch site (${site.error ?? "unknown"})`);
    await setStep("technology", "skipped", "Site unreachable");
    await setStep("contacts", "skipped", "Site unreachable");
    return site;
  }

  const sig = site.signals;
  await setStep(
    "website",
    "done",
    `${site.pagesFetched.length} page${site.pagesFetched.length === 1 ? "" : "s"} analysed${
      sig.title ? ` · ${sig.title}` : ""
    }`,
  );
  await recordTimelineEvent({
    company_id: company.id,
    event_type: "research",
    ai_employee_id: employeeId,
    source: "ai_research",
    subject: sig.title,
    body: `Website analysed: ${site.finalUrl}. Quality ${sig.websiteQualityScore}/100.`,
    metadata: { pages: site.pagesFetched, websiteQuality: sig.websiteQualityScore },
  });

  // Technologies.
  await setStep(
    "technology",
    sig.technologies.length ? "done" : "skipped",
    sig.technologies.length
      ? `${sig.technologies.length} detected: ${sig.technologies.slice(0, 5).map((t) => t.name).join(", ")}`
      : "No technologies detected",
  );
  if (sig.technologies.length) {
    await recordTimelineEvent({
      company_id: company.id,
      event_type: "enriched",
      ai_employee_id: employeeId,
      source: "ai_research",
      body: `Technologies detected: ${sig.technologies.map((t) => t.name).join(", ")}.`,
      metadata: { technologies: sig.technologies.map((t) => t.name) },
    });
  }

  // Contact channels.
  const socialCount = Object.values(sig.socials).filter(Boolean).length;
  const contactBits = [
    sig.emails.length ? `${sig.emails.length} email${sig.emails.length === 1 ? "" : "s"}` : null,
    sig.phones.length ? `${sig.phones.length} phone${sig.phones.length === 1 ? "" : "s"}` : null,
    socialCount ? `${socialCount} social profile${socialCount === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  const hasContacts = contactBits.length > 0;
  await setStep(
    "contacts",
    hasContacts ? "done" : "skipped",
    hasContacts ? contactBits.join(", ") : "No public contact channels found",
  );
  if (hasContacts) {
    await recordTimelineEvent({
      company_id: company.id,
      event_type: "enriched",
      ai_employee_id: employeeId,
      source: "ai_research",
      body: `Contact channels extracted: ${contactBits.join(", ")}.`,
      metadata: { emails: sig.emails, phones: sig.phones },
    });
  }

  return site;
}

// ---------------------------------------------------------------------
// Phase: Researching — Companies House.
// ---------------------------------------------------------------------

async function researchCompaniesHouse(
  company: SalesCompany,
  task: TaskRow,
  result: ResearchResult,
  setStep: SetStep,
  employeeId: string | null,
): Promise<CompaniesHouseFacts | null> {
  void result;
  const fromPayload =
    task.payload && typeof task.payload.companies_house_number === "string"
      ? task.payload.companies_house_number
      : null;
  const number = normaliseCompanyNumber(company.companies_house_number ?? fromPayload);
  if (!number) {
    await setStep("companies_house", "skipped", "No company number to check");
    return null;
  }
  if (!process.env.COMPANIES_HOUSE_API_KEY) {
    await setStep("companies_house", "skipped", "Companies House not connected");
    return null;
  }

  await setStep("companies_house", "active", `Checking register ${number}…`);
  const ch = await lookupCompaniesHouse(number);
  if (!ch) {
    await setStep("companies_house", "failed", "Not found on the register");
    return null;
  }

  const officers = ch.officers.filter((o) => !o.resigned).length;
  await setStep(
    "companies_house",
    "done",
    `${ch.status ?? "registered"}${ch.incorporatedOn ? ` · since ${ch.incorporatedOn}` : ""} · ${officers} active officer${officers === 1 ? "" : "s"}`,
  );
  await recordTimelineEvent({
    company_id: company.id,
    event_type: "enriched",
    ai_employee_id: employeeId,
    source: "ai_research",
    body: `Companies House checked: ${ch.companyName ?? number} (${ch.status ?? "registered"}).`,
    metadata: { companyNumber: number, status: ch.status, sicCodes: ch.sicCodes },
  });
  return ch;
}

// ---------------------------------------------------------------------
// Phase: Analysing — intelligence.
// ---------------------------------------------------------------------

async function analyse(
  company: SalesCompany,
  site: SiteContent | null,
  ch: CompaniesHouseFacts | null,
  result: ResearchResult,
  setStep: SetStep,
  employeeId: string | null,
): Promise<{ intelligence: CompanyIntelligence; provenance: ResearchProvenance }> {
  void result;
  await setStep("intelligence", "active", "Building company intelligence…");

  const sig = site?.signals ?? null;
  // Deterministic baseline — always honest, even with no LLM.
  const base = emptyIntelligence();
  if (sig) {
    base.websiteQualityScore = sig.websiteQualityScore;
    base.digitalMaturityScore = sig.digitalMaturityScore;
    base.softwareUsed = sig.technologies.map((t) => t.name);
    base.hiringActivityScore = sig.hiring ? 70 : null;
    if (sig.hiring) base.recruitmentActivity = "Recruitment signals present on the website.";
  }
  if (ch) {
    base.yearsTrading = yearsTradingFrom(ch.incorporatedOn);
    if (ch.registeredOffice) base.locations = [ch.registeredOffice];
  }

  let provenance: ResearchProvenance = "deterministic";
  let intelligence = base;

  if (researchAiEnabled() && sig) {
    const promptInput: AnalysisPromptInput = {
      companyName: company.name,
      domain: company.domain ?? site?.domain ?? null,
      signals: {
        title: sig.title,
        metaDescription: sig.metaDescription,
        emails: sig.emails,
        phones: sig.phones,
        socials: sig.socials,
        technologies: sig.technologies.map((t) => t.name),
        hiring: sig.hiring,
      },
      siteText: sig.text,
      companiesHouseText: ch ? formatCompaniesHouseFacts(ch) : null,
    };
    const outcome = await runResearchAnalysis(promptInput);
    if (outcome && analysisHasContent(outcome.analysis)) {
      provenance = outcome.provider;
      intelligence = mergeIntelligence(base, outcome.analysis.intelligence);
      // Carry the LLM-found decision makers via a side channel on the object.
      llmDecisionMakers.set(company.id, outcome.analysis.decisionMakers);
    }
  }

  await setStep(
    "intelligence",
    "done",
    intelligence.overview
      ? truncate(intelligence.overview, 90)
      : provenance === "deterministic"
        ? "Deterministic profile (no AI provider / unreadable site)"
        : "Limited public information",
  );
  await recordTimelineEvent({
    company_id: company.id,
    event_type: "enriched",
    ai_employee_id: employeeId,
    source: "ai_research",
    body: `Company intelligence built (${provenance}).`,
    metadata: {
      industry: intelligence.industry,
      constructionSector: intelligence.constructionSector,
      services: intelligence.services.length,
      provenance,
    },
  });

  return { intelligence, provenance };
}

/** Deterministic baseline wins for the two computed scores; the LLM fills
 *  everything interpretive. Software stack is the union of both. */
function mergeIntelligence(
  base: CompanyIntelligence,
  llm: CompanyIntelligence,
): CompanyIntelligence {
  const softwareUsed = [...new Set([...base.softwareUsed, ...llm.softwareUsed])];
  return {
    ...llm,
    softwareUsed,
    websiteQualityScore: base.websiteQualityScore ?? llm.websiteQualityScore,
    digitalMaturityScore: base.digitalMaturityScore ?? llm.digitalMaturityScore,
    hiringActivityScore: llm.hiringActivityScore ?? base.hiringActivityScore,
    yearsTrading: llm.yearsTrading ?? base.yearsTrading,
    recruitmentActivity: llm.recruitmentActivity ?? base.recruitmentActivity,
    locations: llm.locations.length ? llm.locations : base.locations,
  };
}

/** A per-process side channel so analyse() can pass the LLM's decision makers
 *  to identifyDecisionMakers() without widening its return type. */
const llmDecisionMakers = new Map<string, DecisionMaker[]>();

// ---------------------------------------------------------------------
// Phase: Analysing — decision makers.
// ---------------------------------------------------------------------

async function identifyDecisionMakers(
  companyId: string,
  intelligence: CompanyIntelligence,
  ch: CompaniesHouseFacts | null,
  actor: Actor,
  result: ResearchResult,
  setStep: SetStep,
  employeeId: string | null,
): Promise<DecisionMaker[]> {
  void intelligence;
  void result;
  await setStep("decision_makers", "active", "Identifying decision makers…");

  const fromLlm = llmDecisionMakers.get(companyId) ?? [];
  llmDecisionMakers.delete(companyId);
  const fromCh = (ch?.officers ?? [])
    .filter((o) => !o.resigned)
    .map(officerToDecisionMaker);

  // Merge, de-duplicating by normalised name (LLM record wins — richer).
  const byName = new Map<string, DecisionMaker>();
  for (const dm of [...fromLlm, ...fromCh]) {
    const key = normaliseName(dm.fullName);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, dm);
  }
  const decisionMakers = [...byName.values()].slice(0, 12);

  if (decisionMakers.length === 0) {
    await setStep("decision_makers", "done", "None identified (honest unknown)");
    return [];
  }

  // Persist as contacts — skipping names already on the company.
  const existing = await loadExistingContactNames(companyId);
  let added = 0;
  for (const dm of decisionMakers) {
    if (existing.has(normaliseName(dm.fullName))) continue;
    const res = await addContact(
      companyId,
      {
        fullName: dm.fullName,
        title: dm.title,
        seniority: dm.seniority,
        email: dm.email,
        phone: null,
        linkedinUrl: dm.linkedinUrl,
        isPrimary: false,
        isDecisionMaker: true,
        notes: dm.reasoning ? `Research AI: ${dm.reasoning}` : "Identified by Research AI.",
      },
      actor,
    );
    if (res.ok) added += 1;
  }

  await setStep(
    "decision_makers",
    "done",
    `${decisionMakers.length} identified${added ? `, ${added} new contact${added === 1 ? "" : "s"}` : ""}`,
  );
  await recordTimelineEvent({
    company_id: companyId,
    event_type: "enriched",
    ai_employee_id: employeeId,
    source: "ai_research",
    body: `Decision makers identified: ${decisionMakers.map((d) => d.fullName).join(", ")}.`,
    metadata: { count: decisionMakers.length, added },
  });
  return decisionMakers;
}

function officerToDecisionMaker(o: {
  name: string;
  role: string | null;
  appointedOn: string | null;
}): DecisionMaker {
  const role = (o.role ?? "").toLowerCase();
  const seniority: DecisionMaker["seniority"] = role.includes("director")
    ? "director"
    : role.includes("secretary")
      ? "other"
      : role.includes("member")
        ? "director"
        : "unknown";
  return {
    fullName: reformatOfficerName(o.name),
    title: o.role ? titleCase(o.role) : null,
    seniority,
    email: null,
    linkedinUrl: null,
    confidence: 90,
    reasoning: `Listed at Companies House${o.role ? ` as ${o.role}` : ""}${
      o.appointedOn ? `, appointed ${o.appointedOn}` : ""
    }.`,
  };
}

// ---------------------------------------------------------------------
// Phase: Reasoning — research report + sales prep.
// ---------------------------------------------------------------------

type AiAttr = { generatedBy: "ai"; aiEmployeeId: string | null };

async function writeResearchReport(
  companyId: string,
  company: SalesCompany,
  intelligence: CompanyIntelligence,
  score: number | null,
  factors: ResearchScoreFactor[],
  provenance: ResearchProvenance,
  ai: AiAttr,
  actor: Actor,
): Promise<string | null> {
  const known = factors.filter((f) => f.known);
  const unknownCount = factors.length - known.length;
  const riskLevel =
    score == null ? "unknown" : score >= 60 ? "low" : score >= 40 ? "medium" : "high";

  const summaryLines = [
    intelligence.overview || `Research profile for ${company.name}.`,
    intelligence.constructionSector ? `Sector: ${intelligence.constructionSector}.` : null,
    intelligence.services.length ? `Services: ${intelligence.services.slice(0, 6).join(", ")}.` : null,
  ].filter(Boolean);

  const res = await addResearchReport(
    companyId,
    {
      summary: summaryLines.join(" "),
      painPoints: intelligence.painPoints,
      likelihoodScore: score,
      estimatedSoftwareSpendGbp: intelligence.estimatedSoftwareSpendGbp,
      estimatedSpendNote: intelligence.estimatedSoftwareSpendGbp
        ? "Estimated from observed digital footprint."
        : "",
      bestAngle:
        known
          .slice()
          .sort((a, b) => b.value * b.weight - a.value * a.weight)[0]?.detail ?? "",
      openingLine: "",
      recommendedFollowUp: "",
      riskAssessment:
        unknownCount > 0
          ? `Scored on ${known.length} of ${factors.length} factors; ${unknownCount} remain unknown. Treat as ${riskLevel} confidence.`
          : `Full-coverage score across all ${factors.length} factors.`,
      riskLevel,
      generatedBy: ai.generatedBy,
      model: provenance,
      aiEmployeeId: ai.aiEmployeeId,
    },
    actor,
  );
  return res.ok ? res.id : null;
}

async function reasonSalesPrep(
  company: SalesCompany,
  intelligence: CompanyIntelligence,
  decisionMakers: DecisionMaker[],
  score: number | null,
  factors: ResearchScoreFactor[],
  provenance: ResearchProvenance,
  ai: AiAttr,
  actor: Actor,
  result: ResearchResult,
  setStep: SetStep,
  employeeId: string | null,
): Promise<{ brief: SalesBrief | null; drafts: CommsDrafts | null }> {
  void result;
  if (!researchAiEnabled()) {
    await setStep("brief", "skipped", "AI provider not configured");
    await setStep("drafts", "skipped", "AI provider not configured");
    return { brief: null, drafts: null };
  }

  await setStep("brief", "active", "Preparing the sales brief…");
  const topFactors = factors
    .filter((f) => f.known)
    .sort((a, b) => b.value * b.weight - a.value * a.weight)
    .slice(0, 6)
    .map((f) => ({ label: f.label, detail: f.detail }));

  const promptInput: SalesPromptInput = {
    companyName: company.name,
    intelligence,
    decisionMakers,
    score,
    scoreBandLabel: scoreBandLabel(score),
    topFactors,
  };
  const outcome = await runResearchSalesPrep(promptInput);

  if (!outcome) {
    await setStep("brief", "skipped", "No brief generated");
    await setStep("drafts", "skipped", "No drafts generated");
    return { brief: null, drafts: null };
  }

  const { brief, drafts } = outcome.prep;

  // The brief becomes the company's active AI recommendation; the full brief +
  // draft outreach ride along in follow_up_steps so nothing is lost.
  await addRecommendation(
    company.id,
    {
      whyBuy: brief.valueProposition || brief.bestAngle,
      keyFeatures: brief.recommendedModules,
      likelyObjections: brief.likelyObjections,
      recommendedPricing: "", // Research AI never invents pricing.
      recommendedPlan: null,
      recommendedPriceGbp: null,
      bestSalesperson: null,
      bestTimeToCall: brief.bestTimeToCall ?? "",
      followUpSchedule: "",
      followUpSteps: { brief, drafts, provenance },
      generatedBy: ai.generatedBy,
      model: provenance,
      aiEmployeeId: ai.aiEmployeeId,
    },
    actor,
  );
  await setStep("brief", "done", brief.bestAngle ? truncate(brief.bestAngle, 90) : "Sales brief ready");

  // Drafts — DRAFT ONLY. Log the cold email so it's visible on the timeline.
  const draftCount = [
    drafts.coldEmail,
    drafts.linkedinMessage,
    drafts.followUpEmail,
    drafts.voicemailScript,
    drafts.firstCallOpening,
    drafts.demoConfirmation,
  ].filter((d) => d && d.trim()).length;

  await setStep(
    "drafts",
    draftCount ? "done" : "skipped",
    draftCount ? `${draftCount} draft${draftCount === 1 ? "" : "s"} ready for review` : "No drafts generated",
  );
  if (drafts.coldEmail && drafts.coldEmail.trim()) {
    await recordTimelineEvent({
      company_id: company.id,
      event_type: "email_generated",
      ai_employee_id: employeeId,
      source: "ai_research",
      subject: drafts.coldEmailSubject || `Cold email draft for ${company.name}`,
      body: drafts.coldEmail,
      outcome: "draft",
      metadata: { draftCount, requiresApproval: true },
    });
  }

  return { brief, drafts };
}

// ---------------------------------------------------------------------
// Persistence — enrich the company record (scoped partial update).
// ---------------------------------------------------------------------

async function persistEnrichment(
  admin: AdminClient,
  company: SalesCompany,
  intel: CompanyIntelligence,
  site: SiteContent | null,
  score: number | null,
  ch: CompaniesHouseFacts | null,
  detectedTech: string[],
): Promise<void> {
  const sig = site?.signals ?? null;
  const patch: Record<string, unknown> = {};
  const setIfValue = (col: string, value: unknown) => {
    if (value !== null && value !== undefined && value !== "") patch[col] = value;
  };
  const fillIfEmpty = (col: string, current: unknown, value: unknown) => {
    if ((current === null || current === undefined || current === "") && value) patch[col] = value;
  };

  // Derived signals — always refreshed when present.
  setIfValue("website_quality_score", intel.websiteQualityScore);
  setIfValue("digital_maturity_score", intel.digitalMaturityScore);
  setIfValue("marketing_quality_score", intel.marketingQualityScore);
  setIfValue("hiring_activity_score", intel.hiringActivityScore);
  setIfValue("growth_score", intel.growthScore);
  setIfValue("revenue_estimate_gbp", intel.revenueEstimateGbp);
  setIfValue("estimated_software_spend_gbp", intel.estimatedSoftwareSpendGbp);
  setIfValue("construction_sector", intel.constructionSector);
  setIfValue("fleet_size", intel.fleetSize);
  setIfValue("staff_size", intel.staffSize);
  if (score != null) patch.ai_qualification_score = clampScore(score);

  const tech = [...new Set([...(company.website_technology ?? []), ...detectedTech])];
  if (tech.length) patch.website_technology = tech;
  const software = [...new Set([...(intel.softwareUsed ?? []), ...detectedTech])];
  if (software.length) patch.software_used = software;

  // Identity fields — fill only when the operator hasn't set them.
  fillIfEmpty("summary", company.summary, intel.overview);
  fillIfEmpty("industry", company.industry, intel.industry);
  fillIfEmpty("location", company.location, intel.locations[0] ?? intel.geographicCoverage);
  if (sig) {
    fillIfEmpty("primary_email", company.primary_email, sig.emails[0]);
    fillIfEmpty("primary_phone", company.primary_phone, sig.phones[0]);
    fillIfEmpty("linkedin_url", company.linkedin_url, sig.socials.linkedin);
    fillIfEmpty("instagram_url", company.instagram_url, sig.socials.instagram);
    fillIfEmpty("facebook_url", company.facebook_url, sig.socials.facebook);
  }
  if (ch) {
    fillIfEmpty("companies_house_number", company.companies_house_number, ch.companyNumber);
  }

  // Always stamp the research time — this is the signal the CEO dashboard's
  // Research card counts ("companies researched"), so a run always registers.
  patch.last_researched_at = new Date().toISOString();

  const { error: updErr } = await (
    admin.from("hq_sales_companies" as never) as unknown as {
      update: (p: unknown) => { eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }> };
    }
  )
    .update(patch)
    .eq("id", company.id);
  if (updErr) console.error("[hq-research] persistEnrichment failed", updErr);
}

// ---------------------------------------------------------------------
// Reads + small helpers.
// ---------------------------------------------------------------------

async function loadRelationshipScore(
  admin: AdminClient,
  companyId: string,
): Promise<number | null> {
  const { data } = await (
    admin.from("hq_sales_timeline_events" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          order: (c: string, o: { ascending: boolean }) => {
            limit: (n: number) => PromiseLike<{ data: SalesTimelineEvent[] | null }>;
          };
        };
      };
    }
  )
    .select("event_type, direction, occurred_at")
    .eq("company_id", companyId)
    .order("occurred_at", { ascending: false })
    .limit(200);
  return computeRelationshipScore((data ?? []) as SalesTimelineEvent[]).score;
}

async function loadExistingContactNames(companyId: string): Promise<Set<string>> {
  const admin = createAdminClient();
  const { data } = await (
    admin.from("hq_sales_contacts" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => PromiseLike<{ data: Pick<SalesContact, "full_name">[] | null }>;
      };
    }
  )
    .select("full_name")
    .eq("company_id", companyId);
  const set = new Set<string>();
  for (const row of data ?? []) {
    const n = normaliseName(row.full_name);
    if (n) set.add(n);
  }
  return set;
}

function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
}

/** Companies House lists officers "SURNAME, Forename" — flip to natural order. */
function reformatOfficerName(name: string): string {
  const m = /^([^,]+),\s*(.+)$/.exec(name.trim());
  if (m) return titleCase(`${m[2]} ${m[1]}`);
  return titleCase(name);
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .trim();
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------------------------------------------------------------------
// Live state for the polling UI + the cron drain.
// ---------------------------------------------------------------------

export async function getResearchRunState(
  taskId: string,
): Promise<ResearchRunState | null> {
  const admin = createAdminClient();
  const { data } = await tasks<{
    id: string;
    company_id: string | null;
    status: string;
    result: ResearchResult | null;
    started_at: string | null;
    finished_at: string | null;
    error_message: string | null;
  }>(admin)
    .select("id, company_id, status, result, started_at, finished_at, error_message")
    .eq("id", taskId)
    .maybeSingle();
  if (!data) return null;

  const company = data.company_id ? await getCompany(data.company_id) : null;
  const result = data.result;
  return {
    taskId: data.id,
    companyId: data.company_id,
    companyName: company?.name ?? null,
    status: normaliseTaskStatus(data.status),
    phase: result?.phase ?? phaseFromStatus(data.status),
    steps: result?.steps ?? initialSteps(),
    error: result?.error ?? data.error_message,
    startedAt: result?.startedAt ?? data.started_at,
    finishedAt: result?.finishedAt ?? data.finished_at,
    summary: result?.summary ?? null,
  };
}

/** The most recent research task for a company — lets the company page link
 *  straight to a live or finished run. */
export async function latestResearchTaskId(companyId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await tasks<{ id: string }>(admin)
    .select("id")
    .eq("company_id", companyId)
    .eq("task_type", "research_company")
    .order("created_at", { ascending: false })
    .limit(1);
  return Array.isArray(data) && data[0] ? data[0].id : null;
}

function normaliseTaskStatus(s: string): ResearchRunState["status"] {
  return s === "pending" || s === "running" || s === "completed" || s === "failed" || s === "cancelled"
    ? s
    : "pending";
}

function phaseFromStatus(s: string): ResearchPhase {
  if (s === "completed") return "completed";
  if (s === "failed" || s === "cancelled") return "failed";
  if (s === "running") return "running";
  return "queued";
}

export type DrainResult = {
  ok: boolean;
  found: number;
  processed: number;
  results: Array<{ taskId: string; status: string }>;
};

/**
 * Cron entry point: pick up pending research tasks (and any stuck in 'running'
 * past the dead-worker threshold) and run them. Bounded per invocation so one
 * drain never runs away.
 */
export async function drainResearchTasks(limit = 3): Promise<DrainResult> {
  const admin = createAdminClient();

  const { data: pending } = await tasks<{ id: string }>(admin)
    .select("id")
    .eq("task_type", "research_company")
    .eq("status", "pending")
    .order("priority_rank", { ascending: true })
    .limit(limit);

  const ids = (pending ?? []).map((r) => r.id);

  // Re-queue dead 'running' tasks (worker timed out) that still have retries.
  if (ids.length < limit) {
    const cutoff = new Date(Date.now() - STUCK_RUNNING_MS).toISOString();
    const { data: stuck } = await tasks<{ id: string }>(admin)
      .select("id")
      .eq("task_type", "research_company")
      .eq("status", "running")
      .lt("started_at", cutoff)
      .limit(limit - ids.length);
    for (const row of stuck ?? []) {
      // Flip back to pending so claimTask can re-acquire it.
      await tasks(admin).update({ status: "pending" }).eq("id", row.id);
      ids.push(row.id);
    }
  }

  const results: Array<{ taskId: string; status: string }> = [];
  for (const id of ids) {
    const outcome = await runResearchTask(id);
    results.push({ taskId: id, status: outcome.status });
  }

  return { ok: true, found: ids.length, processed: results.length, results };
}

// ---------------------------------------------------------------------
// Read side — recent runs + live metrics (Phase 10, CEO dashboard).
// Bounded reads only: head-counts for totals, a capped window for the
// aggregates. Honest zeros when nothing has run yet ("Foundation").
// ---------------------------------------------------------------------

export type ResearchRunRow = {
  taskId: string;
  companyId: string | null;
  companyName: string | null;
  status: ResearchRunState["status"];
  phase: ResearchPhase;
  score: number | null;
  scoreBand: string | null;
  decisionMakers: number | null;
  provenance: ResearchProvenance | null;
  createdAt: string | null;
  finishedAt: string | null;
};

type RecentTaskRow = {
  id: string;
  company_id: string | null;
  status: string;
  result: ResearchResult | null;
  created_at: string | null;
  finished_at: string | null;
};

/** Most recent research runs, newest first — the home + CEO feeds. */
export async function listRecentResearchRuns(limit = 12): Promise<ResearchRunRow[]> {
  const admin = createAdminClient();
  const capped = Math.min(Math.max(limit, 1), 50);
  const { data } = await tasks<RecentTaskRow>(admin)
    .select("id, company_id, status, result, created_at, finished_at")
    .eq("task_type", "research_company")
    .order("created_at", { ascending: false })
    .limit(capped);

  const rows = Array.isArray(data) ? data : [];
  const names = await loadCompanyNames(
    admin,
    rows.map((r) => r.company_id).filter((id): id is string => !!id),
  );
  return rows.map((r) => {
    const summary = r.result?.summary ?? null;
    return {
      taskId: r.id,
      companyId: r.company_id,
      companyName: r.company_id ? (names.get(r.company_id) ?? null) : null,
      status: normaliseTaskStatus(r.status),
      phase: r.result?.phase ?? phaseFromStatus(r.status),
      score: summary?.score ?? null,
      scoreBand: summary?.scoreBand ?? null,
      decisionMakers: summary?.decisionMakers ?? null,
      provenance: summary?.generatedBy ?? r.result?.provenance ?? null,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
    };
  });
}

export type ResearchMetrics = {
  total: number;
  completed: number;
  inFlight: number;
  failed: number;
  scored: number;
  avgScore: number | null;
  decisionMakersIdentified: number;
  provenance: { anthropic: number; openai: number; deterministic: number };
  lastCompletedAt: string | null;
  recent: ResearchRunRow[];
};

/** Live Research AI metrics for the section home + CEO dashboard tile. */
export async function getResearchMetrics(): Promise<ResearchMetrics> {
  const admin = createAdminClient();
  const [total, completed, failed, inFlight] = await Promise.all([
    countResearch(admin),
    countResearch(admin, "completed"),
    countResearch(admin, "failed"),
    countResearch(admin, ["pending", "running"]),
  ]);

  // Aggregate the most-recent completed runs' summaries (capped window).
  const { data } = await tasks<{ result: ResearchResult | null; finished_at: string | null }>(admin)
    .select("result, finished_at")
    .eq("task_type", "research_company")
    .eq("status", "completed")
    .order("finished_at", { ascending: false })
    .limit(200);

  let scoreSum = 0;
  let scored = 0;
  let decisionMakers = 0;
  const provenance = { anthropic: 0, openai: 0, deterministic: 0 };
  let lastCompletedAt: string | null = null;
  for (const row of Array.isArray(data) ? data : []) {
    const s = row.result?.summary;
    if (!s) continue;
    if (typeof s.score === "number") {
      scoreSum += s.score;
      scored += 1;
    }
    decisionMakers += s.decisionMakers ?? 0;
    const p = s.generatedBy;
    if (p === "anthropic" || p === "openai" || p === "deterministic") provenance[p] += 1;
    if (!lastCompletedAt && row.finished_at) lastCompletedAt = row.finished_at;
  }

  const recent = await listRecentResearchRuns(8);

  return {
    total,
    completed,
    failed,
    inFlight,
    scored,
    avgScore: scored ? Math.round(scoreSum / scored) : null,
    decisionMakersIdentified: decisionMakers,
    provenance,
    lastCompletedAt,
    recent,
  };
}

type CountQuery = PromiseLike<{ count: number | null; error: { message: string } | null }> & {
  select(columns: string, opts: { count: "exact"; head: true }): CountQuery;
  eq(column: string, value: unknown): CountQuery;
  in(column: string, values: ReadonlyArray<unknown>): CountQuery;
};

async function countResearch(
  admin: AdminClient,
  status?: string | string[],
): Promise<number> {
  let q = (admin.from("hq_sales_ai_tasks" as never) as unknown as CountQuery)
    .select("id", { count: "exact", head: true })
    .eq("task_type", "research_company");
  if (Array.isArray(status)) q = q.in("status", status);
  else if (status) q = q.eq("status", status);
  const { count } = await q;
  return count ?? 0;
}

async function loadCompanyNames(
  admin: AdminClient,
  ids: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const map = new Map<string, string>();
  if (unique.length === 0) return map;
  const { data } = await (
    admin.from("hq_sales_companies" as never) as unknown as {
      select: (c: string) => {
        in: (k: string, v: ReadonlyArray<unknown>) => PromiseLike<{
          data: Array<{ id: string; name: string | null }> | null;
        }>;
      };
    }
  )
    .select("id, name")
    .in("id", unique);
  for (const row of data ?? []) {
    if (row.name) map.set(row.id, row.name);
  }
  return map;
}

// ---------------------------------------------------------------------
// Full report view — the rich, completed intelligence report the live page
// renders once the run finishes (decoded straight from result jsonb).
// ---------------------------------------------------------------------

export type ResearchReportView = {
  taskId: string;
  companyId: string | null;
  companyName: string | null;
  status: ResearchRunState["status"];
  phase: ResearchPhase;
  summary: ResearchRunSummary | null;
  intelligence: CompanyIntelligence | null;
  decisionMakers: DecisionMaker[];
  scoreFactors: ResearchScoreFactor[];
  brief: SalesBrief | null;
  drafts: CommsDrafts | null;
  provenance: ResearchProvenance | null;
  pagesFetched: string[];
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

export async function getResearchReport(taskId: string): Promise<ResearchReportView | null> {
  const admin = createAdminClient();
  const { data } = await tasks<{
    id: string;
    company_id: string | null;
    status: string;
    result: ResearchResult | null;
    started_at: string | null;
    finished_at: string | null;
    error_message: string | null;
  }>(admin)
    .select("id, company_id, status, result, started_at, finished_at, error_message")
    .eq("id", taskId)
    .maybeSingle();
  if (!data) return null;

  const company = data.company_id ? await getCompany(data.company_id) : null;
  const r = data.result;
  return {
    taskId: data.id,
    companyId: data.company_id,
    companyName: company?.name ?? null,
    status: normaliseTaskStatus(data.status),
    phase: r?.phase ?? phaseFromStatus(data.status),
    summary: r?.summary ?? null,
    intelligence: r?.intelligence ?? null,
    decisionMakers: r?.decisionMakers ?? [],
    scoreFactors: r?.scoreFactors ?? [],
    brief: r?.brief ?? null,
    drafts: r?.drafts ?? null,
    provenance: r?.provenance ?? null,
    pagesFetched: r?.pagesFetched ?? [],
    startedAt: r?.startedAt ?? data.started_at,
    finishedAt: r?.finishedAt ?? data.finished_at,
    error: r?.error ?? data.error_message,
  };
}

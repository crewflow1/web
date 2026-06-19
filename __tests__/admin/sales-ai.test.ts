import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  aggregateSalesFacets,
  aiTaskPriorityLabel,
  aiTaskStatusLabel,
  buildFunnel,
  channelCategoryLabel,
  clampScore,
  closeRate,
  deriveDomain,
  emptyStatusCounts,
  emptyTaskStatusCounts,
  employeeBand,
  employeeBandLabel,
  eventCategory,
  formatGbp,
  isOpenTaskStatus,
  isPromotableOutcome,
  likelihoodBandFromScore,
  normalizeList,
  normalizeTags,
  pct,
  pipelineValue,
  priorityRank,
  scoreBand,
  summariseActivity,
  tallyStatuses,
  tallyTaskStatuses,
  winRate,
} from "@/lib/sales/model";

/**
 * Sales AI Platform — authorization-boundary + pure-logic contract tests
 * (CEO Directive 003, Phase 1).
 *
 * The directive's security mandate ("HQ only. Super Admin only. Audit
 * every change. All AI actions traceable.") requires proof that:
 *   1. Unauthenticated callers are blocked and write NOTHING.
 *   2. Authenticated but non-allowlisted customers are blocked and write
 *      NOTHING.
 *   3. An HQ super-admin is allowed AND every mutation lands an
 *      admin_activity_log audit row alongside the domain write.
 *   4. Input validation rejects malformed requests before any write.
 *   5. The pure model layer (funnel maths, facet aggregation, scoring,
 *      formatting) behaves exactly to spec.
 *
 * The nine server actions are the only state-changing entry points, so
 * the boundary is proven there. Supabase admin is mocked (queue-based
 * chainable stub); redirect is stubbed to throw, mirroring Next.js where
 * redirect() halts the action.
 */

// ---------- Supabase admin mock --------------------------------------

type QueueEntry = { data: unknown; error: unknown };

function makeMockSupabase() {
  const insertQ: QueueEntry[] = [];
  const updateQ: QueueEntry[] = [];
  const deleteQ: QueueEntry[] = [];
  const maybeSingleQ: QueueEntry[] = [];
  const inserts: Array<{ table: string; payload: unknown }> = [];
  const updates: Array<{
    table: string;
    payload: unknown;
    where: Record<string, unknown>;
  }> = [];
  const deletes: Array<{ table: string; where: Record<string, unknown> }> = [];

  // Read-builder methods the service chains; all simply return the chain.
  const passthrough = new Set([
    "select",
    "eq",
    "neq",
    "in",
    "is",
    "not",
    "or",
    "contains",
    "textSearch",
    "gte",
    "lte",
    "lt",
    "order",
    "range",
    "limit",
    "match",
  ]);

  function thenable(settled: QueueEntry): Record<string, unknown> {
    const inner: Record<string, unknown> = {};
    Object.defineProperty(inner, "then", {
      value: (resolve: (v: QueueEntry) => unknown) => resolve(settled),
    });
    return inner;
  }

  function makeChain(table: string): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    for (const m of passthrough) chain[m] = () => chain;

    // A select(...).eq(...).maybeSingle() read pulls from the read queue
    // (getCompany / promote's report read).
    chain.maybeSingle = async () =>
      maybeSingleQ.shift() ?? { data: null, error: null };

    // insert(...) records the write and returns a thenable that also
    // supports .select(...).single()/.maybeSingle() — every domain insert
    // does `.insert(payload).select("id").maybeSingle()`, while
    // recordAdminActivity simply `await`s the insert directly.
    chain.insert = (payload: unknown) => {
      inserts.push({ table, payload });
      const settled = insertQ.shift() ?? { data: { id: "default-id" }, error: null };
      const ic: Record<string, unknown> = {
        select: () => ic,
        single: async () => settled,
        maybeSingle: async () => settled,
      };
      Object.defineProperty(ic, "then", {
        value: (resolve: (v: QueueEntry) => unknown) => resolve(settled),
      });
      return ic;
    };

    // update(payload).eq(col,val)[.eq(col,val)] — records the mutation and
    // accumulates the where clause across however many .eq() calls chain
    // (addRecommendation supersedes with two equality filters).
    chain.update = (payload: unknown) => {
      const rec = { table, payload, where: {} as Record<string, unknown> };
      updates.push(rec);
      const settled = updateQ.shift() ?? { data: null, error: null };
      const u: Record<string, unknown> = {
        eq: (col: string, val: unknown) => {
          rec.where[col] = val;
          return u;
        },
      };
      Object.defineProperty(u, "then", {
        value: (resolve: (v: QueueEntry) => unknown) => resolve(settled),
      });
      return u;
    };

    // delete().eq(col,val) — deleteContact removes a single row by id.
    chain.delete = () => ({
      eq: (col: string, val: unknown) => {
        deletes.push({ table, where: { [col]: val } });
        return thenable(deleteQ.shift() ?? { data: null, error: null });
      },
    });

    return chain;
  }

  return {
    client: { from: (table: string) => makeChain(table) },
    inserts,
    updates,
    deletes,
    enqueueMaybeSingle: (e: QueueEntry) => maybeSingleQ.push(e),
    enqueueInsert: (e: QueueEntry) => insertQ.push(e),
    enqueueUpdate: (e: QueueEntry) => updateQ.push(e),
    reset() {
      insertQ.length = 0;
      updateQ.length = 0;
      deleteQ.length = 0;
      maybeSingleQ.length = 0;
      inserts.length = 0;
      updates.length = 0;
      deletes.length = 0;
    },
  };
}

const mockAdmin = makeMockSupabase();

// ---------- Module mocks ---------------------------------------------

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockAdmin.client,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const redirectMock = vi.fn((path: string) => {
  // Mirror Next.js's real redirect by throwing — actions stop executing.
  throw new Error(`REDIRECT:${path}`);
});
vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

const requireUserMock = vi.fn();
vi.mock("@/server/auth/session", () => ({
  requireUser: requireUserMock,
}));

const isSuperAdminEmailMock = vi.fn();
vi.mock("@/server/auth/superadmin", () => ({
  isSuperAdminEmail: isSuperAdminEmailMock,
}));

// Late import so all module-level mocks are applied first.
type SalesActions = typeof import("@/app/admin/sales/actions");
async function loadActions(): Promise<SalesActions> {
  return await import("@/app/admin/sales/actions");
}

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

// Valid v4 UUIDs (pass both the lenient UUID_RE and zod's .uuid()).
const CID = "11111111-1111-4111-8111-111111111111";
const RID = "22222222-2222-4222-8222-222222222222";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";
const CHANNEL_ID = "44444444-4444-4444-8444-444444444444";
const EVENT_ID = "55555555-5555-4555-8555-555555555555";

function companyForm(): FormData {
  return makeFormData({
    name: "Northwind Trading Ltd",
    summary: "A mid-market wholesaler in the North West.",
    status: "qualified",
    source: "manual",
    website: "https://www.northwind.co.uk",
    industry: "Wholesale",
    county: "Greater Manchester",
    employee_count: "75",
    estimated_deal_value_gbp: "12,000",
    tags: "wholesale, north-west",
  });
}
function updateForm(): FormData {
  const fd = companyForm();
  fd.set("id", CID);
  fd.set("name", "Northwind Trading Ltd (revised)");
  return fd;
}
function statusForm(status = "qualified"): FormData {
  return makeFormData({ id: CID, status });
}
function contactForm(): FormData {
  return makeFormData({
    company_id: CID,
    full_name: "Jane Doe",
    title: "CFO",
    seniority: "c_level",
    email: "jane@northwind.co.uk",
    is_decision_maker: "on",
  });
}
function deleteContactForm(): FormData {
  return makeFormData({ id: CONTACT_ID, company_id: CID });
}
function researchForm(): FormData {
  return makeFormData({
    company_id: CID,
    generated_by: "human",
    risk_level: "low",
    summary: "Strong fit; outgrowing spreadsheets.",
    pain_points: "Manual scheduling\nNo mobile app",
    likelihood_score: "82",
  });
}
function recoForm(): FormData {
  return makeFormData({
    company_id: CID,
    generated_by: "human",
    why_buy: "Replace 3 tools with one platform.",
    key_features: "Scheduling, Invoicing",
  });
}
function interactionForm(): FormData {
  return makeFormData({
    company_id: CID,
    event_type: "call",
    direction: "outbound",
    subject: "Intro call",
    body: "Spoke to the CFO about scheduling pain.",
    outcome: "positive",
  });
}
function promoteForm(): FormData {
  return makeFormData({ report_id: RID, company_id: CID });
}
function locationForm(): FormData {
  return makeFormData({
    company_id: CID,
    generated_by: "human",
    label: "North depot",
    address_line1: "12 Trade Park",
    city: "Manchester",
    postcode: "M1 2AB",
  });
}
function channelForm(): FormData {
  return makeFormData({
    company_id: CID,
    channel_type: "work_email",
    value: "ops@northwind.co.uk",
    generated_by: "human",
    status: "active",
  });
}
function deleteChannelForm(): FormData {
  return makeFormData({ id: CHANNEL_ID, company_id: CID });
}
function taskForm(): FormData {
  return makeFormData({
    company_id: CID,
    task_type: "company_research",
    priority: "high",
  });
}
function globalTaskForm(): FormData {
  return makeFormData({ task_type: "lead_discovery", priority: "normal" });
}
function promoteOutcomeForm(): FormData {
  return makeFormData({ event_id: EVENT_ID, company_id: CID });
}

/** Every mutating action paired with a valid form, for boundary sweeps. */
const ALL_ACTIONS: Array<[keyof SalesActions, FormData]> = [
  ["createCompanyAction", companyForm()],
  ["updateCompanyAction", updateForm()],
  ["setCompanyStatusAction", statusForm()],
  ["addContactAction", contactForm()],
  ["deleteContactAction", deleteContactForm()],
  ["addResearchAction", researchForm()],
  ["addRecommendationAction", recoForm()],
  ["logInteractionAction", interactionForm()],
  ["promoteResearchAction", promoteForm()],
  ["addLocationAction", locationForm()],
  ["addChannelAction", channelForm()],
  ["deleteChannelAction", deleteChannelForm()],
  ["enqueueAiTaskAction", taskForm()],
  ["promoteOutcomeAction", promoteOutcomeForm()],
];

function callAction(mod: SalesActions, name: keyof SalesActions, fd: FormData) {
  const fn = mod[name] as (formData: FormData) => Promise<void>;
  return fn(fd);
}

function expectNoWrites() {
  expect(mockAdmin.inserts).toHaveLength(0);
  expect(mockAdmin.updates).toHaveLength(0);
  expect(mockAdmin.deletes).toHaveLength(0);
}

function findInsert(table: string) {
  return mockAdmin.inserts.find((i) => i.table === table)?.payload as
    | Record<string, unknown>
    | undefined;
}
function findAudit() {
  return mockAdmin.inserts.find((i) => i.table === "admin_activity_log")
    ?.payload as Record<string, unknown> | undefined;
}

beforeEach(() => {
  mockAdmin.reset();
  redirectMock.mockClear();
  requireUserMock.mockReset();
  isSuperAdminEmailMock.mockReset();
});

// ---------- 1. Unauthenticated ---------------------------------------

describe("authorization — unauthenticated callers are blocked", () => {
  beforeEach(() => {
    // Real requireUser() redirects to /login with no session — it throws
    // and halts the action before requireHq even checks the allowlist.
    requireUserMock.mockImplementation(() => {
      throw new Error("REDIRECT:/login");
    });
    isSuperAdminEmailMock.mockReturnValue(false);
  });

  for (const [name, fd] of ALL_ACTIONS) {
    it(`${name} bounces to /login and writes nothing`, async () => {
      const mod = await loadActions();
      await expect(callAction(mod, name, fd)).rejects.toThrow(
        /REDIRECT:\/login/,
      );
      expectNoWrites();
    });
  }
});

// ---------- 2. Authenticated non-allowlisted customer ----------------

describe("authorization — non-allowlisted customers are blocked", () => {
  beforeEach(() => {
    requireUserMock.mockResolvedValue({
      id: "cust-1",
      email: "owner@some-tenant.test",
    });
    isSuperAdminEmailMock.mockReturnValue(false);
  });

  for (const [name, fd] of ALL_ACTIONS) {
    it(`${name} redirects to /dashboard and writes nothing`, async () => {
      const mod = await loadActions();
      await expect(callAction(mod, name, fd)).rejects.toThrow(
        /REDIRECT:\/dashboard/,
      );
      expect(isSuperAdminEmailMock).toHaveBeenCalledWith("owner@some-tenant.test");
      expectNoWrites();
    });
  }
});

// ---------- 3. HQ super-admin (allowed + audited) --------------------

describe("authorization — HQ super-admin is allowed and every write is audited", () => {
  beforeEach(() => {
    requireUserMock.mockResolvedValue({ id: "admin-1", email: "ceo@crewflow.uk" });
    isSuperAdminEmailMock.mockReturnValue(true);
  });

  it("createCompanyAction inserts the company and audits company_created", async () => {
    mockAdmin.enqueueInsert({ data: { id: "company1" }, error: null });
    const mod = await loadActions();
    await expect(callAction(mod, "createCompanyAction", companyForm())).rejects.toThrow(
      /REDIRECT:\/admin\/sales\/companies\/company1\?saved=created/,
    );

    const row = findInsert("hq_sales_companies");
    expect(row?.name).toBe("Northwind Trading Ltd");
    expect(row?.status).toBe("qualified");
    expect(row?.source).toBe("manual");
    expect(row?.created_by_id).toBe("admin-1");
    expect(row?.created_by_email).toBe("ceo@crewflow.uk");
    // domain is derived from the website on write.
    expect(row?.domain).toBe("northwind.co.uk");
    expect(row?.tags).toEqual(["wholesale", "north-west"]);

    // Per-company timeline 'created' event (the company's own audit trail).
    const evt = findInsert("hq_sales_timeline_events");
    expect((evt as { event_type?: string })?.event_type).toBe("created");

    const audit = findAudit();
    expect(audit?.action).toBe("hq_sales.company_created");
    expect(audit?.actor_email).toBe("ceo@crewflow.uk");
    expect(audit?.target_table).toBe("hq_sales_companies");
    expect(audit?.target_id).toBe("company1");
  });

  it("updateCompanyAction updates in place and audits company_updated", async () => {
    // getCompany(id) returns the current row (status differs → status event).
    mockAdmin.enqueueMaybeSingle({ data: { id: CID, status: "new" }, error: null });
    const mod = await loadActions();
    await expect(callAction(mod, "updateCompanyAction", updateForm())).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/sales/companies/${CID}\\?saved=updated`),
    );

    const upd = mockAdmin.updates.find((u) => u.table === "hq_sales_companies");
    expect(upd).toBeTruthy();
    expect(upd?.where).toEqual({ id: CID });
    expect((upd?.payload as { name?: string }).name).toBe(
      "Northwind Trading Ltd (revised)",
    );

    const audit = findAudit();
    expect(audit?.action).toBe("hq_sales.company_updated");
    expect(audit?.target_id).toBe(CID);
  });

  it("setCompanyStatusAction updates status and audits status_changed", async () => {
    mockAdmin.enqueueMaybeSingle({ data: { id: CID, status: "new" }, error: null });
    const mod = await loadActions();
    await expect(
      callAction(mod, "setCompanyStatusAction", statusForm("qualified")),
    ).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/sales/companies/${CID}\\?saved=status`),
    );

    const upd = mockAdmin.updates.find((u) => u.table === "hq_sales_companies");
    expect((upd?.payload as { status?: string }).status).toBe("qualified");

    const evt = findInsert("hq_sales_timeline_events");
    expect((evt as { event_type?: string })?.event_type).toBe("status_change");

    const audit = findAudit();
    expect(audit?.action).toBe("hq_sales.status_changed");
    expect((audit?.metadata as { status?: string }).status).toBe("qualified");
  });

  it("addContactAction inserts the contact and audits contact_added", async () => {
    mockAdmin.enqueueInsert({ data: { id: "contact1" }, error: null });
    const mod = await loadActions();
    await expect(callAction(mod, "addContactAction", contactForm())).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/sales/companies/${CID}\\?saved=contact`),
    );

    const row = findInsert("hq_sales_contacts");
    expect(row?.full_name).toBe("Jane Doe");
    expect(row?.seniority).toBe("c_level");
    expect(row?.is_decision_maker).toBe(true);
    expect(row?.company_id).toBe(CID);

    const audit = findAudit();
    expect(audit?.action).toBe("hq_sales.contact_added");
    expect(audit?.target_id).toBe("contact1");
  });

  it("deleteContactAction deletes the row and audits contact_deleted", async () => {
    const mod = await loadActions();
    await expect(
      callAction(mod, "deleteContactAction", deleteContactForm()),
    ).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/sales/companies/${CID}\\?saved=contact_removed`),
    );

    const del = mockAdmin.deletes.find((d) => d.table === "hq_sales_contacts");
    expect(del?.where).toEqual({ id: CONTACT_ID });

    const audit = findAudit();
    expect(audit?.action).toBe("hq_sales.contact_deleted");
    expect(audit?.target_id).toBe(CONTACT_ID);
  });

  it("addResearchAction inserts a permanent report and audits research_added", async () => {
    mockAdmin.enqueueInsert({ data: { id: "research1" }, error: null });
    const mod = await loadActions();
    await expect(callAction(mod, "addResearchAction", researchForm())).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/sales/companies/${CID}\\?saved=research`),
    );

    const row = findInsert("hq_sales_research_reports");
    expect(row?.company_id).toBe(CID);
    expect(row?.generated_by).toBe("human");
    expect(row?.status).toBe("final");
    // 82 → very_high band derived on write.
    expect(row?.likelihood_band).toBe("very_high");
    expect(row?.pain_points).toEqual(["Manual scheduling", "No mobile app"]);

    // last_researched_at is stamped on the company.
    const upd = mockAdmin.updates.find((u) => u.table === "hq_sales_companies");
    expect(upd?.payload).toHaveProperty("last_researched_at");

    const audit = findAudit();
    expect(audit?.action).toBe("hq_sales.research_added");
    expect(audit?.target_id).toBe("research1");
  });

  it("addResearchAction with generated_by=human ignores AI attribution fields", async () => {
    mockAdmin.enqueueInsert({ data: { id: "research2" }, error: null });
    const fd = researchForm();
    fd.set("model", "gpt-some");
    fd.set("ai_employee_id", "44444444-4444-4444-4444-444444444444");
    const mod = await loadActions();
    await expect(callAction(mod, "addResearchAction", fd)).rejects.toThrow(
      /saved=research/,
    );
    const row = findInsert("hq_sales_research_reports");
    // A human-authored report must not carry a model / ai_employee_id.
    expect(row?.model).toBeNull();
    expect(row?.ai_employee_id).toBeNull();
  });

  it("addRecommendationAction supersedes the active reco, inserts, and audits", async () => {
    mockAdmin.enqueueInsert({ data: { id: "reco1" }, error: null });
    const mod = await loadActions();
    await expect(
      callAction(mod, "addRecommendationAction", recoForm()),
    ).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/sales/companies/${CID}\\?saved=recommendation`),
    );

    // Any previously-active recommendation is superseded first.
    const supersede = mockAdmin.updates.find(
      (u) => u.table === "hq_sales_recommendations",
    );
    expect((supersede?.payload as { status?: string }).status).toBe("superseded");
    expect(supersede?.where).toEqual({ company_id: CID, status: "active" });

    const row = findInsert("hq_sales_recommendations");
    expect(row?.status).toBe("active");
    expect(row?.why_buy).toBe("Replace 3 tools with one platform.");

    const audit = findAudit();
    expect(audit?.action).toBe("hq_sales.recommendation_added");
    expect(audit?.target_id).toBe("reco1");
  });

  it("logInteractionAction records a timeline event and audits interaction_logged", async () => {
    mockAdmin.enqueueInsert({ data: { id: "evt1" }, error: null });
    const mod = await loadActions();
    await expect(
      callAction(mod, "logInteractionAction", interactionForm()),
    ).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/sales/companies/${CID}\\?saved=logged`),
    );

    const row = findInsert("hq_sales_timeline_events");
    expect(row?.event_type).toBe("call");
    expect(row?.direction).toBe("outbound");
    expect(row?.company_id).toBe(CID);
    expect(row?.actor_email).toBe("ceo@crewflow.uk");

    const audit = findAudit();
    expect(audit?.action).toBe("hq_sales.interaction_logged");
    expect((audit?.metadata as { event_type?: string }).event_type).toBe("call");
  });

  it("addLocationAction inserts a location and audits location_added", async () => {
    mockAdmin.enqueueInsert({ data: { id: "location1" }, error: null });
    const mod = await loadActions();
    await expect(callAction(mod, "addLocationAction", locationForm())).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/sales/companies/${CID}\\?saved=location`),
    );

    const row = findInsert("hq_sales_locations");
    expect(row?.company_id).toBe(CID);
    expect(row?.label).toBe("North depot");
    expect(row?.city).toBe("Manchester");
    expect(row?.postcode).toBe("M1 2AB");
    // Country defaults to the UK when blank.
    expect(row?.country).toBe("United Kingdom");
    expect(row?.generated_by).toBe("human");

    const audit = findAudit();
    expect(audit?.action).toBe("hq_sales.location_added");
    expect(audit?.target_table).toBe("hq_sales_locations");
    expect(audit?.target_id).toBe("location1");
  });

  it("addChannelAction inserts a channel and audits channel_added", async () => {
    mockAdmin.enqueueInsert({ data: { id: "channel1" }, error: null });
    const mod = await loadActions();
    await expect(callAction(mod, "addChannelAction", channelForm())).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/sales/companies/${CID}\\?saved=channel`),
    );

    const row = findInsert("hq_sales_channels");
    expect(row?.company_id).toBe(CID);
    expect(row?.channel_type).toBe("work_email");
    expect(row?.value).toBe("ops@northwind.co.uk");
    expect(row?.status).toBe("active");
    expect(row?.generated_by).toBe("human");

    const audit = findAudit();
    expect(audit?.action).toBe("hq_sales.channel_added");
    expect(audit?.target_id).toBe("channel1");
    expect((audit?.metadata as { channel_type?: string }).channel_type).toBe(
      "work_email",
    );
  });

  it("deleteChannelAction deletes the channel and audits channel_deleted", async () => {
    const mod = await loadActions();
    await expect(
      callAction(mod, "deleteChannelAction", deleteChannelForm()),
    ).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/sales/companies/${CID}\\?saved=channel_removed`),
    );

    const del = mockAdmin.deletes.find((d) => d.table === "hq_sales_channels");
    expect(del?.where).toEqual({ id: CHANNEL_ID });

    const audit = findAudit();
    expect(audit?.action).toBe("hq_sales.channel_deleted");
    expect(audit?.target_id).toBe(CHANNEL_ID);
  });

  it("enqueueAiTaskAction (company-scoped) queues a pending task and audits task_enqueued", async () => {
    mockAdmin.enqueueInsert({ data: { id: "task1" }, error: null });
    const mod = await loadActions();
    await expect(callAction(mod, "enqueueAiTaskAction", taskForm())).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/sales/companies/${CID}\\?saved=task`),
    );

    const row = findInsert("hq_sales_ai_tasks");
    expect(row?.company_id).toBe(CID);
    expect(row?.task_type).toBe("company_research");
    expect(row?.priority).toBe("high");
    // The foundation row is durable + queue-ordered; no worker runs yet.
    expect(row?.status).toBe("pending");
    expect(row?.source).toBe("manual");
    expect(row?.retry_count).toBe(0);
    expect(row?.max_retries).toBe(3);

    // A company-scoped task leaves a timeline marker (the AI footprint).
    const evt = findInsert("hq_sales_timeline_events");
    expect((evt as { event_type?: string })?.event_type).toBe("task_scheduled");

    const audit = findAudit();
    expect(audit?.action).toBe("hq_sales.task_enqueued");
    expect(audit?.target_id).toBe("task1");
  });

  it("enqueueAiTaskAction (global) queues a database-wide task with no timeline event", async () => {
    mockAdmin.enqueueInsert({ data: { id: "task2" }, error: null });
    const mod = await loadActions();
    await expect(
      callAction(mod, "enqueueAiTaskAction", globalTaskForm()),
    ).rejects.toThrow(/REDIRECT:\/admin\/sales\/tasks\?saved=task/);

    const row = findInsert("hq_sales_ai_tasks");
    expect(row?.company_id).toBeNull();
    expect(row?.task_type).toBe("lead_discovery");
    expect(row?.priority).toBe("normal");

    // No company → no per-company timeline marker.
    expect(findInsert("hq_sales_timeline_events")).toBeUndefined();

    const audit = findAudit();
    expect(audit?.action).toBe("hq_sales.task_enqueued");
    expect(audit?.target_id).toBe("task2");
  });

  it("promoteOutcomeAction is idempotent for an already-promoted event and audits outcome_promoted", async () => {
    // The timeline event already carries a memory_id, so the service returns
    // it without creating a second memory (idempotent). The action still
    // records the audit and redirects to the company.
    mockAdmin.enqueueMaybeSingle({
      data: {
        id: EVENT_ID,
        event_type: "objection_handled",
        memory_id: "mem-existing",
        company_id: CID,
      },
      error: null,
    });
    const mod = await loadActions();
    await expect(
      callAction(mod, "promoteOutcomeAction", promoteOutcomeForm()),
    ).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/sales/companies/${CID}\\?saved=promoted`),
    );

    const audit = findAudit();
    expect(audit?.action).toBe("hq_sales.outcome_promoted");
    expect(audit?.target_table).toBe("hq_sales_timeline_events");
    expect(audit?.target_id).toBe(EVENT_ID);
    expect((audit?.metadata as { memory_id?: string }).memory_id).toBe(
      "mem-existing",
    );
  });

  it("promoteOutcomeAction refuses a non-promotable event and writes nothing", async () => {
    // A plain note is not a winning outcome — the service rejects it and the
    // action fails out before any write lands.
    mockAdmin.enqueueMaybeSingle({
      data: { id: EVENT_ID, event_type: "note", memory_id: null, company_id: CID },
      error: null,
    });
    const mod = await loadActions();
    await expect(
      callAction(mod, "promoteOutcomeAction", promoteOutcomeForm()),
    ).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/sales/companies/${CID}\\?error=`),
    );
    expectNoWrites();
  });
});

// ---------- 4. Input validation (rejects before any write) -----------

describe("validation — malformed input is rejected before any write", () => {
  beforeEach(() => {
    requireUserMock.mockResolvedValue({ id: "admin-1", email: "ceo@crewflow.uk" });
    isSuperAdminEmailMock.mockReturnValue(true);
  });

  it("createCompanyAction rejects an empty name", async () => {
    const fd = companyForm();
    fd.set("name", "");
    const mod = await loadActions();
    await expect(callAction(mod, "createCompanyAction", fd)).rejects.toThrow(
      /REDIRECT:\/admin\/sales\/companies\/new\?error=/,
    );
    expectNoWrites();
  });

  it("createCompanyAction rejects an invalid status enum", async () => {
    const fd = companyForm();
    fd.set("status", "h4x0r");
    const mod = await loadActions();
    await expect(callAction(mod, "createCompanyAction", fd)).rejects.toThrow(
      /REDIRECT:\/admin\/sales\/companies\/new\?error=/,
    );
    expectNoWrites();
  });

  it("updateCompanyAction rejects a non-UUID id", async () => {
    const fd = updateForm();
    fd.set("id", "not-a-uuid");
    const mod = await loadActions();
    await expect(callAction(mod, "updateCompanyAction", fd)).rejects.toThrow(
      /REDIRECT:\/admin\/sales\/companies\?error=/,
    );
    expectNoWrites();
  });

  it("setCompanyStatusAction rejects an unknown status", async () => {
    const mod = await loadActions();
    await expect(
      callAction(mod, "setCompanyStatusAction", statusForm("bogus")),
    ).rejects.toThrow(/REDIRECT:\/admin\/sales\/companies\?error=/);
    expectNoWrites();
  });

  it("addContactAction rejects a missing contact name", async () => {
    const fd = contactForm();
    fd.set("full_name", "");
    const mod = await loadActions();
    await expect(callAction(mod, "addContactAction", fd)).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/sales/companies/${CID}\\?error=`),
    );
    expectNoWrites();
  });

  it("logInteractionAction rejects an event type outside the interaction set", async () => {
    const fd = interactionForm();
    fd.set("event_type", "created"); // a lifecycle type, not loggable
    const mod = await loadActions();
    await expect(callAction(mod, "logInteractionAction", fd)).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/sales/companies/${CID}\\?error=`),
    );
    expectNoWrites();
  });

  it("addLocationAction rejects a location with no locating fields", async () => {
    // company_id + generated_by parse fine, but an empty row is refused.
    const fd = makeFormData({ company_id: CID, generated_by: "human" });
    const mod = await loadActions();
    await expect(callAction(mod, "addLocationAction", fd)).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/sales/companies/${CID}\\?error=`),
    );
    expectNoWrites();
  });

  it("addChannelAction rejects an empty channel value", async () => {
    const fd = channelForm();
    fd.set("value", "");
    const mod = await loadActions();
    await expect(callAction(mod, "addChannelAction", fd)).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/sales/companies/${CID}\\?error=`),
    );
    expectNoWrites();
  });

  it("enqueueAiTaskAction rejects an out-of-range priority", async () => {
    const fd = taskForm();
    fd.set("priority", "supercritical");
    const mod = await loadActions();
    await expect(callAction(mod, "enqueueAiTaskAction", fd)).rejects.toThrow(
      new RegExp(`REDIRECT:/admin/sales/companies/${CID}\\?error=`),
    );
    expectNoWrites();
  });

  it("promoteOutcomeAction rejects a non-UUID event id", async () => {
    const fd = promoteOutcomeForm();
    fd.set("event_id", "not-a-uuid");
    const mod = await loadActions();
    await expect(callAction(mod, "promoteOutcomeAction", fd)).rejects.toThrow(
      /REDIRECT:\/admin\/sales\/companies\?error=/,
    );
    expectNoWrites();
  });
});

// ---------- 5. Pure model logic --------------------------------------

describe("model — status tallies + funnel maths", () => {
  const counts = {
    new: 5,
    qualified: 4,
    outreach_ready: 3,
    contacted: 2,
    replied: 1,
    demo_booked: 1,
    won: 2,
    lost: 3,
    disqualified: 1,
  };

  it("tallyStatuses counts only known statuses and ignores junk", () => {
    const t = tallyStatuses([
      { status: "new" },
      { status: "new" },
      { status: "won" },
      { status: "not-a-status" },
    ]);
    expect(t.new).toBe(2);
    expect(t.won).toBe(1);
    expect(t.qualified).toBe(0);
    // emptyStatusCounts is the zeroed baseline.
    expect(emptyStatusCounts().won).toBe(0);
  });

  it("buildFunnel reaches cumulatively and reports stage conversion", () => {
    const f = buildFunnel(counts);
    expect(f[0]).toMatchObject({
      stage: "new",
      reached: 18,
      conversionFromPrev: null,
    });
    // qualified+ = 4+3+2+1+1+2 = 13.
    expect(f[1]?.reached).toBe(13);
    // won is the terminal stage (only the 2 currently-won).
    expect(f[6]).toMatchObject({ stage: "won", reached: 2 });
    expect(f[6]?.conversionFromPrev).toBe(pct(2, 3));
  });

  it("winRate is won ÷ all; closeRate is won ÷ decided", () => {
    expect(winRate(counts)).toBe(9.1); // 2 / 22
    expect(closeRate(counts)).toBe(33.3); // 2 / (2+3+1)
  });

  it("pct returns one-decimal percentages and guards divide-by-zero", () => {
    expect(pct(3, 12)).toBe(25);
    expect(pct(1, 3)).toBe(33.3);
    expect(pct(5, 0)).toBe(0);
  });
});

describe("model — facet aggregation", () => {
  const rows = [
    { status: "new", industry: "Retail", county: "Kent", region: "South East", source: "manual", assigned_to_email: "rep@crewflow.uk", employee_count: 5, estimated_deal_value_gbp: 1000 },
    { status: "new", industry: "Retail", county: "Kent", region: "South East", source: "research", assigned_to_email: "rep@crewflow.uk", employee_count: 120, estimated_deal_value_gbp: 4000 },
    { status: "won", industry: "Trades", county: "Essex", region: "East", source: "manual", assigned_to_email: null, employee_count: 2000, estimated_deal_value_gbp: 9000 },
  ];

  it("aggregateSalesFacets tallies + ranks every required facet", () => {
    const f = aggregateSalesFacets(rows, { manual: "Manual", research: "AI research" });
    expect(f.byStatus.find((x) => x.key === "new")?.count).toBe(2);
    expect(f.byIndustry[0]).toMatchObject({ key: "Retail", count: 2 });
    expect(f.bySource.find((x) => x.key === "manual")?.label).toBe("Manual");
    expect(f.bySalesperson[0]).toMatchObject({ key: "rep@crewflow.uk", count: 2 });
    // size bands: 5→micro, 120→medium, 2000→enterprise.
    expect(f.bySize.find((x) => x.key === "micro")?.count).toBe(1);
    expect(f.bySize.find((x) => x.key === "enterprise")?.count).toBe(1);
  });

  it("pipelineValue sums OPEN deals only (won is excluded)", () => {
    // open: 1000 + 4000; won 9000 excluded.
    expect(pipelineValue(rows)).toBe(5000);
  });
});

describe("model — activity summary", () => {
  it("counts weekly/monthly windows and zero-fills a 14-day series", () => {
    const now = new Date("2026-06-17T12:00:00.000Z").getTime();
    const iso = (daysAgo: number) =>
      new Date(now - daysAgo * 86_400_000).toISOString();
    const a = summariseActivity(
      [
        { occurred_at: iso(0) },
        { occurred_at: iso(3) },
        { occurred_at: iso(20) }, // within 30 but outside 7
        { occurred_at: iso(40) }, // outside both windows
      ],
      now,
    );
    expect(a.weekly).toBe(2);
    expect(a.monthly).toBe(3);
    expect(a.series).toHaveLength(14);
    expect(a.series[13]?.count).toBe(1); // today
  });
});

describe("model — scoring + banding", () => {
  it("scoreBand maps 0–100 to hot/warm/cool/cold/unscored at boundaries", () => {
    expect(scoreBand(80)).toBe("hot");
    expect(scoreBand(60)).toBe("warm");
    expect(scoreBand(40)).toBe("cool");
    expect(scoreBand(39)).toBe("cold");
    expect(scoreBand(null)).toBe("unscored");
  });

  it("likelihoodBandFromScore maps a fit score to a likelihood band", () => {
    expect(likelihoodBandFromScore(80)).toBe("very_high");
    expect(likelihoodBandFromScore(60)).toBe("high");
    expect(likelihoodBandFromScore(40)).toBe("medium");
    expect(likelihoodBandFromScore(39)).toBe("low");
    expect(likelihoodBandFromScore(null)).toBe("unknown");
  });

  it("clampScore clamps to 0–100, rounds, and nulls junk", () => {
    expect(clampScore("150")).toBe(100);
    expect(clampScore("-5")).toBe(0);
    expect(clampScore("72.6")).toBe(73);
    expect(clampScore("")).toBeNull();
    expect(clampScore("abc")).toBeNull();
    expect(clampScore(null)).toBeNull();
  });

  it("employeeBand buckets staff counts and labels them", () => {
    expect(employeeBand(5)?.key).toBe("micro");
    expect(employeeBand(120)?.key).toBe("medium");
    expect(employeeBand(2000)?.key).toBe("enterprise");
    expect(employeeBand(0)).toBeNull();
    expect(employeeBandLabel(120)).toBe("51–200");
    expect(employeeBandLabel(null)).toBe("—");
  });
});

describe("model — formatting + parsing helpers", () => {
  it("formatGbp renders compact currency", () => {
    expect(formatGbp(1_200_000)).toBe("£1.2M");
    expect(formatGbp(1_000_000)).toBe("£1M");
    expect(formatGbp(450_000)).toBe("£450k");
    expect(formatGbp(900)).toBe("£900");
    expect(formatGbp(null)).toBe("—");
  });

  it("deriveDomain extracts a registrable host or null", () => {
    expect(deriveDomain("https://www.Example.com/path?x=1")).toBe("example.com");
    expect(deriveDomain("ftp://foo.co.uk:21/x")).toBe("foo.co.uk");
    expect(deriveDomain("not a url")).toBeNull();
    expect(deriveDomain(null)).toBeNull();
  });

  it("normalizeTags lowercases, dashes whitespace, and de-dupes", () => {
    expect(normalizeTags("Wholesale, North  West, wholesale")).toEqual([
      "wholesale",
      "north-west",
    ]);
    expect(normalizeTags("")).toEqual([]);
  });

  it("normalizeList splits on newlines/commas, strips bullets, de-dupes", () => {
    expect(normalizeList("- Alpha\n- Beta, alpha")).toEqual(["Alpha", "Beta"]);
    expect(normalizeList(null)).toEqual([]);
  });

  it("eventCategory separates interactions, lifecycle markers, and AI actions", () => {
    expect(eventCategory("email")).toBe("interaction");
    expect(eventCategory("call")).toBe("interaction");
    expect(eventCategory("created")).toBe("lifecycle");
    expect(eventCategory("research")).toBe("lifecycle");
    expect(eventCategory("status_change")).toBe("lifecycle");
    // AI-action types carry the autonomous engine's footprint.
    expect(eventCategory("email_sent")).toBe("ai_action");
    expect(eventCategory("objection_handled")).toBe("ai_action");
    expect(eventCategory("task_scheduled")).toBe("ai_action");
  });
});

describe("model — AI task queue vocabulary", () => {
  it("priorityRank mirrors the DB generated column (urgent first; unknown = normal)", () => {
    expect(priorityRank("urgent")).toBe(0);
    expect(priorityRank("high")).toBe(1);
    expect(priorityRank("normal")).toBe(2);
    expect(priorityRank("low")).toBe(3);
    // An unknown priority sorts with 'normal' so junk never jumps the queue.
    expect(priorityRank("bogus")).toBe(2);
  });

  it("tallyTaskStatuses counts known statuses over a zeroed baseline", () => {
    const t = tallyTaskStatuses([
      { status: "pending" },
      { status: "pending" },
      { status: "running" },
      { status: "completed" },
      { status: "not-a-status" },
    ]);
    expect(t.pending).toBe(2);
    expect(t.running).toBe(1);
    expect(t.completed).toBe(1);
    expect(t.failed).toBe(0);
    expect(t.cancelled).toBe(0);
    expect(emptyTaskStatusCounts()).toEqual({
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    });
  });

  it("isOpenTaskStatus is true only for pending/running", () => {
    expect(isOpenTaskStatus("pending")).toBe(true);
    expect(isOpenTaskStatus("running")).toBe(true);
    expect(isOpenTaskStatus("completed")).toBe(false);
    expect(isOpenTaskStatus("failed")).toBe(false);
    expect(isOpenTaskStatus("cancelled")).toBe(false);
  });

  it("task + priority labels fall back to the raw slug when unknown", () => {
    expect(aiTaskStatusLabel("running")).toBe("Running");
    expect(aiTaskStatusLabel("mystery")).toBe("mystery");
    expect(aiTaskPriorityLabel("urgent")).toBe("Urgent");
    expect(aiTaskPriorityLabel("mystery")).toBe("mystery");
  });
});

describe("model — channel vocabulary + promotable outcomes", () => {
  it("channelCategoryLabel maps coarse categories and passes unknowns through", () => {
    expect(channelCategoryLabel("email")).toBe("Email");
    expect(channelCategoryLabel("linkedin")).toBe("LinkedIn");
    expect(channelCategoryLabel("messaging")).toBe("Messaging");
    expect(channelCategoryLabel("carrier_pigeon")).toBe("carrier_pigeon");
  });

  it("isPromotableOutcome recognises winning outcomes only", () => {
    expect(isPromotableOutcome("objection_handled")).toBe(true);
    expect(isPromotableOutcome("call_completed")).toBe(true);
    expect(isPromotableOutcome("demo_completed")).toBe(true);
    expect(isPromotableOutcome("note")).toBe(false);
    expect(isPromotableOutcome("created")).toBe(false);
  });
});

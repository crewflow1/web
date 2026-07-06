import { beforeEach, expect, it, vi } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { recordConversationAuthorisation } from "@/server/services/receptionist-authorisation";
import { verifyApprovedFulfilment } from "@/server/services/receptionist-verification";
import { recoverVerifiedFulfilment } from "@/server/services/receptionist-recovery";
import { resolveConversationCompletion } from "@/server/services/receptionist-resolution";
import { governConversationLifecycle } from "@/server/services/receptionist-lifecycle";
import { orchestrateConversationLifecycle } from "@/server/services/receptionist-orchestration";
import { coordinateConversationLifecycle } from "@/server/services/receptionist-coordination";
import { fulfilApprovedBooking } from "@/server/services/receptionist-fulfilment";
import { queryOrgWorklist } from "@/server/services/receptionist-worklist-read-surface";
import { requireOrgContext } from "@/server/auth/session";
import { fetchOrgWorklist } from "@/server/services/receptionist-worklist-client";
import {
  createWorklistViewModel,
  type WorklistViewModelRuntime,
} from "@/server/services/receptionist-worklist-view-model";
import type { WorklistClientRequest } from "@/lib/receptionist/conversation-worklist-session";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";
import type { NextRequest } from "next/server";

/**
 * Conversation Worklist VIEW MODEL — real-Postgres proof of the AI Receptionist Programme R43 (CONVERSATION
 * WORKLIST VIEW MODEL): the view-model runtime (`server/services/receptionist-worklist-view-model.ts`)
 * PROJECTS the state of a live R42 Worklist Session into presentation-ready data — display rows, a count /
 * range summary, pagination affordances and empty / loading / error verdicts — over the whole live stack
 * (session → R41 client → R40 API → R39 read surface → R38 engine → R37 read model → Postgres).
 *
 * The unit tier pins the pure derivations + the runtime's projection with the transport stubbed; the security
 * tier proves, as a matter of SOURCE, that the view model consumes only the session, holds no organisation and
 * opens no execution path. This tier drives the REAL view-model runtime (its transport is an in-process call to
 * the actual `GET` handler — only `requireOrgContext` is mocked, to inject a seeded org's session) and proves
 * the BEHAVIOUR the directive requires:
 *
 *   (1) THE VIEW MODEL PROJECTS THE BACKLOG THROUGH THE SESSION — a refreshed view model's rows are IDENTICAL
 *       to a direct client read AND to a direct read-surface query (the session, client and API stay
 *       authoritative; the view model adds PRESENTATION, not a second read path), and each row carries the
 *       humanised labels a surface binds to.
 *   (2) SUMMARY + FILTER — a filtered read narrows the rows AND flags `summary.filtered`; clearing restores the
 *       whole view; the summary's count / range reflects the live page.
 *   (3) PAGINATION — the view model pages forward and back, its `pagination` affordances and `summary` range
 *       track position, and paging past the end is a no-op re-projection.
 *   (4) ORGANISATION ISOLATION — a view model bound to org A's session never surfaces org B, and a row carries
 *       no organisation dimension.
 *   (5) REFRESH re-projects LIVE state — a coordination filed after the first read appears on refresh.
 *   (6) THE CLIENT/API REMAIN AUTHORITATIVE FOR VALIDITY — an out-of-range page size the view model does not
 *       validate becomes an `error` verdict carrying the API's 400 message, the last good page's rows retained.
 *   (7) EMPTY STATE — an organisation with no coordinations projects the empty verdict and the empty summary.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in CI if
 * the database is missing. Every ledger exercised (R29→R36) is append-only, so these tests leave their rows
 * behind — harmless in the ephemeral CI database. Each assertion seeds its own org (a fresh uuid).
 */

vi.mock("@/server/auth/session", () => ({ requireOrgContext: vi.fn() }));

const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type RpcClient = { rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T> };
const svc = (): RpcClient => serviceClient() as unknown as RpcClient;

// The API origin the view model's session/client is pointed at; any absolute origin works — in-process transport.
const API_ORIGIN = "http://worklist-view-model.test";

// Late import so the session mock is bound before the route module resolves its imports.
async function loadRoute() {
  return import("@/app/api/receptionist/worklists/route");
}

/** The handler only reads `request.nextUrl.searchParams`, so a URL-bearing stand-in is sufficient. */
function req(url: string): NextRequest {
  return { nextUrl: new URL(url) } as unknown as NextRequest;
}

/** An authenticated session context, as `requireOrgContext` would resolve it for `orgId`. */
function sessionContext(orgId: string): Awaited<ReturnType<typeof requireOrgContext>> {
  return {
    user: { id: "user-1" },
    ctx: {
      membership: { org_id: orgId, role: "owner" },
      org: { id: orgId, name: "Org", slug: "org", status: "active" },
    },
  } as unknown as Awaited<ReturnType<typeof requireOrgContext>>;
}

/**
 * An in-process transport for a given org: it mocks the session to `orgId`, then routes the client's GET into
 * the REAL route handler — so the view model projects the actual API through the actual session and client. The
 * organisation is bound to the SESSION (the transport), never to anything the view model, session or client sends.
 */
function routeTransport(orgId: string): typeof fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    vi.mocked(requireOrgContext).mockResolvedValue(sessionContext(orgId));
    const { GET } = await loadRoute();
    const url = typeof input === "string" ? input : input.toString();
    return (await GET(req(url))) as unknown as Response;
  }) as unknown as typeof fetch;
}

/** Open a REAL view model for a seeded org — its reads run the whole R43→R42→R41→R40→R39→…→Postgres path. */
function viewModel(orgId: string, request: WorklistClientRequest = {}): WorklistViewModelRuntime {
  return createWorklistViewModel({ baseUrl: API_ORIGIN, fetchImpl: routeTransport(orgId), request });
}

/** The coordination ids of a view model's current rows. */
function rowIds(vm: WorklistViewModelRuntime): string[] {
  return vm.getViewModel().rows.map((r) => r.coordinationId);
}

/** Resolve a REAL `approve_booking` decision through the pure cores, so the recorded flags always match the
 *  deterministic fold. `allow`+live ⇒ pending (fulfillable, so coordinatable end to end). */
function authorise(verdict: GuardrailVerdict, live: boolean): ApproveBookingAuthorisation {
  const action = {
    kind: "prepare_booking",
    job_type: JOB,
    postcode: POSTCODE,
    phone_number: PHONE,
  } as const;
  const execution = resolveExecution(action, verdict, { liveExecutionEnabled: live });
  const a = resolveAuthorisation(execution);
  if (!isAuthorisationDecided(a)) throw new Error("test setup: expected a decided authorisation");
  return a;
}

/** Drive the full R29→R34 chain for a held reply so R34 has RECORDED a lifecycle to route. */
async function governThroughStack(opts: {
  orgId: string;
  reviewAuditId: string;
  performFulfilment?: boolean;
  divergentTrade?: boolean;
  conversationId?: string;
}): Promise<{ lifecycleState: string }> {
  const seeded = await recordConversationAuthorisation({
    org_id: opts.orgId,
    conversation_id: opts.conversationId ?? crypto.randomUUID(),
    customer_ref: CALLER,
    correlation_id: crypto.randomUUID(),
    review_audit_id: opts.reviewAuditId,
    decision: authorise("allow", true),
  });
  expect(seeded?.state).toBe("pending");

  if (opts.divergentTrade) {
    const divergent = await svc().rpc<string>("record_receptionist_conversation_fulfilment", {
      p_org_id: opts.orgId,
      p_authorisation_id: seeded?.authorisation_id,
      p_fulfilment_type: "fulfil_booking",
      p_fulfilment_outcome: "booking_recorded",
      p_approval_state: "approved",
      p_correlation_id: crypto.randomUUID(),
      p_review_audit_id: opts.reviewAuditId,
      p_sent_audit_id: crypto.randomUUID(),
      p_review_resolution_id: crypto.randomUUID(),
      p_job_type: "electrical", // DIVERGENT — the authorisation is for plumbing
      p_postcode: POSTCODE,
      p_phone_number: PHONE,
    });
    expect(divergent.error, divergent.error?.message).toBeNull();
  } else if (opts.performFulfilment !== false) {
    const fulfilled = await fulfilApprovedBooking({
      org_id: opts.orgId,
      review_audit_id: opts.reviewAuditId,
      sent_audit_id: crypto.randomUUID(),
      review_resolution_id: crypto.randomUUID(),
    });
    expect(fulfilled, "R30 performed the approved booking").not.toBeNull();
  }

  await verifyApprovedFulfilment({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  await recoverVerifiedFulfilment({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  await resolveConversationCompletion({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  const governed = await governConversationLifecycle({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  expect(governed, "the resolved conversation's lifecycle was governed").not.toBeNull();
  if (!governed) throw new Error("test setup: expected a governed lifecycle");
  return { lifecycleState: governed.lifecycle_state };
}

/** Drive the WHOLE R29→R36 chain and file a real coordination — the decision R37 reads, R38 derives from,
 *  R39 queries, R40 serves, R41 consumes, R42 sessions over and R43 projects. */
async function seedCoordination(opts: {
  orgId: string;
  reviewAuditId: string;
  performFulfilment?: boolean;
  divergentTrade?: boolean;
  conversationId?: string;
}): Promise<{ coordinationId: string; lifecycleState: string }> {
  const { lifecycleState } = await governThroughStack(opts);
  await orchestrateConversationLifecycle({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  const coordinated = await coordinateConversationLifecycle({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  expect(coordinated, "the orchestrated conversation's response was coordinated").not.toBeNull();
  if (!coordinated) throw new Error("test setup: expected a coordination to be filed");
  return { coordinationId: coordinated.coordination_id, lifecycleState };
}

describeIntegration("Conversation Worklist View Model · WorklistViewModelRuntime (R43)", () => {
  beforeEach(() => {
    vi.mocked(requireOrgContext).mockReset();
  });

  it("PROJECTS the backlog THROUGH the session — rows identical to client + read surface, with labels (demonstration 1)", async () => {
    const orgId = crypto.randomUUID();
    const remediating = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      performFulfilment: false,
    });
    const escalating = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      divergentTrade: true,
    });

    const vm = viewModel(orgId, { view: "prioritised" });
    const model = await vm.refresh();

    expect(model.status).toBe("ready");
    expect(model.summary.view).toBe("prioritised");
    expect(rowIds(vm)).toEqual([escalating.coordinationId, remediating.coordinationId]);
    expect(model.rows.map((r) => r.priority)).toEqual(["critical", "elevated"]);
    expect(model.rows.map((r) => r.priorityLabel)).toEqual(["Critical", "Elevated"]);
    expect(model.summary.total).toBe(2);
    expect(model.summary.rangeStart).toBe(1);
    expect(model.summary.rangeEnd).toBe(2);

    // THE SESSION, CLIENT AND API REMAIN AUTHORITATIVE — the view model's rows carry the SAME entries the
    // client returns AND the same the read surface computes. The view model adds presentation, not a read path.
    const viaClient = await fetchOrgWorklist(
      { view: "prioritised" },
      { baseUrl: API_ORIGIN, fetchImpl: routeTransport(orgId) },
    );
    const direct = await queryOrgWorklist({ org_id: orgId, view: "prioritised" });
    expect(rowIds(vm)).toEqual(viaClient.items.map((e) => e.coordination_id));
    expect(rowIds(vm)).toEqual(direct.items.map((e) => e.coordination_id));
  });

  it("projects SUMMARY + FILTER — set narrows and flags filtered, clear restores (demonstration 2)", async () => {
    const orgId = crypto.randomUUID();
    await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), performFulfilment: false });
    const escalating = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      divergentTrade: true,
    });

    const vm = viewModel(orgId, { view: "prioritised" });
    let model = await vm.refresh();
    expect(model.summary.total).toBe(2);
    expect(model.summary.filtered).toBe(false);

    model = await vm.setFilter({ priorities: ["critical"] });
    expect(rowIds(vm)).toEqual([escalating.coordinationId]);
    expect(model.summary.total).toBe(1);
    expect(model.summary.filtered).toBe(true);

    model = await vm.clearFilter();
    expect(model.summary.total).toBe(2);
    expect(model.summary.filtered).toBe(false);
  });

  it("projects PAGINATION — pages forward, back, tracks range, no-ops past the end (demonstration 3)", async () => {
    const orgId = crypto.randomUUID();
    const remediating = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      performFulfilment: false,
    });
    const escalating = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      divergentTrade: true,
    });

    const vm = viewModel(orgId, { view: "prioritised", page: { limit: 1 } });
    let model = await vm.refresh();
    expect(rowIds(vm)).toEqual([escalating.coordinationId]);
    expect(model.pagination.hasNext).toBe(true);
    expect(model.pagination.hasPrevious).toBe(false);
    expect(model.summary.rangeStart).toBe(1);
    expect(model.summary.rangeEnd).toBe(1);

    model = await vm.nextPage();
    expect(rowIds(vm)).toEqual([remediating.coordinationId]);
    expect(model.pagination.offset).toBe(1);
    expect(model.pagination.hasNext).toBe(false);
    expect(model.pagination.hasPrevious).toBe(true);
    expect(model.summary.rangeStart).toBe(2);
    expect(model.summary.rangeEnd).toBe(2);

    // Paging past the end is a no-op — the re-projected view model equals the one before.
    const before = vm.getViewModel();
    const after = await vm.nextPage();
    expect(after).toEqual(before);

    // …and stepping back returns to the first page.
    model = await vm.previousPage();
    expect(rowIds(vm)).toEqual([escalating.coordinationId]);
    expect(model.pagination.hasPrevious).toBe(false);
  });

  it("preserves ORGANISATION ISOLATION — a view model bound to org A never surfaces org B (demonstration 4)", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const a = await seedCoordination({ orgId: orgA, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    const b = await seedCoordination({ orgId: orgB, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    const va = viewModel(orgA, { view: "prioritised" });
    const vb = viewModel(orgB, { view: "prioritised" });
    await va.refresh();
    await vb.refresh();

    expect(rowIds(va)).toEqual([a.coordinationId]);
    expect(rowIds(va)).not.toContain(b.coordinationId);
    expect(rowIds(vb)).toEqual([b.coordinationId]);
    expect(rowIds(vb)).not.toContain(a.coordinationId);

    // A projected row carries NO organisation dimension — isolation is inherited structurally.
    const row = va.getViewModel().rows[0]!;
    expect(Object.keys(row)).not.toContain("org_id");
    expect(Object.keys(row)).not.toContain("record");
  });

  it("REFRESH re-projects live state — a later coordination appears on refresh (demonstration 5)", async () => {
    const orgId = crypto.randomUUID();
    await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    const vm = viewModel(orgId, { view: "prioritised" });
    let model = await vm.refresh();
    expect(model.summary.total).toBe(1);
    expect(model.rows).toHaveLength(1);

    // File a second coordination AFTER the first read, then refresh — the view model reflects it (no stale cache).
    await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    model = await vm.refresh();
    expect(model.summary.total).toBe(2);
    expect(model.rows).toHaveLength(2);
  });

  it("surfaces the client/API authority — an out-of-range page becomes an error verdict, rows retained (demonstration 6)", async () => {
    const orgId = crypto.randomUUID();
    await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    const vm = viewModel(orgId, { view: "prioritised" });
    await vm.refresh();
    const good = vm.getViewModel();
    expect(good.summary.total).toBe(1);
    expect(good.rows).toHaveLength(1);

    // The view model does not validate the bound — `limit=0` is serialised and the API rejects it; the client's
    // typed error becomes the view model's `error` verdict, and the last good page's rows are retained.
    const model = await vm.setPageSize(0);
    expect(model.status).toBe("error");
    expect(model.error.isError).toBe(true);
    expect(model.error.message).toMatch(/limit/i);
    expect(model.error.hasStalePage).toBe(true);
    expect(model.rows).toHaveLength(1);
  });

  it("projects the EMPTY state — an org with no coordinations (demonstration 7)", async () => {
    const orgId = crypto.randomUUID(); // seed nothing

    const vm = viewModel(orgId, { view: "prioritised" });
    const model = await vm.refresh();

    expect(model.status).toBe("ready");
    expect(model.rows).toEqual([]);
    expect(model.empty.isEmpty).toBe(true);
    expect(model.empty.message).toBe("This worklist is empty.");
    expect(model.summary.total).toBe(0);
    expect(model.summary.label).toBe("No conversations");
  });
});

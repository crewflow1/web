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
import { requireOrgContext } from "@/server/auth/session";
import {
  createWorklistViewModel,
  type WorklistViewModelRuntime,
} from "@/server/services/receptionist-worklist-view-model";
import type { WorklistClientRequest } from "@/lib/receptionist/conversation-worklist-session";
import {
  WORKLIST_PAGE_SIZE,
  parseWorklistViewParam,
  parseOffsetParam,
} from "@/app/admin/ai-receptionist/worklist/navigation";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";
import type { NextRequest } from "next/server";

/**
 * Conversation Worklist OPERATOR SURFACE — real-Postgres proof of the AI Receptionist Programme R44 (READ-ONLY
 * WORKLIST OPERATOR SURFACE): the surface consumes the R43 view model and NOTHING else, over the whole live
 * stack (view model → R42 session → R41 client → R40 API → R39 read surface → R38 engine → R37 read model →
 * Postgres). The surface itself is a React server component (its rendering is pinned by the production build,
 * its consuming-only-the-view-model by the security tier); this tier drives the surface's exact DATA path —
 * the request it builds from its URL params, fed to the REAL view-model runtime — and proves the BEHAVIOUR the
 * directive requires:
 *
 *   (1) THE SURFACE PROJECTS THE BACKLOG THROUGH THE VIEW MODEL — the request the page builds from `?view=` /
 *       `?offset=` (via its navigation helper, page size {@link WORKLIST_PAGE_SIZE}) yields a ready view model
 *       whose rows ARE the seeded org's worklist, each carrying humanised labels. The surface adds
 *       presentation, not a read path.
 *   (2) ORGANISATION ISOLATION IS INHERITED — a surface bound to org A's session never surfaces org B, and a
 *       projected row carries no organisation dimension. The scope is the API's, resolved from the session the
 *       transport stands in for — never anything the surface names.
 *   (3) THE OFFSET PARAM REACHES THE API — a parsed `?offset=` beyond the backlog yields an empty page whose
 *       pagination window echoes the offset (previous available, next not), proving the surface's page window
 *       flows through the view model to the authoritative read.
 *   (4) THE EMPTY STATE — an org with no coordinations projects the empty verdict and the empty summary.
 *
 * Only `requireOrgContext` is mocked, to inject a seeded org's session into the in-process transport — exactly
 * as the surface forwards the inbound cookie and the API resolves the org from it. Runs only against a live DB
 * (describeIntegration): skipped locally with no database, FAILED loudly in CI if the database is missing.
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

// The API origin the surface's view model is pointed at; any absolute origin works — in-process transport.
const API_ORIGIN = "http://worklist-operator-surface.test";

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
 * the REAL route handler — so the surface's view model projects the actual API through the actual session and
 * client. The organisation is bound to the SESSION (the transport), never to anything the surface sends. This
 * stands in for the surface forwarding the inbound cookie and the API resolving the org from it.
 */
function routeTransport(orgId: string): typeof fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    vi.mocked(requireOrgContext).mockResolvedValue(sessionContext(orgId));
    const { GET } = await loadRoute();
    const url = typeof input === "string" ? input : input.toString();
    return (await GET(req(url))) as unknown as Response;
  }) as unknown as typeof fetch;
}

/**
 * Build the request EXACTLY as the operator surface page does — normalise `?view=` / `?offset=` through the
 * page's own navigation helper and request one fixed page. So this tier drives the surface's real data path.
 */
function surfaceRequest(sp: { view?: string; offset?: string }): WorklistClientRequest {
  return {
    view: parseWorklistViewParam(sp.view),
    page: { limit: WORKLIST_PAGE_SIZE, offset: parseOffsetParam(sp.offset) },
  };
}

/** Open a view model the way the surface does — the surface's request over a seeded org's session. */
function surface(orgId: string, sp: { view?: string; offset?: string }): WorklistViewModelRuntime {
  return createWorklistViewModel({
    baseUrl: API_ORIGIN,
    fetchImpl: routeTransport(orgId),
    request: surfaceRequest(sp),
  });
}

/** The coordination ids of a view model's current rows. */
function rowIds(vm: WorklistViewModelRuntime): string[] {
  return vm.getViewModel().rows.map((r) => r.coordinationId);
}

/** Resolve a REAL `approve_booking` decision through the pure cores, so the recorded flags match the fold. */
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
}): Promise<void> {
  const seeded = await recordConversationAuthorisation({
    org_id: opts.orgId,
    conversation_id: crypto.randomUUID(),
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
}

/** Drive the WHOLE R29→R36 chain and file a real coordination — the decision R37 reads, R38 derives from,
 *  R39 queries, R40 serves, R41 consumes, R42 sessions over, R43 projects and R44 renders. */
async function seedCoordination(opts: {
  orgId: string;
  reviewAuditId: string;
  performFulfilment?: boolean;
  divergentTrade?: boolean;
}): Promise<{ coordinationId: string }> {
  await governThroughStack(opts);
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
  return { coordinationId: coordinated.coordination_id };
}

describeIntegration("Conversation Worklist Operator Surface (R44)", () => {
  beforeEach(() => {
    vi.mocked(requireOrgContext).mockReset();
  });

  it("PROJECTS the backlog THROUGH the view model — the surface's request yields the seeded worklist with labels (demonstration 1)", async () => {
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

    // No params — the surface opens on the prioritised backlog, first page.
    const vm = surface(orgId, {});
    const model = await vm.refresh();

    expect(model.status).toBe("ready");
    expect(model.summary.view).toBe("prioritised");
    expect(rowIds(vm)).toEqual([escalating.coordinationId, remediating.coordinationId]);
    expect(model.rows.map((r) => r.priorityLabel)).toEqual(["Critical", "Elevated"]);
    expect(model.summary.total).toBe(2);
    expect(model.summary.rangeStart).toBe(1);
    expect(model.summary.rangeEnd).toBe(2);
    expect(model.pagination.hasNext).toBe(false);
    expect(model.pagination.hasPrevious).toBe(false);
  });

  it("preserves ORGANISATION ISOLATION — a surface bound to org A never surfaces org B (demonstration 2)", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const a = await seedCoordination({ orgId: orgA, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    const b = await seedCoordination({ orgId: orgB, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    const va = surface(orgA, {});
    const vb = surface(orgB, {});
    await va.refresh();
    await vb.refresh();

    expect(rowIds(va)).toEqual([a.coordinationId]);
    expect(rowIds(va)).not.toContain(b.coordinationId);
    expect(rowIds(vb)).toEqual([b.coordinationId]);
    expect(rowIds(vb)).not.toContain(a.coordinationId);

    // A projected row carries NO organisation dimension — isolation is inherited, not something the surface holds.
    const row = va.getViewModel().rows[0]!;
    expect(Object.keys(row)).not.toContain("org_id");
    expect(Object.keys(row)).not.toContain("record");
  });

  it("the OFFSET param reaches the API — a page past the backlog is empty, window echoes the offset (demonstration 3)", async () => {
    const orgId = crypto.randomUUID();
    await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    // `?offset=<page size>` — the second page, past the single seeded entry.
    const vm = surface(orgId, { offset: String(WORKLIST_PAGE_SIZE) });
    const model = await vm.refresh();

    expect(model.status).toBe("ready");
    expect(model.rows).toEqual([]);
    expect(model.pagination.offset).toBe(WORKLIST_PAGE_SIZE);
    expect(model.pagination.hasPrevious).toBe(true);
    expect(model.pagination.hasNext).toBe(false);
    // The total still reflects the backlog — the offset moved the window, it did not change the read's scope.
    expect(model.summary.total).toBe(1);
  });

  it("projects the EMPTY state — an org with no coordinations (demonstration 4)", async () => {
    const orgId = crypto.randomUUID(); // seed nothing

    const vm = surface(orgId, {});
    const model = await vm.refresh();

    expect(model.status).toBe("ready");
    expect(model.rows).toEqual([]);
    expect(model.empty.isEmpty).toBe(true);
    expect(model.empty.message).toBe("This worklist is empty.");
    expect(model.summary.total).toBe(0);
    expect(model.summary.label).toBe("No conversations");
  });
});

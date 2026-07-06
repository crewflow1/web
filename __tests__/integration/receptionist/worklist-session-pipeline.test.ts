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
  createWorklistSession,
  type WorklistSession,
} from "@/server/services/receptionist-worklist-session";
import {
  hasNextWorklistPage,
  hasPreviousWorklistPage,
  type WorklistClientRequest,
} from "@/lib/receptionist/conversation-worklist-session";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";
import type { NextRequest } from "next/server";

/**
 * Conversation Worklist SESSION — real-Postgres proof of the AI Receptionist Programme R42 (CONVERSATION
 * WORKLIST SESSION): the stateful session (`server/services/receptionist-worklist-session.ts`) manages the
 * STATE of consuming Conversation Worklists — view, filter, page position and refresh status — by reading
 * THROUGH the R41 client, which consumes the R40 API, over the live stack (API → R39 read surface → R38
 * engine → R37 read model → Postgres).
 *
 * The unit tier pins the pure state model + the runtime's orchestration with the transport stubbed; the
 * security tier proves, as a matter of SOURCE, that the session consumes only the client, holds no
 * organisation and opens no execution path. This tier drives the REAL session (its transport is an in-process
 * call to the actual `GET` handler — only `requireOrgContext` is mocked, to inject a seeded org's session)
 * and proves the BEHAVIOUR the directive requires:
 *
 *   (1) THE SESSION READS THROUGH THE CLIENT — a refreshed session's page is IDENTICAL to a direct client
 *       read AND to a direct read-surface query (the client and the API stay authoritative; the session adds
 *       STATE, not a second read path).
 *   (2) FILTER STATE — setting a filter narrows the page; clearing it restores the whole view, all as session
 *       state across successive reads.
 *   (3) PAGINATION STATE — the session pages forward and back over the backlog and reports position
 *       (`hasNextWorklistPage` / `hasPreviousWorklistPage`); paging past the end is a no-op.
 *   (4) ORGANISATION ISOLATION — a session bound to org A's session never surfaces org B; the session names
 *       no organisation.
 *   (5) REFRESH re-reads LIVE state — a refreshed session reflects a coordination filed after its first read.
 *   (6) THE CLIENT/API REMAIN AUTHORITATIVE FOR VALIDITY — an out-of-range page size the session does not
 *       validate becomes `error` status carrying the API's 400 message, the last good page retained.
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

// The API origin the session's client is pointed at; any absolute origin works — the transport is in-process.
const API_ORIGIN = "http://worklist-session.test";

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
 * the REAL route handler — so the session consumes the actual API through the actual client. The organisation
 * is bound to the SESSION (the transport), never to anything the session or client sends.
 */
function routeTransport(orgId: string): typeof fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    vi.mocked(requireOrgContext).mockResolvedValue(sessionContext(orgId));
    const { GET } = await loadRoute();
    const url = typeof input === "string" ? input : input.toString();
    return (await GET(req(url))) as unknown as Response;
  }) as unknown as typeof fetch;
}

/** Open a REAL session for a seeded org — its reads run the whole R42→R41→R40→R39→…→Postgres path. */
function session(orgId: string, request: WorklistClientRequest = {}): WorklistSession {
  return createWorklistSession({ baseUrl: API_ORIGIN, fetchImpl: routeTransport(orgId), request });
}

/** The coordination ids of a session's current page. */
function pageIds(s: WorklistSession): string[] {
  return (s.getState().page?.items ?? []).map((e) => e.coordination_id);
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
 *  R39 queries, R40 serves, R41 consumes and R42 sessions over. */
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

describeIntegration("Conversation Worklist Session · WorklistSession (R42)", () => {
  beforeEach(() => {
    vi.mocked(requireOrgContext).mockReset();
  });

  it("reads the backlog THROUGH the client — identical to the client and the read surface (demonstration 1)", async () => {
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

    const s = session(orgId, { view: "prioritised" });
    const state = await s.refresh();

    expect(state.status).toBe("ready");
    expect(state.page?.view).toBe("prioritised");
    expect(pageIds(s)).toEqual([escalating.coordinationId, remediating.coordinationId]);
    expect(state.page?.items.map((e) => e.priority)).toEqual(["critical", "elevated"]);

    // THE CLIENT AND API REMAIN AUTHORITATIVE — the session's page carries the SAME entries the client returns
    // AND the same the read surface computes. The session adds state, not a divergent read path.
    const viaClient = await fetchOrgWorklist(
      { view: "prioritised" },
      { baseUrl: API_ORIGIN, fetchImpl: routeTransport(orgId) },
    );
    const direct = await queryOrgWorklist({ org_id: orgId, view: "prioritised" });
    expect(pageIds(s)).toEqual(viaClient.items.map((e) => e.coordination_id));
    expect(pageIds(s)).toEqual(direct.items.map((e) => e.coordination_id));
  });

  it("manages FILTER STATE — set narrows, clear restores (demonstration 2)", async () => {
    const orgId = crypto.randomUUID();
    await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), performFulfilment: false });
    const escalating = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      divergentTrade: true,
    });

    const s = session(orgId, { view: "prioritised" });
    await s.refresh();
    expect(s.getState().page?.total).toBe(2);

    await s.setFilter({ priorities: ["critical"] });
    expect(pageIds(s)).toEqual([escalating.coordinationId]);
    expect(s.getState().page?.total).toBe(1);

    await s.clearFilter();
    expect(s.getState().page?.total).toBe(2);
  });

  it("manages PAGINATION STATE — pages forward, back, and no-ops past the end (demonstration 3)", async () => {
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

    const s = session(orgId, { view: "prioritised", page: { limit: 1 } });
    await s.refresh();
    expect(pageIds(s)).toEqual([escalating.coordinationId]);
    expect(hasNextWorklistPage(s.getState())).toBe(true);
    expect(hasPreviousWorklistPage(s.getState())).toBe(false);

    await s.nextPage();
    expect(pageIds(s)).toEqual([remediating.coordinationId]);
    expect(s.getState().page?.offset).toBe(1);
    expect(hasNextWorklistPage(s.getState())).toBe(false);
    expect(hasPreviousWorklistPage(s.getState())).toBe(true);

    // Paging past the end is a no-op — the state object is unchanged.
    const atEnd = s.getState();
    expect(await s.nextPage()).toBe(atEnd);

    // …and stepping back returns to the first page.
    await s.previousPage();
    expect(pageIds(s)).toEqual([escalating.coordinationId]);
  });

  it("preserves ORGANISATION ISOLATION — a session bound to org A never surfaces org B (demonstration 4)", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const a = await seedCoordination({ orgId: orgA, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    const b = await seedCoordination({ orgId: orgB, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    const sa = session(orgA, { view: "prioritised" });
    const sb = session(orgB, { view: "prioritised" });
    await sa.refresh();
    await sb.refresh();

    expect(pageIds(sa)).toEqual([a.coordinationId]);
    expect(sa.getState().page?.items.every((e) => e.org_id === orgA)).toBe(true);
    expect(pageIds(sa)).not.toContain(b.coordinationId);

    expect(pageIds(sb)).toEqual([b.coordinationId]);
    expect(sb.getState().page?.items.every((e) => e.org_id === orgB)).toBe(true);
    expect(pageIds(sb)).not.toContain(a.coordinationId);
  });

  it("REFRESH re-reads live state — a later coordination appears on refresh (demonstration 5)", async () => {
    const orgId = crypto.randomUUID();
    await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    const s = session(orgId, { view: "prioritised" });
    await s.refresh();
    expect(s.getState().page?.total).toBe(1);

    // File a second coordination AFTER the first read, then refresh — the session reflects it (no stale cache).
    await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    await s.refresh();
    expect(s.getState().page?.total).toBe(2);
  });

  it("surfaces the client/API authority — an out-of-range page becomes error state (demonstration 6)", async () => {
    const orgId = crypto.randomUUID();
    await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    const s = session(orgId, { view: "prioritised" });
    await s.refresh();
    const good = s.getState().page;
    expect(good?.total).toBe(1);

    // The session does not validate the bound — `limit=0` is serialised and the API rejects it; the client's
    // typed error becomes the session's `error` status, and the last good page is retained.
    await s.setPageSize(0);
    const state = s.getState();
    expect(state.status).toBe("error");
    expect(state.error).toMatch(/limit/i);
    expect(state.page).toEqual(good);
  });
});

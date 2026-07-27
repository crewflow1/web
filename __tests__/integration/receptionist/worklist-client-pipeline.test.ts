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
  nextWorklistPageRequest,
  WorklistClientError,
  type WorklistClientRequest,
  type WorklistPage,
} from "@/lib/receptionist/conversation-worklist-client";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";
import type { NextRequest } from "next/server";

/**
 * Conversation Worklist Client — real-Postgres proof of the AI Receptionist Programme R41 (CONVERSATION
 * WORKLIST CLIENT): the typed client (`server/services/receptionist-worklist-client.ts`) CONSUMES the R40
 * API end to end, through the live stack (API → R39 read surface → R38 engine → R37 read model → Postgres).
 *
 * R40 shipped the API — the authenticated HTTP interface over the read surface. R41 is the canonical
 * CLIENT of that API. The unit tier pins the pure contract (serialisation / parsing / helpers) and the
 * runtime consumption with the transport stubbed; the security tier proves, as a matter of SOURCE, that the
 * client consumes only the API, names no organisation and opens no execution path. This tier drives the
 * REAL client against the REAL route against real Postgres — the transport is an in-process call to the
 * actual `GET` handler (only `requireOrgContext` is mocked, to inject a seeded org's session) — and proves
 * the BEHAVIOUR the directive requires:
 *
 *   (1) THE CLIENT READS THE PRIORITISED BACKLOG THROUGH THE API — a typed `fetchOrgWorklist` returns the
 *       R38 backlog the API serves, and it is IDENTICAL to a direct read-surface query (the API stays
 *       authoritative; the client adds a transport, not a second read path).
 *   (2) FILTERING IS SUPPORTED — a typed `filter` narrows the page to the matching coordination.
 *   (3) PAGINATION IS SUPPORTED — the pure `nextWorklistPageRequest` helper drives successive real reads
 *       that cover the whole backlog, one entry at a time.
 *   (4) ORGANISATION ISOLATION IS PRESERVED — a client bound to org A's session never surfaces org B, and
 *       the request carries no vocabulary to ask for another org.
 *   (5) THE API REMAINS AUTHORITATIVE FOR VALIDITY — an out-of-range page the client does not validate is
 *       rejected by the API, and the client surfaces the API's 400 as a typed {@link WorklistClientError}.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in CI
 * if the database is missing. Every ledger exercised (R29→R36) is append-only, so these tests leave their
 * rows behind — harmless in the ephemeral CI database. Each assertion seeds its own org (a fresh uuid) so
 * it sees only its own writes.
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

// The API origin the client is pointed at; any absolute origin works — the transport is in-process.
const API_ORIGIN = "http://worklist-client.test";

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
 * An in-process transport for a given org: it mocks the session to `orgId`, then routes the client's GET
 * into the REAL route handler — so the client consumes the actual API, not a stub. The organisation is
 * bound to the SESSION (the transport), never to anything the client sends.
 */
function routeTransport(orgId: string): typeof fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    vi.mocked(requireOrgContext).mockResolvedValue(sessionContext(orgId));
    const { GET } = await loadRoute();
    const url = typeof input === "string" ? input : input.toString();
    return (await GET(req(url))) as unknown as Response;
  }) as unknown as typeof fetch;
}

/** Drive the REAL client (through the REAL route) for a seeded org — the whole R41→R40→R39→…→Postgres path. */
function client(orgId: string, request: WorklistClientRequest): Promise<WorklistPage> {
  return fetchOrgWorklist(request, { baseUrl: API_ORIGIN, fetchImpl: routeTransport(orgId) });
}

/** Resolve a REAL `approve_booking` decision through the pure cores, so the recorded flags always match
 *  the deterministic fold. `allow`+live ⇒ pending (fulfillable, so coordinatable end to end). */
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

/** Drive the full R29→R34 chain for a held reply so R34 has RECORDED a lifecycle to route.
 *  `divergentTrade` seeds an inconsistent fulfilment (escalated path); `performFulfilment=false` skips
 *  R30 (retained path); the default is the terminal → closed path. */
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

/** Drive the WHOLE R29→R36 chain and file a real coordination — the recorded decision R37 reads, R38
 *  derives worklists from, R39 queries, R40 serves over HTTP and R41 consumes. */
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

describeIntegration("Conversation Worklist Client · fetchOrgWorklist (R41)", () => {
  beforeEach(() => {
    vi.mocked(requireOrgContext).mockReset();
  });

  it("reads the prioritised backlog through the API — identical to the read surface (demonstration 1)", async () => {
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

    const clientPage = await client(orgId, { view: "prioritised" });

    // Critical (escalation) leads, then elevated (recovery) — the R38 order, over the client.
    expect(clientPage.view).toBe("prioritised");
    expect(clientPage.items.map((e) => e.coordination_id)).toEqual([
      escalating.coordinationId,
      remediating.coordinationId,
    ]);
    expect(clientPage.items.map((e) => e.priority)).toEqual(["critical", "elevated"]);
    expect(clientPage).toMatchObject({ total: 2, offset: 0, has_more: false });

    // THE API REMAINS AUTHORITATIVE — the client's HTTP page carries the SAME entries a direct read-surface
    // query returns. The client adds a transport, not a divergent read path.
    const direct = await queryOrgWorklist({ org_id: orgId, view: "prioritised" });
    expect(clientPage.items.map((e) => e.coordination_id)).toEqual(
      direct.items.map((e) => e.coordination_id),
    );
  });

  it("supports FILTERING — a typed filter narrows the page (demonstration 2)", async () => {
    const orgId = crypto.randomUUID();
    await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), performFulfilment: false });
    const escalating = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      divergentTrade: true,
    });

    const filtered = await client(orgId, {
      view: "prioritised",
      filter: { priorities: ["critical"] },
    });
    expect(filtered.items.map((e) => e.coordination_id)).toEqual([escalating.coordinationId]);
    expect(filtered.total).toBe(1);
  });

  it("supports PAGINATION — nextWorklistPageRequest drives successive reads (demonstration 3)", async () => {
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

    const firstRequest: WorklistClientRequest = { view: "prioritised", page: { limit: 1 } };
    const firstPage = await client(orgId, firstRequest);
    expect(firstPage.items.map((e) => e.coordination_id)).toEqual([escalating.coordinationId]);
    expect(firstPage).toMatchObject({ total: 2, limit: 1, offset: 0, has_more: true });

    // The pure helper computes the NEXT request from the API's paging metadata; the client reads it.
    const secondRequest = nextWorklistPageRequest(firstRequest, firstPage);
    expect(secondRequest).not.toBeNull();
    const secondPage = await client(orgId, secondRequest!);
    expect(secondPage.items.map((e) => e.coordination_id)).toEqual([remediating.coordinationId]);
    expect(secondPage).toMatchObject({ total: 2, limit: 1, offset: 1, has_more: false });

    // The backlog is drained — there is no further page to request.
    expect(nextWorklistPageRequest(secondRequest!, secondPage)).toBeNull();
  });

  it("preserves ORGANISATION ISOLATION — a client bound to org A never surfaces org B (demonstration 4)", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const a = await seedCoordination({ orgId: orgA, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    const b = await seedCoordination({ orgId: orgB, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    const pageA = await client(orgA, { view: "prioritised" });
    const pageB = await client(orgB, { view: "prioritised" });

    expect(pageA.items.map((e) => e.coordination_id)).toEqual([a.coordinationId]);
    expect(pageA.items.every((e) => e.org_id === orgA)).toBe(true);
    expect(pageA.items.map((e) => e.coordination_id)).not.toContain(b.coordinationId);

    expect(pageB.items.map((e) => e.coordination_id)).toEqual([b.coordinationId]);
    expect(pageB.items.every((e) => e.org_id === orgB)).toBe(true);
    expect(pageB.items.map((e) => e.coordination_id)).not.toContain(a.coordinationId);
  });

  it("surfaces the API's authority — an out-of-range page is the API's 400, raised as a typed error (demonstration 5)", async () => {
    const orgId = crypto.randomUUID();
    await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    // The client does not validate the bound locally — it serialises `limit=0` and lets the API reject it.
    const error = await client(orgId, { page: { limit: 0 } }).catch((e) => e);
    expect(error).toBeInstanceOf(WorklistClientError);
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/limit/i);
  });
});

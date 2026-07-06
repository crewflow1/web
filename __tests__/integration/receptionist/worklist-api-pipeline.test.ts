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
import { getCoordinationWorklists } from "@/server/services/receptionist-coordination-worklist";
import { requireOrgContext } from "@/server/auth/session";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";
import type { NextRequest } from "next/server";

/**
 * Conversation Worklist API — real-Postgres proof of the AI Receptionist Programme R40 (CONVERSATION
 * WORKLIST API): the HTTP endpoint `GET /api/receptionist/worklists` READ end to end through the live
 * stack (R39 read surface → R38 engine → R37 read model → Postgres).
 *
 * R39 shipped the read surface — a read-only query over the worklists the R38 engine DERIVES. R40 exposes
 * that surface as an authenticated APPLICATION INTERFACE. The unit tier pins the pure request contract and
 * the route wiring (both seams mocked); the security tier proves, as a matter of SOURCE, that the API
 * reads only through R39, derives no worklist and opens no execution path. This tier calls the REAL route
 * handler against real Postgres — only `requireOrgContext` is mocked, to inject a seeded org's session —
 * and proves the BEHAVIOUR the directive requires:
 *
 *   (1) THE PRIORITISED WORKLIST IS SERVED OVER HTTP — a `GET` returns the R38 backlog verbatim, as JSON.
 *   (2) THE FOUR REQUIRED WORKLISTS ARE EXPOSED — prioritised / human_review / recovery / escalation each
 *       return the expected coordination over HTTP.
 *   (3) FILTERING NARROWS THE HTTP PAGE — a `?priority=critical` query returns only the escalation.
 *   (4) PAGINATION BOUNDS THE HTTP PAGE — `?limit=1` then `?limit=1&offset=1` covers the whole backlog.
 *   (5) THE PAGE IS STABLY ORDERED — the same request twice yields an identical page.
 *   (6) ORGANISATION ISOLATION IS PRESERVED — a session scoped to org A never surfaces org B's worklist.
 *   (7) ORG COMES FROM THE SESSION, NEVER THE REQUEST — a client-supplied `?org_id=<orgB>` while the
 *       session is org A is IGNORED: the page returns only org A's data. This is the structural isolation
 *       guarantee, proven against live data.
 *   (8) A MALFORMED QUERY IS A 400 — an unknown view is rejected before any read.
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

// Late import so the session mock is bound before the route module resolves its imports.
async function loadRoute() {
  return import("@/app/api/receptionist/worklists/route");
}

/** The handler only reads `request.nextUrl.searchParams`, so a URL-bearing stand-in is sufficient. */
function req(queryString: string): NextRequest {
  return {
    nextUrl: new URL(`http://localhost/api/receptionist/worklists${queryString}`),
  } as unknown as NextRequest;
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

type ApiPage = {
  ok: boolean;
  view?: string;
  items?: Array<{ coordination_id: string; org_id: string; priority: string }>;
  total?: number;
  limit?: number;
  offset?: number;
  has_more?: boolean;
  error?: string;
};

/** Drive the REAL route: mock the session to `orgId`, GET the query string, return status + parsed JSON. */
async function httpGet(
  orgId: string,
  queryString: string,
): Promise<{ status: number; body: ApiPage }> {
  vi.mocked(requireOrgContext).mockResolvedValue(sessionContext(orgId));
  const { GET } = await loadRoute();
  const res = await GET(req(queryString));
  return { status: res.status, body: (await res.json()) as ApiPage };
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
 *  derives worklists from, R39 queries and R40 serves over HTTP. */
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

describeIntegration("Conversation Worklist API · GET /api/receptionist/worklists (R40)", () => {
  beforeEach(() => {
    vi.mocked(requireOrgContext).mockReset();
  });

  it("serves the prioritised worklist over HTTP — the R38 backlog verbatim, as JSON (demonstration 1)", async () => {
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

    const { status, body } = await httpGet(orgId, "?view=prioritised");

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.view).toBe("prioritised");
    // Critical (escalation) leads, then elevated (recovery).
    expect(body.items?.map((e) => e.coordination_id)).toEqual([
      escalating.coordinationId,
      remediating.coordinationId,
    ]);
    expect(body.items?.map((e) => e.priority)).toEqual(["critical", "elevated"]);
    expect(body).toMatchObject({ total: 2, offset: 0, has_more: false });

    // THE READ SURFACE STAYS AUTHORITATIVE — the HTTP page carries the SAME entries R38/R39 derived.
    const set = await getCoordinationWorklists({ org_id: orgId });
    expect(body.items?.map((e) => e.coordination_id)).toEqual(
      set.prioritised.map((e) => e.coordination_id),
    );
  });

  it("exposes the FOUR required worklists over HTTP (demonstration 2)", async () => {
    const orgId = crypto.randomUUID();
    const escalating = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      divergentTrade: true,
    });
    const remediating = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      performFulfilment: false,
    });

    const humanReview = await httpGet(orgId, "?view=human_review");
    const recovery = await httpGet(orgId, "?view=recovery");
    const escalation = await httpGet(orgId, "?view=escalation");
    const prioritised = await httpGet(orgId, "?view=prioritised");

    expect(humanReview.body.items?.map((e) => e.coordination_id)).toEqual([escalating.coordinationId]);
    expect(escalation.body.items?.map((e) => e.coordination_id)).toEqual([escalating.coordinationId]);
    expect(recovery.body.items?.map((e) => e.coordination_id)).toEqual([remediating.coordinationId]);
    expect(prioritised.body.items?.map((e) => e.coordination_id)).toEqual([
      escalating.coordinationId,
      remediating.coordinationId,
    ]);
  });

  it("FILTERING narrows the HTTP page (demonstration 3)", async () => {
    const orgId = crypto.randomUUID();
    await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), performFulfilment: false });
    const escalating = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      divergentTrade: true,
    });

    const { body } = await httpGet(orgId, "?view=prioritised&priority=critical");
    expect(body.items?.map((e) => e.coordination_id)).toEqual([escalating.coordinationId]);
    expect(body.total).toBe(1);
  });

  it("PAGINATION bounds the HTTP page — one entry at a time covers the backlog (demonstration 4)", async () => {
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

    const first = await httpGet(orgId, "?view=prioritised&limit=1");
    expect(first.body.items?.map((e) => e.coordination_id)).toEqual([escalating.coordinationId]);
    expect(first.body).toMatchObject({ total: 2, limit: 1, offset: 0, has_more: true });

    const second = await httpGet(orgId, "?view=prioritised&limit=1&offset=1");
    expect(second.body.items?.map((e) => e.coordination_id)).toEqual([remediating.coordinationId]);
    expect(second.body).toMatchObject({ total: 2, limit: 1, offset: 1, has_more: false });
  });

  it("the HTTP page is STABLY ORDERED — the same request twice is identical (demonstration 5)", async () => {
    const orgId = crypto.randomUUID();
    await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    const once = await httpGet(orgId, "?view=prioritised");
    const twice = await httpGet(orgId, "?view=prioritised");
    expect(twice.body.items?.map((e) => e.coordination_id)).toEqual(
      once.body.items?.map((e) => e.coordination_id),
    );
  });

  it("ORGANISATION ISOLATION — a session scoped to org A never surfaces org B (demonstration 6)", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const a = await seedCoordination({ orgId: orgA, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    const b = await seedCoordination({ orgId: orgB, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    const pageA = await httpGet(orgA, "?view=prioritised");
    const pageB = await httpGet(orgB, "?view=prioritised");

    expect(pageA.body.items?.map((e) => e.coordination_id)).toEqual([a.coordinationId]);
    expect(pageA.body.items?.every((e) => e.org_id === orgA)).toBe(true);
    expect(pageA.body.items?.map((e) => e.coordination_id)).not.toContain(b.coordinationId);

    expect(pageB.body.items?.map((e) => e.coordination_id)).toEqual([b.coordinationId]);
    expect(pageB.body.items?.every((e) => e.org_id === orgB)).toBe(true);
    expect(pageB.body.items?.map((e) => e.coordination_id)).not.toContain(a.coordinationId);
  });

  it("ORG COMES FROM THE SESSION, NEVER THE REQUEST — a client ?org_id is ignored (demonstration 7)", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const a = await seedCoordination({ orgId: orgA, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    const b = await seedCoordination({ orgId: orgB, reviewAuditId: crypto.randomUUID(), divergentTrade: true });

    // The session is org A; the attacker appends ?org_id=<orgB> to try to read org B's worklist.
    const { status, body } = await httpGet(orgA, `?view=prioritised&org_id=${orgB}`);

    expect(status).toBe(200);
    // The page is org A's, and ONLY org A's — the client-supplied org_id had no effect.
    expect(body.items?.map((e) => e.coordination_id)).toEqual([a.coordinationId]);
    expect(body.items?.every((e) => e.org_id === orgA)).toBe(true);
    expect(body.items?.map((e) => e.coordination_id)).not.toContain(b.coordinationId);
  });

  it("a MALFORMED query is a 400 before any read (demonstration 8)", async () => {
    const orgId = crypto.randomUUID();
    const { status, body } = await httpGet(orgId, "?view=not-a-real-view");
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
  });
});

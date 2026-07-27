import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit proof for the `ctx.comms` SDK facet (server/sdk/comms.ts)
 * (CEO Directive #014 / D-04, Phase A; ADR 0008; Bible Volume XIII §12).
 *
 * The facet BINDS the already-built Communication Layer — `deliverDraft` + the read
 * surfaces (ADR 0003) — to one run's trace. It re-implements NOTHING, so here we mock
 * the SERVICE MODULE itself and pin exactly what the thin facet adds:
 *
 *   - send threads the run's correlationId onto the delivery, and a per-call override
 *     wins; from / replyTo overrides pass through;
 *   - send returns the persisted communication row on success;
 *   - the THROW-BASED ABI: a refused or failed delivery ({ ok:false }) becomes a thrown
 *     Error — so the Task Engine records the run as a failure rather than swallowing it.
 *     This covers the approval-not-approved refusal (the load-bearing property: the
 *     Approval Engine + the DB trigger are the boundary; the facet surfaces the refusal);
 *   - the read surfaces (get / listForDraft / listForSubject) delegate unchanged;
 *   - the bound identity is frozen.
 */

const { deliverDraftMock, getCommunicationMock, listForDraftMock, listForSubjectMock } = vi.hoisted(
  () => ({
    deliverDraftMock: vi.fn(),
    getCommunicationMock: vi.fn(),
    listForDraftMock: vi.fn(),
    listForSubjectMock: vi.fn(),
  }),
);

vi.mock("@/server/services/hq-comms", () => ({
  deliverDraft: deliverDraftMock,
  getCommunication: getCommunicationMock,
  listCommunicationsForDraft: listForDraftMock,
  listCommunicationsForSubject: listForSubjectMock,
}));

import { createComms } from "@/server/sdk/comms";

const CORR = "corr-run-1";

/** A delivery row stub (only the fields these tests read). */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "comm-1",
    draft_id: "draft-1",
    approval_id: "appr-1",
    correlation_id: CORR,
    status: "sent",
    ...over,
  };
}

/** The first argument deliverDraft was called with. */
function deliverInput(): Record<string, unknown> {
  return deliverDraftMock.mock.calls[0]![0] as Record<string, unknown>;
}

beforeEach(() => {
  deliverDraftMock.mockReset();
  getCommunicationMock.mockReset();
  listForDraftMock.mockReset();
  listForSubjectMock.mockReset();
});

// ---------------------------------------------------------------------
// send — correlation threading + success
// ---------------------------------------------------------------------

describe("ctx.comms.send — approval-gated delivery, correlation-threaded", () => {
  it("threads the run's correlationId onto the delivery and returns the row on success", async () => {
    deliverDraftMock.mockResolvedValue({ ok: true, communication: row() });
    const comms = createComms({ slug: "sales-ai" }, CORR);

    const out = await comms.send({ draftId: "draft-1", approvalId: "appr-1", to: "x@acme.com" });

    expect(out).toMatchObject({ id: "comm-1" });
    expect(deliverDraftMock).toHaveBeenCalledTimes(1);
    expect(deliverInput()).toMatchObject({
      draftId: "draft-1",
      approvalId: "appr-1",
      to: "x@acme.com",
      correlationId: CORR,
    });
  });

  it("lets a per-call correlationId override the run's trace", async () => {
    deliverDraftMock.mockResolvedValue({ ok: true, communication: row() });
    const comms = createComms({ slug: "sales-ai" }, CORR);
    await comms.send({ draftId: "d", approvalId: "a", to: "x@acme.com", correlationId: "other" });
    expect(deliverInput().correlationId).toBe("other");
  });

  it("forwards optional from / replyTo overrides", async () => {
    deliverDraftMock.mockResolvedValue({ ok: true, communication: row() });
    const comms = createComms({ slug: "sales-ai" }, CORR);
    await comms.send({
      draftId: "d",
      approvalId: "a",
      to: "x@acme.com",
      from: "me@hq",
      replyTo: "reply@hq",
    });
    const input = deliverInput();
    expect(input.from).toBe("me@hq");
    expect(input.replyTo).toBe("reply@hq");
  });
});

// ---------------------------------------------------------------------
// send — throw-based ABI
// ---------------------------------------------------------------------

describe("ctx.comms.send — throw-based ABI (a refusal/failure becomes a thrown Error)", () => {
  it("THROWS when the delivery is refused because the approval is not approved", async () => {
    deliverDraftMock.mockResolvedValue({ ok: false, error: "not_approved" });
    const comms = createComms({ slug: "sales-ai" }, CORR);
    await expect(
      comms.send({ draftId: "d", approvalId: "a", to: "x@acme.com" }),
    ).rejects.toThrow(/comms\.send failed: not_approved/);
  });

  it("THROWS on any failed delivery so the runner records a failure (never swallows it)", async () => {
    deliverDraftMock.mockResolvedValue({ ok: false, error: "no_provider" });
    const comms = createComms({ slug: "sales-ai" }, CORR);
    await expect(
      comms.send({ draftId: "d", approvalId: "a", to: "x@acme.com" }),
    ).rejects.toThrow(/comms\.send failed: no_provider/);
  });
});

// ---------------------------------------------------------------------
// read surfaces — thin delegation
// ---------------------------------------------------------------------

describe("ctx.comms read surfaces — thin delegation to the service", () => {
  it("get(id) delegates to getCommunication", async () => {
    getCommunicationMock.mockResolvedValue(row({ id: "comm-9" }));
    const comms = createComms({ slug: "sales-ai" }, CORR);
    const out = await comms.get("comm-9");
    expect(out).toMatchObject({ id: "comm-9" });
    expect(getCommunicationMock).toHaveBeenCalledWith("comm-9");
  });

  it("listForDraft delegates draftId + limit", async () => {
    listForDraftMock.mockResolvedValue([row()]);
    const comms = createComms({ slug: "sales-ai" }, CORR);
    await comms.listForDraft("draft-1", 5);
    expect(listForDraftMock).toHaveBeenCalledWith("draft-1", 5);
  });

  it("listForSubject delegates subjectType + subjectId + limit", async () => {
    listForSubjectMock.mockResolvedValue([row()]);
    const comms = createComms({ slug: "sales-ai" }, CORR);
    await comms.listForSubject("lead", "lead-9", 3);
    expect(listForSubjectMock).toHaveBeenCalledWith("lead", "lead-9", 3);
  });
});

// ---------------------------------------------------------------------
// identity immutability
// ---------------------------------------------------------------------

describe("ctx.comms — identity is frozen", () => {
  it("exposes a frozen copy of the bound identity", () => {
    const comms = createComms({ slug: "sales-ai" }, CORR);
    expect(comms.identity.slug).toBe("sales-ai");
    expect(Object.isFrozen(comms.identity)).toBe(true);
    expect(() => {
      (comms.identity as { slug: string }).slug = "evil-ai";
    }).toThrow();
  });
});

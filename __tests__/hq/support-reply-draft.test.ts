import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * P13 — Support AI reply capability: the governed DARK draft-reply seam.
 *
 * Pinned:
 *   1. THE DETERMINISTIC COMPOSER (pure): the acknowledgement references the
 *      ticket's REAL fields — number, subject, category, priority, status,
 *      latest customer-message date — and invents nothing (no diagnosis, no
 *      timeline, no promise beyond "the team is reviewing").
 *   2. DARK BY DEFAULT: with no mid tier bound, draftSupportReply completes
 *      with provenance 'deterministic' and NEVER opens the provider door or
 *      reaches the governor.
 *   3. NEVER AUTO-SENT: the artifact carries `neverSent: true`, and — source
 *      level, comments stripped — the service imports no transport and never
 *      writes support_messages. (The companion security suite pins the same
 *      boundary on the admin action.)
 */

const { detailMock, tierMock, providerMock, governorMock } = vi.hoisted(() => ({
  detailMock: vi.fn(),
  tierMock: vi.fn(),
  providerMock: vi.fn(),
  governorMock: vi.fn(),
}));

vi.mock("@/server/services/hq-support-snapshot", () => ({
  listSupportTicketRowsForHq: vi.fn(),
  loadSupportTicketDetailForHq: detailMock,
}));
vi.mock("@/lib/ai/text", () => ({ getTextProvider: providerMock }));
vi.mock("@/lib/ai/governor", () => ({
  invokeWithGovernor: governorMock,
  isTierActivated: tierMock,
}));
vi.mock("@/lib/ai/governor/attribution", () => ({
  hqBudgetOrgId: () => "hq-org-1",
}));
// Import-safety: narrative helper / runner SDK / auth pulls.
vi.mock("@/server/services/hq-narrative", () => ({
  generateHqBoardNarrative: async () => null,
}));
vi.mock("@/lib/ai/embeddings", () => ({ getEmbeddingProvider: vi.fn() }));
vi.mock("@/server/auth/hq", () => ({ requireHqPage: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: vi.fn(), from: vi.fn() }),
}));

import {
  composeSupportReplyDraft,
  draftSupportReply,
  type SupportReplyDraftInput,
} from "@/server/services/hq-support-ai";

function input(over: Partial<SupportReplyDraftInput> = {}): SupportReplyDraftInput {
  return {
    ticketNumber: 42,
    subject: "Cannot export payroll CSV",
    status: "open",
    priority: "high",
    category: "bug",
    orgName: "Acme Construction",
    ownerName: "Jane",
    lastCustomerMessageAt: "2026-08-28T10:00:00.000Z",
    ...over,
  };
}

function detailOf() {
  return {
    id: "ticket-1",
    ticket_number: 42,
    subject: "Cannot export payroll CSV",
    status: "open",
    priority: "high",
    category: "bug",
    org_id: "org-1",
    org_name: "Acme Construction",
    owner_name: "Jane",
    owner_email: "jane@acme.test",
    created_at: "2026-08-27T09:00:00.000Z",
    messages: [
      {
        id: "m1",
        author_kind: "customer",
        internal: false,
        body: "It fails every time.",
        created_at: "2026-08-28T10:00:00.000Z",
      },
      {
        id: "m2",
        author_kind: "hq",
        internal: true,
        body: "internal note",
        created_at: "2026-08-28T11:00:00.000Z",
      },
    ],
  };
}

beforeEach(() => {
  detailMock.mockReset();
  tierMock.mockReset().mockReturnValue(false); // DARK by default
  providerMock.mockReset().mockReturnValue(null);
  governorMock.mockReset();
});

describe("composeSupportReplyDraft — deterministic, real fields only", () => {
  it("references the ticket's real number, subject, category, priority, status and last message date", () => {
    const body = composeSupportReplyDraft(input());
    expect(body).toMatch(/Hi Jane,/);
    expect(body).toMatch(/"Cannot export payroll CSV" \(ticket #42\)/);
    expect(body).toMatch(/latest message from 2026-08-28/);
    expect(body).toMatch(/bug request at high priority/i);
    expect(body).toMatch(/current status is open/);
    // The honest boundary: review promised, nothing else.
    expect(body).toMatch(/reviewing it and will reply/);
    expect(body).not.toMatch(/fixed|resolved|within \d+|refund/i);
  });

  it("degrades gracefully without an owner name or customer message", () => {
    const body = composeSupportReplyDraft(
      input({ ownerName: null, lastCustomerMessageAt: null }),
    );
    expect(body).toMatch(/^Hi,/);
    expect(body).toMatch(/Your ticket is with the team now\./);
  });

  it("is pure: same input → identical draft", () => {
    expect(composeSupportReplyDraft(input())).toBe(composeSupportReplyDraft(input()));
  });
});

describe("draftSupportReply — dark by default, honest provenance, never sent", () => {
  it("with no mid tier bound: deterministic artifact, door and governor untouched", async () => {
    detailMock.mockResolvedValue(detailOf());
    const artifact = await draftSupportReply("ticket-1");
    expect(artifact).not.toBeNull();
    expect(artifact!.provenance).toBe("deterministic");
    expect(artifact!.model).toBeNull();
    expect(artifact!.ticketNumber).toBe(42);
    expect(artifact!.body).toMatch(/ticket #42/);
    expect(artifact!.neverSent).toBe(true);
    // DARK: the own-tier gate refused BEFORE the door — no provider resolved,
    // no governed invocation attempted.
    expect(providerMock).not.toHaveBeenCalled();
    expect(governorMock).not.toHaveBeenCalled();
  });

  it("tier bound but governor refuses (blocked) → deterministic fallback stands", async () => {
    detailMock.mockResolvedValue(detailOf());
    tierMock.mockReturnValue(true);
    providerMock.mockReturnValue({
      info: { provider: "anthropic" },
      generate: vi.fn(),
    });
    governorMock.mockResolvedValue({ status: "blocked", reason: "budget" });
    const artifact = await draftSupportReply("ticket-1");
    expect(artifact!.provenance).toBe("deterministic");
    expect(governorMock).toHaveBeenCalledTimes(1);
    // Under the registered hq.draft key, drafting class.
    expect(governorMock.mock.calls[0]![0]).toBe("hq.draft");
    expect(governorMock.mock.calls[0]![1]).toBe("drafting");
  });

  it("governed leg runs → model body with honest model provenance", async () => {
    detailMock.mockResolvedValue(detailOf());
    tierMock.mockReturnValue(true);
    providerMock.mockReturnValue({
      info: { provider: "anthropic" },
      generate: vi.fn(),
    });
    governorMock.mockResolvedValue({
      status: "ran",
      value: { text: "Warm generated reply.", model: "claude-x", inputTokens: 1, outputTokens: 2 },
      budget: {},
      recorded: true,
      dark: false,
    });
    const artifact = await draftSupportReply("ticket-1");
    expect(artifact!.provenance).toBe("anthropic");
    expect(artifact!.model).toBe("claude-x");
    expect(artifact!.body).toBe("Warm generated reply.");
    expect(artifact!.neverSent).toBe(true);
  });

  it("unknown ticket → null (the handler turns this into a non-retryable failure)", async () => {
    detailMock.mockResolvedValue(null);
    expect(await draftSupportReply("missing")).toBeNull();
  });
});

describe("NEVER auto-send — source pins (comments stripped)", () => {
  const ROOT = resolve(__dirname, "..", "..");
  const codeOf = (p: string) =>
    readFileSync(resolve(ROOT, p), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("the service imports no transport and never writes the customer thread", () => {
    const code = codeOf("server/services/hq-support-ai.ts");
    expect(code).not.toMatch(/resend|nodemailer|smtp|sendEmail|deliverDraft/i);
    expect(code).not.toMatch(/from\(\s*["'`]support_messages/);
    expect(code).not.toMatch(/\breplyAsHq\b/);
    expect(code).toMatch(/neverSent: true/);
  });

  it("the admin generate action enqueues + drains + audits — and never replies", () => {
    const code = codeOf("app/admin/support/actions.ts");
    const fn = code.slice(code.indexOf("export async function generateSupportReplyDraft"));
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).toMatch(/enqueueSupportReplyDraft\(/);
    expect(fn).toMatch(/runSupportReplyDraftTask\(/);
    expect(fn).not.toMatch(/replyAsHq\s*\(/);
    expect(fn).not.toMatch(/support_messages/);
    expect(fn).not.toMatch(/emitNotifications\s*\(/);
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EVAL_CASES, mockQuoteModel } from "../ai/quote-writer-corpus";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AI QUOTE WRITER — THE HUMAN-APPROVAL / NO-AUTO-SEND INVARIANT, BEHAVIOURALLY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `__tests__/security/ai-quote-writer.test.ts` proves the no-send and
 * management-gate invariants by PINNING SOURCE TEXT — necessary while the
 * feature is dark, but a regex cannot watch the pipeline actually run. This
 * suite drives `generateQuoteDraft` / `applyQuoteDraft` / `discardQuoteDraft`
 * END TO END with:
 *
 *   • the injectable model seam (`deps.model`, the one the eval harness uses)
 *     carrying a canned response — so no provider is reached;
 *   • the REAL governor, left genuinely dark (no tier credential in this env),
 *     so the one invocation runs exactly as it does in production today;
 *   • a mock Supabase that ALLOWS the context reads but THROWS on any write to a
 *     commercial table (quotes / invoices / jobs / leads / quote_line_items /
 *     customers) — so "the model can't reach a customer" is enforced by the
 *     test harness, not merely asserted.
 *
 * The behaviours proven:
 *   1. A valid generation produces an EDITABLE DRAFT (`status: created`, line
 *      items handed back) and stores a row whose status is `draft` — never a
 *      quote lifecycle status, never a send.
 *   2. A compromised / malformed model reply is REFUSED and NOTHING is stored.
 *   3. Applying is a SEPARATE, HUMAN step that RE-VALIDATES the operator's edit
 *      and only flips a draft-table status — it creates no quote.
 *   4. Discarding is a status change, not a delete.
 *   5. A `staff` caller is refused before a model is reached or a row is read.
 *   6. The one model call is routed through the governor as the registered
 *      `quote.writer_draft` drafting feature.
 */

// ── The mock boundary ───────────────────────────────────────────────────────

const H = vi.hoisted(() => ({
  role: "owner" as string,
  writes: [] as Array<{ table: string; op: string; row: Record<string, unknown> }>,
  cfg: {
    single: {} as Record<string, unknown>,
    list: {} as Record<string, unknown[]>,
  },
}));

const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";

/** Writes to these are a model reaching a commercial record — forbidden. */
const FORBIDDEN_WRITE = new Set([
  "quotes",
  "quote_line_items",
  "invoices",
  "jobs",
  "leads",
  "customers",
]);

function guardWrite(table: string) {
  if (FORBIDDEN_WRITE.has(table)) {
    throw new Error(`FORBIDDEN WRITE: the quote writer attempted to write to ${table}`);
  }
}

class SelectBuilder {
  constructor(private table: string) {}
  eq() {
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  async maybeSingle() {
    return { data: H.cfg.single[this.table] ?? null, error: null };
  }
  // Thenable: readPriceBook awaits the builder directly.
  then(onF: (v: { data: unknown[]; error: null }) => unknown, onR?: (e: unknown) => unknown) {
    return Promise.resolve({ data: H.cfg.list[this.table] ?? [], error: null }).then(onF, onR);
  }
}

class UpdateBuilder {
  constructor(private table: string) {}
  eq() {
    return this;
  }
  select() {
    return this;
  }
  async maybeSingle() {
    return { data: { id: "draft-1" }, error: null };
  }
}

function makeClient() {
  return {
    from(table: string) {
      return {
        select: () => new SelectBuilder(table),
        insert: (row: Record<string, unknown>) => {
          guardWrite(table);
          H.writes.push({ table, op: "insert", row });
          return {
            select: () => ({ single: async () => ({ data: { id: "draft-1" }, error: null }) }),
          };
        },
        update: (row: Record<string, unknown>) => {
          guardWrite(table);
          H.writes.push({ table, op: "update", row });
          return new UpdateBuilder(table);
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => makeClient(),
}));

vi.mock("@/server/auth/session", () => ({
  requireOrgContext: async () => ({
    ctx: { org: { id: ORG }, membership: { org_id: ORG, role: H.role } },
    user: { id: USER },
  }),
  // Faithful to the real helper: redirect (here, throw) for non-management.
  requireManagementRole: (ctx: { membership: { role: string | null } }) => {
    const r = ctx.membership.role;
    if (r !== "owner" && r !== "admin") {
      throw new Error("NEXT_REDIRECT:/dashboard?error=forbidden");
    }
  },
}));

vi.mock("@/lib/analytics/events", () => ({
  trackEvent: vi.fn(),
  ANALYTICS_EVENTS: { AI_DRAFT_CREATED: "ai_draft_created" },
}));

import {
  generateQuoteDraft,
  applyQuoteDraft,
  discardQuoteDraft,
} from "@/server/services/ai-quote-writer";
import * as governor from "@/lib/ai/governor";
import { QUOTE_WRITER_FEATURE } from "@/lib/ai/quote-writer-readiness";

// ── Fixtures ────────────────────────────────────────────────────────────────

const evalCase = (id: string) => {
  const c = EVAL_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`eval case ${id} not found`);
  return c;
};
const VALID_RESPONSE = evalCase("bathroom_reno").response;
const COMPROMISED_RESPONSE = evalCase("compromised_quote_one_pound").response;
const MALFORMED_RESPONSE = evalCase("malformed_not_json").response;

function seedContextReads() {
  H.cfg.single = {
    leads: {
      id: "lead-1",
      notes: "Full bathroom refit — strip out, retile, new vanity.",
      service: "bathroom",
      postcode: "SW1A 1AA",
      property_id: "prop-1",
    },
    properties: { id: "prop-1", notes: "Rear access only." },
    ai_receptionist_setups: { trade_type: "bathroom fitting" },
    // apply / discard read the draft row back:
    ai_quote_drafts: { id: "draft-1", status: "draft" },
  };
  H.cfg.list = {
    quote_line_items: [
      { description: "Supply and fit 600mm vanity unit", unit: "ea", unit_price: 240.0, quote_id: "q9" },
    ],
  };
}

beforeEach(() => {
  H.role = "owner";
  H.writes.length = 0;
  H.cfg.single = {};
  H.cfg.list = {};
  seedContextReads();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

// =====================================================================
// 1. A valid generation is an editable DRAFT, stored as a draft.
// =====================================================================

describe("generateQuoteDraft produces an editable draft, never a sent quote", () => {
  it("returns an editable draft with line items and stores status 'draft'", async () => {
    const mock = mockQuoteModel(VALID_RESPONSE);
    const outcome = await generateQuoteDraft({ leadId: "lead-1" }, { model: mock.model });

    expect(outcome.status).toBe("created");
    if (outcome.status !== "created") throw new Error("unreachable");
    // The operator is handed something to EDIT — a draft plus line items — not a
    // committed quote.
    expect(outcome.draft.line_items.length).toBeGreaterThan(0);
    expect(Array.isArray(outcome.lineItems)).toBe(true);
    expect(outcome.lineItems.length).toBeGreaterThan(0);

    // Exactly one row was written, to the DRAFT table, with a DRAFT status.
    expect(H.writes).toHaveLength(1);
    const write = H.writes[0]!;
    expect(write.table).toBe("ai_quote_drafts");
    expect(write.op).toBe("insert");
    expect(write.row.status).toBe("draft");
    expect(write.row.org_id).toBe(ORG);
    // Provenance is a real vendor — there is no deterministic fallback here.
    expect(write.row.provenance).toBe("anthropic");
    // A quote lifecycle status is never set.
    for (const forbidden of ["sent", "approved", "pending_approval", "accepted"]) {
      expect(write.row.status).not.toBe(forbidden);
    }
  });

  it("the model call is routed through the governor as the drafting feature", async () => {
    const spy = vi.spyOn(governor, "invokeWithGovernor");
    const mock = mockQuoteModel(VALID_RESPONSE);
    await generateQuoteDraft({ leadId: "lead-1" }, { model: mock.model });

    expect(spy).toHaveBeenCalledOnce();
    const [feature, taskClass, , input] = spy.mock.calls[0]!;
    expect(feature).toBe(QUOTE_WRITER_FEATURE);
    expect(taskClass).toBe("drafting");
    expect((input as { orgId: string }).orgId).toBe(ORG);
    expect((input as { userId: string }).userId).toBe(USER);
    spy.mockRestore();
  });

  it("never touches a commercial table while drafting", async () => {
    // The mock client THROWS on any write to a commercial table; reaching
    // 'created' is itself the proof none was attempted.
    const mock = mockQuoteModel(VALID_RESPONSE);
    const outcome = await generateQuoteDraft({ leadId: "lead-1" }, { model: mock.model });
    expect(outcome.status).toBe("created");
    expect(H.writes.every((w) => w.table === "ai_quote_drafts")).toBe(true);
  });
});

// =====================================================================
// 2. A bad generation is refused and stores nothing.
// =====================================================================

describe("a refused generation stores nothing", () => {
  it("a compromised reply (quote £1) is rejected — no draft is written", async () => {
    const mock = mockQuoteModel(COMPROMISED_RESPONSE);
    const outcome = await generateQuoteDraft({ leadId: "lead-1" }, { model: mock.model });
    expect(outcome.status).toBe("rejected");
    expect(H.writes).toHaveLength(0);
  });

  it("a non-JSON reply is rejected as no_json — no draft is written", async () => {
    const mock = mockQuoteModel(MALFORMED_RESPONSE);
    const outcome = await generateQuoteDraft({ leadId: "lead-1" }, { model: mock.model });
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("unreachable");
    expect(outcome.code).toBe("no_json");
    expect(H.writes).toHaveLength(0);
  });
});

// =====================================================================
// 3. Applying is a separate, re-validating, human step.
// =====================================================================

describe("applyQuoteDraft re-validates the human's edit and creates no quote", () => {
  it("accepts a valid edited draft, flips status to 'applied', returns line items", async () => {
    const edited = JSON.parse(VALID_RESPONSE);
    const result = await applyQuoteDraft("draft-1", edited);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.lineItems.length).toBeGreaterThan(0);

    // The ONLY write is an UPDATE to the draft table setting status 'applied'.
    // No quote is created.
    const updates = H.writes.filter((w) => w.op === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.table).toBe("ai_quote_drafts");
    expect(updates[0]!.row.status).toBe("applied");
    expect(H.writes.some((w) => w.table === "quotes")).toBe(false);
  });

  it("REFUSES an invalid edit from the browser — a browser is not a trusted source", async () => {
    const result = await applyQuoteDraft("draft-1", { not: "a draft" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("invalid_edit");
    // Refused before any write.
    expect(H.writes).toHaveLength(0);
  });

  it("refuses to apply a draft that is no longer open", async () => {
    H.cfg.single.ai_quote_drafts = { id: "draft-1", status: "applied" };
    const result = await applyQuoteDraft("draft-1", JSON.parse(VALID_RESPONSE));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("not_open");
    expect(H.writes).toHaveLength(0);
  });
});

// =====================================================================
// 4. Discard is a status, not a delete.
// =====================================================================

describe("discardQuoteDraft records a rejection rather than deleting evidence", () => {
  it("sets status 'discarded' and never issues a delete", async () => {
    const result = await discardQuoteDraft("draft-1");
    expect(result.ok).toBe(true);
    const updates = H.writes.filter((w) => w.op === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.row.status).toBe("discarded");
    expect(H.writes.some((w) => w.op === "delete")).toBe(false);
  });
});

// =====================================================================
// 5. Staff are refused before anything happens.
// =====================================================================

describe("the management boundary is enforced before any work", () => {
  it("a staff caller cannot draft — no model is reached, no row is read", async () => {
    H.role = "staff";
    const mock = mockQuoteModel(VALID_RESPONSE);
    await expect(
      generateQuoteDraft({ leadId: "lead-1" }, { model: mock.model }),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mock.calls).toHaveLength(0);
    expect(H.writes).toHaveLength(0);
  });

  it("a staff caller cannot apply a draft either", async () => {
    H.role = "staff";
    await expect(
      applyQuoteDraft("draft-1", JSON.parse(VALID_RESPONSE)),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(H.writes).toHaveLength(0);
  });
});

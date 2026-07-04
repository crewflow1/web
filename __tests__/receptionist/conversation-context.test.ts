import { describe, it, expect } from "vitest";
import {
  assembleConversationContext,
  resolveEventText,
  roleOf,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
} from "@/lib/receptionist/conversation-context";
import { estimateTokens } from "@/lib/memory/retrieval";
import { detectGap } from "@/lib/receptionist/conversation-gap";
import { resolveStrategy } from "@/lib/receptionist/conversation-strategy";
import { planPrompt } from "@/lib/receptionist/conversation-prompt";
import type {
  ConversationSummary,
  ReconstructedConversation,
  TimelineEvent,
} from "@/server/services/receptionist-conversation-reads";

/**
 * Conversation Context Assembly — the model-ready projection, unit tier
 * (the AI Receptionist Programme, R12 — CONVERSATION CONTEXT ASSEMBLY).
 *
 * R11 proved a conversation reconstructs IDENTICALLY every read. R12 is the pure fold ABOVE that
 * read model: it turns a reconstructed conversation into a deterministic, role-attributed,
 * token-budgeted, model-ready context object — with NO model, NO I/O and NO mutation. These tests
 * pin that pure logic: role attribution, by-reference text resolution, order preservation,
 * byte-identical determinism, verbatim metadata projection, deterministic token budgeting and the
 * recency-tail truncation strategy. The end-to-end assembly over real Postgres (through the R11
 * read model + the server seam) is proven in the integration tier.
 *
 * The token maths here is never hard-coded: it is derived from the SAME estimateTokens primitive
 * the assembler uses (lib/memory/retrieval.ts), so the test asserts the assembler reuses that
 * primitive rather than re-deriving a tokeniser.
 */

// A fully-populated TimelineEvent is wide; a factory fills every field with an inert null and lets
// each case set only the keys it exercises (direction, the resolved-text fields, channel, ids).
function evt(
  message_id: string,
  event_at: string,
  overrides: Partial<TimelineEvent> = {},
): TimelineEvent {
  return {
    message_id,
    conversation_id: "conv-1",
    org_id: "org-1",
    direction: "inbound",
    channel: "sms",
    event_at,
    enquiry_id: null,
    inbound_text: null,
    inbound_caller: null,
    inbound_summary: null,
    inbound_job_type: null,
    inbound_urgency: null,
    inbound_postcode: null,
    inbound_confidence: null,
    inbound_status: null,
    inbound_at: null,
    audit_id: null,
    outbound_employee_slug: null,
    outbound_correlation_id: null,
    outbound_customer_ref: null,
    outbound_draft: null,
    outbound_verdict: null,
    outbound_allowed: null,
    outbound_categories: null,
    outbound_enforcement_reason: null,
    outbound_safe_text: null,
    outbound_audit_at: null,
    transport_id: null,
    transport_status: null,
    transport_provider: null,
    provider_message_id: null,
    transport_failure_reason: null,
    transport_at: null,
    receipt_id: null,
    delivery_status: null,
    delivery_terminal: null,
    delivery_provider_status: null,
    delivery_error_code: null,
    receipt_at: null,
    receipt_count: null,
    ...overrides,
  };
}

const inbound = (id: string, at: string, text: string | null): TimelineEvent =>
  evt(id, at, { direction: "inbound", inbound_text: text });

const outbound = (
  id: string,
  at: string,
  opts: { safe?: string | null; draft?: string | null } = {},
): TimelineEvent =>
  evt(id, at, {
    direction: "outbound",
    outbound_safe_text: opts.safe ?? null,
    outbound_draft: opts.draft ?? null,
  });

function summary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    conversation_id: "conv-1",
    org_id: "org-1",
    employee_slug: "voice-receptionist-ai",
    channel: "sms",
    contact_ref: "+447700900000",
    contact_name: null,
    status: "active",
    runtime_state: "awaiting_customer",
    intent: "unknown",
    goal: "undetermined",
    information: {},
    gap: detectGap("undetermined", {}),
    strategy: resolveStrategy(detectGap("undetermined", {})),
    prompt_plan: planPrompt(resolveStrategy(detectGap("undetermined", {}))),
    message_count: 0,
    first_message_at: "2026-01-01T10:00:00.000Z",
    last_message_at: "2026-01-01T10:00:00.000Z",
    created_at: "2026-01-01T10:00:00.000Z",
    updated_at: "2026-01-01T10:00:00.000Z",
    last_direction: "inbound",
    last_event_at: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}

function reconstructed(
  timeline: TimelineEvent[],
  convOverrides: Partial<ConversationSummary> = {},
): ReconstructedConversation {
  return { conversation: summary(convOverrides), timeline };
}

/** The assembler renders each turn as `${role}: ${text}` and costs it with estimateTokens; a test
 *  helper derives the SAME cost from the SAME primitive so no token count is ever hard-coded. */
const turnTokens = (role: string, text: string): number => estimateTokens(`${role}: ${text}`);

describe("roleOf — inbound is the customer, outbound is the assistant", () => {
  it("attributes an inbound event to the customer", () => {
    expect(roleOf(inbound("m-1", "2026-01-01T10:00:00.000Z", "hi"))).toBe("customer");
  });
  it("attributes an outbound event to the assistant", () => {
    expect(roleOf(outbound("m-1", "2026-01-01T10:00:00.000Z", { safe: "hello" }))).toBe(
      "assistant",
    );
  });
});

describe("resolveEventText — authoritative text resolved BY REFERENCE, never copied", () => {
  it("surfaces the customer's message for an inbound event", () => {
    expect(resolveEventText(inbound("m-1", "2026-01-01T10:00:00.000Z", "need a plumber"))).toBe(
      "need a plumber",
    );
  });
  it("prefers the guardrail-safe reply over the raw draft for an outbound event", () => {
    expect(
      resolveEventText(outbound("m-1", "2026-01-01T10:00:00.000Z", { safe: "SAFE", draft: "DRAFT" })),
    ).toBe("SAFE");
  });
  it("falls back to the raw draft when no safe text was enforced", () => {
    expect(
      resolveEventText(outbound("m-1", "2026-01-01T10:00:00.000Z", { safe: null, draft: "DRAFT" })),
    ).toBe("DRAFT");
  });
  it("resolves to empty string (still renderable) when the referenced content is absent", () => {
    expect(resolveEventText(outbound("m-1", "2026-01-01T10:00:00.000Z", {}))).toBe("");
    expect(resolveEventText(inbound("m-1", "2026-01-01T10:00:00.000Z", null))).toBe("");
  });
});

describe("assembleConversationContext — ordered, role-attributed projection", () => {
  it("projects the timeline into role-attributed turns, PRESERVING R11's order", () => {
    const ctx = assembleConversationContext(
      reconstructed([
        inbound("m-1", "2026-01-01T10:00:00.000Z", "Hi, my boiler is broken"),
        outbound("m-2", "2026-01-01T10:00:05.000Z", { safe: "Thanks — we'll be in touch." }),
        inbound("m-3", "2026-01-01T10:00:10.000Z", "How soon?"),
      ]),
    );
    expect(ctx.messages.map((m) => [m.message_id, m.role, m.text])).toEqual([
      ["m-1", "customer", "Hi, my boiler is broken"],
      ["m-2", "assistant", "Thanks — we'll be in touch."],
      ["m-3", "customer", "How soon?"],
    ]);
  });

  it("renders a deterministic, role-tagged transcript string", () => {
    const ctx = assembleConversationContext(
      reconstructed([
        inbound("m-1", "2026-01-01T10:00:00.000Z", "Hi"),
        outbound("m-2", "2026-01-01T10:00:05.000Z", { safe: "Hello" }),
      ]),
    );
    expect(ctx.text).toBe("customer: Hi\nassistant: Hello");
  });

  it("carries each turn's channel, instant and token cost onto the ContextMessage", () => {
    const ctx = assembleConversationContext(
      reconstructed([
        evt("m-1", "2026-01-01T10:00:00.000Z", {
          direction: "inbound",
          inbound_text: "hello there",
          channel: "whatsapp",
        }),
      ]),
    );
    const only = ctx.messages[0]!;
    expect(only.channel).toBe("whatsapp");
    expect(only.event_at).toBe("2026-01-01T10:00:00.000Z");
    expect(only.tokens).toBe(turnTokens("customer", "hello there"));
  });
});

describe("assembleConversationContext — metadata projected VERBATIM (assembler recomputes none)", () => {
  it("projects conversation + contact metadata straight off the R11 summary", () => {
    const ctx = assembleConversationContext(
      reconstructed(
        [inbound("m-1", "2026-01-01T10:00:00.000Z", "hi")],
        {
          conversation_id: "conv-9",
          org_id: "org-9",
          employee_slug: "voice-receptionist-ai",
          channel: "sms",
          status: "active",
          message_count: 7,
          first_message_at: "2026-01-01T09:00:00.000Z",
          last_message_at: "2026-01-01T10:00:00.000Z",
          last_direction: "outbound",
          contact_ref: "+447700900123",
          contact_name: "Alex Smith",
        },
      ),
    );
    expect(ctx.conversation).toEqual({
      conversation_id: "conv-9",
      org_id: "org-9",
      employee_slug: "voice-receptionist-ai",
      channel: "sms",
      status: "active",
      message_count: 7,
      first_message_at: "2026-01-01T09:00:00.000Z",
      last_message_at: "2026-01-01T10:00:00.000Z",
      last_direction: "outbound",
    });
    expect(ctx.contact).toEqual({ contact_ref: "+447700900123", contact_name: "Alex Smith" });
  });

  it("keeps the summary field a null placeholder — R12 GENERATES nothing", () => {
    const ctx = assembleConversationContext(
      reconstructed([inbound("m-1", "2026-01-01T10:00:00.000Z", "hi")]),
    );
    expect(ctx.summary).toBeNull();
  });
});

describe("assembleConversationContext — determinism and non-mutation", () => {
  it("is byte-identical across repeated assembly of the same conversation", () => {
    const input = reconstructed([
      inbound("m-1", "2026-01-01T10:00:00.000Z", "Hi"),
      outbound("m-2", "2026-01-01T10:00:05.000Z", { safe: "Hello" }),
      inbound("m-3", "2026-01-01T10:00:10.000Z", "When?"),
    ]);
    const a = assembleConversationContext(input);
    const b = assembleConversationContext(input);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("does NOT mutate its input timeline", () => {
    const timeline = [
      inbound("m-1", "2026-01-01T10:00:00.000Z", "Hi"),
      outbound("m-2", "2026-01-01T10:00:05.000Z", { safe: "Hello" }),
    ];
    const before = timeline.map((e) => e.message_id);
    assembleConversationContext(reconstructed(timeline));
    expect(timeline.map((e) => e.message_id)).toEqual(before);
  });

  it("uses the fixed default token budget when no options are supplied", () => {
    const ctx = assembleConversationContext(
      reconstructed([inbound("m-1", "2026-01-01T10:00:00.000Z", "hi")]),
    );
    expect(ctx.budget.budget).toBe(DEFAULT_CONTEXT_TOKEN_BUDGET);
  });
});

describe("assembleConversationContext — deterministic token budgeting + recency-tail truncation", () => {
  it("accounts the full transcript when everything fits the budget", () => {
    const ctx = assembleConversationContext(
      reconstructed([
        inbound("m-1", "2026-01-01T10:00:00.000Z", "Hi"),
        outbound("m-2", "2026-01-01T10:00:05.000Z", { safe: "Hello" }),
      ]),
    );
    const expected = turnTokens("customer", "Hi") + turnTokens("assistant", "Hello");
    expect(ctx.budget.tokens_used).toBe(expected);
    expect(ctx.budget.within_budget).toBe(true);
    expect(ctx.boundaries).toEqual({
      total_message_count: 2,
      included_message_count: 2,
      omitted_message_count: 0,
      included_from: "2026-01-01T10:00:00.000Z",
      included_to: "2026-01-01T10:00:05.000Z",
      truncated: false,
    });
    expect(ctx.elision).toBeNull();
  });

  it("drops the OLDEST turns and keeps the newest contiguous suffix that fits", () => {
    // Three inbound turns of 30-char text → each renders to "customer: " + 30 = 40 chars = 10
    // tokens. A 20-token budget keeps the two newest and drops the single oldest.
    const text = "a".repeat(30);
    const ctx = assembleConversationContext(
      reconstructed([
        inbound("m-1", "2026-01-01T10:00:00.000Z", text),
        inbound("m-2", "2026-01-01T10:00:05.000Z", text),
        inbound("m-3", "2026-01-01T10:00:10.000Z", text),
      ]),
      { token_budget: turnTokens("customer", text) * 2 },
    );
    expect(ctx.messages.map((m) => m.message_id)).toEqual(["m-2", "m-3"]);
    expect(ctx.boundaries).toEqual({
      total_message_count: 3,
      included_message_count: 2,
      omitted_message_count: 1,
      included_from: "2026-01-01T10:00:05.000Z",
      included_to: "2026-01-01T10:00:10.000Z",
      truncated: true,
    });
    expect(ctx.elision).toBe("[1 earlier message omitted]");
    expect(ctx.text.startsWith("[1 earlier message omitted]\n")).toBe(true);
    expect(ctx.budget.tokens_used).toBe(turnTokens("customer", text) * 2);
    expect(ctx.budget.within_budget).toBe(true);
  });

  it("pluralises the elision marker when more than one turn is omitted", () => {
    const text = "a".repeat(30); // 10 tokens each
    const ctx = assembleConversationContext(
      reconstructed([
        inbound("m-1", "2026-01-01T10:00:00.000Z", text),
        inbound("m-2", "2026-01-01T10:00:05.000Z", text),
        inbound("m-3", "2026-01-01T10:00:10.000Z", text),
        inbound("m-4", "2026-01-01T10:00:15.000Z", text),
      ]),
      { token_budget: turnTokens("customer", text) }, // only the single newest turn fits
    );
    expect(ctx.messages.map((m) => m.message_id)).toEqual(["m-4"]);
    expect(ctx.boundaries.omitted_message_count).toBe(3);
    expect(ctx.elision).toBe("[3 earlier messages omitted]");
  });

  it("ALWAYS retains the single latest turn even when it alone exceeds the budget", () => {
    const text = "a".repeat(30); // 10 tokens
    const ctx = assembleConversationContext(
      reconstructed([inbound("m-1", "2026-01-01T10:00:00.000Z", text)]),
      { token_budget: 1 },
    );
    expect(ctx.messages.map((m) => m.message_id)).toEqual(["m-1"]);
    expect(ctx.boundaries.omitted_message_count).toBe(0);
    expect(ctx.boundaries.truncated).toBe(false);
    expect(ctx.elision).toBeNull();
    // The always-in rule can bust the budget — within_budget is the honest signal that it did.
    expect(ctx.budget.tokens_used).toBe(turnTokens("customer", text));
    expect(ctx.budget.within_budget).toBe(false);
  });
});

describe("assembleConversationContext — the empty conversation", () => {
  it("assembles an empty, in-budget context with no turns and an empty transcript", () => {
    const ctx = assembleConversationContext(reconstructed([]));
    expect(ctx.messages).toEqual([]);
    expect(ctx.text).toBe("");
    expect(ctx.elision).toBeNull();
    expect(ctx.boundaries).toEqual({
      total_message_count: 0,
      included_message_count: 0,
      omitted_message_count: 0,
      included_from: null,
      included_to: null,
      truncated: false,
    });
    expect(ctx.budget.tokens_used).toBe(0);
    expect(ctx.budget.within_budget).toBe(true);
  });
});

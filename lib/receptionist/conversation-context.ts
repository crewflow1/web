import { estimateTokens } from "@/lib/memory/retrieval";
import type {
  ConversationSummary,
  ReconstructedConversation,
  TimelineEvent,
} from "@/server/services/receptionist-conversation-reads";

// =====================================================================
// THE CONVERSATION CONTEXT ASSEMBLY LAYER (CEO Directive #018, R12).
//
// R11 gave the canonical READ model: two `security_invoker` projections and a read service that
// reconstruct a conversation's ordered timeline with every message's content resolved. R12 is the
// next layer UP — the SINGLE, shared, deterministic transform that turns that reconstructed
// conversation into a MODEL-READY CONVERSATION CONTEXT: an ordered, role-attributed, token-budgeted
// object that a future AI runtime can drop straight into a reasoning prompt. It is the canonical
// INPUT CONTRACT every future intelligent-conversation capability (reply generation, memory
// injection, human handoff, booking intent) will consume — and no feature may assemble conversation
// context any other way.
//
// IT IS ASSEMBLY, NOT GENERATION. Like lib/receptionist/reply.ts and lib/memory/retrieval.ts, this
// is a PURE, client/server-safe module: NO I/O, no clock, no RNG, and — the cardinal R12 rule — NO
// MODEL. It calls no LLM, drafts no reply, retrieves no memory, and mutates nothing. It only
// PROJECTS and ORDERS what the R11 read model already reconstructed. The same conversation and the
// same options always produce a byte-identical context object (determinism composed from R11's
// deterministic order + this pure fold).
//
// IT DUPLICATES NOTHING. Message bodies are read straight off the R11 timeline event (never copied
// into a second store); the token estimate reuses the memory layer's `estimateTokens` primitive
// (lib/memory/retrieval.ts) rather than re-deriving a tokeniser; and ORDER is R11's job — the
// assembler PRESERVES the timeline's canonical order and never re-sorts, so "the order of a
// conversation" stays defined in exactly one place.
//
// The reconstructed-conversation input type is imported for TYPES ONLY from the R11 read service, so
// this stays a pure library with no runtime dependency on the server-only read layer.
// =====================================================================

/**
 * The role a rendered turn is attributed to: an inbound customer message is `customer`; an
 * outbound AI reply is `assistant`. The union is intentionally left open for a future `system`
 * framing turn — which R12 never emits (it composes no system prompt).
 */
export type ContextRole = "customer" | "assistant";

/**
 * One turn of the model-ready transcript: a single conversation message with its role attributed
 * and its authoritative text RESOLVED (read straight off the R11 timeline event — never a second
 * copy), plus the deterministic token cost of rendering it.
 */
export type ContextMessage = {
  message_id: string;
  role: ContextRole;
  channel: string;
  event_at: string;
  text: string;
  tokens: number;
};

/**
 * Conversation-level metadata carried into the context, projected verbatim from the R11
 * conversation summary — the container remains the single source of counts and timestamps; the
 * assembler recomputes none of them.
 */
export type ContextConversationMeta = {
  conversation_id: string;
  org_id: string;
  employee_slug: string;
  channel: string;
  status: string;
  message_count: number;
  first_message_at: string;
  last_message_at: string;
  last_direction: ConversationSummary["last_direction"];
};

/** Contact identity carried into the context, projected verbatim from the R11 summary. */
export type ContextContactMeta = {
  contact_ref: string;
  contact_name: string | null;
};

/**
 * The explicit window the assembled context spans. When the token budget forces truncation,
 * `included_message_count` < `total_message_count`, `omitted_message_count` names how many oldest
 * turns were dropped, and `truncated` is true.
 */
export type ContextBoundaries = {
  total_message_count: number;
  included_message_count: number;
  omitted_message_count: number;
  included_from: string | null;
  included_to: string | null;
  truncated: boolean;
};

/** The deterministic token accounting for the assembled transcript. */
export type ContextBudget = {
  budget: number;
  tokens_used: number;
  within_budget: boolean;
};

/**
 * THE canonical, model-ready conversation context object — the single input contract every future
 * AI conversation capability consumes. Deterministic: the same reconstructed conversation and the
 * same options always produce an identical object.
 */
export type ConversationContext = {
  conversation: ContextConversationMeta;
  contact: ContextContactMeta;
  /**
   * Reserved placeholder for a future conversation summariser (which would require a model, an
   * explicit R12 non-goal). ALWAYS null in R12 — the assembler generates nothing.
   */
  summary: string | null;
  /**
   * A deterministic, model-free elision marker naming how many oldest turns were dropped to fit
   * the budget (e.g. "[3 earlier messages omitted]"), or null when the whole conversation fit.
   */
  elision: string | null;
  /** The retained turns, oldest → newest, in R11's canonical order. */
  messages: ContextMessage[];
  boundaries: ContextBoundaries;
  budget: ContextBudget;
  /**
   * The rendered, role-tagged transcript — the retained `messages` (with the elision marker first
   * when present) as one deterministic string, ready to drop into a reasoning prompt. Mirrors the
   * memory layer's renderContext({ text, ... }) output contract.
   */
  text: string;
};

/**
 * Options controlling assembly. All optional; every default is fixed, so a call with no options is
 * fully deterministic.
 */
export type AssembleOptions = {
  /** The token ceiling for the assembled transcript. Defaults to DEFAULT_CONTEXT_TOKEN_BUDGET. */
  token_budget?: number;
};

/**
 * The default token ceiling for an assembled context. A placeholder to be tuned per future runtime
 * — R12 calls no model, so this governs only the deterministic truncation maths below.
 */
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 4000;

/** Attribute a timeline event to a transcript role: inbound → customer, outbound → assistant. */
export function roleOf(event: TimelineEvent): ContextRole {
  return event.direction === "outbound" ? "assistant" : "customer";
}

/**
 * Resolve a timeline event's authoritative text WITHOUT copying it — an inbound entry surfaces the
 * customer's message; an outbound entry surfaces the guardrail-safe reply, falling back to the raw
 * draft when the reply was not enforced into a safe form. Returns "" when the referenced content is
 * absent, so a turn is always renderable.
 */
export function resolveEventText(event: TimelineEvent): string {
  if (event.direction === "outbound") {
    return event.outbound_safe_text ?? event.outbound_draft ?? "";
  }
  return event.inbound_text ?? "";
}

/** Render one turn as a single deterministic, role-tagged line. */
function renderTurn(role: ContextRole, text: string): string {
  return `${role}: ${text}`;
}

/**
 * Keep the newest contiguous suffix of turns whose token cost fits `budget`, ALWAYS retaining the
 * single latest turn even when it alone exceeds the budget (the memory knapsack's always-in rule).
 * A conversation reply reasons over the tail, so recency — not a scored subset — is the selection
 * rule; keeping a contiguous block preserves conversational continuity. Pure and deterministic:
 * the same turns + budget always yield the same retained turns, in chronological order.
 */
function selectWithinBudget(
  turns: readonly ContextMessage[],
  budget: number,
): ContextMessage[] {
  if (turns.length === 0) return [];
  const kept: ContextMessage[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    const next = used + turn.tokens;
    if (kept.length === 0 || next <= budget) {
      kept.push(turn);
      used = next;
    } else {
      break; // once the next-oldest turn does not fit, everything older is dropped too
    }
  }
  kept.reverse(); // restore chronological (oldest → newest) order
  return kept;
}

/**
 * Assemble the canonical, model-ready context for a reconstructed conversation. Pure, deterministic
 * and non-mutating: it PROJECTS the R11 timeline into role-attributed, token-costed turns
 * (preserving R11's canonical order), applies the deterministic recency truncation to fit the token
 * budget, and carries the container + contact metadata verbatim. It resolves message text by
 * reference (no second copy), reuses the memory layer's token estimate, and calls no model.
 */
export function assembleConversationContext(
  reconstructed: ReconstructedConversation,
  options: AssembleOptions = {},
): ConversationContext {
  const budget = options.token_budget ?? DEFAULT_CONTEXT_TOKEN_BUDGET;

  // 1. Project every timeline event into a candidate turn, PRESERVING R11's canonical order
  //    (ordering lives in exactly one place — the read model — so the assembler never re-sorts).
  const allTurns: ContextMessage[] = reconstructed.timeline.map((event): ContextMessage => {
    const role = roleOf(event);
    const text = resolveEventText(event);
    return {
      message_id: event.message_id,
      role,
      channel: event.channel,
      event_at: event.event_at,
      text,
      tokens: estimateTokens(renderTurn(role, text)),
    };
  });

  // 2. Deterministic truncation — keep the most recent turns that fit the budget.
  const retained = selectWithinBudget(allTurns, budget);
  const omittedCount = allTurns.length - retained.length;

  // 3. Boundaries + token accounting.
  const tokensUsed = retained.reduce((sum, t) => sum + t.tokens, 0);
  const boundaries: ContextBoundaries = {
    total_message_count: allTurns.length,
    included_message_count: retained.length,
    omitted_message_count: omittedCount,
    included_from: retained[0]?.event_at ?? null,
    included_to: retained[retained.length - 1]?.event_at ?? null,
    truncated: omittedCount > 0,
  };
  const elision =
    omittedCount > 0
      ? `[${omittedCount} earlier message${omittedCount === 1 ? "" : "s"} omitted]`
      : null;

  // 4. Render the transcript — the elision marker first when present, then each retained turn.
  const lines = retained.map((t) => renderTurn(t.role, t.text));
  const text = (elision ? [elision, ...lines] : lines).join("\n");

  // 5. Carry the container + contact metadata verbatim (the container is the single source).
  const c = reconstructed.conversation;
  return {
    conversation: {
      conversation_id: c.conversation_id,
      org_id: c.org_id,
      employee_slug: c.employee_slug,
      channel: c.channel,
      status: c.status,
      message_count: c.message_count,
      first_message_at: c.first_message_at,
      last_message_at: c.last_message_at,
      last_direction: c.last_direction,
    },
    contact: {
      contact_ref: c.contact_ref,
      contact_name: c.contact_name,
    },
    summary: null,
    elision,
    messages: retained,
    boundaries,
    budget: {
      budget,
      tokens_used: tokensUsed,
      within_budget: tokensUsed <= budget,
    },
    text,
  };
}

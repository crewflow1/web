import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Voice Telephony (Wave 8) — the Vapi inbound-voice provider.
 *
 * Vapi delivers JSON server messages and (when a secret is configured) signs the
 * RAW body with an HMAC-SHA256 the receiver recomputes. `verifyVapiSignature`
 * reads VAPI_WEBHOOK_SECRET AT CALL TIME (never the frozen env singleton), fails
 * closed on a missing secret / missing signature / any crypto error, and
 * compares in constant time. `parseVapiWebhook` is pure and never throws.
 *
 * No SDK is imported — verification is stdlib crypto, parsing is JSON.
 */

import {
  isCallEventType,
  type CallEventType,
  type NormalizedInboundCall,
  type VoiceProvider,
} from "../types";

/**
 * Verify a Vapi webhook: HMAC-SHA256 of the raw body under VAPI_WEBHOOK_SECRET,
 * compared to the signature header in constant time. Fails closed on ANY doubt.
 */
export function verifyVapiSignature(input: {
  signature: string | null | undefined;
  rawBody: string;
}): boolean {
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (!secret || !input.signature) return false;
  try {
    const expected = createHmac("sha256", secret).update(input.rawBody, "utf8").digest("hex");
    // Accept a bare hex digest or a `sha256=<hex>` form.
    const provided = input.signature.trim().replace(/^sha256=/i, "");
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(provided, "hex");
    if (a.length !== b.length || a.length === 0) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Map Vapi's status vocabulary onto the neutral event types. */
export function mapVapiStatus(
  rawStatus: string | undefined | null,
  endedReason?: string | undefined | null,
): CallEventType | null {
  const s = (rawStatus ?? "").trim().toLowerCase();
  switch (s) {
    case "queued":
    case "ringing":
      return "ringing";
    case "in-progress":
    case "in_progress":
      return "in_progress";
    case "forwarding":
    case "transferred":
      return "transferred";
    case "ended": {
      const r = (endedReason ?? "").toLowerCase();
      if (r.includes("no-answer") || r.includes("no_answer")) return "no_answer";
      if (r.includes("busy")) return "busy";
      if (r.includes("failed") || r.includes("error")) return "failed";
      if (r.includes("cancel")) return "canceled";
      return "completed";
    }
    default:
      return isCallEventType(s) ? s : null;
  }
}

type VapiToolFunction = { name?: string; arguments?: unknown };
type VapiToolCallRaw = { id?: string; function?: VapiToolFunction };

type VapiBody = {
  message?: {
    type?: string;
    status?: string;
    endedReason?: string;
    timestamp?: string | number;
    transcript?: string;
    /** Newer tool-calls shape. */
    toolCalls?: VapiToolCallRaw[];
    toolCallList?: VapiToolCallRaw[];
    /** Legacy single function-call shape. */
    functionCall?: VapiToolFunction;
    artifact?: { messages?: Array<{ role?: string; message?: string; content?: string }> };
    call?: {
      id?: string;
      customer?: { number?: string };
      phoneNumber?: { number?: string };
    };
    phoneNumber?: { number?: string };
    customer?: { number?: string };
  };
};

/** Read the Vapi server-message `type` from a raw body. Pure; never throws. */
export function readVapiMessageType(rawBody: string): string | null {
  try {
    const body = JSON.parse(rawBody) as VapiBody;
    const t = body?.message?.type;
    return typeof t === "string" && t.trim() ? t.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Extract routing + conversation context from ANY Vapi message (not only status
 * updates): the DIALED number to attribute the org from, the caller, and the
 * caller's latest utterance to feed the governed turn. Pure; null on bad JSON.
 */
export function parseVapiConversation(rawBody: string): {
  /** The Vapi call id — the correlation key for persisting this call's turns. */
  callId: string | null;
  to: string | null;
  from: string | null;
  transcript: string;
} | null {
  let body: VapiBody;
  try {
    body = JSON.parse(rawBody) as VapiBody;
  } catch {
    return null;
  }
  const msg = body?.message;
  if (!msg) return null;

  const call = msg.call;
  const callId = call?.id?.trim() || null;
  const from = (call?.customer?.number ?? msg.customer?.number ?? "").trim() || null;
  const to = (call?.phoneNumber?.number ?? msg.phoneNumber?.number ?? "").trim() || null;

  // Prefer an explicit transcript; else the last user turn in the artifact.
  let transcript = typeof msg.transcript === "string" ? msg.transcript.trim() : "";
  if (!transcript && Array.isArray(msg.artifact?.messages)) {
    for (let i = msg.artifact!.messages!.length - 1; i >= 0; i--) {
      const m = msg.artifact!.messages![i];
      if ((m?.role ?? "").toLowerCase() === "user") {
        transcript = (m?.message ?? m?.content ?? "").toString().trim();
        if (transcript) break;
      }
    }
  }
  return { callId, to, from, transcript };
}

/** One normalised tool/function invocation from a Vapi conversational message. */
export type VapiToolInvocation = { id: string | null; name: string; args: Record<string, unknown> };

/** Extract the tool/function calls from a Vapi tool-calls / function-call body. */
export function extractVapiToolCalls(rawBody: string): VapiToolInvocation[] {
  let body: VapiBody;
  try {
    body = JSON.parse(rawBody) as VapiBody;
  } catch {
    return [];
  }
  const msg = body?.message;
  if (!msg) return [];

  const parseArgs = (raw: unknown): Record<string, unknown> => {
    if (raw && typeof raw === "object") return raw as Record<string, unknown>;
    if (typeof raw === "string" && raw.trim()) {
      try {
        const p = JSON.parse(raw);
        return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    }
    return {};
  };

  const list = msg.toolCalls ?? msg.toolCallList ?? [];
  const fromList: VapiToolInvocation[] = list.map((t) => ({
    id: t?.id?.trim() || null,
    name: (t?.function?.name ?? "").trim(),
    args: parseArgs(t?.function?.arguments),
  }));
  if (fromList.length) return fromList.filter((t) => t.name);

  // Legacy single function-call.
  if (msg.functionCall?.name) {
    return [{ id: null, name: msg.functionCall.name.trim(), args: parseArgs(msg.functionCall.arguments) }];
  }
  return [];
}

/**
 * Resolve the ABSOLUTE, origin-pinned URL Vapi's custom-llm calls for every
 * generated turn. Vapi's `custom-llm` provider REQUIRES `model.url` — an
 * OpenAI-compatible `/chat/completions` endpoint — or the receptionist is mute
 * after its fixed firstMessage. That endpoint is our own governed door
 * (app/api/webhooks/vapi/chat-completions), so the generated turn still routes
 * through `invokeWithGovernor` exactly like the tool-call path.
 *
 * Origin is env-pinned (never a request Host header) — the same posture as the
 * integrations' redirect URIs (lib/integrations/accounting/oauth.ts): an explicit
 * `VAPI_CUSTOM_LLM_URL` override wins, else `NEXT_PUBLIC_APP_URL`, else the prod
 * origin. Read at call time; never throws; always non-empty.
 */
export function resolveVapiCustomLlmUrl(): string {
  const pinned = process.env.VAPI_CUSTOM_LLM_URL?.trim();
  if (pinned) return pinned.replace(/\/+$/, "");
  const origin = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const base = (origin && origin.length > 0 ? origin : "https://crewflow.uk").replace(/\/+$/, "");
  return `${base}/api/webhooks/vapi/chat-completions`;
}

/**
 * Build the assistant configuration Vapi expects in reply to an assistant-request.
 * Vendor-neutral, credential-free, and safe to emit while DARK — it declares the
 * receptionist's model/voice/transcriber and opening line; no live provider call
 * is made here. The generative model itself remains governed at turn time via the
 * custom-llm `model.url` endpoint (below) and `maybeGenerateVoiceTurn`.
 */
export function buildVapiAssistantConfig(opts?: {
  firstMessage?: string;
  systemPrompt?: string;
}): Record<string, unknown> {
  const firstMessage =
    opts?.firstMessage?.trim() || "Thank you for calling. How can I help you today?";
  const systemPrompt =
    opts?.systemPrompt?.trim() ||
    [
      "You are CrewFlow Receptionist, answering a phone call for a UK construction firm.",
      "Reply in ONE or TWO short spoken sentences — plain speech, no markdown, no lists.",
      "Be warm and concise. Never promise prices, never book or schedule work.",
    ].join(" ");
  return {
    assistant: {
      firstMessage,
      model: {
        provider: "custom-llm",
        model: "crewflow-receptionist",
        // The GOVERNED custom-llm endpoint. Without this, custom-llm has nothing to
        // call and the receptionist is mute after firstMessage (the activation gap).
        url: resolveVapiCustomLlmUrl(),
        messages: [{ role: "system", content: systemPrompt }],
      },
      transcriber: { provider: "deepgram", model: "nova-2", language: "en-GB" },
      voice: { provider: "vapi", voiceId: "Elliot" },
    },
  };
}

/** One OpenAI chat message as Vapi's custom-llm delivers it. */
type OpenAiChatMessage = { role?: string; content?: unknown };

/** Coerce OpenAI message content (string OR content-part array) to plain text. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
          ? (p as { text: string }).text
          : "",
      )
      .join("")
      .trim();
  }
  return "";
}

/**
 * Parse Vapi's OpenAI-style custom-llm `/chat/completions` POST. Vapi augments the
 * OpenAI body (`messages[]`, `stream`) with its own `call`/`phoneNumber`/`customer`
 * context, so this yields BOTH the conversational turn (latest user utterance +
 * prior turns as memory) AND the routing identity (dialed number, call id). Pure;
 * never throws — null on unparseable JSON.
 */
export function parseVapiChatCompletion(rawBody: string): {
  /** The caller's latest utterance — the turn to respond to. */
  transcript: string;
  /** Prior turns oldest-first, reconstructed from the message history (memory). */
  priorTurns: Array<{ transcript: string; reply: string | null }>;
  /** Vapi call id — the per-call dedupe + persistence correlation key. */
  callId: string | null;
  /** Dialed number — the org attribution key (never the caller identity). */
  to: string | null;
  from: string | null;
  /** Whether Vapi asked for a streamed (SSE) response. Defaults to true. */
  stream: boolean;
} | null {
  type CallCtx = {
    id?: string;
    customer?: { number?: string };
    phoneNumber?: { number?: string };
  };
  // Vapi's custom-llm merges its call context at the TOP LEVEL of the OpenAI body
  // (and, defensively, may also nest it under `message` like its other webhooks).
  type ChatBody = {
    messages?: OpenAiChatMessage[];
    stream?: boolean;
    call?: CallCtx;
    customer?: { number?: string };
    phoneNumber?: { number?: string };
    message?: { call?: CallCtx; customer?: { number?: string }; phoneNumber?: { number?: string } };
  };
  let body: ChatBody | null;
  try {
    body = JSON.parse(rawBody) as ChatBody;
  } catch {
    return null;
  }
  if (!body) return null;

  const call = body.message?.call ?? body.call;
  const callId = call?.id?.trim() || null;
  const from = (call?.customer?.number ?? body.customer?.number ?? "").trim() || null;
  const to = (call?.phoneNumber?.number ?? body.phoneNumber?.number ?? "").trim() || null;

  // Walk the messages: pair each user line with the assistant reply that follows
  // it into a prior turn; the FINAL unanswered user line is the current transcript.
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const priorTurns: Array<{ transcript: string; reply: string | null }> = [];
  let pendingUser: string | null = null;
  let transcript = "";
  for (const m of messages) {
    const role = (m?.role ?? "").toLowerCase();
    const text = messageText(m?.content);
    if (role === "user") {
      // A new user line closes any prior unanswered user line as a reply-less turn.
      if (pendingUser !== null) priorTurns.push({ transcript: pendingUser, reply: null });
      pendingUser = text;
    } else if (role === "assistant") {
      if (pendingUser !== null) {
        priorTurns.push({ transcript: pendingUser, reply: text || null });
        pendingUser = null;
      }
    }
    // system / tool messages carry no conversational turn — ignored.
  }
  if (pendingUser !== null) transcript = pendingUser;

  const stream = body.stream !== false;
  return { transcript, priorTurns, callId, to, from, stream };
}

/**
 * Build a NON-STREAMING OpenAI-compatible `chat.completion` body carrying the
 * governed reply text. Vapi's custom-llm consumes this directly.
 */
export function buildOpenAiChatCompletion(
  content: string,
  opts?: { model?: string },
): Record<string, unknown> {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: opts?.model ?? "crewflow-receptionist",
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * Build a STREAMING OpenAI-compatible Server-Sent-Events body: one content chunk,
 * a terminal `stop` chunk, then `[DONE]`. A single buffered content chunk (not
 * token-by-token) — correct SSE the custom-llm client parses, and enough to
 * deliver a governed one/two-sentence turn.
 */
export function buildOpenAiChatCompletionSse(
  content: string,
  opts?: { model?: string },
): string {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = opts?.model ?? "crewflow-receptionist";
  const frame = (delta: Record<string, unknown>, finish: string | null): string =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return (
    frame({ role: "assistant", content }, null) + frame({}, "stop") + "data: [DONE]\n\n"
  );
}

/** Wrap governed tool/turn outputs into the response shape Vapi consumes. */
export function buildVapiToolResults(
  results: Array<{ toolCallId: string | null; result: string }>,
): Record<string, unknown> {
  return {
    results: results.map((r) => ({ toolCallId: r.toolCallId, result: r.result })),
  };
}

/** Parse a VERIFIED Vapi webhook body into the neutral shape, or null. */
export function parseVapiWebhook(input: {
  rawBody: string;
  params: Record<string, string>;
}): NormalizedInboundCall | null {
  let body: VapiBody;
  try {
    body = JSON.parse(input.rawBody) as VapiBody;
  } catch {
    return null;
  }
  const msg = body?.message;
  if (!msg) return null;

  const call = msg.call;
  const providerCallId = call?.id?.trim();
  if (!providerCallId) return null;

  const status = mapVapiStatus(msg.status, msg.endedReason);
  if (!status) return null;

  // Caller: the customer's number. Dialed: the Vapi phone number reached.
  const from = (call?.customer?.number ?? msg.customer?.number ?? "").trim() || null;
  const to =
    (call?.phoneNumber?.number ?? msg.phoneNumber?.number ?? "").trim() || null;

  const occurredAt = (() => {
    const t = msg.timestamp;
    if (typeof t === "number") return new Date(t).toISOString();
    if (typeof t === "string" && t.trim()) {
      const parsed = Date.parse(t);
      if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    }
    return new Date().toISOString();
  })();

  return {
    provider: "vapi",
    providerCallId,
    from,
    to,
    status,
    // One audit row per (call, status) — the natural idempotency key, since Vapi
    // redelivers the same status-update rather than carrying a per-event id.
    providerEventId: status,
    occurredAt,
    raw: (body as Record<string, unknown>) ?? {},
  };
}

export function createVapiVoiceProvider(): VoiceProvider {
  return {
    id: "vapi",
    verify: async (input) =>
      verifyVapiSignature({ signature: input.signature, rawBody: input.rawBody }),
    parse: (input) => parseVapiWebhook(input),
  };
}

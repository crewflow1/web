import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

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
  return { to, from, transcript };
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
 * Build the assistant configuration Vapi expects in reply to an assistant-request.
 * Vendor-neutral, credential-free, and safe to emit while DARK — it declares the
 * receptionist's model/voice/transcriber and opening line; no live provider call
 * is made here. The generative model itself remains governed at turn time via the
 * tool-call path and `maybeGenerateVoiceTurn`.
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
        messages: [{ role: "system", content: systemPrompt }],
      },
      transcriber: { provider: "deepgram", model: "nova-2", language: "en-GB" },
      voice: { provider: "vapi", voiceId: "Elliot" },
    },
  };
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

import { z } from "zod";

/**
 * CrewFlow HQ — Approval Console payload helpers (Train 11).
 *
 * Pure by construction — NO `server-only`, NO I/O — so the untrusted-content
 * discipline these encode is unit-testable in isolation.
 *
 * THE UNTRUSTED-PAYLOAD RULE. An approval's payload is an AI employee's
 * PROPOSAL — model-shaped output that may contain adversarial text (prompt
 * injection aimed at the reviewer, markup aimed at the renderer). The console
 * therefore treats every payload as INERT DATA:
 *   • it is DISPLAYED as text (React-escaped, via {@link formatPayloadForDisplay})
 *     — never interpreted, never rendered as HTML, never followed as instructions;
 *   • an edit is accepted only as strict JSON that parses to a PLAIN OBJECT
 *     ({@link parseEditedPayloadJson}) — the exact shape `edited_payload` stores —
 *     so a reviewer's revision can never smuggle a non-object into the engine.
 */

/** Upper bound for an edited payload, mirroring the boardroom's large-field caps. */
export const MAX_EDITED_PAYLOAD_CHARS = 20_000;

// The stored shape: a JSON object (string keys, any JSON values). z.record alone
// admits arrays (they are objects to JS), so the plain-object check comes first.
const payloadObjectSchema = z.record(z.unknown());

export type ParsedPayload =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Validate a reviewer's edited-payload textarea into the engine's stored shape.
 * Strict on purpose: JSON only (no JS literals), a plain object only (no array,
 * no scalar, no null), bounded size. Returns a discriminated result — never throws.
 */
export function parseEditedPayloadJson(raw: string): ParsedPayload {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: false, error: "Payload JSON is required." };
  if (trimmed.length > MAX_EDITED_PAYLOAD_CHARS) {
    return {
      ok: false,
      error: `Payload too large (max ${MAX_EDITED_PAYLOAD_CHARS} characters).`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "Not valid JSON." };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Payload must be a JSON object ({ … })." };
  }
  const checked = payloadObjectSchema.safeParse(parsed);
  if (!checked.success) return { ok: false, error: "Payload must be a JSON object ({ … })." };
  return { ok: true, payload: checked.data };
}

/**
 * The payload a decision would act on: the reviewer's tracked edit when one
 * exists, else the employee's original proposal.
 */
export function effectivePayload(row: {
  proposed_payload: Record<string, unknown>;
  edited_payload: Record<string, unknown> | null;
}): Record<string, unknown> {
  return row.edited_payload ?? row.proposed_payload;
}

/**
 * Render a payload for display as PLAIN TEXT — pretty-printed JSON the UI puts
 * inside a React-escaped <pre>. Total: a payload that cannot stringify (cycles
 * cannot arrive from the DB, but the function stays total anyway) degrades to a
 * marker rather than throwing mid-render.
 */
export function formatPayloadForDisplay(payload: Record<string, unknown>): string {
  if (Object.keys(payload).length === 0) return "{}";
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return "[unrenderable payload]";
  }
}

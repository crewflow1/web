import "server-only";
import { NextResponse } from "next/server";
import type { z } from "zod";

/**
 * Public API v1 — shared plumbing for the key-authenticated WRITE surface
 * (POST/PATCH create + update of customers / leads / jobs / quotes).
 *
 * The reads (Train K → Open-API expansion) established the trust boundary:
 * one dark flag, one guard (auth → per-resource scope → key-id rate limit),
 * org-pinning to the KEY'S org, explicit allowlists. The writes reuse ALL of
 * that (the guard is already scope-parameterised — a write route simply passes
 * its `write:*` scope) and add the extra discipline a write needs:
 *
 *   1. STRICT INPUT. Every body is parsed with a `.strict()` Zod schema so an
 *      unknown key (org_id, id, cost_total, public_token, status-you-shouldn't-
 *      set) is REJECTED, not silently ignored. This is the anti-mass-assignment
 *      guarantee: a client can only ever set the fields the schema names.
 *   2. BOUNDED BODY. A hard byte cap before any JSON parse so a huge payload is
 *      refused cheaply (413), never buffered unbounded.
 *   3. TYPED CONTENT. `application/json` only (415) — a write must declare it.
 *   4. LOUD, GENERIC ERRORS. Validation failures return a 422 with per-field
 *      messages; everything else is a coded envelope. Raw Postgres text never
 *      reaches the caller (house rule); the route logs the real error.
 *
 * The org boundary itself is NOT enforced here — each route pins
 * `org_id: guard.key.orgId` on the insert and verifies every foreign reference
 * (customer_id, lead_id, …) belongs to that org BEFORE the write. This module
 * only guarantees the SHAPE of what reaches the route is safe.
 */

/**
 * Hard ceiling on a write body. 64 KiB is generous for a CRM record (a quote
 * with many line items) yet bounds an abusive payload long before it costs
 * memory. Enforced on the raw text, pre-parse.
 */
export const MAX_WRITE_BODY_BYTES = 64 * 1024;

export type ParsedBody<T> =
  | { ok: true; value: T }
  | { ok: false; response: Response };

/** A coded error envelope — mirrors the read surface's `{ ok:false, error }`. */
export function writeError(
  status: number,
  error: string,
  message?: string,
): Response {
  return NextResponse.json(
    message ? { ok: false, error, message } : { ok: false, error },
    { status },
  );
}

/**
 * A 422 with per-field messages built from a Zod error. Only the FIRST message
 * per top-level field is surfaced (matches the app's form-error convention);
 * the shape is `{ ok:false, error:"validation_failed", field_errors:{...} }`.
 */
export function validationError(err: z.ZodError): Response {
  const field_errors: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path[0];
    const name = typeof key === "string" ? key : "_";
    if (!(name in field_errors)) field_errors[name] = issue.message;
  }
  return NextResponse.json(
    { ok: false, error: "validation_failed", field_errors },
    { status: 422 },
  );
}

/**
 * PATCH helper: copy ONLY the keys the client actually sent (value !==
 * undefined) from a validated body into a DB update row. This preserves true
 * PATCH semantics — an omitted field is left untouched, never overwritten with
 * null. The route lists the exact allowlisted columns, so nothing outside that
 * list can be carried through even if the schema grew.
 */
export function pickDefined<
  T extends Record<string, unknown>,
  K extends keyof T,
>(source: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/** 201 Created — the standard success shape for a create: `{ data }`. */
export function created(data: unknown): Response {
  return NextResponse.json({ data }, { status: 201 });
}

/** 200 OK — the standard success shape for an update: `{ data }`. */
export function okData(data: unknown): Response {
  return NextResponse.json({ data }, { status: 200 });
}

/**
 * Read + validate a JSON request body against a STRICT schema.
 *
 * Fails closed with a coded Response on: wrong/absent content-type (415),
 * over-cap body (413), malformed JSON (400), a non-object body (400), or a
 * schema violation including any unknown key (422). On success returns the
 * parsed, typed value — nothing else can reach the route.
 */
export async function parseJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<ParsedBody<T>> {
  const contentType = (request.headers.get("content-type") ?? "").trim();
  // `application/json` (optionally with a charset) only. A write must declare
  // JSON — we never guess.
  if (!/^application\/json\b/i.test(contentType)) {
    return {
      ok: false,
      response: writeError(
        415,
        "unsupported_media_type",
        "Send a JSON body with Content-Type: application/json.",
      ),
    };
  }

  const raw = await request.text();
  // Byte length, not char length — a multibyte payload must be bounded by its
  // real size.
  if (Buffer.byteLength(raw, "utf8") > MAX_WRITE_BODY_BYTES) {
    return {
      ok: false,
      response: writeError(
        413,
        "payload_too_large",
        `Request body exceeds ${MAX_WRITE_BODY_BYTES} bytes.`,
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    return {
      ok: false,
      response: writeError(400, "invalid_json", "Request body is not valid JSON."),
    };
  }

  // A body must be a JSON object — never an array or a bare scalar, so a schema
  // can never be handed something it would coerce surprisingly.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      response: writeError(
        400,
        "invalid_body",
        "Request body must be a JSON object.",
      ),
    };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, response: validationError(result.error) };
  }
  return { ok: true, value: result.data };
}

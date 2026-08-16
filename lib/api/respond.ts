import "server-only";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { REQUEST_ID_HEADER } from "@/lib/api/request-id";

/**
 * Unified response envelope for the INTERNAL `/api/*` surface.
 *
 * Recon found internal routes hand-rolling `NextResponse.json` with slightly
 * different shapes (`{ error }` vs `{ ok:false, error }`, `{ data, count }` vs
 * `{ data }` vs bare objects). This module is the one place that:
 *
 *   1. stamps the `x-request-id` correlation header on EVERY response (read
 *      from the middleware-forwarded request header), and
 *   2. mirrors that id as an additive `request_id` body field, and
 *   3. offers a consistent success (`ok`) / error (`error`) envelope for routes
 *      that adopt the standard shape.
 *
 * ADOPTION IS BEHAVIOUR-PRESERVING. Internal clients depend on existing status
 * codes and body keys, so:
 *   - `json(body, init)` is a drop-in for `NextResponse.json`: it preserves the
 *     body EXACTLY (all existing keys), only ADDING `request_id` (for plain
 *     objects) and the header. Existing routes migrate to this with no shape
 *     change.
 *   - `ok(data, …)` / `error(status, code, …)` are the standard envelope for
 *     the parts of a route where the shape already matches (`{ data }`,
 *     `{ ok:false, error }`), or for new routes.
 *
 * This is the internal cousin of the public v1 helpers in lib/public-api/write.ts;
 * the public surface keeps its own frozen contract, this one serves the app's
 * own fetch calls.
 */

export { REQUEST_ID_HEADER } from "@/lib/api/request-id";

/** Pagination block — mirrors the public v1 read surface for consistency. */
export type Pagination = {
  page: number;
  per_page: number;
  has_more: boolean;
  total?: number;
};

/**
 * The current request's correlation id, read from the middleware-forwarded
 * `x-request-id` request header. Returns null outside a request scope (e.g. a
 * unit test that never set the header) — callers then simply omit it.
 */
export async function currentRequestId(): Promise<string | null> {
  try {
    return (await headers()).get(REQUEST_ID_HEADER);
  } catch {
    return null;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function withRequestIdHeader(res: NextResponse, requestId: string | null): NextResponse {
  if (requestId) res.headers.set(REQUEST_ID_HEADER, requestId);
  return res;
}

/**
 * Behaviour-preserving drop-in for `NextResponse.json`.
 *
 * Preserves the body exactly; for a plain-object body it additively mirrors the
 * request id as `request_id` (never overwriting an existing key). Always sets
 * the `x-request-id` response header when an id is in scope.
 */
export async function json(
  body: unknown,
  init?: ResponseInit,
): Promise<NextResponse> {
  const requestId = await currentRequestId();
  const out =
    isPlainObject(body) && requestId && !("request_id" in body)
      ? { ...body, request_id: requestId }
      : body;
  return withRequestIdHeader(NextResponse.json(out, init), requestId);
}

/**
 * Standard SUCCESS envelope: `{ ok: true, data, [pagination], request_id }`.
 * Use where the route's success payload is a single `data` value (matches the
 * v1 read shape). For routes that return extra top-level keys, use `json`.
 */
export async function ok(
  data: unknown,
  opts: { status?: number; pagination?: Pagination; headers?: HeadersInit } = {},
): Promise<NextResponse> {
  const requestId = await currentRequestId();
  const body: Record<string, unknown> = { ok: true, data };
  if (opts.pagination) body.pagination = opts.pagination;
  if (requestId) body.request_id = requestId;
  return withRequestIdHeader(
    NextResponse.json(body, { status: opts.status ?? 200, headers: opts.headers }),
    requestId,
  );
}

/**
 * Standard ERROR envelope: `{ ok: false, error, [message], [...extra], request_id }`.
 *
 * `code` is a stable machine string (the existing routes' `error` value is kept
 * verbatim so no client that reads `error` breaks). `message` is optional human
 * text; `extra` merges additional fields a route already returned (e.g. Zod
 * `issues`) so the migration stays additive.
 */
export async function error(
  status: number,
  code: string,
  opts: { message?: string; extra?: Record<string, unknown>; headers?: HeadersInit } = {},
): Promise<NextResponse> {
  const requestId = await currentRequestId();
  const body: Record<string, unknown> = { ok: false, error: code };
  if (opts.message !== undefined) body.message = opts.message;
  if (opts.extra) Object.assign(body, opts.extra);
  if (requestId) body.request_id = requestId;
  return withRequestIdHeader(
    NextResponse.json(body, { status, headers: opts.headers }),
    requestId,
  );
}

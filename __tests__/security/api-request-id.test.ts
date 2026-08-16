import { describe, it, expect, vi } from "vitest";

/**
 * SECURITY / STANDARDS — request correlation id.
 *
 * Two proofs:
 *   1. resolveRequestId is injection-safe: it reuses a well-formed inbound id
 *      (distributed tracing) but DISCARDS anything that could forge a log line
 *      or a second header, minting a fresh UUID instead. The id is written into
 *      response headers + Sentry tags + logs, so an unvalidated inbound value is
 *      a header-injection / log-poisoning vector.
 *   2. The unified responders (lib/api/respond.ts) ALWAYS surface the id — on
 *      the response header AND as an additive `request_id` body field — without
 *      disturbing existing body keys (behaviour-preserving envelope adoption).
 */

// respond.ts reads the middleware-forwarded id via next/headers#headers().
const FORWARDED_ID = "req-abc123-DEF456";
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-request-id": FORWARDED_ID }),
}));

import {
  resolveRequestId,
  isAcceptableRequestId,
  REQUEST_ID_HEADER,
} from "@/lib/api/request-id";
import * as respond from "@/lib/api/respond";

describe("resolveRequestId — inbound reuse is injection-safe", () => {
  it("reuses a well-formed inbound id (shared trace across services)", () => {
    const inbound = "0f6c1e2a-1111-4bbb-8ccc-222233334444";
    expect(resolveRequestId(inbound)).toBe(inbound);
  });

  it("mints a fresh UUID when no inbound id is present", () => {
    const id = resolveRequestId(null);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(resolveRequestId(undefined)).not.toBe(resolveRequestId(undefined));
  });

  it("DISCARDS an inbound id carrying CR/LF, spaces or structural chars", () => {
    for (const evil of [
      "abc\r\nSet-Cookie: x=1", // header injection
      "id with spaces",
      "id\nlog forged line",
      "a".repeat(500), // over the length ceiling
      "short", // under the min length (8)
      "semi;colon",
      "%0d%0ainjected",
    ]) {
      expect(isAcceptableRequestId(evil)).toBe(false);
      // Falls back to a minted UUID, never echoes the crafted value.
      expect(resolveRequestId(evil)).not.toBe(evil);
    }
  });
});

describe("lib/api/respond — id present on every response, body preserved", () => {
  it("json() sets the header AND mirrors request_id without dropping keys", async () => {
    const res = await respond.json({ hits: [1, 2], count: 2 });
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(FORWARDED_ID);
    const body = await res.json();
    expect(body).toEqual({ hits: [1, 2], count: 2, request_id: FORWARDED_ID });
  });

  it("json() does not clobber an existing request_id in the body", async () => {
    const res = await respond.json({ request_id: "caller-set", ok: true });
    const body = await res.json();
    expect(body.request_id).toBe("caller-set");
  });

  it("ok() builds the standard success envelope with the id", async () => {
    const res = await respond.ok({ id: "x" }, { pagination: { page: 1, per_page: 20, has_more: false } });
    expect(res.status).toBe(200);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(FORWARDED_ID);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      data: { id: "x" },
      pagination: { page: 1, per_page: 20, has_more: false },
      request_id: FORWARDED_ID,
    });
  });

  it("error() preserves the error code + merges extra fields + carries the id", async () => {
    const res = await respond.error(400, "Invalid input", {
      extra: { issues: { fieldErrors: { amount: ["required"] } } },
    });
    expect(res.status).toBe(400);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(FORWARDED_ID);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Invalid input");
    expect(body.issues).toEqual({ fieldErrors: { amount: ["required"] } });
    expect(body.request_id).toBe(FORWARDED_ID);
  });
});

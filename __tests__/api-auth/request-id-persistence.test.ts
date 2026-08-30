import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ResolvedApiKey } from "@/lib/api-auth/resolve";

/**
 * Request-id persistence on the public-API access log (L11 item 4,
 * migration 20261226000000).
 *
 * lib/public-api/audit.ts now writes the x-request-id correlation token
 * onto every api_request_log row — the SAME id the middleware echoes in
 * the response header and tags in Sentry. The header is
 * client-influenceable, so the writer must re-validate with the
 * SAFE_INBOUND_ID allow-list and store NULL for anything unacceptable —
 * never the raw value (log-poisoning / header-injection vector).
 */

const inserted: Array<Record<string, unknown>> = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        inserted.push(row);
        return { error: null };
      },
    }),
  }),
}));

import { logApiRequest } from "@/lib/public-api/audit";

const KEY = {
  keyId: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
} as unknown as ResolvedApiKey;

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://api.crewflow.uk/api/v1/jobs?page=2", {
    method: "GET",
    headers,
  });
}

beforeEach(() => {
  inserted.length = 0;
});

describe("logApiRequest — request_id persistence", () => {
  it("persists a well-formed x-request-id verbatim", async () => {
    const id = "3f2c1d10-aaaa-4bbb-8ccc-1234567890ab";
    await logApiRequest(KEY, req({ "x-request-id": id }), 200);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.request_id).toBe(id);
    // The metadata boundary holds: pathname only, org/key pinned.
    expect(inserted[0]?.route).toBe("/api/v1/jobs");
    expect(inserted[0]?.key_id).toBe(KEY.keyId);
    expect(inserted[0]?.org_id).toBe(KEY.orgId);
  });

  it("stores NULL when the header is absent", async () => {
    await logApiRequest(KEY, req(), 200);
    expect(inserted[0]?.request_id).toBeNull();
  });

  it("drops a hostile/unacceptable header to NULL, never persists it raw", async () => {
    for (const hostile of [
      "short", // under 8 chars
      "has space in it", // structural char
      "a".repeat(201), // over length ceiling
      "abc;DROP TABLE--x", // structural chars
      "x_tab\tinjected99", // control char
    ]) {
      inserted.length = 0;
      await logApiRequest(KEY, req({ "x-request-id": hostile }), 200);
      expect(inserted[0]?.request_id, JSON.stringify(hostile)).toBeNull();
    }
  });
});

describe("migration 20261226000000 — the column mirrors the app-side allow-list", () => {
  const ROOT = resolve(__dirname, "..", "..");
  const MIGRATION = readFileSync(
    resolve(ROOT, "supabase/migrations/20261226000000_api_request_log_request_id.sql"),
    "utf8",
  );

  it("adds a NULLable request_id with the SAFE_INBOUND_ID pattern as a CHECK", () => {
    expect(MIGRATION).toMatch(/alter table public\.api_request_log/);
    expect(MIGRATION).toMatch(/add column if not exists request_id text/);
    // The exact pattern from lib/api/request-id.ts SAFE_INBOUND_ID.
    expect(MIGRATION).toMatch(/\^\[A-Za-z0-9\._-\]\{8,200\}\$/);
    expect(MIGRATION).toMatch(/request_id is null or/);
  });
});

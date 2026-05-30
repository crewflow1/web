import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Number → organisation routing.
 *
 * The org a call belongs to is decided HERE, from the dialled number, and
 * nowhere else. These tests pin:
 *   1. E.164 normalisation (so the same number in different formats maps
 *      to one row).
 *   2. The lookup filters on e164 + status='active' and returns the org,
 *      the phone_number_id, and any assistant override.
 *   3. Unknown / inactive numbers resolve to null (caller serves no AI).
 */

const h = vi.hoisted(() => ({
  state: {
    table: "",
    filters: [] as Array<[string, unknown]>,
    result: { data: null as unknown, error: null as unknown },
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      h.state.table = table;
      h.state.filters = [];
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (k: string, v: unknown) => {
          h.state.filters.push([k, v]);
          return chain;
        },
        maybeSingle: async () => h.state.result,
      };
      return chain;
    },
  }),
}));

import { normalizeE164, resolveOrgByNumber } from "@/server/services/phone-routing";

beforeEach(() => {
  h.state.table = "";
  h.state.filters = [];
  h.state.result = { data: null, error: null };
});

describe("normalizeE164", () => {
  it("passes through an already-E.164 number", () => {
    expect(normalizeE164("+447911123456")).toBe("+447911123456");
  });

  it("canonicalises UK formats to the same E.164", () => {
    expect(normalizeE164("07911 123456")).toBe("+447911123456");
    expect(normalizeE164("+44 7911 123456")).toBe("+447911123456");
    expect(normalizeE164("0044 7911 123456")).toBe("+447911123456");
    expect(normalizeE164("(07911) 123-456")).toBe("+447911123456");
  });

  it("returns null for empty / nullish input", () => {
    expect(normalizeE164(null)).toBeNull();
    expect(normalizeE164(undefined)).toBeNull();
    expect(normalizeE164("")).toBeNull();
    expect(normalizeE164("   ")).toBeNull();
  });
});

describe("resolveOrgByNumber", () => {
  it("returns the org/number/assistant for an active match, filtering on e164 + status", async () => {
    h.state.result = {
      data: { id: "pn-1", org_id: "org-1", vapi_assistant_id: "asst_x" },
      error: null,
    };

    const route = await resolveOrgByNumber("07911 123456");

    expect(route).toEqual({
      org_id: "org-1",
      phone_number_id: "pn-1",
      vapi_assistant_id: "asst_x",
    });
    expect(h.state.table).toBe("phone_numbers");
    // Looked up the NORMALISED number, scoped to active rows.
    expect(h.state.filters).toContainEqual(["e164", "+447911123456"]);
    expect(h.state.filters).toContainEqual(["status", "active"]);
  });

  it("returns null when no row matches (unknown / inactive number)", async () => {
    h.state.result = { data: null, error: null };
    expect(await resolveOrgByNumber("+447900000000")).toBeNull();
  });

  it("returns null (and does not query) for an unparseable number", async () => {
    expect(await resolveOrgByNumber("")).toBeNull();
    expect(h.state.table).toBe(""); // never hit the DB
  });

  it("returns null on a DB error rather than guessing an org", async () => {
    h.state.result = { data: null, error: { message: "boom" } };
    expect(await resolveOrgByNumber("+447911123456")).toBeNull();
  });
});

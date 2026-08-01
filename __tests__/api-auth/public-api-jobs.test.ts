import { describe, it, expect } from "vitest";
import {
  JOB_DTO_COLUMNS,
  JOB_DTO_SELECT,
  toPublicJobDto,
  parsePagination,
  rangeFor,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type JobRowForDto,
} from "@/lib/public-api/jobs";

/**
 * Public API v1 jobs — DTO projection + pagination bounds (unit tier).
 *
 * The security-critical behaviour of the projection (no leakage of a row
 * column that is NOT allowlisted) is asserted here with a real over-wide row,
 * and the exact allowlist is frozen so a new column cannot ride into the public
 * shape without turning this test red.
 */

describe("public jobs DTO — the allowlist is the contract", () => {
  it("freezes the exact public field set (a change is a deliberate diff, not an accident)", () => {
    expect(JOB_DTO_COLUMNS).toEqual([
      "id",
      "status",
      "scheduled_date",
      "site_postcode",
      "created_at",
      "updated_at",
    ]);
    expect(JOB_DTO_SELECT).toBe(
      "id, status, scheduled_date, site_postcode, created_at, updated_at",
    );
  });

  it("projects ONLY the allowlisted fields — an over-wide row leaks nothing", () => {
    // A row carrying every sensitive column the real table has. The projection
    // must copy only the six safe fields and drop the rest.
    const overWide = {
      id: "job-1",
      status: "scheduled",
      scheduled_date: "2026-08-10",
      site_postcode: "SW1A 1AA",
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-02T00:00:00Z",
      // --- must NEVER appear in the DTO ---
      ai_summary: "internal AI notes",
      notes: "operator-only notes",
      assigned_to: "staff-uuid",
      customer_id: "customer-uuid",
      org_id: "org-uuid",
      photos: ["storage/path.jpg"],
      recurring: { rule: "weekly" },
      site_address_line1: "1 Downing Street",
      site_address_line2: "Flat 2",
      site_city: "London",
      site_county: "Greater London",
      site_country: "GB",
      // paranoia: columns that don't exist today but would be catastrophic
      cost: 1234,
      margin: 0.42,
      portal_token: "secret-token",
    } as unknown as JobRowForDto;

    const dto = toPublicJobDto(overWide);

    expect(Object.keys(dto).sort()).toEqual([...JOB_DTO_COLUMNS].sort());
    expect(dto).toEqual({
      id: "job-1",
      status: "scheduled",
      scheduled_date: "2026-08-10",
      site_postcode: "SW1A 1AA",
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-02T00:00:00Z",
    });

    // Explicit leak assertions — the fields a public API must never emit.
    for (const forbidden of [
      "ai_summary",
      "notes",
      "assigned_to",
      "customer_id",
      "org_id",
      "photos",
      "recurring",
      "site_address_line1",
      "site_address_line2",
      "site_city",
      "site_county",
      "site_country",
      "cost",
      "margin",
      "portal_token",
    ]) {
      expect(dto, `DTO leaked ${forbidden}`).not.toHaveProperty(forbidden);
    }
  });

  it("preserves nulls for optional fields", () => {
    const dto = toPublicJobDto({
      id: "job-2",
      status: "draft",
      scheduled_date: null,
      site_postcode: null,
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
    });
    expect(dto.scheduled_date).toBeNull();
    expect(dto.site_postcode).toBeNull();
  });
});

describe("pagination — bounded and fail-safe", () => {
  it("defaults when params are absent", () => {
    expect(parsePagination(null, null)).toEqual({
      page: 1,
      per_page: DEFAULT_PAGE_SIZE,
    });
  });

  it("clamps an over-large per_page to the hard ceiling (no unbounded scan)", () => {
    expect(parsePagination("1", "100000").per_page).toBe(MAX_PAGE_SIZE);
    expect(parsePagination("1", String(MAX_PAGE_SIZE + 1)).per_page).toBe(
      MAX_PAGE_SIZE,
    );
  });

  it("accepts a valid in-range per_page verbatim", () => {
    expect(parsePagination("3", "50")).toEqual({ page: 3, per_page: 50 });
  });

  it("collapses garbage / zero / negative / fractional to safe defaults", () => {
    // Non-integer, zero, negative, and unparseable inputs all fail SAFE.
    for (const bad of ["0", "-5", "abc", "1.5", "", " ", "NaN", "1abc"]) {
      const p = parsePagination(bad, bad);
      expect(p.page).toBe(1);
      expect(p.per_page).toBe(DEFAULT_PAGE_SIZE);
    }
  });

  it("exponent notation resolves to its integer value, still per_page-clamped", () => {
    // "1e3" === 1000: a legitimate integer, not garbage. page is unbounded
    // above (an out-of-range page simply yields an empty result), but per_page
    // is still clamped to the ceiling — the safety property that matters.
    expect(parsePagination("1e3", "1e3")).toEqual({
      page: 1000,
      per_page: MAX_PAGE_SIZE,
    });
  });

  it("rangeFor asks for exactly per_page + 1 rows (the has_more probe)", () => {
    // page 1, per_page 25 → rows [0..25] inclusive = 26 rows
    expect(rangeFor({ page: 1, per_page: 25 })).toEqual({ from: 0, to: 25 });
    // page 3, per_page 10 → from 20, to 30 inclusive = 11 rows
    expect(rangeFor({ page: 3, per_page: 10 })).toEqual({ from: 20, to: 30 });
  });
});

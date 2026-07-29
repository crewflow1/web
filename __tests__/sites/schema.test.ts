import { describe, expect, it } from "vitest";
import {
  SITE_KINDS,
  SITE_KIND_LABELS,
  compareSites,
  formatSiteAddress,
  friendlySiteError,
  siteFormSchema,
  siteKindLabel,
} from "@/lib/sites/schema";

/**
 * lib/sites/schema — the pure half of the sites domain.
 *
 * These mirror the CHECK constraints in
 * supabase/migrations/20261061000000_sites.sql. The DB stays the enforcement
 * boundary; this tier proves the courtesy layer agrees with it, so a user gets
 * a sentence rather than a Postgres error for anything the DB would refuse.
 */

const minimal = { name: "Wakefield yard", kind: "depot" };

describe("site kinds", () => {
  it("covers the six company-location kinds and NOT a customer job site", () => {
    expect([...SITE_KINDS]).toEqual([
      "depot",
      "yard",
      "warehouse",
      "office",
      "storage_container",
      "lock_up",
    ]);
    // A job's address belongs to the customer and lives on the job
    // (jobs.site_address_*, 20260601000000). Adding it here would invite
    // migrating job addresses into a company-owned register.
    expect(SITE_KINDS as readonly string[]).not.toContain("job_site");
  });

  it("labels every kind, and falls back to the raw value for an unknown one", () => {
    for (const kind of SITE_KINDS) {
      expect(SITE_KIND_LABELS[kind].length).toBeGreaterThan(0);
      expect(siteKindLabel(kind)).toBe(SITE_KIND_LABELS[kind]);
    }
    expect(siteKindLabel("something_new")).toBe("something_new");
  });
});

describe("siteFormSchema", () => {
  it("accepts a name and a kind alone — everything else is optional", () => {
    const parsed = siteFormSchema.safeParse(minimal);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBe("Wakefield yard");
      expect(parsed.data.address_line1).toBeUndefined();
    }
  });

  it("requires a name", () => {
    expect(siteFormSchema.safeParse({ ...minimal, name: "   " }).success).toBe(false);
  });

  it("refuses a kind the DB CHECK would refuse", () => {
    expect(siteFormSchema.safeParse({ ...minimal, kind: "job_site" }).success).toBe(false);
    expect(siteFormSchema.safeParse({ ...minimal, kind: "" }).success).toBe(false);
  });

  it("bounds the name at 160 — the same bound as fleet_vehicles.home_depot", () => {
    expect(siteFormSchema.safeParse({ ...minimal, name: "y".repeat(160) }).success).toBe(true);
    expect(siteFormSchema.safeParse({ ...minimal, name: "y".repeat(161) }).success).toBe(false);
  });

  it("normalises a postcode to upper case with single spaces", () => {
    const parsed = siteFormSchema.safeParse({ ...minimal, postcode: "  wf1   1aa " });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.postcode).toBe("WF1 1AA");
  });

  it("does not regex-pin the postcode — BFPO and Crown-dependency codes pass", () => {
    for (const pc of ["BFPO 123", "JE2 3AB", "IM1 1AA", "GY1 1WR"]) {
      expect(siteFormSchema.safeParse({ ...minimal, postcode: pc }).success, pc).toBe(true);
    }
  });

  it("turns every blank optional field into undefined, never an empty string", () => {
    const parsed = siteFormSchema.safeParse({
      ...minimal,
      address_line1: "",
      city: "   ",
      postcode: "",
      notes: "",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.address_line1).toBeUndefined();
      expect(parsed.data.city).toBeUndefined();
      expect(parsed.data.postcode).toBeUndefined();
      expect(parsed.data.notes).toBeUndefined();
    }
  });

  it("has no `active` field — retiring a site is its own act, not a form checkbox", () => {
    const parsed = siteFormSchema.safeParse({ ...minimal, active: "false" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect("active" in parsed.data).toBe(false);
  });
});

describe("friendlySiteError", () => {
  it("explains a duplicate name in terms of the case-insensitive rule", () => {
    expect(friendlySiteError("23505", "duplicate key value")).toMatch(/already have a site/i);
    expect(friendlySiteError("23505", "duplicate key value")).toMatch(/ignoring capitals/i);
  });

  it("points a blocked delete at deactivation", () => {
    expect(friendlySiteError("23001", "site … deactivate it instead of deleting it")).toMatch(
      /Deactivate it instead/,
    );
    // Also matched by message, so a re-coded raise still reads correctly.
    expect(friendlySiteError(undefined, "… deactivate it instead of deleting it")).toMatch(
      /Deactivate it instead/,
    );
  });

  it("never leaks raw SQL, whatever comes back", () => {
    const msg = friendlySiteError(
      "42P01",
      'relation "public.sites" does not exist at character 13',
    );
    expect(msg).not.toMatch(/relation|character 13|public\./);
  });
});

describe("compareSites", () => {
  it("puts active sites first, then sorts by name ignoring capitals", () => {
    const rows = [
      { name: "wakefield yard", active: true },
      { name: "Old depot", active: false },
      { name: "Barnsley depot", active: true },
    ];
    expect([...rows].sort(compareSites).map((r) => r.name)).toEqual([
      "Barnsley depot",
      "wakefield yard",
      "Old depot",
    ]);
  });
});

describe("formatSiteAddress", () => {
  it("joins only the parts that were recorded", () => {
    expect(
      formatSiteAddress({
        address_line1: "Unit 4",
        address_line2: null,
        city: "Wakefield",
        county: "",
        postcode: "WF1 1AA",
      }),
    ).toBe("Unit 4, Wakefield, WF1 1AA");
  });

  it("returns an empty string when nothing was recorded", () => {
    expect(formatSiteAddress({})).toBe("");
    expect(formatSiteAddress({ address_line1: "  ", postcode: null })).toBe("");
  });
});

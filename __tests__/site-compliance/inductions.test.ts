import { describe, it, expect } from "vitest";
import {
  inductionStatement,
  INDUCTION_STATEMENT_VERSION,
  isInductionCurrent,
  isWorkerInducted,
  latestInductionByWorker,
  type InductionRecord,
} from "@/lib/site-compliance/inductions";

const NOW = new Date("2026-08-15T09:00:00.000Z");

function ind(over: Partial<InductionRecord>): InductionRecord {
  return {
    id: over.id ?? "i1",
    site_id: over.site_id ?? "site-A",
    user_id: over.user_id === undefined ? "user-1" : over.user_id,
    person_name: over.person_name ?? null,
    person_company: over.person_company ?? null,
    induction_version: over.induction_version ?? "v1",
    inducted_at: over.inducted_at ?? "2026-08-01T08:00:00.000Z",
    valid_until: over.valid_until ?? null,
    signed_name: over.signed_name ?? "Jane Doe",
  };
}

describe("inductionStatement", () => {
  it("names the site and has a stable version", () => {
    expect(inductionStatement("Wakefield Yard")).toContain("Wakefield Yard");
    expect(inductionStatement("Wakefield Yard")).toContain("emergency and fire arrangements");
    expect(INDUCTION_STATEMENT_VERSION).toBe("v1");
  });
  it("falls back to a generic phrase for an empty name", () => {
    expect(inductionStatement("   ")).toContain("this site");
  });
});

describe("isInductionCurrent", () => {
  it("no expiry → always current", () => {
    expect(isInductionCurrent({ valid_until: null }, NOW)).toBe(true);
  });
  it("expiry in the future → current", () => {
    expect(isInductionCurrent({ valid_until: "2026-09-01T00:00:00.000Z" }, NOW)).toBe(true);
  });
  it("expiry in the past → not current", () => {
    expect(isInductionCurrent({ valid_until: "2026-08-01T00:00:00.000Z" }, NOW)).toBe(false);
  });
  it("expiry exactly now → not current (strictly after)", () => {
    expect(isInductionCurrent({ valid_until: NOW.toISOString() }, NOW)).toBe(false);
  });
  it("unparseable date → treated as no-expiry, never locks a worker out", () => {
    expect(isInductionCurrent({ valid_until: "not-a-date" }, NOW)).toBe(true);
  });
});

describe("isWorkerInducted (the site gate)", () => {
  const inductions = [
    ind({ id: "a", site_id: "site-A", user_id: "u1" }),
    ind({ id: "b", site_id: "site-A", user_id: "u2", valid_until: "2026-08-10T00:00:00.000Z" }), // expired
    ind({ id: "c", site_id: "site-B", user_id: "u1" }),
  ];

  it("gates IN a worker with a current induction for the site", () => {
    expect(isWorkerInducted(inductions, { siteId: "site-A", userId: "u1", now: NOW })).toBe(true);
  });
  it("gates OUT a worker whose only induction for the site has expired", () => {
    expect(isWorkerInducted(inductions, { siteId: "site-A", userId: "u2", now: NOW })).toBe(false);
  });
  it("gates OUT a worker inducted only for a DIFFERENT site", () => {
    // u1 is inducted for site-B but the gate is asked about site-A → still in via `a`,
    // so test a user with only a site-B induction:
    const only = [ind({ id: "c", site_id: "site-B", user_id: "u9" })];
    expect(isWorkerInducted(only, { siteId: "site-A", userId: "u9", now: NOW })).toBe(false);
  });
  it("gates OUT an unknown worker", () => {
    expect(isWorkerInducted(inductions, { siteId: "site-A", userId: "nobody", now: NOW })).toBe(false);
  });
});

describe("latestInductionByWorker", () => {
  it("keeps the most recent induction per worker and ignores external rows", () => {
    const rows = [
      ind({ id: "old", user_id: "u1", inducted_at: "2026-08-01T00:00:00.000Z", induction_version: "v1" }),
      ind({ id: "new", user_id: "u1", inducted_at: "2026-08-10T00:00:00.000Z", induction_version: "v2" }),
      ind({ id: "ext", user_id: null, person_name: "Contractor" }),
    ];
    const map = latestInductionByWorker(rows);
    expect(map.size).toBe(1);
    expect(map.get("u1")?.id).toBe("new");
  });
});

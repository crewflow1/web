import { describe, it, expect } from "vitest";
import { computeMuster, type MusterInput } from "@/lib/site-compliance/muster";
import type { InductionRecord } from "@/lib/site-compliance/inductions";

const NOW = new Date("2026-08-15T12:00:00.000Z");
const SITE = "site-A";

function ind(over: Partial<InductionRecord>): InductionRecord {
  return {
    id: over.id ?? "i",
    site_id: over.site_id ?? SITE,
    user_id: over.user_id ?? null,
    person_name: over.person_name ?? null,
    person_company: over.person_company ?? null,
    induction_version: over.induction_version ?? "v1",
    inducted_at: over.inducted_at ?? "2026-08-01T08:00:00.000Z",
    valid_until: over.valid_until ?? null,
    signed_name: over.signed_name ?? "Signed Name",
  };
}

function base(over: Partial<MusterInput> = {}): MusterInput {
  return {
    siteId: SITE,
    inductions: over.inductions ?? [],
    openEntries: over.openEntries ?? [],
    visitors: over.visitors ?? [],
    workerDisplay: over.workerDisplay,
    now: over.now ?? NOW,
  };
}

describe("computeMuster — the fire register correctness", () => {
  it("a worker present ⟺ current induction here AND on the clock", () => {
    const roll = computeMuster(
      base({
        inductions: [
          ind({ id: "i1", user_id: "u1" }), // inducted here
          ind({ id: "i2", user_id: "u2" }), // inducted but NOT clocked in
        ],
        openEntries: [
          { user_id: "u1", started_at: "2026-08-15T07:30:00.000Z" }, // on the clock
          { user_id: "u3", started_at: "2026-08-15T07:45:00.000Z" }, // clocked in but NOT inducted here
        ],
      }),
    );
    expect(roll.workers.map((w) => w.userId)).toEqual(["u1"]);
    expect(roll.workers[0]!.clockedInAt).toBe("2026-08-15T07:30:00.000Z");
    expect(roll.presentCount).toBe(1);
  });

  it("an EXPIRED induction does not put a clocked-in worker on the muster", () => {
    const roll = computeMuster(
      base({
        inductions: [ind({ id: "i1", user_id: "u1", valid_until: "2026-08-10T00:00:00.000Z" })],
        openEntries: [{ user_id: "u1", started_at: "2026-08-15T07:30:00.000Z" }],
      }),
    );
    expect(roll.workers).toHaveLength(0);
    expect(roll.presentCount).toBe(0);
  });

  it("an induction for ANOTHER site is ignored", () => {
    const roll = computeMuster(
      base({
        inductions: [ind({ id: "i1", user_id: "u1", site_id: "site-B" })],
        openEntries: [{ user_id: "u1", started_at: "2026-08-15T07:30:00.000Z" }],
      }),
    );
    expect(roll.workers).toHaveLength(0);
  });

  it("dedupes a worker with multiple current inductions to one row (latest version)", () => {
    const roll = computeMuster(
      base({
        inductions: [
          ind({ id: "old", user_id: "u1", inducted_at: "2026-08-01T00:00:00.000Z", induction_version: "v1" }),
          ind({ id: "new", user_id: "u1", inducted_at: "2026-08-12T00:00:00.000Z", induction_version: "v2" }),
        ],
        openEntries: [{ user_id: "u1", started_at: "2026-08-15T07:30:00.000Z" }],
      }),
    );
    expect(roll.workers).toHaveLength(1);
    expect(roll.workers[0]!.inductionVersion).toBe("v2");
  });

  it("counts signed-in visitors and includes them in presentCount", () => {
    const roll = computeMuster(
      base({
        visitors: [
          { id: "v1", visitor_name: "Ada", company: "Acme", purpose: null, host_name: "Host", signed_in_at: "2026-08-15T09:00:00.000Z" },
        ],
      }),
    );
    expect(roll.visitors.map((v) => v.name)).toEqual(["Ada"]);
    expect(roll.presentCount).toBe(1);
  });

  it("uses workerDisplay for the name/company, falling back to signed_name", () => {
    const roll = computeMuster(
      base({
        inductions: [ind({ id: "i1", user_id: "u1", signed_name: "J. Doe" })],
        openEntries: [{ user_id: "u1", started_at: "2026-08-15T07:30:00.000Z" }],
        workerDisplay: { u1: { name: "Jane Doe", company: "CrewCo" } },
      }),
    );
    expect(roll.workers[0]!.name).toBe("Jane Doe");
    expect(roll.workers[0]!.company).toBe("CrewCo");
  });

  it("is deterministic and stably ordered by arrival time then id", () => {
    const input = base({
      inductions: [
        ind({ id: "iB", user_id: "uB" }),
        ind({ id: "iA", user_id: "uA" }),
      ],
      openEntries: [
        { user_id: "uB", started_at: "2026-08-15T07:00:00.000Z" }, // earlier
        { user_id: "uA", started_at: "2026-08-15T08:00:00.000Z" }, // later
      ],
    });
    const a = computeMuster(input);
    const b = computeMuster(input);
    expect(a).toEqual(b);
    // Earlier clock-in listed first regardless of induction input order.
    expect(a.workers.map((w) => w.userId)).toEqual(["uB", "uA"]);
  });
});

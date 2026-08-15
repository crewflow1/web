import { describe, it, expect } from "vitest";
import { musterPeople, musterToCsv, musterFilename } from "@/lib/site-compliance/export";
import type { MusterRoll } from "@/lib/site-compliance/muster";

function roll(over: Partial<MusterRoll> = {}): MusterRoll {
  return {
    siteId: "site-A",
    generatedAt: over.generatedAt ?? "2026-08-15T12:34:00.000Z",
    workers: over.workers ?? [],
    visitors: over.visitors ?? [],
    presentCount: (over.workers?.length ?? 0) + (over.visitors?.length ?? 0),
  };
}

describe("musterPeople", () => {
  it("lists workers first, then visitors, with HH:MM UTC times", () => {
    const people = musterPeople(
      roll({
        workers: [
          { inductionId: "i1", userId: "u1", name: "Jane", company: "CrewCo", clockedInAt: "2026-08-15T07:05:00.000Z", inductionVersion: "v1" },
        ],
        visitors: [
          { id: "v1", name: "Ada", company: null, purpose: null, hostName: null, signedInAt: "2026-08-15T09:15:00.000Z" },
        ],
      }),
    );
    expect(people).toEqual([
      { name: "Jane", kind: "Worker", company: "CrewCo", onSince: "07:05" },
      { name: "Ada", kind: "Visitor", company: null, onSince: "09:15" },
    ]);
  });
});

describe("musterToCsv", () => {
  it("emits a header and CRLF rows, escaping commas and quotes (RFC-4180)", () => {
    const csv = musterToCsv(
      roll({
        workers: [
          { inductionId: "i1", userId: "u1", name: "Doe, Jane", company: 'A "B" Ltd', clockedInAt: "2026-08-15T07:05:00.000Z", inductionVersion: "v1" },
        ],
      }),
      { siteName: "Wakefield Yard", generatedAt: "2026-08-15T12:34:00.000Z" },
    );
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Name,Type,Company,On since (UTC)");
    expect(lines[1]).toBe('"Doe, Jane",Worker,"A ""B"" Ltd",07:05');
    // Trailing CRLF → last element is empty.
    expect(lines[lines.length - 1]).toBe("");
  });

  it("an empty roll is just the header", () => {
    const csv = musterToCsv(roll(), { siteName: "Yard", generatedAt: "2026-08-15T12:34:00.000Z" });
    expect(csv).toBe("Name,Type,Company,On since (UTC)\r\n");
  });
});

describe("musterFilename", () => {
  it("slugs the site name and stamps date + HHMM", () => {
    expect(musterFilename("Wakefield Yard", "2026-08-15T12:34:00.000Z", "pdf")).toBe(
      "muster-wakefield-yard-2026-08-15-1234.pdf",
    );
    expect(musterFilename("!!!", "2026-08-15T12:34:00.000Z", "csv")).toBe(
      "muster-site-2026-08-15-1234.csv",
    );
  });
});

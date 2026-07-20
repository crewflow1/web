import { describe, expect, it } from "vitest";
import {
  isCurrentReport,
  isPortalVisible,
  safeReportFilename,
} from "@/lib/site-reports/portal";

const PUB = "2026-07-08T09:00:00.000Z";

describe("isPortalVisible", () => {
  it("shows an issued, published, not-withdrawn report", () => {
    expect(
      isPortalVisible({ status: "issued", portal_published_at: PUB, portal_withdrawn_at: null }),
    ).toBe(true);
  });

  it("shows a superseded report that was published (historical evidence)", () => {
    expect(
      isPortalVisible({ status: "superseded", portal_published_at: PUB, portal_withdrawn_at: null }),
    ).toBe(true);
  });

  it("hides an unpublished issued report", () => {
    expect(
      isPortalVisible({ status: "issued", portal_published_at: null, portal_withdrawn_at: null }),
    ).toBe(false);
  });

  it("hides a withdrawn report", () => {
    expect(
      isPortalVisible({ status: "issued", portal_published_at: PUB, portal_withdrawn_at: PUB }),
    ).toBe(false);
  });

  it("never shows draft / ready_for_review / approved / archived, even if published", () => {
    for (const status of ["draft", "ready_for_review", "approved", "archived"]) {
      expect(
        isPortalVisible({ status, portal_published_at: PUB, portal_withdrawn_at: null }),
        `status ${status}`,
      ).toBe(false);
    }
  });

  it("isCurrentReport is true only for issued", () => {
    expect(isCurrentReport({ status: "issued" })).toBe(true);
    expect(isCurrentReport({ status: "superseded" })).toBe(false);
  });
});

describe("safeReportFilename", () => {
  it("uses the report number and ends in .pdf", () => {
    expect(safeReportFilename("SR-0007")).toBe("SR-0007.pdf");
  });

  it("strips unsafe characters that could inject headers or paths", () => {
    expect(safeReportFilename('../../etc/passwd"')).not.toContain("/");
    expect(safeReportFilename('a"b\nc')).toBe("a-b-c.pdf");
    expect(safeReportFilename("  ")).toBe("site-report.pdf");
  });

  it("falls back to the title, then a default", () => {
    expect(safeReportFilename(null, "Week 12 progress")).toBe("Week-12-progress.pdf");
    expect(safeReportFilename(null, null)).toBe("site-report.pdf");
  });
});

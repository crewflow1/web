import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildProgressSeries,
  summariseProgress,
} from "@/lib/job-progress/series";
import { toPortalProgress } from "@/lib/job-progress/portal";

/**
 * The customer boundary for job progress.
 *
 * The customer portal is served on an UNAUTHENTICATED token. Progress carries
 * two things a client must never receive: the site team's internal note ("held
 * up because we mispriced the steel") and the identity of whoever recorded the
 * figure. The internal `ProgressSummary` carries both; `PortalProgress` has no
 * field either could occupy.
 *
 * These assertions are the enforcement of that, in two layers:
 *   1. BEHAVIOURAL — serialise the DTO built from a summary stuffed with
 *      sentinel secrets and prove none of them appears anywhere in the payload.
 *      Not "isn't rendered": isn't PRESENT.
 *   2. STRUCTURAL — the portal page must reach progress ONLY through
 *      `toPortalProgress`, so a future edit can't render the internal shape.
 *
 * Mirrors the discipline the portal jobs page already documents for
 * `jobs.notes` and staff email: keep it out of the payload, not just out of the
 * markup.
 */

const ROOT = resolve(__dirname, "..", "..");
const PORTAL_PAGE = "app/customer-portal/[token]/jobs/page.tsx";

const NOTE_SECRET = "INTERNAL-margin-blown-do-not-show-client";
const NOTE_SECRET_2 = "INTERNAL-subbie-is-suing-us";
const AUTHOR_ID = "9f1c8b7a-0000-4000-8000-000000000abc";
const REPORT_REF = "SR-INTERNAL-0042";

function internalSummary() {
  const points = buildProgressSeries({
    observations: [
      {
        id: "obs-1",
        observed_on: "2026-06-01",
        percent: 40,
        note: NOTE_SECRET,
        recorded_by: AUTHOR_ID,
      },
      {
        id: "obs-2",
        observed_on: "2026-06-09",
        percent: 55,
        note: NOTE_SECRET_2,
        recorded_by: AUTHOR_ID,
      },
    ],
    reports: [
      {
        id: "rep-1",
        status: "issued",
        period_end: "2026-05-20",
        report_number: REPORT_REF,
        content: { progress_percent: 25, summary: NOTE_SECRET },
      },
    ],
  });
  return summariseProgress(points, new Date("2026-06-10T09:00:00Z"));
}

describe("job progress · customer-portal safety", () => {
  it("the internal summary really does carry the secrets (guards the test)", () => {
    // Without this, the leak assertions below could pass vacuously.
    const serialised = JSON.stringify(internalSummary());
    expect(serialised).toContain(NOTE_SECRET);
    expect(serialised).toContain(NOTE_SECRET_2);
    expect(serialised).toContain(AUTHOR_ID);
    expect(serialised).toContain(REPORT_REF);
  });

  it("NO internal note, author or report reference survives the DTO", () => {
    const payload = JSON.stringify(toPortalProgress(internalSummary()));
    expect(payload).not.toContain(NOTE_SECRET);
    expect(payload).not.toContain(NOTE_SECRET_2);
    expect(payload).not.toContain(AUTHOR_ID);
    expect(payload).not.toContain(REPORT_REF);
  });

  it("the DTO's shape admits only the customer-facing fields", () => {
    const dto = toPortalProgress(internalSummary());
    expect(Object.keys(dto).sort()).toEqual([
      "daysSinceUpdate",
      "hasProgress",
      "movement",
      "percent",
      "readings",
      "updatedOn",
    ]);
    for (const reading of dto.readings) {
      expect(Object.keys(reading).sort()).toEqual(["day", "percent"]);
    }
  });

  it("a reading is REBUILT, so a new internal field cannot widen the payload", () => {
    // Simulate a future internal field arriving on a point.
    const summary = internalSummary();
    const widened = {
      ...summary,
      points: summary.points.map((p) => ({
        ...p,
        futureInternalField: NOTE_SECRET,
      })),
    };
    const payload = JSON.stringify(toPortalProgress(widened));
    expect(payload).not.toContain(NOTE_SECRET);
    expect(payload).not.toContain("futureInternalField");
  });

  it("the portal page narrows through toPortalProgress before rendering", () => {
    const src = readFileSync(resolve(ROOT, PORTAL_PAGE), "utf8");
    expect(src).toContain("toPortalProgress");
    // The renderer is typed on the SAFE shape only.
    expect(src).toMatch(/progress:\s*PortalProgress\s*\|\s*undefined/);
    // The internal summary type is never imported into the portal.
    expect(src).not.toMatch(/\bProgressSummary\b/);
    expect(src).not.toMatch(/\bProgressPoint\b/);
  });

  it("the portal page never reads a progress note or author field", () => {
    const src = readFileSync(resolve(ROOT, PORTAL_PAGE), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    expect(code).not.toMatch(/\.note\b/);
    expect(code).not.toMatch(/recorded_by/);
    expect(code).not.toMatch(/authorId/);
    expect(code).not.toMatch(/\.reference\b/);
  });

  it("customer wording is factual, not the internal verdict", () => {
    // "Stalled" / "Went backwards" are the contractor's own dashboard words.
    // Publishing them to a paying client would state a verdict nobody wrote.
    const portalSrc = readFileSync(
      resolve(ROOT, "lib/job-progress/portal.ts"),
      "utf8",
    );
    const labels = portalSrc.match(
      /PORTAL_MOVEMENT_LABELS[\s\S]*?\n\};/,
    )?.[0];
    expect(labels).toBeTruthy();
    expect(labels!).not.toContain("Stalled");
    expect(labels!).not.toContain("Went backwards");
    expect(labels!).toContain("No change since the last update");
    expect(labels!).toContain("Revised down");
  });
});

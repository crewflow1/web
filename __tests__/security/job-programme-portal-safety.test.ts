import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { toPortalMilestones } from "@/lib/job-programme/portal";
import type { ProgrammeMilestoneRow } from "@/lib/job-programme/planned";

/**
 * The customer boundary for the job programme.
 *
 * The customer portal is served on an UNAUTHENTICATED token. A programme
 * carries things a client must never receive: the milestone WEIGHTS (the
 * org's commercial model of how the job's effort is distributed), the
 * baseline NOTE (the internal justification for moving the plan — "mispriced
 * the steel"), the REVISION number (how many times the plan has moved, bare
 * of context), internal row ids and the staff-only milestones themselves.
 *
 * Mirrors __tests__/security/job-progress-portal-safety.test.ts exactly:
 *   1. BEHAVIOURAL — serialise the DTO built from rows stuffed with sentinel
 *      secrets and prove none appears anywhere in the payload. Not "isn't
 *      rendered": isn't PRESENT.
 *   2. STRUCTURAL — the portal page reaches milestones ONLY through
 *      `toPortalMilestones`, and the portal READ never selects `weight` at
 *      all, so the secret never even crosses the wire on that path.
 */

const ROOT = resolve(__dirname, "..", "..");
const PORTAL_PAGE = "app/customer-portal/[token]/jobs/page.tsx";
const SERVICE = "server/services/job-progress.ts";

const HIDDEN_TITLE = "INTERNAL-strip-out-and-redo-the-botched-first-fix";
const WEIGHT_SECRET = 13.37;
const ROW_ID = "9f1c8b7a-0000-4000-8000-00000000cafe";
const BASELINE_ID = "9f1c8b7a-0000-4000-8000-00000000feed";

function internalRows(): ProgrammeMilestoneRow[] {
  return [
    {
      id: ROW_ID,
      title: "First fix complete",
      planned_start: "2026-06-01",
      planned_end: "2026-06-08",
      weight: WEIGHT_SECRET,
      customer_visible: true,
      sort: 2,
    },
    {
      id: `${ROW_ID}-2`,
      title: HIDDEN_TITLE, // staff-only: customer_visible = false
      planned_start: null,
      planned_end: "2026-06-05",
      weight: "86.63",
      customer_visible: false,
      sort: 1,
    },
  ];
}

describe("job programme · customer-portal safety", () => {
  it("the internal rows really do carry the secrets (guards the test)", () => {
    const serialised = JSON.stringify(internalRows());
    expect(serialised).toContain(HIDDEN_TITLE);
    expect(serialised).toContain(String(WEIGHT_SECRET));
    expect(serialised).toContain(ROW_ID);
  });

  it("NO weight, id or staff-only milestone survives the DTO", () => {
    const payload = JSON.stringify(toPortalMilestones(internalRows()));
    expect(payload).not.toContain(HIDDEN_TITLE);
    expect(payload).not.toContain(String(WEIGHT_SECRET));
    expect(payload).not.toContain("86.63");
    expect(payload).not.toContain(ROW_ID);
    expect(payload).not.toContain(BASELINE_ID);
    expect(payload).not.toMatch(/weight/i);
    expect(payload).not.toMatch(/revision/i);
    expect(payload).not.toMatch(/note/i);
  });

  it("the DTO's shape admits ONLY title and plannedEnd", () => {
    const dtos = toPortalMilestones(internalRows());
    expect(dtos.length).toBeGreaterThan(0);
    for (const dto of dtos) {
      expect(Object.keys(dto).sort()).toEqual(["plannedEnd", "title"]);
    }
  });

  it("a milestone is REBUILT, so a new internal field cannot widen the payload", () => {
    const widened = internalRows().map((r) => ({
      ...r,
      futureInternalField: HIDDEN_TITLE,
    }));
    const payload = JSON.stringify(toPortalMilestones(widened));
    expect(payload).not.toContain(HIDDEN_TITLE);
    expect(payload).not.toContain("futureInternalField");
  });

  it("customer_visible is honoured HERE, not only in the caller's query", () => {
    // Belt and braces: even if every row crossed the wire, the staff-only one
    // cannot cross this function.
    const rows = internalRows().map((r) => ({ ...r, customer_visible: r.customer_visible }));
    const titles = toPortalMilestones(rows).map((m) => m.title);
    expect(titles).toEqual(["First fix complete"]);
  });

  it("the portal milestone READ never selects weight (it must not cross the wire)", () => {
    const src = readFileSync(resolve(ROOT, SERVICE), "utf8");
    const cols = src.match(/const PORTAL_MILESTONE_COLS =\s*\n?\s*"([^"]+)"/)?.[1];
    expect(cols, "PORTAL_MILESTONE_COLS must exist in the service").toBeTruthy();
    expect(cols!).not.toContain("weight");
    expect(cols!).toContain("customer_visible");
    // …and the batched portal loader uses that constant, filtered in-query.
    const loader = src.match(/export async function loadProgrammeMilestonesForJobs[\s\S]*?\n\}/)?.[0];
    expect(loader).toBeTruthy();
    expect(loader!).toContain("PORTAL_MILESTONE_COLS");
    expect(loader!).toContain('.eq("customer_visible", true)');
    expect(loader!).toContain('.is("superseded_at", null)');
  });

  it("the portal page narrows through toPortalMilestones before rendering", () => {
    const src = readFileSync(resolve(ROOT, PORTAL_PAGE), "utf8");
    expect(src).toContain("toPortalMilestones");
    // The renderer is typed on the SAFE shape only.
    expect(src).toMatch(/milestones:\s*PortalMilestone\[\]\s*\|\s*undefined/);
    // The internal row type is never imported into the portal.
    expect(src).not.toMatch(/\bProgrammeMilestoneRow\b/);
    expect(src).not.toMatch(/\bProgrammeBaselineRow\b/);
  });

  it("the portal page never reads a weight, note or revision field", () => {
    const src = readFileSync(resolve(ROOT, PORTAL_PAGE), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    expect(code).not.toMatch(/\.weight\b/);
    expect(code).not.toMatch(/\brevision\b/);
    expect(code).not.toMatch(/baseline_id/);
  });

  it("the portal DTO publishes dates, never a variance verdict", () => {
    // "Behind programme" shown to a paying client would be a commercial claim
    // the contractor never wrote — the PORTAL_MOVEMENT_LABELS argument, applied
    // to the plan. The portal module must carry no comparative wording at all.
    const portalSrc = readFileSync(resolve(ROOT, "lib/job-programme/portal.ts"), "utf8");
    const code = portalSrc
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");
    expect(code).not.toMatch(/\b(behind|ahead|late|overdue|variance|delay)\b/i);
  });
});

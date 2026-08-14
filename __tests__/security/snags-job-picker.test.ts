import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { withPreservedOption } from "@/lib/quotes/preserve-option";

/**
 * REGRESSION (F-1 picker-completion class — the OPTIONAL-picker variant).
 *
 * The snag create form (app/(app)/snags/new) renders the job as an OPTIONAL
 * `<select defaultValue={presetJob ?? ""}>` whose FIRST option is the empty
 * "No job (general)" sentinel, and whose real <option>s came from a reader
 * capped at `.limit(200)`.
 *
 * THE BUG. The form is deep-linked with the job pre-set — every job detail page
 * renders a "Log a snag" button (jobs/[id]/_job-snags.tsx → /snags/new?job=<id>).
 * For a job older than the 200 newest, that id is ABSENT from the capped option
 * list, so NO <option> matches the non-empty default. Because the picker is
 * OPTIONAL it cannot lean on `required` (a snag need not belong to a job): the
 * browser falls to the LEADING empty option and an untouched submit posts
 * job_id="" → `optionalUuid` coerces "" → undefined → the snag is filed against
 * NO job, silently. This is the pure silent-NULL (worse than the delay/report
 * required variant, which mis-attributes to a wrong job rather than nulling).
 *
 * THE FIX, two layers (both asserted):
 *   1. the option-source reader PAGES the complete set via `fetchAllRows`
 *      (no `.limit(200)` cap), so a deep-linked job is present; and
 *   2. the form PRESERVE-INJECTS the deep-linked id via `withPreservedOption`
 *      so even a capped/filtered list can never drop it — the preset is always a
 *      selectable <option> and an untouched submit round-trips it. The form does
 *      this in-file (not just the page) because the OPTIONAL select cannot use
 *      the `required` exemption its siblings rely on.
 *
 * The SAME optional preset-on-create shape lives on the review-request form
 * (app/(app)/reviews/new): an optional `Completed job` <select defaultValue={
 * sp.job_id ?? ""}>` that read only the recent-200 completed jobs while the
 * customer picker beside it was already paged complete. Its source teeth are
 * asserted at the bottom of this file alongside the snags ones.
 */

const ROOT = resolve(__dirname, "..", "..");

type JobOption = { id: string; label: string };

const DEEP_LINKED_JOB = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_JOB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

/**
 * The browser's contract for an OPTIONAL <select> whose FIRST option is the
 * empty `value=""` "No job" sentinel:
 *   - default present in options → that value (correct attribution);
 *   - default is "" → the empty option (an explicit "no job" — fine);
 *   - default is a non-empty id ABSENT from the options → no <option> matches,
 *     so the FIRST option (the empty sentinel) is selected → an untouched submit
 *     posts "" → the server writes NULL. The silent mis-attribution to NO job.
 */
function submittedOptionalJobSelect(
  options: readonly JobOption[],
  defaultValue: string,
): string {
  if (defaultValue && options.some((o) => o.id === defaultValue)) return defaultValue;
  return ""; // "" default, or non-empty-but-unmatched → the leading empty option
}

describe("snags job picker — a deep-linked job beyond the cap must not silently file against NO job", () => {
  it("DEMONSTRATES THE BUG: a capped list drops the deep-linked job, so the optional select falls to the empty 'No job' option", () => {
    const capped: JobOption[] = [{ id: OTHER_JOB, label: "Some other job" }];
    expect(capped.some((o) => o.id === DEEP_LINKED_JOB)).toBe(false);

    // The optional <select> resolves the missing preset to the leading empty
    // option — job_id="" — which optionalUuid coerces to NULL. Silent mis-file.
    const submitted = submittedOptionalJobSelect(capped, DEEP_LINKED_JOB);
    expect(submitted).toBe("");
    expect(submitted).not.toBe(DEEP_LINKED_JOB);
  });

  it("THE FIX: withPreservedOption injects the deep-linked job so it is present AND selected", () => {
    const capped: JobOption[] = [{ id: OTHER_JOB, label: "Some other job" }];
    const options = withPreservedOption(capped, DEEP_LINKED_JOB, (id) => ({
      id,
      label: "Selected job",
    }));
    // Present as a selectable option…
    expect(options.some((o) => o.id === DEEP_LINKED_JOB)).toBe(true);
    // …and the untouched submit round-trips the CORRECT job — not NULL.
    const submitted = submittedOptionalJobSelect(options, DEEP_LINKED_JOB);
    expect(submitted).toBe(DEEP_LINKED_JOB);
  });

  it("no preset (no deep link): the empty option stands and 'No job' is an honest, intended choice", () => {
    const jobs: JobOption[] = [{ id: OTHER_JOB, label: "Some other job" }];
    // Mirror the page: `sp.job ?? ""` → "" → passed to withPreservedOption as null.
    const presetJob: string = "";
    const options = withPreservedOption(jobs, presetJob || null, (id) => ({
      id,
      label: "Selected job",
    }));
    expect(options).toEqual(jobs); // nothing injected
    expect(submittedOptionalJobSelect(options, "")).toBe(""); // genuine "No job"
  });

  it("is a no-op when the deep-linked job is already in the (paged) list", () => {
    const jobs: JobOption[] = [{ id: DEEP_LINKED_JOB, label: "The job" }];
    const options = withPreservedOption(jobs, DEEP_LINKED_JOB, () => {
      throw new Error("must not inject when the id is already present");
    });
    expect(options).toHaveLength(1);
    expect(submittedOptionalJobSelect(options, DEEP_LINKED_JOB)).toBe(DEEP_LINKED_JOB);
  });
});

// ── SOURCE TEETH: the snag create surface must PAGE the job reader and
// PRESERVE-INJECT the deep-linked preset. Keyed on the files that carry the bug
// so the class can't regrow on this form. ────────────────────────────────────
describe("snags/new job picker pages the reader and preserves the deep-linked preset", () => {
  const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

  it("snags/new page pages the complete job set (fetchAllRows) with no .limit(200) cap and a unique order", () => {
    const src = read("app/(app)/snags/new/page.tsx");
    expect(src).toMatch(/fetchAllRows/);
    expect(src).not.toMatch(/\.limit\(\s*200\s*\)/);
    // Stable, unique order so no row shifts across a page boundary.
    expect(src).toMatch(/order\("id"/);
  });

  it("snags/_form preserve-injects the ?job preset via withPreservedOption (in-file — the optional select can't use `required`)", () => {
    const src = read("app/(app)/snags/_form.tsx");
    expect(src).toMatch(/withPreservedOption/);
    // The rendered <select> must map the PRESERVED source, not the raw prop.
    expect(src).toMatch(/\{jobOptions\.map\(/);
  });
});

// ── reviews/new — the same OPTIONAL preset-on-create job picker. The customer
// picker in that file was already paged; the job picker was left on a
// recent-200 cap and the vacuous allowlist. ──────────────────────────────────
describe("reviews/new job picker pages the reader and preserves the preset", () => {
  const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");
  const src = () => read("app/(app)/reviews/new/page.tsx");

  it("pages the completed-job set (fetchAllRows) with no .limit(200) cap and a unique order", () => {
    const s = src();
    // Both pickers page now; assert there is NO bare .limit(200) left anywhere,
    // and the jobs read carries the unique `id` tiebreaker for stable paging.
    expect(s).not.toMatch(/\.limit\(\s*200\s*\)/);
    expect(s).toMatch(/fetchAllRows<JobOption>/);
    expect(s).toMatch(/order\("id"/);
  });

  it("preserve-injects the ?job_id preset via withPreservedOption and maps the preserved source", () => {
    const s = src();
    expect(s).toMatch(/withPreservedOption\(jobs, sp\.job_id/);
    expect(s).toMatch(/\{jobOptions\.map\(/);
  });
});

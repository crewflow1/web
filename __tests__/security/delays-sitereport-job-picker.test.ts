import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { withPreservedOption } from "@/lib/quotes/preserve-option";

/**
 * REGRESSION (F-1 picker-completion class — the REQUIRED-picker variant).
 *
 * The delay/EOT create form (app/(app)/delays/new) and the site-report create
 * form (app/(app)/site-reports/new) each render the job as a REQUIRED
 * `<select defaultValue={preset}>` with a leading disabled empty option, whose
 * <option>s came from a reader capped at `.limit(200)`.
 *
 * THE BUG. Both forms are deep-linked with the job pre-set —
 * `jobs/[id]/_job-delays.tsx` links to `/delays/new?jobId=<id>`. For a job older
 * than the 200 newest, that id is ABSENT from the capped option list, so the
 * REQUIRED <select> cannot round-trip it: with no matching <option> the browser
 * discards the preset and selects the FIRST ENABLED option — a DIFFERENT job —
 * so an untouched submit silently mis-attributes the delay/EOT to the WRONG job.
 * (`required` does NOT save us here: a non-empty-but-unmatched default resolves
 * to the first real option, which passes validation.)
 *
 * THE FIX, two layers (both asserted):
 *   1. the option-source reader PAGES the complete set via `fetchAllRows`
 *      (no `.limit(200)` cap), so a deep-linked job is present; and
 *   2. the page PRESERVE-INJECTS the deep-linked id via `withPreservedOption`
 *      and hands the form the RESOLVED id as `defaultValue`, so even a
 *      capped/filtered list can never drop it — the correct job is the selected
 *      option and an untouched submit attributes to it.
 */

const ROOT = resolve(__dirname, "..", "..");

type JobOption = { id: string; label: string };

const DEEP_LINKED_JOB = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_JOB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

/**
 * The browser's contract for a REQUIRED <select> with a leading
 * `<option value="" disabled>`:
 *   - default present in options → that value (correct attribution);
 *   - default is "" → the disabled empty option; an untouched submit is BLOCKED
 *     by `required` (LOUD — forces a choice), modelled here as "";
 *   - default is a non-empty id ABSENT from the options → no <option> matches,
 *     so the FIRST ENABLED option is selected (a DIFFERENT job) and passes
 *     `required` — the silent mis-attribution.
 */
function submittedRequiredJobSelect(options: readonly JobOption[], defaultValue: string): string {
  if (defaultValue && options.some((o) => o.id === defaultValue)) return defaultValue;
  if (defaultValue === "") return ""; // disabled empty option → required blocks the submit
  return options[0]?.id ?? ""; // non-empty but unmatched → first enabled option
}

describe("delays / site-reports job picker — a deep-linked job beyond the cap must not silently mis-attribute", () => {
  it("DEMONSTRATES THE BUG: a capped list drops the deep-linked job, so the required select picks a DIFFERENT job", () => {
    // The deep-linked job is older than the cap, so it is not in the list.
    const capped: JobOption[] = [{ id: OTHER_JOB, label: "Some other job" }];
    expect(capped.some((o) => o.id === DEEP_LINKED_JOB)).toBe(false);

    // The required <select> resolves the missing preset to the first enabled
    // option — the WRONG job — and passes validation. Silent mis-attribution.
    const submitted = submittedRequiredJobSelect(capped, DEEP_LINKED_JOB);
    expect(submitted).toBe(OTHER_JOB);
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
    // …and the untouched submit round-trips the CORRECT job.
    const submitted = submittedRequiredJobSelect(options, DEEP_LINKED_JOB);
    expect(submitted).toBe(DEEP_LINKED_JOB);
  });

  it("no preset (no deep link): the empty required option still forces a choice", () => {
    const jobs: JobOption[] = [{ id: OTHER_JOB, label: "Some other job" }];
    // Mirror the page: `sp.jobId ?? ""` → "" → passed to withPreservedOption as null.
    const presetJobId: string = "";
    const options = withPreservedOption(jobs, presetJobId || null, (id) => ({
      id,
      label: "Selected job",
    }));
    expect(options).toEqual(jobs); // nothing injected
    expect(submittedRequiredJobSelect(options, "")).toBe(""); // blocked by `required`
  });

  it("is a no-op when the deep-linked job is already in the (paged) list", () => {
    const jobs: JobOption[] = [{ id: DEEP_LINKED_JOB, label: "The job" }];
    const options = withPreservedOption(jobs, DEEP_LINKED_JOB, () => {
      throw new Error("must not inject when the id is already present");
    });
    expect(options).toHaveLength(1);
    expect(submittedRequiredJobSelect(options, DEEP_LINKED_JOB)).toBe(DEEP_LINKED_JOB);
  });
});

// ── SOURCE TEETH: the two create surfaces must PAGE the job reader and
// PRESERVE-INJECT the deep-linked preset. Keyed on the files that carry the bug
// so the class can't regrow on either form. ──────────────────────────────────
describe("delays / site-reports job pickers page the reader and preserve the deep-linked preset", () => {
  const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

  it("delays: listJobOptions pages the complete set (fetchAllRows) with no .limit(200) cap", () => {
    const src = read("app/(app)/delays/_data.ts");
    const fn = src.slice(src.indexOf("export async function listJobOptions"));
    const body = fn.slice(0, fn.indexOf("\nexport ") === -1 ? fn.length : fn.indexOf("\nexport "));
    expect(body).toMatch(/fetchAllRows/);
    expect(body).not.toMatch(/\.limit\(\s*200\s*\)/);
    // Stable, unique order so no row shifts across a page boundary.
    expect(body).toMatch(/order\("id"/);
  });

  it("delays/new page preserve-injects the ?jobId preset and hands the form the resolved id", () => {
    const src = read("app/(app)/delays/new/page.tsx");
    expect(src).toMatch(/withPreservedOption/);
  });

  it("site-reports/new page pages the job reader (fetchAllRows, no .limit(200)) and preserve-injects the ?job preset", () => {
    const src = read("app/(app)/site-reports/new/page.tsx");
    expect(src).toMatch(/fetchAllRows/);
    expect(src).not.toMatch(/\.limit\(\s*200\s*\)/);
    expect(src).toMatch(/withPreservedOption/);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  filterVerifiedPhotoIds,
  MAX_REPORT_PHOTOS,
  parsePhotoSelection,
} from "@/lib/site-reports/photo-selection";

/**
 * Site-report photo selection — the PRODUCER for the portal photos tab.
 *
 * Staff tick checkboxes whose values are client-supplied attachment ids that
 * will eventually freeze into a customer-visible snapshot. Pinned here:
 *
 *   • every submitted id is re-verified server-side (RLS read + active-org +
 *     target_table='jobs' + THIS report's job in SQL; job binding + image mime
 *     re-checked in code) — the picker UI is a convenience, not the authority;
 *   • a failed id REJECTS the submission (no silent partial save);
 *   • the selection is bounded (MAX_REPORT_PHOTOS, zod + stated in the UI);
 *   • photos are editable in draft/ready_for_review ONLY — after issue the
 *     content is frozen by the DB trigger AND refused in code, so the photo
 *     set a customer was shown can never change;
 *   • issueReport re-verifies at the moment of freeze, and the VERIFIED
 *     selection is what materialises into the snapshot the portal trusts.
 */

const ROOT = resolve(__dirname, "..", "..");
const readRaw = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const read = (p: string) =>
  readRaw(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const ACTIONS = read("app/(app)/site-reports/actions.ts");
const PICKER = read("app/(app)/site-reports/[id]/_photo-picker.tsx");
const PAGE = read("app/(app)/site-reports/[id]/page.tsx");

const JOB = "99999999-8888-4777-a666-555555555555";
const OTHER_JOB = "00000000-1111-4222-a333-444444444444";
const idN = (n: number) =>
  `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

describe("parsePhotoSelection — raw form values, strictly bounded", () => {
  it("accepts a deduped uuid list within the cap", () => {
    expect(parsePhotoSelection([idN(1), idN(2), idN(1)])).toEqual([idN(1), idN(2)]);
    expect(parsePhotoSelection([])).toEqual([]);
  });

  it("rejects any non-uuid entry outright — no coercion, no partial accept", () => {
    for (const bad of [
      [idN(1), "not-a-uuid"],
      [idN(1), "id.eq.anything"],
      ["../../etc/passwd"],
      [42 as unknown as string],
      "not-an-array" as unknown as string[],
    ]) {
      expect(parsePhotoSelection(bad)).toBeNull();
    }
  });

  it(`rejects more than ${MAX_REPORT_PHOTOS} distinct photos`, () => {
    const over = Array.from({ length: MAX_REPORT_PHOTOS + 1 }, (_, i) => idN(i + 1));
    expect(parsePhotoSelection(over)).toBeNull();
    expect(parsePhotoSelection(over.slice(0, MAX_REPORT_PHOTOS))).toHaveLength(
      MAX_REPORT_PHOTOS,
    );
  });
});

describe("filterVerifiedPhotoIds — an id survives only as a proven image of THIS job", () => {
  const rows = [
    { id: idN(1), target_id: JOB, mime_type: "image/jpeg" },
    { id: idN(2), target_id: OTHER_JOB, mime_type: "image/jpeg" }, // wrong job
    { id: idN(3), target_id: JOB, mime_type: "application/pdf" }, // not an image
    { id: idN(4), target_id: null, mime_type: "image/png" }, // detached
  ];

  it("keeps the verified id and drops wrong-job / non-image / detached rows", () => {
    expect(filterVerifiedPhotoIds([idN(1), idN(2), idN(3), idN(4)], rows, JOB)).toEqual([
      idN(1),
    ]);
  });

  it("an id with no row at all never survives (guessed / deleted attachment)", () => {
    expect(filterVerifiedPhotoIds([idN(9)], rows, JOB)).toEqual([]);
  });

  it("re-checks the job binding in code even when the rows were pre-filtered", () => {
    // Same rows, different job: nothing qualifies.
    expect(filterVerifiedPhotoIds([idN(1)], rows, OTHER_JOB)).toEqual([]);
  });
});

describe("updateReportPhotos — server-side re-verification of client ids", () => {
  const action = ACTIONS.slice(
    ACTIONS.indexOf("export async function updateReportPhotos"),
    ACTIONS.indexOf("async function runTransition"),
  );

  it("verification query pins active org, jobs target AND this report's job", () => {
    expect(ACTIONS).toMatch(
      /\.eq\("org_id", orgId\)\s*\n?\s*\.eq\("target_table", "jobs"\)\s*\n?\s*\.eq\("target_id", jobId\)\s*\n?\s*\.in\("id", ids\)/,
    );
    expect(action).toMatch(
      /loadVerifiablePhotoRows\(tenant, ctx\.org\.id, report\.job_id, candidates\)/,
    );
  });

  it("rejects the WHOLE submission when any id fails verification", () => {
    expect(action).toMatch(/verified\.length !== candidates\.length/);
    expect(action).toMatch(/error=photo_not_on_job/);
  });

  it("refuses non-editable states — issued photos cannot change", () => {
    expect(action).toMatch(/if \(!isEditable\(report\.status as SiteReportStatus\)\)/);
    expect(action).toMatch(/error=not_editable/);
  });

  it("replaces ONLY the photo selection, preserving the other source curation", () => {
    expect(action).toMatch(
      /sources: \{ \.\.\.existingSources, photo_attachment_ids: verified \}/,
    );
  });

  it("the write is org-pinned and count-gated", () => {
    expect(action).toMatch(
      /\.update\(\{ content: merged \}, \{ count: "exact" \}\)\s*\n?\s*\.eq\("id", id\)\s*\n?\s*\.eq\("org_id", ctx\.org\.id\)/,
    );
    expect(action).toMatch(/if \(!count\) redirect/);
  });

  it("the verification read fails loud", () => {
    expect(ACTIONS).toMatch(
      /if \(error\) throw readFailure\("site-reports: photo verify", error\)/,
    );
  });
});

describe("issueReport — the freeze re-verifies and freezes only the verified set", () => {
  const issue = ACTIONS.slice(
    ACTIONS.indexOf("export async function issueReport"),
    ACTIONS.indexOf("export async function supersedeReport"),
  );

  it("re-verifies the photo ids against the job at the moment of freeze", () => {
    expect(issue).toMatch(
      /loadVerifiablePhotoRows\(\s*tenant,\s*ctx\.org\.id,\s*report\.job_id,\s*selection\.photo_attachment_ids,?\s*\)/,
    );
    expect(issue).toMatch(/photo_attachment_ids: filterVerifiedPhotoIds\(/);
  });

  it("the snapshot materialises from the VERIFIED selection, not the raw draft", () => {
    expect(issue).toMatch(/content: contentForFreeze/);
    expect(issue).toMatch(/selection: frozenSelection/);
    // The unverified originals must not reach the freeze.
    expect(issue).not.toMatch(/^\s*content,\s*$/m);
    expect(issue).not.toMatch(/^\s*selection,\s*$/m);
  });
});

describe("immutability after issue is untouched", () => {
  it("the DB trigger still freezes snapshot + content (no migration edit)", () => {
    const mig = readRaw("supabase/migrations/20260922000000_site_reports.sql");
    expect(mig).toMatch(/snapshot is immutable once set/);
    expect(mig).toMatch(/content is frozen after issue/);
    // This train added no site_reports DDL: the only Train 4 migration is the
    // preferences table. (The migration's header COMMENT may mention
    // site_reports when describing the zero-DDL photo read path — strip SQL
    // comments and pin that no actual statement touches the table.)
    const t4 = readRaw(
      "supabase/migrations/20261082000000_portal_evolution.sql",
    ).replace(/--[^\n]*/g, "");
    expect(t4).not.toMatch(/site_reports/i);
  });

  it("the picker renders only in editable states", () => {
    expect(PAGE).toMatch(/\{editable && report\.job_id \? \(\s*<ReportPhotoPicker/);
  });
});

describe("the picker — RLS-listed, short-lived thumbnails, phone ergonomics", () => {
  it("lists on the tenant client, pinned to org + jobs target + this job", () => {
    expect(PICKER).toMatch(/createClient\(\)/);
    expect(PICKER).toMatch(
      /\.eq\("org_id", orgId\)\s*\n?\s*\.eq\("target_table", "jobs"\)\s*\n?\s*\.eq\("target_id", jobId\)/,
    );
  });

  it("shows images only and signs the RLS-verified rows' paths for 60s", () => {
    expect(PICKER).toMatch(/\.startsWith\("image\/"\)/);
    expect(PICKER).toMatch(
      /createSignedUrls\(\s*images\.map\(\(a\) => a\.storage_path\),\s*60,?\s*\)/,
    );
    expect(PICKER).toMatch(/throw readFailure/);
  });

  it("meets the 44px touch target and stays a grid at 375px", () => {
    expect(PICKER).toMatch(/min-h-\[44px\]/);
    expect(PICKER).toMatch(/grid grid-cols-3 gap-2 sm:grid-cols-4/);
    expect(PICKER).toMatch(/h-5 w-5/); // checkbox inside the 44px+ label
  });

  it("states the cap in the UI from the same constant the server enforces", () => {
    expect(PICKER).toMatch(/Choose up to \{MAX_REPORT_PHOTOS\}/);
    expect(PICKER).toMatch(/of \{MAX_REPORT_PHOTOS\} selected/);
  });
});

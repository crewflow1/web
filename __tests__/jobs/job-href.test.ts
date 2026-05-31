import { describe, it, expect } from "vitest";
import { jobHref } from "@/lib/jobs/schema";

/**
 * Regression test for BUG-02 (linked job URL 404).
 *
 * The quote detail page used to render a job link whose visible label was a
 * truncated path — `/jobs/<first-8-chars>` — which 404s if a user copies it
 * into the address bar (the job detail page resolves on the FULL uuid).
 *
 * `jobHref` is the canonical route builder. It MUST return the complete id,
 * never a truncated one.
 */
describe("jobHref", () => {
  const FULL_UUID = "3f8a1c2e-9b4d-4e7a-8c1f-2d6b5a0e9f33";

  it("returns the canonical /jobs/<id> path with the full, untruncated id", () => {
    expect(jobHref(FULL_UUID)).toBe(`/jobs/${FULL_UUID}`);
  });

  it("does not truncate the id (the BUG-02 regression)", () => {
    const href = jobHref(FULL_UUID);
    const idSegment = href.replace("/jobs/", "");
    // Full v4 uuid is 36 chars — the old bug emitted only the first 8.
    expect(idSegment).toBe(FULL_UUID);
    expect(idSegment.length).toBe(36);
    expect(href).not.toBe(`/jobs/${FULL_UUID.slice(0, 8)}`);
  });

  it("round-trips an arbitrary id without mutation", () => {
    expect(jobHref("abc")).toBe("/jobs/abc");
    expect(jobHref("")).toBe("/jobs/");
  });
});

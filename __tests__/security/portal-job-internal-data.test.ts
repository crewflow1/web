import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Customer portal — internal job data must not reach customers.
 *
 * The portal jobs page selected `jobs.notes` and rendered it verbatim
 * (`whitespace-pre-wrap`, untruncated) to any portal-token holder. That is not
 * a customer-facing field: staff author it through the ordinary job form, whose
 * own placeholder reads "Scope, materials, access notes…" — so access codes,
 * key locations, pricing margin and internal commentary all plausibly live in
 * it. The same page also fell back to `Assigned: {assigned.email}` whenever a
 * staff member had no `full_name`, exposing internal staff PII.
 *
 * `jobs` has no customer-visibility flag (verified: no customer_visible /
 * visible_to_customer / internal_only column exists), and the page's own header
 * cited the directive's "assigned team IF ALLOWED" — a conditional that was
 * never built. With nothing to gate on, the only safe reading is to send
 * nothing that isn't plainly customer-facing.
 *
 * These assertions pin the fields OUT OF THE QUERY, not merely out of the
 * render. A page that fetches a secret and happens not to print it is one JSX
 * edit away from leaking it again, and the portal runs on the RLS-bypassing
 * service-role client (the token is the entire auth surface), so nothing else
 * would stop it.
 *
 * Source-contract per the repo convention for portal server components
 * (see __tests__/portal/phase3.test.ts).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const JOBS_PAGE = read("app/customer-portal/[token]/jobs/page.tsx");
const STAFF_JOBS_LIST = read("app/(app)/jobs/page.tsx");
const STAFF_JOBS_FORM = read("app/(app)/jobs/_form.tsx");

/** The Supabase .select() string only — what actually crosses the wire. */
const SELECT = (() => {
  const from = JOBS_PAGE.indexOf('.from("jobs")');
  expect(from).toBeGreaterThan(-1);
  const start = JOBS_PAGE.indexOf(".select(", from);
  const end = JOBS_PAGE.indexOf(".eq(", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return JOBS_PAGE.slice(start, end);
})();

describe("portal jobs — internal fields never leave the database", () => {
  it("does not SELECT jobs.notes", () => {
    expect(SELECT).not.toMatch(/\bnotes\b/);
  });

  it("does not SELECT the assigned staff member's email", () => {
    expect(SELECT).not.toMatch(/\bemail\b/);
  });

  it("does not SELECT jobs.ai_summary either (same class of internal text)", () => {
    expect(SELECT).not.toMatch(/ai_summary/);
  });

  it("still selects only the customer-facing fields the page needs", () => {
    for (const field of ["id", "status", "scheduled_date", "full_name"]) {
      expect(SELECT).toContain(field);
    }
  });
});

describe("portal jobs — nothing internal is rendered", () => {
  it("renders no job notes anywhere on the page", () => {
    expect(JOBS_PAGE).not.toMatch(/\{j\.notes\}/);
    expect(JOBS_PAGE).not.toMatch(/j\.notes \?/);
  });

  it("never renders an email as an assignee fallback", () => {
    expect(JOBS_PAGE).not.toMatch(/j\.assigned\?\.email/);
    expect(JOBS_PAGE).not.toMatch(/Assigned: \$\{j\.assigned\.email\}/);
  });

  it("reports an unnamed assignee as assigned, without identifying them", () => {
    // Truthful and non-identifying: the job IS assigned, so claiming
    // "Not yet assigned" would be a lie rather than a redaction.
    expect(JOBS_PAGE).toMatch(
      /j\.assigned\?\.full_name[\s\S]*?j\.assigned[\s\S]*?"Assigned"[\s\S]*?"Not yet assigned"/,
    );
  });

  it("keeps the notes type off the row shape, so it can't be reintroduced silently", () => {
    const rowType = JOBS_PAGE.slice(
      JOBS_PAGE.indexOf("type Row = {"),
      JOBS_PAGE.indexOf("};", JOBS_PAGE.indexOf("type Row = {")),
    );
    expect(rowType).not.toMatch(/notes/);
    expect(rowType).not.toMatch(/email/);
  });
});

describe("portal jobs — legitimate behaviour is unchanged", () => {
  it("still fails closed on a bad token", () => {
    expect(JOBS_PAGE).toMatch(/loadCustomerByPortalToken/);
    expect(JOBS_PAGE).toMatch(/if \(!loaded\) return <InvalidLinkPage/);
  });

  it("still scopes by BOTH org_id AND customer_id (isolation untouched)", () => {
    expect(JOBS_PAGE).toMatch(
      /\.eq\("org_id", customer\.org_id\)[\s\S]*?\.eq\("customer_id", customer\.id\)/,
    );
  });

  it("still shows status, schedule and the empty state", () => {
    expect(JOBS_PAGE).toMatch(/STATUS_LABELS/);
    expect(JOBS_PAGE).toMatch(/STATUS_STYLES/);
    expect(JOBS_PAGE).toMatch(/scheduled_date/);
    expect(JOBS_PAGE).toMatch(/No jobs scheduled yet/);
    expect(JOBS_PAGE).toMatch(/active="jobs"/);
  });
});

describe("staff job screens are untouched", () => {
  it("jobs.notes is still an internal field staff can write", () => {
    // The fix must not reach into the tenant side: notes remain a normal
    // staff field. Only the customer-facing surface stops receiving it.
    expect(STAFF_JOBS_FORM).toMatch(/name="notes"/);
  });

  it("staff still see notes on their own job list", () => {
    expect(STAFF_JOBS_LIST).toMatch(/notes/);
  });
});

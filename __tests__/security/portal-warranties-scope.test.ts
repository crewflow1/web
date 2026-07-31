import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildPortalWarrantyView,
  WARRANTY_PORTAL_KEYS,
} from "@/lib/warranties/portal";

/**
 * Customer-portal warranties — scoping, projection, and the no-send rule.
 *
 * The portal runs on the RLS-bypassing service-role client (the token is the
 * whole auth surface), so every guard here is one somebody could delete without
 * Postgres noticing. They are therefore pinned in source:
 *
 *   • the loader reaches warranties ONLY through the customer's own jobs;
 *   • internal columns are never selected and never projected;
 *   • sentinel secrets planted on the source row are absent from the SERIALISED
 *     payload, not merely unrendered;
 *   • no warranty surface performs a send of any kind.
 */

const ROOT = resolve(__dirname, "..", "..");
const readRaw = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
/**
 * Source with comments stripped. Every assertion below is about what the CODE
 * does; these modules document at length WHY they must not read
 * jobs.practical_completion_date or send anything, and prose saying "we never do
 * X" must never be able to fail — or pass — a test about doing X.
 */
const read = (p: string) =>
  readRaw(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const LOADER = read("app/customer-portal/_warranties.ts");
const PORTAL_PAGE = read("app/customer-portal/[token]/warranties/page.tsx");
const OPERATOR_PAGE = read("app/(app)/jobs/[id]/warranties/page.tsx");
const OPERATOR_ACTIONS = read("app/(app)/jobs/[id]/warranties/actions.ts");
/** DDL only — the migration's header explains at length what it does NOT do. */
const MIGRATION = readRaw("supabase/migrations/20261079000000_job_warranties.sql").replace(
  /^\s*--.*$/gm,
  "",
);

const SENTINELS = {
  org_id: "SENTINEL-ORG-UUID",
  created_by: "SENTINEL-STAFF-UUID",
  voided_by: "SENTINEL-VOIDER-UUID",
  portal_published_by: "SENTINEL-PUBLISHER-UUID",
  void_reason: "SENTINEL-INTERNAL-VOID-REASON",
  job_id: "SENTINEL-JOB-UUID",
};

describe("buildPortalWarrantyView — the shape is declared, not inherited", () => {
  const view = buildPortalWarrantyView({
    id: "w1",
    title: "Workmanship warranty",
    kind: "workmanship",
    cover: "All labour on the roof covering.",
    exclusions: null,
    provider: null,
    reference: null,
    periodMonths: 12,
    serviceIntervalMonths: null,
    serviceNotes: null,
    certificateCompletionDate: "2026-03-15",
    today: "2026-07-31",
  });

  it("has exactly the declared key set", () => {
    expect(Object.keys(view).sort()).toEqual([...WARRANTY_PORTAL_KEYS].sort());
  });

  it("derives the dates it exposes", () => {
    expect(view.start_date).toBe("2026-03-15");
    expect(view.expiry_date).toBe("2027-03-15");
    expect(view.awaiting_completion_certificate).toBe(false);
  });

  it("says so — in the payload — when there is no certificate to start from", () => {
    const pending = buildPortalWarrantyView({
      id: "w2",
      title: "Boiler warranty",
      kind: "product",
      cover: "Manufacturer cover on the boiler.",
      exclusions: null,
      provider: null,
      reference: null,
      periodMonths: 24,
      serviceIntervalMonths: 12,
      serviceNotes: null,
      certificateCompletionDate: null,
      today: "2026-07-31",
    });
    expect(pending.awaiting_completion_certificate).toBe(true);
    expect(pending.start_date).toBeNull();
    expect(pending.expiry_date).toBeNull();
    expect(pending.status).toBe("pending_completion");
  });
});

describe("sentinel secrets on the source row never reach the payload", () => {
  const view = buildPortalWarrantyView({
    id: "w1",
    title: "Workmanship warranty",
    kind: "workmanship",
    cover: "All labour on the roof covering.",
    exclusions: null,
    provider: null,
    reference: null,
    periodMonths: 12,
    serviceIntervalMonths: null,
    serviceNotes: null,
    certificateCompletionDate: "2026-03-15",
    today: "2026-07-31",
    // The whole-row shape a spread or a select("*") would produce.
    ...SENTINELS,
  } as Parameters<typeof buildPortalWarrantyView>[0]);
  const json = JSON.stringify(view);

  it.each(Object.entries(SENTINELS))(
    "%s is absent from the serialised payload",
    (key, value) => {
      expect(json).not.toContain(key);
      expect(json).not.toContain(value);
    },
  );
});

describe("the loader can only reach the customer's own warranties", () => {
  it("derives the job-id set from org_id AND customer_id", () => {
    expect(LOADER).toMatch(
      /\.from\("jobs"\)[\s\S]*?\.eq\("org_id", orgId\)[\s\S]*?\.eq\("customer_id", customerId\)/,
    );
  });

  it("filters warranties by that id set AND the org", () => {
    expect(LOADER).toMatch(/\.eq\("org_id", orgId\)[\s\S]*?\.in\("job_id", jobIds\)/);
  });

  it("short-circuits on an empty job set rather than issuing an unfiltered .in()", () => {
    expect(LOADER).toMatch(/if \(jobIds\.length === 0\) return \[\]/);
  });

  it("shows only published, live, non-void warranties", () => {
    expect(LOADER).toMatch(
      /w\.status === "active" && w\.portal_published_at && !w\.portal_withdrawn_at/,
    );
  });

  it("never selects the internal columns", () => {
    const cols = LOADER.slice(
      LOADER.indexOf("const WARRANTY_COLS"),
      LOADER.indexOf("type Res<"),
    );
    for (const internal of ["void_reason", "voided_by", "created_by", "portal_published_by"]) {
      expect(cols, `WARRANTY_COLS must not read ${internal}`).not.toContain(internal);
    }
  });

  it("scopes the certificate lookup to the org and to ISSUED certificates only", () => {
    expect(LOADER).toMatch(/\.eq\("org_id", orgId\)[\s\S]*?\.eq\("status", "issued"\)/);
  });

  it("fails loud on every read", () => {
    expect(LOADER.match(/throw readFailure/g) ?? []).toHaveLength(3);
  });

  it("projects through the builder — no row is ever returned raw", () => {
    expect(LOADER).toContain("buildPortalWarrantyView({");
    expect(LOADER).not.toMatch(/\.\.\.w[,\s}]/);
  });
});

describe("no warranty surface sends anything", () => {
  const SEND_SHAPES = [
    /sendEmail/i,
    /resend/i,
    /nodemailer/i,
    /sendSms/i,
    /twilio/i,
    /\bnotify\w*\(/i,
    /enqueue/i,
  ];

  it.each([
    ["portal page", PORTAL_PAGE],
    ["operator page", OPERATOR_PAGE],
    ["operator actions", OPERATOR_ACTIONS],
    ["portal loader", LOADER],
  ])("%s performs no send", (_name, src) => {
    for (const shape of SEND_SHAPES) expect(src).not.toMatch(shape);
  });

  it("both module headers say so, and both screens tell the reader on the page", () => {
    // Header (raw, comments included) — for whoever edits the module next.
    expect(readRaw("app/(app)/jobs/[id]/warranties/page.tsx")).toMatch(
      /it does not send anything/i,
    );
    expect(readRaw("app/customer-portal/[token]/warranties/page.tsx")).toMatch(
      /NOTHING ON THIS PAGE IS SENT/,
    );
    // Rendered copy (comments stripped) — for the operator and the customer, who
    // must not assume a reminder went out.
    expect(OPERATOR_PAGE).toMatch(/Reminders are shown, never sent/);
    expect(PORTAL_PAGE).toMatch(/don&apos;t send/);
  });

  it("the migration creates no reminder/queue table and no delete-path trigger", () => {
    expect(MIGRATION).not.toMatch(/create table[\s\S]{0,80}reminder/i);
    expect(MIGRATION).not.toMatch(/after\s+delete/i);
    expect(MIGRATION).not.toMatch(/on delete restrict/i);
  });
});

describe("the warranty clock has exactly one source", () => {
  it("the migration refuses any start basis but the completion certificate", () => {
    expect(MIGRATION).toMatch(/check \(start_basis = 'completion_certificate'\)/);
  });

  it("stores no start or expiry date at all", () => {
    const createStmt = MIGRATION.slice(
      MIGRATION.indexOf("create table if not exists public.job_warranties"),
      MIGRATION.indexOf("comment on table public.job_warranties"),
    );
    expect(createStmt).not.toMatch(/\bstart_date\b/);
    expect(createStmt).not.toMatch(/\bexpiry_date\b/);
    expect(createStmt).not.toMatch(/\bcompletion_date\b/);
  });

  it("no warranty surface reads jobs.practical_completion_date", () => {
    for (const src of [LOADER, PORTAL_PAGE, OPERATOR_PAGE, OPERATOR_ACTIONS]) {
      expect(src).not.toContain("practical_completion_date");
    }
  });

  it("the operator page reads the ISSUED certificate, pinned to the active org", () => {
    expect(OPERATOR_PAGE).toMatch(
      /\.eq\("job_id", id\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)[\s\S]*?\.eq\("status", "issued"\)/,
    );
  });
});

describe("operator writes are active-org pinned", () => {
  it("loads the job through the active-org chokepoint", () => {
    expect(OPERATOR_ACTIONS).toMatch(/loadJobForOrg<[\s\S]*?>\(supabase, jobId, ctx\.org\.id/);
  });

  it("every warranty read and write carries org_id = the ACTIVE org", () => {
    expect(OPERATOR_ACTIONS).toMatch(/\.eq\("id", warrantyId\)\s*\n?\s*\.eq\("org_id", orgId\)/);
    const updates = OPERATOR_ACTIONS.match(/\.eq\("id", warrantyId\)\s*\n\s*\.eq\("org_id", ctx\.org\.id\)/g) ?? [];
    expect(updates.length).toBeGreaterThanOrEqual(2);
  });

  it("stamps org_id from the context, never from the form", () => {
    expect(OPERATOR_ACTIONS).toMatch(/org_id: ctx\.org\.id/);
  });

  it("never takes start_basis from user input", () => {
    expect(OPERATOR_ACTIONS).toMatch(/start_basis: "completion_certificate"/);
    expect(OPERATOR_ACTIONS).not.toMatch(/formData\.get\("start_basis"\)/);
  });
});

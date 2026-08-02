import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip TS/JS comments so negative assertions test EXECUTABLE code. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/**
 * H2-CIS M5 — trust-boundary pins for the CSV export and statement emailing.
 *
 * Hermetic: source contracts, no database. This tier stops the two controls that
 * matter most from being quietly loosened later:
 *
 *   1. THE FILING BOUNDARY. Producing a CSV or emailing a subcontractor their
 *      statement is NOT filing with HMRC. If any of these files ever grow an
 *      HMRC endpoint, a "submit/file" verb or a network call, a download or an
 *      email could be misread as a statutory submission that never happened.
 *   2. THE FABRICATION / LEAK BOUNDARY. The bulk export never emits an unmasked
 *      UTR (the full UTR has one home — the admin-gated per-statement PDF), and
 *      the emailing path is org-scoped and dark-safe.
 */

const NEW_FILES = [
  "lib/cis/export-csv.ts",
  "lib/cis/statement-email.ts",
  "server/services/cis-statement-emails.ts",
  "app/api/cis/returns/[id]/export.csv/route.ts",
  "app/api/cis/statements/export.csv/route.ts",
  "app/(app)/cis/actions.ts",
];

// ---------------------------------------------------------------------------
// 1. The filing boundary
// ---------------------------------------------------------------------------

describe("CIS M5 export/email never files anything with HMRC", () => {
  it("reaches no network endpoint, gateway or HMRC client in any new file", () => {
    for (const f of NEW_FILES) {
      const src = codeOf(read(f));
      expect(src, `${f} must not reach a non-gov network endpoint`).not.toMatch(
        /https?:\/\/(?!www\.gov\.uk)/i,
      );
      expect(src, `${f} must not call HMRC`).not.toMatch(
        /government\s*gateway|hmrc[-_]?(api|client|token|credential)/i,
      );
      expect(src, `${f} must not fetch`).not.toMatch(/\bfetch\s*\(|axios|got\(/);
    }
  });

  it("names the emailing action for what it does — never submit/file/send to HMRC", () => {
    const actions = codeOf(read("app/(app)/cis/actions.ts"));
    expect(actions).toMatch(/export\s+async\s+function\s+emailCisStatements/);
    expect(actions).not.toMatch(/function\s+(submit|file|send)Cis(Return|Statement)/i);
  });

  it("carries the no-filing wording to the subcontractor and in the export copy", () => {
    // The subcontractor-facing body carries it as executable copy…
    expect(codeOf(read("lib/cis/statement-email.ts"))).toMatch(/not a submission to HMRC/i);
    // …and the export module documents the boundary explicitly (raw source).
    expect(read("lib/cis/export-csv.ts")).toMatch(/NOTHING HERE FILES ANYTHING WITH HMRC/i);
  });
});

// ---------------------------------------------------------------------------
// 2. The leak boundary — masked UTR only in the bulk export
// ---------------------------------------------------------------------------

describe("CIS M5 export never becomes a second unmasked-UTR home", () => {
  it("the CSV builder selects the MASKED utr and never a bare full utr column", () => {
    const src = codeOf(read("lib/cis/export-csv.ts"));
    expect(src).toMatch(/subcontractor_utr_masked/);
    // A `utr:` mapping to a raw value would be a leak; the builder must not have one.
    expect(src).not.toMatch(/\butr\b\s*:/i);
    expect(src).not.toMatch(/getCisProfile|\.utr\b/);
  });

  it("neither export route reads the unmasked subcontractor source", () => {
    for (const f of [
      "app/api/cis/returns/[id]/export.csv/route.ts",
      "app/api/cis/statements/export.csv/route.ts",
    ]) {
      const src = codeOf(read(f));
      expect(src, `${f} must not read cis_subcontractors / getCisProfile`).not.toMatch(
        /getCisProfile|cis_subcontractors/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Tenancy — org-scoped reads, dark-safe emailing
// ---------------------------------------------------------------------------

describe("CIS M5 emailing is org-scoped and dark-safe", () => {
  const svc = codeOf(read("server/services/cis-statement-emails.ts"));

  it("pins org_id on every queue read and reads statements through the RLS-gated path", () => {
    // The queue is service-role-only, so its reads/writes use the admin client —
    // but each must pin org_id (#456). Statements come via listStatements (tenant).
    expect(svc).toMatch(/\.eq\("org_id", orgId\)/);
    expect(svc).toMatch(/listStatements\(orgId/);
  });

  it("does not send email itself — it only enqueues; the shared drain sends", () => {
    // Reusing the queue is what keeps sending dark by default (no key ⇒ skipped)
    // and avoids a second email provider. A direct sendEmail here would bypass
    // both the queue's retry/idempotency and the dark default.
    expect(svc).not.toMatch(/from "@\/lib\/email\/send"/);
    expect(svc).not.toMatch(/\bsendEmail\s*\(/);
    expect(svc).toMatch(/notification_email_queue/);
  });

  it("creates a transactional email (notification_id: null), not an in-app notification", () => {
    // A subcontractor is not a CrewFlow user; queuing must not spawn an in-app
    // notification row addressed to nobody.
    expect(svc).toMatch(/notification_id:\s*null/);
  });

  it("both export routes are admin-gated with an explicit role check", () => {
    for (const f of [
      "app/api/cis/returns/[id]/export.csv/route.ts",
      "app/api/cis/statements/export.csv/route.ts",
    ]) {
      const src = codeOf(read(f));
      expect(src, `${f} must check the admin role`).toMatch(/isAdminRole|role === "owner"/);
      expect(src, `${f} must return 403 for non-admins`).toMatch(/status:\s*403/);
    }
  });
});

import { describe, expect, it } from "vitest";

import {
  cisStatementEmailBody,
  cisStatementEmailSubject,
  CIS_STATEMENT_EMAIL_SUBJECT_PREFIX,
  planStatementEmails,
  type CisStatementForEmail,
} from "@/lib/cis/statement-email";

/**
 * H2-CIS M5 — the statement-emailing plan.
 *
 * The one property that matters for a tax document sent to a third party:
 * IDEMPOTENCY. A subcontractor must receive each statement exactly once per
 * period. The plan is also honest about who it does NOT email (gross-paid,
 * no-email-on-file, superseded/withdrawn) rather than dropping them silently.
 */

function stmt(over: Partial<CisStatementForEmail> = {}): CisStatementForEmail {
  return {
    id: "st1",
    supplier_id: "s1",
    statement_number: "CIS-2026-0001",
    status: "issued",
    subcontractor_name: "Groundworks Ltd",
    contractor_name: "D J Smith Ltd",
    contractor_paye_reference: "123/AB45678",
    tax_month_start: "2026-07-06",
    tax_month_end: "2026-08-05",
    statement_due_on: "2026-08-19",
    gross_amount: 1000,
    materials_amount: 200,
    deduction_amount: 160,
    rate_is_uniform: true,
    deduction_rate: 20,
    is_statutory: true,
    ...over,
  };
}

const emails = (pairs: Array<[string, string]>) => new Map<string, string>(pairs);

describe("planStatementEmails — idempotency", () => {
  it("queues each issued statutory statement once when nothing is queued yet", () => {
    const plan = planStatementEmails({
      statements: [stmt({ id: "a", supplier_id: "s1", statement_number: "CIS-1" })],
      emailBySupplier: emails([["s1", "sub@example.com"]]),
      existingKeys: new Set(),
    });
    expect(plan.toQueue).toHaveLength(1);
    expect(plan.toQueue[0]!.toEmail).toBe("sub@example.com");
    expect(plan.toQueue[0]!.subject).toBe(cisStatementEmailSubject("CIS-1"));
  });

  it("re-running with the first run's subjects as existingKeys queues NOTHING new", () => {
    const statements = [
      stmt({ id: "a", supplier_id: "s1", statement_number: "CIS-1" }),
      stmt({ id: "b", supplier_id: "s2", statement_number: "CIS-2", subcontractor_name: "Roofing Ltd" }),
    ];
    const emailBySupplier = emails([
      ["s1", "one@example.com"],
      ["s2", "two@example.com"],
    ]);

    const first = planStatementEmails({ statements, emailBySupplier, existingKeys: new Set() });
    expect(first.toQueue).toHaveLength(2);

    // Simulate the queue now holding the subjects the first run inserted.
    const existingKeys = new Set(first.toQueue.map((q) => q.subject));
    const second = planStatementEmails({ statements, emailBySupplier, existingKeys });
    expect(second.toQueue).toHaveLength(0);
    expect(second.skipped.every((s) => s.reason === "already_queued")).toBe(true);
  });

  it("keys idempotency on the statement NUMBER, so a reissue is emailed again", () => {
    // A reissue supersedes the old statement and gets a NEW number, so it is a
    // new subject and correctly a new email.
    const existingKeys = new Set([cisStatementEmailSubject("CIS-1")]);
    const plan = planStatementEmails({
      statements: [stmt({ id: "b", supplier_id: "s1", statement_number: "CIS-2-reissue" })],
      emailBySupplier: emails([["s1", "sub@example.com"]]),
      existingKeys,
    });
    expect(plan.toQueue).toHaveLength(1);
    expect(plan.toQueue[0]!.statementNumber).toBe("CIS-2-reissue");
  });
});

describe("planStatementEmails — exclusions are explicit", () => {
  it("skips a gross-paid (non-statutory) statement with a reason", () => {
    const plan = planStatementEmails({
      statements: [stmt({ is_statutory: false, deduction_amount: 0 })],
      emailBySupplier: emails([["s1", "sub@example.com"]]),
      existingKeys: new Set(),
    });
    expect(plan.toQueue).toHaveLength(0);
    expect(plan.skipped[0]!.reason).toBe("not_statutory");
  });

  it("skips a subcontractor with no email on file, with a reason", () => {
    const plan = planStatementEmails({
      statements: [stmt()],
      emailBySupplier: emails([]),
      existingKeys: new Set(),
    });
    expect(plan.toQueue).toHaveLength(0);
    expect(plan.skipped[0]!.reason).toBe("no_email");
  });

  it("skips superseded and withdrawn statements — the subcontractor is owed the current one", () => {
    const plan = planStatementEmails({
      statements: [
        stmt({ id: "a", status: "superseded" }),
        stmt({ id: "b", supplier_id: "s2", status: "withdrawn" }),
      ],
      emailBySupplier: emails([
        ["s1", "one@example.com"],
        ["s2", "two@example.com"],
      ]),
      existingKeys: new Set(),
    });
    expect(plan.toQueue).toHaveLength(0);
    expect(plan.skipped.map((s) => s.reason).sort()).toEqual(["not_issued", "not_issued"]);
  });

  it("treats a whitespace-only email as no email", () => {
    const plan = planStatementEmails({
      statements: [stmt()],
      emailBySupplier: emails([["s1", "   "]]),
      existingKeys: new Set(),
    });
    expect(plan.skipped[0]!.reason).toBe("no_email");
  });
});

describe("statement email content", () => {
  it("subject carries the stable prefix and the statement number (the dedupe key)", () => {
    const subject = cisStatementEmailSubject("CIS-2026-0001");
    expect(subject.startsWith(CIS_STATEMENT_EMAIL_SUBJECT_PREFIX)).toBe(true);
    expect(subject).toContain("CIS-2026-0001");
  });

  it("body restates the frozen figures and does NOT claim a filing", () => {
    const body = cisStatementEmailBody(stmt());
    expect(body).toContain("Groundworks Ltd");
    expect(body).toContain("£1,000.00"); // gross
    expect(body).toContain("£160.00"); // deduction
    expect(body).toMatch(/not a submission to HMRC/i);
  });

  it("says the rate varied rather than inventing one when it is not uniform", () => {
    const body = cisStatementEmailBody(stmt({ rate_is_uniform: false, deduction_rate: null }));
    expect(body).toMatch(/rate varied within the month/i);
  });
});

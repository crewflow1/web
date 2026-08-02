import { describe, expect, it } from "vitest";
import {
  composeEotNotice,
  EOT_NOTICE_DISCLAIMER,
  NOT_SPECIFIED,
  type EotNoticeInput,
} from "@/lib/eot/letter";

/**
 * EOT notice-of-delay composer (pure). Fixtures cover: a fully-linked recorded
 * event (every fact transcribed, quantum passed through untouched), an
 * ongoing/unquantified event, and — the load-bearing case — a bare event whose
 * absent contract terms render as [not specified] and are NEVER fabricated.
 */

const NOTICE_DATE = "2026-08-02T09:30:00.000Z";

function input(overrides: Partial<EotNoticeInput> = {}): EotNoticeInput {
  return {
    contractor: { name: "Acme Builders Ltd", address: "1 Trade St, Leeds, LS1 1AA" },
    employer: { name: "Riverside Developments", address: null },
    jobReference: "Riverside Developments · 2026-06-01",
    contractReference: null,
    contractClause: null,
    contractCompletionDate: null,
    diaryEntryDate: null,
    variation: null,
    event: {
      id: "11112222-3333-4444-5555-666677778888",
      category: "weather",
      status: "recorded",
      startedOn: "2026-07-01",
      endedOn: "2026-07-03",
      workingDaysLost: 2,
      description: "Storm stopped roofing works for two days.",
    },
    noticeDate: NOTICE_DATE,
    ...overrides,
  };
}

function particular(notice: ReturnType<typeof composeEotNotice>, label: string) {
  const f = notice.particulars.find((p) => p.label === label);
  if (!f) throw new Error(`no particular labelled "${label}"`);
  return f;
}

describe("composeEotNotice · deterministic facts", () => {
  it("stamps the notice date (day key) and a stable reference from the event id", () => {
    const n = composeEotNotice(input());
    expect(n.noticeDate).toBe("2026-08-02");
    expect(n.reference).toBe("EOT/11112222");
  });

  it("is deterministic — same input, byte-identical output", () => {
    expect(composeEotNotice(input())).toEqual(composeEotNotice(input()));
  });

  it("transcribes parties, cause and period from the record", () => {
    const n = composeEotNotice(input());
    expect(n.contractor.name.value).toBe("Acme Builders Ltd");
    expect(n.contractor.name.specified).toBe(true);
    expect(n.employer.name.value).toBe("Riverside Developments");
    expect(particular(n, "Nature of delay").value).toBe("Weather");
    expect(particular(n, "Period of delay").value).toBe("2026-07-01 to 2026-07-03");
    expect(particular(n, "Cause of delay").value).toBe("Storm stopped roofing works for two days.");
  });

  it("passes the recorder's working-days claim through untouched, never computed", () => {
    const n = composeEotNotice(input());
    const ext = particular(n, "Extension of time claimed");
    expect(ext.value).toBe("2 working days");
    expect(ext.specified).toBe(true);
    // The claim reflects the stored 2, NOT the 3 calendar days spanned.
    expect(n.statements.some((s) => s.includes("2 working days"))).toBe(true);
    expect(n.statements.some((s) => s.includes("has not been calculated from the calendar"))).toBe(
      true,
    );
    expect(n.statements.join(" ")).not.toContain("3 working days");
  });

  it("carries the standing disclaimer verbatim and never asserts entitlement", () => {
    const n = composeEotNotice(input());
    expect(n.disclaimer).toBe(EOT_NOTICE_DISCLAIMER);
    expect(n.disclaimer).toMatch(/does not itself assert contractual entitlement/i);
    expect(n.statements.some((s) => /reserved for determination/i.test(s))).toBe(true);
  });

  it("singular working day is not pluralised", () => {
    const n = composeEotNotice(
      input({ event: { ...input().event, workingDaysLost: 1 } }),
    );
    expect(particular(n, "Extension of time claimed").value).toBe("1 working day");
  });
});

describe("composeEotNotice · absent fields become explicit placeholders, never fabrication", () => {
  it("a bare event renders every absent contract term as [not specified] and lists them", () => {
    const n = composeEotNotice(
      input({
        employer: { name: null, address: null },
        jobReference: null,
        contractReference: null,
        contractClause: null,
        contractCompletionDate: null,
      }),
    );
    for (const label of [
      "Contract reference",
      "Clause relied upon",
      "Project / works",
      "Contract completion date",
      "Revised completion date sought",
      "Records relied upon",
    ]) {
      const f = particular(n, label);
      expect(f.value, `${label} should be the placeholder`).toBe(NOT_SPECIFIED);
      expect(f.specified).toBe(false);
      expect(n.unspecified).toContain(label);
    }
    expect(n.employer.name.value).toBe(NOT_SPECIFIED);
    expect(n.employer.address.value).toBe(NOT_SPECIFIED);
  });

  it("invents NO clause, date or figure anywhere in the output for a bare event", () => {
    const n = composeEotNotice(
      input({
        jobReference: null, // isolate to the event's own dates
        contractReference: null,
        contractClause: null,
        contractCompletionDate: null,
        variation: null,
        event: { ...input().event, workingDaysLost: null },
      }),
    );
    const haystack = [
      ...n.particulars.map((p) => p.value),
      ...n.statements,
    ].join(" \n ");
    // No clause pattern (e.g. "clause 2.27", "cl 61"), no invented completion date.
    expect(haystack).not.toMatch(/clause\s+\d/i);
    expect(haystack).not.toMatch(/cl\.?\s*\d/i);
    // The only dates present are the recorded event dates — no fabricated ones.
    const dates = haystack.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
    expect(new Set(dates)).toEqual(new Set(["2026-07-01", "2026-07-03"]));
  });

  it("an ongoing, unquantified event states the facts without a placeholder for the period", () => {
    const n = composeEotNotice(
      input({
        event: { ...input().event, endedOn: null, workingDaysLost: null },
      }),
    );
    const period = particular(n, "Period of delay");
    expect(period.specified).toBe(true); // ongoing is a recorded fact, not an absent field
    expect(period.value).toMatch(/ongoing/i);
    expect(n.unspecified).not.toContain("Period of delay");
    const ext = particular(n, "Extension of time claimed");
    expect(ext.value).toBe(NOT_SPECIFIED);
    expect(n.unspecified).toContain("Extension of time claimed");
    expect(n.statements.some((s) => /not yet been quantified/i.test(s))).toBe(true);
  });
});

describe("composeEotNotice · linked evidence", () => {
  it("assembles diary + variation into the records-relied-upon particular and body", () => {
    const n = composeEotNotice(
      input({
        diaryEntryDate: "2026-07-01",
        variation: {
          number: 3,
          title: "Storm remedials",
          requestedCompletionDate: "2026-09-01",
          agreedCompletionDate: null,
        },
      }),
    );
    const evidence = particular(n, "Records relied upon");
    expect(evidence.specified).toBe(true);
    expect(evidence.value).toContain("Site diary entry dated 2026-07-01");
    expect(evidence.value).toContain("Variation #003 — Storm remedials");
    expect(particular(n, "Revised completion date sought").value).toBe("2026-09-01");
    expect(n.statements.some((s) => s.includes("Variation #003"))).toBe(true);
  });
});

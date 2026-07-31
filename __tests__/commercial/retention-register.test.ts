import { describe, it, expect } from "vitest";
import { round2 } from "@/lib/money";
import { computeRetentionPosition } from "@/lib/retentions/compute";
import {
  buildRetentionRegister,
  resolveCompletionDate,
  retentionClaimableNow,
  type RegisterJob,
} from "@/lib/commercial/retention-register";

/**
 * The retention register — the state model, the date that governs it, and the
 * reconciliation back to the retention authority.
 *
 * These are the three things a contractor's argument at a client meeting rests
 * on: the right amount, the right date, and evidence for the date.
 */

const TODAY = "2026-07-30";

function job(over: Partial<RegisterJob> = {}): RegisterJob {
  return {
    jobId: "job-1",
    jobLabel: "12 Mill Lane, Leeds",
    customerId: "cust-1",
    customerName: "Northgate Homes",
    ratePercent: 5,
    defectsLiabilityMonths: 12,
    firstReleasePct: 50,
    jobCompletionDate: null,
    certificateCompletionDate: null,
    certificateNumber: null,
    // 5% of £100,000 certified = £5,000 accrued; £2,500 per moiety.
    invoices: [{ status: "sent", amount: 100_000 }],
    releases: [],
    ...over,
  };
}

describe("which practical-completion date governs", () => {
  it("an issued certificate's frozen date beats the job's working field", () => {
    // The certificate is the contractual instrument the client signed off; the
    // job field is a note somebody typed. Precedence must not be the other way.
    expect(
      resolveCompletionDate({
        certificateCompletionDate: "2026-01-15",
        jobCompletionDate: "2026-03-01",
      }),
    ).toEqual({ date: "2026-01-15", source: "certificate" });
  });

  it("falls back to the job field when there is no certificate", () => {
    expect(
      resolveCompletionDate({
        certificateCompletionDate: null,
        jobCompletionDate: "2026-03-01",
      }),
    ).toEqual({ date: "2026-03-01", source: "job" });
  });

  it("reports no date rather than inventing one", () => {
    expect(
      resolveCompletionDate({ certificateCompletionDate: null, jobCompletionDate: null }),
    ).toEqual({ date: null, source: "none" });
  });

  it("the certificate number is surfaced ONLY when the certificate governs", () => {
    const certified = buildRetentionRegister({
      jobs: [
        job({
          certificateCompletionDate: "2026-01-15",
          certificateNumber: "CERT-0007",
          jobCompletionDate: "2026-06-01",
        }),
      ],
      todayIso: TODAY,
    });
    expect(certified.lines[0]!.completionSource).toBe("certificate");
    expect(certified.lines[0]!.certificateNumber).toBe("CERT-0007");

    // A stale certificate number on a job whose cert was never issued must not
    // be presented as evidence for the job field's date.
    const uncertified = buildRetentionRegister({
      jobs: [
        job({
          certificateCompletionDate: null,
          certificateNumber: "CERT-0007",
          jobCompletionDate: "2026-06-01",
        }),
      ],
      todayIso: TODAY,
    });
    expect(uncertified.lines[0]!.completionSource).toBe("job");
    expect(uncertified.lines[0]!.certificateNumber).toBeNull();
  });

  it("the certificate date drives the DEFECTS date too, not just the first release", () => {
    // PC starts the defects clock, so choosing the wrong PC date moves BOTH
    // moieties. Certificate 2026-01-15 + 12 months = 2027-01-15.
    const r = buildRetentionRegister({
      jobs: [
        job({
          certificateCompletionDate: "2026-01-15",
          certificateNumber: "CERT-0007",
          jobCompletionDate: "2026-06-01",
        }),
      ],
      todayIso: TODAY,
    });
    const second = r.lines.find((l) => l.moiety === "second")!;
    expect(second.dueDate).toBe("2027-01-15");
  });
});

describe("the state model", () => {
  it("a passed practical-completion date makes the FIRST moiety overdue", () => {
    const r = buildRetentionRegister({
      jobs: [job({ jobCompletionDate: "2026-01-15" })],
      todayIso: TODAY,
    });
    const first = r.lines.find((l) => l.moiety === "first")!;
    expect(first.state).toBe("overdue");
    expect(first.remaining).toBe(2500);
    expect(first.daysPastDue).toBe(196);
  });

  it("EXACTLY on the completion date it is `due`, not overdue", () => {
    // Same boundary as isInvoiceOverdue — money is not late on the day it falls
    // due, and calling it late would be a false accusation in a client meeting.
    const r = buildRetentionRegister({
      jobs: [job({ jobCompletionDate: TODAY })],
      todayIso: TODAY,
    });
    const first = r.lines.find((l) => l.moiety === "first")!;
    expect(first.state).toBe("due");
    expect(first.daysPastDue).toBeNull();
  });

  it("one day past the completion date it flips to overdue", () => {
    const r = buildRetentionRegister({
      jobs: [job({ jobCompletionDate: "2026-07-29" })],
      todayIso: TODAY,
    });
    expect(r.lines.find((l) => l.moiety === "first")!.state).toBe("overdue");
    expect(r.lines.find((l) => l.moiety === "first")!.daysPastDue).toBe(1);
  });

  it("the DEFECTS moiety is never `overdue`, however long past its date", () => {
    // It is due FROM the end of the defects period: the certificate of making
    // good can legitimately slip, so a red "overdue" would train operators to
    // ignore the colour. The elapsed days are still reported.
    const r = buildRetentionRegister({
      jobs: [job({ jobCompletionDate: "2024-01-01", defectsLiabilityMonths: 12 })],
      todayIso: TODAY,
    });
    const second = r.lines.find((l) => l.moiety === "second")!;
    expect(second.dueDate).toBe("2025-01-01");
    expect(second.dueFrom).toBe(true);
    expect(second.state).toBe("due");
    expect(second.daysPastDue).toBe(575);
  });

  it("a future completion date is `held` with no daysPastDue", () => {
    const r = buildRetentionRegister({
      jobs: [job({ jobCompletionDate: "2027-01-01" })],
      todayIso: TODAY,
    });
    for (const line of r.lines) {
      expect(line.state).toBe("held");
      // Never 0 — a UI must not be able to render "0 days" for money that is
      // not claimable yet.
      expect(line.daysPastDue).toBeNull();
    }
  });

  it("retention with NO completion date anywhere is awaiting_completion, never due", () => {
    const r = buildRetentionRegister({ jobs: [job()], todayIso: TODAY });
    expect(r.lines).toHaveLength(2);
    for (const line of r.lines) {
      expect(line.state).toBe("awaiting_completion");
      expect(line.dueDate).toBeNull();
    }
    expect(r.totals.outstandingByState.due).toBe(0);
    expect(r.totals.outstandingByState.overdue).toBe(0);
    expect(r.totals.outstandingByState.awaiting_completion).toBe(5000);
  });

  it("a released moiety reads `released` and owes nothing", () => {
    const r = buildRetentionRegister({
      jobs: [job({ jobCompletionDate: "2026-01-15", releases: [{ amount: 2500 }] })],
      todayIso: TODAY,
    });
    const first = r.lines.find((l) => l.moiety === "first")!;
    expect(first.state).toBe("released");
    expect(first.remaining).toBe(0);
    // FIFO waterfall: the release filled the first moiety, so the second is
    // untouched and still upcoming.
    expect(r.lines.find((l) => l.moiety === "second")!.remaining).toBe(2500);
  });

  it("a job with no retention rate produces no lines at all", () => {
    const r = buildRetentionRegister({
      jobs: [job({ ratePercent: 0, jobCompletionDate: "2026-01-15" })],
      todayIso: TODAY,
    });
    expect(r.lines).toHaveLength(0);
    expect(r.totals.jobCount).toBe(0);
  });

  it("a retention job with only DRAFT invoices accrues nothing and is omitted", () => {
    // Draft invoices are not certified, so there is no retention base yet.
    const r = buildRetentionRegister({
      jobs: [job({ invoices: [{ status: "draft", amount: 100_000 }] })],
      todayIso: TODAY,
    });
    expect(r.lines).toHaveLength(0);
  });
});

describe("reconciliation with the retention authority", () => {
  it("outstanding across every line EQUALS held across every job", () => {
    const jobs = [
      job({ jobId: "j1", jobCompletionDate: "2026-01-15", releases: [{ amount: 1000 }] }),
      job({
        jobId: "j2",
        ratePercent: 3,
        invoices: [{ status: "sent", amount: 47_333.33 }, { status: "paid", amount: 12_000 }],
        jobCompletionDate: "2025-11-01",
        defectsLiabilityMonths: 6,
        firstReleasePct: 60,
        releases: [{ amount: 250.5 }],
      }),
      job({ jobId: "j3", ratePercent: 5, jobCompletionDate: null }),
      job({ jobId: "j4", ratePercent: 0 }),
    ];
    const register = buildRetentionRegister({ jobs, todayIso: TODAY });

    const lineOutstanding = register.lines.reduce((acc, l) => round2(acc + l.remaining), 0);
    expect(lineOutstanding).toBe(register.totals.held);

    // …and `held` itself is the authority's figure, not a second derivation.
    const authorityHeld = jobs.reduce(
      (acc, j) =>
        round2(
          acc +
            computeRetentionPosition({
              ratePercent: j.ratePercent,
              invoices: j.invoices,
              releases: j.releases,
            }).held,
        ),
      0,
    );
    expect(register.totals.held).toBe(authorityHeld);
  });

  it("the per-state split partitions `held` with nothing lost", () => {
    const register = buildRetentionRegister({
      jobs: [
        job({ jobId: "a", jobCompletionDate: "2026-01-15" }),
        job({ jobId: "b", jobCompletionDate: "2027-06-01" }),
        job({ jobId: "c", jobCompletionDate: null }),
      ],
      todayIso: TODAY,
    });
    const s = register.totals.outstandingByState;
    expect(round2(s.overdue + s.due + s.held + s.awaiting_completion + s.released)).toBe(
      register.totals.held,
    );
    // A released line contributes zero outstanding by construction.
    expect(s.released).toBe(0);
  });

  it("accrued and released come straight from the authority", () => {
    const register = buildRetentionRegister({
      jobs: [job({ releases: [{ amount: 1234.56 }], jobCompletionDate: "2026-01-15" })],
      todayIso: TODAY,
    });
    expect(register.totals.accrued).toBe(5000);
    expect(register.totals.released).toBe(1234.56);
    expect(register.totals.held).toBe(3765.44);
  });

  it("claimable-now is overdue plus due, and nothing else", () => {
    const register = buildRetentionRegister({
      jobs: [
        job({ jobId: "overdue-job", jobCompletionDate: "2026-01-15", defectsLiabilityMonths: 120 }),
        job({ jobId: "future-job", jobCompletionDate: "2027-06-01" }),
        job({ jobId: "no-date-job", jobCompletionDate: null }),
      ],
      todayIso: TODAY,
    });
    const t = register.totals;
    expect(retentionClaimableNow(t)).toBe(
      round2(t.outstandingByState.overdue + t.outstandingByState.due),
    );
    // The first job's PC moiety only — its defects moiety is 10 years out.
    expect(retentionClaimableNow(t)).toBe(2500);
  });
});

describe("counts and ordering", () => {
  it("counts jobs holding retention and jobs with an overdue release", () => {
    const register = buildRetentionRegister({
      jobs: [
        job({ jobId: "a", jobCompletionDate: "2026-01-15" }),
        job({ jobId: "b", jobCompletionDate: "2027-06-01" }),
        job({ jobId: "c", releases: [{ amount: 5000 }], jobCompletionDate: "2026-01-15" }),
      ],
      todayIso: TODAY,
    });
    expect(register.totals.jobCount).toBe(3);
    expect(register.totals.jobsHoldingCount).toBe(2);
    expect(register.totals.jobsOverdueCount).toBe(1);
  });

  it("lines are worst-state first, then biggest money — a total order", () => {
    const build = (jobs: RegisterJob[]) =>
      buildRetentionRegister({ jobs, todayIso: TODAY }).lines.map((l) => l.id);
    const jobs = [
      job({ jobId: "future", jobCompletionDate: "2027-06-01" }),
      job({ jobId: "late-small", jobCompletionDate: "2026-01-15", invoices: [{ status: "sent", amount: 20_000 }] }),
      job({ jobId: "late-big", jobCompletionDate: "2026-01-15", invoices: [{ status: "sent", amount: 200_000 }] }),
    ];
    const order = build(jobs);
    expect(order.slice(0, 2)).toEqual(["late-big:first", "late-small:first"]);
    // Reversing the input must not change the output order.
    expect(build([...jobs].reverse())).toEqual(order);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * RETENTION REGISTER — active-org scoping, evidence integrity, and read-only.
 *
 * ── THE DEFECT CLASS ─────────────────────────────────────────────────────────
 * `current_org_ids()` admits every org the viewer belongs to, so an unpinned read
 * would put both companies' retention in one register. That is the class the repo
 * closed over six read-side slices, and it is worse here than on most surfaces:
 * the register exists to be taken into a meeting and argued from, so a blended
 * total is a claim made against the wrong client for the wrong amount.
 *
 * ── EVIDENCE INTEGRITY IS ALSO A SECURITY PROPERTY HERE ──────────────────────
 * The register's dates come from `completion_certificates`, and only an ISSUED
 * certificate is evidence. A draft, superseded or archived certificate's date
 * must never be presented as certified — that would put a number in front of a
 * client backed by a document that does not exist. Pinned behaviourally below,
 * including the case where a job has BOTH a draft and an issued certificate.
 *
 * The service is EXECUTED against a chainable Supabase mock that honours its
 * filters and is seeded with two orgs, because a source grep for
 * `.eq("org_id", ...)` can be satisfied on the wrong table or on one read of
 * five. The source pins are the tripwire on top of the behavioural proof.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const h = vi.hoisted(() => {
  const reads: Array<{ table: string; eqs: Array<[string, unknown]> }> = [];
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  const failing = new Set<string>();

  function makeBuilder(table: string) {
    const rec = { table, eqs: [] as Array<[string, unknown]> };
    reads.push(rec);
    const builder = {
      select: () => builder,
      eq(col: string, val: unknown) {
        rec.eqs.push([col, val]);
        return builder;
      },
      order: () => builder,
      range: () => {
        if (failing.has(table)) {
          return Promise.resolve({ data: null, error: { message: `${table} exploded` } });
        }
        const rows = (tables[table] ?? []).filter((row) =>
          rec.eqs.every(([col, val]) => row[col] === val),
        );
        return Promise.resolve({ data: rows, error: null });
      },
    };
    return builder;
  }

  return {
    reads,
    tables,
    failing,
    client: { from: (t: string) => makeBuilder(t) },
    reset() {
      reads.length = 0;
      for (const k of Object.keys(tables)) delete tables[k];
      failing.clear();
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => h.client,
}));

const { buildRetentionRegisterView } = await import("@/server/services/retention-register");

const ORG_A = "org-aaaa";
const ORG_B = "org-bbbb";
const NOW = new Date("2026-07-30T09:00:00Z");

/**
 * Both companies hold retention for the SAME customer id. Without that overlap a
 * missing org filter would still produce separate-looking rows and pass.
 */
function seedTwoOrgs() {
  h.tables.jobs = [
    {
      id: "job-a",
      org_id: ORG_A,
      customer_id: "cust-shared",
      site_address_line1: "12 Mill Lane",
      site_city: "Leeds",
      site_postcode: "LS1 1AA",
      retention_percent: 5,
      practical_completion_date: "2026-06-01",
      defects_liability_months: 12,
      retention_first_release_pct: 50,
    },
    {
      id: "job-b",
      org_id: ORG_B,
      customer_id: "cust-shared",
      site_address_line1: "99 Other Road",
      site_city: "Hull",
      site_postcode: "HU1 1AA",
      retention_percent: 5,
      practical_completion_date: "2026-06-01",
      defects_liability_months: 12,
      retention_first_release_pct: 50,
    },
  ];
  h.tables.invoices = [
    // Org A — £100,000 certified → £5,000 accrued.
    { id: "inv-a", org_id: ORG_A, job_id: "job-a", status: "sent", amount: 100_000 },
    // Org B — £900,000 certified → £45,000 accrued. Must never reach org A.
    { id: "inv-b", org_id: ORG_B, job_id: "job-b", status: "sent", amount: 900_000 },
  ];
  h.tables.retention_releases = [
    { id: "rel-a", org_id: ORG_A, job_id: "job-a", amount: 1000 },
    { id: "rel-b", org_id: ORG_B, job_id: "job-b", amount: 20_000 },
  ];
  h.tables.customers = [
    { id: "cust-shared", org_id: ORG_A, name: "Shared Developments (A)" },
    { id: "cust-shared", org_id: ORG_B, name: "Shared Developments (B)" },
  ];
  h.tables.completion_certificates = [];
}

beforeEach(() => {
  h.reset();
  seedTwoOrgs();
});

// ---------------------------------------------------------------------------
// 1. behavioural — the dual-org proof
// ---------------------------------------------------------------------------

describe("dual-org: retention ages only within the active org", () => {
  it("the register holds ONLY the active org's accrual and releases", async () => {
    const view = await buildRetentionRegisterView(ORG_A, NOW);
    expect(view.loadError).toBe(false);
    expect(view.register.totals.accrued).toBe(5000);
    expect(view.register.totals.released).toBe(1000);
    expect(view.register.totals.held).toBe(4000);
    expect(view.register.totals.jobCount).toBe(1);
    expect(view.register.lines.every((l) => l.jobId === "job-a")).toBe(true);
  });

  it("the other org sees its own figures from the same seeded data", async () => {
    const view = await buildRetentionRegisterView(ORG_B, NOW);
    expect(view.register.totals.accrued).toBe(45_000);
    expect(view.register.totals.held).toBe(25_000);
    expect(view.register.lines[0]!.customerName).toBe("Shared Developments (B)");
  });

  it("an invoice from the other org cannot inflate this org's retention base", async () => {
    const view = await buildRetentionRegisterView(ORG_A, NOW);
    // 5% of org A's £100,000 only. Blending would give 5% of £1,000,000.
    expect(view.register.totals.accrued).toBe(5000);
  });

  it("a release recorded in the other org cannot discharge this org's retention", async () => {
    const view = await buildRetentionRegisterView(ORG_A, NOW);
    expect(view.register.totals.released).toBe(1000);
  });

  it("EVERY read carries an org_id filter equal to the active org", async () => {
    await buildRetentionRegisterView(ORG_A, NOW);
    expect(h.reads.length).toBeGreaterThanOrEqual(5);
    for (const r of h.reads) {
      const orgEq = r.eqs.find(([c]) => c === "org_id");
      expect(orgEq, `${r.table} read is not org-pinned`).toBeDefined();
      expect(orgEq?.[1], `${r.table} read is pinned to the wrong org`).toBe(ORG_A);
    }
  });

  it("reads exactly the five tables the register needs", async () => {
    await buildRetentionRegisterView(ORG_A, NOW);
    expect([...new Set(h.reads.map((r) => r.table))].sort()).toEqual([
      "completion_certificates",
      "customers",
      "invoices",
      "jobs",
      "retention_releases",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. behavioural — only an ISSUED certificate is evidence
// ---------------------------------------------------------------------------

describe("evidence integrity — only an issued certificate may date a release", () => {
  it("an issued certificate's date overrides the job field and is attributed", async () => {
    h.tables.completion_certificates = [
      {
        id: "cert-1",
        org_id: ORG_A,
        job_id: "job-a",
        status: "issued",
        certificate_number: "CERT-0007",
        completion_date: "2026-01-15",
      },
    ];
    const view = await buildRetentionRegisterView(ORG_A, NOW);
    const first = view.register.lines.find((l) => l.moiety === "first")!;
    expect(first.completionSource).toBe("certificate");
    expect(first.certificateNumber).toBe("CERT-0007");
    expect(first.dueDate).toBe("2026-01-15");
    // The defects clock runs from the CERTIFIED date too.
    expect(view.register.lines.find((l) => l.moiety === "second")!.dueDate).toBe("2027-01-15");
  });

  for (const status of ["draft", "superseded", "archived"]) {
    it(`a ${status} certificate is NOT evidence — the job field still governs`, async () => {
      h.tables.completion_certificates = [
        {
          id: "cert-1",
          org_id: ORG_A,
          job_id: "job-a",
          status,
          certificate_number: "CERT-0007",
          completion_date: "2020-01-01",
        },
      ];
      const view = await buildRetentionRegisterView(ORG_A, NOW);
      const first = view.register.lines.find((l) => l.moiety === "first")!;
      expect(first.completionSource).toBe("job");
      expect(first.certificateNumber).toBeNull();
      expect(first.dueDate).toBe("2026-06-01");
    });
  }

  it("with BOTH a draft and an issued certificate, the issued one wins", async () => {
    h.tables.completion_certificates = [
      { id: "c-draft", org_id: ORG_A, job_id: "job-a", status: "draft", certificate_number: "CERT-0009", completion_date: "2020-01-01" },
      { id: "c-issued", org_id: ORG_A, job_id: "job-a", status: "issued", certificate_number: "CERT-0007", completion_date: "2026-01-15" },
    ];
    const view = await buildRetentionRegisterView(ORG_A, NOW);
    expect(view.register.lines[0]!.certificateNumber).toBe("CERT-0007");
    expect(view.register.lines[0]!.dueDate).toBe("2026-01-15");
  });

  it("another org's certificate cannot date this org's retention", async () => {
    h.tables.completion_certificates = [
      { id: "cert-b", org_id: ORG_B, job_id: "job-a", status: "issued", certificate_number: "CERT-B", completion_date: "2020-01-01" },
    ];
    const view = await buildRetentionRegisterView(ORG_A, NOW);
    expect(view.register.lines[0]!.completionSource).toBe("job");
    expect(view.register.lines[0]!.dueDate).toBe("2026-06-01");
  });

  it("no completion date anywhere is `awaiting_completion`, never a fabricated due date", async () => {
    const jobA = (h.tables.jobs ?? [])[0]!;
    h.tables.jobs = [{ ...jobA, practical_completion_date: null }];
    const view = await buildRetentionRegisterView(ORG_A, NOW);
    expect(view.register.lines.every((l) => l.state === "awaiting_completion")).toBe(true);
    expect(view.register.totals.outstandingByState.overdue).toBe(0);
    expect(view.register.totals.outstandingByState.due).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. behavioural — loud reads
// ---------------------------------------------------------------------------

describe("loud reads — a failed query must never read as 'nothing owed'", () => {
  it("a failed invoices read sets loadError", async () => {
    h.failing.add("invoices");
    const view = await buildRetentionRegisterView(ORG_A, NOW);
    expect(view.loadError).toBe(true);
  });

  it("a failed RELEASES read sets loadError", async () => {
    // The dangerous direction is the other way here — losing releases OVERSTATES
    // what is owed — but either way the operator must be told.
    h.failing.add("retention_releases");
    const view = await buildRetentionRegisterView(ORG_A, NOW);
    expect(view.loadError).toBe(true);
  });

  it("a failed certificates read sets loadError rather than silently downgrading evidence", async () => {
    h.failing.add("completion_certificates");
    const view = await buildRetentionRegisterView(ORG_A, NOW);
    expect(view.loadError).toBe(true);
  });

  it("a thrown client returns loadError with an as-at date, not a silent empty register", async () => {
    const boom = vi.spyOn(h.client, "from").mockImplementation(() => {
      throw new Error("connection reset");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const view = await buildRetentionRegisterView(ORG_A, NOW);
      expect(view.loadError).toBe(true);
      expect(view.register.totals.held).toBe(0);
      expect(view.asAtIso).toBe("2026-07-30");
    } finally {
      boom.mockRestore();
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. source pins
// ---------------------------------------------------------------------------

const SERVICE = src("server/services/retention-register.ts");
const LIB = src("lib/commercial/retention-register.ts");
const PAGE = src("app/(app)/reports/retention/page.tsx");

describe("source pins — the register is READ-ONLY", () => {
  it("the service never mutates anything", () => {
    for (const op of [".insert(", ".update(", ".delete(", ".upsert(", ".rpc("]) {
      expect(SERVICE, `retention-register must not ${op}`).not.toContain(op);
    }
  });

  it("nothing records a retention RELEASE — reporting is not releasing", () => {
    // A register that could write to `retention_releases` would let a report
    // discharge a contractual holdback. The ledger is append-only and immutable
    // by trigger; this surface must not touch it at all.
    expect(SERVICE).not.toMatch(/retention_releases[\s\S]{0,120}(insert|update|delete)/);
    // No `finances` access of any kind (the header names the table in prose, so
    // this targets the call form rather than the word).
    expect(SERVICE).not.toMatch(/from\(\s*"finances"/);
    expect(SERVICE).not.toMatch(/paged\([\s\S]{0,40}"finances"/);
  });

  it("the page never mutates anything and declares no server action", () => {
    for (const op of [".insert(", ".update(", ".delete(", ".upsert(", ".rpc("]) {
      expect(PAGE, `the retention page must not ${op}`).not.toContain(op);
    }
    expect(PAGE).not.toMatch(/"use server"/);
  });
});

describe("source pins — the register derives no retention of its own", () => {
  it("accrual, releases and the moiety split come from the authorities", () => {
    expect(LIB).toMatch(/import \{[\s\S]*computeRetentionPosition[\s\S]*\} from "@\/lib\/retentions\/compute"/);
    expect(LIB).toMatch(/computeRetentionSchedule.*from "@\/lib\/retentions\/schedule"/);
    expect(LIB).toMatch(/computeRetentionPosition\(\{/);
    expect(LIB).toMatch(/computeRetentionSchedule\(\{/);
  });

  it("no hand-rolled rate maths, held maths or defects-date maths", () => {
    // Each of these is owned elsewhere: rate% × base and accrued − released by
    // computeRetentionPosition, PC + DLP months by the schedule's addMonths.
    expect(LIB).not.toMatch(/\/\s*100/);
    expect(LIB).not.toMatch(/accrued\s*-\s*released/);
    expect(LIB).not.toMatch(/addMonths\s*\(/);
    expect(LIB).not.toMatch(/setUTCMonth|getUTCMonth/);
  });

  it("day counting reuses the shared helper rather than re-adding one", () => {
    // A lane just consolidated seven duplicate relative-time implementations; a
    // new local (b - a) / 86_400_000 would be the eighth.
    expect(LIB).toMatch(/daysBetween.*from "@\/lib\/schedule\/window"/);
    expect(LIB).not.toContain("86_400_000");
    expect(LIB).not.toContain("86400000");
  });

  it("money goes through lib/money, never raw float arithmetic on a total", () => {
    expect(LIB).toMatch(/import \{ round2, sumMoney \} from "@\/lib\/money"/);
  });
});

describe("source pins — org pinning and paging", () => {
  it("the helper applies the org predicate and every read goes through it", () => {
    expect(SERVICE).toMatch(/\.eq\("org_id", orgId\)/);
    expect(SERVICE).toMatch(/fetchAllRows<Row>/);
  });

  it("a non-`id` ordering always appends `id` as the unique tiebreaker", () => {
    expect(SERVICE).toMatch(
      /orderKey === "id" \? base : base\.order\("id", \{ ascending: true \}\)/,
    );
  });

  it("the page passes the ACTIVE org and redirects staff", () => {
    expect(PAGE).toMatch(/const \{ ctx \} = await requireOrgContext\(\)/);
    expect(PAGE).toMatch(/buildRetentionRegisterView\(ctx\.org\.id\)/);
    expect(PAGE).toMatch(/ctx\.membership\.role === "staff"\) redirect\("\/me"\)/);
  });
});

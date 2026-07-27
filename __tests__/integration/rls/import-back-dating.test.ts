import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { buildInvoiceImportPlan } from "@/lib/imports/invoice-row";
import { buildFinanceImportPlan } from "@/lib/imports/vat";

/**
 * Migration OS commit → an imported row keeps the date the file gave it.
 *
 * The regression: the mapper extracted the source file's date into
 * `mapped.created_at` and the commit path never sent it. `finances.created_at`
 * and `invoices.created_at` are plain writable columns with `default now()`, so
 * every imported row was stamped with the day the migration ran — a firm
 * importing two years of expense history got all of it dated today.
 *
 * That is a reporting failure, not a cosmetic one: `finances.created_at` is
 * what the VAT-quarter figures filter on (app/api/tax/quarterly-pdf/route.ts
 * bounds the quarter with gte/lte on it), so the imported history landed
 * entirely in the CURRENT quarter and every historical quarter read as empty.
 * The quarter-window tests below are the ones that actually reproduce that.
 *
 * Why this has to hit a real database: a mocked client accepts any column you
 * hand it and echoes nothing back. Only Postgres can prove the value survives
 * the NOT NULL column's default, that no trigger overwrites it on insert, and
 * that a quarter query then finds the row where the operator expects it.
 *
 * Runs on the service-role client — the columns and triggers are the
 * database's, so proving it there proves it for every app path.
 */

type Row = Record<string, unknown>;
type Db = {
  from: (t: string) => {
    insert: (v: unknown) => {
      select: (c: string) => {
        single: () => Promise<{ data: Row | null; error: { message: string } | null }>;
      };
    };
    select: (c: string) => {
      eq: (k: string, v: unknown) => {
        gte: (
          k: string,
          v: unknown,
        ) => {
          lte: (k: string, v: unknown) => Promise<{ data: Row[] | null; error: unknown }>;
        };
      };
    };
    update: (v: unknown) => {
      eq: (
        k: string,
        v: unknown,
      ) => {
        select: (c: string) => {
          single: () => Promise<{ data: Row | null; error: unknown }>;
        };
      };
    };
    delete: () => { eq: (k: string, v: unknown) => Promise<{ error: unknown }> };
  };
};
const db = (c: unknown): Db => c as unknown as Db;
const TOKEN = `it-import-date-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Postgres returns `2024-03-15T00:00:00+00:00`; compare instants, not strings. */
const instant = (v: unknown) => new Date(String(v)).toISOString();

describeIntegration("imports · a row keeps the date the file gave it", () => {
  let orgId = "";
  const svc = () => db(serviceClient());

  /** Insert a mapped `cost` row exactly as the import commit path would. */
  const importCost = async (mapped: Record<string, unknown>) => {
    const plan = buildFinanceImportPlan(mapped, orgId);
    if (plan.status !== "ok") throw new Error(`expected an importable row: ${plan.status}`);
    const r = await svc()
      .from("finances")
      .insert(plan.row)
      .select("id, amount, created_at")
      .single();
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    return r.data!;
  };

  /** Insert a mapped `invoice` row exactly as the import commit path would. */
  const importInvoice = async (number: string, mapped: Record<string, unknown>) => {
    const plan = buildInvoiceImportPlan(
      { number, amount: 100, vat_total: 20, total: 120, ...mapped },
      orgId,
      "sent",
    );
    if (plan.status !== "ok") throw new Error(`expected an importable row: ${plan.status}`);
    const r = await svc()
      .from("invoices")
      .insert(plan.row)
      .select("id, number, created_at")
      .single();
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    return r.data!;
  };

  beforeAll(async () => {
    const o = await svc()
      .from("organizations")
      .insert({ name: "Import Back-dating Co", slug: TOKEN })
      .select("id")
      .single();
    expect(o.error, JSON.stringify(o.error)).toBeNull();
    orgId = o.data?.id as string;
  });

  afterAll(async () => {
    if (orgId) await svc().from("organizations").delete().eq("id", orgId);
  });

  // -------------------------------------------------------------------------
  // cost → finances.created_at
  // -------------------------------------------------------------------------

  it("persists a back-dated cost at the instant the file stated", async () => {
    const row = await importCost({
      amount: 100,
      vat_rate: 20,
      category: "materials",
      created_at: "2024-03-15",
    });
    expect(instant(row.created_at)).toBe("2024-03-15T00:00:00.000Z");
  });

  it("falls back to the DB default when the file carried no date", async () => {
    const before = Date.now();
    const row = await importCost({ amount: 100, vat_rate: 20, category: "materials" });
    // NOT NULL with `default now()` — the row must still have a real timestamp,
    // and it must be now rather than some sentinel.
    expect(row.created_at).toBeTruthy();
    const t = new Date(String(row.created_at)).getTime();
    expect(t).toBeGreaterThanOrEqual(before - 60_000);
    expect(t).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it("keeps a multi-year history spread across its real dates", async () => {
    const dates = ["2024-01-15", "2025-06-30", "2026-02-01"];
    const rows = await Promise.all(
      dates.map((created_at) =>
        importCost({ amount: 100, vat_rate: 20, category: TOKEN, created_at }),
      ),
    );
    expect(rows.map((r) => instant(r.created_at))).toEqual([
      "2024-01-15T00:00:00.000Z",
      "2025-06-30T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
    ]);
  });

  // -------------------------------------------------------------------------
  // The reported failure, reproduced end to end: every calendar quarter.
  // -------------------------------------------------------------------------

  /** The same gte/lte window app/api/tax/quarterly-pdf/route.ts uses. */
  const inQuarter = async (category: string, qStart: string, qEnd: string) => {
    const r = await svc()
      .from("finances")
      .select("amount, category, created_at")
      .eq("category", category)
      .gte("created_at", qStart)
      .lte("created_at", `${qEnd}T23:59:59.999Z`);
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    return r.data ?? [];
  };

  const QUARTERS = [
    { q: "Q1", start: "2024-01-01", end: "2024-03-31" },
    { q: "Q2", start: "2024-04-01", end: "2024-06-30" },
    { q: "Q3", start: "2024-07-01", end: "2024-09-30" },
    { q: "Q4", start: "2024-10-01", end: "2024-12-31" },
  ];

  for (const { q, start, end } of QUARTERS) {
    it(`files a ${q} cost in ${q} and in no other quarter`, async () => {
      // Dated the FIRST day of the quarter — the boundary a timezone slip moves,
      // and the one that falls into the gap between two windows if the value is
      // not pinned to an explicit instant.
      const category = `${TOKEN}-${q}`;
      await importCost({ amount: 250, vat_rate: 20, category, created_at: start });
      expect(await inQuarter(category, start, end)).toHaveLength(1);
      for (const other of QUARTERS.filter((x) => x.q !== q)) {
        expect(
          await inQuarter(category, other.start, other.end),
          `${q} cost leaked into ${other.q}`,
        ).toHaveLength(0);
      }
    });

    it(`files a ${q} cost dated the LAST day of ${q} in ${q}`, async () => {
      // The other boundary: 23:59:59.999Z is the window's inclusive upper bound,
      // and a value pinned to 00:00:00Z on the last day sits inside it.
      const category = `${TOKEN}-${q}-end`;
      await importCost({ amount: 60, vat_rate: 0, category, created_at: end });
      expect(await inQuarter(category, start, end)).toHaveLength(1);
    });
  }

  it("does NOT put a back-dated cost in the quarter the import ran in", async () => {
    // The literal reported symptom. `now()` is 2026-era; a 2024 Q2 cost must be
    // absent from today's quarter.
    const category = `${TOKEN}-not-today`;
    await importCost({ amount: 250, vat_rate: 20, category, created_at: "2024-05-20" });
    const now = new Date();
    const qIndex = Math.floor(now.getUTCMonth() / 3);
    const qStart = new Date(Date.UTC(now.getUTCFullYear(), qIndex * 3, 1));
    const qEnd = new Date(Date.UTC(now.getUTCFullYear(), qIndex * 3 + 3, 0));
    expect(
      await inQuarter(category, qStart.toISOString().slice(0, 10), qEnd.toISOString().slice(0, 10)),
    ).toHaveLength(0);
  });

  it("stores the instant as midnight UTC, not a timezone-dependent local midnight", async () => {
    // Why the helper pins the instant rather than handing Postgres a bare
    // `YYYY-MM-DD`: a bare date is resolved against the SESSION TimeZone, so the
    // stored instant would depend on a server setting the import cannot see. The
    // stored value here must be exactly 00:00:00Z — no offset, no drift.
    const row = await importCost({
      amount: 10,
      vat_rate: 0,
      category: `${TOKEN}-utc`,
      created_at: "2024-04-01",
    });
    const stored = new Date(String(row.created_at));
    expect(stored.toISOString()).toBe("2024-04-01T00:00:00.000Z");
    expect(stored.getUTCHours()).toBe(0);
    expect(stored.getUTCMinutes()).toBe(0);
  });

  it("survives a later update — the updated_at trigger leaves created_at alone", async () => {
    // finances_set_updated_at fires BEFORE UPDATE. It must touch updated_at
    // only; a back-dated import that silently jumps to today on the first edit
    // would put the row back in the wrong quarter.
    const row = await importCost({
      amount: 100,
      vat_rate: 20,
      category: "materials",
      created_at: "2024-03-15",
    });
    const updated = await svc()
      .from("finances")
      .update({ notes: "edited after import" })
      .eq("id", row.id)
      .select("created_at, updated_at")
      .single();
    expect(updated.error, JSON.stringify(updated.error)).toBeNull();
    expect(instant(updated.data?.created_at)).toBe("2024-03-15T00:00:00.000Z");
    // updated_at did move — proving the trigger ran and still spared created_at.
    expect(new Date(String(updated.data?.updated_at)).getTime()).toBeGreaterThan(
      new Date("2024-03-15T00:00:00.000Z").getTime(),
    );
  });

  // -------------------------------------------------------------------------
  // invoice → invoices.created_at
  // -------------------------------------------------------------------------

  it("persists a back-dated invoice at the instant the file stated", async () => {
    const row = await importInvoice(`${TOKEN}-BACKDATED`, { created_at: "2024-05-09" });
    expect(instant(row.created_at)).toBe("2024-05-09T00:00:00.000Z");
  });

  it("falls back to the DB default for an invoice with no date", async () => {
    const before = Date.now();
    const row = await importInvoice(`${TOKEN}-NODATE`, {});
    expect(row.created_at).toBeTruthy();
    const t = new Date(String(row.created_at)).getTime();
    expect(t).toBeGreaterThanOrEqual(before - 60_000);
    expect(t).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it("puts a back-dated invoice in the tax year it belongs to", async () => {
    // app/(app)/tax/page.tsx bounds invoices the same way, with a single
    // gte(created_at, startOfTaxYear). A UK tax year starts on 6 April.
    await importInvoice(`${TOKEN}-TY`, { created_at: "2024-05-09" });
    const r = await svc()
      .from("invoices")
      .select("number, created_at")
      .eq("org_id", orgId)
      .gte("created_at", "2024-04-06")
      .lte("created_at", "2025-04-05T23:59:59.999Z");
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    const numbers = (r.data ?? []).map((x) => x.number);
    expect(numbers).toContain(`${TOKEN}-TY`);
    // The dateless invoice imported above is stamped today, so it must NOT be
    // in a tax year that ended in 2025.
    expect(numbers).not.toContain(`${TOKEN}-NODATE`);
  });
});

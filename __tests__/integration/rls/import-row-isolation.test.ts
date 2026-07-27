import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { parseCsvFile } from "@/lib/imports/parsers";
import { detectEntityType, mapRow } from "@/lib/imports/detect";
import { buildInvoiceImportPlan } from "@/lib/imports/invoice-row";
import { buildFinanceImportPlan } from "@/lib/imports/vat";

/**
 * Migration OS commit → a whole spreadsheet, against real Postgres.
 *
 * Two things are proved here that the other import suites can't:
 *
 *   1. END TO END. A real CSV goes through the real pipeline — parse, detect,
 *      map, build, insert — and lands in the real table with the right money and
 *      the right dates. The other suites start from a hand-written `mapped`
 *      object, which cannot catch a header that stopped matching.
 *
 *   2. ROW ISOLATION. `commitImport` wraps each `insertOne` in its own
 *      try/catch and marks that ONE row `error` before carrying on. That is the
 *      directive's "AI flags issues but does not stop migration" rule, and it is
 *      what makes rejecting a bad VAT figure safe rather than catastrophic: a
 *      single unusable row in a 500-row file must cost the operator that row,
 *      not the import. The loop below is the commit loop's structure, run
 *      against a real database.
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
      eq: (k: string, v: unknown) => Promise<{ data: Row[] | null; error: unknown }>;
    };
    delete: () => { eq: (k: string, v: unknown) => Promise<{ error: unknown }> };
  };
};
const db = (c: unknown): Db => c as unknown as Db;
const TOKEN = `it-import-iso-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** What the commit loop records for one row. */
type Outcome =
  | { status: "imported"; id: string }
  | { status: "skipped" }
  | { status: "error"; message: string };

describeIntegration("imports · a whole sheet, and one bad row among good ones", () => {
  let orgId = "";
  const svc = () => db(serviceClient());

  beforeAll(async () => {
    const o = await svc()
      .from("organizations")
      .insert({ name: "Import Isolation Co", slug: TOKEN })
      .select("id")
      .single();
    expect(o.error, JSON.stringify(o.error)).toBeNull();
    orgId = o.data?.id as string;
  });

  afterAll(async () => {
    if (orgId) await svc().from("organizations").delete().eq("id", orgId);
  });

  /**
   * Run a CSV through the whole pipeline the way commitImport does — one row at
   * a time, each insert isolated, a failure recorded against that row only.
   */
  const commitSheet = async (
    csv: string,
    kind: "cost" | "invoice",
  ): Promise<{ entity: string; outcomes: Outcome[] }> => {
    const sheet = parseCsvFile(csv);
    const detected = detectEntityType(sheet);
    const outcomes: Outcome[] = [];
    for (const raw of sheet.rows) {
      const { mapped } = mapRow(detected, raw);
      try {
        const plan =
          kind === "cost"
            ? buildFinanceImportPlan(mapped, orgId)
            : buildInvoiceImportPlan(mapped, orgId, "sent");
        if (plan.status === "skip") {
          outcomes.push({ status: "skipped" });
          continue;
        }
        // insertOne throws on a rejected plan; the commit loop catches it.
        if (plan.status === "reject") throw new Error(plan.reason);
        const r = await svc()
          .from(kind === "cost" ? "finances" : "invoices")
          .insert(plan.row)
          .select("id")
          .single();
        if (r.error) throw new Error(r.error.message);
        outcomes.push({ status: "imported", id: String(r.data?.id) });
      } catch (e) {
        outcomes.push({ status: "error", message: (e as Error).message });
      }
    }
    return { entity: detected.entity_type, outcomes };
  };

  // -------------------------------------------------------------------------
  // End to end
  // -------------------------------------------------------------------------

  it("imports a real cost sheet from CSV to rows", async () => {
    const category = `${TOKEN}-costs`;
    const { entity, outcomes } = await commitSheet(
      `Date,Description,Net,VAT,Category\n` +
        `2024-02-10,Cable,100,20,${category}\n` +
        `2024-08-22,Timber,250,12.50,${category}\n` +
        `2024-11-05,Sand,80,0,${category}\n`,
      "cost",
    );
    expect(entity).toBe("cost");
    expect(outcomes.every((o) => o.status === "imported")).toBe(true);

    const r = await svc()
      .from("finances")
      .select("amount, vat_rate, vat_total, created_at")
      .eq("category", category);
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    const rows = (r.data ?? []).sort((a, b) => Number(a.amount) - Number(b.amount));
    expect(rows).toHaveLength(3);
    // 80 @ 0%, 100 @ 20%, 250 @ 5% — each rate backed out of the VAT amount,
    // each vat_total computed by the database from the rate.
    expect(rows.map((x) => Number(x.vat_rate))).toEqual([0, 20, 5]);
    expect(rows.map((x) => Number(x.vat_total))).toEqual([0, 20, 12.5]);
    // And each row kept its own date rather than collapsing onto today.
    expect(rows.map((x) => new Date(String(x.created_at)).toISOString())).toEqual([
      "2024-11-05T00:00:00.000Z",
      "2024-02-10T00:00:00.000Z",
      "2024-08-22T00:00:00.000Z",
    ]);
  });

  it("imports a real invoice sheet whose gross column is Total Due", async () => {
    // The header layout that used to write the money into `due_date`. End to
    // end, on a real table, with a generated `total`.
    const { entity, outcomes } = await commitSheet(
      `Invoice Number,Customer,Subtotal,VAT,Total Due,Invoice Date\n` +
        `${TOKEN}-A,Acme,100,20,120,2024-05-09\n` +
        `${TOKEN}-B,Acme,200,40,240,2024-06-11\n`,
      "invoice",
    );
    expect(entity).toBe("invoice");
    expect(outcomes.every((o) => o.status === "imported")).toBe(true);

    const r = await svc()
      .from("invoices")
      .select("number, amount, vat_total, total, due_date, created_at")
      .eq("org_id", orgId);
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    const rows = (r.data ?? []).filter((x) => String(x.number).startsWith(TOKEN));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // The gross figure is money, and the database recomputed it from the parts.
      expect(Number(row.total)).toBe(Number(row.amount) + Number(row.vat_total));
      // It is emphatically NOT a date.
      expect(row.due_date).toBeNull();
    }
    expect(rows.map((x) => Number(x.total)).sort((a, b) => a - b)).toEqual([120, 240]);
  });

  // -------------------------------------------------------------------------
  // Row isolation
  // -------------------------------------------------------------------------

  it("fails ONE unusable VAT row and imports every good row around it", async () => {
    const category = `${TOKEN}-mixed`;
    const { outcomes } = await commitSheet(
      `Date,Description,Net,VAT,Category\n` +
        `2024-02-10,Good one,100,20,${category}\n` +
        `2024-03-11,Legacy 17.5%,200,35,${category}\n` +
        `2024-04-12,Good two,300,60,${category}\n`,
      "cost",
    );
    expect(outcomes.map((o) => o.status)).toEqual(["imported", "error", "imported"]);
    // The failure names the numbers the operator has to fix.
    const failure = outcomes.find((o) => o.status === "error");
    expect(failure?.status === "error" && failure.message).toMatch(/17\.5%/);

    // The good rows are really in the table — the bad row cost only itself.
    const r = await svc().from("finances").select("amount").eq("category", category);
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect((r.data ?? []).map((x) => Number(x.amount)).sort((a, b) => a - b)).toEqual([100, 300]);
  });

  it("fails ONE unreadable-date row and imports every good row around it", async () => {
    const category = `${TOKEN}-dates`;
    const { outcomes } = await commitSheet(
      `Date,Description,Net,VAT,Category\n` +
        `2024-02-10,Good one,100,20,${category}\n` +
        `31/02/2024,Impossible day,200,40,${category}\n` +
        `2024-04-12,Good two,300,60,${category}\n`,
      "cost",
    );
    // 31 February is not a date. Stamping that row with now() would file it in
    // the wrong VAT quarter, so it fails — alone.
    expect(outcomes.map((o) => o.status)).toEqual(["imported", "error", "imported"]);
    const r = await svc().from("finances").select("amount").eq("category", category);
    expect((r.data ?? []).map((x) => Number(x.amount)).sort((a, b) => a - b)).toEqual([100, 300]);
  });

  it("skips an amount-less row without failing it, and keeps going", async () => {
    // A blank line in the middle of a sheet is not an error, it is nothing.
    const category = `${TOKEN}-skips`;
    const { outcomes } = await commitSheet(
      `Date,Description,Net,VAT,Category\n` +
        `2024-02-10,Good one,100,20,${category}\n` +
        `2024-03-11,No amount,0,0,${category}\n` +
        `2024-04-12,Good two,300,60,${category}\n`,
      "cost",
    );
    expect(outcomes.map((o) => o.status)).toEqual(["imported", "skipped", "imported"]);
    const r = await svc().from("finances").select("amount").eq("category", category);
    expect((r.data ?? []).map((x) => Number(x.amount)).sort((a, b) => a - b)).toEqual([100, 300]);
  });
});

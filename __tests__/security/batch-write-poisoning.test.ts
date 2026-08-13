import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONSTRAINT_VIOLATION_CODES,
  BATCH_WRITE_CHUNK,
} from "@/lib/supabase/safe-batch-write";
import {
  getAccountingAdapter,
  type AccountingProvider,
  type AccountingPushInput,
} from "@/lib/integrations/accounting/adapters";
import type { CanonicalAccountingRow } from "@/lib/integrations/accounting/canonical";

/**
 * BATCH-WRITE POISONING — the systemic shape guard (closes the class, not instances).
 *
 * A mapped external-feed batch written in ONE `.upsert(allRows)` that throws on the
 * first error is the batch-poisoning primitive: one uninsertable row (a CHECK /
 * NOT NULL / datetime / numeric-overflow the mapper did not mirror) aborts the whole
 * write → 0 rows → and because these feeds re-deliver the same window every tick, the
 * same poison re-aborts forever, stranding the org's feed at zero while the UI reads
 * "connected"/"fresh". C61 fixed ONE writer; this guard asserts EVERY mapped-vendor
 * batch writer routes through the SHARED chunked + per-row-fallback safe writer, so
 * the class cannot silently recur in a sibling — or in a future sync adapter.
 *
 * This is the structural twin of the per-adapter constraint guards
 * (telematics-reading-map / banking-statement-map / open-meteo-adapter it.each),
 * which pin that each MAPPER mirrors every CHECK/NOT-NULL/precision constraint.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
/** Strip comments so an example in a doc block can never satisfy (or trip) a match. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const SHARED = "lib/supabase/safe-batch-write.ts";

/**
 * Every mapped external-feed writer: the table it writes + its source file. A NEW
 * sync adapter that writes a mapped vendor feed MUST be added here AND route through
 * the shared safe writer — that is the whole point of a systemic guard.
 */
const MAPPED_FEED_WRITERS = [
  { table: "telematics_readings", file: "server/services/telematics-sync.ts" },
  { table: "bank_statement_lines", file: "server/services/bank-sync.ts" },
  { table: "weather_readings", file: "server/services/weather-fetch.ts" },
] as const;

describe("the shared safe writer exists and enumerates the bad-row SQLSTATEs", () => {
  it("chunks at a bounded size and recognises CHECK / NOT-NULL / datetime / numeric constraint codes", () => {
    expect(BATCH_WRITE_CHUNK).toBeGreaterThan(0);
    expect(BATCH_WRITE_CHUNK).toBeLessThanOrEqual(1000);
    // The bad-row codes that MUST trigger the per-row fallback (drop + TERMINAL),
    // versus a transient blip (bail + keep the feed live).
    for (const code of ["23514", "23502", "22007", "22003"]) {
      expect(CONSTRAINT_VIOLATION_CODES.has(code)).toBe(true);
    }
  });

  it("the shared writer implements chunk + per-row fallback", () => {
    const code = codeOf(read(SHARED));
    expect(code).toMatch(/export async function safeBatchWrite/);
    // A per-row fallback loop exists inside (single-row retry after a chunk error).
    expect(code).toMatch(/for \(const row of chunk\)/);
    expect(code).toMatch(/transientError/);
    expect(code).toMatch(/constraintError/);
  });
});

describe("every mapped-feed writer routes its batch upsert through the shared safe writer", () => {
  it.each(MAPPED_FEED_WRITERS)("$table writer imports and uses safeBatchWrite", ({ file }) => {
    const code = codeOf(read(file));
    expect(code).toMatch(/from\s+["']@\/lib\/supabase\/safe-batch-write["']/);
    expect(code).toMatch(/safeBatchWrite\(/);
  });

  it.each(MAPPED_FEED_WRITERS)(
    "$table writer's EVERY .upsert() operates on the per-chunk arg — never a bare full array",
    ({ file }) => {
      const code = codeOf(read(file));
      // Capture the first argument of every `.upsert(` in the writer. Each must be
      // `chunk` — the safeBatchWrite closure's per-chunk parameter — so a reintroduced
      // bare single `.upsert(allRows)` (the poisoning primitive) is caught here.
      const upsertArgs = [...code.matchAll(/\.upsert\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
      expect(upsertArgs.length).toBeGreaterThan(0);
      for (const arg of upsertArgs) expect(arg).toBe("chunk");
    },
  );
});

describe("each mapper mirrors the DB constraints its writer's table declares", () => {
  it("the banking mapper drops an uninsertable line (isInsertableLine + filter)", () => {
    const code = codeOf(read("lib/integrations/banking/statement-map.ts"));
    expect(code).toMatch(/export function isInsertableLine/);
    expect(code).toMatch(/\.filter\(isInsertableLine\)/);
    // The two constraints the row shape under-mirrors are enforced.
    expect(code).toMatch(/AMOUNT_MAX/);
    expect(code).toMatch(/DATE_ONLY_RE/);
  });

  it("the weather mapper nulls out-of-range metrics (boundedMetric) via the shared bounds", () => {
    const bounds = codeOf(read("lib/weather/reading-bounds.ts"));
    expect(bounds).toMatch(/export function boundedMetric/);
    expect(bounds).toMatch(/WEATHER_METRIC_BOUNDS/);
    const adapter = codeOf(read("lib/weather/providers/open-meteo.ts"));
    expect(adapter).toMatch(/from\s+["']\.\.\/reading-bounds["']/);
    expect(adapter).toMatch(/boundedMetric\(/);
  });

  it("the telematics mapper nulls out-of-range readings (the C61 reference)", () => {
    const code = codeOf(read("lib/integrations/telematics/reading-map.ts"));
    // The reference posture: range CHECK bounds enforced before emitting a row.
    expect(code).toMatch(/ODOMETER_MAX/);
    expect(code).toMatch(/LAT_MIN|LAT_MAX/);
  });
});

/**
 * THE ACCOUNTING-PUSH SURFACE (C61 batch-poisoning class, non-DB writer variant).
 *
 * The Xero / QuickBooks push adapters are per-ROW HTTP writers, not DB batch
 * upserts, so they don't route through safeBatchWrite — but they are the SAME
 * defect class: one poison invoice (a VAT rate outside {0,5,20}, which no honest
 * provider tax code maps) used to zero the WHOLE org's push. Xero built every
 * invoice body up front inside one try that returned {pushed:0} on any throw;
 * QuickBooks stranded the tail from the bad invoice onward. Because the export
 * re-delivers the same window every sync, the same poison re-aborted forever while
 * the connection read "connected".
 *
 * This behavioural invariant pins the per-INVOICE isolation contract for BOTH
 * adapters: a mixed batch [good, bad-rate, good] still pushes the two good
 * invoices, SKIPS the bad one, and names it — so a future whole-batch-abort /
 * tail-strand regression fails CI here, alongside the DB-writer guards above.
 */
describe("accounting-push adapters isolate a per-invoice failure (no whole-batch abort)", () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });
  function enable() {
    process.env.FEATURE_ACCOUNTING_CONNECT = "1"; // the flag accepts only "1"/"true"
    process.env.XERO_CLIENT_ID = "xero-id";
    process.env.XERO_CLIENT_SECRET = "xero-secret";
    process.env.QBO_CLIENT_ID = "qbo-id";
    process.env.QBO_CLIENT_SECRET = "qbo-secret";
  }

  const inv = (n: string, rate: number, vat: string, gross: string): CanonicalAccountingRow => ({
    date: "2026-02-01",
    type: "invoice",
    customer: "Acme Ltd",
    net: "100.00",
    vat,
    gross,
    invoice_number: n,
    status: "sent",
    sourceId: `src-${n}`,
    taxLines: [{ rate, net: "100.00", vat }],
  });
  const GOOD_A = inv("INV-A", 20, "20.00", "120.00");
  const BAD = inv("INV-BAD", 17.5, "17.50", "117.50");
  const GOOD_B = inv("INV-B", 5, "5.00", "105.00");

  const input = (over: Partial<AccountingPushInput>): AccountingPushInput => ({
    rows: [GOOD_A, BAD, GOOD_B],
    accessToken: "ACCESS",
    tenantId: "TENANT",
    realmId: "REALM",
    refresh: vi.fn(async () => null),
    ...over,
  });

  // A QBO fetch mock: item + customer + per-rate tax code + invoice create all OK.
  function qboFetch() {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    return vi.fn(async (url: string, i?: RequestInit) => {
      const method = i?.method ?? "GET";
      if (method === "GET" && url.includes("/query")) {
        if (url.includes("TaxCode")) return json({ QueryResponse: { TaxCode: [{ Id: "TC" }] } });
        if (url.includes("Item")) return json({ QueryResponse: { Item: [{ Id: "7" }] } });
        if (url.includes("Customer")) return json({ QueryResponse: { Customer: [{ Id: "3" }] } });
        return json({ QueryResponse: {} });
      }
      if (method === "POST" && url.includes("/invoice")) return json({ Invoice: { Id: "11" } });
      return json({});
    });
  }

  const cases: Array<{ provider: AccountingProvider; makeFetch: () => ReturnType<typeof vi.fn> }> = [
    {
      provider: "xero",
      makeFetch: () =>
        vi.fn(async () =>
          new Response(JSON.stringify({ Invoices: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    },
    { provider: "quickbooks", makeFetch: qboFetch },
  ];

  it.each(cases)(
    "$provider: [good, bad-rate, good] pushes the 2 good, SKIPS the bad, and names it",
    async ({ provider, makeFetch }) => {
      enable();
      vi.stubGlobal("fetch", makeFetch());
      const res = await getAccountingAdapter(provider).pushInvoices(input({}));
      // Never a whole-batch abort: the postable invoices land.
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.pushed).toBe(2);
        expect(res.pushedSourceIds).toEqual(["src-INV-A", "src-INV-B"]);
        // The poison invoice is isolated and surfaced loudly, never recorded.
        expect(res.skipped?.map((s) => s.invoiceNumber)).toEqual(["INV-BAD"]);
        expect(res.pushedSourceIds).not.toContain("src-INV-BAD");
      }
    },
  );
});

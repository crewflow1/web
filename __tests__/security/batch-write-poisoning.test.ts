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
 * adapters across BOTH kinds of per-row failure and BOTH loops (invoices AND
 * payments):
 *   • MAP-TIME skip — an unmappable VAT rate; [good, bad-rate, good] pushes the
 *     two good, SKIPS the bad, names it.
 *   • PROVIDER REJECTION (C73-C) — a PERMANENT 4xx (≠429, e.g. 400 rejected field
 *     / 422 duplicate DocNumber) on ONE row; [good, provider-rejected(4xx), good]
 *     STILL pushes the good TAIL, SKIPS the rejected row, names it, and leaves it
 *     unrecorded. This closes the exact defect the map-time case did NOT cover:
 *     the loop used to `return` mid-batch on any non-2xx, so an EARLIER
 *     permanently-rejected invoice re-aborted every later invoice on every sync.
 *   • TRANSIENT failure (the counter-case) — a 5xx / 429 aborts the WHOLE run so
 *     it retries; the tail is NOT attempted and nothing is skip-recorded. This
 *     pins the permanent/transient distinction in BOTH directions.
 *
 * A future whole-batch-abort / tail-strand regression fails CI here, alongside the
 * DB-writer guards above.
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

  // ── C73-C: PROVIDER REJECTION (permanent 4xx) vs TRANSIENT (5xx/429) ─────────
  // The map-time case above never exercises a PROVIDER rejection. These cases put
  // a provider-rejected / transient-failing row BEFORE a good row, for BOTH
  // adapters and BOTH loops, so the tail-strand regression is actually caught.

  const payRow = (n: string): CanonicalAccountingRow => ({
    date: "2026-02-05",
    type: "payment",
    customer: "Acme Ltd",
    net: "",
    vat: "",
    gross: "120.00",
    invoice_number: n,
    status: "received",
    sourceId: `pay-${n}`,
  });

  const resp = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  /** Xero: one POST per row; return the i-th status from the sequence. */
  const xeroSeq = (statuses: number[]) => {
    let i = 0;
    return vi.fn(async () => {
      const code = statuses[i++] ?? 200;
      return resp(code, code >= 200 && code < 300 ? { Invoices: [] } : { error: "rejected" });
    });
  };

  /** QBO invoices: resolvers all OK; the i-th invoice POST takes the i-th status. */
  const qboInvSeq = (statuses: number[]) => {
    let i = 0;
    return vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url.includes("/query")) {
        if (url.includes("TaxCode")) return resp(200, { QueryResponse: { TaxCode: [{ Id: "TC" }] } });
        if (url.includes("Item")) return resp(200, { QueryResponse: { Item: [{ Id: "7" }] } });
        if (url.includes("Customer")) return resp(200, { QueryResponse: { Customer: [{ Id: "3" }] } });
        return resp(200, { QueryResponse: {} });
      }
      if (method === "POST" && url.includes("/invoice")) {
        const code = statuses[i++] ?? 200;
        return resp(code, code >= 200 && code < 300 ? { Invoice: { Id: "11" } } : { Fault: {} });
      }
      return resp(200, {});
    });
  };

  /** QBO payments: customer + invoice lookups OK; the i-th payment POST takes the i-th status. */
  const qboPaySeq = (statuses: number[]) => {
    let i = 0;
    return vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url.includes("/query")) {
        if (url.includes("Customer")) return resp(200, { QueryResponse: { Customer: [{ Id: "3" }] } });
        if (url.includes("Invoice")) return resp(200, { QueryResponse: { Invoice: [{ Id: "11" }] } });
        return resp(200, { QueryResponse: {} });
      }
      if (method === "POST" && url.includes("/payment")) {
        const code = statuses[i++] ?? 200;
        return resp(code, code >= 200 && code < 300 ? { Payment: { Id: "22" } } : { Fault: {} });
      }
      return resp(200, {});
    });
  };

  // Three map-VALID rows so all three reach the network POST; the MIDDLE one is the
  // row the provider rejects / transiently fails.
  const INV_ROWS = [
    inv("INV-1", 20, "20.00", "120.00"),
    inv("INV-REJ", 20, "20.00", "120.00"),
    inv("INV-2", 5, "5.00", "105.00"),
  ];
  const PAY_ROWS = [payRow("P-1"), payRow("P-REJ"), payRow("P-2")];

  type LoopCase = {
    label: string;
    rows: CanonicalAccountingRow[];
    makeFetch: (statuses: number[]) => ReturnType<typeof vi.fn>;
    push: (inp: AccountingPushInput) => ReturnType<ReturnType<typeof getAccountingAdapter>["pushInvoices"]>;
    acceptedIds: string[]; // the two good rows' sourceIds
    tailId: string; // the LAST row's sourceId (must NOT push on a transient abort)
    rejectedId: string; // the MIDDLE row's sourceId (must never be recorded)
    skippedRef: string; // the middle row's identifier surfaced in `skipped`
    rejectCode: number; // a PERMANENT 4xx to reject the middle row with
    transientCode: number; // a TRANSIENT code to fail the middle row with
  };

  const loops: LoopCase[] = [
    {
      label: "xero invoices",
      rows: INV_ROWS,
      makeFetch: xeroSeq,
      push: (inp) => getAccountingAdapter("xero").pushInvoices(inp),
      acceptedIds: ["src-INV-1", "src-INV-2"],
      tailId: "src-INV-2",
      rejectedId: "src-INV-REJ",
      skippedRef: "INV-REJ",
      rejectCode: 422,
      transientCode: 500,
    },
    {
      label: "xero payments",
      rows: PAY_ROWS,
      makeFetch: xeroSeq,
      push: (inp) => getAccountingAdapter("xero").pushPayments(inp),
      acceptedIds: ["pay-P-1", "pay-P-2"],
      tailId: "pay-P-2",
      rejectedId: "pay-P-REJ",
      skippedRef: "P-REJ",
      rejectCode: 400,
      transientCode: 429,
    },
    {
      label: "quickbooks invoices",
      rows: INV_ROWS,
      makeFetch: qboInvSeq,
      push: (inp) => getAccountingAdapter("quickbooks").pushInvoices(inp),
      acceptedIds: ["src-INV-1", "src-INV-2"],
      tailId: "src-INV-2",
      rejectedId: "src-INV-REJ",
      skippedRef: "INV-REJ",
      rejectCode: 400,
      transientCode: 500,
    },
    {
      label: "quickbooks payments",
      rows: PAY_ROWS,
      makeFetch: qboPaySeq,
      push: (inp) => getAccountingAdapter("quickbooks").pushPayments(inp),
      acceptedIds: ["pay-P-1", "pay-P-2"],
      tailId: "pay-P-2",
      rejectedId: "pay-P-REJ",
      skippedRef: "P-REJ",
      rejectCode: 422,
      transientCode: 429,
    },
  ];

  it.each(loops)(
    "$label: a PERMANENT provider rejection (4xx≠429) BEFORE a good row is SKIPPED, the tail still pushes",
    async ({ rows, makeFetch, push, acceptedIds, rejectedId, skippedRef, rejectCode }) => {
      enable();
      // [good(200), rejected(4xx), good(200)]
      vi.stubGlobal("fetch", makeFetch([200, rejectCode, 200]));
      const res = await push(input({ rows }));

      // NOT a whole-batch abort: the good tail row after the rejected one lands.
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.pushed).toBe(2);
        expect(res.pushedSourceIds).toEqual(acceptedIds);
        // The rejected row is isolated, surfaced loudly, and never recorded.
        expect(res.skipped?.map((s) => s.invoiceNumber)).toEqual([skippedRef]);
        expect(res.skipped?.[0]?.reason).toMatch(new RegExp(String(rejectCode)));
        expect(res.pushedSourceIds).not.toContain(rejectedId);
      }
    },
  );

  it.each(loops)(
    "$label: a TRANSIENT failure (5xx/429) BEFORE a good row ABORTS the batch (tail NOT attempted)",
    async ({ rows, makeFetch, push, tailId, transientCode }) => {
      enable();
      // [good(200), transient(5xx/429), …] — the tail must never be attempted.
      vi.stubGlobal("fetch", makeFetch([200, transientCode, 200]));
      const res = await push(input({ rows }));

      // A transient failure aborts the whole run so it retries next sync.
      expect(res.ok).toBe(false);
      if (!res.ok) {
        // Only the first (accepted) row counts; the tail was never attempted.
        expect(res.pushed).toBe(1);
        expect(res.pushedSourceIds ?? []).not.toContain(tailId);
        // A transient failure is NOT a per-row skip.
        expect(res.skipped ?? []).toHaveLength(0);
      }
    },
  );
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  matchThreeWay,
  NO_TOLERANCE_POLICY,
  type MatchGrn,
} from "@/lib/purchase-orders/matching";

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const LIB = "lib/purchase-orders/matching.ts";
const SERVICE = "server/services/po-matching.ts";
const PAGE = "app/(app)/purchase-orders/matching/page.tsx";
const REGISTER = "app/(app)/purchase-orders/page.tsx";
const COMPOSE = "lib/briefing/compose.ts";

/**
 * Strip TS/JS comments so NEGATIVE assertions test the EXECUTABLE code and can
 * never be satisfied — or defeated — by a header that quotes the rule. Every
 * file in this slice documents "no insert, no update, no rpc" in prose, which a
 * naive regex would happily match.
 */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const lib = codeOf(read(LIB));
const service = codeOf(read(SERVICE));
const page = codeOf(read(PAGE));

// ---------------------------------------------------------------------------
// 1. READ-ONLY. Detecting a variance must never post, credit or adjust anything
// ---------------------------------------------------------------------------

describe("the three-way match writes NOTHING", () => {
  // THE headline invariant. A PO is committed spend; the ACTUAL cost lands
  // exactly once, when recordSupplierBill posts the supplier's invoice. If this
  // surface ever "corrected" a variance by writing to `finances`, the same spend
  // would be counted twice against the same job — the precise failure the
  // receiving milestone was built to avoid. It is also a governance point: a
  // machine must not decide that a supplier's invoice is wrong and act on it.
  const surfaces: Array<[string, string]> = [
    [LIB, lib],
    [SERVICE, service],
    [PAGE, page],
  ];

  for (const [name, src] of surfaces) {
    it(`${name} contains no write call of any kind`, () => {
      for (const verb of ["insert", "update", "upsert", "delete", "rpc"]) {
        expect(src, `${name} calls .${verb}(`).not.toMatch(new RegExp(`\\.${verb}\\(`));
      }
    });
  }

  it("no file in the slice is a server action", () => {
    for (const [name, src] of surfaces) {
      expect(src, `${name} declares "use server"`).not.toMatch(/"use server"/);
    }
  });

  it("the queue page renders no form and no submit button", () => {
    // A read-only surface with a button on it is one merge away from being a
    // write surface. There is nothing to submit: a human rings the supplier.
    expect(page).not.toMatch(/<form/);
    expect(page).not.toMatch(/<button/);
    expect(page).not.toMatch(/action=/);
  });

  it("invalidates no cache and redirects nowhere — there is no state to commit", () => {
    for (const [name, src] of surfaces) {
      expect(src, name).not.toMatch(/revalidatePath\(/);
      expect(src, name).not.toMatch(/revalidateTag\(/);
      expect(src, name).not.toMatch(/\bredirect\(/);
    }
  });

  it("never reaches for the service-role client, which would bypass RLS", () => {
    for (const [name, src] of surfaces) {
      expect(src, name).not.toMatch(/createAdminClient/);
      expect(src, name).not.toMatch(/SERVICE_ROLE/);
    }
  });

  it("the pure lib imports nothing that could perform I/O", () => {
    expect(lib).not.toMatch(/server-only/);
    expect(lib).not.toMatch(/@\/lib\/supabase/);
    expect(lib).not.toMatch(/from "next\//);
    // …and takes no clock, so the same input always produces the same answer.
    expect(lib).not.toMatch(/new Date\(/);
    expect(lib).not.toMatch(/Date\.now\(/);
  });
});

// ---------------------------------------------------------------------------
// 2. ACTIVE-ORG PIN — one company's discrepancies, never two blended
// ---------------------------------------------------------------------------

describe("every read is pinned to the ACTIVE org, not merely RLS-scoped", () => {
  it("EVERY table read goes through the ONE pinned chokepoint", () => {
    // Structural, not a count: `pagedRows` is the only place `.from(` appears,
    // and it carries the pin. A new read cannot be added without either going
    // through it or making this test fail.
    const froms = service.match(/\.from\(/g) ?? [];
    expect(froms.length, "a read bypassed pagedRows").toBe(1);

    const start = service.indexOf("async function pagedRows(");
    expect(start).toBeGreaterThan(-1);
    const body = service.slice(start, service.indexOf("\n}", start));
    expect(body).toMatch(/\.from\(table\)/);
    expect(body, "the chokepoint must pin org_id").toMatch(/\.eq\("org_id", orgId\)/);
  });

  it("the pin is the org argument, never a value read off a row", () => {
    // The #456 class: copying a row's own org_id back into the filter proves
    // nothing. `orgId` is the caller's ACTIVE org and nothing else.
    expect(service).not.toMatch(/\.eq\("org_id",\s*(?:row|r|po|b|l|n)\./);
  });

  it("the page passes the active org from requireOrgContext and nothing else", () => {
    expect(page).toMatch(/requireOrgContext\(\)/);
    expect(page).toMatch(/loadPoMatchingQueue\([^)]*ctx\.org\.id\)/);
    expect(page).not.toMatch(/searchParams/); // no org-ish input from the URL
  });

  it("the briefing passes the active org to the variance signal", () => {
    const briefing = codeOf(read("server/services/briefing.ts"));
    expect(briefing).toMatch(/loadSupplierBillVarianceSignal\([^)]*orgId\)/);
  });
});

// ---------------------------------------------------------------------------
// 3. LOUD READS (#480) — "no discrepancies" must never mean "we could not look"
// ---------------------------------------------------------------------------

describe("the queue fails loudly", () => {
  it("every paged read's error is thrown, one context each", () => {
    // The call sites and the throws must move together. On THIS surface a
    // swallowed error renders "ordered, delivered and invoiced all agree" —
    // the most dangerous sentence the product could say off a rejected query.
    // Every `pagedRows(` less the one declaration is a read that must be
    // followed by its own `throw readFailure(...)`.
    const calls = (service.match(/\bpagedRows\(/g) ?? []).length - 1;
    const throws = (service.match(/throw readFailure\(/g) ?? []).length;
    expect(calls, "no reads found — has pagedRows been renamed?").toBeGreaterThan(0);
    expect(throws).toBe(calls);
  });

  it("uses none of the three error-discarding shapes", () => {
    expect(service).not.toMatch(/const \{ data(?:: [A-Za-z_$][A-Za-z0-9_$]*)? \} = await/);
    expect(service).not.toMatch(/const \{ count(?:: [A-Za-z_$][A-Za-z0-9_$]*)? \} = await/);
    expect(service).not.toMatch(/\)\.data\s*\?\?/);
  });

  it("the ONE best-effort read is the briefing signal, and it says so", () => {
    const src = read(SERVICE);
    expect(src).toMatch(/BEST-EFFORT BY CONTRACT/);
    expect(src).toMatch(/return EMPTY_SUPPLIER_BILL_VARIANCE;/);
    // Exactly one catch in the file — the briefing's. A second would be a
    // silent all-clear on the page itself.
    expect((service.match(/\} catch/g) ?? []).length).toBe(1);
  });

  it("the page does not defend against the throw — the error boundary is the point", () => {
    expect(page).not.toMatch(/try \{/);
    expect(page).not.toMatch(/catch/);
  });
});

// ---------------------------------------------------------------------------
// 4. Paged reads carry a UNIQUE TOTAL ORDER
// ---------------------------------------------------------------------------

describe("paging cannot drop or repeat a row", () => {
  it("the paged read orders by the primary key", () => {
    expect(service).toMatch(/\.order\("id", \{ ascending: true \}\)/);
    expect(service).toMatch(/fetchAllRows</);
  });

  it("no read re-caps the page with a competing limit", () => {
    // fetchAllRows' contract: nothing may shrink the page below pageSize.
    expect(service).not.toMatch(/\.limit\(/);
  });

  it("the in-memory sorts all end in a unique tiebreak", () => {
    // Severity ordering ends on the PO number (unique per org via
    // purchase_orders_org_number_key); the unlinked-bill sample ends on id.
    expect(lib).toMatch(/a\.number\.localeCompare\(b\.number\)/);
    expect(service).toMatch(/a\.id\.localeCompare\(b\.id\)/);
  });
});

// ---------------------------------------------------------------------------
// 5. Posted-only receipt filtering lives in the LIB, so no caller can get it wrong
// ---------------------------------------------------------------------------

describe("voided and draft deliveries never count as received", () => {
  it("the lib does the posted-only filtering itself", () => {
    expect(lib).toMatch(/status === "posted"/);
  });

  it("the service hands over EVERY note, unfiltered, on purpose", () => {
    // If the service pre-filtered to posted notes, the lib could no longer
    // report what it excluded and the page could not say "1 voided" — and the
    // next caller would be free to forget the filter entirely.
    expect(service).not.toMatch(/\.eq\("status", "posted"\)/);
    expect(service).toMatch(/goods_received_notes/);
  });

  it("behaviourally: a voided receipt cannot make a billed order look matched", () => {
    const voided: MatchGrn[] = [
      {
        id: "g1",
        number: "GRN-0001",
        status: "void",
        delivery_date: "2026-07-01",
        lines: [{ purchase_order_line_item_id: "l1", qty_received: 10 }],
      },
    ];
    const r = matchThreeWay({
      poId: "po-1",
      lines: [{ id: "l1", description: "Blocks", unit: "ea", qty: 10, unit_price: 100, vat_rate: 20 }],
      grns: voided,
      bills: [{ id: "b1", purchase_order_id: "po-1", amount: 1000, vat_total: 200 }],
    });
    expect(r.received.gross).toBe(0);
    expect(r.state).toBe("billed_not_received");
    expect(r.findings[0]?.gross).toBe(1200);
  });
});

// ---------------------------------------------------------------------------
// 6. NO TOLERANCE POLICY — the product does not decide what is acceptable
// ---------------------------------------------------------------------------

describe("no tolerance policy is invented anywhere", () => {
  it("the default policy is zero, so every penny is flagged", () => {
    expect(NO_TOLERANCE_POLICY.minMoneyVariance).toBe(0);
  });

  it("the module states that the threshold is a CEO decision", () => {
    const src = read(LIB);
    expect(src).toMatch(/NO TOLERANCE POLICY/);
    expect(src).toMatch(/CEO decision/);
  });

  it("carries exactly ONE numeric floor, and it is the float-noise guard", () => {
    // 0.005 is half a penny — below the resolution of numeric(12,2), so it can
    // absorb float noise and nothing else. Any OTHER bare money constant here
    // would be a business rule smuggled in as a magic number.
    expect(lib).toMatch(/const EPSILON = 0\.005;/);
    const constants = lib.match(/^const [A-Z_]+ = [\d.]+;$/gm) ?? [];
    expect(constants).toEqual(["const EPSILON = 0.005;"]);
    expect(read(LIB)).toMatch(/FLOAT-NOISE guard, NOT a business tolerance/);
  });

  it("the queue page filters nothing out as close enough", () => {
    // No threshold comparison on the page: it renders what the lib flagged.
    expect(page).not.toMatch(/worstVariance\s*[<>]/);
    expect(page).not.toMatch(/gross\s*[<>]\s*\d/);
  });

  it("all money arithmetic goes through lib/money, never a raw float sum", () => {
    for (const [name, src] of [[LIB, lib], [SERVICE, service]] as const) {
      expect(src, `${name} must use lib/money`).toMatch(/from "@\/lib\/money"/);
      expect(src, `${name} must not toFixed money into place`).not.toMatch(/\.toFixed\(2\)/);
    }
  });

  it("no roll-up rebuilds the exposure by adding the two money-out kinds", () => {
    // THE double-count guard, pinned on source. `over_billed` and
    // `billed_not_received` are usually the same pounds seen from two angles, so
    // the only summable figure is `moneyOutAtRisk`. A briefing headline of
    // overBilled + billedNotReceived would send an owner into a supplier meeting
    // with a number that exists nowhere.
    const compose = codeOf(read(COMPOSE));
    expect(compose).toMatch(/round2\(variance\.moneyOutAtRisk\)/);
    expect(compose).not.toMatch(/overBilled\s*\+\s*variance\.billedNotReceived/);
    expect(service).toMatch(/moneyOutAtRisk: sumMoney\(/);
    // The queue page must not print a total of the three tiles either.
    expect(page).not.toMatch(/overBilled\s*\+/);
  });
});

// ---------------------------------------------------------------------------
// 7. IA — the queue extends the purchase-orders area, it does not fork it
// ---------------------------------------------------------------------------

describe("the discrepancy queue lives inside the purchase-orders area", () => {
  it("is a child route of /purchase-orders and links back to the register", () => {
    expect(page).toMatch(/href="\/purchase-orders"/);
    expect(page).toMatch(/from "@\/lib\/purchase-orders\/schema"/); // shared status labels
  });

  it("is reachable from the register", () => {
    expect(codeOf(read(REGISTER))).toMatch(/href="\/purchase-orders\/matching"/);
  });

  it("links every row to the order, its deliveries and its bills", () => {
    expect(page).toMatch(/\/purchase-orders\/\$\{row\.id\}/);
    expect(page).toMatch(/grn=\$\{g\.id\}/);
    expect(page).toMatch(/b\.reference/);
  });

  it("adds no new sidebar entry — the register owns the nav slot", () => {
    // The queue is the register's next question, not a ninth money page in a
    // sidebar that is already long.
    expect(read("app/(app)/_components/sidebar.tsx")).not.toMatch(/purchase-orders\/matching/);
  });

  it("is mobile-first at 375px — no three-across money row on a phone", () => {
    // The container is 1rem-padded and the card px-4, so at 375px each of three
    // columns gets ~98px; a six-figure variance in tabular figures overflows
    // that and pushes the page sideways. Every multi-column block therefore
    // starts at one column and widens from `sm:`.
    // Unprefixed only — a `sm:`/`md:` variant is exactly what we want to see.
    const grids = page.match(/(?<!:)grid-cols-\d/g) ?? [];
    expect(grids.length).toBeGreaterThan(0);
    for (const g of grids) {
      expect(g, `${g} is applied at every width — stack it and widen from sm:`).toBe("grid-cols-1");
    }
    expect(page).toMatch(/sm:grid-cols-3/);
    // Long supplier names must truncate rather than widen the row.
    expect(page).toMatch(/min-w-0/);
    expect(page).toMatch(/truncate/);
    // The link footer wraps instead of overflowing.
    expect(page).toMatch(/flex-wrap/);
  });

  it("reuses the receipt-quantity formatter the order page uses", () => {
    // Two surfaces printing 12.5 m³ differently is how a builder stops trusting
    // both of them.
    expect(page).toMatch(/from "@\/lib\/purchase-orders\/receiving"/);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  warrantyClaimSchema,
  buildClaimSubject,
  buildClaimMessageBody,
  buildPortalWarrantyClaimView,
  toClaimStage,
  WARRANTY_CLAIM_PORTAL_KEYS,
} from "@/lib/warranties/claims";

/**
 * Warranty claims (P3) — a claim is a support_tickets row (category
 * 'warranty_claim', warranty_id set). Two invariants make that safe on a
 * token-only auth surface:
 *
 *   • WRITE: org_id + customer_id + warranty_id are ALL stamped from the
 *     token-resolved customer and a warranty VERIFIED to be one of that
 *     customer's own — the form supplies summary/details only, so a crafted
 *     warranty_id for another customer/org is rejected before any insert.
 *   • READ-BACK: the ticket read filters on org_id AND customer_id AND an
 *     `.in("warranty_id", <the customer's own visible warranty ids>)`, and rows
 *     exit through a projection with no assignee/priority/notes/raw-status field.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) =>
  readFileSync(resolve(ROOT, p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const ACTION = read("app/customer-portal/_warranty-claim-action.ts");
const LOADER = read("app/customer-portal/_warranty-claims.ts");
const PAGE = read("app/customer-portal/[token]/warranties/page.tsx");

describe("input validation is bounded", () => {
  it("accepts a well-formed claim and rejects out-of-bounds input", () => {
    expect(
      warrantyClaimSchema.safeParse({
        summary: "Boiler losing pressure",
        details: "Pressure drops to zero overnight, started last week.",
      }).success,
    ).toBe(true);
    expect(warrantyClaimSchema.safeParse({ summary: "ab", details: "long enough here" }).success).toBe(false);
    expect(warrantyClaimSchema.safeParse({ summary: "ok summary", details: "short" }).success).toBe(false);
    expect(warrantyClaimSchema.safeParse({ summary: "x".repeat(201), details: "long enough here" }).success).toBe(false);
  });

  it("the subject is prefixed and clamped to the 200-char ticket cap", () => {
    const subj = buildClaimSubject("X".repeat(300), "Y".repeat(300));
    expect(subj.length).toBeLessThanOrEqual(200);
    expect(subj.startsWith("Warranty claim — ")).toBe(true);
  });

  it("the message body carries provenance + warranty + details", () => {
    const body = buildClaimMessageBody({
      customerName: "Acme Ltd",
      warrantyTitle: "Boiler cover",
      jobReference: "abcd1234",
      details: "It leaks",
    });
    expect(body).toContain("Warranty claim from Acme Ltd via the customer portal");
    expect(body).toContain("Boiler cover");
    expect(body).toContain("abcd1234");
    expect(body).toContain("It leaks");
  });
});

describe("the write stamps identity + verifies warranty ownership", () => {
  it("org_id, customer_id and warranty_id come from the token-resolved customer / verified warranty", () => {
    expect(ACTION).toMatch(/org_id: customer\.org_id/);
    expect(ACTION).toMatch(/customer_id: customer\.id/);
    expect(ACTION).toMatch(/warranty_id: warranty\.id/);
    expect(ACTION).toMatch(/category: "warranty_claim"/);
  });

  it("the form is never consulted for identity", () => {
    for (const field of ["customer_id", "org_id", "status", "category", "created_by"]) {
      expect(ACTION, `formData.get("${field}") must not exist`).not.toContain(
        `formData.get("${field}")`,
      );
    }
  });

  it("resolves the token AND verifies the warranty is the customer's own before inserting", () => {
    expect(ACTION).toMatch(/loadCustomerByPortalToken\(token\)/);
    expect(ACTION).toMatch(/listPortalWarranties\(customer\.id, customer\.org_id\)/);
    expect(ACTION).toMatch(/warranties\.find\(\(w\) => w\.id === warrantyId\)/);
    // Ownership check happens BEFORE the insert.
    expect(ACTION.indexOf("listPortalWarranties")).toBeLessThan(ACTION.indexOf(".insert({"));
    // A missing/foreign warranty is rejected.
    expect(ACTION).toMatch(/warranty_not_found/);
  });

  it("is rate-limited on the shared portal_write budget", () => {
    expect(ACTION).toMatch(/consume\("portal_write", token, DEFAULT_LIMITS\.portal_write\)/);
  });
});

describe("the read-back is provably customer-scoped and projection-limited", () => {
  it("short-circuits on an empty warranty set — never an unfiltered .in()", () => {
    expect(LOADER).toMatch(/if \(warrantyIds\.length === 0\) return \[\]/);
  });

  it("filters on org_id AND customer_id AND warranty_id (the customer's own ids)", () => {
    expect(LOADER).toMatch(
      /\.eq\("org_id", orgId\)\s*\n?\s*\.eq\("customer_id", customerId\)\s*\n?\s*\.in\("warranty_id", warrantyIds\)/,
    );
  });

  it("is paged (F-1) on a stable unique order", () => {
    expect(LOADER).toMatch(/fetchAllRows/);
    expect(LOADER).toMatch(/\.range\(from, to\)/);
    expect(LOADER).toMatch(/\.order\("id", \{ ascending: false \}\)/);
  });

  it("selects only projected columns — staff fields are never read", () => {
    expect(LOADER).toMatch(/select\("id, ticket_number, warranty_id, subject, status, created_at"\)/);
    for (const internal of ["assigned_to", "priority", "last_reply", "internal"]) {
      expect(LOADER, `must not read support_tickets.${internal}`).not.toContain(internal);
    }
  });

  it("fails loud rather than rendering empty over a failed read", () => {
    expect(LOADER).toMatch(/throw readFailure\("portal warranty claims: tickets", error\)/);
  });

  it("rows exit through the projection only", () => {
    expect(LOADER).toMatch(/buildPortalWarrantyClaimView\(row\)/);
    expect(LOADER).not.toMatch(/\.\.\.row/);
  });
});

describe("the coarse claim stage — ticket internals never round-trip", () => {
  const view = buildPortalWarrantyClaimView({
    id: "t1",
    ticket_number: 42,
    warranty_id: "w1",
    subject: "Warranty claim — Boiler: leak",
    status: "waiting_on_customer",
    created_at: "2026-08-01T09:00:00.000Z",
    // Whole-row shape a spread/select("*") would produce.
    assigned_to: "SENTINEL-STAFF-UUID",
    priority: "urgent",
    org_id: "SENTINEL-ORG-UUID",
  } as Parameters<typeof buildPortalWarrantyClaimView>[0]);

  it("has exactly the declared key set", () => {
    expect(Object.keys(view).sort()).toEqual([...WARRANTY_CLAIM_PORTAL_KEYS].sort());
  });

  it("maps raw ticket status to a coarse customer-safe word", () => {
    expect(view.stage).toBe("awaiting_you");
    expect(toClaimStage("open")).toBe("submitted");
    expect(toClaimStage("in_progress")).toBe("in_review");
    expect(toClaimStage("resolved")).toBe("resolved");
    expect(toClaimStage("SENTINEL-INTERNAL")).toBe("submitted");
  });

  it("sentinel staff fields never serialise", () => {
    const json = JSON.stringify(view);
    for (const v of ["SENTINEL-STAFF-UUID", "urgent", "SENTINEL-ORG-UUID"]) {
      expect(json).not.toContain(v);
    }
  });
});

describe("cross-customer isolation proof", () => {
  // The read-back's WHERE is (org_id, customer_id, warranty_id in ownIds). Model
  // it: given two customers in the same org, customer B's claim is unreachable
  // from customer A's scoped read because BOTH the customer_id filter AND the
  // warranty-id membership fail.
  type Ticket = { org_id: string; customer_id: string; warranty_id: string; status: string };
  const scopedRead = (
    all: Ticket[],
    orgId: string,
    customerId: string,
    ownWarrantyIds: string[],
  ) =>
    all.filter(
      (t) =>
        t.org_id === orgId &&
        t.customer_id === customerId &&
        ownWarrantyIds.includes(t.warranty_id),
    );

  const claims: Ticket[] = [
    { org_id: "org1", customer_id: "A", warranty_id: "wA", status: "open" },
    { org_id: "org1", customer_id: "B", warranty_id: "wB", status: "open" },
    { org_id: "org2", customer_id: "C", warranty_id: "wC", status: "open" },
  ];

  it("customer A sees only their own claim; B's and another org's are invisible", () => {
    const a = scopedRead(claims, "org1", "A", ["wA"]);
    expect(a).toHaveLength(1);
    expect(a[0]!.customer_id).toBe("A");
  });

  it("a forged warranty id (B's) does not widen A's read", () => {
    // Even if A's page passed B's warranty id, the customer_id filter still bites.
    const forged = scopedRead(claims, "org1", "A", ["wA", "wB"]);
    expect(forged.every((t) => t.customer_id === "A")).toBe(true);
    expect(forged.map((t) => t.warranty_id)).not.toContain("wB");
  });
});

describe("the page surface", () => {
  it("loads through the chokepoint and scopes the claim read to the customer's warranty ids", () => {
    expect(PAGE).toMatch(/loadCustomerByPortalToken\(token\)/);
    expect(PAGE).toMatch(/listPortalWarrantyClaims\(/);
    expect(PAGE).toMatch(/warranties\.map\(\(w\) => w\.id\)/);
    expect(PAGE).toMatch(/InvalidLinkPage kind="portal"/);
  });
});

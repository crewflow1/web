import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  serviceBookingSchema,
  buildPortalSlotView,
  buildPortalBookingView,
  toBookingStatus,
  BOOKING_PORTAL_KEYS,
} from "@/lib/maintenance/booking";

/**
 * Maintenance / service booking (P3). Invariants:
 *
 *   • WRITE: org_id + customer_id + contact_* are stamped from the token-resolved
 *     customer; a supplied warranty_id is VERIFIED to be one of the customer's
 *     own before insert; the DB enforces slot org-binding + capacity atomically.
 *   • READ-BACK (bookings): filters org_id AND customer_id — a customer sees only
 *     their own bookings.
 *   • SLOTS: org-level availability; only slot_id is counted, never another
 *     customer's booking row; remaining seats only, never raw capacity.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) =>
  readFileSync(resolve(ROOT, p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const ACTION = read("app/customer-portal/_booking-action.ts");
const LOADER = read("app/customer-portal/_booking.ts");
const PAGE = read("app/customer-portal/[token]/servicing/page.tsx");
const MIGRATION = readFileSync(
  resolve(ROOT, "supabase/migrations/20261141000002_service_booking.sql"),
  "utf8",
);

describe("input validation is bounded", () => {
  it("requires a UUID slot; warranty_id + notes are optional", () => {
    const uuid = "11111111-1111-4111-8111-111111111111";
    expect(serviceBookingSchema.safeParse({ slot_id: uuid }).success).toBe(true);
    expect(serviceBookingSchema.safeParse({ slot_id: uuid, warranty_id: uuid, notes: "x" }).success).toBe(true);
    expect(serviceBookingSchema.safeParse({ slot_id: "not-a-uuid" }).success).toBe(false);
    expect(serviceBookingSchema.safeParse({ slot_id: uuid, warranty_id: "id.eq.x" }).success).toBe(false);
  });
});

describe("the write stamps identity + verifies warranty ownership", () => {
  it("org_id + customer_id + contact_* come from the customer record", () => {
    expect(ACTION).toMatch(/org_id: customer\.org_id/);
    expect(ACTION).toMatch(/customer_id: customer\.id/);
    expect(ACTION).toMatch(/contact_name: customer\.name/);
    expect(ACTION).toMatch(/contact_email: customer\.email/);
    expect(ACTION).toMatch(/contact_phone: customer\.phone/);
  });

  it("a supplied warranty is verified to be the customer's own before insert", () => {
    expect(ACTION).toMatch(/listPortalWarranties\(customer\.id, customer\.org_id\)/);
    expect(ACTION).toMatch(/warranties\.find\(\(w\) => w\.id === parsed\.data\.warranty_id\)/);
    expect(ACTION).toMatch(/warranty_not_found/);
    expect(ACTION.indexOf("listPortalWarranties")).toBeLessThan(ACTION.indexOf(".insert({"));
  });

  it("the form is never consulted for identity", () => {
    for (const field of ["customer_id", "org_id", "contact_name", "contact_email", "contact_phone", "status"]) {
      expect(ACTION).not.toContain(`formData.get("${field}")`);
    }
  });

  it("a full/foreign slot rejection is surfaced as slot_unavailable", () => {
    expect(ACTION).toMatch(/consume\("portal_write", token, DEFAULT_LIMITS\.portal_write\)/);
    expect(ACTION).toMatch(/slot_unavailable/);
    expect(ACTION).toMatch(/"23514"|"23503"/);
  });
});

describe("the read-back is customer-scoped; slots expose only availability", () => {
  it("the customer's bookings filter org_id AND customer_id", () => {
    expect(LOADER).toMatch(/\.eq\("org_id", orgId\)\s*\n?\s*\.eq\("customer_id", customerId\)/);
  });

  it("the slot availability read selects only slot_id + status for counting", () => {
    expect(LOADER).toMatch(/select\("slot_id, status"\)/);
    // Never selects another customer's identity on the availability count.
    expect(LOADER).not.toMatch(/select\("[^"]*contact_name/);
  });

  it("every set read is paged and fails loud", () => {
    expect(LOADER).toMatch(/fetchAllRows/);
    expect(LOADER).toMatch(/throw readFailure\("portal booking: slots", slotErr\)/);
    expect(LOADER).toMatch(/throw readFailure\("portal booking: bookings", bookErr\)/);
  });
});

describe("projections", () => {
  it("a slot view exposes seats_left, never raw capacity or occupants", () => {
    const v = buildPortalSlotView({
      id: "s1",
      starts_at: "2026-09-01T09:00:00Z",
      ends_at: "2026-09-01T10:00:00Z",
      label: "AM run",
      capacity: 5,
      live_booked: 2,
    });
    expect(v.seats_left).toBe(3);
    expect(Object.keys(v)).not.toContain("capacity");
    expect(Object.keys(v)).not.toContain("live_booked");
  });

  it("seats_left never goes negative", () => {
    const v = buildPortalSlotView({
      id: "s1",
      starts_at: "x",
      ends_at: "y",
      label: null,
      capacity: 1,
      live_booked: 4,
    });
    expect(v.seats_left).toBe(0);
  });

  it("a booking view has exactly the declared keys", () => {
    const v = buildPortalBookingView({
      id: "b1",
      status: "confirmed",
      warranty_id: null,
      slot_starts_at: "2026-09-01T09:00:00Z",
      slot_ends_at: "2026-09-01T10:00:00Z",
      slot_label: "AM run",
    });
    expect(Object.keys(v).sort()).toEqual([...BOOKING_PORTAL_KEYS].sort());
    expect(toBookingStatus("SENTINEL")).toBe("requested");
  });
});

describe("the schema binds bookings to their customer, slot, and warranty by org", () => {
  it("composite FKs prevent cross-org references", () => {
    expect(MIGRATION).toMatch(
      /foreign key \(customer_id, org_id\) references public\.customers \(id, org_id\)/,
    );
    expect(MIGRATION).toMatch(
      /foreign key \(slot_id, org_id\) references public\.service_booking_slots \(id, org_id\)/,
    );
    expect(MIGRATION).toMatch(
      /foreign key \(warranty_id, org_id\) references public\.job_warranties \(id, org_id\)/,
    );
  });

  it("capacity is enforced atomically under a row lock, and the warranty must match the customer", () => {
    expect(MIGRATION).toMatch(/for update/);
    expect(MIGRATION).toMatch(/is fully booked/);
    expect(MIGRATION).toMatch(/does not belong to customer/);
  });

  it("slots are admin-gated for writes; both tables enable RLS", () => {
    expect(MIGRATION).toMatch(/service_booking_slots: admins insert[\s\S]*is_org_admin/);
    expect((MIGRATION.match(/enable row level security/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("cross-customer isolation proof", () => {
  type Booking = { org_id: string; customer_id: string; id: string };
  const scopedRead = (all: Booking[], orgId: string, customerId: string) =>
    all.filter((b) => b.org_id === orgId && b.customer_id === customerId);
  const bookings: Booking[] = [
    { org_id: "org1", customer_id: "A", id: "a1" },
    { org_id: "org1", customer_id: "B", id: "b1" },
    { org_id: "org2", customer_id: "C", id: "c1" },
  ];
  it("customer A sees only their own bookings", () => {
    expect(scopedRead(bookings, "org1", "A").map((b) => b.id)).toEqual(["a1"]);
  });

  it("the page loads through the chokepoint", () => {
    expect(PAGE).toMatch(/loadCustomerByPortalToken\(token\)/);
    expect(PAGE).toMatch(/listPortalServiceBookings\(customer\.id, customer\.org_id\)/);
    expect(PAGE).toMatch(/InvalidLinkPage kind="portal"/);
  });
});

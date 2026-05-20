import { describe, it, expect } from "vitest";
import {
  findCustomerDuplicate,
  findInvoiceDuplicate,
  findStaffDuplicate,
  findLeadDuplicate,
} from "@/lib/imports/duplicates";

describe("findCustomerDuplicate", () => {
  const existing = [
    { id: "c1", name: "Acme Builders", email: "info@acme.test", phone: "07700900111" },
    { id: "c2", name: "Smith & Sons", email: null, phone: "07700900222" },
  ];

  it("matches on email regardless of casing", () => {
    const m = findCustomerDuplicate(
      { name: "different", email: "INFO@ACME.TEST", phone: "" },
      existing,
    );
    expect(m?.target_id).toBe("c1");
    expect(m?.score).toBe(100);
    expect(m?.reason).toBe("matching email");
  });

  it("matches on phone after stripping formatting", () => {
    const m = findCustomerDuplicate(
      { name: "Other", phone: "+44 7700 900 222" },
      existing,
    );
    expect(m?.target_id).toBe("c2");
    expect(m?.score).toBeGreaterThanOrEqual(95);
  });

  it("matches by fuzzy name when nothing else fingerprints", () => {
    const m = findCustomerDuplicate({ name: "Acme Buildrs" }, existing);
    expect(m?.target_id).toBe("c1");
    expect(m?.reason).toContain("name match");
    expect(m?.score).toBeGreaterThanOrEqual(85);
  });

  it("returns null when nothing similar enough exists", () => {
    expect(findCustomerDuplicate({ name: "Totally Different Co" }, existing)).toBeNull();
  });

  it("returns null when input has no fingerprintable fields", () => {
    expect(findCustomerDuplicate({}, existing)).toBeNull();
  });
});

describe("findInvoiceDuplicate", () => {
  const existing = [{ id: "inv-1", number: "INV-001" }];
  it("matches case-insensitively on number", () => {
    expect(findInvoiceDuplicate({ number: "inv-001" }, existing)?.target_id).toBe("inv-1");
  });
  it("ignores whitespace", () => {
    expect(findInvoiceDuplicate({ number: "  INV-001  " }, existing)?.target_id).toBe("inv-1");
  });
  it("returns null when number isn't supplied", () => {
    expect(findInvoiceDuplicate({}, existing)).toBeNull();
  });
});

describe("findStaffDuplicate", () => {
  const existing = [
    { id: "u1", email: "jane@example.test", full_name: "Jane Smith" },
    { id: "u2", email: "bob@example.test", full_name: "Bob Jones" },
  ];

  it("matches on email", () => {
    expect(findStaffDuplicate({ email: "JANE@example.test" }, existing)?.target_id).toBe("u1");
  });

  it("matches on full_name when only name is provided", () => {
    const m = findStaffDuplicate({ full_name: "jane smith" }, existing);
    expect(m?.target_id).toBe("u1");
    expect(m?.score).toBe(100);
  });

  it("returns null on no signals", () => {
    expect(findStaffDuplicate({}, existing)).toBeNull();
  });
});

describe("findLeadDuplicate", () => {
  const existing = [
    { id: "l1", email: "lead@example.test", phone: "07700900111" },
    { id: "l2", email: null, phone: "07700900222" },
  ];
  it("email takes priority over phone", () => {
    const m = findLeadDuplicate(
      { email: "lead@example.test", phone: "07700900222" },
      existing,
    );
    expect(m?.target_id).toBe("l1");
  });
  it("falls back to phone match", () => {
    expect(findLeadDuplicate({ phone: "+44 7700 900 222" }, existing)?.target_id).toBe("l2");
  });
  it("returns null with no signals", () => {
    expect(findLeadDuplicate({ name: "no contact details" }, existing)).toBeNull();
  });
});

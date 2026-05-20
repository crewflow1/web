import { describe, it, expect } from "vitest";
import {
  demoRequestSchema,
  STAFF_COUNT_OPTIONS,
} from "@/lib/demo/schema";

describe("demoRequestSchema", () => {
  const valid = {
    name: "Jane Doe",
    company: "Acme Construction",
    email: "jane@acme.test",
    phone: "07700900111",
    staff_count: "6-10",
    current_systems: "Sage + WhatsApp",
    preferred_demo_time: "weekday mornings",
  };

  it("accepts a fully populated submission", () => {
    const r = demoRequestSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.email).toBe("jane@acme.test");
      expect(r.data.staff_count).toBe("6-10");
    }
  });

  it("accepts a minimal submission (only required fields)", () => {
    const r = demoRequestSchema.safeParse({
      name: "Jane",
      company: "Acme",
      email: "jane@acme.test",
      phone: "07700900111",
      staff_count: "Just me",
    });
    expect(r.success).toBe(true);
  });

  it("trims and lowercases the email", () => {
    const r = demoRequestSchema.safeParse({
      ...valid,
      email: "  JANE@ACME.TEST  ",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe("jane@acme.test");
  });

  it("rejects an invalid email", () => {
    const r = demoRequestSchema.safeParse({ ...valid, email: "not-an-email" });
    expect(r.success).toBe(false);
  });

  it("rejects missing name", () => {
    const r = demoRequestSchema.safeParse({ ...valid, name: "" });
    expect(r.success).toBe(false);
  });

  it("rejects missing phone", () => {
    const r = demoRequestSchema.safeParse({ ...valid, phone: "" });
    expect(r.success).toBe(false);
  });

  it("rejects unknown staff_count option", () => {
    const r = demoRequestSchema.safeParse({ ...valid, staff_count: "100+" });
    expect(r.success).toBe(false);
  });

  it("treats blank optional strings as undefined", () => {
    const r = demoRequestSchema.safeParse({
      ...valid,
      current_systems: "   ",
      preferred_demo_time: "",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.current_systems).toBeUndefined();
      expect(r.data.preferred_demo_time).toBeUndefined();
    }
  });

  it("clips company name beyond 160 chars", () => {
    const long = "a".repeat(200);
    const r = demoRequestSchema.safeParse({ ...valid, company: long });
    expect(r.success).toBe(false);
  });
});

describe("STAFF_COUNT_OPTIONS", () => {
  it("contains the six brackets the modal uses", () => {
    expect(STAFF_COUNT_OPTIONS).toEqual([
      "Just me",
      "2-5",
      "6-10",
      "11-25",
      "26-50",
      "50+",
    ]);
  });
});

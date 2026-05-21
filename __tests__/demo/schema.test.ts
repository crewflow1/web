import { describe, it, expect } from "vitest";
import {
  demoRequestSchema,
  EMPLOYEE_RANGES,
  TURNOVER_RANGES,
  TURNOVER_LABELS,
} from "@/lib/demo/schema";

describe("demoRequestSchema", () => {
  const valid = {
    name: "Jane Doe",
    company: "Acme Construction",
    email: "jane@acme.test",
    phone: "07700900111",
    employees: "6-10",
    turnover_range: "500k_1m",
    current_systems: "Sage + WhatsApp",
    preferred_demo_time: "weekday mornings",
  };

  it("accepts a fully populated valid submission", () => {
    const r = demoRequestSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.email).toBe("jane@acme.test");
      expect(r.data.company).toBe("Acme Construction");
    }
  });

  it("accepts a minimal submission (only required fields)", () => {
    const r = demoRequestSchema.safeParse({
      name: "Jane",
      company: "Acme",
      email: "jane@acme.test",
      employees: "1",
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

  it("rejects unknown employee range", () => {
    const r = demoRequestSchema.safeParse({ ...valid, employees: "100+" });
    expect(r.success).toBe(false);
  });

  it("treats empty optional strings as undefined", () => {
    const r = demoRequestSchema.safeParse({
      ...valid,
      phone: "",
      current_systems: "   ",
      preferred_demo_time: "",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.phone).toBeUndefined();
      expect(r.data.current_systems).toBeUndefined();
      expect(r.data.preferred_demo_time).toBeUndefined();
    }
  });

  it("clips company name at 160 chars", () => {
    const long = "a".repeat(200);
    const r = demoRequestSchema.safeParse({ ...valid, company: long });
    expect(r.success).toBe(false);
  });
});

describe("EMPLOYEE_RANGES + TURNOVER constants", () => {
  it("EMPLOYEE_RANGES has 6 brackets", () => {
    expect(EMPLOYEE_RANGES).toEqual(["1", "2-5", "6-10", "11-25", "26-50", "50+"]);
  });
  it("every TURNOVER_RANGES key has a human label", () => {
    for (const k of TURNOVER_RANGES) {
      expect(TURNOVER_LABELS[k]).toBeTruthy();
    }
  });
});

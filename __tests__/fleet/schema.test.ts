import { describe, it, expect } from "vitest";
import {
  fuelLogSchema,
  normaliseRegistration,
  vehicleFormSchema,
} from "@/lib/fleet/schema";

/**
 * Fleet input validation. These mirror the DB CHECK constraints in
 * 20261056000000 and 20261058000000 — the database remains the enforcement
 * boundary, so every case here is about giving the user a sentence instead of a
 * Postgres error, never about being the only thing standing in the way.
 */

const UUID = "11111111-1111-4111-8111-111111111111";

function vehicle(over: Record<string, unknown> = {}) {
  return vehicleFormSchema.safeParse({
    name: "Transit 350",
    registration: "",
    manufacturer: "",
    model: "",
    supplier_id: "",
    purchase_date: "",
    purchase_price: "",
    notes: "",
    vin: "",
    variant: "",
    year_of_manufacture: "",
    first_registered_on: "",
    fuel_type: "",
    vehicle_class: "",
    gross_weight_kg: "",
    mot_exempt: false,
    operational_status: "",
    finance_type: "",
    finance_provider_id: "",
    finance_agreement_ref: "",
    finance_monthly_payment: "",
    finance_end_date: "",
    home_depot: "",
    odometer_miles: "",
    ...over,
  });
}

describe("normaliseRegistration", () => {
  it("uppercases and strips spaces so 'ab12 cde' and 'AB12CDE' are one plate", () => {
    expect(normaliseRegistration("ab12 cde")).toBe("AB12CDE");
    expect(normaliseRegistration("AB12CDE")).toBe("AB12CDE");
    expect(normaliseRegistration(" ab 12 cde ")).toBe("AB12CDE");
  });

  it("returns null for blank or absent input", () => {
    expect(normaliseRegistration("")).toBeNull();
    expect(normaliseRegistration("   ")).toBeNull();
    expect(normaliseRegistration(null)).toBeNull();
    expect(normaliseRegistration(undefined)).toBeNull();
  });
});

describe("vehicleFormSchema", () => {
  it("needs only a name — everything else can follow later", () => {
    const r = vehicle();
    expect(r.success).toBe(true);
    expect(r.data?.operational_status).toBe("in_service");
    expect(r.data?.finance_type).toBe("none");
  });

  it("rejects an empty name with a usable message", () => {
    const r = vehicle({ name: "  " });
    expect(r.success).toBe(false);
    expect(r.error?.flatten().fieldErrors.name?.[0]).toMatch(/name/i);
  });

  it("normalises the registration to uppercase, spaces stripped", () => {
    expect(vehicle({ registration: "ab12 cde" }).data?.registration).toBe("AB12CDE");
  });

  it("accepts a 17-character VIN and uppercases it", () => {
    const r = vehicle({ vin: "wf0xxxttgxkr12345" });
    expect(r.success).toBe(true);
    expect(r.data?.vin).toBe("WF0XXXTTGXKR12345");
  });

  it("accepts a shorter VIN from an older or imported vehicle", () => {
    expect(vehicle({ vin: "AB123456789" }).success).toBe(true); // 11 chars
  });

  it("rejects a VIN containing I, O or Q — real VINs never do", () => {
    expect(vehicle({ vin: "WF0XXXTTGXKR1234I" }).success).toBe(false);
    expect(vehicle({ vin: "WF0XXXTTGXKR1234O" }).success).toBe(false);
    expect(vehicle({ vin: "WF0XXXTTGXKR1234Q" }).success).toBe(false);
  });

  it("rejects a VIN that is too short or too long", () => {
    expect(vehicle({ vin: "ABC123" }).success).toBe(false);
    expect(vehicle({ vin: "A".repeat(18) }).success).toBe(false);
  });

  it("strips spaces and hyphens from a VIN before validating", () => {
    expect(vehicle({ vin: "WF0X-XXTT GXKR12345" }).data?.vin).toBe("WF0XXXTTGXKR12345");
  });

  it("rejects an odometer that is negative or fractional", () => {
    expect(vehicle({ odometer_miles: "-1" }).success).toBe(false);
    expect(vehicle({ odometer_miles: "100.5" }).success).toBe(false);
    expect(vehicle({ odometer_miles: "0" }).success).toBe(true);
  });

  it("rejects an odometer beyond the DB bound", () => {
    expect(vehicle({ odometer_miles: "3000001" }).success).toBe(false);
    expect(vehicle({ odometer_miles: "3000000" }).success).toBe(true);
  });

  it("enforces finance coherence — agreement detail needs an agreement", () => {
    const r = vehicle({ finance_type: "none", finance_agreement_ref: "HP-1234" });
    expect(r.success).toBe(false);
    expect(r.error?.flatten().fieldErrors.finance_type?.[0]).toMatch(/finance type/i);
  });

  it("allows agreement detail once a finance type is chosen", () => {
    const r = vehicle({
      finance_type: "hire_purchase",
      finance_agreement_ref: "HP-1234",
      finance_monthly_payment: "412.50",
      finance_end_date: "2029-03-01",
      finance_provider_id: UUID,
    });
    expect(r.success).toBe(true);
    expect(r.data?.finance_monthly_payment).toBe(412.5);
  });

  it("rejects a malformed date rather than passing it to Postgres", () => {
    expect(vehicle({ first_registered_on: "01/03/2020" }).success).toBe(false);
  });

  it("rejects an out-of-range year", () => {
    expect(vehicle({ year_of_manufacture: "1899" }).success).toBe(false);
    expect(vehicle({ year_of_manufacture: "2101" }).success).toBe(false);
  });
});

function fuel(over: Record<string, unknown> = {}) {
  return fuelLogSchema.safeParse({
    asset_id: UUID,
    filled_on: "2026-07-28",
    odometer_miles: "",
    litres: "",
    cost: "90.00",
    is_full_fill: true,
    supplier_id: "",
    station: "",
    driver_id: "",
    notes: "",
    ...over,
  });
}

describe("fuelLogSchema", () => {
  it("accepts a cost-only entry (an EV charge has no litres)", () => {
    const r = fuel({ litres: "" });
    expect(r.success).toBe(true);
    expect(r.data?.litres).toBeUndefined();
  });

  it("accepts a litres-only entry with zero cost (a bulk tank draw)", () => {
    expect(fuel({ cost: "0", litres: "55" }).success).toBe(true);
  });

  it("rejects an entry with neither litres nor cost — it records nothing", () => {
    const r = fuel({ cost: "0", litres: "" });
    expect(r.success).toBe(false);
    expect(r.error?.flatten().fieldErrors.cost?.[0]).toMatch(/records nothing/i);
  });

  it("rejects zero or negative litres — a fill is a real quantity", () => {
    expect(fuel({ litres: "0" }).success).toBe(false);
    expect(fuel({ litres: "-5" }).success).toBe(false);
  });

  it("rejects a negative cost", () => {
    expect(fuel({ cost: "-1" }).success).toBe(false);
  });

  it("rejects a malformed date", () => {
    expect(fuel({ filled_on: "28-07-2026" }).success).toBe(false);
  });

  it("treats the checkbox 'on' value as a full fill", () => {
    expect(fuel({ is_full_fill: "on" }).data?.is_full_fill).toBe(true);
    expect(fuel({ is_full_fill: "" }).data?.is_full_fill).toBe(false);
  });
});

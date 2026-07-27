import { describe, expect, it } from "vitest";
import {
  ASSET_OWNERSHIPS,
  ASSET_OWNERSHIP_LABELS,
  ASSET_STATUSES,
  ASSET_STATUS_LABELS,
  createAssetSchema,
  isDisposed,
} from "@/lib/assets/schema";

describe("asset constants", () => {
  it("labels every status and ownership", () => {
    for (const s of ASSET_STATUSES) expect(ASSET_STATUS_LABELS[s]).toBeTruthy();
    for (const o of ASSET_OWNERSHIPS) expect(ASSET_OWNERSHIP_LABELS[o]).toBeTruthy();
  });

  it("treats everything but active as disposed", () => {
    expect(isDisposed("active")).toBe(false);
    for (const s of ASSET_STATUSES.filter((x) => x !== "active")) {
      expect(isDisposed(s), s).toBe(true);
    }
  });
});

describe("createAssetSchema", () => {
  it("accepts a minimal asset (name only) with defaults", () => {
    const a = createAssetSchema.parse({ name: "Kubota KX016 digger" });
    expect(a.name).toBe("Kubota KX016 digger");
    expect(a.ownership).toBe("owned");
    expect(a.status).toBe("active");
    expect(a.serial_number).toBeUndefined();
  });

  it("requires a name", () => {
    expect(createAssetSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("coerces blank optionals to undefined (no empty writes)", () => {
    const a = createAssetSchema.parse({
      name: "Genset",
      manufacturer: "",
      serial_number: "",
      supplier_id: "",
      purchase_price: "",
      purchase_date: "",
      registration: "",
    });
    expect(a.manufacturer).toBeUndefined();
    expect(a.serial_number).toBeUndefined();
    expect(a.supplier_id).toBeUndefined();
    expect(a.purchase_price).toBeUndefined();
    expect(a.purchase_date).toBeUndefined();
  });

  it("coerces money and rejects negatives / non-numeric", () => {
    expect(
      createAssetSchema.parse({ name: "x", purchase_price: "12500.50" }).purchase_price,
    ).toBe(12500.5);
    expect(
      createAssetSchema.safeParse({ name: "x", current_value: "-1" }).success,
    ).toBe(false);
    expect(
      createAssetSchema.safeParse({ name: "x", hire_rate: "lots" }).success,
    ).toBe(false);
  });

  it("validates dates and ownership/status enums", () => {
    expect(
      createAssetSchema.safeParse({ name: "x", purchase_date: "01/02/2026" }).success,
    ).toBe(false);
    expect(
      createAssetSchema.safeParse({ name: "x", ownership: "leased" }).success,
    ).toBe(false);
    const ok = createAssetSchema.parse({
      name: "Hired telehandler",
      ownership: "hired",
      status: "active",
      hire_start: "2026-07-01",
      hire_end: "2026-08-01",
      hire_rate: "180",
    });
    expect(ok.ownership).toBe("hired");
    expect(ok.hire_rate).toBe(180);
  });

  it("rejects a non-uuid supplier reference", () => {
    expect(
      createAssetSchema.safeParse({ name: "x", supplier_id: "nope" }).success,
    ).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import {
  CALIBRATION_RESULTS,
  CALIBRATION_RESULT_LABELS,
  CALIBRATION_EXPIRY_LABELS,
  resultIsFit,
  classifyCalibrationExpiry,
  currentCalibrationStatus,
  recordCalibrationSchema,
  friendlyCalibrationError,
} from "@/lib/assets/calibration";

const TODAY = "2026-08-15";

describe("calibration constants", () => {
  it("labels every result and expiry state", () => {
    for (const r of CALIBRATION_RESULTS) expect(CALIBRATION_RESULT_LABELS[r]).toBeTruthy();
    for (const s of ["no_expiry", "valid", "due_soon", "expired"] as const) {
      expect(CALIBRATION_EXPIRY_LABELS[s]).toBeTruthy();
    }
  });
});

describe("resultIsFit", () => {
  it("treats pass / pass_with_adjustment as fit and the rest as not", () => {
    expect(resultIsFit("pass")).toBe(true);
    expect(resultIsFit("pass_with_adjustment")).toBe(true);
    expect(resultIsFit("fail")).toBe(false);
    expect(resultIsFit("limited")).toBe(false);
    expect(resultIsFit("indicative")).toBe(false);
  });
});

describe("classifyCalibrationExpiry (boundary: valid THROUGH the due day)", () => {
  it("is no_expiry when there is no next-due", () => {
    expect(classifyCalibrationExpiry(null, TODAY).state).toBe("no_expiry");
  });
  it("is due_soon exactly on the due day (day 0), not expired", () => {
    expect(classifyCalibrationExpiry("2026-08-15", TODAY).state).toBe("due_soon");
  });
  it("is expired strictly after the due day", () => {
    const r = classifyCalibrationExpiry("2026-08-14", TODAY);
    expect(r.state).toBe("expired");
    expect(r.daysUntilDue).toBe(-1);
  });
  it("is due_soon inside the lead window and valid beyond it", () => {
    expect(classifyCalibrationExpiry("2026-09-10", TODAY).state).toBe("due_soon"); // 26 days
    expect(classifyCalibrationExpiry("2026-10-20", TODAY).state).toBe("valid"); // 66 days
  });
  it("honours a custom lead window", () => {
    expect(classifyCalibrationExpiry("2026-09-10", TODAY, 7).state).toBe("valid"); // 26 > 7
  });
});

describe("currentCalibrationStatus", () => {
  it("is no_expiry with no certificates", () => {
    expect(currentCalibrationStatus([], TODAY).state).toBe("no_expiry");
  });

  it("lets the latest calibration govern the expiry state", () => {
    const status = currentCalibrationStatus(
      [
        { calibration_date: "2024-01-01", next_due_date: "2025-01-01", result: "pass" }, // old, expired
        { calibration_date: "2026-01-01", next_due_date: "2027-01-01", result: "pass" }, // newest, valid
      ],
      TODAY,
    );
    expect(status.state).toBe("valid");
    expect(status.latestFailed).toBe(false);
  });

  it("flags when the latest certificate result was not fit", () => {
    const status = currentCalibrationStatus(
      [{ calibration_date: "2026-06-01", next_due_date: "2027-06-01", result: "fail" }],
      TODAY,
    );
    expect(status.state).toBe("valid"); // next-due still in the future
    expect(status.latestFailed).toBe(true); // but the instrument was found unfit
  });
});

describe("recordCalibrationSchema", () => {
  const base = {
    asset_id: "11111111-1111-1111-1111-111111111111",
    certificate_number: "CAL-2026-001",
    calibrated_by: "Acme Metrology Ltd",
    calibration_date: "2026-06-01",
    result: "pass",
  };

  it("accepts a minimal certificate (no next-due, no schedule)", () => {
    const parsed = recordCalibrationSchema.safeParse(base);
    expect(parsed.success).toBe(true);
  });

  it("accepts a linked, dated certificate", () => {
    const parsed = recordCalibrationSchema.safeParse({
      ...base,
      schedule_id: "22222222-2222-2222-2222-222222222222",
      next_due_date: "2027-06-01",
      standard: "UKAS 0123",
      notes: "Within tolerance.",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a next-due before the calibration date", () => {
    const parsed = recordCalibrationSchema.safeParse({ ...base, next_due_date: "2026-05-01" });
    expect(parsed.success).toBe(false);
  });

  it("requires certificate number and calibrated-by", () => {
    expect(recordCalibrationSchema.safeParse({ ...base, certificate_number: "" }).success).toBe(false);
    expect(recordCalibrationSchema.safeParse({ ...base, calibrated_by: "  " }).success).toBe(false);
  });
});

describe("friendlyCalibrationError", () => {
  it("maps a duplicate certificate number", () => {
    expect(friendlyCalibrationError("23505", "duplicate key value")).toMatch(/already exists/i);
  });
  it("maps the wrong-schedule-type guard", () => {
    expect(friendlyCalibrationError("check_violation", "schedule x is not a calibration schedule")).toMatch(/calibration schedule/i);
  });
  it("maps the due-after-cal check", () => {
    expect(friendlyCalibrationError("23514", "asset_calibration_certs_due_after_cal_check")).toMatch(/before the calibration/i);
  });
  it("has a generic fallback", () => {
    expect(friendlyCalibrationError(undefined, undefined)).toMatch(/couldn't save/i);
  });
});

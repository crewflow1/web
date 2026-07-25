import { describe, it, expect } from "vitest";
import {
  ackStatement, hasAcknowledged, acknowledgementProgress, validateSignature,
  ACK_SUBJECT_TYPES, ACK_STATEMENT_VERSION,
} from "@/lib/health-safety/acknowledgements";

describe("ackStatement — version-anchored wording", () => {
  it("names the subject + its reference", () => {
    expect(ackStatement("risk_assessment", "RA-0001")).toMatch(/risk assessment RA-0001/);
    expect(ackStatement("permit_to_work", "PTW-0002")).toMatch(/permit to work PTW-0002/);
  });
  it("has a stable statement version", () => {
    expect(ACK_STATEMENT_VERSION).toBe("v1");
    expect(ACK_SUBJECT_TYPES).toEqual(["risk_assessment", "permit_to_work"]);
  });
});

describe("hasAcknowledged — bound to operative + issued version", () => {
  const acks = [{ user_id: "u1", subject_version: "RA-0001" }, { user_id: "u2", subject_version: "RA-0001" }];
  it("true only for the matching user + version", () => {
    expect(hasAcknowledged(acks, "u1", "RA-0001")).toBe(true);
    expect(hasAcknowledged(acks, "u3", "RA-0001")).toBe(false);
    // a different (superseded) version is NOT carried forward
    expect(hasAcknowledged(acks, "u1", "RA-0002")).toBe(false);
  });
});

describe("acknowledgementProgress — distinct signers", () => {
  it("counts distinct users vs expected", () => {
    expect(acknowledgementProgress([{ user_id: "u1" }, { user_id: "u1" }, { user_id: "u2" }], 3))
      .toEqual({ signed: 2, expected: 3, complete: false });
    expect(acknowledgementProgress([{ user_id: "u1" }, { user_id: "u2" }], 2).complete).toBe(true);
    expect(acknowledgementProgress([], 0).complete).toBe(false);
  });
});

describe("validateSignature", () => {
  it("requires a typed name", () => {
    expect(validateSignature(" ")).toContain("Type your full name to sign.");
    expect(validateSignature("Jo")).toEqual([]);
    expect(validateSignature("x".repeat(200))).toContain("Name is too long.");
  });
});

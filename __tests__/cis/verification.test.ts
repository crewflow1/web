import { describe, it, expect } from "vitest";

import {
  CIS_OUTCOME_STATUSES,
  CIS_STATUSES,
  isOutcomeStatus,
  type CisStatus,
} from "@/lib/cis/types";
import {
  allowedTransitions,
  canonicaliseCompanyNumber,
  canonicaliseUtr,
  canonicaliseVatNumber,
  canonicaliseVerificationReference,
  canRecordVerificationOutcome,
  canTransition,
  deriveVerificationExpiry,
  isRateConsistent,
  isVerificationStale,
  maskUtr,
  rateForStatus,
  REVERIFICATION_WARNING_DAYS,
  taxYearStart,
  transitionRefusal,
  verificationFreshness,
} from "@/lib/cis/verification";

// ---------------------------------------------------------------------------
// Status → rate authority
// ---------------------------------------------------------------------------

describe("rateForStatus — real HMRC CIS rates", () => {
  it("gross payment status deducts nothing", () => {
    expect(rateForStatus("gross")).toBe(0);
  });

  it("a registered subcontractor deducts 20%", () => {
    expect(rateForStatus("standard_20")).toBe(20);
  });

  it("an unregistered subcontractor deducts 30%", () => {
    expect(rateForStatus("higher_30")).toBe(30);
  });

  it("an HMRC no-match deducts at the HIGHER rate, not the standard one", () => {
    // The compliance-relevant case: failing to match must never fall back to 20%.
    expect(rateForStatus("failed")).toBe(30);
  });

  it("returns null before any verification outcome exists", () => {
    // Null, NOT a default of 20 or 30 — there is no lawful rate until HMRC says.
    expect(rateForStatus("unverified")).toBeNull();
    expect(rateForStatus("verification_required")).toBeNull();
  });

  it("covers every declared status (no status can silently fall through)", () => {
    for (const status of CIS_STATUSES) {
      const rate = rateForStatus(status);
      if (isOutcomeStatus(status)) {
        expect(rate, `${status} must carry a rate`).not.toBeNull();
        expect([0, 20, 30]).toContain(rate);
      } else {
        expect(rate, `${status} must not carry a rate`).toBeNull();
      }
    }
  });
});

describe("isRateConsistent — a rate can never contradict its status", () => {
  it("accepts each correct pairing", () => {
    expect(isRateConsistent("gross", 0)).toBe(true);
    expect(isRateConsistent("standard_20", 20)).toBe(true);
    expect(isRateConsistent("higher_30", 30)).toBe(true);
    expect(isRateConsistent("failed", 30)).toBe(true);
    expect(isRateConsistent("unverified", null)).toBe(true);
    expect(isRateConsistent("verification_required", null)).toBe(true);
  });

  it("rejects a FORGED rate that contradicts the status", () => {
    expect(isRateConsistent("higher_30", 20)).toBe(false);
    expect(isRateConsistent("higher_30", 5)).toBe(false);
    expect(isRateConsistent("standard_20", 0)).toBe(false);
    expect(isRateConsistent("gross", 20)).toBe(false);
    expect(isRateConsistent("failed", 20)).toBe(false);
  });

  it("rejects a determinate status carrying NO rate", () => {
    // Mirrors the DB CHECK's `is not distinct from`: null must not slip through.
    expect(isRateConsistent("gross", null)).toBe(false);
    expect(isRateConsistent("standard_20", undefined)).toBe(false);
    expect(isRateConsistent("higher_30", null)).toBe(false);
  });

  it("rejects a pre-outcome status carrying a rate", () => {
    expect(isRateConsistent("unverified", 20)).toBe(false);
    expect(isRateConsistent("unverified", 0)).toBe(false);
    expect(isRateConsistent("verification_required", 30)).toBe(false);
  });

  it("agrees with rateForStatus across every status", () => {
    for (const status of CIS_STATUSES) {
      expect(isRateConsistent(status, rateForStatus(status))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Transition guard
// ---------------------------------------------------------------------------

describe("canTransition", () => {
  it("NOTHING may go back to 'unverified' once a verification was attempted", () => {
    for (const from of CIS_STATUSES) {
      expect(canTransition(from, "unverified"), `${from} → unverified`).toBe(false);
    }
  });

  it("refuses a self-transition (a no-op must not restamp a verification)", () => {
    for (const status of CIS_STATUSES) {
      expect(canTransition(status, status), `${status} → ${status}`).toBe(false);
    }
  });

  it("lets an unverified profile receive any verification outcome", () => {
    for (const outcome of CIS_OUTCOME_STATUSES) {
      expect(canTransition("unverified", outcome)).toBe(true);
    }
  });

  it("lets any outcome be re-verified into any other outcome", () => {
    for (const from of CIS_OUTCOME_STATUSES) {
      for (const to of CIS_OUTCOME_STATUSES) {
        if (from === to) continue;
        expect(canTransition(from, to), `${from} → ${to}`).toBe(true);
      }
    }
  });

  it("lets an outcome be flagged for re-verification, and re-verified from there", () => {
    expect(canTransition("standard_20", "verification_required")).toBe(true);
    expect(canTransition("gross", "verification_required")).toBe(true);
    expect(canTransition("verification_required", "higher_30")).toBe(true);
  });

  it("does not offer 'verification_required' as a target of itself", () => {
    expect(canTransition("verification_required", "verification_required")).toBe(false);
  });

  it("allowedTransitions agrees with canTransition for every pair", () => {
    for (const from of CIS_STATUSES) {
      const allowed = allowedTransitions(from);
      for (const to of CIS_STATUSES) {
        expect(allowed.includes(to)).toBe(canTransition(from, to));
      }
    }
  });
});

describe("canRecordVerificationOutcome — recording evidence, not changing status", () => {
  it("allows re-recording the SAME outcome (the commonest CIS action)", () => {
    // "Re-verified, still 20%" carries a new date + reference. canTransition
    // refuses this as a self-transition, which is why verification does not use it.
    for (const outcome of CIS_OUTCOME_STATUSES) {
      expect(canRecordVerificationOutcome(outcome, outcome), `${outcome} again`).toBe(true);
      expect(canTransition(outcome, outcome), "canTransition still refuses it").toBe(false);
    }
  });

  it("allows any HMRC outcome from any starting point", () => {
    for (const from of CIS_STATUSES) {
      for (const outcome of CIS_OUTCOME_STATUSES) {
        expect(canRecordVerificationOutcome(from, outcome), `${from} → ${outcome}`).toBe(true);
      }
    }
  });

  it("refuses a pre-outcome status — a verification can never yield one", () => {
    for (const from of CIS_STATUSES) {
      expect(canRecordVerificationOutcome(from, "unverified")).toBe(false);
      expect(canRecordVerificationOutcome(from, "verification_required")).toBe(false);
    }
  });
});

describe("transitionRefusal", () => {
  it("is null when the move is allowed", () => {
    expect(transitionRefusal("unverified", "standard_20")).toBeNull();
  });

  it("explains the going-back-to-unverified refusal specifically", () => {
    expect(transitionRefusal("higher_30", "unverified")).toMatch(/re-verification/i);
  });

  it("explains a self-transition as already-current", () => {
    expect(transitionRefusal("gross", "gross")).toMatch(/already/i);
  });
});

// ---------------------------------------------------------------------------
// UK tax year + expiry derivation
// ---------------------------------------------------------------------------

describe("taxYearStart — UK tax year runs 6 April to 5 April", () => {
  it("5 April is still the PREVIOUS tax year", () => {
    expect(taxYearStart("2026-04-05")).toBe(2025);
  });

  it("6 April starts the new tax year", () => {
    expect(taxYearStart("2026-04-06")).toBe(2026);
  });

  it("handles either side of the boundary", () => {
    expect(taxYearStart("2026-01-31")).toBe(2025);
    expect(taxYearStart("2026-12-31")).toBe(2026);
    expect(taxYearStart("2026-03-31")).toBe(2025);
    expect(taxYearStart("2026-04-30")).toBe(2026);
  });

  it("returns null for a malformed date", () => {
    expect(taxYearStart("not-a-date")).toBeNull();
    expect(taxYearStart("2026-02-31")).toBeNull();
    expect(taxYearStart("2026-13-01")).toBeNull();
  });
});

describe("deriveVerificationExpiry — current tax year plus the two following", () => {
  it("verified mid-year 2026/27 is good through 5 April 2029", () => {
    expect(deriveVerificationExpiry("2026-07-01")).toBe("2029-04-05");
  });

  it("verified on 5 April falls in the earlier tax year, so expires a year sooner", () => {
    expect(deriveVerificationExpiry("2026-04-05")).toBe("2028-04-05");
  });

  it("verified on 6 April starts the new tax year's window", () => {
    expect(deriveVerificationExpiry("2026-04-06")).toBe("2029-04-05");
  });

  it("returns null when there is no verification date", () => {
    expect(deriveVerificationExpiry(null)).toBeNull();
    expect(deriveVerificationExpiry(undefined)).toBeNull();
    expect(deriveVerificationExpiry("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Freshness / staleness boundaries
// ---------------------------------------------------------------------------

const verified = (over: Partial<{ cis_status: CisStatus; verified_at: string | null; verification_expires_at: string | null }> = {}) => ({
  cis_status: "standard_20" as CisStatus,
  verified_at: "2026-01-01",
  verification_expires_at: "2026-12-31",
  ...over,
});

describe("verificationFreshness", () => {
  it("is 'current' well inside the window", () => {
    expect(verificationFreshness(verified(), "2026-06-01")).toBe("current");
  });

  it("is still valid ON the expiry date (inclusive boundary)", () => {
    expect(verificationFreshness(verified(), "2026-12-31")).toBe("expiring_soon");
    expect(verificationFreshness(verified(), "2026-12-31")).not.toBe("expired");
  });

  it("is 'expired' the day AFTER the expiry date", () => {
    expect(verificationFreshness(verified(), "2027-01-01")).toBe("expired");
  });

  it("warns exactly at the warning-window boundary and not a day earlier", () => {
    // Expiry 2026-12-31; the window is REVERIFICATION_WARNING_DAYS days wide.
    expect(REVERIFICATION_WARNING_DAYS).toBe(60);
    // 60 days before 2026-12-31 is 2026-11-01 → inside the window.
    expect(verificationFreshness(verified(), "2026-11-01")).toBe("expiring_soon");
    // 61 days before is 2026-10-31 → still just 'current'.
    expect(verificationFreshness(verified(), "2026-10-31")).toBe("current");
  });

  it("is 'none' for a pre-outcome status even with dates present", () => {
    expect(
      verificationFreshness(verified({ cis_status: "unverified", verified_at: null }), "2026-06-01"),
    ).toBe("none");
    expect(
      verificationFreshness(verified({ cis_status: "verification_required" }), "2026-06-01"),
    ).toBe("none");
  });

  it("is 'none' for an outcome with no verification date", () => {
    expect(verificationFreshness(verified({ verified_at: null }), "2026-06-01")).toBe("none");
  });

  it("falls back to the DERIVED expiry when none is stored", () => {
    // Verified 2026-07-01 derives 2029-04-05.
    const snap = verified({ verified_at: "2026-07-01", verification_expires_at: null });
    expect(verificationFreshness(snap, "2028-01-01")).toBe("current");
    expect(verificationFreshness(snap, "2029-04-05")).toBe("expiring_soon");
    expect(verificationFreshness(snap, "2029-04-06")).toBe("expired");
  });

  it("treats a 'failed' outcome as a real, datable verification", () => {
    expect(verificationFreshness(verified({ cis_status: "failed" }), "2026-06-01")).toBe("current");
  });

  it("is 'none' rather than 'current' when asOf is unparseable (fails closed)", () => {
    expect(verificationFreshness(verified(), "rubbish")).toBe("none");
  });
});

describe("isVerificationStale — fail closed", () => {
  it("is false only while a verification is positively current", () => {
    expect(isVerificationStale(verified(), "2026-06-01")).toBe(false);
    expect(isVerificationStale(verified(), "2026-11-15")).toBe(false); // expiring_soon is not stale
  });

  it("is true once expired", () => {
    expect(isVerificationStale(verified(), "2027-01-01")).toBe(true);
  });

  it("is true for anything never verified", () => {
    expect(
      isVerificationStale(verified({ cis_status: "unverified", verified_at: null }), "2026-06-01"),
    ).toBe(true);
    expect(
      isVerificationStale(verified({ cis_status: "verification_required" }), "2026-06-01"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

describe("canonicaliseUtr", () => {
  it("accepts exactly 10 digits", () => {
    expect(canonicaliseUtr("1234567890")).toBe("1234567890");
  });

  it("strips whitespace as HMRC prints it", () => {
    expect(canonicaliseUtr("12345 67890")).toBe("1234567890");
    expect(canonicaliseUtr(" 1234567890 ")).toBe("1234567890");
  });

  it("strips a trailing K, which appears on some HMRC correspondence", () => {
    expect(canonicaliseUtr("1234567890K")).toBe("1234567890");
    expect(canonicaliseUtr("1234567890k")).toBe("1234567890");
  });

  it("rejects the wrong number of digits", () => {
    expect(canonicaliseUtr("123456789")).toBeNull();
    expect(canonicaliseUtr("12345678901")).toBeNull();
  });

  it("rejects anything non-numeric", () => {
    expect(canonicaliseUtr("12345678AB")).toBeNull();
    expect(canonicaliseUtr("AB12345678")).toBeNull();
    expect(canonicaliseUtr("not a utr")).toBeNull();
  });

  it("rejects empty input", () => {
    expect(canonicaliseUtr(null)).toBeNull();
    expect(canonicaliseUtr(undefined)).toBeNull();
    expect(canonicaliseUtr("")).toBeNull();
  });
});

describe("maskUtr — mirrors maskNiNumber", () => {
  it("masks the middle, keeping 2 leading and 3 trailing characters", () => {
    expect(maskUtr("1234567890")).toBe("12*****890");
  });

  it("never leaks more than 5 of the 10 digits", () => {
    const masked = maskUtr("1234567890");
    const visible = masked.replace(/\*/g, "");
    expect(visible).toHaveLength(5);
    expect(masked).toHaveLength(10);
  });

  it("does not contain the full UTR anywhere in its output", () => {
    expect(maskUtr("1234567890")).not.toContain("1234567890");
    expect(maskUtr("1234567890")).not.toContain("34567");
  });

  it("returns an em dash when there is nothing stored", () => {
    expect(maskUtr(null)).toBe("—");
    expect(maskUtr(undefined)).toBe("—");
    expect(maskUtr("")).toBe("—");
  });

  it("returns *** for a suspiciously short value rather than leaking it", () => {
    expect(maskUtr("123")).toBe("***");
    expect(maskUtr("123456")).toBe("***");
  });
});

describe("canonicaliseVerificationReference", () => {
  it("accepts V + 10 digits", () => {
    expect(canonicaliseVerificationReference("V1234567890")).toBe("V1234567890");
  });

  it("accepts the unmatched-subcontractor suffix letter", () => {
    expect(canonicaliseVerificationReference("V1234567890A")).toBe("V1234567890A");
  });

  it("upper-cases and strips separators", () => {
    expect(canonicaliseVerificationReference("v1234567890")).toBe("V1234567890");
    expect(canonicaliseVerificationReference("V 1234567890")).toBe("V1234567890");
    expect(canonicaliseVerificationReference("V-1234567890")).toBe("V1234567890");
  });

  it("rejects a malformed reference", () => {
    expect(canonicaliseVerificationReference("1234567890")).toBeNull();
    expect(canonicaliseVerificationReference("V123")).toBeNull();
    expect(canonicaliseVerificationReference("V12345678901")).toBeNull();
    expect(canonicaliseVerificationReference(null)).toBeNull();
  });
});

describe("canonicaliseCompanyNumber", () => {
  it("accepts 8 digits", () => {
    expect(canonicaliseCompanyNumber("12345678")).toBe("12345678");
  });

  it("accepts the 2-letter prefixed forms (SC/NI/OC…)", () => {
    expect(canonicaliseCompanyNumber("SC123456")).toBe("SC123456");
    expect(canonicaliseCompanyNumber("ni123456")).toBe("NI123456");
  });

  it("rejects the wrong shape", () => {
    expect(canonicaliseCompanyNumber("1234567")).toBeNull();
    expect(canonicaliseCompanyNumber("S1234567")).toBeNull();
    expect(canonicaliseCompanyNumber(null)).toBeNull();
  });
});

describe("canonicaliseVatNumber", () => {
  it("accepts 9 and 12 digit forms, with or without GB", () => {
    expect(canonicaliseVatNumber("123456789")).toBe("123456789");
    expect(canonicaliseVatNumber("GB123456789")).toBe("GB123456789");
    expect(canonicaliseVatNumber("gb 123 4567 89")).toBe("GB123456789");
    expect(canonicaliseVatNumber("123456789012")).toBe("123456789012");
  });

  it("rejects the wrong length", () => {
    expect(canonicaliseVatNumber("12345678")).toBeNull();
    expect(canonicaliseVatNumber("GB1234567890")).toBeNull();
    expect(canonicaliseVatNumber(null)).toBeNull();
  });
});

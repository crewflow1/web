import { describe, it, expect } from "vitest";
import { SCOPES } from "@/lib/api-auth/scopes";
import {
  LISTING_CATEGORIES,
  LISTING_STATUSES,
  INSTALL_STATUSES,
  ENTITLEMENT_STATUSES,
  REVIEW_DECISIONS,
  isListingInstallable,
  isListingDiscoverable,
  canSubmitForReview,
  isValidSlug,
  validateRequestedScopes,
  normaliseScopes,
  sameScopeSet,
  validateInstallConsent,
} from "@/lib/marketplace/registry";

/**
 * Marketplace consent + lifecycle — pure unit contracts (no DB). These pin the
 * install-consent gate (exact scopes), the approval gate (only approved is
 * installable/discoverable), and the vocabularies the migration mirrors.
 */

describe("marketplace registry vocabularies", () => {
  it("categories, listing/install/entitlement statuses are stable + unique", () => {
    for (const arr of [
      LISTING_CATEGORIES,
      LISTING_STATUSES,
      INSTALL_STATUSES,
      ENTITLEMENT_STATUSES,
      REVIEW_DECISIONS,
    ]) {
      expect(new Set(arr).size).toBe(arr.length);
    }
    expect(LISTING_STATUSES).toContain("approved");
    expect(REVIEW_DECISIONS).toEqual(["approved", "rejected", "suspended"]);
  });
});

describe("listing approval gate", () => {
  it("ONLY an approved listing is installable + discoverable", () => {
    for (const s of LISTING_STATUSES) {
      const expected = s === "approved";
      expect(isListingInstallable(s)).toBe(expected);
      expect(isListingDiscoverable(s)).toBe(expected);
    }
    // Unknown/garbage status is never installable.
    expect(isListingInstallable("APPROVED")).toBe(false);
    expect(isListingInstallable("")).toBe(false);
  });

  it("only a draft may be submitted for review", () => {
    expect(canSubmitForReview("draft")).toBe(true);
    for (const s of ["pending_review", "approved", "rejected", "suspended"]) {
      expect(canSubmitForReview(s)).toBe(false);
    }
  });
});

describe("slug validation", () => {
  it("accepts lowercase-hyphen slugs of 3..63 chars", () => {
    expect(isValidSlug("acme-sync")).toBe(true);
    expect(isValidSlug("abc")).toBe(true);
    expect(isValidSlug("a1-b2-c3")).toBe(true);
  });
  it("rejects bad slugs", () => {
    for (const s of ["ab", "Acme", "acme_sync", "-acme", "acme-", "acme--x", "a".repeat(64), "acme sync"]) {
      expect(isValidSlug(s)).toBe(false);
    }
  });
});

describe("requested-scope validation reuses the public-API vocabulary", () => {
  it("accepts a non-empty subset of SCOPES, registry-ordered + deduped", () => {
    const r = validateRequestedScopes(["read:invoices", "read:jobs", "read:jobs"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Registry order (read:jobs precedes read:invoices in SCOPES), deduped.
      expect(r.scopes).toEqual(["read:jobs", "read:invoices"]);
    }
  });
  it("rejects unknown scope strings (no marketplace-invented scopes)", () => {
    const r = validateRequestedScopes(["read:jobs", "read:everything"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.invalid).toContain("read:everything");
  });
  it("rejects the empty set", () => {
    const r = validateRequestedScopes([]);
    expect(r.ok).toBe(false);
  });
  it("every SCOPES entry is a valid requested scope", () => {
    const r = validateRequestedScopes([...SCOPES]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scopes).toEqual([...SCOPES]);
  });
});

describe("sameScopeSet — order/dup-insensitive set equality", () => {
  it("equal sets regardless of order or duplicates", () => {
    expect(sameScopeSet(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameScopeSet(["a", "a", "b"], ["b", "a"])).toBe(true);
  });
  it("unequal on any difference", () => {
    expect(sameScopeSet(["a", "b"], ["a"])).toBe(false);
    expect(sameScopeSet(["a"], ["a", "b"])).toBe(false);
    expect(sameScopeSet(["a", "c"], ["a", "b"])).toBe(false);
  });
});

describe("validateInstallConsent — the install-consent gate", () => {
  const requested = ["read:jobs", "read:invoices"];

  it("ACCEPTS consent to EXACTLY the requested scopes (any order)", () => {
    const r = validateInstallConsent("approved", requested, ["read:invoices", "read:jobs"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scopes).toEqual(["read:jobs", "read:invoices"]); // normalised
  });

  it("REJECTS a subset (under-consent)", () => {
    const r = validateInstallConsent("approved", requested, ["read:jobs"]);
    expect(r).toEqual({ ok: false, reason: "scope_mismatch" });
  });

  it("REJECTS a superset (escalation beyond what was requested)", () => {
    const r = validateInstallConsent("approved", requested, ["read:jobs", "read:invoices", "write:jobs"]);
    expect(r).toEqual({ ok: false, reason: "scope_mismatch" });
  });

  it("REJECTS installing a listing that is not approved (the review gate)", () => {
    for (const s of ["draft", "pending_review", "rejected", "suspended"]) {
      const r = validateInstallConsent(s, requested, requested);
      expect(r).toEqual({ ok: false, reason: "not_installable" });
    }
  });

  it("REJECTS when the listing's requested scopes are invalid", () => {
    const r = validateInstallConsent("approved", ["read:nonsense"], ["read:nonsense"]);
    expect(r).toEqual({ ok: false, reason: "invalid_scopes" });
  });
});

describe("normaliseScopes", () => {
  it("dedupes + registry-orders + drops non-scopes", () => {
    expect(normaliseScopes(["read:invoices", "nope", "read:jobs", "read:jobs"])).toEqual([
      "read:jobs",
      "read:invoices",
    ]);
  });
});

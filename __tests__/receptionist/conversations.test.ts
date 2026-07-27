import { describe, it, expect } from "vitest";
import {
  normaliseContactRef,
  hasResolvableContact,
} from "@/server/services/receptionist-conversations";

/**
 * Conversation & contact-identity substrate — contact normalisation, unit tier
 * (the AI Receptionist Programme, R10 — CONVERSATION & CONTACT-IDENTITY SUBSTRATE).
 *
 * `normaliseContactRef` is the substrate's ONE identity-shaping rule, and it is a
 * COPY of a rule that also lives in Postgres: the resolver folds a contact with
 * `lower(btrim(coalesce(p_contact_ref,'')))`, and this function must fold it the SAME
 * way — `(raw ?? "").trim().toLowerCase()` — so the resolved identity can never drift
 * between the TypeScript short-circuit (no contact ⇒ no RPC) and the database key
 * `unique (org_id, channel, contact_ref)`. If these two rules ever disagree, the SAME
 * person could open TWO conversations, or a genuinely empty identifier could reach the
 * RPC. These tests pin the fold and the derived `hasResolvableContact` guard as pure
 * logic; the database's identical fold and the race-safe resolution are proven against
 * real Postgres in __tests__/integration/receptionist/conversation-substrate.test.ts.
 */

describe("normaliseContactRef — trim + casefold, mirroring the DB resolver", () => {
  it("lowercases (casefold) so casing never splits one contact into two", () => {
    expect(normaliseContactRef("Customer@Example.COM")).toBe("customer@example.com");
    expect(normaliseContactRef("+44 7700 900000")).toBe("+44 7700 900000");
    expect(normaliseContactRef("@A.Customer")).toBe("@a.customer");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normaliseContactRef("  +447700900000  ")).toBe("+447700900000");
    expect(normaliseContactRef("\t user@site.io \n")).toBe("user@site.io");
  });

  it("folds incidental whitespace AND casing together (the same person → one key)", () => {
    // The exact drift the substrate must prevent: the same identifier delivered with
    // different casing/whitespace by two webhooks must normalise identically.
    expect(normaliseContactRef("  JoHn@Example.com ")).toBe(
      normaliseContactRef("john@example.com"),
    );
  });

  it("returns \"\" for a null, undefined, empty, or whitespace-only identifier", () => {
    // The empty result is the short-circuit signal: no usable contact ⇒ no conversation.
    expect(normaliseContactRef(null)).toBe("");
    expect(normaliseContactRef(undefined)).toBe("");
    expect(normaliseContactRef("")).toBe("");
    expect(normaliseContactRef("   ")).toBe("");
    expect(normaliseContactRef("\t\n ")).toBe("");
  });

  it("is idempotent — normalising an already-normalised value is a no-op", () => {
    const once = normaliseContactRef("  Owner@Firm.CO.UK ");
    expect(normaliseContactRef(once)).toBe(once);
  });

  it("preserves the interior of an identifier — it folds, it does not sanitise", () => {
    // Normalisation is trim + casefold ONLY. It must not strip interior spaces, plus
    // signs, or punctuation — those are part of the identity a channel delivered.
    expect(normaliseContactRef("whatsapp:+44 7700 900123")).toBe(
      "whatsapp:+44 7700 900123",
    );
  });
});

describe("hasResolvableContact — true exactly when a contact survives normalisation", () => {
  it("is true for any identifier that normalises to a non-empty string", () => {
    expect(hasResolvableContact("+447700900000")).toBe(true);
    expect(hasResolvableContact("  A@b.com ")).toBe(true);
    expect(hasResolvableContact("@handle")).toBe(true);
  });

  it("is false for a null, undefined, empty, or whitespace-only identifier", () => {
    expect(hasResolvableContact(null)).toBe(false);
    expect(hasResolvableContact(undefined)).toBe(false);
    expect(hasResolvableContact("")).toBe(false);
    expect(hasResolvableContact("   ")).toBe(false);
  });

  it("agrees with normaliseContactRef on every input (one derived guard, one rule)", () => {
    for (const raw of [
      null,
      undefined,
      "",
      "   ",
      "\t",
      "+447700900000",
      "  Mixed@Case.COM ",
      "@x",
    ]) {
      expect(hasResolvableContact(raw)).toBe(normaliseContactRef(raw) !== "");
    }
  });
});

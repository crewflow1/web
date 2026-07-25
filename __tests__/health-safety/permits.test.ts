import { describe, it, expect } from "vitest";
import {
  canTransition, isEditable, isTerminal, isExpired, isNotYetValid, effectiveStatus,
  canIssue, validatePermit, PERMIT_TYPES, PERMIT_STATUSES,
} from "@/lib/health-safety/permits";

const NOW = new Date("2026-06-15T12:00:00Z");

describe("permit lifecycle", () => {
  it("editable only while draft; terminal for closed/cancelled", () => {
    expect(isEditable("draft")).toBe(true);
    for (const s of ["issued", "active", "suspended", "closed", "cancelled"] as const) expect(isEditable(s)).toBe(false);
    expect(isTerminal("closed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("active")).toBe(false);
  });
  it("enforces the transition matrix (mirrors the DB trigger)", () => {
    expect(canTransition("draft", "issued")).toBe(true);
    expect(canTransition("draft", "cancelled")).toBe(true);
    expect(canTransition("issued", "active")).toBe(true);
    expect(canTransition("active", "suspended")).toBe(true);
    expect(canTransition("suspended", "active")).toBe(true);
    expect(canTransition("active", "closed")).toBe(true);
    // disallowed
    expect(canTransition("draft", "active")).toBe(false);
    expect(canTransition("closed", "active")).toBe(false);
    expect(canTransition("cancelled", "active")).toBe(false);
    expect(canTransition("issued", "draft")).toBe(false);
    expect(canTransition("suspended", "issued")).toBe(false);
  });
  it("covers every type + status", () => {
    expect(PERMIT_TYPES).toContain("confined_space");
    expect(PERMIT_STATUSES).toEqual(["draft", "issued", "active", "suspended", "closed", "cancelled"]);
  });
});

describe("derived expiry (never stored, no cron)", () => {
  it("a live permit past its window is expired", () => {
    expect(isExpired("2026-06-15T11:00:00Z", "active", NOW)).toBe(true);
    expect(isExpired("2026-06-15T13:00:00Z", "active", NOW)).toBe(false);
  });
  it("a non-live or unbounded permit is never expired", () => {
    expect(isExpired("2026-06-15T11:00:00Z", "draft", NOW)).toBe(false);
    expect(isExpired("2026-06-15T11:00:00Z", "closed", NOW)).toBe(false);
    expect(isExpired(null, "active", NOW)).toBe(false);
  });
  it("not-yet-valid is detected", () => {
    expect(isNotYetValid("2026-06-15T13:00:00Z", NOW)).toBe(true);
    expect(isNotYetValid("2026-06-15T11:00:00Z", NOW)).toBe(false);
  });
  it("effectiveStatus shows expired for a lapsed live permit, else the stored status", () => {
    expect(effectiveStatus("active", "2026-06-15T11:00:00Z", NOW)).toBe("expired");
    expect(effectiveStatus("active", "2026-06-15T13:00:00Z", NOW)).toBe("active");
    expect(effectiveStatus("closed", "2026-06-15T11:00:00Z", NOW)).toBe("closed");
  });

  it("effectiveStatus shows not_yet_valid for a live permit whose window has not opened", () => {
    // valid_from in the FUTURE (> NOW) + a live status ⇒ must NOT read "active".
    expect(effectiveStatus("active", "2026-06-15T20:00:00Z", NOW, "2026-06-15T14:00:00Z")).toBe("not_yet_valid");
    expect(effectiveStatus("issued", "2026-06-16T00:00:00Z", NOW, "2026-06-15T18:00:00Z")).toBe("not_yet_valid");
    // window already open (valid_from in the past) ⇒ the stored status again
    expect(effectiveStatus("active", "2026-06-15T20:00:00Z", NOW, "2026-06-15T11:00:00Z")).toBe("active");
    // only live permits gate on the window — a draft is never not-yet-valid
    expect(effectiveStatus("draft", "2026-06-15T20:00:00Z", NOW, "2026-06-15T14:00:00Z")).toBe("draft");
    // omitting validFrom preserves the prior expiry-only behaviour (backward-compatible)
    expect(effectiveStatus("active", "2026-06-15T20:00:00Z", NOW)).toBe("active");
  });
});

describe("canIssue — the DB-enforced issue gate, mirrored", () => {
  const base = { status: "draft" as const, permit_type: "hot_works", title: "Welding", scope: "Weld beam", valid_from: "2026-06-15T08:00:00Z", valid_until: "2026-06-15T16:00:00Z" };
  it("issues a complete draft with all required conditions confirmed", () => {
    expect(canIssue(base, [{ required: true, confirmed: true }, { required: false, confirmed: false }])).toEqual({ ok: true, reasons: [] });
  });
  it("blocks on an unconfirmed required condition", () => {
    expect(canIssue(base, [{ required: true, confirmed: false }]).reasons).toContain("1 required condition not yet confirmed.");
  });
  it("blocks incomplete headers + non-draft + bad window", () => {
    expect(canIssue({ ...base, status: "issued" }, []).reasons).toContain("Only a draft permit can be issued.");
    expect(canIssue({ ...base, valid_until: null }, []).reasons.some((r) => r.includes("validity window"))).toBe(true);
    expect(canIssue({ ...base, valid_until: "2026-06-15T07:00:00Z" }, []).reasons.some((r) => r.includes("expire after"))).toBe(true);
    expect(canIssue({ ...base, scope: " " }, []).ok).toBe(false);
  });
});

describe("validatePermit", () => {
  it("requires a valid type + title + scope, ordered window", () => {
    expect(validatePermit({ permitType: "nope", title: "", scope: "" })).toEqual(
      expect.arrayContaining(["A valid permit type is required.", "Title is required.", "Scope of work is required."]),
    );
    expect(validatePermit({ permitType: "hot_works", title: "t", scope: "s", validFrom: "2026-06-15T10:00:00Z", validUntil: "2026-06-15T09:00:00Z" }))
      .toContain("Valid-until must be after valid-from.");
    expect(validatePermit({ permitType: "hot_works", title: "t", scope: "s" })).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { parsePublicLead } from "@/lib/public-lead/schema";

/** Public lead-capture schema — the unauthenticated input contract. */

const valid = {
  orgSlug: "acme-builders",
  name: "Alex Smith",
  email: "alex@example.com",
  phone: "",
  service: "Roof repair",
  postcode: "SW1A 1AA",
  message: "Need a new flat roof on a garage.",
  consent: true,
  website: "",
};

describe("parsePublicLead", () => {
  it("accepts a valid enquiry (not spam)", () => {
    const r = parsePublicLead(valid);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spam).toBe(false);
  });

  it("flags honeypot-filled submissions as spam (still ok:true so the bot learns nothing)", () => {
    const r = parsePublicLead({ ...valid, website: "http://spam.example" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spam).toBe(true);
  });

  it("rejects when consent is not explicitly true", () => {
    const r = parsePublicLead({ ...valid, consent: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fieldErrors.consent).toBeTruthy();
  });

  it("rejects when neither email nor phone is given", () => {
    const r = parsePublicLead({ ...valid, email: "", phone: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fieldErrors.email).toBeTruthy();
  });

  it("accepts phone-only (no email)", () => {
    const r = parsePublicLead({ ...valid, email: "", phone: "07700 900000" });
    expect(r.ok).toBe(true);
  });

  it("requires a name and a message", () => {
    const r1 = parsePublicLead({ ...valid, name: "" });
    const r2 = parsePublicLead({ ...valid, message: "" });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    if (!r1.ok) expect(r1.fieldErrors.name).toBeTruthy();
    if (!r2.ok) expect(r2.fieldErrors.message).toBeTruthy();
  });

  it("rejects an invalid email", () => {
    const r = parsePublicLead({ ...valid, email: "not-an-email" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fieldErrors.email).toBeTruthy();
  });

  it("rejects unknown keys (no mass-assignment of org_id/status/source)", () => {
    const r = parsePublicLead({ ...valid, org_id: "00000000-0000-0000-0000-000000000000", status: "won" });
    expect(r.ok).toBe(false);
  });
});

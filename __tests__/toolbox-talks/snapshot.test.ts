import { describe, it, expect } from "vitest";
import {
  buildToolboxTalkSnapshot,
  TOOLBOX_TALK_SNAPSHOT_KEYS,
} from "@/lib/toolbox-talks/snapshot";

describe("buildToolboxTalkSnapshot — worker-safe evidence by construction", () => {
  const snap = buildToolboxTalkSnapshot({
    talkReference: "TBT-0007-R02",
    revision: 2,
    talkDate: "2026-07-18",
    location: "Plot 4, mansard roof",
    siteLabel: "1 High St, Belfast",
    deliveredBy: "A. Foreman",
    topic: "Working at height",
    keyPoints: "Edge protection checked; harness on the mansard.",
    ppe: ["Hard hat", "Harness"],
    ramsReference: "RA-0007-R02",
    ramsRevision: 2,
    permitReference: "PTW-0003",
    permitStatusAtIssue: "active",
    externalAttendees: [{ name: "J. Bloggs", company: "ACME Roofing Ltd" }],
    attendanceNote: "J. Smith, K. Patel, the groundworks crew",
    attendeeCount: 6,
    issuedByName: "A. Foreman",
    issuedOn: "2026-07-18",
  });

  it("freezes the linked RAMS/permit as point-in-time strings (not live FKs)", () => {
    expect(snap.rams_reference).toBe("RA-0007-R02");
    expect(snap.rams_revision).toBe(2);
    expect(snap.permit_reference).toBe("PTW-0003");
    expect(snap.permit_status_at_issue).toBe("active"); // status-at-issue, never re-derived live
  });

  it("freezes the Tier-B recorded attendance (free-text + headcount) — the subcontractor sign-in", () => {
    expect(snap.attendance_note).toBe("J. Smith, K. Patel, the groundworks crew");
    expect(snap.attendee_count).toBe(6);
  });

  it("contains EXACTLY the worker-safe key set — no internal/commercial field can leak", () => {
    expect(Object.keys(snap).sort()).toEqual([...TOOLBOX_TALK_SNAPSHOT_KEYS].sort());
    const json = JSON.stringify(snap).toLowerCase();
    for (const forbidden of [
      "cost", "price", "day_rate", "rate", "labour", "margin", "profit", "markup",
      "supplier", "commercial", "internal", "notes", "token", "secret",
      "email", "phone", "customer_id", "job_id", "org_id", "user_id",
    ]) {
      expect(json, `snapshot must not contain "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it("defaults optional fields safely (no undefined holes)", () => {
    const minimal = buildToolboxTalkSnapshot({
      talkReference: "TBT-0001",
      revision: 1,
      talkDate: "2026-07-01",
      deliveredBy: "Site Manager",
      topic: "Manual handling",
      keyPoints: "Lift with the legs; team-lift over 25kg.",
      issuedOn: "2026-07-01",
    });
    expect(minimal.ppe).toEqual([]);
    expect(minimal.external_attendees).toEqual([]);
    expect(minimal.attendance_note).toBeNull();
    expect(minimal.attendee_count).toBeNull();
    expect(minimal.rams_reference).toBeNull();
    expect(minimal.permit_reference).toBeNull();
    expect(minimal.location).toBeNull();
    expect(Object.keys(minimal).sort()).toEqual([...TOOLBOX_TALK_SNAPSHOT_KEYS].sort());
  });
});

/**
 * Toolbox Talk immutable evidence snapshot — the worker/customer-SAFE frozen record
 * written once when a talk is delivered (issued). Mirrors
 * lib/completion-certificates/snapshot.ts: security by construction — the builder
 * accepts ONLY worker-safe inputs, so no commercial/internal field can physically
 * reach the frozen object. Linked RAMS/permit are denormalised to point-in-time
 * STRINGS, so a later RAMS revision or permit expiry never mutates this evidence.
 *
 * The acknowledgement roster is deliberately NOT a snapshot key: signatures accrue
 * after issue, so they live in safety_acknowledgements (append-only, version-anchored)
 * and are rendered live — exactly as the RAMS PDF pulls sign-offs live.
 */

export type ToolboxAttendee = { name: string; company: string | null };

export type ToolboxTalkSnapshot = {
  // identity + lineage — frozen at issue
  talk_reference: string; // "TBT-0007" / "TBT-0007-R02"
  revision: number;
  // when + where delivered
  talk_date: string; // YYYY-MM-DD
  location: string | null; // specific area/plot
  site_label: string | null; // denormalised job site string (never a job_id)
  // who delivered it — display name / free text (never a user UUID or email)
  delivered_by: string;
  // the briefing itself — worker-facing safety content only
  topic: string;
  key_points: string;
  ppe: string[];
  // point-in-time document links — DENORMALISED STRINGS, never live FKs
  rams_reference: string | null; // "RA-0007-R02" as it stood at issue
  rams_revision: number | null;
  permit_reference: string | null; // "PTW-0003" as it stood at issue
  permit_status_at_issue: string | null; // frozen effectiveStatus
  // structured external / manual attendees captured in the room (Tier B) — frozen
  // names, NO PII beyond company. (Reserved for a future structured capture UI.)
  external_attendees: ToolboxAttendee[];
  // Tier B — the manager's free-text attendance record + headcount as typed at
  // delivery (the subcontractor paper sign-in for anyone not signing in-app). Frozen
  // here so the evidence PDF carries what was recorded, honestly labelled Tier B.
  attendance_note: string | null;
  attendee_count: number | null;
  // issue stamps
  issued_by_name: string | null; // display name only
  issued_on: string; // YYYY-MM-DD
};

// NOTE: this allowlist is ALSO enforced at the DB (tg_tt_a_lifecycle, migration
// 20261030) so a crafted PostgREST write cannot inject non-allowlist keys into the
// frozen evidence. Keep the two in sync — adding a key here means adding it there.
export const TOOLBOX_TALK_SNAPSHOT_KEYS: ReadonlyArray<keyof ToolboxTalkSnapshot> = [
  "talk_reference", "revision", "talk_date", "location", "site_label",
  "delivered_by", "topic", "key_points", "ppe",
  "rams_reference", "rams_revision", "permit_reference", "permit_status_at_issue",
  "external_attendees", "attendance_note", "attendee_count", "issued_by_name", "issued_on",
];

export type BuildToolboxTalkSnapshotInput = {
  talkReference: string;
  revision: number;
  talkDate: string;
  location?: string | null;
  siteLabel?: string | null;
  deliveredBy: string;
  topic: string;
  keyPoints: string;
  ppe?: string[] | null;
  ramsReference?: string | null;
  ramsRevision?: number | null;
  permitReference?: string | null;
  permitStatusAtIssue?: string | null;
  externalAttendees?: ToolboxAttendee[] | null;
  attendanceNote?: string | null;
  attendeeCount?: number | null;
  issuedByName?: string | null;
  issuedOn: string;
};

/**
 * Build the frozen, worker-safe snapshot. Every field is a scalar/string the input
 * deliberately supplies — there is no path for cost/rate/margin/internal notes/token
 * to enter. The returned object's key set is EXACTLY TOOLBOX_TALK_SNAPSHOT_KEYS
 * (asserted by the structural test).
 */
export function buildToolboxTalkSnapshot(input: BuildToolboxTalkSnapshotInput): ToolboxTalkSnapshot {
  return {
    talk_reference: input.talkReference,
    revision: input.revision,
    talk_date: input.talkDate,
    location: input.location ?? null,
    site_label: input.siteLabel ?? null,
    delivered_by: input.deliveredBy,
    topic: input.topic,
    key_points: input.keyPoints,
    ppe: input.ppe ?? [],
    rams_reference: input.ramsReference ?? null,
    rams_revision: input.ramsRevision ?? null,
    permit_reference: input.permitReference ?? null,
    permit_status_at_issue: input.permitStatusAtIssue ?? null,
    external_attendees: input.externalAttendees ?? [],
    attendance_note: input.attendanceNote ?? null,
    attendee_count: input.attendeeCount ?? null,
    issued_by_name: input.issuedByName ?? null,
    issued_on: input.issuedOn,
  };
}

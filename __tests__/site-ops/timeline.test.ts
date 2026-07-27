import { describe, expect, it } from "vitest";
import {
  compareSiteEvents,
  composeSiteTimeline,
  groupSiteTimelineByDay,
  isDateOnly,
  normaliseInstant,
  SITE_EVENT_KIND_META,
  SITE_EVENT_KINDS,
  type SiteTimelineInput,
} from "@/lib/site-ops/timeline";

/**
 * Unit proofs for the Site Timeline composer.
 *
 * The composer is the ONLY place the job feed's ordering and type mapping is
 * decided, and it is pure — so these tests are the full specification of the
 * feed's behaviour. No database, no clock, no I/O.
 */

const NOW = new Date("2026-07-20T12:00:00.000Z");
const JOB = "job-1";

function base(overrides: Partial<SiteTimelineInput> = {}): SiteTimelineInput {
  return { now: NOW, jobId: JOB, ...overrides };
}

describe("normaliseInstant", () => {
  it("maps a date-only value to midnight UTC of that day", () => {
    expect(normaliseInstant("2026-07-18")).toBe("2026-07-18T00:00:00.000Z");
  });

  it("canonicalises a timestamptz into ISO-8601 UTC", () => {
    expect(normaliseInstant("2026-07-18T09:30:00+01:00")).toBe("2026-07-18T08:30:00.000Z");
  });

  it("trims surrounding whitespace", () => {
    expect(normaliseInstant("  2026-07-18  ")).toBe("2026-07-18T00:00:00.000Z");
  });

  it("returns null for absent or unparseable input", () => {
    expect(normaliseInstant(null)).toBeNull();
    expect(normaliseInstant(undefined)).toBeNull();
    expect(normaliseInstant("")).toBeNull();
    expect(normaliseInstant("   ")).toBeNull();
    expect(normaliseInstant("not a date")).toBeNull();
    expect(normaliseInstant(42 as unknown as string)).toBeNull();
  });

  it("classifies date-only vs instant", () => {
    expect(isDateOnly("2026-07-18")).toBe(true);
    expect(isDateOnly("2026-07-18T00:00:00Z")).toBe(false);
  });
});

describe("composeSiteTimeline — empty inputs", () => {
  it("returns an empty feed when nothing is supplied", () => {
    expect(composeSiteTimeline(base())).toEqual([]);
  });

  it("returns an empty feed when every source is an empty array", () => {
    const out = composeSiteTimeline(
      base({
        diary: [],
        snags: [],
        toolbox: [],
        rams: [],
        permits: [],
        inspections: [],
        documents: [],
        attachments: [],
      }),
    );
    expect(out).toEqual([]);
  });

  it("groups an empty feed to an empty list", () => {
    expect(groupSiteTimelineByDay([])).toEqual([]);
  });
});

describe("composeSiteTimeline — type mapping", () => {
  it("maps a diary entry, dated by its calendar day", () => {
    const [e] = composeSiteTimeline(
      base({
        diary: [
          {
            id: "d1",
            entry_date: "2026-07-18",
            work_summary: "First fix upstairs",
            weather: "Dry",
            labour_count: 6,
          },
        ],
      }),
    );
    expect(e!.kind).toBe("diary");
    expect(e!.key).toBe("diary:d1");
    expect(e!.at).toBe("2026-07-18T00:00:00.000Z");
    expect(e!.day).toBe("2026-07-18");
    expect(e!.dateOnly).toBe(true);
    expect(e!.title).toContain("18 Jul 2026");
    expect(e!.detail).toBe("First fix upstairs · Dry · 6 on site");
    expect(e!.href).toBe("/diary/d1");
  });

  it("emits TWO events for a resolved snag and one for an open snag", () => {
    const out = composeSiteTimeline(
      base({
        snags: [
          {
            id: "s1",
            title: "Cracked tile",
            status: "verified",
            priority: "high",
            location: "Plot 4",
            created_at: "2026-07-10T08:00:00.000Z",
            resolved_at: "2026-07-15T16:00:00.000Z",
          },
          {
            id: "s2",
            title: "Loose socket",
            status: "open",
            priority: "low",
            location: null,
            created_at: "2026-07-11T08:00:00.000Z",
            resolved_at: null,
          },
        ],
      }),
    );
    expect(out.map((e) => e.key)).toEqual([
      "snag_resolved:s1",
      "snag_raised:s2",
      "snag_raised:s1",
    ]);
    // Status words come from the snag vocabulary, never a bare code.
    expect(out.find((e) => e.key === "snag_raised:s1")?.status).toBe("Verified");
    expect(out.find((e) => e.key === "snag_raised:s1")?.detail).toBe("Plot 4 · High priority");
    expect(out.find((e) => e.key === "snag_raised:s2")?.status).toBe("Open");
  });

  it("does not emit a closure event once a snag is reopened (resolved_at cleared)", () => {
    const out = composeSiteTimeline(
      base({
        snags: [
          {
            id: "s1",
            title: "Cracked tile",
            status: "in_progress",
            priority: "medium",
            location: null,
            created_at: "2026-07-10T08:00:00.000Z",
            resolved_at: null,
          },
        ],
      }),
    );
    expect(out.map((e) => e.kind)).toEqual(["snag_raised"]);
  });

  it("maps a toolbox talk by its talk date, with the vertical's status label", () => {
    const [e] = composeSiteTimeline(
      base({
        toolbox: [
          {
            id: "t1",
            topic: "Working at height",
            talk_date: "2026-07-17",
            status: "issued",
            reference: "TBT-0004",
            attendee_count: 9,
          },
        ],
      }),
    );
    expect(e!.kind).toBe("toolbox_talk");
    expect(e!.title).toBe("Working at height");
    expect(e!.detail).toBe("TBT-0004 · 9 attended");
    // "Delivered" is the toolbox vertical's own word for `issued` — proof the
    // feed borrows each domain's vocabulary instead of inventing a second one.
    expect(e!.status).toBe("Delivered");
    expect(e!.href).toBe("/toolbox/t1");
  });

  it("dates a RAMS by its issue, falling back to creation while draft", () => {
    const out = composeSiteTimeline(
      base({
        rams: [
          {
            id: "r1",
            title: "Roof tiling",
            reference: "RA-0007",
            status: "issued",
            activity: "Tiling, plot 4",
            created_at: "2026-07-01T09:00:00.000Z",
            issued_at: "2026-07-05T09:00:00.000Z",
          },
          {
            id: "r2",
            title: "Groundworks",
            reference: null,
            status: "draft",
            activity: null,
            created_at: "2026-07-02T09:00:00.000Z",
            issued_at: null,
          },
        ],
      }),
    );
    const issued = out.find((e) => e.sourceId === "r1")!;
    const draft = out.find((e) => e.sourceId === "r2")!;
    expect(issued.at).toBe("2026-07-05T09:00:00.000Z");
    expect(issued.status).toBe("Current");
    expect(issued.detail).toBe("RA-0007 · Tiling, plot 4");
    expect(draft.at).toBe("2026-07-02T09:00:00.000Z");
    expect(draft.status).toBe("Draft");
    expect(draft.detail).toBeNull();
  });

  it("shows a permit's DERIVED status, so a lapsed window never reads active", () => {
    const out = composeSiteTimeline(
      base({
        permits: [
          {
            id: "p1",
            title: "Hot works, roof",
            reference: "PTW-0002",
            permit_type: "hot_works",
            status: "active",
            created_at: "2026-07-01T09:00:00.000Z",
            issued_at: "2026-07-02T09:00:00.000Z",
            valid_from: "2026-07-02T09:00:00.000Z",
            // Window closed 18 days before `now`.
            valid_until: "2026-07-02T17:00:00.000Z",
          },
        ],
      }),
    );
    expect(out[0]!.kind).toBe("permit");
    expect(out[0]!.status).toBe("Expired");
    expect(out[0]!.detail).toBe("PTW-0002 · Hot works");
    expect(out[0]!.href).toBe("/health-safety/permits/p1");
  });

  it("names the asset on an inspection and dates it by when it was performed", () => {
    const [e] = composeSiteTimeline(
      base({
        inspections: [
          {
            id: "i1",
            asset_id: "a1",
            title: "Weekly check",
            kind: "loler",
            status: "issued",
            outcome: "pass_with_defects",
            inspected_at: "2026-07-16T07:30:00.000Z",
            created_at: "2026-07-16T09:00:00.000Z",
          },
        ],
        assetNames: new Map([["a1", "Telehandler"]]),
      }),
    );
    expect(e!.at).toBe("2026-07-16T07:30:00.000Z");
    expect(e!.title).toBe("Telehandler — Weekly check");
    expect(e!.detail).toBe("LOLER · Pass with defects");
    expect(e!.status).toBe("Issued");
    expect(e!.href).toBe("/assets/a1");
  });

  it("splits uploads into photos and documents by mime type", () => {
    const out = composeSiteTimeline(
      base({
        attachments: [
          {
            id: "att1",
            filename: "wall.jpg",
            mime_type: "image/jpeg",
            target_table: "snags",
            target_id: "s1",
            created_at: "2026-07-14T10:00:00.000Z",
          },
          {
            id: "att2",
            filename: "delivery-note.pdf",
            mime_type: "application/pdf",
            target_table: "jobs",
            target_id: JOB,
            created_at: "2026-07-13T10:00:00.000Z",
          },
          {
            id: "att3",
            filename: "unknown.bin",
            mime_type: null,
            target_table: "jobs",
            target_id: JOB,
            created_at: "2026-07-12T10:00:00.000Z",
          },
        ],
        attachmentContext: new Map([["s1", "Snag: Cracked tile"]]),
      }),
    );
    expect(out.map((e) => e.kind)).toEqual(["photo", "document", "document"]);
    expect(out[0]!.detail).toBe("Snag: Cracked tile");
    expect(out[1]!.href).toBe(`/jobs/${JOB}`);
    // An unknown mime type degrades to a document rather than being dropped.
    expect(out[2]!.title).toBe("unknown.bin");
  });

  it("maps a job document, marking a private one as such", () => {
    const out = composeSiteTimeline(
      base({
        documents: [
          {
            id: "doc1",
            title: "EICR",
            doc_type: "eicr",
            status: "completed",
            visibility: "private",
            created_at: "2026-07-09T10:00:00.000Z",
          },
        ],
      }),
    );
    expect(out[0]!.kind).toBe("document");
    expect(out[0]!.status).toBe("Completed");
    // The acronym is spelled the way the trade says it, not "Eicr".
    expect(out[0]!.detail).toBe("EICR · Private");
  });

  it("skips rows whose timestamp is missing or unparseable instead of throwing", () => {
    const out = composeSiteTimeline(
      base({
        diary: [
          { id: "d1", entry_date: "", work_summary: null, weather: null, labour_count: null },
          { id: "d2", entry_date: "nonsense", work_summary: null, weather: null, labour_count: null },
          { id: "d3", entry_date: "2026-07-18", work_summary: null, weather: null, labour_count: null },
        ],
      }),
    );
    expect(out.map((e) => e.sourceId)).toEqual(["d3"]);
  });

  it("has presentation metadata with a text label for every kind", () => {
    for (const kind of SITE_EVENT_KINDS) {
      expect(SITE_EVENT_KIND_META[kind].label.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("composeSiteTimeline — ordering", () => {
  const mixed = base({
    diary: [
      { id: "d1", entry_date: "2026-07-18", work_summary: null, weather: null, labour_count: null },
    ],
    snags: [
      {
        id: "s1",
        title: "Snag A",
        status: "open",
        priority: "high",
        location: null,
        created_at: "2026-07-19T06:00:00.000Z",
        resolved_at: null,
      },
    ],
    toolbox: [
      { id: "t1", topic: "Manual handling", talk_date: "2026-07-18", status: "issued", reference: null, attendee_count: null },
    ],
    permits: [
      {
        id: "p1",
        title: "Hot works",
        reference: null,
        permit_type: "hot_works",
        status: "closed",
        created_at: "2026-07-17T08:00:00.000Z",
        issued_at: "2026-07-17T08:00:00.000Z",
        valid_from: "2026-07-17T08:00:00.000Z",
        valid_until: "2026-07-17T18:00:00.000Z",
      },
    ],
  });

  it("orders newest first across mixed event types", () => {
    const out = composeSiteTimeline(mixed);
    expect(out.map((e) => e.key)).toEqual([
      "snag_raised:s1", // 19 Jul 06:00
      "diary:d1", // 18 Jul 00:00 (date-only)
      "toolbox_talk:t1", // 18 Jul 00:00 (date-only) — kind rank breaks the tie
      "permit:p1", // 17 Jul 08:00
    ]);
    // Timestamps are non-increasing.
    const times = out.map((e) => e.at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("breaks a same-timestamp tie by kind rank, then by source id", () => {
    const sameDay = base({
      diary: [
        { id: "d2", entry_date: "2026-07-18", work_summary: null, weather: null, labour_count: null },
        { id: "d1", entry_date: "2026-07-18", work_summary: null, weather: null, labour_count: null },
      ],
      toolbox: [
        { id: "t1", topic: "B", talk_date: "2026-07-18", status: null, reference: null, attendee_count: null },
      ],
    });
    expect(composeSiteTimeline(sameDay).map((e) => e.key)).toEqual([
      "diary:d1",
      "diary:d2",
      "toolbox_talk:t1",
    ]);
  });

  it("is independent of the order the sources arrive in", () => {
    const forward = composeSiteTimeline(mixed).map((e) => e.key);
    const reversed = composeSiteTimeline({
      ...mixed,
      diary: [...(mixed.diary ?? [])].reverse(),
      snags: [...(mixed.snags ?? [])].reverse(),
      toolbox: [...(mixed.toolbox ?? [])].reverse(),
      permits: [...(mixed.permits ?? [])].reverse(),
    }).map((e) => e.key);
    expect(reversed).toEqual(forward);
  });

  it("compareSiteEvents is a TOTAL order — only identical events compare equal", () => {
    const out = composeSiteTimeline(mixed);
    for (const a of out) {
      for (const b of out) {
        if (a.key === b.key) expect(compareSiteEvents(a, b)).toBe(0);
        else expect(compareSiteEvents(a, b)).not.toBe(0);
      }
    }
  });

  it("applies the display limit to the newest events", () => {
    const out = composeSiteTimeline(mixed, { limit: 2 });
    expect(out.map((e) => e.key)).toEqual(["snag_raised:s1", "diary:d1"]);
    expect(composeSiteTimeline(mixed, { limit: 0 })).toEqual([]);
    // A limit above the feed size is a no-op.
    expect(composeSiteTimeline(mixed, { limit: 99 })).toHaveLength(4);
  });
});

describe("groupSiteTimelineByDay", () => {
  it("buckets an ordered feed into contiguous days, preserving order", () => {
    const out = composeSiteTimeline(
      base({
        diary: [
          { id: "d1", entry_date: "2026-07-18", work_summary: null, weather: null, labour_count: null },
        ],
        snags: [
          {
            id: "s1",
            title: "A",
            status: "open",
            priority: "high",
            location: null,
            created_at: "2026-07-19T06:00:00.000Z",
            resolved_at: null,
          },
          {
            id: "s2",
            title: "B",
            status: "open",
            priority: "high",
            location: null,
            created_at: "2026-07-19T09:00:00.000Z",
            resolved_at: null,
          },
        ],
      }),
    );
    const groups = groupSiteTimelineByDay(out);
    expect(groups.map((g) => g.day)).toEqual(["2026-07-19", "2026-07-18"]);
    expect(groups[0]!.events.map((e) => e.sourceId)).toEqual(["s2", "s1"]);
    expect(groups[1]!.events).toHaveLength(1);
  });

  it("files a late-evening BST instant under its UK day, not its UTC day", () => {
    // 2026-07-19T23:30Z is 00:30 on 20 Jul in British Summer Time.
    const [e] = composeSiteTimeline(
      base({
        snags: [
          {
            id: "s1",
            title: "Late callout",
            status: "open",
            priority: "high",
            location: null,
            created_at: "2026-07-19T23:30:00.000Z",
            resolved_at: null,
          },
        ],
      }),
    );
    expect(e!.at).toBe("2026-07-19T23:30:00.000Z");
    expect(e!.day).toBe("2026-07-20");
  });
});

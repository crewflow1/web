import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * CrewFlow HQ — the auto morning CEO briefing READER (P2 HQ AI Operating System).
 *
 * The composer (lib/hq/ceo-briefing.ts) and store (hq_ceo_briefings, migration 20261128) are
 * WRITE-ONLY; this proves the read side that finally surfaces them at /admin/ceo/briefings:
 *
 *   • the reader returns the STORED briefings, newest day first (latest + history);
 *   • an unread-yet store is an honest EMPTY (latest null), never a fabricated row;
 *   • a failed read is LOUD (throws) — never a silently-empty archive;
 *   • the `signals` normaliser is TOTAL — `{}` / partial / malformed → empty shape, never a throw;
 *   • drill-down by date selects the recorded day, unknown days fall back to latest;
 *   • the page is ADMIN-GATED (requireHqPage) and renders no untrusted HTML (source contract).
 */

// A faithful double of the admin client's read chain the reader issues:
//   from(table).select(cols).order(...).order(...).range(from, to) → { data, error }
const { fake } = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const state = {
    rows: [] as Row[],
    error: null as { message: string } | null,
    reset() {
      this.rows = [];
      this.error = null;
    },
  };
  function client() {
    return {
      from() {
        const builder = {
          select() {
            return builder;
          },
          order() {
            return builder;
          },
          range(from: number, to: number) {
            if (state.error) return Promise.resolve({ data: null, error: state.error });
            return Promise.resolve({ data: state.rows.slice(from, to + 1), error: null });
          },
        };
        return builder;
      },
    };
  }
  return { fake: { state, client } };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.client() }));

import {
  getCeoBriefingArchive,
  selectBriefingByDate,
} from "@/server/services/hq-ceo-briefing-reader";
import {
  normalizeSignals,
  projectBriefingRow,
  BRIEFING_TONE_ORDER,
} from "@/lib/hq/ceo-briefing-record";

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    briefing_date: "2026-08-19",
    source: "deterministic",
    correlation_id: "11111111-1111-1111-1111-111111111111",
    headline: "CEO briefing 2026-08-19 — MRR £5,000; 1 department needs attention.",
    narrative: "Morning CEO briefing for 2026-08-19.\n\nCompany vitals:\n  - MRR: £5,000",
    signals: {
      vitals: [
        { key: "mrr", label: "MRR", value: 5000, format: "gbp", trendPct: 4.2, trendDirection: "up", foundation: false },
      ],
      departments: [
        { key: "support", title: "Support", healthTone: "attention", healthLabel: "Needs attention" },
        { key: "finance", title: "Finance", healthTone: "healthy", healthLabel: "Healthy" },
      ],
      competitors: {
        total: 1,
        notes: [
          { name: "Acme", headline: "Cut prices 10%", category: "pricing", importance: "high", capturedAt: "2026-08-18" },
        ],
      },
    },
    generated_at: "2026-08-19T06:00:00.000Z",
    created_at: "2026-08-19T06:00:00.000Z",
    ...over,
  };
}

beforeEach(() => fake.state.reset());

describe("getCeoBriefingArchive — returns the stored briefings, newest day first", () => {
  it("projects a stored row into the record view (latest, history, all)", async () => {
    fake.state.rows = [
      row({ id: 3, briefing_date: "2026-08-19" }),
      row({ id: 2, briefing_date: "2026-08-18" }),
      row({ id: 1, briefing_date: "2026-08-17" }),
    ];
    const archive = await getCeoBriefingArchive();
    expect(archive.all).toHaveLength(3);
    expect(archive.latest?.briefingDate).toBe("2026-08-19");
    expect(archive.latest?.source).toBe("deterministic");
    expect(archive.latest?.id).toBe(3);
    expect(archive.history.map((b) => b.briefingDate)).toEqual(["2026-08-18", "2026-08-17"]);
    // the stored structure is surfaced for drill-down
    expect(archive.latest?.signals.vitals[0]?.label).toBe("MRR");
    expect(archive.latest?.signals.competitors.notes[0]?.name).toBe("Acme");
  });

  it("preserves the store's newest-first ordering as read", async () => {
    fake.state.rows = [
      row({ id: 10, briefing_date: "2026-09-01" }),
      row({ id: 9, briefing_date: "2026-08-31" }),
    ];
    const archive = await getCeoBriefingArchive();
    expect(archive.all.map((b) => b.id)).toEqual([10, 9]);
  });

  it("EMPTY-STATE: an unread-yet store yields latest null, no fabricated row", async () => {
    fake.state.rows = [];
    const archive = await getCeoBriefingArchive();
    expect(archive.latest).toBeNull();
    expect(archive.history).toEqual([]);
    expect(archive.all).toEqual([]);
  });

  it("LOUD: a failed read throws rather than returning an empty archive", async () => {
    fake.state.error = { message: "boom" };
    await expect(getCeoBriefingArchive()).rejects.toThrow(/hq-ceo-briefing-reader: archive/);
  });

  it("coerces a numeric-string bigint id to a number", async () => {
    fake.state.rows = [row({ id: "42" })];
    const archive = await getCeoBriefingArchive();
    expect(archive.latest?.id).toBe(42);
  });
});

describe("selectBriefingByDate — drill-down over the loaded archive (no re-read)", () => {
  it("returns the requested day when present", async () => {
    fake.state.rows = [row({ id: 2, briefing_date: "2026-08-19" }), row({ id: 1, briefing_date: "2026-08-18" })];
    const archive = await getCeoBriefingArchive();
    expect(selectBriefingByDate(archive, "2026-08-18")?.id).toBe(1);
  });

  it("falls back to latest for a null or unknown day", async () => {
    fake.state.rows = [row({ id: 2, briefing_date: "2026-08-19" }), row({ id: 1, briefing_date: "2026-08-18" })];
    const archive = await getCeoBriefingArchive();
    expect(selectBriefingByDate(archive, null)?.id).toBe(2);
    expect(selectBriefingByDate(archive, "1999-01-01")?.id).toBe(2);
  });

  it("returns null when the archive is empty", async () => {
    const archive = await getCeoBriefingArchive();
    expect(selectBriefingByDate(archive, "2026-08-19")).toBeNull();
  });
});

describe("normalizeSignals — total & defensive (never throws on a bad snapshot)", () => {
  it("coerces an empty {} default into empty arrays / zero totals", () => {
    const s = normalizeSignals({});
    expect(s.vitals).toEqual([]);
    expect(s.departments).toEqual([]);
    expect(s.competitors).toEqual({ total: 0, notes: [] });
  });

  it("coerces null / non-object into the empty shape", () => {
    expect(normalizeSignals(null).vitals).toEqual([]);
    expect(normalizeSignals("nope").departments).toEqual([]);
  });

  it("normalises an invalid format to int and an invalid tone to insufficient", () => {
    const s = normalizeSignals({
      vitals: [{ key: "x", label: "X", value: 3, format: "florins" }],
      departments: [{ key: "d", title: "D", healthTone: "vibes" }],
    });
    expect(s.vitals[0]?.format).toBe("int");
    expect(s.departments[0]?.healthTone).toBe("insufficient");
    expect(s.departments[0]?.healthLabel).toBe("Unavailable");
  });

  it("drops non-object entries and defaults competitor total to the note count", () => {
    const s = normalizeSignals({
      vitals: [null, 7, { key: "k", label: "L", value: 1, format: "gbp" }],
      competitors: { notes: [{ name: "A", headline: "h" }, { name: "B", headline: "h2" }] },
    });
    expect(s.vitals).toHaveLength(1);
    expect(s.competitors.total).toBe(2);
    expect(s.competitors.notes[0]?.importance).toBe("normal");
    expect(s.competitors.notes[0]?.category).toBeNull();
  });

  it("keeps a well-formed snapshot intact through projectBriefingRow", () => {
    const rec = projectBriefingRow(row() as never);
    expect(rec.signals.vitals[0]).toMatchObject({ key: "mrr", format: "gbp", trendDirection: "up" });
    expect(rec.source).toBe("deterministic");
    expect(rec.correlationId).toMatch(/^1{8}-/);
  });
});

describe("BRIEFING_TONE_ORDER — most operationally urgent first", () => {
  it("leads with attention then insufficient", () => {
    expect(BRIEFING_TONE_ORDER.slice(0, 2)).toEqual(["attention", "insufficient"]);
    expect(BRIEFING_TONE_ORDER).toHaveLength(5);
  });
});

describe("reader page — admin-gated & untrusted-safe (source contract)", () => {
  const ROOT = resolve(__dirname, "..", "..");
  const page = readFileSync(resolve(ROOT, "app/admin/ceo/briefings/page.tsx"), "utf8");

  it("imports and awaits requireHqPage (HQ-only, never tenant auth)", () => {
    expect(page).toMatch(/import\s*\{\s*requireHqPage\s*\}\s*from\s*"@\/server\/auth\/hq"/);
    expect(page).toMatch(/await\s+requireHqPage\(\)/);
  });

  it("never uses dangerouslySetInnerHTML (recorded fields are React-escaped)", () => {
    expect(page).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it("reads through the loud, paged service and issues no write", () => {
    expect(page).toMatch(/getCeoBriefingArchive/);
    expect(page).not.toMatch(/\.insert\(|\.update\(|\.delete\(|hq_record_ceo_briefing/);
  });

  it("is registered in the HQ nav under Home", () => {
    // Nav moved to the grouped model; Morning briefings lives under the Home area.
    const model = readFileSync(
      resolve(ROOT, "app/admin/_nav/hq-nav-model.ts"),
      "utf8",
    );
    expect(model).toMatch(/\/admin\/ceo\/briefings/);
  });
});

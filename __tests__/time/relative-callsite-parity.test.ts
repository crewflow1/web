import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  RELATIVE_TIME_PRESETS,
  relativeTime,
  relativeTimeVerbose,
  type RelativeTimeOptions,
} from "@/lib/time/relative";

/**
 * Call-site parity proof for the relative-time consolidation.
 *
 * Each block below holds a VERBATIM copy of the implementation that call site
 * shipped before the refactor, frozen as an oracle. Every case asserts the new
 * module reproduces the old string exactly — or, where the change is
 * deliberate, that it produces the stated replacement AND that the replacement
 * genuinely differs from what shipped (so an "intended change" cannot be
 * rubber-stamped onto a row that never changed).
 *
 * The legacy copies read `Date.now()` internally, so the clock is faked to a
 * fixed instant rather than the oracles being rewritten.
 */

const NOW = new Date("2026-05-20T12:00:00.000Z");
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

/** Offsets exercised against every call site. Labels appear in failure output. */
const OFFSETS: Array<[label: string, ms: number]> = [
  ["0s", 0],
  ["1s", 1 * S],
  ["29.5s", 29.5 * S],
  ["30s", 30 * S],
  ["45s", 45 * S],
  ["59s", 59 * S],
  ["60s", 60 * S],
  ["90s", 90 * S],
  ["59m", 59 * M],
  ["60m", 60 * M],
  ["89m", 89 * M],
  ["91m", 91 * M],
  ["23h", 23 * H],
  ["23h30m", 23.5 * H],
  ["24h", 24 * H],
  ["5d", 5 * D],
  ["29d", 29 * D],
  ["29d12h", 29.5 * D],
  ["30d", 30 * D],
  ["60d", 60 * D],
  ["359d", 359 * D],
  ["360d", 360 * D],
  ["730d", 730 * D],
  ["future +1h", -1 * H],
  ["future +8d", -8 * D],
];

function gridRows(): Array<[string, string]> {
  return [
    ...OFFSETS.map(([label, ms]) => [label, ago(ms)] as [string, string]),
    ["unparseable", "not-a-date"],
    ["empty", ""],
  ];
}

/**
 * Runs `legacy` and `migrated` over every offset plus the degenerate inputs and
 * asserts they agree string-for-string.
 *
 * `intendedChanges` names rows whose output deliberately differs, with the
 * replacement; each is also asserted to have ACTUALLY changed, so a row that
 * was already correct cannot be quietly labelled a fix.
 *
 * `tzDependent` names rows the legacy implementation renders differently
 * depending on the runner's timezone — i.e. rows whose old output is not a
 * well-defined string at all. They are excluded from comparison here and must
 * be asserted absolutely by the caller. Every entry in both lists must exist in
 * the grid.
 */
function proveParity(
  legacy: (iso: string) => string,
  migrated: (iso: string) => string,
  opts: {
    intendedChanges?: Record<string, string>;
    tzDependent?: readonly string[];
  } = {},
) {
  const { intendedChanges = {}, tzDependent = [] } = opts;
  const rows = gridRows();

  for (const [label, iso] of rows) {
    if (tzDependent.includes(label)) continue;
    const before = legacy(iso);
    const after = migrated(iso);
    if (label in intendedChanges) {
      const want = intendedChanges[label]!;
      expect(after, `${label}: intended new output`).toBe(want);
      expect(before, `${label}: marked as changed but did not change`).not.toBe(
        want,
      );
    } else {
      expect(after, `${label}: expected parity with pre-migration output`).toBe(
        before,
      );
    }
  }

  for (const label of [...Object.keys(intendedChanges), ...tzDependent]) {
    expect(
      rows.some(([l]) => l === label),
      `parity options name unknown case "${label}"`,
    ).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// lib/notifications/format.ts — relativeTime(iso, now)
// ---------------------------------------------------------------------------

/** VERBATIM pre-migration copy. */
function legacyNotificationsFormat(iso: string, now: Date = new Date()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = now.getTime() - t;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

describe("parity: lib/notifications/format.ts → notification preset", () => {
  it("reproduces every string the deleted helper produced", () => {
    proveParity(
      (iso) => legacyNotificationsFormat(iso, NOW),
      (iso) =>
        relativeTime(iso, { ...RELATIVE_TIME_PRESETS.notification, now: NOW }),
    );
  });

  it("also fixes the null hole the old NaN guard missed", () => {
    // new Date(null).getTime() is 0, not NaN, so the old guard fell through and
    // rendered the epoch as an elapsed duration. Unreachable via its `string`
    // signature, but it was one `?? null` away.
    expect(legacyNotificationsFormat(null as unknown as string, NOW)).toBe(
      "57y ago",
    );
    expect(
      relativeTime(null, { ...RELATIVE_TIME_PRESETS.notification, now: NOW }),
    ).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// app/(app)/_components/notifications.tsx — local relativeTime(iso)
// ---------------------------------------------------------------------------

/** VERBATIM pre-migration copy. */
function legacyNotificationsComponent(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

describe("parity: app/(app)/_components/notifications.tsx → notification preset", () => {
  it("is unchanged under 30 days, and fixes the tail, future and invalid holes", () => {
    proveParity(
      legacyNotificationsComponent,
      (iso) =>
        relativeTime(iso, { ...RELATIVE_TIME_PRESETS.notification, now: NOW }),
      {
        intendedChanges: {
          // The component had NO overflow: a day count that grew without bound.
          "30d": "1mo ago",
          "60d": "2mo ago",
          "359d": "11mo ago",
          "360d": "1y ago",
          "730d": "2y ago",
          // ...NO future guard: a negative elapsed count rendered literally.
          "future +1h": "just now",
          "future +8d": "just now",
          // ...and NO invalid guard: NaN reached the template string.
          unparseable: "—",
          empty: "—",
        },
      },
    );
  });

  it("documents the exact strings production rendered for those holes", () => {
    expect(legacyNotificationsComponent(ago(730 * D))).toBe("730d ago");
    expect(legacyNotificationsComponent(ago(-1 * H))).toBe("-3600s ago");
    expect(legacyNotificationsComponent("not-a-date")).toBe("NaNd ago");
  });
});

// ---------------------------------------------------------------------------
// lib/ai-employees/model.ts — relativeTime(iso) [→ sales/model, memory/model]
// ---------------------------------------------------------------------------

/** VERBATIM pre-migration copy. */
function legacyAiEmployees(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const diff = Date.now() - then;
  if (diff < 0) return iso.slice(0, 10);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return iso.slice(0, 10);
}

describe("parity: lib/ai-employees/model.ts → module defaults", () => {
  it("reproduces every string, with no options passed at all", () => {
    proveParity(legacyAiEmployees, (iso) => relativeTime(iso, { now: NOW }));
  });

  it("keeps the null and undefined contract the boardroom relies on", () => {
    expect(legacyAiEmployees(null)).toBe("—");
    expect(relativeTime(null, { now: NOW })).toBe("—");
    expect(relativeTime(undefined, { now: NOW })).toBe("—");
  });

  it("still routes through the re-export on lib/ai-employees/model", async () => {
    const { relativeTime: viaModel } = await import("@/lib/ai-employees/model");
    const { relativeTime: viaSales } = await import("@/lib/sales/model");
    const { relativeTime: viaMemory } = await import("@/lib/memory/model");
    for (const fn of [viaModel, viaSales, viaMemory]) {
      expect(fn(null)).toBe("—");
      expect(fn(ago(5 * M))).toBe("5m ago");
      expect(fn(ago(2 * D))).toBe("2d ago");
      expect(fn("2020-01-15T10:00:00.000Z")).toBe("2020-01-15");
    }
  });
});

// ---------------------------------------------------------------------------
// lib/activity/render.ts — relativeTime(iso) [→ lib/events/render]
// ---------------------------------------------------------------------------

const LEGACY_VERBOSE = new Intl.RelativeTimeFormat("en-GB", {
  numeric: "auto",
});

/** VERBATIM pre-migration copy. */
function legacyActivityRender(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffSec = (then - Date.now()) / 1000;
  const abs = Math.abs(diffSec);
  if (abs < 60) return LEGACY_VERBOSE.format(Math.round(diffSec), "second");
  if (abs < 3600) return LEGACY_VERBOSE.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return LEGACY_VERBOSE.format(Math.round(diffSec / 3600), "hour");
  if (abs < 604800) return LEGACY_VERBOSE.format(Math.round(diffSec / 86400), "day");
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London",
  });
}

describe("parity: lib/activity/render.ts → relativeTimeVerbose", () => {
  it("reproduces every string the deleted helper produced", () => {
    proveParity(legacyActivityRender, (iso) => relativeTimeVerbose(iso, NOW));
  });

  it("still routes through the re-exports on activity/render and events/render", async () => {
    const { relativeTime: viaActivity } = await import("@/lib/activity/render");
    const { relativeTime: viaEvents } = await import("@/lib/events/render");
    for (const fn of [viaActivity, viaEvents]) {
      expect(fn(ago(5 * M))).toBe("5 minutes ago");
      expect(fn(ago(24 * H))).toBe("yesterday");
      expect(fn(ago(30 * D))).toBe("20 Apr 2026");
      expect(fn("not-a-date")).toBe("not-a-date");
    }
  });

  it("keeps the year-bearing fallback identical to formatDateShortUK", async () => {
    const { formatDateShortUK } = await import("@/lib/time/format");
    const iso = ago(30 * D);
    expect(relativeTimeVerbose(iso, NOW)).toBe(formatDateShortUK(iso));
    expect(relativeTimeVerbose(iso, NOW)).toBe(legacyActivityRender(iso));
  });
});

// ---------------------------------------------------------------------------
// app/admin/{research,tasks,qualification}/page.tsx — three byte-identical copies
// ---------------------------------------------------------------------------

/** VERBATIM pre-migration copy (all three pages shipped this exact body). */
function legacyHqConsole(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

describe("parity: app/admin/{research,tasks,qualification} → hqConsole preset", () => {
  const migrated = (iso: string) =>
    relativeTime(iso, { ...RELATIVE_TIME_PRESETS.hqConsole, now: NOW });

  /**
   * Rows that reach the day+month overflow. The legacy fallback carried no
   * timeZone, so its output tracked the RUNNER's zone — e.g. the 29d12h row
   * lands on 00:00Z, which is the previous calendar day anywhere behind UTC.
   * There is no single "old string" to compare against, so these are asserted
   * absolutely, London-pinned, in the next test instead.
   */
  const OVERFLOW_ROWS = [
    "29d12h",
    "30d",
    "60d",
    "359d",
    "360d",
    "730d",
  ] as const;

  it("reproduces every string, including the nearest-rounding cascade", () => {
    proveParity(legacyHqConsole, migrated, { tzDependent: OVERFLOW_ROWS });
  });

  it("renders the overflow rows as London-pinned day + month", () => {
    expect(migrated(ago(29.5 * D))).toBe("21 Apr");
    expect(migrated(ago(30 * D))).toBe("20 Apr");
    expect(migrated(ago(60 * D))).toBe("21 Mar");
    expect(migrated(ago(359 * D))).toBe("26 May");
    expect(migrated(ago(360 * D))).toBe("25 May");
    expect(migrated(ago(730 * D))).toBe("20 May");
    // The zone is pinned, so these hold in any runner timezone — which is
    // exactly what the legacy no-timeZone version could not promise.
    expect(new Set(OVERFLOW_ROWS).size).toBe(OVERFLOW_ROWS.length);
  });

  it("preserves the rounding decisions that distinguish this contract", () => {
    // These are the cases where nearest-rounding disagrees with the floor
    // ladder every other surface uses.
    expect(legacyHqConsole(ago(45 * S))).toBe("1m ago");
    expect(migrated(ago(45 * S))).toBe("1m ago");
    expect(legacyHqConsole(ago(91 * M))).toBe("2h ago");
    expect(migrated(ago(91 * M))).toBe("2h ago");
    expect(legacyHqConsole(ago(23.5 * H))).toBe("1d ago");
    expect(migrated(ago(23.5 * H))).toBe("1d ago");
    // Floor-mode, for contrast: the same instants read one unit lower.
    expect(relativeTime(ago(45 * S), { now: NOW })).toBe("just now");
    expect(relativeTime(ago(91 * M), { now: NOW })).toBe("1h ago");
    expect(relativeTime(ago(23.5 * H), { now: NOW })).toBe("23h ago");
  });

  it("INTENDED CHANGE: the overflow date is now London-pinned", () => {
    const iso = "2026-05-20T23:30:00.000Z";
    const later = new Date("2026-07-20T12:00:00.000Z");
    const opts: RelativeTimeOptions = {
      ...RELATIVE_TIME_PRESETS.hqConsole,
      now: later,
    };
    // What a UTC production server rendered for this instant...
    expect(
      new Date(iso).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }),
    ).toBe("20 May");
    // ...versus the correct UK calendar day it renders now.
    expect(relativeTime(iso, opts)).toBe("21 May");
  });
});

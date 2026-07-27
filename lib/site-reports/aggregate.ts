import type { ReportContent, ReportSnapshot, ReportSources } from "./schema";

/**
 * Site Reports — deterministic aggregation (pure).
 *
 * Takes source records that were already fetched (job + period scoped) and
 * shapes them: proposes a default selection, summarises counts for the create
 * preview, filters to the author's selection, and materialises the frozen
 * snapshot at issue. No I/O and no clock — the caller passes `issuedAt` — so
 * every function here is unit-testable and reproducible. This is *deterministic
 * aggregation, not AI generation* (the CEO's distinction).
 */

export type DiaryLite = {
  id: string;
  entry_date: string;
  weather: string | null;
  labour_count: number | null;
  work_summary: string | null;
  delays: string | null;
};
export type SnagLite = {
  id: string;
  title: string;
  status: string;
  priority: string;
  location: string | null;
  trade: string | null;
  due_date: string | null;
};
export type ToolboxLite = {
  id: string;
  talk_date: string;
  topic: string;
  presenter: string | null;
  attendee_count: number | null;
};

export type RawSources = {
  diary: DiaryLite[];
  snags: SnagLite[];
  toolbox: ToolboxLite[];
};

const OPEN_SNAG_STATUSES = new Set(["open", "in_progress", "fixed"]);

/** Everything in scope is proposed for inclusion; the author curates from there. */
export function defaultSelection(sources: RawSources): ReportSources {
  return {
    diary_entry_ids: sources.diary.map((d) => d.id),
    snag_ids: sources.snags.map((s) => s.id),
    toolbox_talk_ids: sources.toolbox.map((t) => t.id),
    photo_attachment_ids: [],
  };
}

/** Headline counts for the create preview + the report's programme section. */
export function summariseSources(sources: RawSources): {
  diary: number;
  snags: number;
  openSnags: number;
  overdueSnags: number;
  toolbox: number;
  totalAttendance: number;
} {
  const today = sources.diary[0]?.entry_date ?? "";
  return {
    diary: sources.diary.length,
    snags: sources.snags.length,
    openSnags: sources.snags.filter((s) => OPEN_SNAG_STATUSES.has(s.status))
      .length,
    overdueSnags: sources.snags.filter(
      (s) =>
        OPEN_SNAG_STATUSES.has(s.status) &&
        !!s.due_date &&
        !!today &&
        s.due_date < today,
    ).length,
    toolbox: sources.toolbox.length,
    totalAttendance: sources.toolbox.reduce(
      (sum, t) => sum + (t.attendee_count ?? 0),
      0,
    ),
  };
}

/** Narrow the fetched sources to exactly what the author selected. */
export function filterSelected(
  sources: RawSources,
  selection: ReportSources,
): RawSources {
  const diarySet = new Set(selection.diary_entry_ids);
  const snagSet = new Set(selection.snag_ids);
  const toolboxSet = new Set(selection.toolbox_talk_ids);
  return {
    diary: sources.diary.filter((d) => diarySet.has(d.id)),
    snags: sources.snags.filter((s) => snagSet.has(s.id)),
    toolbox: sources.toolbox.filter((t) => toolboxSet.has(t.id)),
  };
}

/**
 * Build the frozen, customer-visible snapshot from the report meta, the author's
 * commentary, and the SELECTED, already-resolved source records. This is what
 * `snapshot` stores at issue — so the report never changes when the underlying
 * rows are later edited.
 */
export function materializeSnapshot(input: {
  title: string;
  reportNumber: string | null;
  revision: number;
  periodStart: string;
  periodEnd: string;
  customerName: string | null;
  jobLabel: string | null;
  content: ReportContent;
  sources: RawSources;
  selection: ReportSources;
  issuedAt: string;
}): ReportSnapshot {
  const selected = filterSelected(input.sources, input.selection);
  return {
    title: input.title,
    report_number: input.reportNumber,
    revision: input.revision,
    period_start: input.periodStart,
    period_end: input.periodEnd,
    customer_name: input.customerName,
    job_label: input.jobLabel,
    content: input.content,
    sources: {
      diary: selected.diary as unknown as Array<Record<string, unknown>>,
      snags: selected.snags as unknown as Array<Record<string, unknown>>,
      toolbox_talks: selected.toolbox as unknown as Array<Record<string, unknown>>,
    },
    issued_at: input.issuedAt,
  };
}

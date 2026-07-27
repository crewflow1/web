import { SNAG_PRIORITY_LABELS, SNAG_STATUS_LABELS, type SnagPriority, type SnagStatus } from "@/lib/snags/schema";
import { formatDiaryDate } from "@/lib/site-diary/schema";
import { toolboxStatusLabel, type ToolboxTalkStatus } from "@/lib/health-safety/toolbox-talks";
import { effectiveStatus, PERMIT_TYPE_LABELS, type PermitStatus } from "@/lib/health-safety/permits";
import { formatDayKeyUK } from "@/lib/time/format";
import {
  INSPECTION_KIND_LABELS,
  INSPECTION_OUTCOME_LABELS,
  INSPECTION_STATUS_LABELS,
  type InspectionKind,
  type InspectionOutcome,
  type InspectionStatus,
} from "@/lib/assets/inspection";

/**
 * Site Timeline — the composed "what happened on this job" feed (PURE).
 *
 * This module OWNS NO DATA and performs NO I/O. It takes rows that were already
 * fetched (RLS-scoped + org-pinned + job-pinned by
 * server/services/site-timeline.ts) and merges them into one chronological,
 * typed feed. That split is deliberate:
 *
 *   - every ordering / labelling / type-mapping rule is unit-testable without a
 *     database, and
 *   - the feed re-uses the EXISTING domain vocabularies (snag status + priority
 *     labels, toolbox status labels, permit effective-status, inspection
 *     outcome/kind labels, the diary date formatter) instead of forking a second
 *     set of strings that could drift from the verticals they describe.
 *
 * No new business rules are invented here. A snag's lifecycle still belongs to
 * lib/snags/schema.ts; a permit's expiry is still decided by
 * lib/health-safety/permits.ts. This file only decides WHEN something goes in
 * the feed and HOW it reads.
 */

// ── Event shape ──────────────────────────────────────────────────────────────

export const SITE_EVENT_KINDS = [
  "diary",
  "snag_raised",
  "snag_resolved",
  "toolbox_talk",
  "rams",
  "permit",
  "inspection",
  "document",
  "photo",
] as const;
export type SiteEventKind = (typeof SITE_EVENT_KINDS)[number];

/**
 * Presentation metadata per kind. `label` is the WORD shown on the badge — the
 * kind is never communicated by colour alone (WCAG 1.4.1), the tone only
 * reinforces it.
 */
export const SITE_EVENT_KIND_META: Record<SiteEventKind, { label: string; tone: string }> = {
  diary: { label: "Diary", tone: "bg-sky-100 text-sky-800" },
  snag_raised: { label: "Snag raised", tone: "bg-rose-100 text-rose-800" },
  snag_resolved: { label: "Snag closed", tone: "bg-emerald-100 text-emerald-800" },
  toolbox_talk: { label: "Toolbox talk", tone: "bg-amber-100 text-amber-800" },
  rams: { label: "RAMS", tone: "bg-indigo-100 text-indigo-800" },
  permit: { label: "Permit", tone: "bg-violet-100 text-violet-800" },
  inspection: { label: "Inspection", tone: "bg-teal-100 text-teal-800" },
  document: { label: "Document", tone: "bg-slate-100 text-slate-700" },
  photo: { label: "Photo", tone: "bg-slate-100 text-slate-700" },
};

/**
 * Same-instant tiebreak order. Purely for determinism + readability: when a
 * diary entry and a toolbox talk share a calendar day (both are date-only
 * sources, so both normalise to midnight) the day's narrative reads
 * diary → defects → safety → plant → paperwork rather than in whatever order
 * PostgREST happened to return them.
 */
const KIND_RANK: Record<SiteEventKind, number> = {
  diary: 0,
  snag_raised: 1,
  snag_resolved: 2,
  toolbox_talk: 3,
  rams: 4,
  permit: 5,
  inspection: 6,
  document: 7,
  photo: 8,
};

export interface SiteTimelineEvent {
  /** Unique, stable React key + dedupe identity. `${kind}:${sourceId}`. */
  key: string;
  kind: SiteEventKind;
  /**
   * Normalised sort instant — ALWAYS canonical ISO-8601 UTC
   * (`YYYY-MM-DDTHH:mm:ss.sssZ`), so a lexicographic compare is a chronological
   * compare. Date-only sources land on midnight UTC of their day.
   */
  at: string;
  /**
   * The Europe/London calendar day `at` falls on (`YYYY-MM-DD`) — the bucket
   * the UI groups under. UK day, not UTC day, so a late-evening BST event is
   * filed under the date its displayed time reads.
   */
  day: string;
  /** True when the source column is a `date` and carries no meaningful time. */
  dateOnly: boolean;
  title: string;
  detail: string | null;
  /** Status as a WORD (never colour-only). Null when the source has no status. */
  status: string | null;
  /** Deep link into the vertical that owns the record. */
  href: string | null;
  /** The owning row's primary key. */
  sourceId: string;
}

// ── Input rows (exactly the columns the service selects) ─────────────────────

export type DiaryEventRow = {
  id: string;
  entry_date: string;
  work_summary: string | null;
  weather: string | null;
  labour_count: number | null;
};

export type SnagEventRow = {
  id: string;
  title: string;
  status: string;
  priority: string;
  location: string | null;
  created_at: string;
  resolved_at: string | null;
};

export type ToolboxEventRow = {
  id: string;
  topic: string;
  talk_date: string;
  status: string | null;
  reference: string | null;
  attendee_count: number | null;
};

export type RamsEventRow = {
  id: string;
  title: string;
  reference: string | null;
  status: string;
  activity: string | null;
  created_at: string;
  issued_at: string | null;
};

export type PermitEventRow = {
  id: string;
  title: string;
  reference: string | null;
  permit_type: string;
  status: string;
  created_at: string;
  issued_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
};

export type InspectionEventRow = {
  id: string;
  asset_id: string;
  title: string;
  kind: string | null;
  status: string;
  outcome: string | null;
  inspected_at: string | null;
  created_at: string;
};

export type JobDocumentEventRow = {
  id: string;
  title: string;
  doc_type: string;
  status: string;
  visibility: string;
  created_at: string;
};

export type AttachmentEventRow = {
  id: string;
  filename: string;
  mime_type: string | null;
  target_table: string;
  target_id: string;
  created_at: string;
};

export interface SiteTimelineInput {
  /** Clock, injected so permit expiry (and therefore output) is reproducible. */
  now: Date;
  jobId: string;
  diary?: readonly DiaryEventRow[];
  snags?: readonly SnagEventRow[];
  toolbox?: readonly ToolboxEventRow[];
  rams?: readonly RamsEventRow[];
  permits?: readonly PermitEventRow[];
  inspections?: readonly InspectionEventRow[];
  documents?: readonly JobDocumentEventRow[];
  attachments?: readonly AttachmentEventRow[];
  /** asset_id → display name, resolved by the caller in one batched read. */
  assetNames?: ReadonlyMap<string, string>;
  /** target_id → human label ("Diary 18 Jul 2026"), for attachment context. */
  attachmentContext?: ReadonlyMap<string, string>;
}

// ── Timestamp normalisation ──────────────────────────────────────────────────

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** True when PostgREST handed us a `date` column rather than a `timestamptz`. */
export function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value.trim());
}

/**
 * Canonicalise any diary `date` or `*_at` timestamptz into a single comparable
 * ISO-8601 UTC instant. Date-only values become midnight UTC of that day, so a
 * `date` and a `timestamptz` can share one sort key. Returns null for absent or
 * unparseable input — such a row is simply omitted from the feed rather than
 * being sorted to an arbitrary position (or crashing the page).
 */
export function normaliseInstant(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  const candidate = DATE_ONLY.test(raw) ? `${raw}T00:00:00.000Z` : raw;
  const ms = Date.parse(candidate);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function event(
  kind: SiteEventKind,
  sourceId: string,
  rawAt: string | null | undefined,
  fields: { title: string; detail?: string | null; status?: string | null; href?: string | null },
): SiteTimelineEvent | null {
  const at = normaliseInstant(rawAt);
  if (!at) return null;
  return {
    key: `${kind}:${sourceId}`,
    kind,
    at,
    day: formatDayKeyUK(at) || at.slice(0, 10),
    dateOnly: typeof rawAt === "string" && isDateOnly(rawAt),
    title: fields.title,
    detail: fields.detail ?? null,
    status: fields.status ?? null,
    href: fields.href ?? null,
    sourceId,
  };
}

/** Join non-empty fragments into one detail line. Null when nothing survives. */
function detailLine(...parts: Array<string | null | undefined>): string | null {
  const kept = parts.map((p) => (typeof p === "string" ? p.trim() : "")).filter((p) => p.length > 0);
  return kept.length > 0 ? kept.join(" · ") : null;
}

/** Clamp long free text so one verbose diary entry can't dominate the feed. */
function clip(text: string | null | undefined, max = 180): string | null {
  if (typeof text !== "string") return null;
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return null;
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function label<T extends string>(map: Record<T, string>, value: string | null): string | null {
  if (!value) return null;
  return (map as Record<string, string>)[value] ?? value;
}

/**
 * Sentence-case a raw DB status code for display ("not_yet_valid" → "Not yet
 * valid"). Used only where the owning vertical has no label map of its own —
 * where one exists (snags, toolbox, inspections) we call it instead.
 */
function humanise(code: string): string {
  const t = code.replace(/_/g, " ").trim();
  return t.length === 0 ? code : t.charAt(0).toUpperCase() + t.slice(1);
}

// ── Per-entity mappers ───────────────────────────────────────────────────────

function fromDiary(rows: readonly DiaryEventRow[]): Array<SiteTimelineEvent | null> {
  return rows.map((r) =>
    event("diary", r.id, r.entry_date, {
      title: `Site diary — ${formatDiaryDate(r.entry_date)}`,
      detail: detailLine(
        clip(r.work_summary),
        r.weather ? clip(r.weather, 60) : null,
        typeof r.labour_count === "number" ? `${r.labour_count} on site` : null,
      ),
      href: `/diary/${r.id}`,
    }),
  );
}

/**
 * A snag contributes up to TWO events: it was raised, and (once it reaches a
 * terminal status) it was closed. `resolved_at` is the DB's own stamp — set and
 * cleared by lib/snags/schema.ts's resolvedAtForTransition — so a reopened snag
 * automatically loses its closure event without any rule being restated here.
 */
function fromSnags(rows: readonly SnagEventRow[]): Array<SiteTimelineEvent | null> {
  const out: Array<SiteTimelineEvent | null> = [];
  for (const r of rows) {
    const priority = label(SNAG_PRIORITY_LABELS as Record<SnagPriority, string>, r.priority);
    const status = label(SNAG_STATUS_LABELS as Record<SnagStatus, string>, r.status);
    out.push(
      event("snag_raised", r.id, r.created_at, {
        title: r.title,
        detail: detailLine(r.location ? clip(r.location, 60) : null, priority ? `${priority} priority` : null),
        status,
        href: `/snags/${r.id}`,
      }),
    );
    if (r.resolved_at) {
      out.push(
        event("snag_resolved", r.id, r.resolved_at, {
          title: r.title,
          detail: detailLine(r.location ? clip(r.location, 60) : null),
          status,
          href: `/snags/${r.id}`,
        }),
      );
    }
  }
  return out;
}

function fromToolbox(rows: readonly ToolboxEventRow[]): Array<SiteTimelineEvent | null> {
  return rows.map((r) =>
    event("toolbox_talk", r.id, r.talk_date, {
      title: r.topic,
      detail: detailLine(
        r.reference,
        typeof r.attendee_count === "number" ? `${r.attendee_count} attended` : null,
      ),
      status: r.status ? toolboxStatusLabel(r.status as ToolboxTalkStatus) : null,
      href: `/toolbox/${r.id}`,
    }),
  );
}

/** RAMS are dated by their ISSUE (the moment they became the safe system of work). */
function fromRams(rows: readonly RamsEventRow[]): Array<SiteTimelineEvent | null> {
  return rows.map((r) =>
    event("rams", r.id, r.issued_at ?? r.created_at, {
      title: r.title,
      detail: detailLine(r.reference, clip(r.activity, 80)),
      status: r.status === "issued" ? "Current" : humanise(r.status),
      href: `/health-safety/${r.id}`,
    }),
  );
}

/**
 * Permits are dated by issue, and their status is the DERIVED one — so a permit
 * whose window has closed reads "expired" on the timeline instead of the stale
 * stored "active". Same authority the job safety panel uses.
 */
function fromPermits(rows: readonly PermitEventRow[], now: Date): Array<SiteTimelineEvent | null> {
  return rows.map((r) => {
    const eff = effectiveStatus(r.status as PermitStatus, r.valid_until, now, r.valid_from);
    return event("permit", r.id, r.issued_at ?? r.created_at, {
      title: r.title,
      detail: detailLine(
        r.reference,
        (PERMIT_TYPE_LABELS as Record<string, string>)[r.permit_type] ?? r.permit_type,
      ),
      status: humanise(eff),
      href: `/health-safety/permits/${r.id}`,
    });
  });
}

function fromInspections(
  rows: readonly InspectionEventRow[],
  assetNames: ReadonlyMap<string, string> | undefined,
): Array<SiteTimelineEvent | null> {
  return rows.map((r) =>
    event("inspection", r.id, r.inspected_at ?? r.created_at, {
      title: assetNames?.get(r.asset_id) ? `${assetNames.get(r.asset_id)} — ${r.title}` : r.title,
      detail: detailLine(
        label(INSPECTION_KIND_LABELS as Record<InspectionKind, string>, r.kind),
        label(INSPECTION_OUTCOME_LABELS as Record<InspectionOutcome, string>, r.outcome),
      ),
      status: label(INSPECTION_STATUS_LABELS as Record<InspectionStatus, string>, r.status),
      href: `/assets/${r.asset_id}`,
    }),
  );
}

const DOC_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  in_progress: "In progress",
  completed: "Completed",
};

/**
 * Display names for job_documents.doc_type — mirrors the CHECK in
 * 20260704010000_job_documents.sql. The vertical has no label map of its own
 * (it never renders the type), and "Eicr" is not what a sparky calls an EICR,
 * so the acronyms are spelled properly here. `custom` is the default and adds
 * nothing to a timeline line, hence blank.
 */
const DOC_TYPE_LABELS: Record<string, string> = {
  eicr: "EICR",
  test_sheet: "Test sheet",
  risk_assessment: "Risk assessment",
  method_statement: "Method statement",
  completion_cert: "Completion certificate",
  checklist: "Checklist",
  site_report: "Site report",
  timesheet: "Timesheet",
  commissioning: "Commissioning",
  custom: "",
};

function fromDocuments(rows: readonly JobDocumentEventRow[], jobId: string): Array<SiteTimelineEvent | null> {
  return rows.map((r) =>
    event("document", r.id, r.created_at, {
      title: r.title,
      detail: detailLine(
        DOC_TYPE_LABELS[r.doc_type] ?? humanise(r.doc_type),
        r.visibility === "private" ? "Private" : null,
      ),
      status: DOC_STATUS_LABELS[r.status] ?? r.status,
      href: `/jobs/${jobId}`,
    }),
  );
}

/**
 * An uploaded file is a PHOTO when its recorded mime type is an image, and a
 * DOCUMENT otherwise. `mime_type` is nullable, so an unknown type degrades to
 * "document" rather than being dropped.
 */
function fromAttachments(
  rows: readonly AttachmentEventRow[],
  context: ReadonlyMap<string, string> | undefined,
  jobId: string,
): Array<SiteTimelineEvent | null> {
  return rows.map((r) => {
    const isImage = typeof r.mime_type === "string" && r.mime_type.toLowerCase().startsWith("image/");
    return event(isImage ? "photo" : "document", r.id, r.created_at, {
      title: r.filename,
      detail: context?.get(r.target_id) ?? null,
      href: r.target_table === "jobs" ? `/jobs/${jobId}` : null,
    });
  });
}

// ── The composer ─────────────────────────────────────────────────────────────

/**
 * Total order over the feed: NEWEST FIRST by instant, then by kind rank, then
 * by source id. The last two make the order TOTAL — two events can never
 * compare equal unless they are the same event — so the output is identical for
 * any permutation of the inputs. That matters because the sources arrive from
 * independent queries whose relative arrival order is not guaranteed.
 *
 * `at` is canonical ISO-8601 UTC, so the string compare IS the time compare.
 */
export function compareSiteEvents(a: SiteTimelineEvent, b: SiteTimelineEvent): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  if (a.kind !== b.kind) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;
  return 0;
}

/**
 * Merge every supplied source into one chronological feed.
 *
 * Pure: no clock of its own (`input.now`), no I/O, no mutation of the inputs.
 * Rows whose timestamp is missing or unparseable are skipped — a single bad row
 * must never blank a site manager's whole timeline.
 */
export function composeSiteTimeline(
  input: SiteTimelineInput,
  options: { limit?: number } = {},
): SiteTimelineEvent[] {
  const events = [
    ...fromDiary(input.diary ?? []),
    ...fromSnags(input.snags ?? []),
    ...fromToolbox(input.toolbox ?? []),
    ...fromRams(input.rams ?? []),
    ...fromPermits(input.permits ?? [], input.now),
    ...fromInspections(input.inspections ?? [], input.assetNames),
    ...fromDocuments(input.documents ?? [], input.jobId),
    ...fromAttachments(input.attachments ?? [], input.attachmentContext, input.jobId),
  ].filter((e): e is SiteTimelineEvent => e !== null);

  events.sort(compareSiteEvents);

  const limit = options.limit;
  if (typeof limit === "number" && limit >= 0 && events.length > limit) {
    return events.slice(0, limit);
  }
  return events;
}

/**
 * Bucket an ALREADY-ORDERED feed by calendar day, preserving order. Days come
 * back newest-first with their events still newest-first, which is what the
 * mobile UI renders (one sticky-ish date heading per day rather than repeating
 * the date on every row).
 */
export function groupSiteTimelineByDay(
  events: readonly SiteTimelineEvent[],
): Array<{ day: string; events: SiteTimelineEvent[] }> {
  const out: Array<{ day: string; events: SiteTimelineEvent[] }> = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (last && last.day === e.day) last.events.push(e);
    else out.push({ day: e.day, events: [e] });
  }
  return out;
}

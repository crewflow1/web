import { daysBetween } from "@/lib/schedule/window";
import type { ProgressSummary } from "@/lib/job-progress/series";
import {
  DELAY_CATEGORIES,
  DELAY_CATEGORY_LABELS,
  type DelayCategory,
  type DelayEventStatus,
} from "@/lib/eot/lifecycle";

/**
 * EOT evidence pack — ASSEMBLY (PURE).
 *
 * Takes rows the caller already fetched (RLS-scoped, org- and job-pinned by
 * server/services/eot-pack.ts) and composes ONE deterministic structure: the
 * job's recorded delay events grouped by head of delay, each with the diary
 * entry and variation it links to, the job's EoT-carrying variations, the
 * progress series CONTEXT, and — first-class, not a footnote — the GAPS.
 *
 * ── EVIDENCE, NOT A CLAIM ──────────────────────────────────────────────────
 * The pack ASSEMBLES what the org recorded; it asserts no entitlement,
 * computes no contractual quantum, and drafts no letter. Specifically:
 *   • `totalClaimedWorkingDaysLost` is a SUM OF HUMAN CLAIMS (the stored
 *     working_days_lost integers). Nothing here derives working days from a
 *     date range — `calendarDaysSpanned` is labelled calendar time precisely
 *     so nobody mistakes it for the claim.
 *   • Only RECORDED events enter the pack. Drafts are half-written accounts
 *     and withdrawn events are retracted ones; both are counted (so the
 *     reviewer knows they exist) but never itemised as evidence.
 *   • Gaps are stated, never papered over. "No diary entry linked" in the
 *     pack today is a prompt to fix the record NOW, while memories are
 *     fresh — not a surprise in a dispute two years on.
 *
 * ── COMPOSITION, NOT RE-DETECTION ──────────────────────────────────────────
 * Progress context is the `ProgressSummary` ALREADY built by
 * lib/job-progress/series.ts (via server/services/job-progress.ts). This
 * module consumes it as an opaque input; it never re-merges observations and
 * reports, because two definitions of the series is how a pack ends up
 * disagreeing with the chart beside it.
 *
 * ── THE WEATHER SEAM ───────────────────────────────────────────────────────
 * `weatherEvidenceAvailable` is a parameter the caller DERIVES from the shipped
 * weather cache (20261074) via the governed read accessor
 * (server/services/weather.ts → buildWeatherSnapshot). It is `true` only when
 * real observed readings exist for a weather event's delay window, and the
 * per-event evidence itself arrives through `weatherEvidenceByEvent`. This file
 * still owns NO rule about WHETHER weather is available — it renders what the
 * caller resolved:
 *   • flag false (the state of every environment today — provider dark, cache
 *     empty) ⇒ every weather-category event carries the explicit gap
 *     "weather evidence unavailable — provider dark", BYTE-IDENTICAL to before
 *     this seam was wired. Nothing is fabricated: an absent reading is a gap,
 *     never a green corroboration.
 *   • flag true ⇒ the dark gap is suppressed and, where the caller supplied a
 *     reading summary for that event, it is attached as `weatherEvidence`.
 * The invariant this preserves: no reading is ever invented. When the cache is
 * empty the pack looks exactly as it did before, because the accessor returns
 * no readings and the caller passes `false`.
 *
 * Deterministic and permutation-independent: categories render in
 * DELAY_CATEGORIES order, events sort by (started_on, id), variations by
 * (variation_number, id), and gaps are emitted in that same traversal order.
 * No Date is constructed here; `generatedAt` is injected.
 */

// ── Input rows (exactly the columns the service selects) ────────────────────

export interface DelayEventRow {
  id: string;
  job_id: string;
  category: string;
  status: DelayEventStatus;
  started_on: string;
  ended_on: string | null;
  working_days_lost: number | null;
  description: string;
  diary_entry_id: string | null;
  variation_quote_id: string | null;
  weather_district: string | null;
  recorded_at: string | null;
  recorded_by: string | null;
  withdrawn_at: string | null;
  created_at: string;
}

/** The linked diary entry, as evidence: the contemporaneous page. */
export interface DiaryEvidenceRow {
  id: string;
  entry_date: string;
  weather: string | null;
  labour_count: number | null;
  work_summary: string | null;
  delays: string | null;
}

/** A variation (quotes row with variation_number) on this job. */
export interface VariationEvidenceRow {
  id: string;
  variation_number: number | null;
  title: string | null;
  status: string | null;
  accepted_at: string | null;
  eot_requested_completion_date: string | null;
  eot_agreed_completion_date: string | null;
  eot_agreed_at: string | null;
}

/**
 * Observed weather over one delay event's window, as EVIDENCE.
 *
 * A deterministic reduction of the readings the governed accessor returned for
 * the event's district and dates — never a forecast, never a claim. Every field
 * is `number | null`, and `null` means "no reading reported this metric", never
 * "zero" (the decision layer's own rule, kept here so a missing gust can never
 * read as calm). Present ONLY when real readings exist; absent otherwise.
 */
export interface EotWeatherEvidence {
  /** The postcode district the readings are for. */
  district: string;
  /** How many cached readings covered the window — 0 is never represented (the whole object is absent instead). */
  readingCount: number;
  /** Coldest air temperature observed in the window, °C. */
  minAirTempC: number | null;
  /** Strongest mean wind observed, m/s. */
  maxWindSpeedMs: number | null;
  /** Strongest gust observed, m/s — the number that stops a lift or strips a sheet. */
  maxWindGustMs: number | null;
  /** Peak precipitation intensity, mm/h. */
  maxPrecipRateMmH: number | null;
  /** Total precipitation accumulated across the window, mm. */
  totalPrecipMm: number | null;
}

// ── Output shapes ────────────────────────────────────────────────────────────

export type EotGapKind =
  | "no_diary_link"
  | "weather_evidence_dark"
  | "ongoing"
  | "days_unquantified"
  | "no_eot_variation"
  | "no_progress_series";

export interface EotGap {
  kind: EotGapKind;
  /** Null for job-level gaps. */
  eventId: string | null;
  /** Ready-to-render sentence. The kind is the machine key; this is the prose. */
  message: string;
}

export interface EotVariationSummary {
  id: string;
  variationNumber: number | null;
  title: string | null;
  status: string | null;
  accepted: boolean;
  requestedCompletionDate: string | null;
  agreedCompletionDate: string | null;
  agreedAt: string | null;
  /**
   * agreed − requested, in CALENDAR days (positive: more time agreed than
   * asked). Null unless BOTH dates exist. A date arithmetic fact about the
   * variation document itself — not a working-days figure and never summed
   * into one.
   */
  agreedVsRequestedDays: number | null;
  /** True when either EoT column is set — the variations the claim leans on. */
  carriesEot: boolean;
}

export interface EotPackEvent {
  id: string;
  category: DelayCategory;
  startedOn: string;
  endedOn: string | null;
  /** The HUMAN'S claim, passed through untouched. Null = not quantified. */
  workingDaysLost: number | null;
  description: string;
  weatherDistrict: string | null;
  recordedAt: string | null;
  /**
   * Inclusive CALENDAR span in days (1-day stoppage = 1). Null while ongoing.
   * Context for the reviewer; deliberately NOT working time.
   */
  calendarDaysSpanned: number | null;
  /** Resolved linked diary entry, when linked AND fetched. */
  diaryEntry: DiaryEvidenceRow | null;
  /** Resolved linked variation, when linked. */
  variation: EotVariationSummary | null;
  /**
   * Observed weather over this event's window, when the caller resolved real
   * readings for it. Null for every non-weather event, and null for a weather
   * event whenever the cache held no readings (the dark state today) — in which
   * case the `weather_evidence_dark` gap is emitted instead. Never fabricated.
   */
  weatherEvidence: EotWeatherEvidence | null;
}

export interface EotCategoryBlock {
  category: DelayCategory;
  label: string;
  events: EotPackEvent[];
  /** Sum of the events' CLAIMED working_days_lost (nulls excluded). */
  claimedWorkingDaysLost: number;
  /** How many events in this block have NOT quantified their claim. */
  unquantifiedEvents: number;
}

export interface EotEvidencePack {
  jobId: string;
  /** Injected by the caller; pure assembly stamps nothing itself. */
  generatedAt: string;
  /** Only categories with at least one RECORDED event, in canonical order. */
  categories: EotCategoryBlock[];
  recordedEventCount: number;
  /** Excluded from the pack, disclosed so the reviewer knows they exist. */
  draftEventCount: number;
  withdrawnEventCount: number;
  /** Sum of claimed working days across every recorded event. */
  totalClaimedWorkingDaysLost: number;
  /** Per-category claimed totals, zero-filled for absent categories. */
  claimedByCategory: Record<DelayCategory, number>;
  /** Every variation on the job, EoT-carrying first. */
  variations: EotVariationSummary[];
  /** The subset the claim actually leans on. */
  eotVariations: EotVariationSummary[];
  /** Progress context from lib/job-progress/series.ts, or null if that read failed. */
  progress: ProgressSummary | null;
  gaps: EotGap[];
  /**
   * The weather-data licence attribution (CC-BY for Open-Meteo) that MUST be
   * printed on this client-facing pack whenever it renders observed weather
   * evidence. Non-null IFF at least one event carries `weatherEvidence` — the
   * caller derives it from the active provider (server/services/eot-pack.ts),
   * so it is present exactly when there is weather data to attribute and null
   * on every dark build. The template renders nothing new when it is null.
   */
  weatherAttribution: string | null;
}

// ── Assembly ─────────────────────────────────────────────────────────────────

export interface EotPackInput {
  jobId: string;
  events: readonly DelayEventRow[];
  /** The linked diary entries (any superset is fine; looked up by id). */
  diaryEntries: readonly DiaryEvidenceRow[];
  /** Every variation on the job. */
  variations: readonly VariationEvidenceRow[];
  /** Composed progress summary; null when the progress read failed. */
  progress: ProgressSummary | null;
  /**
   * True IFF the caller resolved real observed readings for at least one weather
   * event's window (server/services/eot-pack.ts derives this from the governed
   * weather accessor). False in every environment today — the provider is dark
   * and the cache is empty — which keeps the pack byte-identical to before this
   * seam was wired.
   */
  weatherEvidenceAvailable: boolean;
  /**
   * Per-event observed-weather evidence, keyed by delay-event id. Supplied only
   * alongside `weatherEvidenceAvailable: true`; an event absent from the map (or
   * a dark build with no map at all) simply carries no evidence and, if it is a
   * weather event, keeps its dark gap. Never contains a fabricated reading.
   */
  weatherEvidenceByEvent?: ReadonlyMap<string, EotWeatherEvidence>;
  /**
   * The active provider's weather-data licence attribution, supplied alongside
   * real evidence so the pack can print it (CC-BY compliance). Optional and
   * defaulting to null: a dark build supplies no evidence and no attribution,
   * keeping the pack byte-identical to before this seam existed.
   */
  weatherAttribution?: string | null;
  /** ISO timestamp for the pack header — injected, never `new Date()` here. */
  generatedAt: string;
}

function toVariationSummary(v: VariationEvidenceRow): EotVariationSummary {
  const requested = v.eot_requested_completion_date;
  const agreed = v.eot_agreed_completion_date;
  return {
    id: v.id,
    variationNumber: v.variation_number,
    title: v.title,
    status: v.status,
    accepted: v.accepted_at !== null,
    requestedCompletionDate: requested,
    agreedCompletionDate: agreed,
    agreedAt: v.eot_agreed_at,
    agreedVsRequestedDays: requested && agreed ? daysBetween(requested, agreed) : null,
    carriesEot: requested !== null || agreed !== null,
  };
}

const byNumberThenId = (a: EotVariationSummary, b: EotVariationSummary): number => {
  const an = a.variationNumber ?? Number.MAX_SAFE_INTEGER;
  const bn = b.variationNumber ?? Number.MAX_SAFE_INTEGER;
  if (an !== bn) return an - bn;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** Assemble the pack. Pure; safe to call with any permutation of the inputs. */
export function assembleEotPack(input: EotPackInput): EotEvidencePack {
  const diaryById = new Map(input.diaryEntries.map((d) => [d.id, d]));
  const variationById = new Map(input.variations.map((v) => [v.id, toVariationSummary(v)]));

  const recorded = input.events
    .filter((e) => e.status === "recorded")
    .slice()
    .sort((a, b) =>
      a.started_on < b.started_on
        ? -1
        : a.started_on > b.started_on
          ? 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
    );
  const draftEventCount = input.events.filter((e) => e.status === "draft").length;
  const withdrawnEventCount = input.events.filter((e) => e.status === "withdrawn").length;

  const gaps: EotGap[] = [];
  const claimedByCategory = Object.fromEntries(
    DELAY_CATEGORIES.map((c) => [c, 0]),
  ) as Record<DelayCategory, number>;

  const packEvents = new Map<DelayCategory, EotPackEvent[]>();
  for (const e of recorded) {
    // The CHECK makes an unknown category unrepresentable; if one ever
    // arrived anyway it files under 'other' rather than silently vanishing
    // from the pack — dropping a recorded stoppage is the one failure an
    // evidence assembly must never have.
    const category: DelayCategory = (DELAY_CATEGORIES as readonly string[]).includes(e.category)
      ? (e.category as DelayCategory)
      : "other";

    const ended = e.ended_on;
    // Evidence attaches ONLY to weather events, ONLY when the caller declared it
    // available, and ONLY where a reading summary was supplied for this id. Every
    // other case is null — never a manufactured reading.
    const weatherEvidence: EotWeatherEvidence | null =
      category === "weather" && input.weatherEvidenceAvailable
        ? (input.weatherEvidenceByEvent?.get(e.id) ?? null)
        : null;
    const packEvent: EotPackEvent = {
      id: e.id,
      category,
      startedOn: e.started_on,
      endedOn: ended,
      workingDaysLost: e.working_days_lost,
      description: e.description,
      weatherDistrict: e.weather_district,
      recordedAt: e.recorded_at,
      calendarDaysSpanned: ended ? daysBetween(e.started_on, ended) + 1 : null,
      diaryEntry: e.diary_entry_id ? (diaryById.get(e.diary_entry_id) ?? null) : null,
      variation: e.variation_quote_id
        ? (variationById.get(e.variation_quote_id) ?? null)
        : null,
      weatherEvidence,
    };
    const list = packEvents.get(category) ?? [];
    list.push(packEvent);
    packEvents.set(category, list);

    if (e.working_days_lost !== null) {
      claimedByCategory[category] += e.working_days_lost;
    }

    // Per-event gaps, in a fixed order so the list is stable.
    if (packEvent.diaryEntry === null) {
      gaps.push({
        kind: "no_diary_link",
        eventId: e.id,
        message:
          "No site diary entry linked — the contemporaneous record that would prove this stoppage is missing.",
      });
    }
    if (category === "weather" && !input.weatherEvidenceAvailable) {
      gaps.push({
        kind: "weather_evidence_dark",
        eventId: e.id,
        message:
          "Weather evidence unavailable — no weather provider is connected, so no observed readings can corroborate this event yet.",
      });
    }
    if (ended === null) {
      gaps.push({
        kind: "ongoing",
        eventId: e.id,
        message: "Delay still ongoing — no end date recorded yet.",
      });
    }
    if (e.working_days_lost === null) {
      gaps.push({
        kind: "days_unquantified",
        eventId: e.id,
        message: "Working days lost not yet claimed for this event.",
      });
    }
  }

  const categories: EotCategoryBlock[] = DELAY_CATEGORIES.filter((c) =>
    packEvents.has(c),
  ).map((c) => {
    const events = packEvents.get(c)!;
    return {
      category: c,
      label: DELAY_CATEGORY_LABELS[c],
      events,
      claimedWorkingDaysLost: claimedByCategory[c],
      unquantifiedEvents: events.filter((e) => e.workingDaysLost === null).length,
    };
  });

  const allVariations = [...variationById.values()].sort(byNumberThenId);
  const eotVariations = allVariations.filter((v) => v.carriesEot);
  const variations = [...eotVariations, ...allVariations.filter((v) => !v.carriesEot)];

  // Job-level gaps, after the per-event ones.
  if (recorded.length > 0 && eotVariations.length === 0) {
    gaps.push({
      kind: "no_eot_variation",
      eventId: null,
      message:
        "No variation on this job carries an extension-of-time request — delays are recorded but no additional time has been formally asked for.",
    });
  }
  if (input.progress !== null && input.progress.points.length === 0) {
    gaps.push({
      kind: "no_progress_series",
      eventId: null,
      message:
        "No progress readings exist for this job, so the pack cannot show how the programme actually moved around these delays.",
    });
  }

  return {
    jobId: input.jobId,
    generatedAt: input.generatedAt,
    categories,
    recordedEventCount: recorded.length,
    draftEventCount,
    withdrawnEventCount,
    totalClaimedWorkingDaysLost: DELAY_CATEGORIES.reduce(
      (n, c) => n + claimedByCategory[c],
      0,
    ),
    claimedByCategory,
    variations,
    eotVariations,
    progress: input.progress,
    gaps,
    // Attribution rides on the pack ONLY when real evidence is actually rendered,
    // so the licence line prints exactly when there is weather data to license —
    // and never on the dark path, where no event carries evidence.
    weatherAttribution: categories.some((c) => c.events.some((e) => e.weatherEvidence !== null))
      ? (input.weatherAttribution ?? null)
      : null,
  };
}

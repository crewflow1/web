/**
 * Weather intelligence — UK construction work thresholds.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. No I/O, no `process.env`, no `server-only`, no network, no clock.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is the file where the domain knowledge lives, and it is the reason this
 * feature is worth building before a provider exists: the thresholds are the
 * hard part, and they are the part that stays true regardless of who supplies
 * the numbers.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PROVENANCE IS DATA, NOT A COMMENT
 * ───────────────────────────────────────────────────────────────────────────
 * Every threshold carries its own `source` and `sourceKind`. That is deliberate
 * and it is the most important design decision in this file. A safety-adjacent
 * number with no attribution is indistinguishable from one somebody invented,
 * and a UI that shows "too windy to lift" without being able to say WHY is
 * asking a site manager to take an unaccountable machine's word over their own
 * judgement. Because provenance is data:
 *
 *   - the reasoning surfaces can quote the source next to the verdict;
 *   - a test asserts that EVERY threshold declares a non-empty source;
 *   - the numbers that are OUR OWN DEFAULTS are visibly marked as such
 *     (`sourceKind: "configurable_default"`), so nobody mistakes one for a
 *     standard. There are eleven of them and they are listed in
 *     {@link UNSOURCED_THRESHOLD_COUNT}'s comment.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS LAYER IS NOT
 * ───────────────────────────────────────────────────────────────────────────
 * It is ADVISORY. It does not discharge anybody's legal duty, and it says so on
 * every surface that renders it. Three of the duties below are statutory
 * (WAHR 2005, LOLER 1998, CDM 2015) and every one of them requires a COMPETENT
 * PERSON to assess the actual conditions on the actual site. A forecast for a
 * postcode district is an input to that judgement, never a substitute for it.
 *
 * It also does NOT produce an extension-of-time claim. Recording what the
 * weather was and deciding whether work can proceed are different problems from
 * establishing contractual entitlement, and conflating them would be wrong in
 * both directions. (See the migration header on why these rows are a cache and
 * not evidence.)
 */

// ---------------------------------------------------------------------------
// Work types — the weather-governed activities of UK construction.
// ---------------------------------------------------------------------------

/**
 * The activities this layer can assess. Chosen because each has a DISTINCT
 * weather sensitivity with a defensible published basis — not to be
 * comprehensive. Notably absent: asphalt/surfacing, whose laying temperatures
 * are genuinely governed by the Specification for Highway Works and the
 * manufacturer's data sheet, neither of which this author can cite precisely
 * enough to encode. Guessing it would have added a seventh work type and a
 * fabricated number; omitting it leaves an honest gap.
 */
export const WORK_TYPES = [
  "concrete_pour",
  "crane_lift",
  "roofing",
  "working_at_height",
  "groundworks",
  "external_masonry",
  "external_coatings",
] as const;
export type WorkType = (typeof WORK_TYPES)[number];

/** Operator-facing labels. Kept beside the types so a rename cannot drift. */
export const WORK_TYPE_LABELS: Readonly<Record<WorkType, string>> = {
  concrete_pour: "Concrete pour",
  crane_lift: "Crane or lifting operation",
  roofing: "Roofing",
  working_at_height: "Working at height / scaffolding",
  groundworks: "Groundworks and excavation",
  external_masonry: "External masonry and bricklaying",
  external_coatings: "External painting and coatings",
} as const;

// ---------------------------------------------------------------------------
// Metrics — what a threshold is measured against.
// ---------------------------------------------------------------------------

/**
 * The reduced quantities a threshold compares against, each derived from a
 * WINDOW of readings by ./decision. Extremes rather than means throughout: a
 * pour is ruined by the coldest hour of the night, and a load is swung by the
 * strongest gust, not by the day's average.
 */
export const WEATHER_METRICS = [
  "minAirTempC",
  "maxAirTempC",
  "maxWindSpeedMs",
  "maxWindGustMs",
  "maxPrecipRateMmH",
  "totalPrecipMm",
  "maxPrecipProbPct",
  "minVisibilityM",
  "maxHumidityPct",
  "minDewPointMarginC",
  "antecedentPrecipMm",
] as const;
export type WeatherMetric = (typeof WEATHER_METRICS)[number];

/**
 * Where a number comes from. The distinction that matters is the last one:
 * everything except `configurable_default` can be looked up by a third party.
 *
 *   regulation          — a statutory duty (SI). Cite-able, and legally binding.
 *   standard            — a published BS/EN/ISO standard stating this figure.
 *   practice_guidance   — widely published industry guidance (HSE guidance
 *                         notes, trade-body codes, the Beaufort scale). Real and
 *                         citeable, but not a standard clause or a legal limit.
 *   configurable_default— OUR OWN NUMBER. No external source states it. Present
 *                         because the underlying hazard is real and a threshold
 *                         is needed to reason at all, but it must be treated as
 *                         a starting point for a competent person to set, and it
 *                         is surfaced as such.
 */
export const THRESHOLD_SOURCE_KINDS = [
  "regulation",
  "standard",
  "practice_guidance",
  "configurable_default",
] as const;
export type ThresholdSourceKind = (typeof THRESHOLD_SOURCE_KINDS)[number];

export type ThresholdSeverity = "caution" | "blocking";

export type Threshold = {
  /** Stable id — used in reasoning output and as a test anchor. */
  readonly id: string;
  readonly metric: WeatherMetric;
  /** `below` ⇒ breached when the metric falls under `value`; `above` ⇒ over it. */
  readonly comparator: "below" | "above";
  readonly value: number;
  readonly unit: string;
  readonly severity: ThresholdSeverity;
  /** What this rule says, in the words a site manager would use. */
  readonly rule: string;
  /** WHERE the number comes from. Never empty. */
  readonly source: string;
  readonly sourceKind: ThresholdSourceKind;
};

/**
 * True when a threshold's number comes from somewhere outside this codebase.
 * Derived from `sourceKind` rather than stored as a second field, so the two can
 * never disagree.
 */
export function isSourced(t: Threshold): boolean {
  return t.sourceKind !== "configurable_default";
}

// ---------------------------------------------------------------------------
// Shared source strings. Named constants so a citation is written ONCE and
// every threshold that rests on it stays consistent.
// ---------------------------------------------------------------------------

/**
 * Work at Height Regulations 2005, reg. 4(3): work at height is to be carried
 * out "only when weather conditions do not jeopardise the health or safety of
 * persons involved". This is the statutory duty that the wind and rain limits
 * for roofing and scaffolding discharge in practice — the regulation states the
 * DUTY without stating a number, which is exactly why the numbers below are
 * practice guidance rather than regulation.
 */
const WAHR_2005 = "Work at Height Regulations 2005, reg. 4(3) (weather conditions duty)";

/**
 * LOLER 1998 reg. 8 requires every lifting operation to be properly planned by
 * a competent person. BS 7121-1:2016 (Code of practice for safe use of cranes)
 * is the code that plan follows, and it requires the appointed person to obtain
 * and observe the CRANE MANUFACTURER'S maximum in-service wind speed, adjusted
 * for the sail area of the actual load. There is therefore NO single legal wind
 * limit for lifting, and any number presented as one is wrong.
 */
const LOLER_BS7121 =
  "LOLER 1998 reg. 8 + BS 7121-1:2016 — the crane manufacturer's maximum " +
  "in-service wind speed governs, reduced for the load's sail area";

/**
 * CDM 2015 reg. 22 (Excavations): all practicable steps must be taken to
 * prevent danger from collapse of an excavation. Again a duty with no number —
 * whether ground is too wet to dig safely depends on soil type and groundwater,
 * which no forecast reports.
 */
const CDM_2015_EXCAVATION =
  "CDM 2015 reg. 22 (excavations — practicable steps against collapse)";

/**
 * The Beaufort scale (WMO). Used as the anchor for the wind bands because it is
 * the vocabulary UK trade guidance is written in: force 6 "strong breeze" is
 * 10.8 to 13.8 m/s (25 to 31 mph), force 8 "gale" is 17.2 to 20.7 m/s (39 to 46 mph).
 */
const BEAUFORT = "Beaufort wind force scale (WMO)";

/**
 * MPA The Concrete Centre / Concrete Society guidance on concreting in cold
 * weather, as commonly published: do not place concrete when the air
 * temperature is at or below 3 °C and falling; placing may proceed when the air
 * temperature is 3 °C and rising; protect new concrete from frost until it
 * reaches about 5 N/mm² compressive strength.
 */
const CONCRETE_COLD_WEATHER =
  "MPA The Concrete Centre / Concrete Society guidance, concreting in cold " +
  "weather (do not place at or below 3 °C and falling)";

/**
 * BS 8500-2 / BS EN 206 specify a MINIMUM FRESH CONCRETE TEMPERATURE of 5 °C at
 * delivery. Note this is the temperature of the CONCRETE, not of the air — air
 * temperature is a proxy for it, which is why breaching it is a caution here
 * rather than a block: heated materials and protection are the normal remedy.
 */
const BS8500_FRESH_TEMP =
  "BS 8500-2 / BS EN 206 — minimum fresh concrete temperature 5 °C at delivery " +
  "(air temperature is a proxy; heating and protection are the remedy)";

/**
 * BS 8000-3 (workmanship on building sites — masonry) and BS EN 1996-2 (design
 * and execution of masonry): do not lay masonry when the air temperature is
 * below 3 °C unless materials are heated and the work is protected, do not
 * build on frozen work, and protect new work against frost.
 */
const BS8000_MASONRY =
  "BS 8000-3 / BS EN 1996-2 — do not lay masonry below 3 °C without heated " +
  "materials and protection; never build on frozen work";

/**
 * HSE HSG33 "Health and safety in roof work" identifies wind as a principal
 * roof-work hazard, particularly when handling sheet materials, which act as
 * sails. The National Federation of Roofing Contractors' guidance is commonly
 * stated as stopping work with sheet material around Beaufort force 6.
 */
const HSG33_ROOF_WIND =
  "HSE HSG33 (roof work) + NFRC guidance — sheet materials act as sails; work " +
  "with them commonly stops around Beaufort force 6";

/**
 * BS EN ISO 12944-7 (protective paint systems): coatings are not to be applied
 * when relative humidity exceeds 85%, nor when the substrate is less than 3 °C
 * above the dew point, because condensation on the substrate wrecks adhesion.
 */
const ISO12944_COATINGS =
  "BS EN ISO 12944-7 — do not apply coatings above 85% RH, nor within 3 °C of " +
  "the dew point";

// ---------------------------------------------------------------------------
// The thresholds.
// ---------------------------------------------------------------------------

/**
 * Per work type, the conditions that make work impossible (`blocking`) or
 * questionable (`caution`).
 *
 * READ THE `sourceKind` OF EACH ENTRY. Roughly half these numbers come from a
 * standard, a regulation or published trade guidance; the rest are this
 * codebase's own defaults for hazards that are real but that nobody has
 * published a number for. The second group is marked, counted and tested.
 */
export const WORK_TYPE_THRESHOLDS: Readonly<Record<WorkType, ReadonlyArray<Threshold>>> = {
  // ── CONCRETE ──────────────────────────────────────────────────────────────
  concrete_pour: [
    {
      // SOURCE: MPA/Concrete Society cold-weather guidance — 3 °C is the figure
      // UK practice states. Blocking: below it the concrete will not gain
      // strength predictably and is at risk of frost damage before it can
      // resist it.
      id: "concrete.air_temp_placing",
      metric: "minAirTempC",
      comparator: "below",
      value: 3,
      unit: "°C",
      severity: "blocking",
      rule: "Do not place concrete when the air temperature is at or below 3 °C and falling.",
      source: CONCRETE_COLD_WEATHER,
      sourceKind: "practice_guidance",
    },
    {
      // SOURCE: BS 8500-2 / BS EN 206 — 5 °C minimum FRESH CONCRETE temperature.
      // Caution not blocking: this is a property of the mix, remediable by
      // heated materials, and air temperature is only a proxy for it.
      id: "concrete.fresh_temp_proxy",
      metric: "minAirTempC",
      comparator: "below",
      value: 5,
      unit: "°C",
      severity: "caution",
      rule: "Below 5 °C, fresh concrete must be delivered at 5 °C or above — expect heated materials and protection.",
      source: BS8500_FRESH_TEMP,
      sourceKind: "standard",
    },
    {
      // SOURCE: the same cold-weather guidance — new concrete must be protected
      // from frost until it reaches roughly 5 N/mm². A sub-zero minimum anywhere
      // in the window means frost will reach the pour.
      //
      // NOTE ON A LIMIT OF THIS LAYER: what actually matters is whether the
      // GROUND, formwork and reinforcement are frozen, and BS EN 13670 forbids
      // placing against frozen surfaces. No forecast reports that. Air
      // temperature is a proxy and the reasoning output says so.
      id: "concrete.frost_before_strength",
      metric: "minAirTempC",
      comparator: "below",
      value: 0,
      unit: "°C",
      severity: "blocking",
      rule: "Frost is forecast. New concrete must be protected until it reaches about 5 N/mm², and must never be placed against frozen ground, formwork or reinforcement.",
      source: CONCRETE_COLD_WEATHER,
      sourceKind: "practice_guidance",
    },
    {
      // CONFIGURABLE DEFAULT. Hot-weather concreting is a real problem — rapid
      // slump loss, plastic shrinkage cracking — but the published limits are on
      // the FRESH CONCRETE temperature (specifications commonly cap it at
      // 30 to 35 °C), not on air temperature, and the relationship between the two
      // depends on the mix and the haul. 30 °C ambient is this codebase's own
      // trigger for "get advice", not a published figure.
      id: "concrete.hot_weather",
      metric: "maxAirTempC",
      comparator: "above",
      value: 30,
      unit: "°C",
      severity: "caution",
      rule: "Hot weather accelerates slump loss and risks plastic shrinkage cracking. Check the fresh concrete temperature limit in the specification.",
      source:
        "Configurable default — no published limit on AMBIENT temperature exists; " +
        "specifications cap FRESH CONCRETE temperature (commonly 30 to 35 °C) instead",
      sourceKind: "configurable_default",
    },
    {
      // CONFIGURABLE DEFAULT. Rain on a fresh slab damages the surface finish
      // and raises the surface water/cement ratio. Every practical source says
      // "protect against rain"; none states an intensity. 2 mm/h is our own
      // trigger for "you will need covers".
      id: "concrete.rain_during_pour",
      metric: "maxPrecipRateMmH",
      comparator: "above",
      value: 2,
      unit: "mm/h",
      severity: "blocking",
      rule: "Rain at this intensity will damage the surface finish and raise the surface water/cement ratio. Pour under cover or reschedule.",
      source:
        "Configurable default — guidance universally says protect fresh concrete " +
        "from rain, but states no intensity",
      sourceKind: "configurable_default",
    },
  ],

  // ── LIFTING ───────────────────────────────────────────────────────────────
  // THE MOST IMPORTANT CAVEAT IN THIS FILE. There is no legal wind limit for
  // lifting. BS 7121-1 requires the appointed person to obtain the crane
  // manufacturer's maximum in-service wind speed and to reduce it for the sail
  // area of the load. A large panel can halve it. Both numbers below are
  // therefore ADVISORY BANDS, and the blocking one is the point past which no
  // common crane is in service rather than a limit that applies to any
  // particular machine.
  crane_lift: [
    {
      // SOURCE: Beaufort force 8 ("gale", 17.2 to 20.7 m/s) is the band in which
      // tower cranes are commonly stated to come out of service, and 20 m/s is
      // the figure most often quoted as a tower crane's in-service ceiling.
      // Above it, effectively no crane is working. The MANUFACTURER'S figure
      // still governs and is frequently much lower.
      id: "lifting.wind_gust_ceiling",
      metric: "maxWindGustMs",
      comparator: "above",
      value: 20,
      unit: "m/s",
      severity: "blocking",
      rule: "Gusts at or above 20 m/s (about 45 mph, Beaufort 8) exceed the in-service wind speed commonly quoted for tower cranes. Check the crane's own limit — it may be far lower.",
      source: `${BEAUFORT}; ${LOLER_BS7121}`,
      sourceKind: "practice_guidance",
    },
    {
      // CONFIGURABLE DEFAULT. Mobile cranes on long booms, and any load with a
      // significant sail area, are routinely limited well below the tower-crane
      // figure — 9 to 12 m/s is the range commonly cited in lift plans. 9 m/s is
      // our own caution trigger, chosen at the bottom of that range because the
      // consequence of being wrong is a swinging load.
      id: "lifting.wind_gust_sail_area",
      metric: "maxWindGustMs",
      comparator: "above",
      value: 9,
      unit: "m/s",
      severity: "caution",
      rule: "Gusts above 9 m/s (about 20 mph) already restrict mobile cranes on long booms and any load with a large sail area. The lift plan's own limit governs.",
      source:
        "Configurable default at the bottom of the 9 to 12 m/s range commonly cited " +
        `in lift plans. ${LOLER_BS7121}`,
      sourceKind: "configurable_default",
    },
    {
      // CONFIGURABLE DEFAULT. BS 7121-1 does require that the load can be seen
      // or that effective communication exists, so the HAZARD is sourced — but
      // no visibility distance in metres is published. 200 m is our own trigger.
      id: "lifting.visibility",
      metric: "minVisibilityM",
      comparator: "below",
      value: 200,
      unit: "m",
      severity: "caution",
      rule: "Poor visibility. BS 7121 requires the operator to see the load or to have effective communication with a slinger throughout.",
      source:
        "Configurable default — BS 7121-1 requires visibility of the load or " +
        "effective communication, but states no distance",
      sourceKind: "configurable_default",
    },
  ],

  // ── ROOFING ───────────────────────────────────────────────────────────────
  roofing: [
    {
      // SOURCE: HSG33 + NFRC — sheet material acts as a sail; force 6
      // (10.8 to 13.8 m/s) is the commonly stated stopping point. 11 m/s is the
      // bottom of force 6.
      id: "roofing.wind_sheet_handling",
      metric: "maxWindGustMs",
      comparator: "above",
      value: 11,
      unit: "m/s",
      severity: "blocking",
      rule: "Gusts at Beaufort 6 or above (11 m/s, about 25 mph) make sheet materials unmanageable at height.",
      source: `${HSG33_ROOF_WIND}; ${WAHR_2005}`,
      sourceKind: "practice_guidance",
    },
    {
      // CONFIGURABLE DEFAULT. Force 5 (8.0 to 10.7 m/s) as an early warning band.
      // Our own banding, not a published stopping point.
      id: "roofing.wind_caution",
      metric: "maxWindGustMs",
      comparator: "above",
      value: 8,
      unit: "m/s",
      severity: "caution",
      rule: "Gusts at Beaufort 5 (8 m/s, about 18 mph). Handling large sheets is getting difficult — review before starting.",
      source: `Configurable default — early-warning band one Beaufort force below the stopping point. ${BEAUFORT}`,
      sourceKind: "configurable_default",
    },
    {
      // CONFIGURABLE DEFAULT for the NUMBER; the duty is regulation. A wet roof
      // is a slip hazard and WAHR reg. 4(3) forbids working at height when the
      // weather jeopardises safety. No source states an intensity, so this is
      // set at "measurable rain" — 0.2 mm/h — because a pitched roof does not
      // need much water to become dangerous.
      id: "roofing.wet_surface",
      metric: "maxPrecipRateMmH",
      comparator: "above",
      value: 0.2,
      unit: "mm/h",
      severity: "blocking",
      rule: "Rain makes a pitched roof a slip hazard. Work at height must not proceed when the weather jeopardises safety.",
      source: `Configurable default set at measurable rain. Duty: ${WAHR_2005}`,
      sourceKind: "configurable_default",
    },
  ],

  // ── WORKING AT HEIGHT / SCAFFOLDING ───────────────────────────────────────
  working_at_height: [
    {
      // SOURCE: Beaufort force 7 (13.9 to 17.1 m/s) — scaffolding erection and
      // dismantling is commonly suspended in this band (NASC SG4/TG20 practice),
      // and WAHR reg. 4(3) is the duty. 14 m/s is the bottom of force 7.
      id: "height.wind_blocking",
      metric: "maxWindGustMs",
      comparator: "above",
      value: 14,
      unit: "m/s",
      severity: "blocking",
      rule: "Gusts at Beaufort 7 or above (14 m/s, about 31 mph). Scaffold erection and dismantling and general work at height should stop.",
      source: `${BEAUFORT}; NASC SG4/TG20 practice; duty: ${WAHR_2005}`,
      sourceKind: "practice_guidance",
    },
    {
      // CONFIGURABLE DEFAULT. Force 6 as the review band for general work at
      // height (as opposed to sheet handling, which stops there).
      id: "height.wind_caution",
      metric: "maxWindGustMs",
      comparator: "above",
      value: 11,
      unit: "m/s",
      severity: "caution",
      rule: "Gusts at Beaufort 6 (11 m/s, about 25 mph). Review the work at height — anything with a large surface area should stop.",
      source: `Configurable default — force 6 review band. ${BEAUFORT}; duty: ${WAHR_2005}`,
      sourceKind: "configurable_default",
    },
    {
      // CONFIGURABLE DEFAULT for the number; duty is WAHR. Icy staging and
      // ladders. Sub-zero is a defensible trigger but the number is ours.
      id: "height.ice_risk",
      metric: "minAirTempC",
      comparator: "below",
      value: 0,
      unit: "°C",
      severity: "caution",
      rule: "Sub-zero temperatures. Check staging, ladders and walkways for ice before working at height.",
      source: `Configurable default at freezing point. Duty: ${WAHR_2005}`,
      sourceKind: "configurable_default",
    },
  ],

  // ── GROUNDWORKS ───────────────────────────────────────────────────────────
  // HONESTY NOTE: there is NO published threshold for "too wet to dig", and
  // this layer's groundworks rules are consequently the weakest in the file.
  // Excavation stability depends on soil type, groundwater and support — none of
  // which a forecast reports. Both antecedent-rainfall numbers below are OUR
  // OWN and are flagged accordingly. The duty they serve (CDM 2015 reg. 22) is
  // real; the trip points are a starting point for a competent person.
  groundworks: [
    {
      // CONFIGURABLE DEFAULT — entirely ours.
      id: "groundworks.saturation_blocking",
      metric: "antecedentPrecipMm",
      comparator: "above",
      value: 50,
      unit: "mm",
      severity: "blocking",
      rule: "Heavy antecedent rainfall. Expect saturated ground, standing water in excavations and a materially higher collapse risk — have the excavation re-assessed before entry.",
      source: `Configurable default — no published threshold exists for ground saturation. Duty: ${CDM_2015_EXCAVATION}`,
      sourceKind: "configurable_default",
    },
    {
      // CONFIGURABLE DEFAULT — entirely ours.
      id: "groundworks.saturation_caution",
      metric: "antecedentPrecipMm",
      comparator: "above",
      value: 25,
      unit: "mm",
      severity: "caution",
      rule: "Significant antecedent rainfall. Ground will be soft — check excavation support, plant access and spoil handling.",
      source: `Configurable default — no published threshold exists for ground saturation. Duty: ${CDM_2015_EXCAVATION}`,
      sourceKind: "configurable_default",
    },
    {
      // CONFIGURABLE DEFAULT. Rain during the dig compounds it.
      id: "groundworks.rain_during_work",
      metric: "maxPrecipRateMmH",
      comparator: "above",
      value: 4,
      unit: "mm/h",
      severity: "caution",
      rule: "Heavy rain during excavation. Water ingress destabilises trench sides and batters.",
      source: `Configurable default. Duty: ${CDM_2015_EXCAVATION}`,
      sourceKind: "configurable_default",
    },
    {
      // CONFIGURABLE DEFAULT. Frozen ground is a productivity and plant problem
      // rather than primarily a safety one.
      id: "groundworks.frozen_ground",
      metric: "minAirTempC",
      comparator: "below",
      value: -2,
      unit: "°C",
      severity: "caution",
      rule: "Hard frost. Frozen ground slows excavation and can damage plant; trench support behaviour changes as it thaws.",
      source: "Configurable default — no published threshold",
      sourceKind: "configurable_default",
    },
  ],

  // ── MASONRY ───────────────────────────────────────────────────────────────
  external_masonry: [
    {
      // SOURCE: BS 8000-3 / BS EN 1996-2 — 3 °C is the standard's own figure.
      // One of the best-sourced numbers in this file.
      id: "masonry.air_temp",
      metric: "minAirTempC",
      comparator: "below",
      value: 3,
      unit: "°C",
      severity: "blocking",
      rule: "Do not lay masonry below 3 °C without heated materials and protection, and never on frozen work.",
      source: BS8000_MASONRY,
      sourceKind: "standard",
    },
    {
      // SOURCE: the same standards require new work to be protected against
      // frost. Sub-zero in the window means it will be needed.
      id: "masonry.frost_protection",
      metric: "minAirTempC",
      comparator: "below",
      value: 0,
      unit: "°C",
      severity: "blocking",
      rule: "Frost is forecast. New masonry must be protected — frozen mortar loses strength permanently.",
      source: BS8000_MASONRY,
      sourceKind: "standard",
    },
    {
      // CONFIGURABLE DEFAULT. Heavy rain washes mortar out of unprotected new
      // work; the hazard is universally described, the intensity is not.
      id: "masonry.rain",
      metric: "maxPrecipRateMmH",
      comparator: "above",
      value: 2,
      unit: "mm/h",
      severity: "caution",
      rule: "Rain washes mortar out of new work and saturates the wall. Cover new work at the end of each lift.",
      source: "Configurable default — guidance says protect new masonry from rain but states no intensity",
      sourceKind: "configurable_default",
    },
  ],

  // ── EXTERNAL COATINGS ─────────────────────────────────────────────────────
  external_coatings: [
    {
      // SOURCE: BS EN ISO 12944-7 — 85% RH is the standard's own limit.
      id: "coatings.humidity",
      metric: "maxHumidityPct",
      comparator: "above",
      value: 85,
      unit: "%",
      severity: "blocking",
      rule: "Do not apply coatings above 85% relative humidity.",
      source: ISO12944_COATINGS,
      sourceKind: "standard",
    },
    {
      // SOURCE: BS EN ISO 12944-7 — the substrate must be at least 3 °C above
      // the dew point. Computed from air temperature and humidity by the
      // decision layer (Magnus–Tetens), with the honest caveat that AIR
      // temperature is a proxy for SUBSTRATE temperature.
      id: "coatings.dew_point_margin",
      metric: "minDewPointMarginC",
      comparator: "below",
      value: 3,
      unit: "°C",
      severity: "blocking",
      rule: "The surface is within 3 °C of the dew point. Condensation will form and the coating will not adhere.",
      source: ISO12944_COATINGS,
      sourceKind: "standard",
    },
    {
      // CONFIGURABLE DEFAULT. 5 °C is the near-universal minimum on UK exterior
      // paint data sheets, but it is the MANUFACTURER'S figure, not a standard's,
      // and it varies by product.
      id: "coatings.min_air_temp",
      metric: "minAirTempC",
      comparator: "below",
      value: 5,
      unit: "°C",
      severity: "blocking",
      rule: "Most exterior coatings require 5 °C and rising. Check the product data sheet — this figure is set by the manufacturer, not by a standard.",
      source:
        "Configurable default — 5 °C is the common minimum on UK exterior paint " +
        "data sheets; the manufacturer's figure governs",
      sourceKind: "configurable_default",
    },
    {
      // CONFIGURABLE DEFAULT for the number. Rain on wet paint is obviously
      // ruinous; no source states an intensity.
      id: "coatings.rain",
      metric: "maxPrecipRateMmH",
      comparator: "above",
      value: 0.2,
      unit: "mm/h",
      severity: "blocking",
      rule: "Rain will wash off or bloom an uncured coating.",
      source: "Configurable default set at measurable rain",
      sourceKind: "configurable_default",
    },
  ],
} as const;

/** Every threshold across every work type, flattened. */
export const ALL_THRESHOLDS: ReadonlyArray<Threshold> = WORK_TYPES.flatMap(
  (w) => WORK_TYPE_THRESHOLDS[w],
);

/**
 * How many thresholds are this codebase's OWN numbers rather than a cited
 * source's. Asserted by the test suite so the count cannot creep up unnoticed:
 * adding an unsourced number is allowed, but doing it silently is not.
 *
 * As it stands: 25 thresholds, of which 10 rest on a regulation, a standard or
 * published trade guidance, and 15 are our own defaults —
 *
 *   concrete_pour      hot_weather, rain_during_pour
 *   crane_lift         wind_gust_sail_area, visibility
 *   roofing            wind_caution, wet_surface
 *   working_at_height  wind_caution, ice_risk
 *   groundworks        saturation_blocking, saturation_caution,
 *                      rain_during_work, frozen_ground   ← ALL FOUR
 *   external_masonry   rain
 *   external_coatings  min_air_temp, rain
 *
 * The reason to count them is the groundworks row: that work type is ENTIRELY
 * unsourced, which {@link FULLY_UNSOURCED_WORK_TYPES} exposes so no surface can
 * present it with the same confidence as the masonry or coatings rules.
 */
export const UNSOURCED_THRESHOLD_COUNT = ALL_THRESHOLDS.filter((t) => !isSourced(t)).length;

/** The work types whose every threshold is an unsourced default. Currently: groundworks. */
export const FULLY_UNSOURCED_WORK_TYPES: ReadonlyArray<WorkType> = WORK_TYPES.filter((w) =>
  WORK_TYPE_THRESHOLDS[w].every((t) => !isSourced(t)),
);

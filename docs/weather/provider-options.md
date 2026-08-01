# Weather provider options — the activation decision

**Status: NO PROVIDER IS BOUND. Nothing here has been signed up for, no key exists,
and no recommendation is made.** This document exists so the choice can be made on
evidence rather than on whichever API a developer happened to reach for.

The engineering is complete and dark: the thresholds, the decision layer, the cache
and the trust boundary all ship in migration `20261074000000` and `lib/weather/`.
What remains is a commercial decision with a licence and a bill attached, plus one
piece of data-ingest work that is easy to miss (see
[The hidden prerequisite](#the-hidden-prerequisite-district--coordinate)).

Prices were read from vendor pricing pages in July 2026 and exclude VAT unless
stated. **Verify before committing** — they move.

---

## The candidates

### 1. Met Office Weather DataHub — Site Specific (Global Spot)

| | |
|---|---|
| **API key** | Required (DataHub subscription key) |
| **Free tier** | 360 calls/day, £0 |
| **Paid tiers** | 900/day £9 · 3,600/day £32 · 18,000/day £146 · 36,000/day £250 · 72,000/day £437 — per month, ex VAT |
| **Enterprise** | Custom |
| **Limit style** | Hard daily call cap, resets 00:00 UTC |
| **Licence** | Met Office Weather DataHub Terms & Conditions. Specific redistribution terms are **not** published on the pricing page — `licensing@metoffice.gov.uk` |
| **Billing** | GBP, UK entity |

**Why it is the strongest candidate on credibility.** The Met Office is the UK's
national meteorological service. Its forecasts are the reference a contract
administrator, an insurer or an adjudicator recognises, and its UKV model (~1.5 km
grid) is the highest-resolution operational model over the UK. If weather data is
ever going to be quoted in a commercial conversation, this is the source that does
not need defending.

**What to check before committing.** The T&Cs are not on the pricing page. The
question that matters is whether the licence permits **showing the data to a
builder's own customers** (e.g. on a customer portal), as distinct from internal
operational use. Get that in writing from the licensing team — it is the difference
between an internal tool and a customer-facing feature.

**Note.** The old free DataPoint API was retired in 2025; DataHub is its successor.
Any tutorial referencing DataPoint is out of date.

---

### 2. Open-Meteo

| | |
|---|---|
| **API key** | None on the open-access tier; **required** on all commercial tiers |
| **Free tier** | 10,000 calls/day, 300,000/month — **NON-COMMERCIAL USE ONLY** |
| **Paid tiers** | Standard 1M calls/month ≈ €29/mo · Professional 5M/month · Enterprise 50M+/month |
| **Limit style** | Monthly call budget, not per-request billing |
| **Licence** | **CC-BY 4.0** — attribution required: credit, a link to the licence, and an indication if changes were made |
| **Billing** | EUR |

**⚠️ THE LICENCE TRAP, and the single most important line in this document.** The
keyless tier that makes Open-Meteo so easy to prototype with is licensed for
**non-commercial use only**. CrewFlow is a commercial product. Using the free tier
in production would be a licence breach, and it is a breach that would be trivially
easy to commit by accident because *it works without a key* — there is no
credential whose absence would stop it.

`lib/weather/readiness.ts` therefore maps `open-meteo` to a required
`OPEN_METEO_API_KEY` even though the free tier needs none, so that "no key" reads as
"not activated" rather than "quietly running on the wrong licence". That mapping is
deliberate and should not be relaxed.

**Why it is the strongest candidate on cost at scale.** €29/month for 1M calls is
roughly 1/5 the price of the Met Office tier of comparable volume, and monthly
budgeting is more forgiving than a hard daily cap. It aggregates national met
services (including UK models), so the underlying data is not materially worse for
this use case.

**What to weigh against that.** It is a small operation compared to a national met
service. For a paid product whose users make safety-adjacent decisions, business
continuity is a real consideration, and CC-BY attribution must appear on every
surface that renders the data.

---

### 3. Visual Crossing

| | |
|---|---|
| **API key** | Required |
| **Free tier** | 1,000 records/day — **commercial use permitted** |
| **Beyond that** | Pay-as-you-go, ~$0.0001 per record |
| **Licence** | Vendor terms; commercial use included in the free tier |
| **Billing** | USD |

The only candidate with a free tier that *permits commercial use*, which makes it
the cheapest honest way to run a pilot. Per-record PAYG is very cheap.

---

### 4. OpenWeather (One Call API 3.0)

| | |
|---|---|
| **API key** | Required |
| **Free tier** | 1,000 calls/day |
| **Beyond that** | ~£0.0012 per call |
| **Billing** | GBP available |

Included for completeness. Roughly 12× Visual Crossing's per-unit overage cost.

---

## ⚠️ PAYG vs capped — an architectural consequence, not just a price difference

This distinction affects the code, so it is worth stating plainly:

- **Met Office and Open-Meteo sell a CAP.** Exceeding it fails closed — requests are
  refused. Over-watching districts degrades the feature; it does not generate a bill.
- **Visual Crossing and OpenWeather sell PAYG.** Exceeding the free allowance bills
  automatically. Over-watching districts costs real money with no ceiling.

`weather_watches` currently has **no per-org cap** on how many districts an org may
watch. On a capped provider that is acceptable. **On a PAYG provider it is not** — a
watch ceiling (or a global daily call budget in the spirit of the AI governor's
£100/month reservation) becomes a prerequisite rather than a nice-to-have.

So the provider choice determines whether an extra piece of engineering is required
before activation. That is the CEO decision this document most needs to surface.

---

## ~~The hidden prerequisite~~ district → coordinate — **CLOSED**

**Every candidate above is queried by latitude and longitude — and the build can now
produce one.** `districtResolutionAvailable` is `true`, and it is *derived* from the
shipped dataset's size (floor: 2,500 districts) rather than hard-coded, so a
truncated or deleted dataset flips it back to `false` by itself.

What shipped (Train 3, `feat/weather-district-coordinates`):

- **Dataset** — `lib/weather/geo/district-centroids.ts`: 2,943 UK postcode-district
  (outward code) centroids, WGS84 at 5 dp, **including Northern Ireland** (80+ BT
  districts). Derived from the **ONS Postcode Directory (May 2026)** downloaded from
  the ONS Open Geography Portal (portal item `6fff67d204fd4f339591ed667a6e3642`,
  `ONSPD_MAY_2026.zip`): live postcodes only (`doterm` empty), grouped by outward
  code, unweighted mean of each unit's ONSPD `lat`/`long`. 2,726,476 rows read;
  1,796,277 live coordinated units contributed. Rows carrying the ONSPD
  no-grid-reference sentinel (lat 99.999999 — Channel Islands, Isle of Man, GIR)
  are excluded, so GY/JE/IM districts deliberately do **not** resolve.
- **Derivation script** — `scripts/derive-district-centroids.ts`, checked in and
  runnable offline against a downloaded ONSPD release. It never runs at runtime and
  performs no network I/O; regeneration on a new ONSPD release is one command plus a
  reviewed diff (the dataset-integrity tests are the gate).
- **Resolution** — `resolveDistrictCoordinates(district)` in `lib/weather/geo`:
  pure, O(1) in-memory lookup, no geocoding service, no per-request cost, and
  **null for anything unknown** — callers surface "cannot resolve", they never
  guess a neighbouring district. `datasetInfo()` exposes source, version, count and
  the licence attribution for any displaying surface.
- **Provider seam plumbing** — `WeatherProvider.fetchWindow` now takes the resolved
  `coordinates`, and the future writer records them into
  `weather_readings.resolved_lat` / `resolved_lon`, so what was asked and what was
  stored cannot drift. (Nothing writes `weather_readings` yet; that is unchanged.)

**Licence** — Open Government Licence v3.0. Required attribution (carried by
`datasetInfo()` and rendered on the readiness panel):
`Contains OS data © Crown copyright and database right 2026` ·
`Contains Royal Mail data © Royal Mail copyright and database right 2026` ·
`Contains GeoPlace data © Local Government Information House Limited copyright and
database right 2026` · `Source: Office for National Statistics licensed under the
Open Government Licence v.3.0`.

> **NI licensing caveat, flagged for legal review:** Northern Ireland postcodes
> inside the ONSPD carry additional Ordnance Survey of Northern Ireland / LPS terms
> (see the ONSPD User Guide). The shipped BT rows are heavily aggregated district
> centroids used for in-product display; confirm the licence position before any
> surface *redistributes* BT-derived coordinates.

**Accuracy caveat (the IV27 case).** A district centroid is not a site coordinate:
fine in LS1, potentially tens of kilometres out in IV27 (Sutherland). The seam
carries `WeatherWindow.resolvedDistanceKm` so the verdict layer can show the
caveat rather than hide it. (OS Code-Point Open was the fallback source — GB-only,
OSGB36, would have needed a documented Helmert transform to WGS84 and would have
lost NI. Not used.)

---

## Call-volume arithmetic

Sizing depends on **distinct districts under watch across the whole platform**, not
on tenants × jobs — because `weather_readings` is a *global* cache, so two builders
working in Leeds share one call. (This is the economic payoff of the district key;
see the migration header.)

At **4 refreshes per day** per watched district:

| Distinct districts watched | Calls/day | Cheapest Met Office tier | Open-Meteo |
|---|---|---|---|
| 90 | 360 | **Free** — exactly at the 360/day cap, no headroom | Free tier is non-commercial — N/A |
| 300 | 1,200 | Standard 2 (3,600/day) — £32/mo | Standard — ~€29/mo |
| 900 | 3,600 | Standard 2 — at the cap; size up to Standard 3 | Standard — ~€29/mo |
| 2,900 (every UK district) | 11,600 | Standard 3 (18,000/day) — £146/mo | Standard — ~€29/mo |

Rows sitting *exactly* at a cap need the next tier in practice: a retry, a backfill or
a single extra district tips them over, and the Met Office cap is a hard daily refusal.

Two things follow:

1. **A pilot fits the Met Office free tier.** ~90 districts is a real amount of
   coverage for early tenants, at £0.
2. **National coverage is cheap either way.** Even watching *every postcode district
   in the United Kingdom* costs £146/month on the Met Office and stays inside a
   single €29 Open-Meteo plan. This feature does not have a scaling cost problem.

Refresh frequency is the lever that moves these numbers, and it is a product
decision: hourly refresh (24/day) multiplies every row by six.

---

## What is NOT decided here

- **Which provider.** Not chosen. Nothing signed up for.
- **Whether the licence permits customer-facing display.** Needs a written answer
  from the Met Office licensing team if that provider is chosen.
- **Refresh frequency**, and therefore the tier.
- **Observation retention.** `purge_weather_readings` defaults to 24 months, which
  outlives a typical 12-month JCT/NEC defects period. Contractual limitation in
  England & Wales runs to **six years**, which is a materially more expensive answer.
  This is a legal/product call.
- **Whether a watch ceiling is required.** Depends entirely on capped vs PAYG above.

## What activation requires, in order

1. Choose a provider; confirm its licence covers the intended display surface.
2. Obtain the key; set `WEATHER_PROVIDER` and the vendor's credential.
3. ~~Ingest district centroids~~ **DONE** — shipped in `lib/weather/geo`;
   `districtResolutionAvailable` is now derived from the dataset (see above).
4. Write `lib/weather/providers/<vendor>.ts` implementing `WeatherProvider`
   (its `fetchWindow` already receives the resolved coordinates).
5. Flip that vendor's entry in `PROVIDER_IMPLEMENTED` — **this trips the security
   suite deliberately**, so activation is a reviewed diff, never a config change.
6. Add the writer (service-role only — the cache has no INSERT policy) and a
   scheduled refresh over `weather_watches`; it must write the resolved
   coordinates into `resolved_lat` / `resolved_lon`.
7. Render the vendor's required attribution wherever data appears (the ONSPD
   attribution is already rendered by the readiness panel).
8. If PAYG: add the watch ceiling *first*.

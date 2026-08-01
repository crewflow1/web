# Weather provider options — the activation decision

**Status: NO PROVIDER IS BOUND. Nothing here has been signed up for, no key exists,
and no recommendation is made.** This document exists so the choice can be made on
evidence rather than on whichever API a developer happened to reach for.

The engineering is now complete and dark **end to end**: the thresholds, the
decision layer, the cache and the trust boundary ship in migration
`20261074000000` and `lib/weather/`; district→coordinate resolution shipped in
Train 3; and **Train 7 shipped the Open-Meteo adapter, the fetch/cache pipeline
and the (unscheduled) cron seam** — see
[What shipped in Train 7](#what-shipped-in-train-7--adapter--pipeline-built-dark).
What remains is EXACTLY the commercial decision with a licence and a bill
attached, plus the credential and one `vercel.json` line it unlocks.

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

## What shipped in Train 7 — adapter + pipeline, BUILT-DARK

Everything below exists in the build, is CI-tested against checked-in fixtures
with **zero network egress**, and does nothing in any environment because no
credential exists anywhere. The security suite's transport allowlist pins the
adapter as the only file permitted to contain a transport primitive.

- **Adapter** — `lib/weather/providers/open-meteo.ts`: implements
  `WeatherProvider` for BOTH kinds (forecast via the forecast API, observation
  via the historical/archive API), platform `fetch` only, SI units demanded
  explicitly (`wind_speed_unit=ms`), UTC, throws typed
  `WeatherProviderError`s (retryable 429/5xx/network vs deterministic 4xx /
  malformed). **It speaks ONLY to the commercial `customer-` hosts** — the
  keyless free endpoints do not appear in the source, so the non-commercial
  licence cannot be breached by accident; the suite pins their absence. The
  key is injected by the factory; the adapter reads no environment.
- **Factory arm** — `getWeatherProvider()` returns the adapter only when
  `WEATHER_PROVIDER="open-meteo"` AND `OPEN_METEO_API_KEY` is set AND district
  resolution is available. `PROVIDER_IMPLEMENTED["open-meteo"]` is now `true`
  (the deliberate, test-tripping flip); `metoffice` remains `false`.
- **Fetch pipeline** — `server/services/weather-fetch.ts` (service-role, the
  cache has no INSERT policy): distinct districts under active watch →
  freshness skip (forecast 6 h, observation 24 h) → resolve (unresolvable ⇒
  recorded outcome, never guessed) → fetch (retry ≤3 with jittered backoff;
  breaker trips after 3 consecutive failures) → upsert on
  `(provider, postcode_district, kind, valid_at)` with `resolved_lat/lon`
  provenance and per-kind `expires_at` (forecast = fetched+6 h; observation
  NULL). Windows: forecast +48 h; observation −72 h (antecedent rainfall).
  Bounded at 200 districts/run.
- **Cron seam** — `app/api/cron/weather-fetch/route.ts`: Bearer-gated,
  dark ⇒ 204 no-op with zero DB access, **deliberately NOT in `vercel.json`**
  — scheduling it is an activation step, and the suite pins its absence.
- **Kill switch** — no new flag system: `WEATHER_PROVIDER` unset/`none`/`off`/
  `disabled` ⇒ null regardless of any key, and removing the credential kills
  it equally; every gate is conjunctive.
- **Known follow-up (activation-time)** — the archive lags ~5 days, so recent
  antecedent-rainfall observations may come back empty; if that matters in
  practice, source recent hours from the forecast endpoint's `past_days`
  parameter (a product decision, not taken here).

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

*(Updated after Train 7: the engineering items are DONE-dark for Open-Meteo.
If the commercial decision lands on Open-Meteo, activation is steps 1, 2, 6
and 7 only. Choosing any other vendor reopens steps 4–5 for that vendor.)*

1. **Choose a provider; confirm its licence covers the intended display
   surface.** ← the open decision. Nothing signed up for.
2. **Obtain the key; set `WEATHER_PROVIDER` and the vendor's credential.** ←
   pending the decision. For Open-Meteo this must be a COMMERCIAL subscription
   key — the adapter refuses to exist without one and carries no free-tier
   endpoint (see the licence trap above).
3. ~~Ingest district centroids~~ **DONE** (Train 3) — shipped in
   `lib/weather/geo`; `districtResolutionAvailable` is derived from the dataset.
4. ~~Write `lib/weather/providers/<vendor>.ts`~~ **DONE for Open-Meteo**
   (Train 7) — both kinds, fixture-tested, zero-egress in CI. A Met Office
   choice would need its own adapter here plus the transport-roster entry.
5. ~~Flip that vendor's entry in `PROVIDER_IMPLEMENTED`~~ **DONE for
   Open-Meteo** (Train 7) — the flip tripped the security suite exactly as
   designed and the pins were updated to the new truth in the same reviewed
   diff. `metoffice` remains false.
6. ~~Add the writer~~ **DONE** (Train 7) — `server/services/weather-fetch.ts`
   writes `resolved_lat`/`resolved_lon` on every row. **Remaining half:
   SCHEDULE it** — add `/api/cron/weather-fetch` to `vercel.json` (the
   security suite pins its absence today; update that pin in the activation
   diff). Suggested cadence: every 3–6 h, matching the 6 h forecast freshness
   horizon priced in the arithmetic above.
7. **Render the vendor's required attribution wherever weather data appears**
   (CC-BY 4.0 for Open-Meteo — the string ships on `provider.info.attribution`;
   the ONSPD attribution is already rendered by the readiness panel). ← remains,
   because no surface renders vendor data yet (there is none to render).
8. If PAYG: add the watch ceiling *first*. (Open-Meteo is capped, not PAYG, so
   this is moot unless the decision changes vendor class. The pipeline also
   self-bounds at 200 districts/run.)

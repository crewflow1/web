-- Weather intelligence — the substrate. BUILT DARK.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY WEATHER IS A FIRST-CLASS DOMAIN AND NOT A WIDGET
-- ═══════════════════════════════════════════════════════════════════════════
-- UK construction is weather-governed. Concrete pours, roofing, groundworks,
-- craneage and every external trade stop on rain, wind or frost, and weather is
-- the single most common contractual ground for an extension of time. CrewFlow
-- currently has ZERO weather awareness: nothing in this schema knows that it
-- froze last night.
--
-- This migration lands the SUBSTRATE only. No provider is bound, no credential
-- is introduced, no row can be written on a fresh production database, and
-- nothing in the build can reach the network. Like `ai_invocations` (20261062)
-- and `ai_quote_drafts` (20261068) before it, the storage and its trust
-- boundary arrive BEFORE the capability that fills them — because a control
-- retrofitted around a system that has already learned to spend is not a
-- control. On production this table is EMPTY, and that is the expected state.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE KEY DECISION: POSTCODE DISTRICT, AND THE CACHE IS **GLOBAL**
-- ═══════════════════════════════════════════════════════════════════════════
-- Four candidate keys were considered. This is the reasoning, not the taste.
--
--   1. `sites.id` (20261061). REJECTED, and this is the important one.
--      `sites` is the company's OWN estate — depots, yards, warehouses,
--      lock-ups — and its header states in terms that it deliberately EXCLUDES
--      'job_site' because a job site belongs to the CUSTOMER. Weather stops a
--      concrete pour at the customer's job site, not at the yard the mixer left
--      from. Keying the cache on `sites` would put the forecast in precisely
--      the wrong place, and would have quietly re-litigated a boundary that
--      migration argued carefully.
--
--   2. Latitude/longitude. REJECTED as FICTIONAL. There is no latitude or
--      longitude anywhere in this schema (verified: no column, no PostGIS, no
--      geocoder in the build). Job locations exist only as free text —
--      `jobs.site_address_*` (20260601) resolved through
--      `resolveJobAddress()` in lib/address.ts. A key I cannot compute without
--      adding a SECOND external dependency (a geocoder) is not a key, it is a
--      promissory note. The coordinate is instead recorded as PROVENANCE
--      (`resolved_lat`/`resolved_lon` below) once a provider is bound and has
--      told us where it actually answered for.
--
--   3. Full unit postcode ("LS1 4AP"). REJECTED on all three axes.
--      - CORRECTNESS: it buys nothing. The Met Office's UKV model runs on a
--        ~1.5 km grid; two full postcodes 300 m apart resolve to the SAME model
--        cell and return a byte-identical forecast. Precision the forecast does
--        not contain is not precision.
--      - ECONOMICS: ~1.8 million units vs ~2,900 districts. A builder with 40
--        live jobs pays 40 calls per refresh instead of the 5–8 those jobs
--        actually cluster into.
--      - PRIVACY, and this is decisive: a full postcode plus a house number
--        identifies a household. This table is GLOBAL and readable across
--        tenants (see the RLS block). Writing full postcodes into it would
--        publish a cross-tenant index of where every builder's customers live.
--
--   4. A fixed geographic cell (e.g. a 10 km grid square, or OS 100 km/10 km
--      squares). REJECTED as a key we cannot DERIVE. Assigning an address to a
--      grid cell requires a coordinate, which returns us to (2). A grid would
--      be the better key in a build that had geocoding; it does not.
--
-- CHOSEN: the UK POSTCODE DISTRICT — the outward code, "LS1" from "LS1 4AP",
-- normalised uppercase. It is computable TODAY, with a pure string function and
-- zero network, from columns that already exist (`jobs.site_postcode`,
-- `customers.postcode`, `sites.postcode`).
--
--   ON CORRECTNESS. Every threshold this feature decides against is a
--   synoptic-to-mesoscale quantity. Air temperature and mean wind speed do not
--   vary meaningfully across a postcode district. Convective rainfall genuinely
--   does — but forecast skill at sub-district scale beyond a couple of hours is
--   near zero, so a finer key would resolve noise, not signal. District
--   resolution therefore loses essentially no DECISION-RELEVANT skill.
--
--   THE HONEST WEAKNESS, stated rather than hidden: postcode districts are
--   irregular polygons of wildly varying size. LS1 (Leeds centre) is ~1 km²;
--   IV27 (north-west Highlands) is on the order of 1,500 km². So this is a
--   VARIABLE-resolution key, and for a large rural district the cached reading
--   may describe a point tens of kilometres from the work. That is why
--   `resolved_lat`/`resolved_lon` exist: the coordinate the provider was
--   actually asked about is recorded on every row, so the imprecision is
--   AUDITABLE at the point of use instead of being silently averaged away. A
--   surface that shows a reading for a large district must show how far away it
--   was measured. (The decision layer carries this through as a caveat; see
--   lib/weather/decision.ts.)
--
--   ON API-CALL ECONOMICS, and this is what the global cache buys. Because
--   weather is NOT tenant data, one row serves every tenant. Call volume
--   therefore scales with the number of DISTINCT DISTRICTS UNDER WATCH ACROSS
--   THE WHOLE PLATFORM — not with tenants × jobs. Two builders both working in
--   Leeds share one call. On the Met Office free tier (360 calls/day) that is
--   the difference between a single-tenant toy and platform-wide coverage.
--   No other key choice makes cross-tenant sharing SAFE, because no other key
--   choice is free of customer-identifying detail.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE SPLIT: WEATHER IS NOT TENANT DATA — WHICH DISTRICTS YOU WATCH IS
-- ═══════════════════════════════════════════════════════════════════════════
-- Two tables, because there are two genuinely different things here:
--
--   `weather_readings`  GLOBAL. No org_id. The rainfall over LS1 at 07:00 is a
--                       fact about the world, identical for every tenant, and
--                       duplicating it per-org would multiply both storage and
--                       provider calls by the tenant count for no gain.
--
--   `weather_watches`   ORG-SCOPED. That a firm is watching LS1 for a job is
--                       COMMERCIALLY SENSITIVE — it is a map of where that
--                       builder is working. This is ordinary tenant data with
--                       ordinary RLS.
--
-- The cache's read policy is then gated on the watch table (below), so the
-- global table cannot be used to enumerate the platform's activity.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- TEARDOWN SAFETY (the 20261052 lesson, applied deliberately)
-- ═══════════════════════════════════════════════════════════════════════════
-- 20261052 fixed a P1 in which `delete from organizations` aborted because a
-- cascade child fired a trigger that could not write. 20261061 then repeated
-- the shape of the fix for `sites`. This migration avoids the class outright:
--
--   - `weather_readings` has NO org_id and NO FK to organizations, so org
--     teardown never touches it at all. Trivially safe.
--   - `weather_watches` cascades from organizations and carries NO delete
--     guard. There is deliberately NO `restrict_violation` anywhere in this
--     file. A watch is a lightweight preference, not a record of fact: losing
--     the org, the job or the site correctly loses the reason to watch. Adding
--     a RESTRICT here to "protect" a cache-warming hint would re-introduce
--     exactly the defect 20261052 closed.
--   - `weather_watches.job_id` and `.site_id` are ON DELETE CASCADE for the
--     same reason. Note this does NOT interact with `sites_delete_guard`
--     (20261061): that guard counts vehicles and custody records only, and this
--     migration does NOT add itself to it — a weather watch must never be able
--     to block a depot from being retired.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- RETENTION AND EXPIRY — stated, not implied
-- ═══════════════════════════════════════════════════════════════════════════
-- The two kinds have genuinely different lifetimes, so `expires_at` is
-- STRUCTURALLY tied to `kind` by a CHECK rather than left to convention:
--
--   FORECAST     Has an expiry. `expires_at` is the refresh horizon the
--                provider's own issue cycle implies. A superseded forecast has
--                no evidentiary value, so it is purgeable — but NOT instantly:
--                the default grace is 7 days so that "what did we think on
--                Monday when we booked the pump" stays answerable for a working
--                week. `expires_at` is NOT NULL for forecasts.
--
--   OBSERVATION  Does NOT expire — it is a record of what actually happened,
--                and there is no later version of the past. `expires_at` is
--                forced NULL. Retention is driven by `valid_at` age instead,
--                with a 24-month default: long enough to outlive a typical
--                12-month JCT/NEC defects period and any retrospective delay
--                analysis, short enough not to become an unbounded archive.
--
-- BOTH numbers are DEFAULTS ON A PURGE FUNCTION, not hard-coded policy, and
-- the 24-month figure in particular is a PRODUCT/LEGAL decision rather than an
-- engineering one (contractual limitation in England & Wales runs to six years,
-- which is a different and much more expensive answer). Nothing purges
-- automatically: `purge_weather_readings` must be called deliberately, because
-- deleting an observation destroys the only record of a fact.
--
-- DELIBERATELY NOT IMMUTABLE, unlike `ai_invocations` (20261062) and the
-- 20261031–37 storage wave. This is a CACHE. Providers reissue forecasts
-- continuously and re-publish observations after quality control, so a row that
-- could not be corrected would be a row that permanently held a bad reading.
-- The upsert on the unique key below is the intended write path.
--   CONSEQUENCE, stated so nobody relies on the wrong thing: these rows are
--   NOT evidence. If a future surface ever needs weather as EVIDENCE for a
--   claim, it must snapshot the readings into its own write-once artifact with a
--   content hash (the 20261035 idiom) at the moment of use. It must not cite a
--   mutable cache. That surface is explicitly NOT built here.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Additive, idempotent, reversible. To roll back:
--   revoke execute on function public.purge_weather_readings(interval, interval) from service_role;
--   drop function if exists public.purge_weather_readings(interval, interval);
--   drop trigger if exists weather_watches_set_updated_at on public.weather_watches;
--   drop trigger if exists weather_watches_org_integrity on public.weather_watches;
--   drop function if exists public.tg_weather_watch_org_integrity();
--   drop table if exists public.weather_watches;
--   drop table if exists public.weather_readings;
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. weather_readings — the GLOBAL cache ───────────────────────────────────
create table if not exists public.weather_readings (
  id                uuid primary key default gen_random_uuid(),

  -- WHICH provider produced this. Part of the identity, not metadata: two
  -- providers disagree about the same hour, and silently blending them would
  -- make a work-viability verdict irreproducible. Lowercase vendor id, matching
  -- the `provider` convention in lib/comms (e.g. 'resend', 'twilio', 'meta').
  provider          text not null
                    check (provider = lower(trim(provider))
                           and length(trim(provider)) between 2 and 40),

  -- THE KEY. A UK postcode district (outward code), uppercase, no whitespace.
  --
  -- This CHECK is a PII CONTAINMENT CONTROL, not input validation, and it is
  -- the reason it is deliberately TIGHT where 20261056 argued for looseness on
  -- externally-issued identifiers like a VIN. A district is not issued to us —
  -- we DERIVE it ourselves from an address. The pattern admits exactly the six
  -- real outward-code shapes (A9, A99, A9A, AA9, AA99, AA9A) plus the GIR
  -- special case, and therefore STRUCTURALLY REFUSES a full postcode: "LS1 4AP"
  -- cannot be written to this cross-tenant-readable table. A leak of customer
  -- home addresses into a global table is made unrepresentable in SQL rather
  -- than prevented by careful callers.
  postcode_district text not null
                    check (postcode_district = 'GIR'
                           or postcode_district ~ '^[A-Z]{1,2}[0-9][A-Z0-9]?$'),

  -- A FORECAST is a prediction that expires; an OBSERVATION is a record of the
  -- past that does not. See the retention block in the header — this column
  -- drives the expires_at CHECK below and the two-arm purge.
  kind              text not null check (kind in ('forecast', 'observation')),

  -- The instant this row DESCRIBES. Min/max over a day are deliberately NOT
  -- stored: the decision layer derives them from the rows in a window, so the
  -- cache holds no redundant aggregate that could disagree with its own inputs.
  valid_at          timestamp with time zone not null,

  -- When we retrieved it. Distinct from valid_at: a forecast for Friday
  -- fetched on Monday and the same forecast refetched on Thursday are different
  -- rows in every way that matters except identity, and the later fetch wins.
  fetched_at        timestamp with time zone not null default now(),

  -- The refresh horizon. NOT NULL for a forecast, NULL for an observation —
  -- structural, so "an observation that expires" and "a forecast that never
  -- goes stale" are both unrepresentable.
  expires_at        timestamp with time zone,
  constraint weather_readings_expiry_matches_kind check (
    (kind = 'forecast'    and expires_at is not null) or
    (kind = 'observation' and expires_at is null)
  ),

  -- PROVENANCE, not a key: where the provider actually answered for. This is
  -- what makes the variable-resolution weakness of a district key auditable
  -- (see the header). NULLABLE, and null on every row today, because no
  -- provider is bound and nothing has resolved a coordinate.
  resolved_lat      numeric(8, 5) check (resolved_lat is null or resolved_lat between -90 and 90),
  resolved_lon      numeric(8, 5) check (resolved_lon is null or resolved_lon between -180 and 180),

  -- ── the measurements ──────────────────────────────────────────────────────
  -- SI units throughout, and every field NULLABLE because no provider supplies
  -- all of them. The set is exactly what lib/weather/decision.ts consumes plus
  -- its cheap neighbours; nothing speculative (no UV, no pollen, no snow depth
  -- — snow is already implied by precipitation at sub-zero temperature).
  --
  -- Wind is stored in m/s, which is the unit the lifting standards are written
  -- in (BS 7121 / Beaufort), even though a UK foreman says mph. The conversion
  -- belongs at the display edge, not in the store, so the thresholds can be
  -- compared against the numbers their sources actually quote.
  air_temp_c        numeric(4, 1),
  feels_like_c      numeric(4, 1),
  wind_speed_ms     numeric(4, 1) check (wind_speed_ms is null or wind_speed_ms >= 0),
  wind_gust_ms      numeric(4, 1) check (wind_gust_ms is null or wind_gust_ms >= 0),
  wind_bearing_deg  integer       check (wind_bearing_deg is null or wind_bearing_deg between 0 and 360),
  precip_rate_mm_h  numeric(5, 2) check (precip_rate_mm_h is null or precip_rate_mm_h >= 0),
  precip_total_mm   numeric(6, 2) check (precip_total_mm  is null or precip_total_mm  >= 0),
  precip_prob_pct   integer       check (precip_prob_pct  is null or precip_prob_pct between 0 and 100),
  humidity_pct      integer       check (humidity_pct     is null or humidity_pct    between 0 and 100),
  -- Visibility earns its place: BS 7121 treats poor visibility as a reason to
  -- suspend a lift independently of wind, because the slinger and the operator
  -- must be able to see the load.
  visibility_m      integer       check (visibility_m     is null or visibility_m >= 0),

  created_at        timestamp with time zone not null default now()
);

-- IDENTITY. One row per provider, district, kind and instant. This is also the
-- upsert target: a refreshed forecast for the same valid_at REPLACES its
-- predecessor rather than accumulating duplicates that a reader would have to
-- disambiguate by fetched_at.
create unique index if not exists weather_readings_identity
  on public.weather_readings (provider, postcode_district, kind, valid_at);

-- The read every surface performs: this district, this window, newest first.
-- Provider-agnostic on purpose — a reader asks "what is the weather in LS1",
-- and provider selection is configuration, not part of the question.
create index if not exists weather_readings_district_valid_idx
  on public.weather_readings (postcode_district, valid_at desc);

-- The purge's own scan. Partial: only forecasts carry an expiry at all, so the
-- index holds no observation rows.
create index if not exists weather_readings_expiry_idx
  on public.weather_readings (expires_at)
  where expires_at is not null;

-- RLS ON THIS TABLE IS ENABLED IN §3, NOT HERE, and the reason is a hard
-- ordering dependency rather than style: its SELECT policy is gated on
-- `public.weather_watches`, which does not exist yet at this point in the file.
-- `create policy` resolves the tables its expression names AT CREATION TIME, so
-- declaring it here fails a from-scratch replay with
--   ERROR: relation "public.weather_watches" does not exist (SQLSTATE 42P01)
-- while succeeding on any database that already has the table — the class of bug
-- that only ever surfaces in a restore. Caught by `supabase db reset`; the fix is
-- to create the dependency first and the policy after it. See §3.


-- ── 2. weather_watches — the ORG-SCOPED half ────────────────────────────────
-- Which districts this firm wants kept warm, and why. This is the table that
-- decides what the platform spends provider calls on, and it is the only half
-- of this feature that is tenant data.
create table if not exists public.weather_watches (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,

  -- Same key, same CHECK, same PII containment reasoning as the cache. Repeated
  -- rather than factored into a domain type so that reading either table's
  -- definition tells the whole truth about what may be stored in it.
  postcode_district text not null
                    check (postcode_district = 'GIR'
                           or postcode_district ~ '^[A-Z]{1,2}[0-9][A-Z0-9]?$'),

  -- WHY this district is watched. At most one anchor, both nullable:
  --   job_id  — the common case. Work is happening there; the watch should die
  --             with the job.
  --   site_id — the company's own depot/yard (20261061). Genuinely useful for
  --             "is the yard frozen / flooded", and it makes the org-scoped
  --             half literal: which of YOUR places you watch is your business.
  --   neither — a STANDING watch on a district (see the RLS block: this is the
  --             admin-only one, because it is the one with no natural end).
  job_id            uuid references public.jobs(id)  on delete cascade,
  site_id           uuid references public.sites(id) on delete cascade,
  constraint weather_watches_single_anchor check (job_id is null or site_id is null),

  -- What a human calls this watch, when the anchor is not self-explanatory.
  label             text check (label is null or length(trim(label)) between 1 and 120),

  -- Pause without forgetting. A watch on a job that is on hold should stop
  -- costing provider calls without losing the operator's setup.
  active            boolean not null default true,

  created_by        uuid references public.users(id) on delete set null,
  created_at        timestamp with time zone not null default now(),
  updated_at        timestamp with time zone not null default now()
);

-- One watch per district per anchor. Three PARTIAL unique indexes rather than
-- one composite, because NULL is distinct from NULL in a unique index: a plain
-- `unique (org_id, postcode_district, job_id, site_id)` would happily admit ten
-- identical standing watches on LS1. Each index states one real rule.
create unique index if not exists weather_watches_org_district_standing
  on public.weather_watches (org_id, postcode_district)
  where job_id is null and site_id is null;

create unique index if not exists weather_watches_org_job_district
  on public.weather_watches (org_id, job_id, postcode_district)
  where job_id is not null;

create unique index if not exists weather_watches_org_site_district
  on public.weather_watches (org_id, site_id, postcode_district)
  where site_id is not null;

-- The refresh planner's read: every district this platform owes a call for.
-- Partial on `active` so a paused watch costs nothing to skip.
create index if not exists weather_watches_active_district_idx
  on public.weather_watches (postcode_district)
  where active;

-- org_id leads, serving the bare org_id predicate RLS applies.
create index if not exists weather_watches_org_active_idx
  on public.weather_watches (org_id, active);

-- THE INDEX THAT SERVES THE CACHE'S RLS POLICY, and it is not optional.
-- `weather_readings_select` runs `exists (select 1 from weather_watches where
-- postcode_district = ... and org_id in (...))` for EVERY candidate row, which
-- makes this the hottest read in the feature. Neither index above serves it:
-- the one on (org_id, active) leads with the wrong column, and
-- weather_watches_active_district_idx is PARTIAL on `active` while the policy
-- deliberately does not filter on it. Column order matches the policy's
-- predicate exactly.
create index if not exists weather_watches_district_org_idx
  on public.weather_watches (postcode_district, org_id);

create index if not exists weather_watches_job_idx
  on public.weather_watches (job_id) where job_id is not null;

drop trigger if exists weather_watches_set_updated_at on public.weather_watches;
create trigger weather_watches_set_updated_at before update on public.weather_watches
  for each row execute function public.tg_set_updated_at();

-- ── cross-tenant control on BOTH anchors ────────────────────────────────────
-- RLS only ever checks the ROW's own org_id; it says nothing about the org of
-- the thing the row POINTS AT. Without this, a member of org A could anchor a
-- watch to org B's job — a cross-tenant write, and a job-name leak the moment
-- any surface renders the anchor it points at. Exactly the class 20261011
-- closed for purchase orders and 20261024 generalised.
--
-- ONE function covering both FKs, following tg_material_request_org_integrity
-- (20261066) rather than the TG_ARGV-parameterised
-- tg_site_reference_org_integrity (20261061): both columns live on this one
-- table, so a single trigger is simpler and cannot half-fire.
--
-- SECURITY DEFINER + pinned search_path, for the reason 20261061 states: the
-- check must read the TRUE owning org of the referenced row, not the subset of
-- `jobs`/`sites` the caller's RLS happens to expose. It leaks nothing — it
-- returns no data and its message repeats only the id the caller supplied.
create or replace function public.tg_weather_watch_org_integrity()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  if new.job_id is not null then
    select org_id into v_org from public.jobs where id = new.job_id;
    if v_org is null or v_org <> new.org_id then
      raise exception 'weather watch: job % is not in this org', new.job_id
        using errcode = 'check_violation';
    end if;
  end if;

  if new.site_id is not null then
    select org_id into v_org from public.sites where id = new.site_id;
    if v_org is null or v_org <> new.org_id then
      raise exception 'weather watch: site % is not in this org', new.site_id
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists weather_watches_org_integrity on public.weather_watches;
create trigger weather_watches_org_integrity
  before insert or update on public.weather_watches
  for each row execute function public.tg_weather_watch_org_integrity();

-- ── RLS: members manage ANCHORED watches, admins own STANDING ones ───────────
-- Not the reference-data posture of `sites` (admin-only writes) and not the
-- free-for-all of `suppliers` either, because the two kinds of watch have
-- different blast radii:
--
--   ANCHORED to a job or a site — member write. Setting a weather watch for
--   next Tuesday's pour is day-to-day site management, and admin-gating it
--   would put an office bottleneck in front of the one person who needs it.
--   Its lifetime is bounded by its anchor: the job ends, the cascade removes
--   the watch, the cost stops.
--
--   STANDING (no anchor) — ADMIN write. This is the one with no natural end. It
--   keeps costing provider calls until a human remembers to remove it, which is
--   precisely the kind of open-ended commitment that should sit with whoever
--   owns the bill. The rule is structural, in the WITH CHECK below, not a UI
--   convention.
--
-- Read is org-wide: everyone can see what the firm watches.
alter table public.weather_watches enable row level security;

create policy weather_watches_select on public.weather_watches
  for select using (org_id in (select public.current_org_ids()));

create policy weather_watches_insert on public.weather_watches
  for insert with check (
    org_id in (select public.current_org_ids())
    and (
      job_id is not null or site_id is not null   -- anchored: any member
      or public.is_org_admin(org_id)              -- standing: admins only
    )
  );

-- UPDATE is gated on BOTH sides. Without the WITH CHECK arm a member could take
-- an anchored watch they are allowed to edit and null out its anchor, arriving
-- at a standing watch they were never allowed to create — privilege escalation
-- by omission.
create policy weather_watches_update on public.weather_watches
  for update using (
    org_id in (select public.current_org_ids())
    and (job_id is not null or site_id is not null or public.is_org_admin(org_id))
  ) with check (
    org_id in (select public.current_org_ids())
    and (job_id is not null or site_id is not null or public.is_org_admin(org_id))
  );

create policy weather_watches_delete on public.weather_watches
  for delete using (
    org_id in (select public.current_org_ids())
    and (job_id is not null or site_id is not null or public.is_org_admin(org_id))
  );


-- ── 3. RLS on the GLOBAL cache: readable only for districts YOU watch ────────
-- Deferred to here, after §2, because the policy names `public.weather_watches`
-- and `create policy` resolves that reference at creation time (see the note in
-- §1). Everything else about `weather_readings` is declared in §1.
--
-- The cache holds no tenant data, so the naive posture would be "any signed-in
-- user may read any row". That is rejected. The SET of districts present in
-- this table is itself an inference channel: it reveals which parts of the
-- country SOMEBODY on the platform is working in, and combined with row
-- timestamps it would leak the shape of a competitor's workload. This is the
-- cross-tenant read primitive class that the 20261031–37 storage wave was
-- written to eliminate, and it costs one EXISTS to close.
--
-- So a row is visible only when one of the caller's own orgs watches that
-- district. Weather stays shared (one row, one API call, every tenant), while
-- the QUESTION "who is looking at LS1" stays private.
--
-- The gate deliberately does NOT require `active`. Pausing a watch stops
-- FETCHING, not reading — a reading already paid for stays visible to the org
-- that paid for it, and making cached data vanish the moment a job goes on hold
-- would be a confusing way to save nothing. `active` gates the refresh planner
-- (weather_watches_active_district_idx), which is where the cost actually is.
--
-- Writes: NO insert, update or delete policy exists. Only service_role — which
-- bypasses RLS — can populate or purge this table, exactly as with
-- `ai_invocations` (20261062). A tenant client cannot forge a reading, which
-- matters because a forged reading would drive a false work-viability verdict.
alter table public.weather_readings enable row level security;

create policy weather_readings_select on public.weather_readings
  for select using (
    exists (
      select 1
        from public.weather_watches w
       where w.postcode_district = weather_readings.postcode_district
         and w.org_id in (select public.current_org_ids())
    )
  );


-- ── 4. Retention: an EXPLICIT purge, never an automatic one ─────────────────
-- Two arms because the two kinds have different lifetimes (see the header).
-- Both windows are PARAMETERS with defaults, not baked policy, and the
-- observation window in particular encodes a product/legal decision that has
-- not been taken — 24 months outlives a typical defects period; contractual
-- limitation in England & Wales runs to six years.
--
-- INVOKER RIGHTS, deliberately. A SECURITY DEFINER purge would be a privileged
-- delete primitive over a cross-tenant table, and it does not need to be one:
-- the only caller is service_role, which bypasses RLS already. EXECUTE is
-- revoked from public/anon/authenticated before being granted to service_role
-- so the lock-down is a property of this migration and not an inherited side
-- effect (the 20261052 idiom).
--
-- Returns what it removed, so a scheduled caller can report it rather than
-- silently deleting records of fact.
create or replace function public.purge_weather_readings(
  p_forecast_grace        interval default interval '7 days',
  p_observation_retention interval default interval '24 months'
)
returns table (forecasts_deleted bigint, observations_deleted bigint)
language plpgsql
set search_path = public
as $$
declare
  v_forecasts    bigint := 0;
  v_observations bigint := 0;
begin
  -- Expired forecasts, past their grace period. A superseded prediction.
  delete from public.weather_readings
   where kind = 'forecast'
     and expires_at is not null
     and expires_at < now() - p_forecast_grace;
  get diagnostics v_forecasts = row_count;

  -- Observations older than the retention window. This DESTROYS a record of
  -- what the weather actually was; it is why nothing calls this automatically.
  delete from public.weather_readings
   where kind = 'observation'
     and valid_at < now() - p_observation_retention;
  get diagnostics v_observations = row_count;

  return query select v_forecasts, v_observations;
end $$;

revoke execute on function public.purge_weather_readings(interval, interval)
  from public, anon, authenticated;
grant execute on function public.purge_weather_readings(interval, interval)
  to service_role;


-- ── comments: the authority, on the objects themselves ──────────────────────
comment on table public.weather_readings is
  'GLOBAL weather cache keyed by UK postcode district (outward code) — deliberately NOT org-scoped, because weather is not tenant data. Readable only for districts one of your orgs watches; writes are service_role only. A CACHE, not evidence: rows are mutable and purgeable. EMPTY in production — no provider is bound (20261074000000).';
comment on column public.weather_readings.postcode_district is
  'UK outward code, uppercase, no whitespace (e.g. LS1). The CHECK is a PII containment control: it structurally refuses a full postcode, which would publish customer home addresses into a cross-tenant table.';
comment on column public.weather_readings.resolved_lat is
  'Provenance, not a key: the coordinate the provider actually answered for. Makes the variable size of a postcode district auditable at the point of use. NULL until a provider is bound.';
comment on column public.weather_readings.expires_at is
  'Refresh horizon. NOT NULL for a forecast, NULL for an observation — an observation is a record of the past and has no later version.';
comment on table public.weather_watches is
  'Which postcode districts an org watches, and why (a job, one of its own sites, or a standing watch). ORG-SCOPED: this is a map of where a builder is working, and is commercially sensitive. Anchored watches are member-writable; standing ones are admin-only (20261074000000).';
comment on function public.purge_weather_readings(interval, interval) is
  'Explicit, service_role-only retention pass. Two arms: expired forecasts past a grace period, and observations past a retention window. Never called automatically — deleting an observation destroys the only record of a fact.';

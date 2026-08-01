-- EOT (extension of time) evidence foundation — delay_events.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
-- ═══════════════════════════════════════════════════════════════════════════
-- Under JCT/NEC, an extension of time stands or falls on CONTEMPORANEOUS
-- EVIDENCE: what stopped the work, when, for how long, and what records were
-- kept at the time. CrewFlow already holds most of the raw material — site
-- diary entries with free-text weather and a `delays` field (20260920), EoT
-- request/agreement dates on variations (20261073), a progress time series
-- (20261078) — but nothing ties a specific stoppage to the records that prove
-- it. This migration adds that spine: a dated, categorised, human-recorded
-- DELAY EVENT that links to the evidence it rests on.
--
-- It is an EVIDENCE FOUNDATION, not a claims engine:
--   • NO AI touches this lane. No draft letters, no generated narratives.
--   • NOTHING is submitted anywhere automatically. The output is a pack a
--     human reviews; the contractual claim letter is deliberately NOT
--     produced (a claim asserts contractual entitlement — a legal position —
--     and inventing one is exactly the "invented contractual facts" failure
--     this design refuses).
--   • NO contractual fact is derived. See WORKING DAYS LOST below.
--   • NO job date moves. 20261073 §2 already established that whether an
--     agreed EoT shifts the programme is a pending PRODUCT decision; a delay
--     event records what happened, never what it entitles anyone to.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE CATEGORIES (CHECK below) — what each one MEANS
-- ═══════════════════════════════════════════════════════════════════════════
-- The six values are the recurring heads of delay in UK small-works practice.
-- The category is a FILING KEY for the pack (a claim is argued head-by-head),
-- not a legal characterisation — whether an event is a "Relevant Event"/
-- "Compensation Event" under the actual contract is for the human reviewer.
--
--   weather                 Work stopped or slowed by weather at the site:
--                           rain, wind (crane/roof limits), frost/snow, heat.
--                           May carry `weather_district` (see the seam note).
--   client_instruction      The client/employer (or their agent) told the
--                           contractor to stop, suspend, resequence, or wait
--                           for a decision. Includes late instructions.
--   access_restriction      The site could not be accessed or occupied as
--                           planned: possession not given, area held by
--                           another trade, road closures, restricted hours.
--   third_party_dependency  Waiting on a party neither side controls: utility
--                           company, statutory undertaker, building control /
--                           inspector availability, supplier failure.
--   design_change           Works stopped or redone because design
--                           information changed or was awaited (revised
--                           drawings, unanswered RFI, discrepancy found).
--   other                   Anything else — the description carries the
--                           substance. Deliberately present so an awkward
--                           real-world stoppage is never forced into a wrong
--                           category or, worse, left unrecorded.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WORKING DAYS LOST IS CLAIMED BY THE HUMAN, NEVER COMPUTED
-- ═══════════════════════════════════════════════════════════════════════════
-- `working_days_lost` is a plain nullable integer the recorder types in. It
-- is NOT a generated column, NO trigger derives it, and no app code computes
-- it from the date range. This is deliberate, and it is the most important
-- decision in this file:
--
--   • (ended_on − started_on) is CALENDAR time. Converting it to working
--     time needs the site's working week, holiday calendar, and whether the
--     crew was redeployed — none of which this schema holds. A derived
--     number would be wrong in a way that LOOKS authoritative.
--   • In a dispute, an assessor tests the claimed figure against the
--     records. A system-computed figure would put false precision INTO the
--     evidence — the pack would assert a contractual quantum nobody actually
--     assessed. False precision is the enemy of an honest claim.
--   • NULL is a first-class state: "not yet quantified" must stay
--     distinguishable from "quantified at zero" (an event can be recorded
--     contemporaneously and quantified later — see the write-once note).
--
-- The date range and the claimed figure may legitimately disagree (a 10-day
-- calendar stoppage might cost 3 working days on a part-time site). The pack
-- surfaces both and lets the reviewer judge.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE EVIDENCE LINKS — all nullable, all composite-FK org-pinned
-- ═══════════════════════════════════════════════════════════════════════════
--   diary_entry_id      The site diary entry that contemporaneously records
--                       the stoppage. Composite FK (diary_entry_id, org_id)
--                       → site_diary_entries (id, org_id): a cross-tenant
--                       link is UNREPRESENTABLE, for service_role too. The
--                       guard trigger additionally requires the entry to name
--                       THIS job — a diary page about another job (or no job)
--                       is not evidence for this one.
--   variation_quote_id  The variation (quotes row, 20260520180000) whose EoT
--                       columns (20261073) carry the requested/agreed dates.
--                       Same composite-FK discipline; the guard requires it
--                       to actually BE a variation (variation_number set) on
--                       THIS job.
--   weather_district    THE WEATHER SEAM — a UK postcode district under the
--                       SAME CHECK as weather_readings.postcode_district
--                       (20261074). Deliberately TEXT WITH NO FK: the weather
--                       cache is BUILT DARK AND EMPTY (no provider bound —
--                       20261074's header), so an FK would make every weather
--                       delay unrecordable until a provider ships, and
--                       weather_readings rows are a rolling cache with no
--                       stable identity to reference anyway. Nothing reads
--                       the weather tables at runtime on this lane; the pack
--                       states "weather evidence unavailable — provider
--                       dark". When weather activates, this column is the
--                       join key that back-fills observed readings alongside
--                       each event — the seam waits, it does not pretend.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- LIFECYCLE: draft → recorded → withdrawn (tg_delay_event_transition)
-- ═══════════════════════════════════════════════════════════════════════════
--   draft      Being written up. Freely editable by members; deletable by an
--              admin (RLS below). Carries no evidential weight.
--   recorded   The org's formal account of the event. IMMUTABLE except for:
--                a) recorded → withdrawn (the only exit), and
--                b) WRITE-ONCE COMPLETION of `ended_on` and
--                   `working_days_lost` (NULL → value only; value → different
--                   value is refused — the 20261073 §4 idiom). This is what
--                   lets an ONGOING stoppage be recorded contemporaneously —
--                   evidentially far stronger than a retrospective write-up —
--                   and closed when it actually ends.
--   withdrawn  Stood down but never erased: a recorded event is evidence,
--              and evidence is retracted in the open, not deleted. Terminal
--              and fully frozen.
--
--   draft → withdrawn is REFUSED (delete the draft instead): permitting it
--   would mint terminal rows that skipped the recording gate — the RAMS S4
--   forgery class (20261034). The graph is enforced for EVERYONE including
--   service_role (a bad shape is a bad shape — the 20261067 asymmetry);
--   PROVENANCE PINNING (recorded_by/at, withdrawn_by/at := the caller) is
--   JWT-gated so trusted seeds can construct historical states by walking
--   the graph with explicit provenance.
--
--   Roles: recording and withdrawing are MEMBER-LEVEL, exactly like the RAMS
--   lifecycle — whether they should be admin-gated is the same pending
--   product decision deliberately not taken here (20261034 precedent).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ORG-TEARDOWN SAFETY (the 20261052 lesson) — including the SET NULL escape
-- ═══════════════════════════════════════════════════════════════════════════
-- `delete from organizations` must keep working. No RESTRICT anywhere, no
-- AFTER-DELETE trigger, no activity trigger. Every cascade route is safe:
--     organizations → delay_events                       (cascade, direct)
--     organizations → jobs → delay_events                (cascade, composite)
--     organizations → site_diary_entries → delay_events  (SET NULL, column list)
--     organizations → quotes → delay_events              (SET NULL, column list)
--
-- The last two are why the immutability rule has ONE narrow escape: the
-- evidence-link FKs use PG15+ column-list `on delete set null (col)` (org_id
-- must survive the nulling), and that referential UPDATE fires the transition
-- trigger on RECORDED rows mid-teardown. A trigger that froze the linkage
-- columns absolutely would abort the cascade and re-create the 20261052
-- failure. So linkage columns may go value → NULL at any time (the FK action
-- and an operator unlink — visible in updated_at), while value → DIFFERENT
-- value stays refused: evidence may be detached in the open, never swapped.
--
-- Additive and reversible:
--   drop table public.delay_events;
--   drop function public.tg_delay_event_transition();
--   drop function public.tg_delay_event_guard();
--   -- the (id, org_id) candidate keys on site_diary_entries/quotes are
--   -- harmless supersets of the PK that other lanes' composite FKs may by
--   -- then also target; they stay (the 20261078 jobs_id_org_key reasoning).

-- ── 1. Candidate keys the composite FKs need ────────────────────────────────
-- (id, org_id) is a superset of each PK, so adding it can never reject a row.
-- jobs_id_org_key already exists (20261078). Introspection-guarded, the same
-- idiom, so a concurrent lane adding the same key cannot collide.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'site_diary_entries_id_org_key') then
    alter table public.site_diary_entries
      add constraint site_diary_entries_id_org_key unique (id, org_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quotes_id_org_key') then
    alter table public.quotes
      add constraint quotes_id_org_key unique (id, org_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jobs_id_org_key') then
    alter table public.jobs add constraint jobs_id_org_key unique (id, org_id);
  end if;
end $$;

-- ── 2. delay_events ──────────────────────────────────────────────────────────
create table if not exists public.delay_events (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,

  -- NOT NULL + composite FK + CASCADE, the 20261078 reasoning verbatim: a
  -- delay with no job it delayed is not a degraded record, it is a
  -- meaningless one, and the composite FK makes a cross-tenant job
  -- unrepresentable for every role with no trigger to bypass.
  job_id             uuid not null,

  category           text not null
                     check (category in ('weather', 'client_instruction',
                                         'access_restriction', 'third_party_dependency',
                                         'design_change', 'other')),

  -- The stoppage's date range. `ended_on` NULL while the delay is ONGOING —
  -- an honest open interval, not a missing value.
  started_on         date not null,
  ended_on           date,

  -- CLAIMED by the recorder. Never computed — see the header. NULL means
  -- "not yet quantified", distinct from 0.
  working_days_lost  integer
                     check (working_days_lost is null or working_days_lost >= 0),

  -- What happened, in the recorder's words. The substance of the record.
  description        text not null check (length(btrim(description)) between 1 and 4000),

  -- Evidence links — see the header. All nullable: an event with no linked
  -- evidence is recordable (the pack SURFACES the gap; refusing the record
  -- would just mean the stoppage goes unlogged, which is strictly worse).
  diary_entry_id     uuid,
  variation_quote_id uuid,
  weather_district   text
                     check (weather_district is null
                            or weather_district = 'GIR'
                            or weather_district ~ '^[A-Z]{1,2}[0-9][A-Z0-9]?$'),

  -- Lifecycle + provenance. recorded_*/withdrawn_* are pinned by the
  -- transition trigger on JWT paths; the CHECKs make a terminal state
  -- without provenance unrepresentable no matter who writes it.
  status             text not null default 'draft'
                     check (status in ('draft', 'recorded', 'withdrawn')),
  recorded_at        timestamptz,
  recorded_by        uuid references public.users(id) on delete set null,
  withdrawn_at       timestamptz,
  withdrawn_by       uuid references public.users(id) on delete set null,

  created_by         uuid references public.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint delay_events_dates_ordered
    check (ended_on is null or ended_on >= started_on),

  -- A recorded/withdrawn event must carry its provenance timestamps.
  constraint delay_events_recorded_audited
    check (status = 'draft' or recorded_at is not null),
  constraint delay_events_withdrawn_audited
    check (status <> 'withdrawn' or withdrawn_at is not null),
  -- ...and a draft carries none: provenance appears only when the transition
  -- happens, so it can never be pre-forged on a draft.
  constraint delay_events_draft_unprovenanced
    check (status <> 'draft'
           or (recorded_at is null and recorded_by is null
               and withdrawn_at is null and withdrawn_by is null)),

  -- Cross-tenant impossibility, per link. Column-list SET NULL (PG15+) so the
  -- referential action nulls ONLY the linkage column, never NOT NULL org_id —
  -- this is what keeps org teardown alive (header §teardown).
  constraint delay_events_job_fkey
    foreign key (job_id, org_id) references public.jobs (id, org_id) on delete cascade,
  constraint delay_events_diary_fkey
    foreign key (diary_entry_id, org_id) references public.site_diary_entries (id, org_id)
    on delete set null (diary_entry_id),
  constraint delay_events_variation_fkey
    foreign key (variation_quote_id, org_id) references public.quotes (id, org_id)
    on delete set null (variation_quote_id),

  -- Candidate key for any future child relation's composite, org-binding FK.
  constraint delay_events_id_org_key unique (id, org_id)
);

-- The two hot paths: a job's delay history (pack assembly, job panel), and
-- the org-wide register, newest stoppage first.
create index if not exists delay_events_job_idx
  on public.delay_events (job_id, started_on desc);
create index if not exists delay_events_org_idx
  on public.delay_events (org_id, started_on desc);

-- ── 3. RLS — member-scoped via current_org_ids(); delete draft-only + admin ─
alter table public.delay_events enable row level security;

-- Recording a delay is site work (the snags/site_diary/job_progress idiom):
-- INSERT/UPDATE are member-level; the transition trigger is what polices the
-- graph and immutability, because RLS sees OLD or NEW, never both.
create policy delay_events_select on public.delay_events
  for select using (org_id in (select public.current_org_ids()));
create policy delay_events_insert on public.delay_events
  for insert with check (org_id in (select public.current_org_ids()));
create policy delay_events_update on public.delay_events
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
-- Hard DELETE: admin, and ONLY a draft. A recorded event is evidence — it is
-- withdrawn in the open, never erased. (Cascades — org/job teardown — run as
-- table owner and are not subject to this policy, which is the escape that
-- keeps `delete from organizations` working.)
create policy delay_events_delete on public.delay_events
  for delete using (public.is_org_admin(org_id) and status = 'draft');

drop trigger if exists delay_events_set_updated_at on public.delay_events;
create trigger delay_events_set_updated_at before update on public.delay_events
  for each row execute function public.tg_set_updated_at();

-- ── 4. Guard: honest shape, validated WHEN ASSERTED ─────────────────────────
-- What the constraints cannot express. The job's tenancy is already the
-- composite FK's guarantee, so it is NOT re-checked here (20261078 reasoning).
--
-- EVERY check below runs on INSERT, or when the fact it validates is CHANGING
-- — never on an unrelated UPDATE. That scoping is teardown-load-bearing, not
-- tidiness: the evidence-link FKs' column-list SET NULL fires this trigger on
-- surviving rows mid-`delete from organizations`, at a point where
-- memberships (or the linked quote's job) may already be gone. A guard that
-- re-litigated every fact on every UPDATE would abort that cascade — the
-- 20261052 failure class arrived at through a BEFORE trigger instead of an
-- AFTER one. A fact is checked when it is asserted; it is not re-proved when
-- a different column moves.
create or replace function public.tg_delay_event_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Europe/London')::date;
begin
  -- Born a draft, unconditionally — even the service role (the RAMS 20261034
  -- rule): terminal or recorded rows exist only by walking the graph.
  if tg_op = 'INSERT' and new.status <> 'draft' then
    raise exception 'a delay event is created as a draft, then recorded'
      using errcode = 'check_violation';
  end if;

  -- No future-dated facts. A delay that has not started is a risk, not an
  -- event; a future end date is a prediction, not a record. Europe/London
  -- day, not UTC (the 20261070/20261078 idiom): at 00:30 BST a UK user is
  -- still on the previous UTC date and a UTC comparison would reject their
  -- entirely valid "today".
  if (tg_op = 'INSERT' or new.started_on is distinct from old.started_on)
     and new.started_on > v_today then
    raise exception 'a delay cannot start in the future (% is after today)', new.started_on
      using errcode = 'check_violation';
  end if;
  if (tg_op = 'INSERT' or new.ended_on is distinct from old.ended_on)
     and new.ended_on is not null and new.ended_on > v_today then
    raise exception 'a delay cannot end in the future (% is after today)', new.ended_on
      using errcode = 'check_violation';
  end if;

  -- A linked diary entry must contemporaneously record THIS job. The
  -- composite FK proves the tenant; this proves the subject — an entry about
  -- another job (or filed against no job) is not evidence for this one.
  -- Checked when the link (or the job it must match) is being set/changed;
  -- nulling a link asserts nothing and needs no proof.
  if new.diary_entry_id is not null
     and (tg_op = 'INSERT'
          or new.diary_entry_id is distinct from old.diary_entry_id
          or new.job_id is distinct from old.job_id) then
    if not exists (
      select 1 from public.site_diary_entries d
       where d.id = new.diary_entry_id
         and d.org_id = new.org_id
         and d.job_id = new.job_id
    ) then
      raise exception 'the linked site diary entry does not record this job'
        using errcode = 'check_violation';
    end if;
  end if;

  -- A linked "variation" must actually be one (variation_number set,
  -- 20260520180000) and must belong to THIS job.
  if new.variation_quote_id is not null
     and (tg_op = 'INSERT'
          or new.variation_quote_id is distinct from old.variation_quote_id
          or new.job_id is distinct from old.job_id) then
    if not exists (
      select 1 from public.quotes q
       where q.id = new.variation_quote_id
         and q.org_id = new.org_id
         and q.variation_number is not null
         and q.job_id = new.job_id
    ) then
      raise exception 'the linked document is not a variation on this job'
        using errcode = 'check_violation';
    end if;
  end if;

  -- Authorship names must be members of THIS org (the 20261059/20261066/
  -- 20261078 guard): a forged id would put another tenant's staff name
  -- inside this org's evidence.
  if new.created_by is not null
     and (tg_op = 'INSERT' or new.created_by is distinct from old.created_by)
     and not exists (select 1 from public.memberships
                      where user_id = new.created_by and org_id = new.org_id) then
    raise exception 'delay event: % is not a member of this org', new.created_by
      using errcode = 'check_violation';
  end if;
  if new.recorded_by is not null
     and (tg_op = 'INSERT' or new.recorded_by is distinct from old.recorded_by)
     and not exists (select 1 from public.memberships
                      where user_id = new.recorded_by and org_id = new.org_id) then
    raise exception 'delay event: % is not a member of this org', new.recorded_by
      using errcode = 'check_violation';
  end if;
  if new.withdrawn_by is not null
     and (tg_op = 'INSERT' or new.withdrawn_by is distinct from old.withdrawn_by)
     and not exists (select 1 from public.memberships
                      where user_id = new.withdrawn_by and org_id = new.org_id) then
    raise exception 'delay event: % is not a member of this org', new.withdrawn_by
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists delay_events_guard on public.delay_events;
create trigger delay_events_guard
  before insert or update on public.delay_events
  for each row execute function public.tg_delay_event_guard();

-- ── 5. Transition trigger: the graph + immutability-after-recorded ──────────
-- material_requests style (20261067): one BEFORE UPDATE function owns both the
-- legal edges and what may change while status stands still. The GRAPH binds
-- everyone (service_role included); PROVENANCE PINNING is JWT-gated.
create or replace function public.tg_delay_event_transition()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_jwt boolean := auth.uid() is not null;
begin
  -- ── Status unchanged: police the fields ────────────────────────────────
  if new.status is not distinct from old.status then
    if old.status = 'draft' then
      return new; -- drafts are freely editable (guard trigger still applies)
    end if;

    if old.status = 'withdrawn' then
      raise exception 'delay event %: a withdrawn event is frozen', old.id
        using errcode = 'check_violation';
    end if;

    -- RECORDED: frozen, except —
    --   a) write-once COMPLETION of ended_on / working_days_lost (NULL→value;
    --      the 20261073 §4 idiom) so an ongoing stoppage recorded
    --      contemporaneously can be closed when it actually ends;
    --   b) evidence links may go value→NULL (operator unlink, and the FK's
    --      column-list SET NULL during teardown — header §teardown), never
    --      value→different value.
    if new.job_id is distinct from old.job_id
       or new.org_id is distinct from old.org_id
       or new.category is distinct from old.category
       or new.started_on is distinct from old.started_on
       or new.description is distinct from old.description
       or new.created_by is distinct from old.created_by
       or new.recorded_at is distinct from old.recorded_at
       or new.recorded_by is distinct from old.recorded_by
       or new.withdrawn_at is distinct from old.withdrawn_at
       or new.withdrawn_by is distinct from old.withdrawn_by then
      raise exception 'delay event %: a recorded event is immutable (withdraw it instead)', old.id
        using errcode = 'check_violation';
    end if;
    if old.ended_on is not null and new.ended_on is distinct from old.ended_on then
      raise exception 'delay event %: its end date is already recorded', old.id
        using errcode = 'check_violation';
    end if;
    if old.working_days_lost is not null
       and new.working_days_lost is distinct from old.working_days_lost then
      raise exception 'delay event %: its working-days-lost claim is already recorded', old.id
        using errcode = 'check_violation';
    end if;
    if (old.diary_entry_id is not null
        and new.diary_entry_id is distinct from old.diary_entry_id
        and new.diary_entry_id is not null)
       or (old.diary_entry_id is null and new.diary_entry_id is not null) then
      raise exception 'delay event %: evidence links on a recorded event can be removed, not changed', old.id
        using errcode = 'check_violation';
    end if;
    if (old.variation_quote_id is not null
        and new.variation_quote_id is distinct from old.variation_quote_id
        and new.variation_quote_id is not null)
       or (old.variation_quote_id is null and new.variation_quote_id is not null) then
      raise exception 'delay event %: evidence links on a recorded event can be removed, not changed', old.id
        using errcode = 'check_violation';
    end if;
    if new.weather_district is distinct from old.weather_district
       and not (old.weather_district is not null and new.weather_district is null) then
      raise exception 'delay event %: evidence links on a recorded event can be removed, not changed', old.id
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- ── draft → recorded ────────────────────────────────────────────────────
  if old.status = 'draft' and new.status = 'recorded' then
    if v_jwt then
      -- Pin provenance server-side: who recorded, and when, cannot be forged
      -- or back-dated (the RAMS issue-gate idiom, 20261034).
      new.recorded_at := now();
      new.recorded_by := auth.uid();
    else
      -- Trusted seeds state explicit provenance; the CHECK requires the
      -- timestamp either way.
      new.recorded_at := coalesce(new.recorded_at, now());
    end if;
    return new;
  end if;

  -- ── recorded → withdrawn ────────────────────────────────────────────────
  if old.status = 'recorded' and new.status = 'withdrawn' then
    -- A withdrawal changes STANDING, not substance: every evidential field
    -- must ride through unchanged, so the withdrawn row still shows exactly
    -- what was retracted.
    if new.job_id is distinct from old.job_id
       or new.category is distinct from old.category
       or new.started_on is distinct from old.started_on
       or new.ended_on is distinct from old.ended_on
       or new.working_days_lost is distinct from old.working_days_lost
       or new.description is distinct from old.description
       or new.diary_entry_id is distinct from old.diary_entry_id
       or new.variation_quote_id is distinct from old.variation_quote_id
       or new.weather_district is distinct from old.weather_district
       or new.recorded_at is distinct from old.recorded_at
       or new.recorded_by is distinct from old.recorded_by then
      raise exception 'delay event %: withdrawal cannot alter the record it retracts', old.id
        using errcode = 'check_violation';
    end if;
    if v_jwt then
      new.withdrawn_at := now();
      new.withdrawn_by := auth.uid();
    else
      new.withdrawn_at := coalesce(new.withdrawn_at, now());
    end if;
    return new;
  end if;

  -- ── Everything else ─────────────────────────────────────────────────────
  -- Includes draft → withdrawn (delete the draft instead — a terminal row
  -- must not skip the recording gate: the RAMS S4 class), recorded → draft
  -- (evidence cannot be quietly re-opened for editing), and every edge out
  -- of 'withdrawn'.
  raise exception 'delay event %: % -> % is not a legal transition',
    old.id, old.status, new.status using errcode = 'check_violation';
end $$;

drop trigger if exists delay_events_transition on public.delay_events;
create trigger delay_events_transition
  before update on public.delay_events
  for each row execute function public.tg_delay_event_transition();

-- ── 6. Comments — constraints, restated at the point of use ─────────────────
comment on table public.delay_events is
  'Human-recorded delay events per job — the EVIDENCE FOUNDATION for a future extension-of-time claim. '
  'Lifecycle draft -> recorded -> withdrawn (tg_delay_event_transition); recorded events are immutable '
  'except withdrawal and write-once completion of ended_on/working_days_lost. No AI, no automatic '
  'submission, no derived contractual facts anywhere on this lane.';
comment on column public.delay_events.working_days_lost is
  'CLAIMED by the recorder, never computed: deriving working time from the calendar range would need a '
  'working week and holiday calendar this schema does not hold, and would put false precision into '
  'evidence. NULL = not yet quantified (distinct from 0). Write-once after recording.';
comment on column public.delay_events.weather_district is
  'Evidence SEAM for the dark weather cache (20261074): same district CHECK as '
  'weather_readings.postcode_district, deliberately NO FK — the cache is empty until a provider is '
  'bound, and nothing on this lane reads it at runtime. When weather activates, this key back-fills '
  'observed readings alongside each event.';
comment on column public.delay_events.ended_on is
  'NULL while the delay is ONGOING — an honest open interval. Write-once after recording, so a '
  'contemporaneously recorded stoppage can be closed when it actually ends.';

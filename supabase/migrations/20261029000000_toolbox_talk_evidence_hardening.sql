-- Toolbox Talks — final adversarial-review evidence hardening.
--
-- A 5-agent review of the whole wave found the honesty model, concurrency, tenant
-- isolation and revision correctness sound (P0=0), but surfaced a convergent cluster
-- of evidence-integrity gaps where the DB did NOT backstop what the design claims.
-- The driving fact (as with the RAMS M5 hardening): the base UPDATE RLS policy on
-- toolbox_talks is org-member-only with NO status gate, so the triggers — not RLS,
-- not the server action's .eq("status","draft") — are the sole backstop against a
-- crafted PostgREST write by any authenticated member. Closed here:
--
--   [P1] The Tier-B attendance columns (attendees, attendee_count, notes) — the ONLY
--        record for subcontractors who never acknowledge in-app — were omitted from
--        the immutable frozen tuple, so a member could silently rewrite who was
--        briefed on delivered evidence. Now frozen once the talk leaves draft.
--   [P1] The snapshot write-once guard only engaged once snapshot was non-null, and
--        nothing forced a snapshot at issue — so a crafted UPDATE could issue with
--        snapshot=NULL and then author a forged "point-in-time" snapshot AFTER issue
--        (post-dating the evidence). Now a JWT issue MUST carry its snapshot.
--   [P2] The M5 attachment-freeze trigger returned OLD in its allow-branches; for a
--        BEFORE UPDATE that silently discards the caller's change (latent today — no
--        code UPDATEs tenant_attachments — but a landmine). Now TG_OP-correct.
--   [P2] The delivered_by uuid column was dead (no TS reads/writes it; the feature
--        uses presenter free-text + issued_by). Dropped — no dead FK on live H&S evidence.
--
-- Trusted-role asymmetry preserved: the snapshot-required gate fires only for JWT
-- callers (auth.uid() present); the service role (fixtures/migrations, never shipped
-- to the browser) keeps explicit values, exactly as the born-draft/issue-gate do.
-- Additive + reversible.

-- ---------------------------------------------------------------------------
-- 1. Drop the dead delivered_by column (nothing references it).
-- ---------------------------------------------------------------------------
alter table public.toolbox_talks drop column if exists delivered_by;

-- ---------------------------------------------------------------------------
-- 2. Lifecycle: require the evidence snapshot on a JWT draft->issued transition
--    (closes the null-then-forge hole). Body otherwise identical to 20261025.
-- ---------------------------------------------------------------------------
create or replace function public.tg_tt_a_lifecycle()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and new.status <> 'draft' then
    raise exception 'a toolbox talk is created as a draft, then issued';
  end if;

  if tg_op = 'UPDATE' and old.status = 'draft' and new.status = 'issued' and auth.uid() is not null then
    if new.topic is null or length(trim(new.topic)) = 0
       or new.key_points is null or length(trim(new.key_points)) = 0 then
      raise exception 'a toolbox talk needs a topic and key points before it can be delivered';
    end if;
    -- The frozen evidence snapshot must be written IN the issue transition — never
    -- authored later (the write-once guard alone left a null-then-forge window).
    if new.snapshot is null then
      raise exception 'a toolbox talk must be delivered with its evidence snapshot';
    end if;
    new.issued_by := auth.uid();
    new.issued_at := now();
  end if;

  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Immutable-on-issue: extend the frozen tuple to cover the Tier-B attendance
--    record (attendees, attendee_count, notes). Body otherwise identical to 20261025.
-- ---------------------------------------------------------------------------
create or replace function public.tg_tt_m_immutable()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'draft' then
    return new;
  end if;

  if new.status is distinct from old.status then
    if old.status = 'issued' and new.status in ('superseded', 'withdrawn') then
      null;
    else
      raise exception 'invalid toolbox talk status transition % -> %', old.status, new.status;
    end if;
  end if;

  if old.snapshot is not null and new.snapshot is distinct from old.snapshot then
    raise exception 'the toolbox talk evidence snapshot is frozen once set';
  end if;

  if (new.topic, new.key_points, new.location, new.ppe, new.talk_date, new.presenter,
      new.attendees, new.attendee_count, new.notes,
      new.job_id, new.risk_assessment_id, new.permit_to_work_id, new.reference,
      new.issued_at, new.issued_by, new.supersedes_id, new.root_toolbox_talk_id,
      new.revision_number, new.org_id, new.created_by, new.created_at)
     is distinct from
     (old.topic, old.key_points, old.location, old.ppe, old.talk_date, old.presenter,
      old.attendees, old.attendee_count, old.notes,
      old.job_id, old.risk_assessment_id, old.permit_to_work_id, old.reference,
      old.issued_at, old.issued_by, old.supersedes_id, old.root_toolbox_talk_id,
      old.revision_number, old.org_id, old.created_by, old.created_at)
  then
    raise exception 'a % toolbox talk is immutable; raise a new revision instead', old.status;
  end if;

  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Attachment freeze: TG_OP-correct return so a permitted UPDATE of a
--    non-delivered-toolbox attachment is not silently discarded.
-- ---------------------------------------------------------------------------
create or replace function public.tg_tenant_attachment_freeze_delivered_toolbox()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_ret record;
begin
  v_ret := case when tg_op = 'DELETE' then old else new end;
  if old.target_table <> 'toolbox_talks' then
    return v_ret;
  end if;
  if not exists (select 1 from public.organizations where id = old.org_id) then
    return v_ret;
  end if;
  select status into v_status from public.toolbox_talks where id = old.target_id;
  if v_status is null or v_status = 'draft' then
    return v_ret;
  end if;
  raise exception 'evidence attached to a delivered toolbox talk is frozen — add new files, never remove or replace one';
end $$;

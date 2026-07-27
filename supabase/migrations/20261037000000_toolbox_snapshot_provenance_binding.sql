-- Security wave — complete the toolbox evidence-snapshot binding (adversarial follow-up).
--
-- The 20261030 snapshot binding pinned only 4 of the 18 snapshot keys (talk_reference,
-- revision, topic, key_points) to the record. The provenance/linkage keys — issued_on,
-- issued_by_name, rams_reference/revision, permit_reference — passed through caller-authored
-- and unverified, so a member could issue their OWN draft via a single direct PATCH carrying
-- a backdated issue date, a spoofed issuer name, and fabricated/mislabelled RAMS+permit
-- control references. The DB row's issued_at/issued_by stay pinned (the record is truthful),
-- but the PDF renders the frozen SNAPSHOT — so the distributed "tamper-evident" evidence
-- could show forged provenance. Within-tenant, own-org, direct-PostgREST only (the app UI
-- assembles the snapshot honestly server-side), but it undermines the exact evidentiary
-- integrity the table exists for. Same class as the 20261030 identity binding, completed here.
--
-- Fix: DERIVE these fields from the DB at issue (overwrite the caller's values) rather than
-- trust them — the "DB assembles the invariant scalar fields" approach. Honest issues are
-- unaffected (the app already supplies the same derived values, so the overwrite is a no-op
-- for them); only a crafted snapshot is silently corrected. issued_on = the real pinned issue
-- date; issued_by_name = the resolved acting user; rams_reference/revision + permit_reference =
-- the actually-linked documents (null when unlinked — a fabricated link is stripped).
--
-- RESIDUAL (tracked P3, NOT closed here): permit_status_at_issue when a permit IS linked is
-- left as supplied — binding it needs the app's effectiveStatus() (expiry-adjusted) replicated
-- in SQL. A fabricated status with NO permit linked IS stripped (nulled) below.
--
-- CREATE OR REPLACE of tg_tt_a_lifecycle only (trigger already bound). Body identical to
-- 20261030 with the provenance pin moved above the binding + the derive block added. JWT-only
-- (service role exempt). Additive + reversible: restore the 20261030 body.

create or replace function public.tg_tt_a_lifecycle()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and new.status <> 'draft' then
    raise exception 'a toolbox talk is created as a draft, then issued';
  end if;

  if tg_op = 'UPDATE' and old.status = 'draft' and auth.uid() is not null then
    if new.status not in ('draft', 'issued') then
      raise exception 'a draft toolbox talk can only be delivered (issued), not moved directly to %', new.status;
    end if;

    if new.status = 'issued' then
      if new.topic is null or length(trim(new.topic)) = 0
         or new.key_points is null or length(trim(new.key_points)) = 0 then
        raise exception 'a toolbox talk needs a topic and key points before it can be delivered';
      end if;
      if new.snapshot is null then
        raise exception 'a toolbox talk must be delivered with its evidence snapshot';
      end if;

      -- Pin provenance FIRST so the derived snapshot below references the real issue stamp.
      new.issued_by := auth.uid();
      new.issued_at := now();

      -- Identity + core content bound to the record (20261030).
      if new.snapshot->>'talk_reference' is distinct from new.reference then
        raise exception 'the evidence snapshot reference must equal the issued reference';
      end if;
      if (new.snapshot->>'revision')::int is distinct from new.revision_number then
        raise exception 'the evidence snapshot revision must equal the talk revision';
      end if;
      if new.snapshot->>'topic' is distinct from new.topic
         or new.snapshot->>'key_points' is distinct from new.key_points then
        raise exception 'the evidence snapshot content must match the delivered talk';
      end if;

      -- Provenance/linkage fields are DB-authoritative — overwrite whatever the caller sent
      -- (honest issues supply the identical values, so this is a no-op for them).
      new.snapshot := jsonb_set(new.snapshot, '{issued_on}',
        to_jsonb(to_char(new.issued_at at time zone 'utc', 'YYYY-MM-DD')));
      new.snapshot := jsonb_set(new.snapshot, '{issued_by_name}',
        coalesce(to_jsonb((select full_name from public.users where id = auth.uid())), 'null'::jsonb));
      new.snapshot := jsonb_set(new.snapshot, '{rams_reference}',
        coalesce((select to_jsonb(reference) from public.risk_assessments where id = new.risk_assessment_id), 'null'::jsonb));
      new.snapshot := jsonb_set(new.snapshot, '{rams_revision}',
        coalesce((select to_jsonb(revision_number) from public.risk_assessments where id = new.risk_assessment_id), 'null'::jsonb));
      new.snapshot := jsonb_set(new.snapshot, '{permit_reference}',
        coalesce((select to_jsonb(reference) from public.permits_to_work where id = new.permit_to_work_id), 'null'::jsonb));
      -- A permit status claim with no permit linked is a fabrication — strip it.
      if new.permit_to_work_id is null then
        new.snapshot := jsonb_set(new.snapshot, '{permit_status_at_issue}', 'null'::jsonb);
      end if;

      -- Allowlist: only worker-safe keys (mirrors TOOLBOX_TALK_SNAPSHOT_KEYS).
      if exists (
        select 1 from jsonb_object_keys(new.snapshot) as snap_key
        where snap_key <> all (array[
          'talk_reference','revision','talk_date','location','site_label','delivered_by',
          'topic','key_points','ppe','rams_reference','rams_revision','permit_reference',
          'permit_status_at_issue','external_attendees','attendance_note','attendee_count',
          'issued_by_name','issued_on'])
      ) then
        raise exception 'the evidence snapshot carries an unexpected field';
      end if;
    end if;
  end if;

  return new;
end $$;

-- Toolbox Talks — post-release-audit authz + snapshot-integrity hardening.
--
-- A 16-agent independent production-release audit of the whole wave (20261025–29)
-- re-examined the DB as the SOLE backstop against a crafted PostgREST/RPC write by an
-- authenticated org member (the base UPDATE RLS on toolbox_talks is org-member-only,
-- no status gate — the triggers, not RLS and not the server action's .eq("status",
-- "draft"), are the boundary). It surfaced a convergent cluster the earlier 5-agent
-- pass missed. Closed here (all JWT-gated; the trusted service role — fixtures /
-- migrations, never shipped to the browser — stays exempt, exactly as born-draft /
-- issue-gate / provenance-pin already are):
--
--   [P0] draft -> superseded/withdrawn bypassed the ENTIRE issue gate. tg_tt_a_lifecycle
--        gated only draft->issued; tg_tt_m_immutable early-returns on old.status='draft'.
--        So one crafted PATCH ({status:'superseded', reference, issued_at:<backdated>,
--        issued_by:<spoofed>, snapshot:<forged>}) on a member's own draft minted a
--        PDF-renderable "evidence" record with a backdated issue date, a spoofed issuer,
--        and a forged body — none reachable through the honest flow. A draft may now
--        ONLY be delivered (->issued, through the pinned gate) or edited (->draft).
--
--   [P1] The frozen snapshot (the PDF body) was caller-authored and never checked
--        against the record it claims to freeze. A member could call the revision RPC —
--        or craft a draft->issued PATCH — with a snapshot whose reference/revision/topic
--        disagree with the row, so the distributed PDF misrepresents the briefing. The
--        snapshot's identity + core content are now bound to the row at issue.
--
--   [P1] Superseding / withdrawing delivered evidence, and raising / issuing a revision,
--        were gated ONLY in the server action (isManager). A non-manager member could
--        neutralise a live briefing org-wide — irreversibly (terminal states) — via a
--        direct PATCH/RPC. Now DB-enforced with is_org_admin (= role in owner/admin,
--        byte-identical to the app's isManager), so no legitimate owner/admin is affected.
--
--   [P2] The frozen snapshot column is bare jsonb; the worker-safe allowlist lived only
--        in TypeScript. A crafted write could inject cost/rate/PII/email into distributed
--        evidence. The allowlist (TOOLBOX_TALK_SNAPSHOT_KEYS) is now enforced at issue.
--
--   [P3] `id` was absent from the immutable frozen tuple — a crafted PK update on a
--        non-root revision could orphan its acknowledgements. Added.
--
-- Deliberately NOT added: a `check (status='draft' or snapshot is not null)` table
-- invariant. After the [P0] fix a JWT caller cannot reach any non-draft state except
-- through the issue gate (which already requires a non-null snapshot), so that CHECK
-- would only constrain the trusted service role and would break fixtures that seed
-- issued rows directly — pure cost, no JWT-reachable gain. The trusted-role asymmetry
-- is intentional and preserved throughout.
--
-- Additive + reversible: CREATE OR REPLACE of four existing functions only (no schema
-- change, no data change; prod has 0 rows regardless). Rollback = restore the 20261029
-- (a_lifecycle, m_immutable) / 20261025 (revision_integrity) / 20261027 (RPC) bodies.

-- ---------------------------------------------------------------------------
-- 1. Lifecycle: only-issue-out-of-draft [P0], snapshot content binding [P1],
--    snapshot allowlist [P2]. Body otherwise identical to 20261029.
-- ---------------------------------------------------------------------------
create or replace function public.tg_tt_a_lifecycle()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Born a draft: no INSERT may mint an issued record (unconditional — service role too).
  if tg_op = 'INSERT' and new.status <> 'draft' then
    raise exception 'a toolbox talk is created as a draft, then issued';
  end if;

  -- All JWT (browser) transitions OUT of draft funnel through here; auth.uid() null =
  -- trusted service role (fixtures/migrations), exempt and keeps explicit values.
  if tg_op = 'UPDATE' and old.status = 'draft' and auth.uid() is not null then
    -- [P0] A draft may ONLY be delivered (->issued) or keep being edited (->draft).
    -- draft->superseded/withdrawn would skip the entire issue gate below (no provenance
    -- pin, no snapshot requirement, no content binding), enabling single-request
    -- fabrication of backdated, misattributed, PDF-renderable evidence. Slammed shut.
    if new.status not in ('draft', 'issued') then
      raise exception 'a draft toolbox talk can only be delivered (issued), not moved directly to %', new.status;
    end if;

    if new.status = 'issued' then
      if new.topic is null or length(trim(new.topic)) = 0
         or new.key_points is null or length(trim(new.key_points)) = 0 then
        raise exception 'a toolbox talk needs a topic and key points before it can be delivered';
      end if;
      -- The frozen evidence snapshot must be written IN the issue transition (never later).
      if new.snapshot is null then
        raise exception 'a toolbox talk must be delivered with its evidence snapshot';
      end if;
      -- [P1] Bind the caller-authored snapshot to THE RECORD IT CLAIMS TO FREEZE. The
      -- snapshot is the PDF body; without this a member could issue (first delivery or the
      -- JWT revision RPC, both promote through here) with a snapshot whose reference /
      -- revision / topic disagree with the row, so the distributed PDF lies about what
      -- was briefed. Identity + core safety content are pinned to the row.
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
      -- [P2] The frozen evidence may carry ONLY worker-safe allowlist keys — this list
      -- MIRRORS TOOLBOX_TALK_SNAPSHOT_KEYS in lib/toolbox-talks/snapshot.ts and MUST stay
      -- in sync (a divergence fails an honest issue loudly, never silently). No crafted
      -- cost/rate/margin/PII/email key can enter the record distributed to workers.
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
      new.issued_by := auth.uid();
      new.issued_at := now();
    end if;
  end if;

  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Immutable-on-issue: owner/admin gate on the terminal transitions [P1] +
--    `id` in the frozen tuple [P3]. Body otherwise identical to 20261029.
-- ---------------------------------------------------------------------------
create or replace function public.tg_tt_m_immutable()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'draft' then
    return new;  -- drafts are freely editable (the ->issued gate lives in a_lifecycle)
  end if;

  if new.status is distinct from old.status then
    if old.status = 'issued' and new.status in ('superseded', 'withdrawn') then
      -- [P1] Superseding or withdrawing DELIVERED evidence is an owner/admin action
      -- (is_org_admin = role in owner/admin = the app's isManager). The DB is the real
      -- boundary: otherwise a non-manager member could neutralise a live briefing
      -- org-wide via a crafted PATCH — irreversibly, since these states are terminal.
      -- JWT-gated; service role (fixtures/migrations) exempt. Also gates the revision
      -- RPC's supersede step for a non-manager who calls it directly.
      if auth.uid() is not null and not public.is_org_admin(new.org_id) then
        raise exception 'only an owner or admin can supersede or withdraw delivered evidence';
      end if;
    else
      raise exception 'invalid toolbox talk status transition % -> %', old.status, new.status;
    end if;
  end if;

  if old.snapshot is not null and new.snapshot is distinct from old.snapshot then
    raise exception 'the toolbox talk evidence snapshot is frozen once set';
  end if;

  -- [P3] `id` is now frozen: a crafted PK update on a non-root revision would otherwise
  -- pass this trigger (id absent) and revision-integrity (root still resolves), orphaning
  -- that revision's acknowledgements and 404-ing its evidence at the old id.
  if (new.id, new.topic, new.key_points, new.location, new.ppe, new.talk_date, new.presenter,
      new.attendees, new.attendee_count, new.notes,
      new.job_id, new.risk_assessment_id, new.permit_to_work_id, new.reference,
      new.issued_at, new.issued_by, new.supersedes_id, new.root_toolbox_talk_id,
      new.revision_number, new.org_id, new.created_by, new.created_at)
     is distinct from
     (old.id, old.topic, old.key_points, old.location, old.ppe, old.talk_date, old.presenter,
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
-- 3. Revision lineage: owner/admin gate on raising a revision (rev >= 2) [P1].
--    Body otherwise identical to 20261025.
-- ---------------------------------------------------------------------------
create or replace function public.tg_tt_revision_integrity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and new.root_toolbox_talk_id is null then
    new.root_toolbox_talk_id := new.id;
  end if;

  -- [P1] Raising a revision (rev >= 2, or explicitly superseding a prior) is an
  -- owner/admin action — mirrors createToolboxTalkRevision's app gate at the DB
  -- boundary. First delivery (rev 1) stays open to a foreman. JWT-gated; service
  -- role exempt. Placed here because this trigger owns revision-lineage integrity.
  if tg_op = 'INSERT' and auth.uid() is not null
     and (new.revision_number > 1 or new.supersedes_id is not null)
     and not public.is_org_admin(new.org_id) then
    raise exception 'only an owner or admin can raise a toolbox talk revision';
  end if;

  if new.root_toolbox_talk_id <> new.id
     and not exists (select 1 from public.toolbox_talks
                     where id = new.root_toolbox_talk_id and org_id = new.org_id) then
    raise exception 'revision series root % is not a toolbox talk in this organisation', new.root_toolbox_talk_id;
  end if;

  if new.supersedes_id is not null then
    if new.supersedes_id = new.id then
      raise exception 'a toolbox talk cannot supersede itself';
    end if;
    if not exists (select 1 from public.toolbox_talks
                   where id = new.supersedes_id and org_id = new.org_id
                     and root_toolbox_talk_id = new.root_toolbox_talk_id) then
      raise exception 'supersedes_id must be another revision of the same series in this organisation';
    end if;
  end if;

  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Revision issue RPC: owner/admin gate at the DB boundary [P1]. Body otherwise
--    identical to 20261027 (snapshot still set atomically; reference still DB-computed).
-- ---------------------------------------------------------------------------
create or replace function public.issue_toolbox_talk_revision(p_id uuid, p_snapshot jsonb)
returns text language plpgsql security invoker set search_path = public as $$
declare
  v_root uuid;
  v_rev  integer;
  v_status text;
  v_org uuid;
  v_base text;
  v_newref text;
begin
  select root_toolbox_talk_id, revision_number, status, org_id
    into v_root, v_rev, v_status, v_org
  from public.toolbox_talks where id = p_id for update;

  if v_root is null then raise exception 'toolbox talk % not found', p_id; end if;
  -- [P1] Issuing a revision is an owner/admin action (mirrors issueToolboxTalkRevision).
  -- Enforced here; the m_immutable supersede gate independently backstops the supersede
  -- step. JWT-gated; service role exempt.
  if auth.uid() is not null and not public.is_org_admin(v_org) then
    raise exception 'only an owner or admin can issue a toolbox talk revision';
  end if;
  if v_status <> 'draft' then raise exception 'only a draft revision can be issued (status %)', v_status; end if;
  if v_rev < 2 then raise exception 'the first issue of a series uses the standard issue flow, not a revision'; end if;

  select reference into v_base
  from public.toolbox_talks where root_toolbox_talk_id = v_root and revision_number = 1;
  if v_base is null then raise exception 'the series has no issued origin revision to number against'; end if;
  v_newref := v_base || '-R' || lpad(v_rev::text, 2, '0');

  update public.toolbox_talks set status = 'superseded'
   where root_toolbox_talk_id = v_root and status = 'issued';

  update public.toolbox_talks
     set status = 'issued', reference = v_newref, issued_at = now(), issued_by = auth.uid(), snapshot = p_snapshot
   where id = p_id;

  return v_newref;
end $$;
grant execute on function public.issue_toolbox_talk_revision(uuid, jsonb) to authenticated;

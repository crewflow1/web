-- Toolbox Talks M3 — atomic revision issue freezes the evidence snapshot.
--
-- M1 (20261025) shipped issue_toolbox_talk_revision(uuid): supersede the current
-- issued revision + promote the draft, race-safe via FOR UPDATE + the one-current
-- partial unique index. But a toolbox talk's evidence is a FROZEN JSON snapshot
-- (unlike RAMS, which renders live) — so promoting a revision must also write the
-- point-in-time snapshot IN THE SAME TRANSACTION, or the new current revision would
-- momentarily exist as issued evidence with a null snapshot.
--
-- The snapshot is application-denormalised (RAMS/permit references, site label,
-- names) so it is built in the server action and passed in. This migration widens
-- the RPC to accept it and sets it atomically with the promotion. The reference is
-- still computed server-side in the RPC (authoritative, race-safe) — the caller
-- cannot forge it. Additive: drop the old 1-arg signature, add the 2-arg one.

drop function if exists public.issue_toolbox_talk_revision(uuid);

create or replace function public.issue_toolbox_talk_revision(p_id uuid, p_snapshot jsonb)
returns text language plpgsql security invoker set search_path = public as $$
declare
  v_root uuid;
  v_rev  integer;
  v_status text;
  v_base text;
  v_newref text;
begin
  select root_toolbox_talk_id, revision_number, status
    into v_root, v_rev, v_status
  from public.toolbox_talks where id = p_id for update;

  if v_root is null then raise exception 'toolbox talk % not found', p_id; end if;
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

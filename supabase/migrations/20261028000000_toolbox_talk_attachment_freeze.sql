-- Toolbox Talks M5 — signed-sheet / photo evidence is append-only once delivered.
--
-- THREAT (from the epic's evidence-integrity review): a manager delivers a talk
-- with a photographed sign-off sheet (Photo A), then later DELETES Photo A and
-- uploads Photo B — silently rewriting the historical evidence. The talk body is
-- already frozen (tg_tt_m_immutable) and acknowledgements are append-only, but the
-- tenant_attachments row was still freely deletable/replaceable.
--
-- FIX: a trigger on tenant_attachments blocks DELETE and UPDATE of any attachment
-- whose target is a DELIVERED (issued/superseded/withdrawn) toolbox talk — for
-- EVERY role, RLS-independent. Evidence is APPEND-ONLY: new files can still be
-- added to a delivered talk (upload the paper sheet after briefing), but nothing
-- already attached can be removed or repointed. No byte duplication — the existing
-- tenant_attachments storage is reused (cost-neutral).
--
-- Draft talks stay fully mutable (attachments can be managed while composing), and
-- org teardown (cascade) is still permitted — the org row is gone by then.
-- Additive + reversible: drop the trigger + function.

create or replace function public.tg_tenant_attachment_freeze_delivered_toolbox()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_status text;
begin
  -- Only toolbox-talk evidence is governed here; every other target is untouched.
  if old.target_table <> 'toolbox_talks' then
    return old;
  end if;
  -- Allow the org-teardown cascade (the org row is already gone by then).
  if not exists (select 1 from public.organizations where id = old.org_id) then
    return old;
  end if;
  -- Resolve the target talk. A draft (or a talk that no longer exists) is mutable.
  select status into v_status from public.toolbox_talks where id = old.target_id;
  if v_status is null or v_status = 'draft' then
    return old;
  end if;
  -- The talk is delivered → its attached evidence is frozen (add-only).
  raise exception 'evidence attached to a delivered toolbox talk is frozen — add new files, never remove or replace one';
end $$;

drop trigger if exists tenant_attachments_freeze_toolbox on public.tenant_attachments;
create trigger tenant_attachments_freeze_toolbox
  before delete or update on public.tenant_attachments
  for each row execute function public.tg_tenant_attachment_freeze_delivered_toolbox();

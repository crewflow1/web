-- Completion-time lead reconciliation — ATOMIC + reference-preserving.
--
-- When a voice call's PROVISIONAL origination lead is found to concern the SAME
-- project as an existing open lead (proven at completion), we merge it into that
-- lead and remove the duplicate. Doing this as several separate statements from the
-- app risked (a) ORPHANING references whose FK is ON DELETE SET NULL (quotes,
-- ai_quote_drafts, conversations), and (b) a PARTIAL-FAILURE split if one statement
-- failed between the re-link and the delete.
--
-- This function performs the whole merge in ONE transaction (a plpgsql body is
-- atomic): every reference is migrated to the target FIRST, notes are folded in, the
-- origination notification is cleared, and only then is the provisional lead deleted.
-- If anything raises, the whole merge rolls back — no data loss, no orphaned call, no
-- split state. It is ORG-PINNED on every statement and is a tenant-safe NO-OP for a
-- cross-org or missing lead. Call history (call_events, keyed by call_id) and audit
-- rows (no FK to leads) are preserved automatically — the call is re-pointed and the
-- audit is immutable history that correctly records what happened.
--
-- SERVICE-ROLE ONLY: invoked solely by the server admin client in the voice
-- completion path. EXECUTE is revoked from PUBLIC/anon/authenticated, so it is never
-- reachable across the client trust boundary and needs no current_org_ids() in-body
-- guard (it pins p_org_id on every statement regardless).
--
-- Rollback (manual):
--   drop function if exists public.reconcile_provisional_voice_lead(uuid, text, uuid, uuid, uuid);

create or replace function public.reconcile_provisional_voice_lead(
  p_org_id uuid,
  p_provider_call_id text,
  p_enquiry_id uuid,
  p_provisional_lead_id uuid,
  p_target_lead_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prov_org uuid;
  v_target_org uuid;
  v_deleted integer;
begin
  -- No-op guards: the two leads must be DISTINCT and BOTH live in p_org_id. A missing
  -- or cross-org lead ⇒ touch nothing and report "not merged" (tenant-safe).
  if p_provisional_lead_id is null or p_target_lead_id is null
     or p_provisional_lead_id = p_target_lead_id then
    return false;
  end if;
  select org_id into v_prov_org from public.leads where id = p_provisional_lead_id;
  select org_id into v_target_org from public.leads where id = p_target_lead_id;
  if v_prov_org is null or v_target_org is null
     or v_prov_org <> p_org_id or v_target_org <> p_org_id then
    return false;
  end if;

  -- 1. Migrate every reference from the provisional lead to the target (org-pinned), so
  --    nothing attached to the provisional is lost when it is removed.
  update public.calls
     set lead_id = p_target_lead_id
   where org_id = p_org_id
     and provider_call_id = p_provider_call_id
     and (lead_id = p_provisional_lead_id or lead_id is null);

  update public.inbound_enquiries
     set lead_id = p_target_lead_id
   where id = p_enquiry_id and org_id = p_org_id;

  update public.quotes
     set lead_id = p_target_lead_id
   where lead_id = p_provisional_lead_id and org_id = p_org_id;

  update public.ai_quote_drafts
     set lead_id = p_target_lead_id
   where lead_id = p_provisional_lead_id and org_id = p_org_id;

  update public.conversations
     set lead_id = p_target_lead_id
   where lead_id = p_provisional_lead_id and org_id = p_org_id;

  -- 2. Preserve any notes written on the provisional by folding them into the target.
  update public.leads t
     set notes = nullif(concat_ws(E'\n', nullif(t.notes, ''), nullif(p.notes, '')), '')
    from public.leads p
   where t.id = p_target_lead_id and t.org_id = p_org_id
     and p.id = p_provisional_lead_id and p.org_id = p_org_id
     and coalesce(p.notes, '') <> '';

  -- 3. Clear the provisional lead's origination notification (no card to a merged lead).
  delete from public.notifications
   where org_id = p_org_id
     and source_module = 'receptionist'
     and source_id = p_provisional_lead_id::text;

  -- 4. Delete the now-dereferenced provisional lead (lead_followup_state CASCADEs off it).
  delete from public.leads where id = p_provisional_lead_id and org_id = p_org_id;
  get diagnostics v_deleted = row_count;

  return v_deleted > 0;
end;
$$;

-- Trust boundary: server-only. Strip the default PUBLIC EXECUTE and grant service_role.
revoke all on function public.reconcile_provisional_voice_lead(uuid, text, uuid, uuid, uuid) from public;
revoke all on function public.reconcile_provisional_voice_lead(uuid, text, uuid, uuid, uuid) from anon;
revoke all on function public.reconcile_provisional_voice_lead(uuid, text, uuid, uuid, uuid) from authenticated;
grant execute on function public.reconcile_provisional_voice_lead(uuid, text, uuid, uuid, uuid) to service_role;

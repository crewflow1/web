-- Comms records + service catalogue: writes are owner/admin only at the data layer
-- (adversarial tenant-isolation programme — register ST-09; generalisation of INJ-01).
--
-- THE HOLE
-- --------
-- A column-level probe with a real `staff` JWT (every org-scoped table, every column,
-- direct PostgREST PATCH/POST) showed nine tables whose WRITE policies admit any org
-- member although the product gives staff no way to write them:
--
--   messages, conversations, inbound_enquiries, whatsapp_assistant_actions
--       Every in-app writer is behind the `inbox` capability
--       (app/(app)/inbox/**: requireCapabilityFor(ctx, user, "inbox", "create" | "edit" |
--       "approve")) — and a `staff` membership resolves to NO capabilities. Yet a staff
--       JWT could rewrite any message body / direction / status, re-status an enquiry,
--       insert fabricated inbound or outbound messages, and set
--       whatsapp_assistant_actions.status / reviewed_by / review_resolution — i.e. mark
--       an AI-assistant action as reviewed without holding inbox:approve.
--   calls, missed_call_textbacks, voice_notes, lead_followup_state
--       Written only by server code with the service role (telephony / receptionist /
--       lead-followup services). A staff JWT could rewrite a call's transcript,
--       recording_url and ai_summary, and insert fabricated call records.
--   service_catalog
--       The priced service list (default_price, vat_rate). No client writer exists at
--       all; a staff JWT could change prices and insert services.
--
-- These are in-tenant (no cross-org reach) integrity escalations: tampering with the
-- organisation's customer-communication record and a price list by a role the
-- capability model gives no such authority.
--
-- THE FIX
-- -------
-- RESTRICTIVE policies, one per write command, requiring is_org_admin(org_id). As in
-- 20261303000000: restrictive = ANDed with the existing permissive policies, so this
-- can only remove access and drops/alters nothing. READ access is deliberately left as
-- it is (whether staff should read the inbox is a product decision, not made here).
-- service_role (webhooks, telephony, receptionist, crons) bypasses RLS and is
-- unaffected; the SECURITY DEFINER projection trigger on inbound_enquiries runs as the
-- table owner and is unaffected.
--
-- data-api:exempt: policy-only change; adds no table and no grant.
-- Additive, idempotent (drop policy if exists on the NEW policy names only).
--
-- Rollback (manual, not recommended — it reopens ST-09):
--   drop policy "<table>: admin writes only (restrictive <cmd>)" on public.<table>;

do $$
declare
  t text;
  c text;
  pol text;
begin
  foreach t in array array[
    'messages',
    'conversations',
    'inbound_enquiries',
    'whatsapp_assistant_actions',
    'calls',
    'missed_call_textbacks',
    'voice_notes',
    'lead_followup_state',
    'service_catalog'
  ]
  loop
    foreach c in array array['insert', 'update', 'delete']
    loop
      pol := t || ': admin writes only (restrictive ' || c || ')';
      execute format('drop policy if exists %I on public.%I', pol, t);
      if c = 'insert' then
        execute format(
          'create policy %I on public.%I as restrictive for insert to authenticated '
          'with check (public.is_org_admin(org_id))', pol, t);
      elsif c = 'update' then
        execute format(
          'create policy %I on public.%I as restrictive for update to authenticated '
          'using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id))', pol, t);
      else
        execute format(
          'create policy %I on public.%I as restrictive for delete to authenticated '
          'using (public.is_org_admin(org_id))', pol, t);
      end if;
      execute format(
        'comment on policy %I on public.%I is %L', pol, t,
        'ST-09: writes are owner/admin only at the data layer (every in-app writer is '
        'capability-gated or service-role). RESTRICTIVE — can only remove access.');
    end loop;
  end loop;
end $$;

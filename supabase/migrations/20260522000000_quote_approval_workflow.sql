-- Wave 2 — Quote Approval Workflow
--
-- Adds the approval gate: no quote can go to the customer (status 'sent')
-- without first being explicitly approved by an owner or admin. This is
-- the foundation for trusting AI-drafted quotes — AI can DRAFT into
-- 'pending_approval' but never auto-SEND.
--
-- State machine:
--   draft ──► pending_approval ──► approved ──► sent ──► viewed ──► accepted/declined/expired
--                       │
--                       └─► rejected
--
-- Edits to an approved/sent quote revert it to 'pending_approval' so
-- the approver re-confirms the new numbers. Application-layer enforces
-- this; the trigger emits the audit event.

-- New columns
alter table public.quotes
  add column if not exists approved_by uuid references public.users(id) on delete set null,
  add column if not exists approved_at timestamp with time zone,
  add column if not exists approval_comment text;

-- Backfill grandfathered quotes: anything currently past the approval
-- gate (sent and beyond) is treated as having been approved by its
-- creator at send time. Preserves audit continuity.
update public.quotes
   set approved_by = created_by,
       approved_at = COALESCE(sent_at, created_at)
 where status in ('sent', 'viewed', 'accepted', 'declined', 'expired')
   and approved_at is null;

-- Status check constraint — extend with 3 new states
do $$ begin
  if exists (
    select 1 from pg_constraint
    where conname = 'quotes_status_check'
      and conrelid = 'public.quotes'::regclass
  ) then
    alter table public.quotes drop constraint quotes_status_check;
  end if;
end $$;

alter table public.quotes add constraint quotes_status_check check (
  status in (
    'draft',
    'pending_approval',
    'approved',
    'rejected',
    'sent',
    'viewed',
    'accepted',
    'declined',
    'expired'
  )
);

create index if not exists quotes_org_status_idx on public.quotes (org_id, status);

-- Activity trigger update — emit explicit events for the new approval
-- transitions. Keeps all existing cases unchanged.
create or replace function public._tg_quotes_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_signer text;
  v_is_variation boolean := NEW.variation_number is not null;
  v_label text;
begin
  if TG_OP = 'INSERT' then
    v_label := case when v_is_variation then 'variation.created' else 'quote.created' end;
    perform _record_activity(
      NEW.org_id, v_label, 'quotes', NEW.id,
      jsonb_build_object(
        'number', NEW.number, 'total', NEW.total,
        'customer_id', NEW.customer_id, 'lead_id', NEW.lead_id,
        'job_id', NEW.job_id, 'variation_number', NEW.variation_number
      )
    );
    return NEW;
  elsif TG_OP = 'UPDATE' then
    -- Approval workflow transitions (new in Wave 2)
    if NEW.status is distinct from OLD.status then
      -- approved → pending_approval = "changed after approval"
      if OLD.status in ('approved', 'sent', 'viewed') and NEW.status = 'pending_approval' then
        perform _record_activity(
          NEW.org_id, 'quote.changed_after_approval', 'quotes', NEW.id,
          jsonb_build_object(
            'number', NEW.number, 'total', NEW.total,
            'from_status', OLD.status,
            'job_id', NEW.job_id, 'variation_number', NEW.variation_number
          )
        );
      elsif NEW.status = 'pending_approval' then
        perform _record_activity(
          NEW.org_id, 'quote.approval_requested', 'quotes', NEW.id,
          jsonb_build_object(
            'number', NEW.number, 'total', NEW.total,
            'job_id', NEW.job_id, 'variation_number', NEW.variation_number
          )
        );
      elsif NEW.status = 'approved' then
        perform _record_activity(
          NEW.org_id, 'quote.approved', 'quotes', NEW.id,
          jsonb_build_object(
            'number', NEW.number, 'total', NEW.total,
            'approved_by', NEW.approved_by, 'comment', NEW.approval_comment,
            'job_id', NEW.job_id, 'variation_number', NEW.variation_number
          )
        );
      elsif NEW.status = 'rejected' then
        perform _record_activity(
          NEW.org_id, 'quote.rejected', 'quotes', NEW.id,
          jsonb_build_object(
            'number', NEW.number, 'total', NEW.total,
            'reviewed_by', NEW.approved_by, 'comment', NEW.approval_comment,
            'job_id', NEW.job_id, 'variation_number', NEW.variation_number
          )
        );
      end if;
    end if;
    -- Existing transitions (kept)
    if NEW.sent_at is distinct from OLD.sent_at and NEW.sent_at is not null then
      v_label := case when v_is_variation then 'variation.sent' else 'quote.sent' end;
      perform _record_activity(
        NEW.org_id, v_label, 'quotes', NEW.id,
        jsonb_build_object(
          'number', NEW.number, 'total', NEW.total,
          'job_id', NEW.job_id, 'variation_number', NEW.variation_number
        )
      );
    end if;
    if NEW.viewed_at is distinct from OLD.viewed_at and NEW.viewed_at is not null then
      v_label := case when v_is_variation then 'variation.viewed' else 'quote.viewed' end;
      perform _record_activity(
        NEW.org_id, v_label, 'quotes', NEW.id,
        jsonb_build_object(
          'number', NEW.number,
          'job_id', NEW.job_id, 'variation_number', NEW.variation_number
        ),
        'Customer (public link)'
      );
    end if;
    if NEW.accepted_at is distinct from OLD.accepted_at and NEW.accepted_at is not null then
      v_signer := nullif(NEW.accept_signature ->> 'name', '');
      v_label := case when v_is_variation then 'variation.accepted' else 'quote.accepted' end;
      perform _record_activity(
        NEW.org_id, v_label, 'quotes', NEW.id,
        jsonb_build_object(
          'number', NEW.number, 'total', NEW.total,
          'signer', v_signer,
          'source', NEW.accept_signature ->> 'source',
          'job_id', NEW.job_id, 'variation_number', NEW.variation_number,
          'comment', NEW.customer_comment
        ),
        coalesce(v_signer, null)
      );
    end if;
    if NEW.declined_at is distinct from OLD.declined_at and NEW.declined_at is not null then
      v_label := case when v_is_variation then 'variation.declined' else 'quote.declined' end;
      perform _record_activity(
        NEW.org_id, v_label, 'quotes', NEW.id,
        jsonb_build_object(
          'number', NEW.number,
          'job_id', NEW.job_id, 'variation_number', NEW.variation_number,
          'comment', NEW.customer_comment
        )
      );
    end if;
    return NEW;
  end if;
  return null;
end;
$$;

-- Same-org foreign keys for quote_line_items, invoice_reminders and support_messages
-- (adversarial tenant-isolation programme — register ST-01, ST-03, ST-06).
--
-- THE HOLE
-- --------
-- RLS guards the row being WRITTEN (org_id), not the row it POINTS AT. Both tables
-- referenced their parent through a BARE single-column FK:
--
--     quote_line_items.quote_id   -> quotes(id)
--     invoice_reminders.invoice_id -> invoices(id)
--
-- so a member of org A could insert a child with org_id = A (passes RLS) and
-- parent id = <a row of org B> (passes the FK). Org B's users never see such a row —
-- their RLS filters on org_id — but every SERVICE-ROLE reader that loads children
-- "by parent id" bypasses RLS and does:
--
--   * quote_line_items: app/q/[token]/page.tsx, app/q/[token]/pdf/route.ts,
--     lib/email/send-quote.ts, lib/customers/portal-bulk-download.ts. An owner/admin of
--     ANY tenant who knew a victim quote's uuid could add scope lines to the victim's
--     PUBLIC quote page, PDF and quote email. It worked even on an ACCEPTED quote:
--     tg_quote_line_items_freeze_accepted is SECURITY INVOKER, so its
--     `select accepted_at from quotes where id = new.quote_id` ran under the
--     ATTACKER's RLS, saw no row, and let the insert through.
--   * invoice_reminders: app/api/cron/invoice-reminders/route.ts decides "already
--     reminded?" from `invoice_reminders where stage = … and invoice_id in (…)`. ANY
--     member of any tenant (the INSERT policy is member-wide) could pre-plant rows for
--     a victim invoice and silence its day-3/7/14/21 reminders; the partial unique
--     index (invoice_id, stage) then also blocked the legitimate insert.
--
-- Both were listed in the INTERNAL_RLS allowlist of
-- __tests__/integration/rls/cross-tenant-fk-completeness.test.ts as "not reachable via
-- a public/service-role parent-embed". That justification was wrong for these two.
--
-- THE FIX
-- -------
-- The established pattern (invoices #349, invoice_payments #351, jobs/leads
-- 20261112000000, quotes 20261113000000): a COMPOSITE foreign key,
-- (child.<ref>, org_id) -> parent(id, org_id), so "the parent lives in the same org" is
-- a DATABASE invariant no writer — service role included — can bypass. With the child
-- pinned to the parent's org, the freeze trigger's parent read is also always a
-- same-org read, so it can no longer be blinded by RLS.
--
-- STRICTLY ADDITIVE: the composite FK is ADDED ALONGSIDE the existing bare FK, exactly
-- as invoice_payments carries both invoice_payments_invoice_id_fkey and
-- invoice_payments_invoice_org_fkey. Nothing is dropped or altered, so the bare FKs'
-- entries in cross-tenant-fk-completeness.test.ts stay valid and PostgREST embed hints
-- that name the bare constraint keep resolving. The bare FK is now redundant (the
-- composite one implies it) and can be dropped in a later cleanup.
--
-- Both parents already carry the unique (id, org_id) the composite FK needs
-- (quotes_id_org_key from 20261113000000, invoices_id_org_key from #349). ON DELETE
-- CASCADE matches the bare FKs (both CASCADE; both columns NOT NULL).
--
-- PRE-FLIGHT (verified read-only against production 2026-11-13, aggregate counts only):
--   quote_line_items whose quote is in another org:   0
--   invoice_reminders whose invoice is in another org: 0
-- so the new constraints validate cleanly. If a mismatch ever exists the ALTER fails
-- loudly and nothing changes — which is the correct outcome.
--
-- Idempotent (guarded on pg_constraint). Forward-only.
-- data-api:exempt: constraint-only change; widens no client surface, adds no table.
--
-- Rollback (manual, not recommended — it reopens ST-01/ST-03):
--   alter table public.quote_line_items  drop constraint quote_line_items_quote_org_fkey;
--   alter table public.invoice_reminders drop constraint invoice_reminders_invoice_org_fkey;

-- Parent unique keys — already present; asserted here so a fresh database (or one
-- where they were somehow dropped) cannot fail the FK below with an obscure error.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quotes_id_org_key' and conrelid = 'public.quotes'::regclass) then
    alter table public.quotes add constraint quotes_id_org_key unique (id, org_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invoices_id_org_key' and conrelid = 'public.invoices'::regclass) then
    alter table public.invoices add constraint invoices_id_org_key unique (id, org_id);
  end if;
end $$;

-- ── quote_line_items.quote_id ───────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quote_line_items_quote_org_fkey' and conrelid = 'public.quote_line_items'::regclass) then
    alter table public.quote_line_items
      add constraint quote_line_items_quote_org_fkey
      foreign key (quote_id, org_id)
      references public.quotes (id, org_id)
      on delete cascade;
  end if;
end $$;

comment on constraint quote_line_items_quote_org_fkey on public.quote_line_items is
  'Tenant integrity: a quote line may belong only to a quote in the SAME org. RLS '
  'cannot enforce this — it guards the row being written, not the quote it points at — '
  'and the public /q/[token] page, quote PDF and quote email read lines by quote_id '
  'with the service role. Sits alongside the bare quote_line_items_quote_id_fkey (ST-01).';

-- ── invoice_reminders.invoice_id ────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'invoice_reminders_invoice_org_fkey' and conrelid = 'public.invoice_reminders'::regclass) then
    alter table public.invoice_reminders
      add constraint invoice_reminders_invoice_org_fkey
      foreign key (invoice_id, org_id)
      references public.invoices (id, org_id)
      on delete cascade;
  end if;
end $$;

comment on constraint invoice_reminders_invoice_org_fkey on public.invoice_reminders is
  'Tenant integrity: a reminder row may reference only an invoice in the SAME org. The '
  'reminder cron decides "already reminded?" by invoice_id with the service role, so a '
  'foreign-org row could silence another tenant''s reminders. Sits alongside the bare '
  'invoice_reminders_invoice_id_fkey (ST-03).';


-- ════════════════════════════════════════════════════════════════════════════
-- PART 2 — support_messages.ticket_id (register ST-06). Same class, same fix; kept in
-- this migration so the three same-org foreign keys ship and roll back together.
-- ════════════════════════════════════════════════════════════════════════════
--
-- Same-org foreign key for support_messages.ticket_id
-- (adversarial tenant-isolation programme — register ST-06).
--
-- THE HOLE
-- --------
-- support_messages.ticket_id -> support_tickets(id) was a BARE single-column FK and the
-- INSERT policy is member-wide (org_id in current_org_ids(), author_kind in
-- ('customer','org')). So ANY member of org A — staff included — who knew a ticket uuid
-- of org B could insert a message with org_id = A, ticket_id = <B's ticket>. Two
-- consequences, both proven against the local stack:
--
--   1. A CROSS-TENANT WRITE. _support_messages_after_insert() is SECURITY DEFINER and
--      runs `update support_tickets set last_reply_at, last_reply_kind, status …
--      where id = new.ticket_id` with no org check — so the foreign message rewrote org
--      B's ticket (open → in_progress → waiting_on_customer, or re-opened it).
--   2. CONTENT INJECTION into org B's customer portal. The portal thread list
--      (app/customer-portal/[token]/messages/page.tsx) embeds
--      `last_message:support_messages!support_messages_ticket_id_fkey(body, …)` with the
--      service role, i.e. messages by ticket id regardless of org.
--
-- THE FIX
-- -------
-- The composite same-org FK (support_messages.ticket_id, org_id) ->
-- support_tickets(id, org_id), the established pattern (see 20261301000000). The
-- definer trigger can then only ever touch a ticket in the message's own org, which is
-- an org the writer passed RLS for.
--
-- STRICTLY ADDITIVE: adds a unique (id, org_id) on support_tickets (id is already the
-- primary key, so this cannot fail on data) and ADDS the composite FK alongside the
-- bare one. The bare FK is kept because the portal embed names it explicitly as its
-- relationship hint. Every writer already stamps the ticket's own org_id
-- (app/(app)/support/actions.ts, app/admin/support/actions.ts,
-- app/customer-portal/_*-action.ts), so no code change is needed.
--
-- PRE-FLIGHT (read-only against production 2026-11-13, aggregate counts only):
--   support_messages whose ticket is in another org: 0 (table empty).
--
-- data-api:exempt: constraint-only change; widens no client surface, adds no table.
-- Idempotent (guarded on pg_constraint). Forward-only.
--
-- Rollback (manual, not recommended — it reopens ST-06):
--   alter table public.support_messages drop constraint support_messages_ticket_org_fkey;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'support_tickets_id_org_key' and conrelid = 'public.support_tickets'::regclass) then
    alter table public.support_tickets add constraint support_tickets_id_org_key unique (id, org_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'support_messages_ticket_org_fkey' and conrelid = 'public.support_messages'::regclass) then
    alter table public.support_messages
      add constraint support_messages_ticket_org_fkey
      foreign key (ticket_id, org_id)
      references public.support_tickets (id, org_id)
      on delete cascade;
  end if;
end $$;

comment on constraint support_messages_ticket_org_fkey on public.support_messages is
  'Tenant integrity: a support message may belong only to a ticket in the SAME org. '
  'The definer trigger _support_messages_after_insert updates the ticket by id, and the '
  'customer portal embeds messages by ticket id with the service role — so a foreign-org '
  'message was a cross-tenant write + content injection. Sits alongside the bare '
  'support_messages_ticket_id_fkey (ST-06).';

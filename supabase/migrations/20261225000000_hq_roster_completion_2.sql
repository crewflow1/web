-- HQ roster completion, wave 2 — the tenant-domain (product-mapped) cohort
-- (L10, roadmap/final-completion; ADR 0012).
--
-- Seeds the ELEVEN specified-but-missing AI-employee identities from the
-- workforce bible (docs/bible/workforce/employees/ #27–#37, excluding the
-- already-seeded voice-receptionist #26): whatsapp-ai, email-ai, scheduler-ai,
-- quote-writer-ai, cashflow-ai, payroll-ai, business-coach-ai, site-manager-ai,
-- blueprint-ai, procurement-ai, intelligence-ai.
--
-- THE HONEST SHAPE — product-mapped identities, seeded DARK:
--   • status 'disabled': no runner exists for any of these, and none is being
--     built here. Their FUNCTIONS already live as product engines that tenants
--     use today; each description records exactly which engine serves the
--     function, so the registry entry is a truthful map, not a promise.
--   • NO Capability Registry grants are seeded: the registry's default-deny
--     floor is the correct served posture for an identity with no runner
--     (approval level renders from the floor, which is honest).
--   • NO model_provider / model_name: registered, not wired.
--   • manager_slug carried on the insert, per the canonical management graph
--     (docs/bible/workforce/relationships.md §2): channels → support-ai; money
--     functions → finance-ai; construction ops → operations-ai (blueprint-ai →
--     site-manager-ai); business-coach-ai → coo-ai; intelligence-ai → cto-ai.
--
-- Departments are drawn ONLY from the existing ai_employees.department CHECK
-- set (support / operations / finance / engineering) — no constraint changes.
-- Sort orders continue the existing sequence (roster max was 300).
--
-- Idempotent: `on conflict (slug) do nothing`, plus a NULL-only manager
-- backfill for rows that might pre-exist without one. Rollback:
--   delete from public.ai_employees where slug in (…the eleven slugs…);

insert into public.ai_employees
  (name, slug, role, department, description, icon, accent, status,
   memory_scope, manager_slug, sort_order)
values
  ('WhatsApp AI', 'whatsapp-ai',
   'WhatsApp channel — inbound triage and draft-first replies',
   'support',
   'Registry identity for the WhatsApp channel function. Maps to the live WhatsApp assistant engine (channel-agnostic inbound foundation: webhook intake, conversation threading, draft-first replies — outbound stays dark). No dedicated runner; the product engine serves this function today.',
   'life-buoy', 'emerald', 'disabled', 'department', 'support-ai', 310),

  ('Email AI', 'email-ai',
   'Email channel — inbound handling and drafted responses',
   'support',
   'Registry identity for the email channel function. Maps to the live email pipeline (inbound webhook handling, customer-statement and CIS-statement emailing, drafted comms with human send). No dedicated runner; the product engines serve this function today.',
   'life-buoy', 'sky', 'disabled', 'department', 'support-ai', 320),

  ('Scheduler AI', 'scheduler-ai',
   'Workforce scheduling — rota and assignment optimisation',
   'operations',
   'Registry identity for the scheduling function. Maps to the live deterministic rota solver and scheduling engine (shift planning, assignment, conflict detection) — computed, not generated. No dedicated runner; the product engine serves this function today.',
   'compass', 'cyan', 'disabled', 'department', 'operations-ai', 330),

  ('Quote Writer AI', 'quote-writer-ai',
   'Quote drafting — priced build-ups for human review',
   'finance',
   'Registry identity for the quote-writing function. Maps to the AI quote writer engine (governed quote.writer_draft feature, draft-only into ai_quote_drafts, injection-contained, currently dark pending provider activation). No dedicated runner; the product engine serves this function.',
   'banknote', 'amber', 'disabled', 'department', 'finance-ai', 340),

  ('Cashflow AI', 'cashflow-ai',
   'Cash position — forecasting and cash-health signals',
   'finance',
   'Registry identity for the cashflow function. Maps to the live cash engine and company-health briefing (money-in/money-out position, aged ledgers, cash signals in the daily brief) — derived from real ledgers, nothing invented. No dedicated runner; the product engines serve this function today.',
   'trending-up', 'green', 'disabled', 'department', 'finance-ai', 350),

  ('Payroll AI', 'payroll-ai',
   'Payroll — pay-run preparation and cost estimates',
   'finance',
   'Registry identity for the payroll function. Maps to the live payroll engine (timesheet-driven pay-run preparation, CIS deductions, payroll cost estimates — estimates exclude employer NI/pension and are labelled as such). No dedicated runner; the product engine serves this function today.',
   'banknote', 'indigo', 'disabled', 'department', 'finance-ai', 360),

  ('Business Coach AI', 'business-coach-ai',
   'Business coaching — performance signals and guidance drafts',
   'operations',
   'Registry identity for the business-coaching function. Maps to the live company-health and briefing engines (KPI trends, risk flags, plain-English guidance drafted for the owner). No dedicated runner; the product engines serve this function today.',
   'compass', 'violet', 'disabled', 'organization', 'coo-ai', 370),

  ('Site Manager AI', 'site-manager-ai',
   'Site operations — progress, reports and site compliance',
   'operations',
   'Registry identity for the site-management function. Maps to the live jobs/site engines (site reports, delay events, toolbox talks, RAMS and permit workflows, job programme). No dedicated runner; the product engines serve this function today.',
   'compass', 'amber', 'disabled', 'department', 'operations-ai', 380),

  ('Blueprint AI', 'blueprint-ai',
   'Blueprints — drawing management, pins and take-off support',
   'operations',
   'Registry identity for the blueprint function. Maps to the live Blueprint Centre (drawing versions, pins, markup, pin photos/comments, offline reading). No dedicated runner; the product engine serves this function today.',
   'book-open', 'blue', 'disabled', 'department', 'site-manager-ai', 390),

  ('Procurement AI', 'procurement-ai',
   'Procurement — materials, stock and supplier ordering',
   'operations',
   'Registry identity for the procurement function. Maps to the live materials/stock engines (material requests, warehouse stock, GRN receipting, fulfilment, purchase workflows). No dedicated runner; the product engines serve this function today.',
   'settings-2', 'slate', 'disabled', 'department', 'operations-ai', 400),

  ('Intelligence AI', 'intelligence-ai',
   'Company intelligence — synthesised signals for decisions',
   'engineering',
   'Registry identity for the intelligence function (AI Platform division). Maps to the live intelligence/insights engines (governed embeddings, AI insights, weather intelligence pipeline, intelligence briefing) — synthesis over real signals only. No dedicated runner; the product engines serve this function today.',
   'trending-up', 'fuchsia', 'disabled', 'organization', 'cto-ai', 410)
on conflict (slug) do nothing;

-- If any of the eleven pre-existed WITHOUT a manager (e.g. hand-seeded in an
-- environment), fill the documented line — NULLs only, never an operator edit.
update public.ai_employees e
   set manager_slug = v.manager
  from (values
    ('whatsapp-ai',      'support-ai'),
    ('email-ai',         'support-ai'),
    ('scheduler-ai',     'operations-ai'),
    ('quote-writer-ai',  'finance-ai'),
    ('cashflow-ai',      'finance-ai'),
    ('payroll-ai',       'finance-ai'),
    ('business-coach-ai','coo-ai'),
    ('site-manager-ai',  'operations-ai'),
    ('blueprint-ai',     'site-manager-ai'),
    ('procurement-ai',   'operations-ai'),
    ('intelligence-ai',  'cto-ai')
  ) as v(slug, manager)
 where e.slug = v.slug
   and e.manager_slug is null
   and exists (select 1 from public.ai_employees m where m.slug = v.manager);

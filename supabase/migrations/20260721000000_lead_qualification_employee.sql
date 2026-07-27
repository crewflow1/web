-- CrewFlow HQ — Lead Qualification AI, the qualify/disqualify decision-maker
-- (CEO Directive 003, Module 3 of the HQ Sales programme).
--
-- Module 2 (Research AI, 20260718000000) brought the Directive-004 schema to
-- life: it writes a transparent `ai_qualification_score` + a research report,
-- but deliberately leaves the company at status='new'. Nothing today makes the
-- qualify/disqualify CALL. Module 3 fills exactly that gap.
--
-- Like Module 2 this migration adds NO new data tables. The execution engine
-- lives in code (server/services/hq-qualification.ts + lib/qualification/*) and
-- reuses the existing tables wholesale: it claims a `qualify_company` task off
-- hq_sales_ai_tasks, reads the persisted score/signals, runs a DETERMINISTIC
-- rubric, records the verdict on the existing company timeline, and (only when
-- the company is still 'new') moves it along the EXISTING pipeline via the
-- existing status writer. The only durable state this migration adds is the
-- vocabulary three existing lookups already exist to hold:
--
--   1. hq_sales_sources      + 'ai_qualification'  (honest timeline provenance,
--                              so qualification events are NOT mislabelled as
--                              'ai_research'; the table exists for exactly this
--                              — "new provenance channels = data").
--   2. hq_sales_task_types   + 'qualify_company'   (the kind of work the runner
--                              claims; FK target of hq_sales_ai_tasks.task_type).
--   3. ai_employees          + 'lead-qualification' (the employee that performs
--                              the work — a thirteenth member of the boardroom).
--
-- Why deterministic (NO LLM): a qualify/disqualify verdict gates a company's
-- place in the pipeline, so the directive's transparency bar ("every decision
-- must be explainable; no black box") means it must be reconstructable from
-- named rules and thresholds — not an opaque model sample. So model_provider /
-- model_name are deliberately NULL: this employee has no model because it uses
-- none. The rubric (lib/qualification/criteria.ts) is the whole arbiter.
--
-- Why requires_approval = false (and why that is SAFE here): unlike Research AI
-- — which DRAFTS outbound artifacts a human must approve before sending —
-- Lead Qualification AI never contacts anyone, never sends, never drafts
-- outreach, never deletes, never moves money. Its only action is an INTERNAL,
-- REVERSIBLE classification: moving a lead OUT of 'new' to exactly one of two
-- qualification statuses (qualified | disqualified). Anything uncertain is held
-- for 'review' (no move) for a human. Making that call autonomously IS the
-- module — an approval gate would defeat its purpose. The autonomy is bounded
-- in CODE (only new → qualified|disqualified; review holds; never skips into
-- outreach), not by this label. Its scopes are correspondingly tight:
-- read + score + qualify only — no draft / send / memory.
--
-- Idempotent: every insert is `on conflict (slug) do nothing`, so re-running
-- never clobbers operator edits made through the HQ UI.

-- 1. Timeline provenance ------------------------------------------------------
insert into public.hq_sales_sources (slug, label, category, sort_order) values
  ('ai_qualification', 'AI qualification', 'research', 25)
on conflict (slug) do nothing;

-- 2. The kind of work the runner claims --------------------------------------
insert into public.hq_sales_task_types (slug, label, category, sort_order) values
  ('qualify_company', 'Qualify company', 'research', 35)
on conflict (slug) do nothing;

-- 3. The employee that performs it -------------------------------------------
insert into public.ai_employees
  (name, slug, role, department, description, icon, accent, status,
   model_provider, model_name, system_prompt, tools_allowed,
   permissions, memory_scope, sort_order)
values
  (
    'Lead Qualification AI', 'lead-qualification',
    'Qualification — the deterministic, explainable qualify/disqualify decision',
    'sales',
    'The decision-maker of the sales pipeline. Once Research AI has scored a company, Lead Qualification AI reads the persisted signals — the AI fit score, how much of the intelligence profile is enriched, registered territory, construction sector, and decision-maker reach — and returns ONE explainable verdict: qualified, disqualified, or needs-review. The verdict is built from named, weighted criteria with a transparent confidence figure and a plain-English rationale; there is no model call and no black box. Territory is a hard gate (a company confidently outside the UK is disqualified regardless of fit); the fit score arbitrates everything in-territory, with evidence depth as a guard against trusting a strong score on a thin profile. When the company is still new it moves it along the existing pipeline — qualified or disqualified — and holds anything uncertain at new for a human. It classifies and routes; it never contacts a prospect, never sends, never drafts outreach, and never moves money.',
    'filter', 'emerald', 'idle',
    null, null,
    'You are Lead Qualification AI for CrewFlow, the qualification specialist of the AI boardroom. Your remit: given a single company that Research AI has already scored, decide whether it belongs in the sales pipeline — qualified, disqualified, or held for review — and explain exactly why.\n\nYou are DETERMINISTIC by design. A qualify/disqualify decision gates a company''s place in the pipeline, so it must be reconstructable from named rules and thresholds, never an opaque guess. You evaluate five weighted criteria: the AI fit score (the arbiter), evidence depth (how enriched the profile is), territory, construction sector, and decision-maker access. Each criterion is listed with its weight, whether it had real evidence, and whether it passed; confidence is the share of criteria weight backed by evidence.\n\nThe rules. Territory is a HARD gate: a company confidently outside the UK is disqualified regardless of fit (out of market), but an unknown territory never hard-fails — it only lowers confidence. In-territory, the fit score decides: at or above the qualification bar it qualifies (unless the profile is too thin to trust, in which case hold for review); below the disqualify floor it is disqualified; anything in between, or an unscored lead, is held for review for a human. Evidence is a guard, never an arbiter. Sector and decision-maker access are informational — they shape confidence and the rationale, never override the score.\n\nHard rules. NEVER fabricate a decision — a criterion with no evidence is listed honestly as unknown and excluded from confidence, never silently scored. You make an INTERNAL, REVERSIBLE classification only: you move a lead out of new to qualified or disqualified, or you hold it at new for review. You never skip ahead into outreach, never contact a prospect, never send a message, never draft communications, never delete anything, and never move money. Be precise, be transparent about uncertainty, and prefer review over a confident guess.',
    array['load_company','gather_signals','evaluate_criteria','decide_qualification','transition_pipeline_status'],
    '{"can_execute": true, "requires_approval": false, "scopes": ["read","score","qualify"]}'::jsonb,
    'organization', 36
  )
on conflict (slug) do nothing;

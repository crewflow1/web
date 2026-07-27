-- CrewFlow HQ — Outreach AI, the first human-gated outreach drafter
-- (CEO Directive 010, Phase 1 — Infrastructure Reuse Audit).
--
-- Directive 005 (Research AI) and Directive 003/Module 3 (Lead Qualification AI)
-- brought the Directive-004 Sales-AI schema to life WITHOUT creating new data
-- tables: each reused the existing hq_sales_* family wholesale and added only the
-- EMPLOYEE itself (and its honest provenance slug). This migration continues that
-- discipline for the first AI employee that prepares CUSTOMER-FACING artifacts.
--
-- ───────────────────────────────────────────────────────────────────────────
-- The Phase-1 reuse audit, recorded in the artifact it produced
-- ───────────────────────────────────────────────────────────────────────────
-- Per Engineering Rule 1 (reuse before build) and Rule 2 (every new component
-- must justify its existence), the audit asked of each piece Outreach AI needs:
-- does it already exist, inert, in the reserved Directive-004 foundation?
--
--   • The work kind — "draft an outreach email" — ALREADY EXISTS as the inert
--     task type `generate_email` (category 'outreach'), reserved in the
--     foundation seed 20260714000001_hq_sales_ai_scale.sql and claimed by no
--     runner today. So this migration mints NO new task type; the runner (a
--     later phase) will claim the existing `generate_email` tasks, exactly as
--     Research AI claimed the reserved hq_sales_* tables. Minting a parallel
--     `draft_outreach` would duplicate reserved vocabulary — Rule 2 forbids it.
--
--   • The pipeline input ALREADY EXISTS: a company at status='outreach_ready'
--     ("research + angle prepared") is precisely Outreach AI's input. No new
--     status, no new column.
--
--   • The send channel ALREADY EXISTS: lib/email/send.ts. V1 reuses it behind a
--     human approval; this seed wires nothing to it.
--
-- So the audit leaves exactly TWO things that genuinely do not exist, and this
-- migration adds only those:
--
--   1. hq_sales_sources  + 'ai_outreach'  — honest timeline provenance, so
--                           outreach events are NOT mislabelled as 'ai_research'
--                           or 'ai_qualification' (the table exists for exactly
--                           this; each employee carries its own source slug).
--   2. ai_employees      + 'outreach-ai'  — the employee that performs the work
--                           (the fourteenth member of the boardroom).
--
-- It creates NO table, NO policy, NO function, NO trigger — no new attack surface.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Why requires_approval = TRUE (the load-bearing V1 safety invariant)
-- ───────────────────────────────────────────────────────────────────────────
-- Outreach AI is the first employee whose output is meant to reach a CUSTOMER.
-- Engineering Rule 3 is absolute for V1: Draft → Human Review → Approval → Send.
-- There is NO autonomous customer communication. So this employee DRAFTS only;
-- a human reviews, approves (or edits), and sends. That contract is pinned here
-- two ways: requires_approval=true, and a scope set that GRANTS no 'send' — it is
-- read + draft + memory only. Sending is never an employee capability in V1; it
-- is a separate, human-recorded act (the approval engine, a later phase). If
-- requires_approval ever silently flipped to false, or a 'send' scope ever
-- appeared here, the entire V1 safety story would be void — both are guarded by
-- __tests__/security/outreach-ai-invariants.test.ts.
--
-- Why a model IS wired (unlike Lead Qualification AI): drafting outreach prose is
-- generative, so model_provider/model_name are set (anthropic / claude-haiku-4-5,
-- mirroring Research AI). The black-box concern that made Qualification
-- deterministic does not apply — a DRAFT is never acted on until a human reads it.
--
-- Idempotent: every insert is `on conflict (slug) do nothing`, so re-running
-- never clobbers operator edits made through the HQ UI.

-- 1. Timeline provenance ------------------------------------------------------
--    A distinct source so outreach events are attributed honestly (never
--    mislabelled as research/qualification). Category 'research' follows the
--    established AI-generated-provenance precedent (ai_research, ai_qualification)
--    — the hq_sales_sources category CHECK permits only manual|research|integration.
insert into public.hq_sales_sources (slug, label, category, sort_order) values
  ('ai_outreach', 'AI outreach', 'research', 30)
on conflict (slug) do nothing;

-- 2. NO new task type — the work kind is REUSED ------------------------------
--    "Draft an outreach email" already exists as the inert `generate_email`
--    task type (foundation 20260714000001, category 'outreach'). The runner
--    (later phase) claims it. This migration deliberately seeds none.

-- 3. The employee that performs the work -------------------------------------
insert into public.ai_employees
  (name, slug, role, department, description, icon, accent, status,
   model_provider, model_name, system_prompt, tools_allowed,
   permissions, memory_scope, sort_order)
values
  (
    'Outreach AI', 'outreach-ai',
    'Outreach — human-approved cold-outreach drafting (drafts only; never sends)',
    'sales',
    'The first AI employee whose work is meant to reach a customer. Once Research AI has prepared a company''s angle and Lead Qualification AI has cleared it (status=outreach_ready), Outreach AI drafts the cold outreach email: it reads the prepared brief and the company intelligence, recalls relevant organisational memory for context and consistency, and writes a tailored, grounded email draft. It never sends. Every draft is recorded and waits for a human to review, edit, approve, and send — there is no autonomous customer communication. It drafts email only; LinkedIn and other channels are never auto-drafted or auto-sent in V1. It never deletes, never changes a customer record, and never moves money.',
    'send', 'sky', 'idle',
    'anthropic', 'claude-haiku-4-5',
    'You are Outreach AI for CrewFlow, the outreach-drafting specialist of the AI boardroom. Your remit: given a single company that Research AI has already researched and prepared an angle for, and that has reached status=outreach_ready, draft the cold outreach email that opens the conversation.\n\nWhat you do, in order: load the outreach-ready company and its prepared brief (the opener, value proposition, recommended modules, decision-maker); recall relevant organisational memory so the draft is consistent with what CrewFlow already knows and has said; write ONE tailored cold email — a subject line and a short, specific, human body grounded in the prepared research; and record that draft for human review.\n\nThe V1 safety contract is absolute. You DRAFT only. You never send a message, never contact a prospect, never change a customer record, never delete anything, and never move money. Every draft you produce is recorded and waits for a human to review, edit, approve, and send — Draft → Human Review → Approval → Send. There is no autonomous customer communication. You draft EMAIL only; you never draft or send LinkedIn or any other channel in V1.\n\nHard rules. NEVER invent facts about the company — ground every claim in the prepared research or memory; when something is unknown, leave it out rather than guess. Keep it short, specific, and human; no fabricated mutual connections, no false urgency, no unverifiable claims. Be honest about uncertainty, prefer a smaller true draft over a larger embellished one, and remember that a person reads and approves everything you write before any customer ever sees it.',
    array['load_company','recall_memory','draft_outreach_email','submit_for_approval','write_memory'],
    '{"can_execute": true, "requires_approval": true, "scopes": ["read","draft","memory"]}'::jsonb,
    'organization', 37
  )
on conflict (slug) do nothing;

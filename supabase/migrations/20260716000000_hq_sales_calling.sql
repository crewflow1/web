-- CrewFlow HQ — AI Calling Centre Foundation (CEO Directive 004, Phase 6).
--
-- The durable record behind the AI Calling Centre: a reusable call-script
-- library, an objection-handling playbook, and a rich per-call record that
-- carries the directive's full shape — recording, transcript, AI summary,
-- sentiment, outcome, duration, and a follow-up. The "call queue" is simply
-- calls in a waiting status, ordered by an indexed priority_rank (exactly
-- how hq_sales_ai_tasks models its own queue).
--
-- FOUNDATION ONLY. No telephony provider, dialler, or transcription engine
-- is wired here. NOTHING in this migration places a call, records audio, or
-- transcribes anything. AI-authorable rows carry the generated_by / model /
-- ai_employee_id traceability triad from day one, and a winning call or
-- objection can be promoted into the Directive-002 Shared Memory Engine via
-- an optional memory_id FK — so every future autonomous action is traceable.
--
-- HQ-ONLY: every table below has RLS ENABLED with NO policies, so only the
-- service-role client can see or touch these rows. This mirrors the existing
-- hq_sales_* tables, the hq_memory* tables, and ai_employee*. NO customer /
-- staff JWT client can ever read the Calling Centre. NO customer-facing
-- surface changes.
--
-- Relationship to existing schema:
--   * hq_sales_ai_tasks already provides the GENERIC AI work queue (a
--     'cold_call' task type exists). A call row may reference the task that
--     spawned it (ai_task_id), but a call stands on its own — a 100k-char
--     transcript belongs in a first-class column, not a task's JSONB bag.
--   * hq_sales_timeline_events already has 'call' / 'call_completed' /
--     'objection_handled' types; a completed call is additionally summarised
--     onto the company timeline by the service layer (the audit trail),
--     while the full artifacts live here.
--
-- Tables:
--   hq_sales_call_scripts  reusable call-script templates (cold/discovery/…)
--   hq_sales_objections    objection → recommended-response playbook
--   hq_sales_calls         per-call record + queue (recording/transcript/…)

-- ---------------------------------------------------------------------
-- 1. Call scripts — the reusable script library the caller (human or, in
--    future, the AI) opens for a given call type. Versioned; status lets a
--    script be drafted, made active, or archived without deletion.
-- ---------------------------------------------------------------------

create table if not exists public.hq_sales_call_scripts (
  id              uuid primary key default gen_random_uuid(),

  name            text not null check (char_length(name) between 1 and 200),
  -- What kind of call this script is written for.
  category        text not null default 'cold_call'
                  check (category in (
                    'cold_call', 'discovery', 'demo', 'follow_up',
                    'gatekeeper', 'closing', 'voicemail', 'objection', 'other'
                  )),
  status          text not null default 'active'
                  check (status in ('draft', 'active', 'archived')),
  version         integer not null default 1 check (version >= 1),

  -- One-line purpose, the opening line, and the full script body.
  summary         text not null default '' check (char_length(summary) <= 2000),
  opening         text not null default '' check (char_length(opening) <= 4000),
  body            text not null default '' check (char_length(body) <= 20000),

  -- Structured aids: key talking points + discovery questions to ask.
  talking_points  text[] not null default '{}',
  questions       text[] not null default '{}',

  -- Who/what this script targets, for "the right script for the call".
  target_persona  text check (target_persona is null or char_length(target_persona) <= 200),
  target_status   text check (target_status is null or char_length(target_status) <= 60),
  estimated_duration_seconds integer
                  check (estimated_duration_seconds is null or estimated_duration_seconds >= 0),

  tags            text[] not null default '{}',
  -- Times this script has been attached to a call (foundation: stays 0).
  usage_count     integer not null default 0 check (usage_count >= 0),

  -- Traceability — a script can be AI-drafted.
  generated_by    text not null default 'human'
                  check (generated_by in ('ai', 'human')),
  model           text check (model is null or char_length(model) <= 120),
  ai_employee_id  uuid references public.ai_employees(id) on delete set null,
  created_by_email text,

  search_tsv      tsvector generated always as (
                    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
                    setweight(to_tsvector('english',
                      coalesce(summary, '') || ' ' || coalesce(opening, '')), 'B') ||
                    setweight(to_tsvector('english', coalesce(body, '')), 'C')
                  ) stored,

  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now()
);
alter table public.hq_sales_call_scripts enable row level security;
-- NO policies → service-role only.

create index if not exists hq_sales_call_scripts_status_idx
  on public.hq_sales_call_scripts (status);
create index if not exists hq_sales_call_scripts_category_idx
  on public.hq_sales_call_scripts (category);
create index if not exists hq_sales_call_scripts_search_idx
  on public.hq_sales_call_scripts using gin (search_tsv);
create index if not exists hq_sales_call_scripts_tags_idx
  on public.hq_sales_call_scripts using gin (tags);

-- ---------------------------------------------------------------------
-- 2. Objection playbook — the live reference card: "when they say X,
--    respond Y". Distinct from Directive-002 memory: this is the curated
--    playbook the caller uses in the moment; a real winning rebuttal can
--    still be PROMOTED into Shared Memory (memory_id) by Phase 7.
-- ---------------------------------------------------------------------

create table if not exists public.hq_sales_objections (
  id              uuid primary key default gen_random_uuid(),

  -- The objection itself, e.g. "It's too expensive".
  objection       text not null check (char_length(objection) between 1 and 500),
  category        text not null default 'other'
                  check (category in (
                    'price', 'timing', 'authority', 'need', 'trust',
                    'competitor', 'contract', 'feature', 'other'
                  )),

  -- The recommended response + supporting proof points + a follow-up.
  response        text not null default '' check (char_length(response) <= 8000),
  supporting_points text[] not null default '{}',
  follow_up       text not null default '' check (char_length(follow_up) <= 4000),

  tags            text[] not null default '{}',
  -- 0–100 confidence in this play; win_rate is observed effectiveness
  -- (null until real calls are logged — never faked).
  confidence      integer check (confidence is null or confidence between 0 and 100),
  win_rate        integer check (win_rate is null or win_rate between 0 and 100),
  times_used      integer not null default 0 check (times_used >= 0),

  status          text not null default 'active'
                  check (status in ('draft', 'active', 'archived')),

  -- Sales Memory bridge — set when promoted into the Shared Memory Engine.
  memory_id       uuid references public.hq_memories(id) on delete set null,

  -- Traceability — an objection play can be AI-authored.
  generated_by    text not null default 'human'
                  check (generated_by in ('ai', 'human')),
  model           text check (model is null or char_length(model) <= 120),
  ai_employee_id  uuid references public.ai_employees(id) on delete set null,
  created_by_email text,

  search_tsv      tsvector generated always as (
                    setweight(to_tsvector('english', coalesce(objection, '')), 'A') ||
                    setweight(to_tsvector('english', coalesce(response, '')), 'B') ||
                    setweight(to_tsvector('english',
                      coalesce(follow_up, '') || ' ' || coalesce(category, '')), 'C')
                  ) stored,

  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now()
);
alter table public.hq_sales_objections enable row level security;
-- NO policies → service-role only.

create index if not exists hq_sales_objections_status_idx
  on public.hq_sales_objections (status);
create index if not exists hq_sales_objections_category_idx
  on public.hq_sales_objections (category);
create index if not exists hq_sales_objections_search_idx
  on public.hq_sales_objections using gin (search_tsv);
create index if not exists hq_sales_objections_tags_idx
  on public.hq_sales_objections using gin (tags);

-- ---------------------------------------------------------------------
-- 3. Calls — the per-call record AND the call queue. A call is created in
--    a waiting status (queued/scheduled); a worker (or a human logging a
--    completed call) fills in the timing + artifacts. priority_rank is
--    generated so the queue is ordered by an index, never a CASE.
-- ---------------------------------------------------------------------

create table if not exists public.hq_sales_calls (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.hq_sales_companies(id) on delete cascade,
  contact_id      uuid references public.hq_sales_contacts(id) on delete set null,
  -- The script opened for this call + the queue task that spawned it (both
  -- optional — a call can be ad-hoc logged with neither).
  script_id       uuid references public.hq_sales_call_scripts(id) on delete set null,
  ai_task_id      uuid references public.hq_sales_ai_tasks(id) on delete set null,

  direction       text not null default 'outbound'
                  check (direction in ('outbound', 'inbound')),

  status          text not null default 'queued'
                  check (status in (
                    'queued', 'scheduled', 'in_progress',
                    'completed', 'no_answer', 'voicemail', 'busy',
                    'failed', 'cancelled'
                  )),
  priority        text not null default 'normal'
                  check (priority in ('low', 'normal', 'high', 'urgent')),
  priority_rank   integer generated always as (
                    case priority
                      when 'urgent' then 0
                      when 'high'   then 1
                      when 'normal' then 2
                      when 'low'    then 3
                      else 2
                    end
                  ) stored,

  -- Disposition once a dial happens. Null-safe default 'unknown' mirrors
  -- the research report's likelihood_band.
  outcome         text not null default 'unknown'
                  check (outcome in (
                    'connected', 'callback_requested', 'meeting_booked',
                    'demo_booked', 'not_interested', 'do_not_call',
                    'wrong_number', 'no_answer', 'left_voicemail',
                    'gatekeeper', 'unknown'
                  )),

  -- The goal of the call (e.g. "Book a 20-min demo").
  objective       text not null default '' check (char_length(objective) <= 2000),

  -- Lifecycle timing. scheduled_at drives the queue; started/ended bracket
  -- the live call; duration is stored explicitly for fast roll-ups.
  scheduled_at    timestamp with time zone,
  started_at      timestamp with time zone,
  ended_at        timestamp with time zone,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),

  -- Artifacts. A recording lives in object storage (URL only); the
  -- transcript + AI summary are stored permanently for search + learning.
  recording_url   text check (recording_url is null or char_length(recording_url) <= 1000),
  transcript      text not null default '' check (char_length(transcript) <= 200000),
  summary         text not null default '' check (char_length(summary) <= 8000),
  notes           text not null default '' check (char_length(notes) <= 8000),

  -- Sentiment of the conversation (band + optional 0–100 score).
  sentiment       text not null default 'unknown'
                  check (sentiment in ('positive', 'neutral', 'negative', 'mixed', 'unknown')),
  sentiment_score integer check (sentiment_score is null or sentiment_score between 0 and 100),

  -- Objections raised during the call (free-form list, may map to the
  -- playbook above by text).
  objections_raised text[] not null default '{}',

  -- Follow-up captured at the end of the call.
  follow_up_at    timestamp with time zone,
  follow_up_notes text not null default '' check (char_length(follow_up_notes) <= 4000),
  follow_up_done  boolean not null default false,

  tags            text[] not null default '{}',

  -- Sales Memory bridge — set when a winning call is promoted.
  memory_id       uuid references public.hq_memories(id) on delete set null,

  -- Traceability — a call can be placed/logged by the AI engine.
  generated_by    text not null default 'human'
                  check (generated_by in ('ai', 'human')),
  model           text check (model is null or char_length(model) <= 120),
  ai_employee_id  uuid references public.ai_employees(id) on delete set null,
  source          text not null default 'manual' references public.hq_sales_sources(slug),
  created_by_email text,

  metadata        jsonb,

  search_tsv      tsvector generated always as (
                    setweight(to_tsvector('english', coalesce(summary, '')), 'A') ||
                    setweight(to_tsvector('english', coalesce(transcript, '')), 'B') ||
                    setweight(to_tsvector('english',
                      coalesce(notes, '') || ' ' || coalesce(objective, '') || ' ' ||
                      coalesce(outcome, '')), 'C')
                  ) stored,

  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now()
);
alter table public.hq_sales_calls enable row level security;
-- NO policies → service-role only.

-- Per-company history.
create index if not exists hq_sales_calls_company_idx
  on public.hq_sales_calls (company_id, created_at desc);
-- The dequeue index: waiting work, highest priority, earliest scheduled.
create index if not exists hq_sales_calls_queue_idx
  on public.hq_sales_calls (status, priority_rank, scheduled_at nulls first, created_at)
  where status in ('queued', 'scheduled', 'in_progress');
-- Filter / analytics facets.
create index if not exists hq_sales_calls_status_idx    on public.hq_sales_calls (status);
create index if not exists hq_sales_calls_outcome_idx   on public.hq_sales_calls (outcome);
create index if not exists hq_sales_calls_sentiment_idx on public.hq_sales_calls (sentiment);
create index if not exists hq_sales_calls_created_idx   on public.hq_sales_calls (created_at desc);
create index if not exists hq_sales_calls_ended_idx     on public.hq_sales_calls (ended_at desc nulls last);
create index if not exists hq_sales_calls_contact_idx   on public.hq_sales_calls (contact_id) where contact_id is not null;
create index if not exists hq_sales_calls_script_idx    on public.hq_sales_calls (script_id) where script_id is not null;
create index if not exists hq_sales_calls_ai_idx        on public.hq_sales_calls (ai_employee_id) where ai_employee_id is not null;
create index if not exists hq_sales_calls_search_idx    on public.hq_sales_calls using gin (search_tsv);
-- Outstanding follow-ups (a "call them back" worklist).
create index if not exists hq_sales_calls_follow_up_idx
  on public.hq_sales_calls (follow_up_at)
  where follow_up_at is not null and follow_up_done = false;

-- ---------------------------------------------------------------------
-- 4. updated_at touch triggers (reuse the shared public._hq_sales_touch()
--    defined in the base Sales AI migration).
-- ---------------------------------------------------------------------

drop trigger if exists hq_sales_call_scripts_touch on public.hq_sales_call_scripts;
create trigger hq_sales_call_scripts_touch
  before update on public.hq_sales_call_scripts
  for each row execute function public._hq_sales_touch();

drop trigger if exists hq_sales_objections_touch on public.hq_sales_objections;
create trigger hq_sales_objections_touch
  before update on public.hq_sales_objections
  for each row execute function public._hq_sales_touch();

drop trigger if exists hq_sales_calls_touch on public.hq_sales_calls;
create trigger hq_sales_calls_touch
  before update on public.hq_sales_calls
  for each row execute function public._hq_sales_touch();

-- ---------------------------------------------------------------------
-- 5. Register the telephony connector (planned). NOTHING here makes a
--    call; the connector flips to 'connected' when its phase ships.
-- ---------------------------------------------------------------------

insert into public.hq_sales_integrations (slug, label, category, status, sort_order) values
  ('aircall', 'Aircall', 'comms', 'planned', 45)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------
-- 6. Seed the starter playbook — a REAL, immediately-useful CrewFlow
--    construction-sales script library + objection playbook. These are
--    authored sales ASSETS (like the seeded Shared Memory + AI employee
--    roster), NOT fabricated activity: no call records are seeded, because
--    a call is a real event that only exists once one is placed/logged.
--    Idempotent via stable slugs in metadata? Scripts/objections have no
--    natural key, so guard the whole seed on emptiness to stay re-runnable.
-- ---------------------------------------------------------------------

insert into public.hq_sales_call_scripts
  (name, category, status, summary, opening, body, talking_points, questions,
   target_persona, target_status, estimated_duration_seconds, tags, generated_by)
select * from (values
  (
    'Cold call — construction MD/Owner',
    'cold_call', 'active',
    'First-touch outbound to a construction company owner or managing director who has never heard of CrewFlow.',
    'Hi, is that {first_name}? It''s {rep} from CrewFlow — I know I''ve caught you out of the blue, have you got thirty seconds for me to explain why I called, then you can tell me to get lost?',
    E'PERMISSION + REASON\nOpen with a pattern-interrupt and earn 30 seconds. Reason for the call: we help UK construction firms run jobs, teams and quotes from one place instead of paper, WhatsApp and spreadsheets.\n\nRELEVANCE\n"We work with {sector} firms around {county} and the thing we hear most is that the office is drowning in admin while the lads on site can never find the right paperwork."\n\nMICRO-QUALIFY\nAsk how they currently track jobs and staff hours. Listen for paper/spreadsheet/WhatsApp pain.\n\nASK FOR THE DEMO\n"Worth a proper look — can I grab 20 minutes Thursday to show you how it''d work for {company}?"',
    array[
      'Earn the 30 seconds before pitching',
      'Lead with the office-admin pain, not features',
      'One clear ask: a 20-minute demo',
      'Reference their sector + county to prove relevance'
    ],
    array[
      'How do you track which jobs are on, and who''s on them today?',
      'Where do your site team get drawings, RAMS and job sheets right now?',
      'How long does it take to turn a site visit into a priced quote?'
    ],
    'Managing Director / Owner', 'new', 240,
    array['cold', 'construction', 'first-touch'], 'human'
  ),
  (
    'Discovery — uncover the admin pain',
    'discovery', 'active',
    'Second call once a prospect has agreed to talk — map their current process and quantify the cost of the status quo.',
    'Thanks for making the time, {first_name}. Before I show you anything, I''d like to understand how {company} runs today so I only show you the bits that matter — is that alright?',
    E'CURRENT STATE\nWalk their job lifecycle: enquiry → quote → won → scheduled → on site → invoiced. Note every tool used at each step.\n\nQUANTIFY THE PAIN\nFor each gap, ask "what does that cost you?" in hours, rework, or missed invoicing.\n\nDECISION PROCESS\nWho else would weigh in? What''s changed that means they''re looking now?\n\nSUMMARISE BACK\nPlay back their three biggest costs and get a "yes, that''s right" before booking the demo.',
    array[
      'Map the whole job lifecycle, tool by tool',
      'Quantify pain in hours and money',
      'Identify the other decision makers early',
      'Summarise and confirm before moving on'
    ],
    array[
      'Walk me through what happens from enquiry to getting paid.',
      'What''s the most painful part of that for the office?',
      'If you fixed one thing this quarter, what would it be?',
      'Who else would want to be in the room when we look at this?'
    ],
    'Operations / Commercial', 'qualified', 1200,
    array['discovery', 'qualification'], 'human'
  ),
  (
    'Demo follow-up — keep the momentum',
    'follow_up', 'active',
    'Call placed 1–2 days after a demo to confirm value, handle remaining questions and agree next steps.',
    'Hi {first_name}, it''s {rep} from CrewFlow — I wanted to check the demo landed the way you hoped and see what questions came up once you''d had a think.',
    E'CONFIRM VALUE\nRecap the two or three things that resonated most in the demo.\n\nSURFACE BLOCKERS\nAsk directly what would stop them going ahead — price, timing, team buy-in.\n\nNEXT STEP\nPropose a concrete next step: a trial, a team walkthrough, or pricing sign-off. Put a date on it.',
    array[
      'Recap the value they reacted to, not everything',
      'Ask directly what would stop them',
      'Always leave with a dated next step'
    ],
    array[
      'What did the rest of the team make of it?',
      'Is there anything that would stop you moving ahead?',
      'Shall we line up a two-week trial to prove it on a live job?'
    ],
    'Managing Director / Owner', 'demo_booked', 600,
    array['follow-up', 'demo'], 'human'
  ),
  (
    'Voicemail — short and call-back-worthy',
    'voicemail', 'active',
    'A 20-second voicemail that earns a call back without pitching.',
    'Hi {first_name}, it''s {rep} from CrewFlow on {number}.',
    E'KEEP IT UNDER 20 SECONDS\n"I''m calling about how {sector} firms around {county} are cutting their office admin — I''ve got one idea specific to {company}. Worth a two-minute call back on {number}. Thanks {first_name}."\n\nSay the number twice, slowly. No features, just curiosity.',
    array[
      'Under 20 seconds',
      'Give one reason to call back, not a pitch',
      'Say your number twice, slowly'
    ],
    array[]::text[],
    'Any', null, 20,
    array['voicemail'], 'human'
  ),
  (
    'Gatekeeper — get to the decision maker',
    'gatekeeper', 'active',
    'Navigate a receptionist or office manager politely to reach the owner/MD.',
    'Morning! I wonder if you can help me — I''m trying to get hold of whoever looks after how the jobs and teams are run, would that be {first_name} or someone else?',
    E'BE HUMAN + ASK FOR HELP\nGatekeepers help people who are warm and honest.\n\nNAME THE ROLE, NOT A PRODUCT\n"It''s about cutting the site admin — not selling them anything today, just the right person to point me at."\n\nGET A ROUTE\nIf unavailable: best time to try, or a direct line/email. Thank them by name.',
    array[
      'Be warm and ask for help',
      'Reference the role and the problem, never "sales"',
      'Always leave with a next route in'
    ],
    array[
      'Who''s the best person to talk to about how jobs and teams are run?',
      'When''s a good time to catch them?'
    ],
    'Gatekeeper', null, 120,
    array['gatekeeper'], 'human'
  )
) as seed
where not exists (select 1 from public.hq_sales_call_scripts);

insert into public.hq_sales_objections
  (objection, category, response, supporting_points, follow_up, tags, confidence, status, generated_by)
select * from (values
  (
    'It''s too expensive / we can''t justify the cost',
    'price',
    E'Acknowledge, then reframe to cost-of-inaction. "Completely fair — let''s make sure it pays for itself. Most firms your size lose more than the subscription every month in missed invoicing and re-keying job info. CrewFlow usually pays for itself on the admin time alone, before a single extra job won."',
    array[
      'Frame against the cost of the status quo, not a rival',
      'Tie to missed invoicing + admin hours they quantified in discovery',
      'Offer a trial so value is proven before spend'
    ],
    'Offer a two-week trial on a live job so the saving is proven, not promised.',
    array['price', 'cost'], 80, 'active', 'human'
  ),
  (
    'We''re too busy to change systems right now',
    'timing',
    E'"That''s exactly why most of our customers started — they were too busy because the admin was manual. We onboard alongside your current way of working, one job at a time, so nothing stops. Being busy is the reason to fix it, not to wait."',
    array[
      'Busy = the symptom CrewFlow fixes, reframe it',
      'Stress phased onboarding — no big-bang switchover',
      'Start with one live job to keep risk tiny'
    ],
    'Propose starting with a single job next week so there''s no disruption.',
    array['timing', 'too-busy'], 78, 'active', 'human'
  ),
  (
    'I need to speak to my business partner / the team',
    'authority',
    E'"Of course — it''s the right call to get them on board. What would they most want to know? Let''s line up a short walkthrough with them on so they can see it first-hand rather than hearing it second-hand from you."',
    array[
      'Welcome the other decision maker, don''t resist',
      'Pre-handle their likely questions now',
      'Book a joint session rather than relying on a relay'
    ],
    'Get a date in the diary for a joint walkthrough with the partner/team present.',
    array['authority', 'decision-maker'], 75, 'active', 'human'
  ),
  (
    'We already use a spreadsheet / WhatsApp and it works fine',
    'need',
    E'"They''re great until you''re juggling ten jobs and three crews — then things slip between the cracks and nobody owns it. CrewFlow keeps the speed you like but means the job, the team and the paperwork are all in one place. Can I show you the exact moment a spreadsheet stops scaling?"',
    array[
      'Respect what works, target where it breaks (scale)',
      'Keep their speed, remove the cracks',
      'Make it concrete — show the breaking point'
    ],
    'Show a side-by-side of their spreadsheet flow vs CrewFlow on a busy week.',
    array['status-quo', 'spreadsheet'], 76, 'active', 'human'
  ),
  (
    'How do I know it actually works for firms like mine?',
    'trust',
    E'"Best way is to see it on your own jobs, not a generic demo. We work with {sector} firms around {county} doing exactly what you do. I''ll show you how one of them runs a week, and you tell me where it''d save you time."',
    array[
      'Offer proof on their jobs, not a canned demo',
      'Reference similar sector + region firms',
      'Invite them to find the gaps — confidence sells'
    ],
    'Book a tailored demo using their real job types and a two-week trial offer.',
    array['trust', 'proof'], 74, 'active', 'human'
  ),
  (
    'We looked at [competitor] / other software before',
    'competitor',
    E'"Useful — what made you stop short last time? A lot of construction tools are built for big main contractors and feel heavy for a firm your size. CrewFlow is built for UK trades and contractors: quick to set up, nothing you won''t use. Let me show you the difference where it matters to you."',
    array[
      'Diagnose why the last attempt stalled',
      'Position fit-for-size vs heavy enterprise tools',
      'Demo only the features relevant to them'
    ],
    'Tailor the demo to the gaps that made the previous tool fail.',
    array['competitor', 'switching'], 72, 'active', 'human'
  ),
  (
    'Send me some information and I''ll have a look',
    'timing',
    E'"Happy to — and so it''s actually useful rather than another email you''ll skim, let me ask two quick things so I send the right bits." Qualify, then: "I''ll send a short summary, and shall we hold 15 minutes Thursday so I can walk you through the parts that fit {company}?"',
    array[
      'Agree to send, but qualify first so it''s relevant',
      'Never let "send info" replace a booked next step',
      'Tie the email to a held slot in the diary'
    ],
    'Send a tailored one-pager AND hold a 15-minute slot to review it together.',
    array['brush-off', 'send-info'], 70, 'active', 'human'
  ),
  (
    'Just email me your prices',
    'price',
    E'"I can — pricing depends on team size and what you need switched on, so I don''t want to quote you for things you''ll never use. Give me two minutes on how {company} runs and I''ll send a price that''s actually yours, not a list."',
    array[
      'Price depends on their setup — quoting blind hurts both sides',
      'Trade a tailored price for two minutes of qualification',
      'Avoid anchoring on a headline number out of context'
    ],
    'Qualify team size + needs, then send a tailored price tied to a follow-up call.',
    array['price', 'pricing'], 71, 'active', 'human'
  )
) as seed
where not exists (select 1 from public.hq_sales_objections);

-- CrewFlow HQ — Sales Learning Engine (CEO Directive 004, Phase 7).
--
-- The compounding edge: every winning cold-call, email, LinkedIn touch,
-- objection rebuttal, demo and close is distilled into a REUSABLE pattern —
-- the prompt that worked, the context it worked in, the result it produced,
-- the metrics behind it, tags, and a confidence. Over time this becomes the
-- sales brain the autonomous engine reaches for first.
--
-- Relationship to the Directive-002 Shared Memory Engine (hq_memories):
--   * hq_memories is the GENERIC, company-wide knowledge store every AI
--     employee reads (a 'sales' memory_type already exists). It is broad
--     prose knowledge, not metric-bearing sales plays.
--   * hq_sales_learnings is the SPECIALISED, execution-grade playbook: a
--     structured prompt/context/result record tied to the real artifact
--     that PROVED it (a call, a timeline touch, an objection), carrying its
--     own effectiveness metrics. A genuinely-proven learning can be PROMOTED
--     into company-wide memory via the memory_id bridge (a later phase wires
--     that write) — so the two engines compose, never duplicate. This is the
--     same pattern as Phase 6 adding dedicated call tables rather than
--     overloading hq_sales_ai_tasks.
--
-- FOUNDATION ONLY. No model provider, embedding, or autonomous capture is
-- wired here. NOTHING in this migration generates a learning, scores one, or
-- applies one to a live call. AI-authorable rows carry the generated_by /
-- model / ai_employee_id traceability triad from day one.
--
-- HQ-ONLY: RLS ENABLED with NO policies → service-role client only. No
-- customer / staff JWT client can ever read the Learning Engine. No
-- customer-facing surface changes.

-- ---------------------------------------------------------------------
-- The learning record — one distilled, reusable winning pattern.
-- ---------------------------------------------------------------------

create table if not exists public.hq_sales_learnings (
  id              uuid primary key default gen_random_uuid(),

  title           text not null check (char_length(title) between 1 and 300),

  -- The winning-pattern taxonomy from the directive (cold-call / email /
  -- LinkedIn / objection / demo / close …). FK-free check so it stays a
  -- bounded, indexable vocabulary the pure model mirrors exactly.
  pattern_type    text not null default 'cold_call'
                  check (pattern_type in (
                    'cold_call', 'email', 'linkedin', 'objection',
                    'discovery', 'demo', 'close', 'follow_up',
                    'voicemail', 'referral', 'other'
                  )),
  -- Optional comms channel the pattern applies to (forward-compatible with
  -- the Communication Centre's channel set).
  channel         text check (channel is null or channel in (
                    'phone', 'email', 'linkedin', 'instagram',
                    'whatsapp', 'sms', 'facebook', 'in_person', 'other'
                  )),

  status          text not null default 'active'
                  check (status in ('draft', 'active', 'archived')),

  -- The directive's reusable-knowledge shape.
  summary         text not null default '' check (char_length(summary) <= 2000),
  -- `prompt`  the reusable words / template that worked.
  prompt          text not null default '' check (char_length(prompt) <= 8000),
  -- `context` when + where to use it (situation, persona, stage).
  context         text not null default '' check (char_length(context) <= 8000),
  -- `result`  what it produced — the proof it works.
  result          text not null default '' check (char_length(result) <= 8000),
  -- Structured supporting cues for the caller / engine.
  supporting_points text[] not null default '{}',

  tags            text[] not null default '{}',
  -- `metrics` free-form evidence bag, e.g. {"calls": 40, "meetings": 9}.
  metrics         jsonb,
  -- `confidence` 0–100 belief this pattern generalises.
  confidence      integer check (confidence is null or confidence between 0 and 100),

  -- Observed effectiveness — accrues only from real logged use, never faked.
  times_used      integer not null default 0 check (times_used >= 0),
  times_won       integer not null default 0 check (times_won >= 0),
  win_rate        integer check (win_rate is null or win_rate between 0 and 100),
  last_used_at    timestamp with time zone,

  -- Provenance — the real artifact that proved this pattern (all optional;
  -- a learning can be hand-authored as a starter play with none set).
  company_id          uuid references public.hq_sales_companies(id) on delete set null,
  source_call_id      uuid references public.hq_sales_calls(id) on delete set null,
  source_event_id     uuid references public.hq_sales_timeline_events(id) on delete set null,
  source_objection_id uuid references public.hq_sales_objections(id) on delete set null,

  -- Shared Memory bridge — set when promoted into the company-wide engine.
  memory_id       uuid references public.hq_memories(id) on delete set null,

  -- Traceability — a learning can be AI-distilled.
  generated_by    text not null default 'human'
                  check (generated_by in ('ai', 'human')),
  model           text check (model is null or char_length(model) <= 120),
  ai_employee_id  uuid references public.ai_employees(id) on delete set null,
  source          text not null default 'manual' references public.hq_sales_sources(slug),
  created_by_email text,

  search_tsv      tsvector generated always as (
                    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                    setweight(to_tsvector('english',
                      coalesce(summary, '') || ' ' || coalesce(prompt, '')), 'B') ||
                    setweight(to_tsvector('english',
                      coalesce(context, '') || ' ' || coalesce(result, '')), 'C')
                  ) stored,

  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now()
);
alter table public.hq_sales_learnings enable row level security;
-- NO policies → service-role only.

create index if not exists hq_sales_learnings_status_idx
  on public.hq_sales_learnings (status);
create index if not exists hq_sales_learnings_type_idx
  on public.hq_sales_learnings (pattern_type);
-- "Best plays first": most-effective, most-used, newest.
create index if not exists hq_sales_learnings_rank_idx
  on public.hq_sales_learnings (win_rate desc nulls last, times_used desc, created_at desc);
create index if not exists hq_sales_learnings_search_idx
  on public.hq_sales_learnings using gin (search_tsv);
create index if not exists hq_sales_learnings_tags_idx
  on public.hq_sales_learnings using gin (tags);
create index if not exists hq_sales_learnings_company_idx
  on public.hq_sales_learnings (company_id) where company_id is not null;
create index if not exists hq_sales_learnings_memory_idx
  on public.hq_sales_learnings (memory_id) where memory_id is not null;

-- updated_at touch (reuse the shared trigger fn from the base migration).
drop trigger if exists hq_sales_learnings_touch on public.hq_sales_learnings;
create trigger hq_sales_learnings_touch
  before update on public.hq_sales_learnings
  for each row execute function public._hq_sales_touch();

-- ---------------------------------------------------------------------
-- Seed the starter playbook — REAL, distilled CrewFlow construction-sales
-- winning patterns (authored sales ASSETS, like the Phase 6 scripts +
-- objection plays and the Shared Memory seed). These are honest priors:
-- confidence is set, but observed metrics (times_used / times_won /
-- win_rate / last_used_at) stay empty until real calls are logged — a
-- "winning" pattern earns its win-rate, it is never fabricated. Guarded on
-- emptiness so the seed is re-runnable.
-- ---------------------------------------------------------------------

insert into public.hq_sales_learnings
  (title, pattern_type, channel, status, summary, prompt, context, result,
   supporting_points, tags, confidence, generated_by)
select * from (values
  (
    'Permission-based cold open earns the 30 seconds',
    'cold_call', 'phone', 'active',
    'Asking permission up front, then naming the office-admin pain, consistently buys enough time to land the demo ask.',
    E'Hi, is that {first_name}? It''s {rep} from CrewFlow — I know I''ve caught you out of the blue, have you got thirty seconds for me to explain why I called, then you can tell me to get lost?',
    'First-touch outbound to a construction owner/MD who has never heard of CrewFlow. Works best mid-morning, decision-maker direct line.',
    'Pattern-interrupt + permission lowers the guard; pivoting straight to admin pain (not features) keeps them on past the 30-second mark.',
    array[
      'Earn permission before pitching anything',
      'Lead with office-admin pain, never features',
      'One ask only: a 20-minute demo'
    ],
    array['cold', 'opener', 'construction'], 78, 'human'
  ),
  (
    'Cost-of-inaction reframe beats discounting on price',
    'objection', 'phone', 'active',
    'On "too expensive", reframing to the monthly cost of manual admin + missed invoicing outperforms any discount.',
    E'Completely fair — let''s make sure it pays for itself. Most firms your size lose more than the subscription every month in missed invoicing and re-keying job info. CrewFlow usually pays for itself on the admin time alone, before a single extra job won.',
    'Price objection from an owner/MD who has quantified their admin pain in discovery. Do NOT discount first.',
    'Anchoring against the status quo (not a rival) shifts the frame from spend to saving; pairing with a live-job trial removes the risk.',
    array[
      'Reframe to cost of the status quo, not a discount',
      'Tie back to the admin hours they named in discovery',
      'Close on a two-week live-job trial'
    ],
    array['objection', 'price', 'reframe'], 80, 'human'
  ),
  (
    'Specific-result email subject lifts cold open rates',
    'email', 'email', 'active',
    'Cold emails that put a concrete, sector-specific result in the subject line get opened and replied to far more than feature-led ones.',
    E'Subject: cutting {sector} office admin in {county}\n\nHi {first_name}, quick one — we help {sector} firms around {county} run jobs, teams and quotes from one place instead of paper, WhatsApp and spreadsheets. Worth 15 minutes to see if it''d save {company} the admin hours? I can show you on your own job types.',
    'First cold email to a construction owner/MD. Pair with a call; never send pricing blind.',
    'Concrete outcome + locality in the subject beats "Introducing CrewFlow"; one clear, low-friction ask drives the reply.',
    array[
      'Put a concrete result + locality in the subject',
      'One low-friction ask (15 minutes), not a pitch',
      'Reference their sector + county for relevance'
    ],
    array['email', 'subject-line', 'cold'], 72, 'human'
  ),
  (
    'Problem-led LinkedIn connect note out-converts a pitch',
    'linkedin', 'linkedin', 'active',
    'A short connection note that names the problem and asks nothing converts better than a pitch or a blank request.',
    E'Hi {first_name} — I work with {sector} firms around {county} on cutting the office admin that piles up as the job count grows. Not selling anything here, just like to connect with people running busy sites.',
    'Cold LinkedIn outreach to owners/MDs/ops leads. Send the note with the request; no link, no ask.',
    'Naming the problem signals relevance; explicitly not selling lowers resistance and earns the accept, opening a warm follow-up later.',
    array[
      'Name the problem, ask for nothing',
      'Say plainly you''re not selling',
      'Keep it under three sentences'
    ],
    array['linkedin', 'social', 'connect'], 70, 'human'
  ),
  (
    'Demo on their real job types beats a generic tour',
    'demo', 'phone', 'active',
    'Running the demo against the prospect''s own job types and a busy week — not a generic walkthrough — is what books the next step.',
    E'Before I show you anything, tell me the two job types that cause the most office hassle — I''ll run the demo on those so you''re seeing your week, not a generic tour.',
    'Booked demo with a qualified construction firm. Use the discovery notes to pick the job types live.',
    'Anchoring the demo in their reality makes the value self-evident and pre-empts "but does it do X for us"; always close on a dated next step.',
    array[
      'Demo their real job types, not a generic flow',
      'Pull the scenarios from discovery notes',
      'Leave with a dated next step every time'
    ],
    array['demo', 'discovery-led'], 76, 'human'
  ),
  (
    'Trial-to-close on a single live job de-risks the decision',
    'close', 'phone', 'active',
    'Closing by proposing a two-week trial on one live job removes the perceived risk and shortens the decision.',
    E'Shall we prove it on one live job for two weeks? You''ll see the admin saving on a real job before you commit to anything — if it doesn''t earn its place, we part as friends.',
    'Late-stage deal where value is understood but the prospect is hesitating on commitment or team buy-in.',
    'A bounded, reversible trial converts hesitation into a yes; scoping to one job keeps it low-effort to start and easy to expand after a win.',
    array[
      'Offer a bounded, reversible trial on ONE job',
      'Frame the exit as easy to lower the stakes',
      'Plan the expansion conversation for post-win'
    ],
    array['close', 'trial', 'de-risk'], 75, 'human'
  )
) as seed
where not exists (select 1 from public.hq_sales_learnings);

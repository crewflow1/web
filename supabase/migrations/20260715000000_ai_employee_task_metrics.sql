-- CrewFlow HQ — AI Employee workforce telemetry index
-- (CEO Directive 004, Phase 3).
--
-- The Command Centre's sibling — the AI Boardroom — now derives live
-- workforce stats (tasks today, success rate, avg completion time, last
-- completed task) from `ai_employee_tasks`. The roster service reads the
-- most recent task rows across the WHOLE roster in one bounded query
-- (`order by created_at desc limit N`), then buckets them per employee
-- in-app — two round trips regardless of headcount.
--
-- The existing `ai_employee_tasks_recent_idx (ai_employee_id, created_at)`
-- is per-employee-leading, so it can't serve a roster-wide ordering. This
-- adds the matching single-column index so the global recent-task read
-- stays index-ordered as a future learning loop grows the table toward the
-- directive's "millions of AI tasks" horizon.
--
-- ARCHITECTURE ONLY. No new table, no RLS change (ai_employee_tasks keeps
-- its RLS-enabled, zero-policy, service-role-only posture), no execution.

create index if not exists ai_employee_tasks_created_idx
  on public.ai_employee_tasks (created_at desc);

-- CrewFlow HQ — Shared Memory Engine seed-version backfill
-- (CEO Directive 002, Phase 2).
--
-- The example-memory seed (20260713000100) inserts rows directly into
-- `hq_memories`, bypassing the application service (`createMemory`),
-- which is what normally writes the matching v1 snapshot into
-- `hq_memory_versions`. As a result the seeded memories carry
-- `version = 1` but have no version-history row, so their detail-page
-- timeline would start at v2 on the first edit and never show the
-- original v1.
--
-- This migration backfills a v1 snapshot for every `hq_memories` row
-- that has no version history at all. It is fully idempotent: the
-- `not exists` guard means re-running never duplicates snapshots, and
-- it only touches memories whose history is genuinely empty (it will
-- not fabricate a v1 for memories that were edited through the app and
-- already own a version trail).

insert into public.hq_memory_versions
  (memory_id, version, title, summary, body, memory_type,
   department, importance, tags, status, edited_by_email, created_at)
select
  m.id,
  1,
  m.title,
  m.summary,
  m.body,
  m.memory_type,
  m.department,
  m.importance,
  m.tags,
  m.status,
  m.created_by_email,
  m.created_at
from public.hq_memories m
where not exists (
  select 1
  from public.hq_memory_versions v
  where v.memory_id = m.id
);

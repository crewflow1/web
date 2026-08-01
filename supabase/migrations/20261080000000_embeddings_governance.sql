-- ═══════════════════════════════════════════════════════════════════════════
-- EMBEDDINGS GOVERNANCE — admit 'embedding' as a fourth governed task class.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY. Embeddings were the last ungoverned AI path in the build. The readiness
-- surface (lib/ai/governor/readiness.ts) has said so out loud since the
-- governance-closure wave: `lib/ai/embeddings` selected its provider on
-- OPENAI_API_KEY alone — a key-only activation, exactly the class of defect
-- the governor closed for text and vision — and structurally COULD NOT be
-- governed, because this ledger's task_class CHECK admitted only
-- classification / drafting / complex, and an embedding is none of the three.
--
-- This migration widens both CHECKs to admit 'embedding'. The TypeScript side
-- (same train) adds the 'embedding' task class + a dedicated 'embedding' cost
-- tier to the registry, moves the embedding provider door behind per-tier
-- governor activation, and routes both embedding call sites (the memory
-- worker and HQ recall's query-time embed) through invokeWithGovernor — so an
-- embedding call now gets the identical atomic reserve→settle treatment, the
-- same SHA-256 dedupe, and the same per-org monthly ceiling as every other
-- governed call.
--
-- 'deterministic' remains DELIBERATELY ABSENT from both CHECKs. A
-- deterministic task reaches no model by definition; the database keeps
-- refusing a ledger row or a budget claim for one, for every role including
-- service_role. (The zero-cost, zero-egress deterministic embedding provider
-- used by CI never writes here at all — it spends nothing, so there is
-- nothing to account.)
--
-- WIDENING IS THE WHOLE MIGRATION. No new tables, no new functions: the
-- reserve/settle/release RPCs (20261070) carry task_class as opaque text and
-- rely on these CHECKs at INSERT time, which is exactly where a closed
-- vocabulary belongs. Every existing row satisfies the widened constraint by
-- construction (a superset), so ADD CONSTRAINT validates instantly and this
-- replays cleanly from scratch.

alter table public.ai_invocations
  drop constraint ai_invocations_task_class_check;

alter table public.ai_invocations
  add constraint ai_invocations_task_class_check
  check (task_class in ('classification', 'drafting', 'complex', 'embedding'));

alter table public.ai_cost_reservations
  drop constraint ai_cost_reservations_task_class_check;

alter table public.ai_cost_reservations
  add constraint ai_cost_reservations_task_class_check
  check (task_class in ('classification', 'drafting', 'complex', 'embedding'));

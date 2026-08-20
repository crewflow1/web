-- ═══════════════════════════════════════════════════════════════════════════
-- TRANSCRIPTION GOVERNANCE — admit 'transcription' as a governed task class.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY. Voice-note transcription (Speech-to-Text) is a SEPARATE AI MODALITY, not
-- a price band of the generative text/vision one and not the embedding one: it
-- turns audio bytes into a transcript, billed on audio duration, through a
-- different vendor surface. WhatsApp voice notes already arrive at the assistant
-- pipeline (server/services/whatsapp-assistant-actions.ts) and the dark seam
-- that would transcribe them exists (lib/ai/transcription.ts) — but until this
-- migration the ledger's task_class CHECK admitted only
-- classification / drafting / complex / embedding, and a transcription is none
-- of those. So a transcription call COULD NOT be metered: the reserve/settle
-- RPCs (20261070) carry task_class as opaque text and rely on this CHECK at
-- INSERT time, which would refuse an unknown class.
--
-- This migration widens both CHECKs to admit 'transcription'. The TypeScript
-- side (same train) adds the 'transcription' task class + a dedicated
-- 'transcription' cost tier to the registry, registers the
-- `voice_note.transcription` feature, and routes the transcription call through
-- invokeWithGovernor — so a voice-note transcription now gets the identical
-- atomic reserve→settle treatment, the same SHA-256 dedupe, and the same
-- per-org monthly ceiling as every other governed call.
--
-- STILL DARK AFTER THIS MIGRATION. No STT model is bound (TRANSCRIPTION_MODEL
-- and TIER_MODEL.transcription are both null), so the governor's per-tier dark
-- short-circuit runs the caller's degraded path and writes NO ledger row — the
-- transcription seam returns `deferred` with a null transcript and never
-- fabricates. Widening the CHECK changes nothing observable while dark; it
-- makes the ledger READY for the activation diff (bind a model + credential),
-- exactly as 20261080 did for embeddings.
--
-- 'deterministic' remains DELIBERATELY ABSENT from both CHECKs. A deterministic
-- task reaches no model by definition; the database keeps refusing a ledger row
-- or a budget claim for one, for every role including service_role.
--
-- WIDENING IS THE WHOLE MIGRATION. No new tables, no new functions: the
-- reserve/settle/release RPCs carry task_class as opaque text and rely on these
-- CHECKs. Every existing row satisfies the widened constraint by construction (a
-- superset), so ADD CONSTRAINT validates instantly and this replays cleanly from
-- scratch.

alter table public.ai_invocations
  drop constraint ai_invocations_task_class_check;

alter table public.ai_invocations
  add constraint ai_invocations_task_class_check
  check (task_class in ('classification', 'drafting', 'complex', 'embedding', 'transcription'));

alter table public.ai_cost_reservations
  drop constraint ai_cost_reservations_task_class_check;

alter table public.ai_cost_reservations
  add constraint ai_cost_reservations_task_class_check
  check (task_class in ('classification', 'drafting', 'complex', 'embedding', 'transcription'));

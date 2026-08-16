-- HQ Event Spine — ACTIVATION (Module 1 reveal; Master-Plan R3).
--
-- Everything the HQ Event Spine needs to be LIVE already exists and is CI-green:
--   • the append-only, RANGE-partitioned log + the sole validated writer
--     hq_emit_event + the block-mutation guard        (20260720000000, PR1);
--   • the curated activity -> canonical-event producer hq_emit_from_activity,
--     gated by hq_spine_dual_write_enabled()           (20260720010000, PR2);
--   • the generic offset drainer / replay / dead-letter machinery,
--     gated by hq_spine_consumer_enabled()             (20260720020000, PR3);
--   • the historical backfill of the three legacy logs into the spine,
--     gated by hq_spine_backfill_enabled()             (20260720030000, PR4);
--   • the `hq_timeline` CQRS projection, its `timeline` WHEN-branch in
--     hq_consumer_apply, and the `timeline` consumer REGISTERED at offset 0
--                                                      (20260720040000, PR5);
--   • the per-minute Vercel crons spine-drain + spine-backfill that iterate
--     every registered consumer / every backfill source (vercel.json).
--
-- The ONLY thing keeping all of this dormant in production is three infra
-- kill-switches in the hq_settings singleton, each seeded FALSE by its PR and
-- deliberately designed to be flipped "at runtime, with no deploy". This
-- migration performs exactly that deliberate reveal — as migration-first,
-- reviewable, idempotent SQL rather than an unaudited manual UPDATE against
-- prod — so the Master-Plan capability is genuinely LIVE, not dark:
--
--   1. dual_write_enabled -> true : real HQ actions (the curated OPERATIONS
--      verb subset) begin emitting canonical hq_events in-transaction.
--   2. backfill_enabled   -> true : the three legacy logs replay their surviving
--      history INTO the spine, so the timeline reaches back before producers ran.
--   3. consumer_enabled   -> true : the spine-drain cron drains the registered
--      `timeline` consumer, so hq_events (forward + backfilled) drains into the
--      hq_timeline projection the /admin/pulse feed reads.
--
-- NET EFFECT: /admin/pulse populates from real events. No new verbs are invented
-- (the producer's curated map is unchanged — the frozen registry's OPERATIONS
-- group); no new writer, guard, table, or function is introduced; not one line
-- of the frozen spine core is edited. This migration ONLY changes settings data
-- + re-affirms the consumer registration. Every existing invariant — append-only
-- block-mutation, sole-writer hq_emit_event, monthly partitioning, RLS:hq,
-- service-role-only function grants — is untouched and stays green.
--
-- WHY THE FLAGS ARE FLIPPED, NOT REMOVED. The task allows keeping a flag if it
-- earns its place for safety, provided it DEFAULTS ON now. These three do earn
-- their place: they are operator kill-switches (an operator can instantly quiet
-- the spine by flipping one back to false at runtime, no deploy) AND they are the
-- seam the integration tier toggles to prove dark/live behaviour both ways. So we
-- keep the mechanism and set every value ON — the capability is live, the
-- off-switch survives.
--
-- ORDERING. At runtime the two crons read these flags independently, so the order
-- within this transaction has no correctness bearing; we still write them in the
-- documented reveal order (dual-write -> backfill -> consumer) for auditability.
-- Cross-flag consistency is inherent in the design, not in the order here:
--   • the `timeline` consumer is registered at offset 0, so once consumer_enabled
--     is on it replays the ENTIRE history — including every backfilled row — by
--     strict event id, and the event-id PK on hq_timeline makes replay + at-least
--     -once delivery no-ops (no double projection);
--   • backfilled events are INSERTed at the tail of the identity sequence (new,
--     larger ids) while carrying their ORIGINAL ts, so the drainer (which orders
--     by id) always picks them up on a later tick, and the feed (which orders by
--     ts desc) still shows them at their true historical position.
--
-- IDEMPOTENT. Re-applying sets the same three values true and re-affirms the
-- consumer registration (ON CONFLICT DO NOTHING inside hq_consumer_register — it
-- never rewinds a live consumer). No tenant table is touched (P2, provably
-- additive). This migration adds NO new SECURITY DEFINER function, so there is no
-- new grant surface to harden.

-- ---------------------------------------------------------------------------
-- 1. Flip the three infra kill-switches ON in the hq_settings singleton.
--    Written under the same non-UI `event_spine` section the PRs seeded, so the
--    operator settings page still never renders them (SECTION_IDS omits it) and
--    mergeSettings() still ignores them — they remain low-level infra switches.
--    We set the values UNCONDITIONALLY to true here (the whole point of this
--    migration is the reveal), preserving any OTHER keys already under
--    event_spine via the coalesce/`||` merge. The singleton row is guaranteed to
--    exist (seeded in 20260616000000_hq_settings.sql), so a bare UPDATE suffices.
-- ---------------------------------------------------------------------------
update public.hq_settings
set data = coalesce(data, '{}'::jsonb)
           || jsonb_build_object(
                'event_spine',
                coalesce(data -> 'event_spine', '{}'::jsonb)
                  || jsonb_build_object(
                       'dual_write_enabled', true,
                       'backfill_enabled',   true,
                       'consumer_enabled',   true
                     )
              )
where id = 'singleton';

-- ---------------------------------------------------------------------------
-- 2. Re-affirm the `timeline` consumer registration at offset 0.
--    PR5 (20260720040000) already registered it; this is a defensive, idempotent
--    re-assert so activation is self-contained and correct even if that row were
--    ever absent. hq_consumer_register is ON CONFLICT (consumer) DO NOTHING, so
--    it NEVER rewinds an already-advanced consumer — a live `timeline` offset is
--    left exactly where it is. Offset 0 (only used if the row is created here)
--    means "replay the entire history", which is the intended reveal behaviour.
-- ---------------------------------------------------------------------------
select public.hq_consumer_register('timeline', 0);

import "server-only";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCeoDashboard } from "@/server/services/hq-ceo";
import {
  composeCeoBriefing,
  type CeoBriefing,
  type CeoBriefingCompetitorIntel,
} from "@/lib/hq/ceo-briefing";
import { loadCompetitorIntelForBriefing } from "@/server/services/hq-competitor-intel";
import type { CeoBoard } from "@/lib/hq/ceo";

/**
 * CrewFlow HQ — the auto morning CEO briefing runtime (P2 HQ AI Operating System).
 *
 * Composes the deterministic morning briefing from the CEO board (lib/hq/ceo-briefing.ts) and
 * records it durably through the SECURITY DEFINER function `hq_record_ceo_briefing` (EXECUTE
 * granted to service_role only, migration 20261128000001) — the same hardening shape the executor
 * shadow store and the HQ Event Spine use. The morning cron (app/api/cron/hq-ceo-briefing) calls
 * this once per day.
 *
 * ONE ROW PER DAY, IDEMPOTENT. The store keys on `briefing_date` and the RPC is first-write-wins
 * (`on conflict do nothing`, then returns the day's id), so a re-run of the cron never duplicates
 * a briefing and never raises.
 *
 * DETERMINISTIC ONLY. The narrative is composed by pure code from the board's real figures; the
 * generative variant is dark (the store's `source` CHECK admits only 'deterministic', and the RPC
 * hardcodes it). This module makes NO model call.
 *
 * BEST-EFFORT + INJECTABLE. Every dependency has a safe default and is injectable so the compose →
 * record path is provable without a DB (mirroring server/services/hq-apply-drain.ts). It returns a
 * discriminated result and never throws.
 */

// hq_record_ceo_briefing isn't in the generated Supabase types — cast past the typed client (the
// same convention executor-shadow.ts uses for hq_record_executor_shadow).
type RecordBriefingRpc = (
  fn: "hq_record_ceo_briefing",
  args: Record<string, unknown>,
) => Promise<{ data: number | string | null; error: { message: string } | null }>;

/** What a durable briefing write returned. */
export type CeoBriefingRecordResult =
  | { readonly ok: true; readonly id: number }
  | { readonly ok: false; readonly error: string };

/** The seam that persists a composed briefing — injectable, defaults to the durable RPC. */
export type CeoBriefingRecorder = (input: {
  readonly briefingDate: string;
  readonly briefing: CeoBriefing;
  readonly correlationId: string;
}) => Promise<CeoBriefingRecordResult>;

/** The durable recorder — appends one briefing row through the service-role-only RPC. Never throws. */
export const durableCeoBriefingRecorder: CeoBriefingRecorder = async ({
  briefingDate,
  briefing,
  correlationId,
}) => {
  try {
    const admin = createAdminClient();
    const rpc = admin.rpc.bind(admin) as unknown as RecordBriefingRpc;
    const { data, error } = await rpc("hq_record_ceo_briefing", {
      p_briefing_date: briefingDate,
      p_headline: briefing.headline,
      p_narrative: briefing.narrative,
      p_signals: briefing.signals,
      p_correlation_id: correlationId,
    });
    if (error || data == null) {
      console.error("[hq-ceo-briefing] record failed", { briefingDate, error: error?.message });
      return { ok: false, error: error?.message ?? "briefing record failed" };
    }
    // bigint comes back from PostgREST as a JS number (safe past this horizon) or a numeric string.
    return { ok: true, id: Number(data) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[hq-ceo-briefing] record threw", { briefingDate, message });
    return { ok: false, error: message };
  }
};

/** The injectable dependencies of {@link composeAndRecordCeoBriefing} — all with safe defaults. */
export interface CeoBriefingDeps {
  /** Injected clock — determines the briefing date and stamps the narrative. */
  readonly now?: Date;
  /** Load the CEO board to compose from (defaults to the service-role aggregator). */
  readonly loadBoard?: () => Promise<CeoBoard>;
  /** Load the competitor-intel snapshot (defaults to the service-role note store). */
  readonly loadCompetitors?: () => Promise<CeoBriefingCompetitorIntel>;
  /** Persist the composed briefing (defaults to the durable RPC recorder). */
  readonly record?: CeoBriefingRecorder;
}

/** The total, JSON-safe summary of one briefing composition — the cron run's golden signal. */
export type ComposeCeoBriefingSummary =
  | {
      readonly ok: true;
      readonly briefingDate: string;
      readonly id: number;
      readonly headline: string;
      readonly source: "deterministic";
    }
  | { readonly ok: false; readonly briefingDate: string; readonly error: string };

/**
 * Compose the morning CEO briefing and record it, once. Best-effort: any fault is caught and
 * returned, never thrown, so a briefing failure can never break a cron tick. Deterministic +
 * generative-dark by construction.
 */
export async function composeAndRecordCeoBriefing(
  deps: CeoBriefingDeps = {},
): Promise<ComposeCeoBriefingSummary> {
  const now = deps.now ?? new Date();
  const briefingDate = now.toISOString().slice(0, 10);
  const loadBoard = deps.loadBoard ?? (async () => (await getCeoDashboard()).board);
  const loadCompetitors = deps.loadCompetitors ?? (() => loadCompetitorIntelForBriefing());
  const record = deps.record ?? durableCeoBriefingRecorder;

  try {
    const board = await loadBoard();
    const competitors = await loadCompetitors();
    const briefing = composeCeoBriefing(board, now, competitors);
    const correlationId = randomUUID();
    const result = await record({ briefingDate, briefing, correlationId });
    if (!result.ok) return { ok: false, briefingDate, error: result.error };
    return {
      ok: true,
      briefingDate,
      id: result.id,
      headline: briefing.headline,
      source: "deterministic",
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[hq-ceo-briefing] compose threw", { briefingDate, message });
    return { ok: false, briefingDate, error: message };
  }
}

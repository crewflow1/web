import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  WHATSAPP_CLAIM_LEASE_MS,
  processClaimedMessage,
  processClaimedStatus,
} from "@/server/services/whatsapp-webhook-handler";
import type {
  NormalizedWhatsAppMessage,
  NormalizedWhatsAppStatus,
} from "@/lib/comms/providers/meta-whatsapp";

/**
 * WhatsApp failed-event SWEEP (activation-hardening P2-4).
 *
 * The ingress claim protocol (whatsapp_webhook_events) deliberately leaves a
 * failed or crash-orphaned row RETRYABLE — processed_at NULL, error_message
 * set or the 15-minute lease expired. But the ONLY thing that ever exercised
 * the reclaim was a Meta REDELIVERY, and Meta stops retrying within hours; a
 * transient DB error at the wrong moment silently stranded a customer message
 * forever. This sweep is the missing retry driver, mirroring the embedding
 * worker's doctrine:
 *
 *   • CANDIDATES: processed_at NULL, not dead-lettered, and (failed OR lease
 *     expired) — oldest first, BOUNDED per tick.
 *   • RECLAIM is atomic and CAS-shaped: the UPDATE re-asserts every candidacy
 *     predicate plus the observed attempts value, so a concurrent webhook
 *     redelivery or overlapping tick loses cleanly (0 rows) and nothing is
 *     processed twice.
 *   • RE-RUN goes through the SAME post-claim machinery the live webhook uses
 *     (processClaimedMessage / processClaimedStatus): routing re-resolved (a
 *     number provisioned after the failure now attributes), opt-out handling,
 *     the unchanged ingestion core, processed/failed stamping. No parallel
 *     pipeline.
 *   • DEAD-LETTER: after WHATSAPP_SWEEP_MAX_ATTEMPTS sweep re-runs the row is
 *     stamped dead_lettered_at (processed_at stays NULL — it never completed),
 *     excluded from every future reclaim, and surfaced to HQ via the admin
 *     activity log. A give-up is loud, never silent.
 *
 * DARK-SAFE: the cron route short-circuits while NEXT_PUBLIC_FEATURE_WHATSAPP
 * is off (no events exist while dark anyway), and this module contacts no
 * provider — re-processing is DB-side; outbound stays behind its own gates.
 */

/** Sweep re-runs before a row is dead-lettered (the embedding worker's default). */
export const WHATSAPP_SWEEP_MAX_ATTEMPTS = 5;

/** Rows re-processed per tick — each re-run is a full ingestion pass, so keep it small. */
export const WHATSAPP_SWEEP_BATCH = 10;

export type WhatsAppSweepSummary = {
  ok: boolean;
  scanned: number;
  reclaimed: number;
  dispatched: number;
  unrouted: number;
  failed: number;
  dead_lettered: number;
  /** Candidates lost to a concurrent claimant (benign) or with unusable payloads. */
  skipped: number;
};

type SweepRow = {
  event_key: string;
  kind: string;
  attempts: number;
  error_message: string | null;
  payload: unknown;
};

type EventsTable = {
  select: (cols: string) => {
    is: (k: string, v: unknown) => {
      is: (k: string, v: unknown) => {
        or: (f: string) => {
          order: (col: string, opts: { ascending: boolean }) => {
            limit: (n: number) => Promise<{
              data: SweepRow[] | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    };
  };
  update: (row: unknown) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        is: (k: string, v: unknown) => {
          is: (k: string, v: unknown) => {
            or: (f: string) => {
              select: (cols: string) => Promise<{
                data: Array<{ event_key: string }> | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      };
    };
  };
};

function eventsTable(): EventsTable {
  const admin = createAdminClient();
  return admin.from("whatsapp_webhook_events" as never) as unknown as EventsTable;
}

/** Minimal shape check before re-running a stored message payload. */
function asMessagePayload(payload: unknown): NormalizedWhatsAppMessage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.wamid !== "string" || p.wamid.length === 0) return null;
  return {
    phone_number_id: typeof p.phone_number_id === "string" ? p.phone_number_id : null,
    wamid: p.wamid,
    caller: typeof p.caller === "string" ? p.caller : null,
    contact_name: typeof p.contact_name === "string" ? p.contact_name : null,
    raw_text: typeof p.raw_text === "string" ? p.raw_text : "",
    message_type: typeof p.message_type === "string" ? p.message_type : "unknown",
    has_media: p.has_media === true,
    media: (p.media ?? null) as NormalizedWhatsAppMessage["media"],
    provider_timestamp: typeof p.provider_timestamp === "string" ? p.provider_timestamp : null,
  };
}

/** Minimal shape check before re-running a stored status payload. */
function asStatusPayload(payload: unknown): NormalizedWhatsAppStatus | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.wamid !== "string" || p.wamid.length === 0) return null;
  if (typeof p.status !== "string" || p.status.length === 0) return null;
  return {
    phone_number_id: typeof p.phone_number_id === "string" ? p.phone_number_id : null,
    wamid: p.wamid,
    status: p.status,
    receipt: (p.receipt ?? null) as NormalizedWhatsAppStatus["receipt"],
  };
}

const retryablePredicate = (leaseCutoffIso: string): string =>
  `error_message.not.is.null,claimed_at.lt.${leaseCutoffIso}`;

/**
 * Atomically take one candidate for this sweep pass: re-assert candidacy AND
 * the observed attempts value (CAS), bump the lease, clear the error. 0 rows ⇒
 * a concurrent claimant won — skip, never double-process.
 */
async function reclaimForSweep(row: SweepRow, leaseCutoffIso: string): Promise<boolean> {
  const upd = await eventsTable()
    .update({
      claimed_at: new Date().toISOString(),
      error_message: null,
      attempts: row.attempts + 1,
    })
    .eq("event_key", row.event_key)
    .eq("attempts", row.attempts)
    .is("processed_at", null)
    .is("dead_lettered_at", null)
    .or(retryablePredicate(leaseCutoffIso))
    .select("event_key");
  if (upd.error) {
    console.error("[whatsapp-sweep] reclaim failed", {
      event_key: row.event_key,
      message: upd.error.message,
    });
    return false;
  }
  return (upd.data?.length ?? 0) > 0;
}

/**
 * Terminal give-up: stamp dead_lettered_at (attempts CAS again — a concurrent
 * success/claim wins over the stamp) and surface it to HQ. The original
 * error_message is preserved as the last known failure.
 */
async function deadLetter(row: SweepRow, leaseCutoffIso: string): Promise<boolean> {
  const upd = await eventsTable()
    .update({ dead_lettered_at: new Date().toISOString() })
    .eq("event_key", row.event_key)
    .eq("attempts", row.attempts)
    .is("processed_at", null)
    .is("dead_lettered_at", null)
    .or(retryablePredicate(leaseCutoffIso))
    .select("event_key");
  if (upd.error) {
    console.error("[whatsapp-sweep] dead-letter stamp failed", {
      event_key: row.event_key,
      message: upd.error.message,
    });
    return false;
  }
  if ((upd.data?.length ?? 0) === 0) return false;
  await recordAdminActivity({
    actorId: null,
    actorEmail: null,
    action: "whatsapp.event_dead_lettered",
    targetTable: "whatsapp_webhook_events",
    targetId: row.event_key,
    metadata: {
      kind: row.kind,
      attempts: row.attempts,
      last_error: row.error_message,
    },
  }).catch(() => undefined);
  return true;
}

/**
 * One bounded sweep pass. Never throws — a scan error returns ok:false with
 * zero work; a per-row failure is recorded on that row (retryable) and the
 * pass continues. Deliberately sequential: ingestion re-runs are heavyweight
 * and ordered-oldest-first delivery is kinder to conversation threading.
 */
export async function sweepWhatsAppWebhookEvents(opts?: {
  batch?: number;
}): Promise<WhatsAppSweepSummary> {
  const batch = Math.min(Math.max(opts?.batch ?? WHATSAPP_SWEEP_BATCH, 1), 50);
  const summary: WhatsAppSweepSummary = {
    ok: true,
    scanned: 0,
    reclaimed: 0,
    dispatched: 0,
    unrouted: 0,
    failed: 0,
    dead_lettered: 0,
    skipped: 0,
  };
  const leaseCutoffIso = new Date(Date.now() - WHATSAPP_CLAIM_LEASE_MS).toISOString();

  const scan = await eventsTable()
    .select("event_key, kind, attempts, error_message, payload")
    .is("processed_at", null)
    .is("dead_lettered_at", null)
    .or(retryablePredicate(leaseCutoffIso))
    .order("created_at", { ascending: true })
    .limit(batch);
  if (scan.error) {
    console.error("[whatsapp-sweep] scan failed", { message: scan.error.message });
    return { ...summary, ok: false };
  }

  const rows = scan.data ?? [];
  summary.scanned = rows.length;

  for (const row of rows) {
    // Max attempts exhausted → dead-letter instead of another re-run.
    if (row.attempts >= WHATSAPP_SWEEP_MAX_ATTEMPTS) {
      if (await deadLetter(row, leaseCutoffIso)) summary.dead_lettered++;
      else summary.skipped++;
      continue;
    }

    if (!(await reclaimForSweep(row, leaseCutoffIso))) {
      summary.skipped++; // a concurrent claimant won — benign
      continue;
    }
    summary.reclaimed++;

    try {
      if (row.kind === "message") {
        const msg = asMessagePayload(row.payload);
        if (!msg) {
          // Unusable payload can never succeed — count the attempt; the CAS
          // path dead-letters it once attempts exhaust.
          await markSweepFailure(row.event_key, "sweep: unusable message payload");
          summary.failed++;
          continue;
        }
        const outcome = await processClaimedMessage(msg, row.event_key);
        if (outcome === "dispatched") summary.dispatched++;
        else if (outcome === "unrouted") summary.unrouted++;
        else summary.failed++;
      } else if (row.kind === "status") {
        const st = asStatusPayload(row.payload);
        if (!st) {
          await markSweepFailure(row.event_key, "sweep: unusable status payload");
          summary.failed++;
          continue;
        }
        const outcome = await processClaimedStatus(st, row.event_key);
        if (outcome === "processed") summary.dispatched++;
        else summary.failed++;
      } else {
        await markSweepFailure(row.event_key, `sweep: unknown kind ${row.kind}`);
        summary.failed++;
      }
    } catch (e) {
      // processClaimed* stamp their own failures; this catch is the defensive
      // net for anything thrown around them. Row stays retryable.
      await markSweepFailure(
        row.event_key,
        e instanceof Error ? e.message : String(e),
      );
      summary.failed++;
    }
  }

  return summary;
}

/** Record a sweep-side failure on the row (keeps it retryable / dead-letterable). */
async function markSweepFailure(eventKey: string, error: string): Promise<void> {
  const admin = createAdminClient();
  const table = admin.from("whatsapp_webhook_events" as never) as unknown as {
    update: (row: unknown) => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
    };
  };
  const res = await table.update({ error_message: error.slice(0, 2000) }).eq("event_key", eventKey);
  if (res.error) {
    console.error("[whatsapp-sweep] markSweepFailure failed", {
      event_key: eventKey,
      message: res.error.message,
    });
  }
}

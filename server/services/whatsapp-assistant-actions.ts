import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { uploadTenantAttachmentAsService } from "@/server/services/tenant-attachments";
import { transcribeVoiceNote } from "@/lib/ai/transcription";
import type { NormalizedWhatsAppMessage } from "@/lib/comms/providers/meta-whatsapp";

/**
 * WhatsApp assistant AUTO-ACTIONS — turn one inbound message into the right
 * entity, DARK-safe, doctrine-first.
 *
 * THE RECEPTIONIST DOCTRINE governs what may happen without a human. From
 * server/services/receptionist.ts: "AI never books, schedules, prices, or
 * commits work — the owner is notified and decides." So this pipeline splits
 * inbound intent into two classes:
 *
 *   EVIDENCE (safe to record without sign-off) — a note of what the customer
 *   said, a photo of the site. These are WRITTEN to real tenant entities:
 *     - note  → appended to `jobs.notes` (tenant-visible), and
 *     - photo → a `tenant_attachments` row against the job (reusing the
 *               attachment service's evidence discipline: SHA-256, private
 *               bucket, service-role byte write).
 *
 *   COMMITMENTS (a human must decide) — a priced variation, a task/booking.
 *   These are NOT auto-created; they are recorded as `pending_review` in
 *   `whatsapp_assistant_actions` with the extracted request, so the owner
 *   creates the priced variation / schedules the work through the existing
 *   session-bound flow. Auto-pricing a variation from a message is exactly the
 *   "commit work" the doctrine forbids, and the variation-numbering RPC is
 *   membership-gated (unusable from a service-role webhook) — so pending_review
 *   is both the doctrinal AND the structurally-correct answer.
 *
 * INTENT CLASSIFICATION is DETERMINISTIC today (keyword + media-shape rules) —
 * no model, no fabrication. An AI intent classifier is the natural governed
 * upgrade; until one is bound the deterministic rules stand, so this whole
 * pipeline is dark-safe and testable with zero provider dependency.
 *
 * EVERY action is logged to `whatsapp_assistant_actions`, idempotently on
 * (org_id, wamid, action_type), so an at-least-once webhook never double-acts.
 * All writes are org-scoped: a job is re-read under `.eq("org_id", orgId)` before
 * anything is written against it, so a service-role write can never cross tenants.
 */

export type AssistantIntent = "note" | "task" | "variation_draft" | "photo_upload";

export type AssistantActionRecord = {
  action_type: AssistantIntent;
  status: "created" | "pending_review" | "skipped" | "failed";
  target_table: string | null;
  target_id: string | null;
  detail: Record<string, unknown>;
};

export type AssistantActionsResult = {
  intent: AssistantIntent;
  actions: AssistantActionRecord[];
};

// Keyword rules. Deliberately conservative — a false "note" is harmless; a false
// "commitment" merely lands in the review queue, never auto-committed.
const VARIATION_KEYWORDS = [
  "variation",
  "extra",
  "additional",
  "as well",
  "on top",
  "change order",
  "while you're here",
  "while youre here",
  "also need",
  "can you also",
];
const TASK_KEYWORDS = [
  "please book",
  "can you book",
  "arrange",
  "schedule",
  "send someone",
  "come back",
  "need you to",
  "chase up",
  "follow up",
];

/**
 * Deterministic intent classification. Media shape wins first (a photo is a
 * photo), then commitment keywords (variation before task), else a plain note.
 * Pure and side-effect-free so it is trivially unit-tested.
 */
export function classifyAssistantIntent(message: NormalizedWhatsAppMessage): AssistantIntent {
  const media = message.media;
  if (media && (media.message_type === "image" || media.message_type === "document")) {
    return "photo_upload";
  }
  const text = (message.raw_text ?? "").toLowerCase();
  if (VARIATION_KEYWORDS.some((k) => text.includes(k))) return "variation_draft";
  if (TASK_KEYWORDS.some((k) => text.includes(k))) return "task";
  // A voice note with no other signal is recorded as a note (its transcript, when
  // a provider is bound, or a placeholder while dark).
  return "note";
}

const ACTIONS_TABLE = "whatsapp_assistant_actions";

type ActionsTable = {
  insert: (row: unknown) => Promise<{ error: { message: string; code?: string } | null }>;
};

function actionsTable(): ActionsTable {
  const admin = createAdminClient();
  return admin.from(ACTIONS_TABLE as never) as unknown as ActionsTable;
}

/** Log one action, idempotently. A duplicate (unique org+wamid+action_type) is a benign no-op. */
async function logAction(
  orgId: string,
  wamid: string,
  enquiryId: string | null,
  rec: AssistantActionRecord,
): Promise<void> {
  const res = await actionsTable().insert({
    org_id: orgId,
    wamid,
    enquiry_id: enquiryId,
    action_type: rec.action_type,
    target_table: rec.target_table,
    target_id: rec.target_id,
    status: rec.status,
    detail: rec.detail,
    error_message: rec.status === "failed" ? String(rec.detail.error ?? "unknown") : null,
  });
  if (res.error) {
    const isDup = res.error.code === "23505" || res.error.message?.includes("duplicate");
    if (!isDup) {
      console.error("[whatsapp-assistant] action log failed", res.error);
    }
  }
}

/**
 * Re-read a job UNDER its org — the org-isolation gate. Returns the job row (with
 * its current notes) only when it genuinely belongs to `orgId`; null otherwise,
 * so a spoofed/foreign job id can never be written against.
 */
async function loadJobForOrg(
  orgId: string,
  jobId: string,
): Promise<{ id: string; notes: string | null } | null> {
  const admin = createAdminClient();
  const res = await (
    admin.from("jobs" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{
              data: { id: string; notes: string | null } | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    }
  )
    .select("id, notes")
    .eq("id", jobId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (res.error) {
    console.error("[whatsapp-assistant] job load failed", res.error);
    return null;
  }
  return res.data;
}

/** Append a timestamped line to jobs.notes, org-scoped. */
async function appendJobNote(
  orgId: string,
  jobId: string,
  existingNotes: string | null,
  line: string,
): Promise<boolean> {
  const admin = createAdminClient();
  const stamped = `[WhatsApp ${new Date().toISOString()}] ${line}`.slice(0, 5000);
  const next = existingNotes && existingNotes.trim().length > 0 ? `${existingNotes}\n${stamped}` : stamped;
  const res = await (
    admin.from("jobs" as never) as unknown as {
      update: (row: unknown) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
        };
      };
    }
  )
    .update({ notes: next })
    .eq("id", jobId)
    .eq("org_id", orgId);
  if (res.error) {
    console.error("[whatsapp-assistant] note append failed", res.error);
    return false;
  }
  return true;
}

/** WhatsApp image MIME → a tenant_attachments-allowed MIME, or null when unsupported. */
function attachmentMimeFor(mime: string | null): string | null {
  if (!mime) return null;
  const base = (mime.split(";")[0] ?? "").trim().toLowerCase();
  const allowed = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "application/pdf",
  ]);
  return allowed.has(base) ? base : null;
}

/** Digits-only tail of a phone/wa_id, for tolerant matching across formats. */
function phoneTail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, "");
  if (digits.length < 7) return null;
  return digits.slice(-9);
}

/**
 * Resolve the job an inbound WhatsApp message concerns, DETERMINISTICALLY:
 * caller wa_id → a customer in THIS org whose phone tail matches → that
 * customer's most recent still-open job. Returns null when no confident match
 * exists — the assistant then queues the action for review rather than guessing.
 *
 * Strictly org-scoped: both the customer and the job lookups are pinned to
 * `orgId`, so a service-role read can never surface another tenant's records.
 */
export async function resolveJobForCaller(
  orgId: string,
  caller: string | null,
): Promise<string | null> {
  const tail = phoneTail(caller);
  if (!tail) return null;
  const admin = createAdminClient();

  // Complete, paged read (F-1 guard): a bare select on customers is capped at the
  // PostgREST row cap; page it so the phone match sees every customer in the org.
  const custs = await fetchAllRows<{ id: string; phone: string | null }>((from, to) =>
    (
      admin.from("customers" as never) as unknown as {
        select: (c: string) => {
          eq: (k: string, v: unknown) => {
            range: (f: number, t: number) => PromiseLike<{
              data: Array<{ id: string; phone: string | null }> | null;
              error: unknown;
            }>;
          };
        };
      }
    )
      .select("id, phone")
      .eq("org_id", orgId)
      .range(from, to),
  );
  if (custs.error) return null;
  const match = custs.data.find((c) => phoneTail(c.phone) === tail);
  if (!match) return null;

  const jobs = await (
    admin.from("jobs" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            in: (k: string, v: unknown[]) => {
              order: (k: string, o: { ascending: boolean }) => {
                limit: (n: number) => Promise<{
                  data: Array<{ id: string }> | null;
                  error: { message: string } | null;
                }>;
              };
            };
          };
        };
      };
    }
  )
    .select("id")
    .eq("org_id", orgId)
    .eq("customer_id", match.id)
    .in("status", ["new", "in-progress"])
    .order("created_at", { ascending: false })
    .limit(1);
  const firstJob = jobs.data?.[0];
  if (jobs.error || !firstJob) return null;
  return firstJob.id;
}

export type RunAssistantInput = {
  orgId: string;
  wamid: string;
  enquiryId: string | null;
  message: NormalizedWhatsAppMessage;
  /** The job this message concerns, resolved by the caller. Null ⇒ no job context. */
  jobId: string | null;
  /** The downloaded media bytes (from the media pipeline), when a photo was stored. */
  media?: { bytes: Uint8Array; mimeType: string | null } | null;
};

/**
 * Run the assistant's auto-actions for one inbound message. Best-effort and
 * idempotent: every branch logs its outcome and never throws into the caller
 * (the webhook must ack Meta regardless).
 */
export async function runWhatsAppAssistantActions(
  input: RunAssistantInput,
): Promise<AssistantActionsResult> {
  const { orgId, wamid, enquiryId, message, jobId } = input;
  const intent = classifyAssistantIntent(message);
  const actions: AssistantActionRecord[] = [];

  const record = async (rec: AssistantActionRecord) => {
    actions.push(rec);
    await logAction(orgId, wamid, enquiryId, rec);
  };

  try {
    switch (intent) {
      case "photo_upload": {
        // Evidence — safe to record, but only against a job that is genuinely
        // this org's. No job / no bytes / unsupported type ⇒ pending_review so a
        // human can file it, never a silent drop.
        const mime = attachmentMimeFor(input.media?.mimeType ?? message.media?.mime_type ?? null);
        const bytes = input.media?.bytes ?? null;
        if (!jobId) {
          await record({
            action_type: "photo_upload",
            status: "pending_review",
            target_table: null,
            target_id: null,
            detail: { reason: "no_job_context", media_id: message.media?.media_id ?? null },
          });
          break;
        }
        if (!bytes || !mime) {
          await record({
            action_type: "photo_upload",
            status: "pending_review",
            target_table: "jobs",
            target_id: jobId,
            detail: { reason: bytes ? "unsupported_mime" : "no_bytes", media_id: message.media?.media_id ?? null },
          });
          break;
        }
        const job = await loadJobForOrg(orgId, jobId);
        if (!job) {
          await record({
            action_type: "photo_upload",
            status: "skipped",
            target_table: "jobs",
            target_id: jobId,
            detail: { reason: "job_not_in_org" },
          });
          break;
        }
        const up = await uploadTenantAttachmentAsService({
          orgId,
          targetTable: "jobs",
          targetId: jobId,
          filename: message.media?.filename ?? `whatsapp-${message.media?.media_id ?? wamid}`,
          mimeType: mime,
          bytes,
          dedupeContentHash: true,
        });
        await record({
          action_type: "photo_upload",
          status: up.ok ? "created" : "failed",
          target_table: "tenant_attachments",
          target_id: up.ok ? up.attachment_id : null,
          detail: up.ok ? { job_id: jobId, media_id: message.media?.media_id ?? null } : { error: up.error },
        });
        break;
      }

      case "note": {
        // A voice note may carry a transcript once STT is bound; while dark the
        // seam returns null (NEVER fabricated) and we record the placeholder text.
        let noteBody = message.raw_text ?? "";
        if (message.media?.is_voice_note && input.media?.bytes) {
          const t = await transcribeVoiceNote({
            orgId,
            audio: input.media.bytes,
            mimeType: input.media.mimeType ?? message.media.mime_type,
          });
          if (t.status === "completed") noteBody = t.transcript;
        }
        if (!jobId) {
          await record({
            action_type: "note",
            status: "pending_review",
            target_table: null,
            target_id: null,
            detail: { reason: "no_job_context", text: noteBody.slice(0, 2000) },
          });
          break;
        }
        const job = await loadJobForOrg(orgId, jobId);
        if (!job) {
          await record({
            action_type: "note",
            status: "skipped",
            target_table: "jobs",
            target_id: jobId,
            detail: { reason: "job_not_in_org" },
          });
          break;
        }
        const ok = await appendJobNote(orgId, jobId, job.notes, noteBody);
        await record({
          action_type: "note",
          status: ok ? "created" : "failed",
          target_table: "jobs",
          target_id: jobId,
          detail: ok ? { appended: true } : { error: "note_append_failed" },
        });
        break;
      }

      case "variation_draft": {
        // COMMITMENT — the doctrine forbids auto-pricing/committing work, so the
        // extracted request is queued for the owner to turn into a priced
        // variation through the existing flow. Never an auto-created quote.
        await record({
          action_type: "variation_draft",
          status: "pending_review",
          target_table: jobId ? "jobs" : null,
          target_id: jobId,
          detail: {
            reason: "human_in_the_loop",
            requested: (message.raw_text ?? "").slice(0, 2000),
            caller: message.caller,
          },
        });
        break;
      }

      case "task": {
        // COMMITMENT — scheduling/booking is the owner's call, and there is no
        // tenant task entity to write to. Queued for review.
        await record({
          action_type: "task",
          status: "pending_review",
          target_table: jobId ? "jobs" : null,
          target_id: jobId,
          detail: {
            reason: "human_in_the_loop",
            requested: (message.raw_text ?? "").slice(0, 2000),
            caller: message.caller,
          },
        });
        break;
      }
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await record({
      action_type: intent,
      status: "failed",
      target_table: null,
      target_id: null,
      detail: { error },
    });
  }

  return { intent, actions };
}

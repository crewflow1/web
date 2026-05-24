import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { emitNotifications } from "@/server/services/notifications-service";
import { dispatchAutomation } from "@/server/services/automation-dispatcher";
import { isAiConfigured } from "@/lib/ai/safety";
import type { NotificationCreate } from "@/lib/notifications/types";
import type {
  InboundEnquiryInput,
  InboundExtraction,
  InboundUrgency,
} from "@/lib/receptionist/types";

/**
 * Phase A — AI Receptionist processor.
 *
 * The single entry-point every channel adapter (phone webhook, SMS
 * webhook, WhatsApp Business, Instagram DM, Facebook DM) feeds.
 *
 *   1. INSERT raw row into `inbound_enquiries` (status='received').
 *   2. If AI is configured: extract structured fields from raw_text.
 *      Otherwise: deterministic fallback (keyword urgency, postcode
 *      regex, no AI summary).
 *   3. Create a `leads` row (status='new', source=channel).
 *   4. Update the enquiry: status='qualified', link lead_id, store
 *      extraction artefacts.
 *   5. Emit notifications (customer-audience for the org owner,
 *      audit log entry, automation dispatch).
 *
 * AI safety: this service runs on the SERVER. AI never books,
 * schedules, prices, or commits work — the owner is notified and
 * decides. The extraction is read-only output stored alongside the
 * raw transcript so the owner can verify.
 *
 * Idempotency: channels can replay webhooks. Callers may pass a
 * `dedup_key` (e.g. WhatsApp message_id) via the audit metadata;
 * the dispatcher's correlation_id handles the automation side.
 */

export async function processInboundEnquiry(
  input: InboundEnquiryInput,
): Promise<{ enquiry_id: string; lead_id: string | null }> {
  const admin = createAdminClient();

  // Step 1 — record raw enquiry.
  const { data: enquiryRow, error: insErr } = await (
    admin.from("inbound_enquiries" as never) as unknown as {
      insert: (row: unknown) => {
        select: (cols: string) => {
          single: () => Promise<{
            data: { id: string } | null;
            error: { message: string } | null;
          }>;
        };
      };
    }
  )
    .insert({
      org_id: input.org_id,
      channel: input.channel,
      raw_text: input.raw_text ?? null,
      caller: input.caller ?? null,
      status: "received",
    })
    .select("id")
    .single();
  if (insErr || !enquiryRow?.id) {
    throw new Error(`inbound_enquiries insert failed: ${insErr?.message ?? "no id"}`);
  }
  const enquiryId = enquiryRow.id;

  // Step 2 — AI extraction (or deterministic fallback).
  const extraction = await extractFields(input.raw_text ?? "");

  // Step 3 — create the lead. We do NOT create a customer row yet
  // (the directive's "AI NEVER commits work" rule). The owner can
  // promote the lead to a customer manually.
  let leadId: string | null = null;
  try {
    const { data: leadRow } = await admin
      .from("leads")
      .insert({
        org_id: input.org_id,
        source: input.channel,
        status: "new",
        service: extraction.job_type,
        urgency: extraction.urgency,
        postcode: extraction.postcode,
        ai_summary: extraction.summary,
      })
      .select("id")
      .single();
    leadId = (leadRow as { id?: string } | null)?.id ?? null;
  } catch (e) {
    console.error("[receptionist] lead insert failed", e);
  }

  // Step 4 — update enquiry with extraction + lead link.
  await (admin.from("inbound_enquiries" as never) as unknown as {
    update: (row: unknown) => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
    };
  })
    .update({
      status: leadId ? "qualified" : "processed",
      processed_at: new Date().toISOString(),
      ai_summary: extraction.summary,
      ai_confidence: extraction.confidence,
      job_type: extraction.job_type,
      urgency: extraction.urgency,
      postcode: extraction.postcode,
      budget_gbp: extraction.budget_gbp,
      lead_id: leadId,
    })
    .eq("id", enquiryId);

  // Step 5 — notify + audit + automation.
  if (leadId) {
    const note: NotificationCreate = {
      org_id: input.org_id,
      user_id: null,
      audience: "customer",
      type: "receptionist.lead_created",
      category: "system",
      priority: extraction.urgency === "urgent" ? "urgent" : "high",
      title: `New ${input.channel.replace("_", " ")} enquiry`,
      body: extraction.summary.slice(0, 280),
      action_url: `/leads/${leadId}`,
      source_module: "receptionist",
      source_id: leadId,
      metadata: {
        channel: input.channel,
        caller: input.caller,
        confidence: extraction.confidence,
      },
    };
    await emitNotifications([note]).catch((e) =>
      console.error("[receptionist] notify failed", e),
    );

    await recordAdminActivity({
      actorId: null,
      actorEmail: input.caller ?? null,
      action: "receptionist.enquiry_qualified",
      targetTable: "leads",
      targetId: leadId,
      metadata: {
        org_id: input.org_id,
        channel: input.channel,
        confidence: extraction.confidence,
        ai_used: isAiConfigured(),
      },
    });

    await dispatchAutomation({
      type: "support.ticket.created", // closest existing event id; new lead trigger could land later
      org_id: input.org_id,
      source_table: "leads",
      source_id: leadId,
      payload: { channel: input.channel, summary: extraction.summary },
    }).catch((e) => console.error("[receptionist] automation failed", e));
  }

  return { enquiry_id: enquiryId, lead_id: leadId };
}

// ---------------------------------------------------------------------
// Extraction — AI or deterministic
// ---------------------------------------------------------------------

async function extractFields(rawText: string): Promise<InboundExtraction> {
  // No AI key → deterministic fallback (keyword urgency + postcode
  // regex). Always returns SOMETHING so the lead still creates.
  if (!isAiConfigured() || !rawText.trim()) {
    return deterministicExtract(rawText);
  }
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const msg = await client.messages.create(
      {
        model: "claude-haiku-4-5",
        max_tokens: 500,
        system: [
          "You are CrewFlow Receptionist, processing an inbound enquiry for a UK construction firm.",
          "Read the transcript / message and return ONE JSON object only:",
          '{ "summary": "...", "confidence": 0-100, "job_type": "...", "urgency": "low"|"medium"|"high"|"urgent"|null, "postcode": "..."|null, "budget_gbp": number|null }',
          "Rules:",
          "- summary: 1-2 sentences, plain prose, no markdown",
          "- confidence: how reliable the extraction is (high if explicit, low if guessed)",
          "- urgency: 'urgent' if customer mentioned emergency/leak/flood/no-heat, else infer",
          "- DO NOT invent budget. If unstated, return null.",
          "- DO NOT promise prices or book appointments.",
          "- postcode: UK format only (e.g. SW1A 1AA), null if not present",
        ].join("\n"),
        messages: [{ role: "user", content: rawText }],
      },
      { signal: AbortSignal.timeout(10_000) },
    );
    const block = msg.content[0];
    if (block?.type === "text") {
      const raw = extractJson(block.text);
      if (raw && typeof raw === "object") {
        return normaliseExtraction(raw as Record<string, unknown>);
      }
    }
  } catch (e) {
    console.error("[receptionist] LLM extraction failed", e);
  }
  return deterministicExtract(rawText);
}

function deterministicExtract(raw: string): InboundExtraction {
  const text = raw.toLowerCase();
  const urgent =
    /\b(emergency|urgent|asap|leak|flood|no heat|burst|broken)\b/.test(text);
  const postcodeMatch =
    raw.match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i)?.[0] ?? null;
  return {
    summary:
      raw.trim().length > 0
        ? raw.trim().slice(0, 280)
        : "New enquiry — no transcript captured.",
    confidence: 30,
    job_type: null,
    urgency: urgent ? "urgent" : null,
    postcode: postcodeMatch ? postcodeMatch.toUpperCase().replace(/\s+/g, " ").trim() : null,
    budget_gbp: null,
  };
}

function normaliseExtraction(raw: Record<string, unknown>): InboundExtraction {
  const urgencyRaw =
    typeof raw.urgency === "string" ? raw.urgency.toLowerCase() : null;
  const urgency: InboundUrgency | null =
    urgencyRaw === "low" ||
    urgencyRaw === "medium" ||
    urgencyRaw === "high" ||
    urgencyRaw === "urgent"
      ? (urgencyRaw as InboundUrgency)
      : null;
  return {
    summary: String(raw.summary ?? "").trim() || "AI returned no summary.",
    confidence: clampConfidence(raw.confidence),
    job_type: typeof raw.job_type === "string" ? raw.job_type : null,
    urgency,
    postcode: typeof raw.postcode === "string" ? raw.postcode : null,
    budget_gbp:
      typeof raw.budget_gbp === "number" && Number.isFinite(raw.budget_gbp)
        ? raw.budget_gbp
        : null,
  };
}

function clampConfidence(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

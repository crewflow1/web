import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import {
  invokeWithGovernor,
  isGovernorActivated,
  type GovernedCall,
} from "@/lib/ai/governor";

/**
 * Phase C — AI lead summary.
 *
 * For a given lead, return a 1-2 sentence summary covering:
 *   - location (postcode)
 *   - urgency
 *   - job type
 *   - photo count (attachments)
 *   - suggested action (call / quote / archive)
 *
 * Hard rule from the directive: NO pricing, NO scheduling.
 *
 * When AI is not activated, a deterministic fallback assembles the
 * summary from the lead's structured fields. Same shape, same return
 * type — UI never branches on "AI is on".
 *
 * GOVERNED (closure wave). This path was NOT in the audit's list of five: it was
 * found by sweeping for provider-SDK constructions rather than for
 * `isAiConfigured()` gates, and it is the more serious of the two the sweep
 * added, because it is TENANT-FACING. It gated on a bare credential and
 * constructed `@anthropic-ai/sdk` itself, so `ANTHROPIC_API_KEY` on a deploy
 * would have run a model on every lead summary with no £100/org/month ceiling
 * and no ledger row. It now gates on `isGovernorActivated()` — the MODEL BINDING,
 * not the key — and the provider call passes through `invokeWithGovernor`. Both
 * governor refusals return the deterministic summary, which is the same value
 * this function already returns when AI is off, so no caller sees a new outcome.
 *
 * EVENT-DRIVEN: called when an operator opens/actions a specific lead, once per
 * lead. The dedupe window covers a double-click; it is not a render loop.
 *
 * SECURITY (P2 audit H-1): this runs under the service-role admin client,
 * which BYPASSES RLS. The caller MUST pass its authenticated org id, and
 * every read here is filtered by `org_id`. A lead belonging to another
 * tenant therefore resolves to null and we return early — before any
 * cross-tenant PII reaches the LLM, and before the caller can persist a
 * summary. `orgId` is required (not optional) so it cannot be omitted.
 */

export type LeadSummary = {
  summary: string;
  suggested_action: "call" | "quote" | "archive" | null;
  generated_by: "anthropic" | "openai" | "deterministic";
};

export async function summariseLead(
  leadId: string,
  orgId: string,
): Promise<LeadSummary | null> {
  const admin = createAdminClient();
  type Row = {
    id: string;
    org_id: string;
    source: string;
    status: string;
    service: string | null;
    urgency: string | null;
    postcode: string | null;
    estimated_value: number | null;
    ai_summary: string | null;
    created_at: string;
    last_activity_at: string;
    customer: { name: string | null; email: string | null } | null;
  };
  const { data: row, error: leadError } = await admin
    .from("leads")
    .select(
      `
        id, org_id, source, status, service, urgency, postcode,
        estimated_value, ai_summary, created_at, last_activity_at,
        customer:customers ( name, email )
      `,
    )
    .eq("id", leadId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (leadError) throw readFailure("lead-summary: lead row", leadError);
  const lead = row as unknown as Row | null;
  // Returns null for a missing lead OR a lead in another org (the org_id
  // filter above makes those indistinguishable, by design — no existence
  // oracle across tenants).
  if (!lead) return null;

  // Photo count for this lead — uses tenant_attachments polymorphic.
  // Also org-scoped: the admin client bypasses RLS, so we filter org_id
  // explicitly rather than trusting target_id alone.
  const { count: photoCount } = await (
    admin.from("tenant_attachments" as never) as unknown as {
      select: (cols: string, opts?: { count?: string; head?: boolean }) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            eq: (k: string, v: unknown) => Promise<{ count: number | null }>;
          };
        };
      };
    }
  )
    .select("id" as never, { count: "exact", head: true })
    .eq("target_table", "leads")
    .eq("target_id", leadId)
    .eq("org_id", orgId);

  // Not activated (no bound cost tier, or no credential) → deterministic.
  if (!isGovernorActivated()) {
    return deterministicSummary(lead, photoCount ?? 0);
  }

  // The model's ONLY ground truth. Built before the governed call so the
  // fingerprint below is over exactly what the model would be shown.
  const leadFacts = JSON.stringify({
    source: lead.source,
    service: lead.service,
    urgency: lead.urgency,
    postcode: lead.postcode,
    customer_name: lead.customer?.name ?? null,
    photo_count: photoCount ?? 0,
    raw_summary: lead.ai_summary,
    created_at: lead.created_at,
  });

  try {
    const outcome = await invokeWithGovernor(
      "lead.summary",
      "drafting",
      () => summariseWithProvider(leadFacts),
      {
        orgId,
        // No signed-in user is threaded this far; the ledger's user_id is
        // nullable for exactly this case rather than being guessed at.
        userId: null,
        // The lead's own facts are the dedupe identity: summarising an unchanged
        // lead twice buys the identical paragraph. Only the SHA-256 reaches the
        // ledger — never the customer's details.
        dedupeContent: leadFacts,
      },
    );
    // `blocked` (over ceiling) and `duplicate` degrade exactly as "AI off" does:
    // the deterministic summary, same shape, so no UI branches on it.
    if (outcome.status === "ran" && outcome.value) {
      const obj = outcome.value;
      return {
        summary:
          String(obj.summary ?? "").trim() ||
          deterministicSummary(lead, photoCount ?? 0).summary,
        suggested_action: normaliseAction(obj.suggested_action),
        generated_by: "anthropic",
      };
    }
  } catch (e) {
    // The governor RECORDED the failure and rethrew; this catch is unchanged.
    console.error("[lead-summary] LLM failed", e);
  }
  return deterministicSummary(lead, photoCount ?? 0);
}

/** The fixed framing. No lead content can steer it. */
const LEAD_SUMMARY_SYSTEM = [
  "You summarise a single inbound lead for a UK construction firm's owner.",
  "Return ONE JSON object only:",
  '{ "summary": "...", "suggested_action": "call"|"quote"|"archive"|null }',
  "Rules:",
  "- summary: 1-2 sentences mentioning location/postcode, urgency, job type, photo count",
  "- DO NOT suggest a price. DO NOT propose a schedule.",
  "- suggested_action: 'call' for urgent/high, 'quote' if job type is clear + non-urgent, 'archive' if data is too thin",
].join("\n");

/**
 * The provider leg, isolated so the governor can time it and account for it.
 * Reports the vendor's own billed token counts; throws on any provider failure,
 * so the caller owns the degraded path.
 *
 * Returns `null` for an unparseable response while STILL reporting usage — the
 * call cost what it cost, and a ledger that omitted it would under-count spend.
 */
async function summariseWithProvider(
  leadFacts: string,
): Promise<GovernedCall<Record<string, unknown> | null>> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  // Safe non-null: `isGovernorActivated()` above requires the bound vendor's
  // credential to be present, so this is not a bare-key assumption.
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const model = "claude-haiku-4-5";
  const msg = await client.messages.create(
    {
      model,
      max_tokens: 400,
      system: LEAD_SUMMARY_SYSTEM,
      messages: [{ role: "user", content: leadFacts }],
    },
    { signal: AbortSignal.timeout(10_000) },
  );
  const usage = {
    provider: "anthropic",
    model: msg.model ?? model,
    inputTokens: msg.usage?.input_tokens ?? 0,
    outputTokens: msg.usage?.output_tokens ?? 0,
  };
  const block = msg.content[0];
  if (block?.type === "text") {
    const raw = extractJson(block.text);
    if (raw && typeof raw === "object") {
      return { value: raw as Record<string, unknown>, usage };
    }
  }
  return { value: null, usage };
}

function deterministicSummary(
  lead: {
    source: string;
    service: string | null;
    urgency: string | null;
    postcode: string | null;
    ai_summary: string | null;
    customer: { name: string | null } | null;
  },
  photoCount: number,
): LeadSummary {
  const parts: string[] = [];
  parts.push(
    `${lead.customer?.name ?? "Lead"} via ${lead.source}${lead.service ? ` (${lead.service})` : ""}.`,
  );
  if (lead.urgency) parts.push(`Urgency: ${lead.urgency}.`);
  if (lead.postcode) parts.push(`Postcode: ${lead.postcode}.`);
  if (photoCount > 0)
    parts.push(`${photoCount} photo${photoCount === 1 ? "" : "s"} attached.`);
  if (lead.ai_summary) parts.push(`Note: ${lead.ai_summary.slice(0, 200)}`);

  const action: LeadSummary["suggested_action"] =
    lead.urgency === "urgent" || lead.urgency === "high"
      ? "call"
      : lead.service
        ? "quote"
        : null;
  return {
    summary: parts.join(" "),
    suggested_action: action,
    generated_by: "deterministic",
  };
}

function normaliseAction(v: unknown): LeadSummary["suggested_action"] {
  return v === "call" || v === "quote" || v === "archive" ? v : null;
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

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAiConfigured } from "@/lib/ai/safety";

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
 * When ANTHROPIC_API_KEY is unset, deterministic fallback assembles
 * the summary from the lead's structured fields. Same shape, same
 * return type — UI never branches on "AI is on".
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
  const { data: row } = await admin
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

  if (!isAiConfigured()) {
    return deterministicSummary(lead, photoCount ?? 0);
  }

  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const msg = await client.messages.create(
      {
        model: "claude-haiku-4-5",
        max_tokens: 400,
        system: [
          "You summarise a single inbound lead for a UK construction firm's owner.",
          "Return ONE JSON object only:",
          '{ "summary": "...", "suggested_action": "call"|"quote"|"archive"|null }',
          "Rules:",
          "- summary: 1-2 sentences mentioning location/postcode, urgency, job type, photo count",
          "- DO NOT suggest a price. DO NOT propose a schedule.",
          "- suggested_action: 'call' for urgent/high, 'quote' if job type is clear + non-urgent, 'archive' if data is too thin",
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              source: lead.source,
              service: lead.service,
              urgency: lead.urgency,
              postcode: lead.postcode,
              customer_name: lead.customer?.name ?? null,
              photo_count: photoCount ?? 0,
              raw_summary: lead.ai_summary,
              created_at: lead.created_at,
            }),
          },
        ],
      },
      { signal: AbortSignal.timeout(10_000) },
    );
    const block = msg.content[0];
    if (block?.type === "text") {
      const raw = extractJson(block.text);
      if (raw && typeof raw === "object") {
        const obj = raw as Record<string, unknown>;
        return {
          summary: String(obj.summary ?? "").trim() || deterministicSummary(lead, photoCount ?? 0).summary,
          suggested_action: normaliseAction(obj.suggested_action),
          generated_by: "anthropic",
        };
      }
    }
  } catch (e) {
    console.error("[lead-summary] LLM failed", e);
  }
  return deterministicSummary(lead, photoCount ?? 0);
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

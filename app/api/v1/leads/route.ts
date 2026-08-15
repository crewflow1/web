import { createAdminClient } from "@/lib/supabase/admin";
import { guardPublicApiRequest } from "@/lib/public-api/guard";
import { verifyCustomerInOrg } from "@/lib/crm/reference-integrity";
import {
  LEAD_DTO_SELECT,
  toPublicLeadDto,
  type LeadRowForDto,
} from "@/lib/public-api/leads";
import { createLeadSchema } from "@/lib/public-api/write-schemas";
import {
  parseJsonBody,
  created,
  writeError,
} from "@/lib/public-api/write";

/**
 * POST /api/v1/leads — the public, key-authenticated LEAD CAPTURE surface.
 *
 * The flagship write: a website / marketing integration posts a new enquiry
 * straight into the pipeline. Same dark flag + guard as every v1 route;
 * requires the DISTINCT `write:leads` scope. There is no leads READ endpoint
 * and no `read:leads` scope — this key capability is write-only.
 *
 * SECURITY:
 *   - Strict body validation (unknown keys rejected — no mass assignment);
 *     `status` is NOT accepted, so a captured lead is always created as "new".
 *   - org_id is pinned to the KEY'S org, never the body.
 *   - An optional customer_id is verified to belong to the key's org BEFORE the
 *     insert (defence in depth over the composite FK) so a foreign customer can
 *     never be attached — a clean 422, not a raw 23503 → 500.
 *   - The created row is returned through the leads DTO allowlist (no contact
 *     PII, no internal fields).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Minimal typed surface for the insert + allowlisted readback.
 * `contact_*` columns post-date the generated Database types (landed in
 * 20260601000100_leads_contact_fields) — the house cast idiom keeps the typed
 * client happy for those new columns.
 */
type LeadInsertWrite = {
  insert: (row: {
    org_id: string;
    contact_name: string;
    contact_email: string | null;
    contact_phone: string | null;
    source: string;
    service: string | null;
    urgency: string;
    postcode: string | null;
    estimated_value: number | null;
    notes: string | null;
    customer_id: string | null;
    status: string;
    first_contact_at: string;
    last_activity_at: string;
  }) => {
    select: (cols: string) => {
      single: () => Promise<{
        data: LeadRowForDto | null;
        error: { message?: string | null } | null;
      }>;
    };
  };
};

export async function POST(request: Request): Promise<Response> {
  const guard = await guardPublicApiRequest(request, "write:leads");
  if (!guard.ok) return guard.response;

  const body = await parseJsonBody(request, createLeadSchema);
  if (!body.ok) return body.response;
  const input = body.value;

  const admin = createAdminClient();

  // Cross-tenant reference integrity: a linked customer must be in the key's
  // org. Verified before the write so a forged id is a clean validation error.
  if (input.customer_id) {
    const ref = await verifyCustomerInOrg(
      admin as never,
      input.customer_id,
      guard.key.orgId,
    );
    if (!ref.ok) {
      return writeError(422, "invalid_reference", ref.message);
    }
  }

  const now = new Date().toISOString();
  const { data, error } = await (
    admin.from("leads") as unknown as LeadInsertWrite
  )
    .insert({
      // ORG PINNING — the key's own org, never a client-supplied value.
      org_id: guard.key.orgId,
      contact_name: input.contact_name,
      contact_email: input.contact_email ?? null,
      contact_phone: input.contact_phone ?? null,
      source: input.source,
      service: input.service ?? null,
      urgency: input.urgency ?? "normal",
      postcode: input.postcode ?? null,
      estimated_value: input.estimated_value ?? null,
      notes: input.notes ?? null,
      customer_id: input.customer_id ?? null,
      // A captured lead is ALWAYS new — the client cannot inject a stage.
      status: "new",
      first_contact_at: now,
      last_activity_at: now,
    })
    .select(LEAD_DTO_SELECT)
    .single();

  if (error || !data) {
    console.error("[public-api] lead create failed", error?.message);
    return writeError(500, "write_failed", "Couldn't create the lead.");
  }

  return created(toPublicLeadDto(data));
}

import "server-only";
import type { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";

/**
 * Cross-tenant reference integrity for CRM writes (jobs + leads + the calendar
 * reschedule endpoint).
 *
 * The database is the real guard: jobs/leads.customer_id carry a COMPOSITE FK to
 * customers(id, org_id), and assigned_to is gated by a membership trigger (see
 * migration 20261112000000). These helpers are DEFENCE IN DEPTH: they run the
 * same org-membership check BEFORE the write so the caller gets a clean,
 * field-level validation message instead of a raw 23503 / trigger exception
 * surfacing as a 500.
 *
 * LOUD READS. A genuine read failure throws via `readFailure` rather than
 * degrading to "not in this org" — reporting a legitimate reference as foreign
 * because the lookup errored is exactly the lie loud reads exist to stop. A
 * clean "no matching row" is the only thing that becomes a rejection.
 *
 * ORG-PINNED. Every lookup is `.eq("org_id", orgId)` on the caller's ACTIVE org
 * (not merely left to RLS, whose `current_org_ids()` returns every org the
 * viewer belongs to).
 */

type Client = Awaited<ReturnType<typeof createClient>>;

export type RefCheck = { ok: true } | { ok: false; message: string };

/** The customer, when set, must belong to the caller's active org. */
export async function verifyCustomerInOrg(
  supabase: Client,
  customerId: string,
  orgId: string,
): Promise<RefCheck> {
  const { data, error } = await supabase
    .from("customers")
    .select("id")
    .eq("id", customerId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw readFailure("crm ref: customer in org", error);
  return data
    ? { ok: true }
    : { ok: false, message: "That customer isn't in your organisation." };
}

/** The assignee, when set, must be a member of the caller's active org. */
export async function verifyAssigneeInOrg(
  supabase: Client,
  userId: string,
  orgId: string,
): Promise<RefCheck> {
  const { data, error } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw readFailure("crm ref: assignee membership", error);
  return data
    ? { ok: true }
    : { ok: false, message: "That team member isn't in your organisation." };
}

/**
 * Verify a job/lead write's customer_id + assigned_to references against the
 * active org in one call. Returns the first rejection, or ok when both (or
 * neither, when unset) are valid.
 */
export async function verifyCrmReferences(
  supabase: Client,
  orgId: string,
  refs: { customerId?: string | null; assignedTo?: string | null },
): Promise<RefCheck> {
  if (refs.customerId) {
    const c = await verifyCustomerInOrg(supabase, refs.customerId, orgId);
    if (!c.ok) return c;
  }
  if (refs.assignedTo) {
    const a = await verifyAssigneeInOrg(supabase, refs.assignedTo, orgId);
    if (!a.ok) return a;
  }
  return { ok: true };
}

/** The property, when set, must belong to the caller's active org. */
export async function verifyPropertyInOrg(
  supabase: Client,
  propertyId: string,
  orgId: string,
): Promise<RefCheck> {
  const { data, error } = await supabase
    .from("properties")
    .select("id")
    .eq("id", propertyId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw readFailure("crm ref: property in org", error);
  return data
    ? { ok: true }
    : { ok: false, message: "That property isn't in your organisation." };
}

/** The lead, when set, must belong to the caller's active org. */
export async function verifyLeadInOrg(
  supabase: Client,
  leadId: string,
  orgId: string,
): Promise<RefCheck> {
  const { data, error } = await supabase
    .from("leads")
    .select("id")
    .eq("id", leadId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw readFailure("crm ref: lead in org", error);
  return data
    ? { ok: true }
    : { ok: false, message: "That lead isn't in your organisation." };
}

/** The job, when set, must belong to the caller's active org. */
export async function verifyJobInOrg(
  supabase: Client,
  jobId: string,
  orgId: string,
): Promise<RefCheck> {
  const { data, error } = await supabase
    .from("jobs")
    .select("id")
    .eq("id", jobId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw readFailure("crm ref: job in org", error);
  return data
    ? { ok: true }
    : { ok: false, message: "That job isn't in your organisation." };
}

/**
 * Verify a QUOTE write's customer_id + property_id + lead_id + job_id references
 * against the active org in one call. Returns the first rejection, or ok when
 * all set references (and any unset ones) are valid.
 *
 * The database is the real guard — quotes.{customer,property,lead,job}_id all
 * carry COMPOSITE FKs to parent(id, org_id) (migration 20261113000000). This is
 * DEFENCE IN DEPTH: it runs the same org-membership check BEFORE the write so the
 * caller gets a clean, field-level validation message instead of a raw 23503
 * surfacing as a 500 — and, critically for quotes, so a forged customer_id never
 * even reaches the row that renders on the PUBLIC /q/[token] portal.
 */
export async function verifyQuoteReferences(
  supabase: Client,
  orgId: string,
  refs: {
    customerId?: string | null;
    propertyId?: string | null;
    leadId?: string | null;
    jobId?: string | null;
  },
): Promise<RefCheck> {
  if (refs.customerId) {
    const c = await verifyCustomerInOrg(supabase, refs.customerId, orgId);
    if (!c.ok) return c;
  }
  if (refs.propertyId) {
    const p = await verifyPropertyInOrg(supabase, refs.propertyId, orgId);
    if (!p.ok) return p;
  }
  if (refs.leadId) {
    const l = await verifyLeadInOrg(supabase, refs.leadId, orgId);
    if (!l.ok) return l;
  }
  if (refs.jobId) {
    const j = await verifyJobInOrg(supabase, refs.jobId, orgId);
    if (!j.ok) return j;
  }
  return { ok: true };
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import type { LibAttachment } from "@/lib/customers/portal-documents";

/**
 * Customer-portal reads for portal-visible attachments.
 *
 * The portal has no customer JWT — the caller has ALREADY resolved the URL token
 * to a customer via loadCustomerByPortalToken. These functions take that resolved
 * customerId + orgId and are the ONLY portal path to attachments.
 *
 * PUBLICATION GATE (two independent conditions, BOTH required):
 *   1. tenant_attachments.portal_visible = true — an explicit staff decision.
 *      The flag defaults FALSE, so nothing is shared merely by attaching it.
 *   2. The attachment's (target_table, target_id) resolves to a quote / invoice
 *      / job the token-resolved customer OWNS (org_id + customer_id match). An
 *      attachment on another customer's record — even if flagged — never returns.
 *
 * The admin client bypasses RLS by design, so BOTH conditions are enforced in
 * code/SQL here. Only quotes / invoices / jobs are portal-eligible target types;
 * an attachment hanging off any other entity is ignored.
 */

const PORTAL_TARGET_TABLES = ["quotes", "invoices", "jobs"] as const;
type PortalTargetTable = (typeof PORTAL_TARGET_TABLES)[number];

const IN_CHUNK = 500;

type AttachmentRow = {
  id: string;
  target_table: string | null;
  target_id: string | null;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  created_at: string | null;
};

/** Every id of a given customer-owned entity, paged in full (F-1 safe). */
async function ownedIds(
  admin: ReturnType<typeof createAdminClient>,
  table: PortalTargetTable,
  customerId: string,
  orgId: string,
): Promise<string[]> {
  const { data, error } = await fetchAllRows<{ id: string }>((from, to) =>
    admin
      .from(table)
      .select("id")
      .eq("org_id", orgId)
      .eq("customer_id", customerId)
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
      data: { id: string }[] | null;
      error: unknown;
    }>,
  );
  if (error) throw readFailure(`portal attachments: ${table} ids`, error);
  return (data ?? []).map((r) => r.id);
}

/** Flagged attachments for a single owned target table, chunked so each
 * `.in("target_id", …)` stays under the PostgREST cap. */
async function flaggedFor(
  admin: ReturnType<typeof createAdminClient>,
  table: PortalTargetTable,
  targetIds: string[],
): Promise<AttachmentRow[]> {
  const out: AttachmentRow[] = [];
  type Chain = {
    select: (c: string) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => {
          in: (
            k: string,
            v: unknown[],
          ) => PromiseLike<{ data: AttachmentRow[] | null; error: SupabaseReadError | null }>;
        };
      };
    };
  };
  for (let i = 0; i < targetIds.length; i += IN_CHUNK) {
    const chunk = targetIds.slice(i, i + IN_CHUNK);
    const { data, error } = await (
      admin.from("tenant_attachments" as never) as unknown as Chain
    )
      .select("id, target_table, target_id, filename, mime_type, size_bytes, created_at")
      .eq("portal_visible", true)
      .eq("target_table", table)
      .in("target_id", chunk);
    if (error) throw readFailure(`portal attachments: ${table}`, error);
    for (const row of data ?? []) out.push(row);
  }
  return out;
}

/** All portal-visible attachments this customer may see, newest first. */
export async function listPortalAttachments(
  customerId: string,
  orgId: string,
): Promise<LibAttachment[]> {
  const admin = createAdminClient();
  const rows: AttachmentRow[] = [];
  for (const table of PORTAL_TARGET_TABLES) {
    const ids = await ownedIds(admin, table, customerId, orgId);
    if (ids.length === 0) continue;
    rows.push(...(await flaggedFor(admin, table, ids)));
  }
  return rows
    .map((r) => ({
      id: r.id,
      filename: r.filename,
      target_table: r.target_table,
      mime_type: r.mime_type,
      size_bytes: r.size_bytes,
      created_at: r.created_at,
    }))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}

/**
 * Re-verify a SINGLE attachment for the download route (defence in depth — the
 * list read never reaches the route). Returns the storage details ONLY when the
 * attachment is flagged AND owned by this customer; otherwise null (fail closed).
 */
export async function verifyPortalAttachment(
  attachmentId: string,
  customerId: string,
  orgId: string,
): Promise<{ storage_path: string; filename: string | null; mime_type: string | null } | null> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attachmentId)
  ) {
    return null;
  }
  const admin = createAdminClient();

  type AttLookup = {
    select: (c: string) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => {
          maybeSingle: () => Promise<{
            data: {
              target_table: string | null;
              target_id: string | null;
              storage_path: string | null;
              filename: string | null;
              mime_type: string | null;
            } | null;
            error: SupabaseReadError | null;
          }>;
        };
      };
    };
  };
  const { data: att, error } = await (
    admin.from("tenant_attachments" as never) as unknown as AttLookup
  )
    .select("target_table, target_id, storage_path, filename, mime_type")
    .eq("id", attachmentId)
    .eq("org_id", orgId)
    .maybeSingle();
  // Note: portal_visible + ownership are checked below so a not-flagged or
  // wrong-customer id both resolve to "no file".
  if (error) throw readFailure("portal attachment: lookup", error);
  if (!att?.storage_path || !att.target_id) return null;

  const table = att.target_table ?? "";
  if (!(PORTAL_TARGET_TABLES as readonly string[]).includes(table)) return null;

  // Re-load the flag AND ownership together (the lookup above omitted the flag
  // so this single verification is authoritative).
  const flagged = await isFlagged(admin, attachmentId, orgId);
  if (!flagged) return null;

  const owned = await ownsTarget(
    admin,
    table as PortalTargetTable,
    att.target_id,
    customerId,
    orgId,
  );
  if (!owned) return null;

  return {
    storage_path: att.storage_path,
    filename: att.filename,
    mime_type: att.mime_type,
  };
}

async function isFlagged(
  admin: ReturnType<typeof createAdminClient>,
  attachmentId: string,
  orgId: string,
): Promise<boolean> {
  type Chain = {
    select: (c: string) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{
              data: { id: string } | null;
              error: SupabaseReadError | null;
            }>;
          };
        };
      };
    };
  };
  const { data, error } = await (
    admin.from("tenant_attachments" as never) as unknown as Chain
  )
    .select("id")
    .eq("id", attachmentId)
    .eq("org_id", orgId)
    .eq("portal_visible", true)
    .maybeSingle();
  if (error) throw readFailure("portal attachment: flag", error);
  return !!data;
}

async function ownsTarget(
  admin: ReturnType<typeof createAdminClient>,
  table: PortalTargetTable,
  targetId: string,
  customerId: string,
  orgId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from(table)
    .select("id")
    .eq("id", targetId)
    .eq("org_id", orgId)
    .eq("customer_id", customerId)
    .maybeSingle();
  if (error) throw readFailure(`portal attachment: ${table} ownership`, error);
  return !!data;
}

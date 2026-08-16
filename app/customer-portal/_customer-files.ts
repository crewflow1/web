import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";

/**
 * Portal read-back of a customer's OWN general file uploads (kind='customer_file').
 *
 * Every row filtered by BOTH customer_id AND org_id (the token-resolved identity)
 * AND kind — so a customer sees exactly the files they themselves sent, never a
 * payment proof, a staff-uploaded doc, or another customer's file. Runs on the
 * RLS-bypassing admin client (portal_uploads is service-role only), which makes
 * these three filters the whole isolation boundary; they must never be relaxed.
 */

export type PortalCustomerFile = {
  id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  notes: string | null;
  uploaded_at: string;
  storage_path: string;
};

type FileRow = PortalCustomerFile;
type OrderChain = {
  order: (k: string, o: { ascending: boolean }) => OrderChain;
  range: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: FileRow[] | null; error: SupabaseReadError | null }>;
};
type ListChain = {
  select: (c: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => OrderChain;
      };
    };
  };
};

export async function listCustomerFiles(
  customerId: string,
  orgId: string,
): Promise<PortalCustomerFile[]> {
  const admin = createAdminClient();
  const { data, error } = await fetchAllRows<FileRow>(
    (from, to) =>
      (admin.from("portal_uploads" as never) as unknown as ListChain)
        .select("id, filename, mime_type, size_bytes, notes, uploaded_at, storage_path")
        .eq("customer_id", customerId)
        .eq("org_id", orgId)
        .eq("kind", "customer_file")
        .order("uploaded_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
  );
  if (error) throw readFailure("portal customer files: list", error);
  return data ?? [];
}

/**
 * Short-lived signed URL for a customer to re-download their OWN file. Scoped by
 * (id + customer_id + org_id + kind), so a crafted id belonging to another
 * customer/org — or a non-customer_file upload — resolves to no row → null.
 */
export async function customerFileSignedUrl(
  uploadId: string,
  customerId: string,
  orgId: string,
): Promise<string | null> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId)
  ) {
    return null;
  }
  const admin = createAdminClient();
  type Lookup = {
    eq: (k: string, v: unknown) => Lookup;
    maybeSingle: () => Promise<{
      data: { storage_path: string | null } | null;
      error: SupabaseReadError | null;
    }>;
  };
  // The ownership lookup is LOUD — a DB error resolving the customer's own file
  // must not masquerade as "no such file". Only the storage signing below is
  // best-effort (a transient storage hiccup hides ONE download link, not the
  // page). See docs/loud-read-failures.md (C ledger).
  const { data: row, error } = await (
    admin.from("portal_uploads" as never) as unknown as {
      select: (c: string) => Lookup;
    }
  )
    .select("storage_path")
    .eq("id", uploadId)
    .eq("customer_id", customerId)
    .eq("org_id", orgId)
    .eq("kind", "customer_file")
    .maybeSingle();
  if (error) throw readFailure("portal customer files: sign", error);
  if (!row?.storage_path) return null;
  const { data: signed } = await admin.storage
    .from("portal-uploads")
    .createSignedUrl(row.storage_path, 60);
  return signed?.signedUrl ?? null;
}

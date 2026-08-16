import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";

/**
 * STAFF-side inbox of the files a customer sent through the portal
 * (kind='customer_file') — the counterpart to getPaymentProofSignedUrl.
 *
 * portal_uploads has RLS enabled with NO policies (service-role only — see
 * 20260620000000_portal_uploads.sql), so the user-JWT client reads zero rows.
 * This therefore runs on the RLS-BYPASSING admin client, which makes the
 * `org_id` filter the ONLY thing enforcing organisation isolation — it must
 * never be removed or widened. `customer_id` scopes to the one customer whose
 * page this is, and `kind` pins to general customer files so this can never
 * surface a payment proof or another upload kind. The caller passes the ACTIVE
 * org (ctx.org.id), already the pin used for the customer subject itself.
 *
 * Each file carries a short-lived (60s) signed URL for staff to open it; the
 * bucket is private, so the URL is the only way in and it expires quickly.
 */

export type StaffCustomerFile = {
  id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  notes: string | null;
  uploaded_at: string;
  url: string | null;
};

type FileRow = {
  id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  notes: string | null;
  uploaded_at: string;
  storage_path: string;
};
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

export async function listStaffCustomerFiles(
  orgId: string,
  customerId: string,
): Promise<StaffCustomerFile[]> {
  const admin = createAdminClient();
  const { data, error } = await fetchAllRows<FileRow>(
    (from, to) =>
      (admin.from("portal_uploads" as never) as unknown as ListChain)
        .select("id, filename, mime_type, size_bytes, notes, uploaded_at, storage_path")
        .eq("org_id", orgId)
        .eq("customer_id", customerId)
        .eq("kind", "customer_file")
        .order("uploaded_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
  );
  if (error) throw readFailure("staff customer files: list", error);
  return Promise.all(
    (data ?? []).map(async (f) => {
      const { data: signed } = await admin.storage
        .from("portal-uploads")
        .createSignedUrl(f.storage_path, 60);
      return {
        id: f.id,
        filename: f.filename,
        mime_type: f.mime_type,
        size_bytes: f.size_bytes,
        notes: f.notes,
        uploaded_at: f.uploaded_at,
        url: signed?.signedUrl ?? null,
      };
    }),
  );
}

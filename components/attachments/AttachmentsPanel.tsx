import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import type { AttachmentTargetTable } from "@/server/services/tenant-attachments";
import { AttachmentsUploadForm, AttachmentRow } from "./AttachmentsClient";

/**
 * Phase F — Drop-in attachments panel.
 *
 * Renders the list of files attached to an entity + an upload form.
 * Use on customer/job/quote/invoice/supplier/staff/lead detail pages:
 *
 *   <AttachmentsPanel targetTable="jobs" targetId={job.id} />
 *
 * Server component — fetches the rows server-side so the list is up
 * to date on every page load + after revalidatePath().
 */

type Row = {
  id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  created_at: string;
};

export async function AttachmentsPanel({
  targetTable,
  targetId,
  frozen = false,
}: {
  targetTable: AttachmentTargetTable;
  targetId: string;
  // When true, attached files are APPEND-ONLY: new uploads are allowed but nothing
  // already attached can be removed (delivered H&S evidence — the DB enforces this
  // too via the toolbox attachment-freeze trigger). Hides the Delete control so the
  // affordance never lies.
  frozen?: boolean;
}) {
  const { ctx } = await requireOrgContext();
  // SECURITY (P2 audit M-5): deleting an attachment is owner/admin-only (RLS +
  // in-code gate in deleteTenantAttachment). Only surface the Delete control to
  // those roles so members aren't shown an action the server will refuse — and
  // never when the evidence is frozen.
  const canDelete =
    !frozen && (ctx.membership.role === "owner" || ctx.membership.role === "admin");
  const supabase = await createClient();

  const { data } = await (
    supabase.from("tenant_attachments" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            order: (col: string, opts: { ascending: boolean }) => {
              limit: (n: number) => Promise<{ data: Row[] | null }>;
            };
          };
        };
      };
    }
  )
    .select("id, filename, mime_type, size_bytes, created_at")
    .eq("target_table", targetTable)
    .eq("target_id", targetId)
    .order("created_at", { ascending: false })
    .limit(100);

  const rows = data ?? [];

  return (
    <section
      aria-labelledby={`attachments-${targetId}`}
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <h2
        id={`attachments-${targetId}`}
        className="text-sm font-semibold text-slate-900"
      >
        Attachments ({rows.length})
      </h2>

      {frozen ? (
        <p className="mt-1 text-xs text-slate-500">
          Delivered evidence — files can be added but not removed or replaced.
        </p>
      ) : null}

      <AttachmentsUploadForm
        targetTable={targetTable}
        targetId={targetId}
      />

      {rows.length === 0 ? (
        <p className="mt-3 text-xs text-slate-500">No files yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {rows.map((row) => (
            <AttachmentRow
              key={row.id}
              attachment={row}
              targetTable={targetTable}
              targetId={targetId}
              canDelete={canDelete}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
